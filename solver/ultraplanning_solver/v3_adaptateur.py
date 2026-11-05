"""Le moteur v3 (Soraya Pitroipa, sous-module v3/) derrière l'interface du solveur.

`generer_v3(d, demande)` reçoit les mêmes `Donnees` et `Demande` que l'ancien moteur CP-SAT
et rend le même `Resultat` : l'API, l'assistant et les propositions n'y voient pas de
différence. Correspondances :

- génération : séances figées (hors périmètre, hors période, verrouillées, ou toutes avec
  « compléter ») posées d'abord avec leur propre enseignant, puis placement glouton
  multi-essais et amélioration CP-SAT, sur les seules dates de la période ;
- période courte (horizon au-delà de la période) : le reste de chaque cours est réparti
  jusqu'à l'horizon, seule la période est placée, le reste est reporté (pas de rattrapage) ;
- replanification (`minimiser_changements`) : chaque séance du périmètre est revérifiée à
  sa place, et seules celles devenues impossibles sont replacées ; avec `ramener_depuis`,
  celles prévues hors de la période y sont ramenées si elles y trouvent une place ;
- contraintes ajoutées (imposer / interdire) : règles horaires du moteur ;
- CD-13 (`max_matieres_semaine`), CD-14 (rythme maximal), CS-01 à CS-07 : paramètres et
  poids du moteur ; une CS désactivée met son poids à zéro.
"""

from __future__ import annotations

import os
import random
import time as chrono
from collections import Counter, defaultdict
from datetime import date, time

from .demande import Demande, NonPlace, Resultat
from .donnees import JOURS, Donnees, Seance, minutes
from .v3.instance import Instance
from .v3.planif import essais_paralleles
from .v3.replanif import replanifier_etat


def _h(t) -> int:
    if t.minute:
        raise ValueError(f"Le solveur travaille en heures entières ({t})")
    return t.hour


def _regle_ajoutee(i: int, k) -> dict:
    """ContrainteAjoutee -> règle horaire du moteur v3."""
    cible = {cle: v for cle, v in (("id_cours", k.id_cours), ("id_classe", k.id_classe),
                                   ("id_enseignant", k.id_enseignant)) if v is not None}
    r = {"id": f"ajoutee-{i}", "type": k.type, "cible": cible, "dure": True, "libelle": k.libelle or k.type,
         "jours": list(k.jours), "heure_min": minutes(k.heure_min) if k.heure_min else 0,
         "heure_max": minutes(k.heure_max) if k.heure_max else 24 * 60}
    if k.date_debut:
        r["du"] = k.date_debut.isoformat()
    if k.date_fin:
        r["au"] = k.date_fin.isoformat()
    return r


