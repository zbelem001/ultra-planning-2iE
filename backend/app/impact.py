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
from ultraplanning_solver.donnees import Donnees, Seance


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

    enseignants: dict[int, int] = defaultdict(int)
    for k in touches:
        enseignants[d.cours[k].id_enseignant] += supprimees[k] + creees[k]
    a_prevenir = [
        {"enseignant": d.enseignants[e].nom, "statut": d.enseignants[e].statut, "seances_modifiees": n}
        for e, n in sorted(enseignants.items(), key=lambda x: -x[1])
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
            charge[c.id_enseignant, s.date_seance] += s.duree
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

    return {
        "seances_deplacees": deplacees,
        "seances_supprimees": sum(supprimees.values()),
        "seances_creees": sum(creees.values()),
        "heures_perdues": heures_perdues,
        "heures_reportees": heures_reportees,
        "enseignants_a_prevenir": a_prevenir,
        "classes_concernees": sorted({d.classes[d.cours[k].id_classe].code_classe for k in touches}),
        "fins_decalees": decalees,
        "journees_chargees": journees,
        "changements_de_site": sites,
    }


def resume(impact: dict) -> list[str]:
    """Texte des conséquences, lu par l'assistant."""
    lignes = ["Conséquences :"]
    if not (impact["seances_supprimees"] or impact["seances_creees"]):
        lignes.append("- Aucun changement : l'emploi du temps actuel satisfait déjà la demande.")
        return lignes
    lignes.append(f"- {impact['seances_deplacees']} séance(s) déplacée(s) ; classes concernées : {', '.join(impact['classes_concernees'])}.")
    if impact["heures_perdues"]:
        total = sum(h["heures"] for h in impact["heures_perdues"])
        lignes.append(f"- ATTENTION : {total} h ne seraient plus programmées sur la période :")
        lignes += [f"  · {h['cours']} : {h['heures']} h ({h['raison']})" for h in impact["heures_perdues"]]
    if impact.get("heures_reportees"):
        total = sum(h["heures"] for h in impact["heures_reportees"])
        lignes.append(f"- {total} h restent à programmer après la période (volume restant, selon le rythme des cours) : "
                      + ", ".join(f"{h['cours']} {h['heures']} h" for h in impact["heures_reportees"]) + ".")
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
    return lignes
