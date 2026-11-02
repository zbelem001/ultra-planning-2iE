"""Passage entre la base PostgreSQL / Supabase et le moteur v3.

Lecture : on réutilise le chargeur du solveur de Zakaria (`ultraplanning_solver.base.charger`,
schéma v8 et isolation par école), puis on complète avec les colonnes et tables
propres au moteur v3 si elles existent (voir propositions/009_moteur_v3.sql) :
site de la promotion, groupe parent, publics supplémentaires, types de salle
acceptés, salles réservées, paramètres des règles, temps de trajet. Sans elles,
le moteur tourne avec des valeurs déduites, signalées dans `meta.avertissements`.

Écriture : seulement les différences (séances supprimées et ajoutées) ; une séance
inchangée garde son identifiant, et le journal d'audit ne note que les vrais
changements. Les déclencheurs de la base revalident chaque séance écrite.

La clé de connexion se passe par variable d'environnement (DATABASE_URL), jamais
dans le code.
"""
from __future__ import annotations

from collections import Counter, defaultdict

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]


def _h(t) -> int:
    if t.minute:
        raise ValueError(f"Le moteur travaille en heures entières ({t})")
    return t.hour


def donnees_vers_v3(d) -> dict:
    """Convertit un objet `Donnees` du solveur de Zakaria en instance v3."""
    avert: list[str] = []
    # plages : créneaux contigus d'un jour, coupés aux pauses
    pauses = [(_h(a), _h(b)) for a, b in d.pauses]
    plages = {}
    for j in JOURS:
        crs = sorted((_h(c.heure_debut), _h(c.heure_fin)) for c in d.creneaux if c.jour == j)
        blocs: list[list[int]] = []
        for a, b in crs:
            if blocs and blocs[-1][1] == a and not any(pa == a for pa, _ in pauses):
                blocs[-1][1] = b
            else:
                blocs.append([a, b])
        if blocs:
            plages[j] = blocs

    conges_globaux = [[g.date_debut.isoformat(), g.date_fin.isoformat()] for g in d.conges if g.id_classe is None]
    regles: list[dict] = []
    for g in d.conges:   # congé d'une seule promotion : règle « interdire » sur la période
        if g.id_classe is not None:
            regles.append({"id": f"conge-{g.id_classe}-{g.date_debut}", "type": "interdire", "dure": True,
                           "cible": {"id_classe": g.id_classe}, "du": g.date_debut.isoformat(),
                           "au": g.date_fin.isoformat(), "libelle": "congé de la promotion"})
    if d.max_matieres_semaine:
        avert.append(f"CD-13 ({d.max_matieres_semaine} matières par semaine) n'est pas appliquée par le moteur v3")
    if getattr(d, "plafond_heures_jour", None):
        regles.append({"id": "CS-06", "type": "plafond_jour", "cible": {"tous": True}, "dure": False,
                       "heures": d.plafond_heures_jour, "poids": d.poids.get("CS-06", 2),
                       "libelle": f"{d.plafond_heures_jour} h par jour de préférence (CS-06)"})
    if "CS-05" in d.poids:
        regles.append({"id": "CS-05", "type": "cm_avant_td", "dure": False, "poids": d.poids["CS-05"],
                       "libelle": "CM avant TD (CS-05)"})

    indispo, pref = defaultdict(list), defaultdict(list)
    for (k, jour, t), niveau in d.disponibilites.items():
        x = {"jour": jour, "heure_debut": _h(t), "heure_fin": _h(t) + 1}
        (indispo if niveau == "indisponible" else pref)[k].append(x)

    sites = sorted({s.id_site for s in d.salles.values()})
    # site d'une promotion inconnu dans ce schéma : celui de ses séances existantes, sinon le site principal
    site_salle = {s.id_salle: s.id_site for s in d.salles.values()}
    vu: dict[int, Counter] = defaultdict(Counter)
    for s in d.seances:
        if s.id_cours in d.cours and s.id_salle in site_salle:
            vu[d.cours[s.id_cours].id_classe][site_salle[s.id_salle]] += 1
    principal = Counter(site_salle.values()).most_common(1)[0][0] if site_salle else None
    classes = []
    for c in d.classes.values():
        site = vu[c.id_classe].most_common(1)[0][0] if vu[c.id_classe] else principal
        classes.append({"id_classe": c.id_classe, "code_classe": c.code_classe, "effectif": c.effectif,
                        "id_site": site, "site_statut": "déduit"})
    if len(sites) > 1:
        avert.append("site des promotions déduit (colonne classe.id_site absente)")

    return {
        "version": 3,
        "calendrier": {"debut": d.semestre_debut.isoformat(), "fin": d.semestre_fin.isoformat(),
                       "jours_feries": sorted(x.isoformat() for x in d.jours_feries),
                       "conges": conges_globaux, "plages": plages},
        "sites": [{"id_site": s} for s in sites],
        "trajet_min": {f"{a}-{b}": 60 for a in sites for b in sites if a < b},
        "salles": [{"id_salle": s.id_salle, "code_salle": s.nom_salle, "id_site": s.id_site,
                    "id_type_salle": s.id_type_salle, "capacite": s.capacite,
                    "est_disponible": s.est_disponible, "reservee_a": []} for s in d.salles.values()],
        "classes": classes,
        "groupes": [{"id_groupe": g.id_groupe, "id_classe": g.id_classe, "parent": None,
                     "type_groupe": g.type_groupe, "effectif": g.effectif, "code_groupe": g.code_groupe}
                    for g in d.groupes.values()],
        "enseignants": [{"id_enseignant": e.id_enseignant, "statut": e.statut,
                         "nb_heures_max_semaine": e.nb_heures_max_semaine,
                         "sejours": [[p.date_debut.isoformat(), p.date_fin.isoformat()] for p in d.sejours.get(e.id_enseignant, [])],
                         "absences": [[p.date_debut.isoformat(), p.date_fin.isoformat()] for p in d.absences.get(e.id_enseignant, [])],
                         "indisponibilites": indispo[e.id_enseignant], "preferences": pref[e.id_enseignant]}
                        for e in d.enseignants.values()],
        "cours": [{"id_cours": c.id_cours, "id_matiere": c.id_matiere, "type_cours": c.type_cours,
                   "publics": [{"id_classe": c.id_classe, "id_groupe": c.id_groupe}],
                   "id_enseignant": c.id_enseignant, "id_type_salle": c.id_type_salle,
                   "volume": c.volume_horaire, "durees": list(c.durees_preferees),
                   "h_sem_min": c.heures_semaine_min, "h_sem_max": c.heures_semaine_max,
                   "priorite": c.priorite} for c in d.cours.values()],
        "regles": regles,
        "seances_existantes": [{"id_seance": s.id_seance, "id_cours": s.id_cours, "date": s.date_seance.isoformat(),
                                "heure_debut": f"{_h(s.heure_debut):02d}:00", "heure_fin": f"{_h(s.heure_fin):02d}:00",
                                "id_salle": s.id_salle, "est_verrouillee": s.est_verrouillee} for s in d.seances],
        "parametres": {},
        "meta": {"id_edt": d.id_edt, "id_ecole": getattr(d, "id_ecole", None), "avertissements": avert},
    }


