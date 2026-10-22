"""Placement glouton (SANS OR-Tools) : premier emploi du temps valide, rapide.

Sert de filet de sécurité et de point de départ (hint) pour le solveur CP-SAT.
Respecte les mêmes contraintes dures que le solveur : pas de chevauchement (salle, enseignant, groupes),
8 h/jour max, même site pendant une demi-journée, pause, samedi matin, capacité/type, indisponibilités.
On place d'abord les séances les plus contraintes ; chaque séance prend le placement de moindre coût.
"""
import random
import time
from collections import defaultdict

try:  # utilisé comme paquet (from moteur_v2.solver import solve) ou comme scripts
    from .instance import SPD, Instance
    from .qualite import evaluer
except ImportError:
    from instance import SPD, Instance
    from qualite import evaluer


def construire(data, inst=None, graine=None):
    """graine=None : ordre déterministe ; sinon l'ordre de placement est légèrement perturbé."""
    t0 = time.time()
    inst = inst or Instance(data)
    W = inst.prm["poids"]
    hard, soft = inst.prm["max_heures_jour"], inst.prm["max_heures_jour_souple"]
    p0 = inst.pause[0]
    locks = {(l["id_cours"], l["index"]): l for l in data.get("seances_verrouillees", [])}

    busy = set()                          # (ressource, jour, heure)
    charge = defaultdict(int)             # (entité, jour) -> heures
    site_demi = {}                        # (entité, jour, demi) -> site
    nb_jour = defaultdict(int)            # (cours, jour) -> séances
    place = {}                            # (cid, k) -> (start, salle)

    def poser(s, ents, st, r):
        j, h = divmod(st, SPD)
        demi = 0 if h < p0 else 1
        site = inst.salles[r]["site"]
        for hh in range(h, h + s["duree"]):
            busy.add((("S", r), j, hh))
            for e in ents:
                busy.add((e, j, hh))
        for e in ents:
            charge[(e, j)] += s["duree"]
            site_demi[(e, j, demi)] = site
        nb_jour[(s["cid"], j)] += 1
        place[(s["cid"], s["k"])] = (st, r)

    jeux = [s for s in inst.sessions if s["starts"] and s["rooms"]]
    impossibles = [s for s in inst.sessions if not (s["starts"] and s["rooms"])]
    if graine is None:
        jeux.sort(key=lambda s: (len(s["starts"]) * len(s["rooms"]), -s["duree"]))
    else:
        rnd = random.Random(graine)
        jeux.sort(key=lambda s: (len(s["starts"]) * len(s["rooms"]) * rnd.uniform(0.6, 1.4), -s["duree"]))

    # séances verrouillées d'abord
    for s in jeux:
        l = locks.get((s["cid"], s["k"]))
        if l:
            st = inst.jour_idx[l["jour"]] * SPD + l["heure_debut"]
            if st not in s["scores"] or l["id_salle"] not in s["rooms"]:
                raise ValueError(f"Séance verrouillée impossible : {l}")
            poser(s, list(s["entites"]) + [("E", s["ens"])], st, l["id_salle"])

    for s in jeux:
        if (s["cid"], s["k"]) in place:
            continue
        ents = list(s["entites"]) + [("E", s["ens"])]
        d = s["duree"]
        mp = inst.classes[s["classe"]].get("site_principal")
        best = None
        for st in s["starts"]:
            j, h = divmod(st, SPD)
            demi = 0 if h < p0 else 1
            hrs = range(h, h + d)
            if any((e, j, hh) in busy for e in ents for hh in hrs):
                continue
            if any(charge[(e, j)] + d > hard for e in ents):
                continue
            imposed, ok = None, True
            for e in ents:
                sx = site_demi.get((e, j, demi))
                if sx is not None:
                    if imposed is None:
                        imposed = sx
                    elif imposed != sx:
                        ok = False
                        break
            if not ok:
                continue
            base = -s["scores"][st] + W["cs04"] * nb_jour[(s["cid"], j)]
            for e in ents:
                c = charge[(e, j)]
                base += (max(0, c + d - soft) - max(0, c - soft)) * (
                    W["cs06_enseignant"] if e[0] == "E" else W["cs06_groupe"])
            for r in s["rooms"]:
                site = inst.salles[r]["site"]
                if imposed is not None and site != imposed:
                    continue
                if any((("S", r), j, hh) in busy for hh in hrs):
                    continue
                cost = base + (W["cs09"] if mp and site != mp else 0)
                for e in ents:
                    so = site_demi.get((e, j, 1 - demi))
                    if so is not None and so != site:
                        cost += W["cs03"]
                if best is None or cost < best[0]:
                    best = (cost, st, r)
        if best:
            poser(s, ents, best[1], best[2])

    # symétrie : séances identiques d'un même cours rangées par horaire croissant (cohérent avec le solveur)
    par_cours = defaultdict(list)
    for s in jeux:
        par_cours[(s["cid"], s["duree"])].append(s)
    for L in par_cours.values():
        L.sort(key=lambda s: s["k"])
        posees = [s for s in L if (s["cid"], s["k"]) in place]
        valeurs = sorted((place[(s["cid"], s["k"])] for s in posees))
        for s, v in zip(posees, valeurs):
            place[(s["cid"], s["k"])] = v

    seances, non_placees = [], []
    for s in jeux:
        if (s["cid"], s["k"]) in place:
            st, r = place[(s["cid"], s["k"])]
            j, h = divmod(st, SPD)
            seances.append({"id_cours": s["cid"], "index": s["k"], "jour": inst.jours[j],
                            "heure_debut": h, "heure_fin": h + s["duree"], "duree": s["duree"],
                            "id_salle": r, "id_enseignant": s["ens"]})
        else:
            non_placees.append({"id_cours": s["cid"], "index": s["k"], "motif": inst.explication(s)})
    for s in impossibles:
        non_placees.append({"id_cours": s["cid"], "index": s["k"], "motif": inst.explication(s)})
    jidx = {j: i for i, j in enumerate(inst.jours)}
    seances.sort(key=lambda x: (jidx[x["jour"]], x["heure_debut"], x["id_salle"]))
    total = len(inst.sessions)
    return {"statut": "GLOUTON", "seances": seances, "non_placees": non_placees,
            "taux_placement": round(len(seances) / total, 4) if total else 1.0,
            "placements": place, "temps_s": round(time.time() - t0, 2)}


def meilleur_placement(data, inst=None, essais=12, budget_s=20):
    """Relance le glouton avec des ordres différents et garde le meilleur résultat :
    d'abord le moins de séances non placées, puis le meilleur score de qualité."""
    t0 = time.time()
    inst = inst or Instance(data)
    meilleur = None
    for i in range(essais):
        r = construire(data, inst, graine=None if i == 0 else i)
        cle = (len(r["non_placees"]), evaluer(data, r, inst)["score"])
        if meilleur is None or cle < meilleur[0]:
            meilleur = (cle, r)
        if time.time() - t0 > budget_s:
            break
    res = meilleur[1]
    res["essais"] = i + 1
    res["temps_s"] = round(time.time() - t0, 2)
    return res
