"""Indicateurs de qualité d'un emploi du temps (format v3), pour comparer deux résultats."""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from .instance import JOURS, Instance


def evaluer(inst: Instance, seances: list[dict]) -> dict:
    par_atome_jour = defaultdict(set)      # (atome, date) -> heures occupées
    ens_sites = defaultdict(set)
    ens_jours = set()
    sur_pref = samedi = 0
    semaines_cours = defaultdict(set)
    h_total = 0
    for s in seances:
        c = inst.cours[s["id_cours"]]
        d = date.fromisoformat(s["date"])
        h0, h1 = int(s["heure_debut"][:2]), int(s["heure_fin"][:2])
        h_total += h1 - h0
        for a in c.atomes:
            par_atome_jour[a, d].update(range(h0, h1))
        ens_sites[c.enseignant, d].add(inst.salles[s["id_salle"]]["id_site"])
        ens_jours.add((c.enseignant, d))
        jour = JOURS[d.weekday()]
        demi = 0 if h0 < 12 else 1
        if (jour, demi) in inst.ens_pref[c.enseignant]:
            sur_pref += h1 - h0
        if jour == "Samedi":
            samedi += h1 - h0
        semaines_cours[c.id].add((d - inst.lundi0).days // 7)
    # trou : heure libre entre deux heures de cours d'une même demi-journée (la pause ne compte pas)
    trous = 0
    for (a, d), hs in par_atome_jour.items():
        for lo, hi in ((7, 12), (13, 19)):
            x = sorted(h for h in hs if lo <= h < hi)
            if x:
                trous += (x[-1] - x[0] + 1) - len(x)
    n_atomes = max(1, len({a for a, _ in par_atome_jour}))
    # étalement : nombre de semaines où le cours a lieu, rapporté au minimum nécessaire
    etal = [len(w) for w in semaines_cours.values()]
    return {
        "heures": h_total,
        "trous_h_par_etudiant_et_semaine": round(trous / n_atomes / max(1, inst.n_semaines), 2),
        "enseignant_deux_sites_jours": sum(1 for v in ens_sites.values() if len(v) > 1),
        "heures_sur_preference_pct": round(100 * sur_pref / max(1, h_total), 1),
        "heures_le_samedi_pct": round(100 * samedi / max(1, h_total), 1),
        "semaines_par_cours_moy": round(sum(etal) / max(1, len(etal)), 1),
        "jours_de_presence_enseignants": len(ens_jours),
    }