def _existe(conn, table: str, colonne: str | None = None) -> bool:
    q = ("SELECT 1 FROM information_schema.columns WHERE table_name = %s AND column_name = %s" if colonne
         else "SELECT 1 FROM information_schema.tables WHERE table_name = %s")
    return conn.execute(q, (table, colonne) if colonne else (table,)).fetchone() is not None


def completer_v3(conn, data: dict) -> dict:
    """Ajoute ce que le schéma v8 ne porte pas, si la migration 009 est appliquée."""
    ecole = data["meta"]["id_ecole"]
    av = data["meta"]["avertissements"]
    q = lambda sql, *p: conn.execute(sql, (ecole, *p)).fetchall()  # noqa: E731
    if _existe(conn, "classe", "id_site"):
        site = dict(q("SELECT id_classe, id_site FROM classe WHERE id_ecole = %s AND id_site IS NOT NULL"))
        for c in data["classes"]:
            if c["id_classe"] in site:
                c["id_site"], c["site_statut"] = site[c["id_classe"]], "base"
        av[:] = [x for x in av if not x.startswith("site des promotions")]
    if _existe(conn, "groupe", "id_groupe_parent"):
        parent = dict(q("SELECT id_groupe, id_groupe_parent FROM groupe WHERE id_ecole = %s"))
        for g in data["groupes"]:
            g["parent"] = parent.get(g["id_groupe"])
    if _existe(conn, "cours_public"):
        cours = {c["id_cours"]: c for c in data["cours"]}
        for k, ic, ig in q("SELECT id_cours, id_classe, id_groupe FROM cours_public WHERE id_ecole = %s"):
            if k in cours:
                cours[k]["publics"].append({"id_classe": ic, "id_groupe": ig})
    if _existe(conn, "cours_type_salle"):
        cours = {c["id_cours"]: c for c in data["cours"]}
        for k, t in q("SELECT id_cours, id_type_salle FROM cours_type_salle WHERE id_ecole = %s"):
            if k in cours:
                c = cours[k]
                c["types_salle"] = sorted(set(c.get("types_salle") or ([c["id_type_salle"]] if c["id_type_salle"] else [])) | {t})
    if _existe(conn, "salle_reservation"):
        salles = {s["id_salle"]: s for s in data["salles"]}
        for s, ic in q("SELECT id_salle, id_classe FROM salle_reservation WHERE id_ecole = %s"):
            if s in salles:
                salles[s]["reservee_a"].append(ic)
    if _existe(conn, "site_trajet"):
        for a, b, mn in q("SELECT id_site_a, id_site_b, minutes FROM site_trajet WHERE id_ecole = %s"):
            data["trajet_min"][f"{min(a, b)}-{max(a, b)}"] = mn
    if _existe(conn, "contrainte", "parametres"):
        for row in q("SELECT id_contrainte, type_contrainte, nature, poids, parametres, date_debut, date_fin, libelle "
                     "FROM contrainte WHERE id_ecole = %s AND est_active AND id_edt = %s AND parametres IS NOT NULL",
                     data["meta"]["id_edt"]):
            k, t, nature, poids, p, du, au, lib = row
            r = {"id": k, "type": t, "dure": nature == "dure", "poids": poids, "libelle": lib, **(p or {})}
            if du:
                r["du"] = du.isoformat()
            if au:
                r["au"] = au.isoformat()
            data["regles"].append(r)
    return data