def instance_v3(d: Donnees, demande: Demande, du: date, au: date) -> dict:
    """Instance au format v3 (voir v3/generateur.py) ; d'après moteur/base.py de Soraya."""
    pauses = [(_h(a), _h(b)) for a, b in d.pauses]
    plages = {}
    for j in JOURS:
        blocs: list[list[int]] = []
        for a, b in sorted((_h(c.heure_debut), _h(c.heure_fin)) for c in d.creneaux if c.jour == j):
            if blocs and blocs[-1][1] == a and not any(pa == a for pa, _ in pauses):
                blocs[-1][1] = b
            else:
                blocs.append([a, b])
        if blocs:
            plages[j] = blocs

    regles = list(d.regles)
    for g in d.conges:   # congé d'une seule promotion : règle « interdire » sur la période
        if g.id_classe is not None:
            regles.append({"id": f"conge-{g.id_classe}-{g.date_debut}", "type": "interdire", "dure": True,
                           "cible": {"id_classe": g.id_classe}, "du": g.date_debut.isoformat(),
                           "au": g.date_fin.isoformat(), "libelle": "congé de la promotion"})
    if d.poids.get("CS-06"):
        regles.append({"id": "CS-06", "type": "plafond_jour", "cible": {"tous": True}, "dure": False,
                       "heures": d.plafond_heures_jour, "poids": d.poids["CS-06"],
                       "libelle": f"{d.plafond_heures_jour} h par jour de préférence (CS-06)"})
    if d.poids.get("CS-05"):
        regles.append({"id": "CS-05", "type": "cm_avant_td", "dure": False, "poids": d.poids["CS-05"],
                       "libelle": "CM avant TD (CS-05)"})
    regles += [_regle_ajoutee(i, k) for i, k in enumerate(demande.contraintes)]
    # Épreuves : elles ne comptent pas dans les volumes, mais leurs classes et leur salle sont prises
    salles_bloquees = []
    for x in d.examens:
        c = d.cours.get(x.id_cours)
        if c is None:
            continue
        jour, debut, fin = x.date_seance.isoformat(), minutes(x.heure_debut), minutes(x.heure_fin)
        regles += [{"id": f"epreuve-{x.id_seance}-{ic}", "type": "interdire", "dure": True, "cible": {"id_classe": ic},
                    "du": jour, "au": jour, "heure_min": debut, "heure_max": fin, "libelle": "épreuve de la classe"}
                   for ic in {c.id_classe, *(i for i, _ in c.publics_suppl)}]
        salles_bloquees.append({"id_salle": x.id_salle, "date": jour, "debut": debut // 60, "fin": (fin + 59) // 60})

    indispo, pref = defaultdict(list), defaultdict(list)
    for (k, jour, t), niveau in d.disponibilites.items():
        x = {"jour": jour, "heure_debut": _h(t), "heure_fin": _h(t) + 1}
        (indispo if niveau == "indisponible" else pref)[k].append(x)

    sites = sorted({s.id_site for s in d.salles.values()})
    trajet = {f"{min(a, b)}-{max(a, b)}": m for (a, b), m in d.trajet_min.items()}
    # poids : une bonne pratique désactivée (absente de d.poids) ne compte plus
    poids = {} if d.poids.get("CS-01") else {"preference": 0}
    if not d.poids.get("CS-02"):
        poids["colle"] = 0
    if not d.poids.get("CS-03"):
        poids["enseignant_deux_sites"] = 0
    if not d.poids.get("CS-07"):
        poids["priorite"] = 0
    return {
        "version": 3,
        "calendrier": {"debut": d.semestre_debut.isoformat(), "fin": d.semestre_fin.isoformat(),
                       "jours_feries": sorted(x.isoformat() for x in d.jours_feries),
                       "conges": [[g.date_debut.isoformat(), g.date_fin.isoformat()] for g in d.conges if g.id_classe is None],
                       "plages": plages},
        "sites": [{"id_site": s} for s in sites],
        "trajet_min": trajet or {f"{a}-{b}": 60 for a in sites for b in sites if a < b},
        "salles": [{"id_salle": s.id_salle, "code_salle": s.nom_salle, "id_site": s.id_site,
                    "id_type_salle": s.id_type_salle, "capacite": s.capacite, "est_disponible": s.est_disponible,
                    "reservee_a": sorted(s.reservee_a)} for s in d.salles.values()],
        "classes": [{"id_classe": c.id_classe, "code_classe": c.code_classe, "effectif": c.effectif,
                     "id_site": c.id_site} for c in d.classes.values()],
        "groupes": [{"id_groupe": g.id_groupe, "id_classe": g.id_classe, "parent": g.id_groupe_parent,
                     "type_groupe": g.type_groupe, "effectif": g.effectif, "code_groupe": g.code_groupe}
                    for g in d.groupes.values()],
        "enseignants": [{"id_enseignant": e.id_enseignant, "statut": e.statut,
                         "nb_heures_max_semaine": e.nb_heures_max_semaine,
                         "sejours": [[p.date_debut.isoformat(), p.date_fin.isoformat()] for p in d.sejours.get(e.id_enseignant, [])],
                         "absences": [[p.date_debut.isoformat(), p.date_fin.isoformat()] for p in d.absences.get(e.id_enseignant, [])],
                         "indisponibilites": indispo[e.id_enseignant], "preferences": pref[e.id_enseignant]}
                        for e in d.enseignants.values()],
        "cours": [{"id_cours": c.id_cours, "id_matiere": c.id_matiere, "type_cours": c.type_cours,
                   "publics": [{"id_classe": c.id_classe, "id_groupe": c.id_groupe}]
                   + [{"id_classe": ic, "id_groupe": ig} for ic, ig in c.publics_suppl],
                   "id_enseignant": c.id_enseignant, "id_type_salle": c.id_type_salle,
                   "types_salle": sorted(({c.id_type_salle} if c.id_type_salle else set()) | set(c.types_salle)),
                   "volume": c.volume_horaire, "durees": list(c.durees_preferees),
                   "h_sem_min": c.heures_semaine_min, "h_sem_max": c.heures_semaine_max,
                   "priorite": c.priorite} for c in d.cours.values()],
        "regles": regles,
        "salles_bloquees": salles_bloquees,
        "seances_existantes": [],
        "parametres": {"max_matieres_semaine": d.max_matieres_semaine, "poids": poids,
                       "placer_du": du.isoformat(), "placer_au": au.isoformat()},
    }


# Motif d'une heure non programmée -> code affiché (règle concernée)
CODES = [("CD-13", "CD-13"), ("rythme maximal", "CD-14"), ("étudiants déjà", "CD-03"), ("enseignant déjà en cours", "CD-02"),
         ("salle", "CD-01"), ("absent", "CD-06"), ("indisponibilité", "CD-06"), ("séjour", "CD-06"),
         ("plafond journalier", "PLAFOND"), ("trajet", "SITES"), ("autre site", "SITES"), ("precede", "ORDRE"),
         ("interdire", "REGLE"), ("contrainte ajoutée", "CONTRAINTE"), ("semaine pleine", "CAPACITE"),
         ("jour fermé", "CD-09")]


def code_de(raison: str) -> str:
    return next((code for mot, code in CODES if mot in raison), "CAPACITE")


def _seance_v3(s: Seance) -> dict:
    return {"id_seance": s.id_seance, "id_cours": s.id_cours, "date": s.date_seance.isoformat(),
            "heure_debut": f"{_h(s.heure_debut):02d}:00", "heure_fin": f"{_h(s.heure_fin):02d}:00",
            "id_salle": s.id_salle, "est_verrouillee": s.est_verrouillee, "id_enseignant": s.id_enseignant}


def _seances(inst: Instance, e, garder) -> list[Seance]:
    return sorted((Seance(x["id_cours"], inst.dates[x["jour"]], time(x["debut"]), time(x["debut"] + x["duree"]),
                          x["id_salle"], id_enseignant=x["ens"]) for x in e.seances if garder(x)),
                  key=lambda s: (s.date_seance, s.heure_debut, s.id_cours))


def generer_v3(d: Donnees, demande: Demande) -> Resultat:
    debut_calcul = chrono.perf_counter()
    du = max(demande.du or d.semestre_debut, d.semestre_debut)
    au = min(demande.au or d.semestre_fin, d.semestre_fin)
    cours = [c for c in d.cours.values() if demande.perimetre.contient(d, c)]
    ids = {c.id_cours for c in cours}
    inst = Instance(instance_v3(d, demande, du, au))
    semaines = sorted({inst.semaine_de[i] for i, x in enumerate(inst.dates) if du <= x <= au})
    stats = {"moteur": "v3", "cours": len(cours), "semaines": len(semaines), "avertissements": inst.erreurs}

    if demande.minimiser_changements:
        # Replanification : revérifier chaque séance à sa place, ne déplacer que l'impossible
        def verrouillee(s):
            return demande.garder_verrouillees and s.est_verrouillee
        existantes = [{**_seance_v3(s), "est_verrouillee": verrouillee(s)} for s in d.seances]
        e, modifications, raisons, verifiees, avert = replanifier_etat(
            inst, existantes, lambda c: c.id in ids, du, au, False, random.Random(1), demande.ramener_depuis)
        restees = [m for m in modifications if m["type"] == "restée"]
        sans_place = {(m["id_cours"], m["avant"]["date"], m["avant"]["heure_debut"]) for m in restees}

        def reprise(s):
            if s.id_cours not in ids or verrouillee(s):
                return False
            if du <= s.date_seance <= au:
                return True
            return demande.ramener_depuis is not None and s.date_seance >= demande.ramener_depuis and \
                (s.id_cours, s.date_seance.isoformat(), f"{_h(s.heure_debut):02d}:00") not in sans_place
        remplacees = [s for s in d.seances if reprise(s)]
        fixes = [s for s in d.seances if not reprise(s)]
        a_reprendre = Counter()   # heures qu'aucune place n'a pu accueillir telles quelles
        for s in remplacees:
            a_reprendre[s.id_cours] += s.duree
        for x in e.seances:
            if not x["fixe"]:
                a_reprendre[x["id_cours"]] -= x["duree"]
        a_reprendre = {k: h for k, h in a_reprendre.items() if h > 0}
        if a_reprendre and demande.temps_amelioration > 0:
            # CP-SAT par promotion et semaine : redécoupe ces heures et pousse un peu les autres séances
            try:
                from .v3.ameliore import ameliorer
            except ImportError:
                stats["amelioration"] = "OR-Tools absent"
            else:
                stats["amelioration"] = ameliorer(inst, e, demande.temps_amelioration, semaines=semaines, cours_ok=ids,
                                                  plafond_ajout=dict(a_reprendre), bonus_origine=200)
        seances = _seances(inst, e, lambda x: not x["fixe"])
        perdues = Counter()
        for s in remplacees:
            perdues[s.id_cours] += s.duree
        for s in seances:
            perdues[s.id_cours] -= s.duree
        non_places = [NonPlace(k, h, code_de(r := raisons[k].most_common(1)[0][0] if raisons.get(k) else "aucun créneau"), r)
                      for k, h in sorted(perdues.items()) if h > 0]
        besoin = sum(s.duree for s in remplacees)
        stats.update({"seances_verifiees": verifiees, "deplacees": sum(m["type"] == "déplacée" for m in modifications),
                      "heures_demandees": besoin, "heures_placees": sum(s.duree for s in seances),
                      "heures_reportees": 0, "duree_s": round(chrono.perf_counter() - debut_calcul, 2),
                      "restees_hors_periode": [{"id_cours": m["id_cours"], **m["avant"], "raison": m["raison"]} for m in restees]})
        stats["avertissements"] = inst.erreurs + avert
        return Resultat(seances, fixes, remplacees, non_places, stats)

    # Génération (ou « compléter ») sur la période
    def a_remplacer(s: Seance) -> bool:
        if demande.completer:
            return False
        return s.id_cours in ids and du <= s.date_seance <= au and not (demande.garder_verrouillees and s.est_verrouillee)

    remplacees = [s for s in d.seances if a_remplacer(s)]
    fixes = [s for s in d.seances if not a_remplacer(s)]
    figees = [{"id_cours": s.id_cours, "jour": inst.index_date.get(s.date_seance), "debut": _h(s.heure_debut),
               "duree": s.duree, "id_salle": s.id_salle, "ens": s.id_enseignant} for s in fixes]
    deja = defaultdict(int)
    for s in fixes:
        deja[s.id_cours] += s.duree
    restant = {c.id_cours: max(c.volume_horaire - deja[c.id_cours], 0) for c in cours}

    horizon_date = min(demande.horizon or d.semestre_fin, d.semestre_fin)
    courte = horizon_date > au   # période courte : le reste est reporté après elle
    horizon = None
    if courte and inst.dates:
        apres = [inst.semaine_de[i] for i, x in enumerate(inst.dates) if x <= horizon_date]
        horizon = (max(apres) + 1) if apres else None
    processus = demande.processus or os.cpu_count() or 1
    concentration = demande.concentration if demande.concentration is not None else (1.0 if d.max_matieres_semaine else 0.5)
    e, raisons, i_best = essais_paralleles(inst, demande.essais, 1, concentration, 0.85, processus, figees, semaines,
                                           ids, horizon, not courte)
    stats.update({"essais": demande.essais, "meilleur_essai": i_best, "processus": processus,
                  "glouton_s": round(chrono.perf_counter() - debut_calcul, 2)})
    if not courte and demande.temps_amelioration > 0 and any(e.reste[k] > 0 for k in ids):
        try:
            from .v3.ameliore import ameliorer
        except ImportError:
            stats["amelioration"] = "OR-Tools absent"
        else:
            stats["amelioration"] = ameliorer(inst, e, demande.temps_amelioration, semaines=semaines, cours_ok=ids)

    seances = _seances(inst, e, lambda x: not x["fixe"])
    placees = defaultdict(int)
    for s in seances:
        placees[s.id_cours] += s.duree
    manque = {k: restant[k] - placees[k] for k in ids if restant[k] - placees[k] > 0}
    reportees: dict[int, int] = {}
    if courte:
        # reporté : ce que les semaines suivantes peuvent encore accueillir au rythme maximal du cours
        apres_periode = (semaines[-1] + 1) if semaines else 0
        for k, h in manque.items():
            c = inst.cours[k]
            reportees[k] = min(h, inst.semaines_restantes(c, apres_periode, horizon) * c.h_max)
    non_places = []
    for k, h in sorted(manque.items()):
        h -= reportees.get(k, 0)
        if h <= 0:
            continue
        if courte:
            r = "Pas assez de semaines d'ici la fin du semestre (rythme maximal du cours, présence de l'enseignant)."
        else:
            r = raisons[k].most_common(1)[0][0] if raisons.get(k) else "pas assez de semaines"
        non_places.append(NonPlace(k, h, code_de(r) if not courte else "CAPACITE", r))
    stats.update({"heures_demandees": sum(restant.values()) - sum(reportees.values()),
                  "heures_placees": sum(placees.values()), "heures_reportees": sum(reportees.values()),
                  "duree_s": round(chrono.perf_counter() - debut_calcul, 2)})
    return Resultat(seances, fixes, remplacees, non_places, stats, reportees)
