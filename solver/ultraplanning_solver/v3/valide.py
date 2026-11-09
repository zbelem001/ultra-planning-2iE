"""Validateur indépendant : recompte les règles dures sur les séances produites,
à partir des données brutes (sans réutiliser le code du placement).

L'enseignant d'une séance est son `id_enseignant` s'il est donné (sinon celui du cours) ;
une séance sans enseignant (à désigner) n'a aucun contrôle d'enseignant."""
from __future__ import annotations

from collections import defaultdict
from datetime import date

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]


def valider(data: dict, seances: list[dict]) -> list[str]:
    v: list[str] = []
    cal = data["calendrier"]
    fer = set(cal.get("jours_feries", []))
    conges = cal.get("conges", [])
    salles = {s["id_salle"]: s for s in data["salles"]}
    classes = {c["id_classe"]: c for c in data["classes"]}
    groupes = {g["id_groupe"]: g for g in data["groupes"]}
    ens = {e["id_enseignant"]: e for e in data["enseignants"]}
    cours = {c["id_cours"]: c for c in data["cours"]}
    plafond = data.get("parametres", {}).get("plafond_jour_dur", 8)
    for r in data.get("regles", []):
        if r["type"] == "plafond_jour" and r.get("dure", True):
            plafond = min(plafond, r["heures"])
    bloquees = {(b["id_salle"], b["date"], h) for b in data.get("salles_bloquees", []) for h in range(b["debut"], b["fin"])}

    def ancetres(g):
        out = []
        while g is not None:
            out.append(g)
            g = groupes[g]["parent"]
        return out

    def chevauche_public(p, q):
        """Deux publics partagent des étudiants si même promotion et : l'un contient l'autre,
        ou leurs branches se séparent sur deux groupes frères de types différents
        (découpages croisés, ex. TD et TP)."""
        if p["id_classe"] != q["id_classe"]:
            return False
        if p.get("id_groupe") is None or q.get("id_groupe") is None:
            return True
        a, b = ancetres(p["id_groupe"])[::-1], ancetres(q["id_groupe"])[::-1]   # depuis la racine
        i = 0
        while i < min(len(a), len(b)) and a[i] == b[i]:
            i += 1
        if i == len(a) or i == len(b):
            return True
        return groupes[a[i]]["type_groupe"] != groupes[b[i]]["type_groupe"]

    trajet_h = -(-max(data.get("trajet_min", {}).values() or [60]) // 60)
    ens_jour_sites = defaultdict(list)    # (enseignant, date) -> [(début, fin, site)]
    occ_salle, occ_ens = {}, {}
    par_heure = defaultdict(list)
    h_jour_ens = defaultdict(int)
    h_classe_jour = defaultdict(list)
    demi_sites = defaultdict(list)   # (date, demi-journée) -> [(publics, campus)]
    fait = defaultdict(int)
    fin_matiere, debut_matiere = {}, {}
    for s in seances:
        c = cours[s["id_cours"]]
        d = s["date"]
        dt = date.fromisoformat(d)
        h0, h1 = int(s["heure_debut"][:2]), int(s["heure_fin"][:2])
        jour = JOURS[dt.weekday()] if dt.weekday() < 6 else "Dimanche"
        tag = f"cours {c['id_cours']} le {d} {h0}h-{h1}h"
        if any((s["id_salle"], d, h) in bloquees for h in range(h0, h1)):
            v.append(f"{tag} : salle prise par une épreuve")
        fait[c["id_cours"]] += h1 - h0
        m = c["id_matiere"]
        fin_matiere[m] = max(fin_matiere.get(m, (d, h1)), (d, h1))
        debut_matiere[m] = min(debut_matiere.get(m, (d, h0)), (d, h0))
        # jour et plage
        if jour == "Dimanche" or d in fer or any(a <= d <= b for a, b in conges) or not (cal["debut"] <= d <= cal["fin"]):
            v.append(f"{tag} : jour fermé")
        plages = cal["plages"].get(jour, [])
        demi = next((i for i, (a, b) in enumerate(plages) if a <= h0 and h1 <= b), None)
        if demi is None:
            v.append(f"{tag} : hors des plages horaires")
        # salle
        sa = salles[s["id_salle"]]
        eff = sum(groupes[p["id_groupe"]]["effectif"] if p.get("id_groupe") else classes[p["id_classe"]]["effectif"]
                  for p in c["publics"])
        if sa["capacite"] < eff:
            v.append(f"{tag} : salle trop petite ({sa['capacite']} < {eff})")
        types = c.get("types_salle") or ([c["id_type_salle"]] if c.get("id_type_salle") is not None else [])
        if types and sa["id_type_salle"] not in types:
            v.append(f"{tag} : mauvais type de salle")
        demi_sites[d, demi].append((c["publics"], sa["id_site"]))   # campus par demi-journée
        if sa.get("reservee_a") and not set(sa["reservee_a"]) & {p["id_classe"] for p in c["publics"]}:
            v.append(f"{tag} : salle réservée à d'autres promotions")
        # enseignant de la séance
        k_ens = s.get("id_enseignant", c.get("id_enseignant"))
        e = ens.get(k_ens, {})
        if e.get("statut") in ("externe_non_resident", "externe") and not any(a <= d <= b for a, b in e.get("sejours", [])):
            v.append(f"{tag} : enseignant externe hors de son séjour")
        if any(x <= d <= y for x, y in e.get("absences", [])):
            v.append(f"{tag} : enseignant absent ce jour")
        for i in e.get("indisponibilites", []):
            if ("demi" in i and i["jour"] == jour and i["demi"] == demi) or                ("heure_debut" in i and i["jour"] == jour and i["heure_debut"] < h1 and h0 < i["heure_fin"]):
                v.append(f"{tag} : enseignant indisponible")
                break
        if k_ens is not None:
            h_jour_ens[k_ens, d] += h1 - h0
            ens_jour_sites[k_ens, d].append((h0, h1, sa["id_site"]))
        # règles « interdire » (demi-journée ou heures) et « imposer » (heures)
        for r in data.get("regles", []):
            if r["type"] not in ("interdire", "imposer") or not r.get("dure", True):
                continue
            cib = r.get("cible", {})
            if "id_classe" in cib and cib["id_classe"] not in {p["id_classe"] for p in c["publics"]}:
                continue
            if "id_enseignant" in cib and cib["id_enseignant"] != c.get("id_enseignant"):
                continue
            if "id_cours" in cib and cib["id_cours"] != c["id_cours"]:
                continue
            dans_dates = not (("du" in r and d < r["du"]) or ("au" in r and d > r["au"]))
            dans_jours = not r.get("jours") or jour in r["jours"]
            if r.get("heure_min") is None and r.get("heure_max") is None and r["type"] == "interdire":
                touche = r.get("demi") is None or r["demi"] == demi
                viole = dans_dates and dans_jours and touche
            else:
                lo, hi = r.get("heure_min") or 0, r.get("heure_max") or 24 * 60
                if r["type"] == "imposer":
                    viole = not (dans_dates and dans_jours and h0 * 60 >= lo and h1 * 60 <= hi)
                else:
                    viole = dans_dates and dans_jours and h0 * 60 < hi and h1 * 60 > lo
            if viole:
                v.append(f"{tag} : règle {r['id']} « {r.get('libelle', '')} »")
        for h in range(h0, h1):
            k = (s["id_salle"], d, h)
            if k in occ_salle:
                v.append(f"{tag} : salle {s['id_salle']} déjà prise par le cours {occ_salle[k]}")
            occ_salle[k] = c["id_cours"]
            if k_ens is not None:
                k = (k_ens, d, h)
                if k in occ_ens:
                    v.append(f"{tag} : enseignant déjà en cours ({occ_ens[k]})")
                occ_ens[k] = c["id_cours"]
            par_heure[d, h].append(c)
        for p in c["publics"]:
            h_classe_jour[p["id_classe"], d].append((p, h1 - h0))
    # étudiants : deux cours en même temps sur des publics qui se croisent
    for (d, h), liste in par_heure.items():
        for i in range(len(liste)):
            for j in range(i + 1, len(liste)):
                if any(chevauche_public(p, q) for p in liste[i]["publics"] for q in liste[j]["publics"]):
                    v.append(f"le {d} à {h}h : cours {liste[i]['id_cours']} et {liste[j]['id_cours']} ont des étudiants communs")
    # les mêmes étudiants n'ont cours que sur un campus par demi-journée
    for (d, demi), liste in demi_sites.items():
        for i in range(len(liste)):
            for j in range(i + 1, len(liste)):
                (pa, sa_), (pb, sb_) = liste[i], liste[j]
                if sa_ != sb_ and any(chevauche_public(p, q) for p in pa for q in pb):
                    v.append(f"le {d} : étudiants communs sur deux campus la même demi-journée")
    # temps de trajet entre deux sites le même jour
    for (k, d), liste in ens_jour_sites.items():
        for a0, a1, sa in liste:
            for b0, b1, sb in liste:
                if sa != sb and a1 <= b0 and b0 - a1 < trajet_h:
                    v.append(f"enseignant {k} le {d} : {a1}h site {sa} puis {b0}h site {sb}, trajet trop court")
    # plafonds journaliers
    for (k, d), h in h_jour_ens.items():
        if h > plafond:
            v.append(f"enseignant {k} le {d} : {h} h > {plafond} h")
    feuilles_classe = defaultdict(list)
    parents = {g["parent"] for g in groupes.values() if g["parent"]}
    for g in groupes.values():
        if g["id_groupe"] not in parents:
            feuilles_classe[g["id_classe"]].append(g["id_groupe"])
    for (ic, d), liste in h_classe_jour.items():
        feuilles = feuilles_classe.get(ic) or [None]
        for f in feuilles:
            q = {"id_classe": ic, "id_groupe": f}
            h = sum(n for p, n in liste if chevauche_public(p, q))
            if h > plafond:
                v.append(f"promotion {ic} (groupe {f}) le {d} : {h} h > {plafond} h")
                break
    # le rythme hebdomadaire d'un cours (CS-08) est souple depuis la version 18 : ce n'est pas une violation
    # au plus N matières par promotion et par semaine ISO (CD-13)
    n_max = data.get("parametres", {}).get("max_matieres_semaine")
    if n_max:
        matieres = defaultdict(set)
        for s in seances:
            c = cours[s["id_cours"]]
            iso = date.fromisoformat(s["date"]).isocalendar()
            for p in c["publics"]:
                matieres[p["id_classe"], iso[0], iso[1]].add(c["id_matiere"])
        for (ic, a, w), ms in matieres.items():
            if len(ms) > n_max:
                v.append(f"promotion {ic} semaine {a}-S{w} : {len(ms)} matières > {n_max} (CD-13)")
    # volumes et ordre des matières
    for k, h in fait.items():
        if h > cours[k]["volume"]:
            v.append(f"cours {k} : {h} h placées pour un volume de {cours[k]['volume']} h")
    for r in data.get("regles", []):
        if r["type"] == "precede" and r.get("dure", True):
            a, b = r["matiere_avant"], r["matiere_apres"]
            if a in fin_matiere and b in debut_matiere and fin_matiere[a] > debut_matiere[b]:
                v.append(f"règle {r['id']} : la matière {b} commence avant la fin de {a}")
    return v