def charger(conn, id_edt: int) -> dict:
    """Instance v3 d'un emploi du temps, lue dans la base."""
    from ultraplanning_solver.base import charger as charger_zak
    return completer_v3(conn, donnees_vers_v3(charger_zak(conn, id_edt)))


def enregistrer(conn, data: dict, res: dict) -> dict:
    """Écrit les différences entre `seances_existantes` et `res["seances"]`, en une transaction.
    Si un déclencheur refuse une séance, rien n'est écrit et l'erreur remonte."""
    id_edt, ecole = data["meta"]["id_edt"], data["meta"]["id_ecole"]
    cle = lambda s: (s["id_cours"], s["date"], s["heure_debut"], s["heure_fin"], s["id_salle"])  # noqa: E731
    avant = {cle(s): s for s in data.get("seances_existantes", [])}
    apres = {cle(s) for s in res["seances"]}
    a_supprimer = [s["id_seance"] for k, s in avant.items() if k not in apres and s.get("id_seance") is not None]
    a_ajouter = [s for s in res["seances"] if cle(s) not in avant]
    jours = JOURS + ["Dimanche"]
    from datetime import date
    with conn.transaction():
        if a_supprimer:
            conn.execute("DELETE FROM seance WHERE id_seance = ANY(%s) AND id_ecole = %s", (a_supprimer, ecole))
        for s in a_ajouter:
            jour = jours[date.fromisoformat(s["date"]).weekday()]
            row = conn.execute("SELECT id_creneau FROM creneau WHERE id_ecole = %s AND jour = %s AND heure_debut = %s",
                               (ecole, jour, s["heure_debut"])).fetchone()
            if row is None:
                raise ValueError(f"Aucun créneau ne commence le {jour} à {s['heure_debut']}")
            conn.execute(
                "INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (s["date"], s["heure_debut"], s["heure_fin"], s["id_cours"], s["id_salle"], row[0], id_edt, ecole))
    return {"supprimees": len(a_supprimer), "ajoutees": len(a_ajouter), "inchangees": len(apres) - len(a_ajouter)}
