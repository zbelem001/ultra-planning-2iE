"""Conséquences d'une replanification, pour que l'assistant argumente et que le
planificateur décide en connaissance de cause.

On compare l'emploi du temps avant (séances conservées + remplacées) et après
(séances conservées + nouvelles) et on relève ce qui touche les personnes :
heures perdues, enseignants à prévenir, cours qui finissent plus tard,
journées trop chargées, changements de site dans la journée d'une classe.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from ultraplanning_solver import Resultat
from ultraplanning_solver.donnees import Donnees, Seance, lundi_de


def _libelle(d: Donnees, noms: dict[int, str], id_cours: int) -> str:
    c = d.cours[id_cours]
    public = d.classes[c.id_classe].code_classe
    if c.id_groupe is not None:
        public += f" · {d.groupes[c.id_groupe].code_groupe}"
    return f"{noms.get(c.id_matiere, f'matière {c.id_matiere}')} {c.type_cours} ({public})"


def analyser(d: Donnees, r: Resultat, noms_matieres: dict[int, str]) -> dict:
    avant = r.conservees + r.remplacees
    apres = r.conservees + r.seances
    ops = r.modifications()
    touches = {o["avant"]["id_cours"] if "avant" in o else o["apres"]["id_cours"] for o in ops}
    lib = lambda k: _libelle(d, noms_matieres, k)  # noqa: E731

    # Séances déplacées : pour chaque cours, min(supprimées, créées) ; le reste est perdu ou ajouté
    supprimees, creees = defaultdict(int), defaultdict(int)
    for o in ops:
        if o["action"] == "supprimer":
            supprimees[o["avant"]["id_cours"]] += 1
        else:
            creees[o["apres"]["id_cours"]] += 1
    deplacees = sum(min(supprimees[k], creees[k]) for k in touches)

    heures_perdues = [
        {"cours": lib(n.id_cours), "heures": n.heures, "regle": n.code, "raison": n.raison} for n in r.non_places
    ]
    # Génération sur une courte période : heures prévues après elle (pas perdues)
    heures_reportees = [{"cours": lib(k), "heures": h} for k, h in sorted(r.reportees.items()) if h > 0]
    # Séances à ramener dans la période qui n'y ont pas trouvé de place : elles restent où elles sont
    # (hors période)
    restees = [{"cours": lib(x["id_cours"]), "date": x["date"], "heure_debut": x["heure_debut"],
                "heure_fin": x["heure_fin"], "raison": x["raison"]}
               for x in r.statistiques.get("restees_hors_periode", [])]

    # Enseignants des séances retirées et des séances créées (pas forcément celui prévu du cours)
    # (une séance déplacée est retirée puis créée : elle ne compte qu'une fois)
    enseignants: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for o in ops:
        e = (o.get("apres") or o.get("avant") or {}).get("id_enseignant")
        if e is not None:
            enseignants[e][o["action"] == "creer"] += 1
    a_prevenir = [
        {"enseignant": d.enseignants[e].nom, "statut": d.enseignants[e].statut, "seances_modifiees": max(n)}
        for e, n in sorted(enseignants.items(), key=lambda x: -max(x[1]))
    ]

    def fins(seances: list[Seance]) -> dict[int, date]:
        out: dict[int, date] = {}
        for s in seances:
            if s.id_cours in touches:
                out[s.id_cours] = max(out.get(s.id_cours, s.date_seance), s.date_seance)
        return out

    fin_avant, fin_apres = fins(avant), fins(apres)
    decalees = [
        {"cours": lib(k), "fin_avant": fin_avant[k].isoformat(), "fin_apres": fin_apres[k].isoformat(),
         "jours": (fin_apres[k] - fin_avant[k]).days}
        for k in sorted(touches) if k in fin_avant and k in fin_apres and fin_apres[k] != fin_avant[k]
    ]

    # Journées d'enseignant au-delà du plafond (CS-06) et changements de site, sur les jours touchés
    jours_touches = {s.date_seance for s in r.seances} | {s.date_seance for s in r.remplacees}

    def charge_et_sites(seances: list[Seance]):
        charge: dict[tuple[int, date], int] = defaultdict(int)
        sites: dict[tuple[int, date], set[int]] = defaultdict(set)
        for s in seances:
            if s.date_seance not in jours_touches:
                continue
            c = d.cours[s.id_cours]
            if s.id_enseignant is not None:
                charge[s.id_enseignant, s.date_seance] += s.duree
            sites[c.id_classe, s.date_seance].add(d.salles[s.id_salle].id_site)
        return charge, sites

    charge_avant, sites_avant = charge_et_sites(avant)
    charge_apres, sites_apres = charge_et_sites(apres)
    journees = [
        {"enseignant": d.enseignants[e].nom, "date": j.isoformat(), "heures": h, "plafond": d.plafond_heures_jour}
        for (e, j), h in sorted(charge_apres.items(), key=lambda x: x[0][1])
        if h > d.plafond_heures_jour and charge_avant.get((e, j), 0) < h
    ]
    sites = [
        {"classe": d.classes[cl].code_classe, "date": j.isoformat(), "sites": len(ss)}
        for (cl, j), ss in sorted(sites_apres.items(), key=lambda x: x[0][1])
        if len(ss) > 1 and len(sites_avant.get((cl, j), set())) < len(ss)
    ]

    # Rythme souhaité des cours (CS-08, souple) : semaines où un cours touché le dépasse, plus qu'avant
    def par_semaine(seances: list[Seance]) -> dict[tuple[int, date], int]:
        out: dict[tuple[int, date], int] = defaultdict(int)
        for s in seances:
            if s.id_cours in touches:
                out[s.id_cours, lundi_de(s.date_seance)] += s.duree
        return out

    sem_avant, sem_apres = par_semaine(avant), par_semaine(apres)
    au_dela = [
        {"cours": lib(k), "semaine": lundi.isoformat(), "heures": h, "rythme": d.cours[k].heures_semaine_max}
        for (k, lundi), h in sorted(sem_apres.items(), key=lambda x: (x[0][1], x[0][0]))
        if h > d.cours[k].heures_semaine_max and h > sem_avant.get((k, lundi), 0)
    ]

    return {
        "seances_deplacees": deplacees,
        # en plus des séances déplacées, qui sont retirées puis recréées
        "seances_supprimees": sum(supprimees.values()) - deplacees,
        "seances_creees": sum(creees.values()) - deplacees,
        "heures_perdues": heures_perdues,
        "heures_reportees": heures_reportees,
        "restees_hors_periode": restees,
        "enseignants_a_prevenir": a_prevenir,
        "classes_concernees": sorted({d.classes[d.cours[k].id_classe].code_classe for k in touches}),
        "fins_decalees": decalees,
        "journees_chargees": journees,
        "changements_de_site": sites,
        "au_dela_du_rythme": au_dela,
    }


def lignes_restees(impact: dict) -> list[str]:
    restees = impact.get("restees_hors_periode")
    if not restees:
        return []
    return [f"- {len(restees)} séance(s) n'ont pas de place dans la période et restent où elles sont :",
            *(f"  · {x['cours']} le {x['date']} {x['heure_debut'][:5]}–{x['heure_fin'][:5]} ({x['raison']})" for x in restees)]


def resume(impact: dict) -> list[str]:
    """Texte des conséquences d'une proposition, lu par l'assistant."""
    lignes = ["Conséquences :"]
    lignes.append(f"- {impact['seances_deplacees']} séance(s) déplacée(s) ; classes concernées : {', '.join(impact['classes_concernees'])}.")
    if impact["heures_perdues"]:
        total = sum(h["heures"] for h in impact["heures_perdues"])
        lignes.append(f"- ATTENTION : {total} h ne seraient plus programmées sur la période :")
        lignes += [f"  · {h['cours']} : {h['heures']} h ({h['raison']})" for h in impact["heures_perdues"]]
    if impact.get("heures_reportees"):
        total = sum(h["heures"] for h in impact["heures_reportees"])
        lignes.append(f"- {total} h restent à programmer après la période (volume restant, selon le rythme des cours) : "
                      + ", ".join(f"{h['cours']} {h['heures']} h" for h in impact["heures_reportees"]) + ".")
    lignes += lignes_restees(impact)
    if impact["enseignants_a_prevenir"]:
        lignes.append("- Enseignants à prévenir : " + ", ".join(
            f"{e['enseignant']} ({e['seances_modifiees']} séance(s){', externe' if e['statut'] == 'externe' else ''})"
            for e in impact["enseignants_a_prevenir"]) + ".")
    for f in impact["fins_decalees"]:
        sens = "plus tard" if f["jours"] > 0 else "plus tôt"
        lignes.append(f"- {f['cours']} finit {abs(f['jours'])} jour(s) {sens} (le {f['fin_apres']} au lieu du {f['fin_avant']}).")
    for j in impact["journees_chargees"]:
        lignes.append(f"- Journée chargée : {j['enseignant']} aurait {j['heures']} h le {j['date']} (préférence : {j['plafond']} h au plus).")
    for s in impact["changements_de_site"]:
        lignes.append(f"- {s['classe']} changerait de site dans la journée du {s['date']}.")
    for x in impact.get("au_dela_du_rythme", []):
        lignes.append(f"- Au-delà du rythme souhaité (CS-08, souple) : {x['cours']} aurait {x['heures']} h la semaine du "
                      f"{x['semaine']} (rythme souhaité : {x['rythme']} h). C'est permis ; signale-le.")
    return lignes
