"""Indicateurs de qualité d'un emploi du temps (SANS OR-Tools).

`score` reprend la formule de l'objectif du solveur (plus bas = mieux) pour comparer glouton et
solveur sur un même pied ; les autres indicateurs sont lisibles par un planificateur.
CS-02 (trous) n'est pas optimisée par le solveur : on la MESURE ici.
"""
from collections import defaultdict

try:  # utilisé comme paquet (from moteur_v2.solver import solve) ou comme scripts
    from .instance import SPD, Instance
except ImportError:
    from instance import SPD, Instance

PEN_NON_PLACEE = 100_000


def evaluer(data, result, inst=None):
    inst = inst or Instance(data)
    W = inst.prm["poids"]
    soft = inst.prm["max_heures_jour_souple"]
    p0 = inst.pause[0]
    sess = {(s["cid"], s["k"]): s for s in inst.sessions}

    occ = defaultdict(set)         # (entité, jour, demi) -> heures occupées
    charge = defaultdict(int)      # (entité, jour) -> heures
    sites = defaultdict(set)       # (entité, jour, demi) -> sites
    jours_cours = defaultdict(int)
    bonus = pref_hits = hors_site = 0

    for s in result["seances"]:
        ss = sess[(s["id_cours"], s["index"])]
        j, h, d = inst.jour_idx[s["jour"]], s["heure_debut"], s["duree"]
        demi = 0 if h < p0 else 1
        bonus += ss["scores"].get(j * SPD + h, 0)
        pref = inst.pref.get(ss["ens"], ())
        if any((j, hh) in pref for hh in range(h, h + d)):
            pref_hits += 1
        site = inst.salles[s["id_salle"]]["site"]
        mp = inst.classes[ss["classe"]].get("site_principal")
        if mp and site != mp and any(inst.salles[r]["site"] == mp for r in ss["rooms"]):
            hors_site += 1
        jours_cours[(s["id_cours"], j)] += 1
        for e in list(ss["entites"]) + [("E", ss["ens"])]:
            charge[(e, j)] += d
            occ[(e, j, demi)].update(range(h, h + d))
            sites[(e, j, demi)].add(site)

    # trous : heures libres entre deux séances d'une même demi-journée (groupes / promotions)
    trous = 0
    for (e, j, demi), hrs in occ.items():
        if e[0] in ("G", "C"):
            trous += (max(hrs) - min(hrs) + 1) - len(hrs)
    nb_groupes = len({e for (e, _, _) in occ if e[0] in ("G", "C")}) or 1

    # changements de site à midi
    chg_g = chg_e = 0
    vus = {(e, j) for (e, j, _) in sites}
    for e, j in vus:
        m, a = sites.get((e, j, 0)), sites.get((e, j, 1))
        if m and a and m != a:
            if e[0] == "E":
                chg_e += 1
            else:
                chg_g += 1

    exces_c4 = sum(max(0, n - 1) for n in jours_cours.values())
    exces_c6 = sum(max(0, h - soft) * (W["cs06_enseignant"] if e[0] == "E" else W["cs06_groupe"])
                   for (e, _), h in charge.items())
    jours_plus_6h = sum(1 for (e, _), h in charge.items() if e[0] != "E" and h > soft)
    total = len(inst.sessions)
    placees = len(result["seances"])
    score = (PEN_NON_PLACEE * (total - placees) - bonus + W["cs04"] * exces_c4 + exces_c6
             + W["cs03"] * (chg_g + chg_e) + W["cs09"] * hors_site)
    return {
        "score": score,
        "seances_placees": placees,
        "trous_heures_total": trous,
        "trous_heures_par_groupe": round(trous / nb_groupes, 2),
        "changements_site_midi_groupes": chg_g,
        "changements_site_midi_enseignants": chg_e,
        "seances_sur_preference_pct": round(100 * pref_hits / placees, 1) if placees else 0.0,
        "seances_hors_site_principal": hors_site,
        "jours_groupes_plus_de_6h": jours_plus_6h,
    }
