"""Moteur v2 : semaine type, séances de 2 à 4 h, OR-Tools CP-SAT (variables d'intervalle).

Contraintes dures
  - pas de chevauchement : salle, enseignant, groupe (un cours de classe entière occupe tous ses groupes)
  - capacité, type de salle, indisponibilités enseignant (filtrés avant le modèle)
  - séance entière dans une demi-journée : jamais pendant la pause, pas de samedi après-midi, 7h-18h
  - maximum 8 h de cours par jour pour chaque groupe et chaque enseignant
  - même site pendant toute une demi-journée (1 h de route ; la navette de 12h-13h permet de changer à midi)
Contraintes souples (poids dans parametres.poids)
  - cs01 préférences enseignants, cs08 débuts préférés (7h / 13h)
  - cs03 changement de site à midi, cs09 site principal de la promotion
  - cs04 séances d'un même cours sur des jours différents
  - cs06 au-delà de 6 h/jour (groupes et enseignants)
Pas encore : CS-02 (trous dans la journée), CS-05 (CM avant TD/TP).
"""
import time
from collections import defaultdict

from ortools.sat.python import cp_model

try:  # utilisé comme paquet (from moteur_v2.solver import solve) ou comme scripts
    from .greedy import meilleur_placement
    from .instance import SPD, Instance
except ImportError:
    from greedy import meilleur_placement
    from instance import SPD, Instance

PEN_NON_PLACEE = 100_000


def solve(data, log=False):
    t0 = time.time()
    inst = Instance(data)
    prm, W = inst.prm, inst.prm["poids"]
    nj = len(inst.jours)
    m = cp_model.CpModel()
    # solution gloutonne : point de départ du solveur et filet de sécurité
    glouton = (meilleur_placement(data, inst=inst, essais=prm["essais_glouton"],
                                  budget_s=prm["budget_glouton_s"])
               if prm.get("utiliser_glouton", True) else None)
    gplace = glouton["placements"] if glouton else {}

    S = [s for s in inst.sessions if s["starts"] and s["rooms"]]
    impossibles = [s for s in inst.sessions if not (s["starts"] and s["rooms"])]
    locks = {(l["id_cours"], l["index"]): l for l in data.get("seances_verrouillees", [])}

    cost = []
    room_iv = defaultdict(list)
    ent_iv = defaultdict(list)
    ent_sessions = defaultdict(list)
    par_cours = defaultdict(list)

    for s in S:
        cid, k, d = s["cid"], s["k"], s["duree"]
        tag = f"{cid}_{k}"
        p = m.NewBoolVar(f"p_{tag}")
        s["p"] = p
        start = m.NewIntVarFromDomain(cp_model.Domain.FromValues(s["starts"]), f"st_{tag}")
        s["start"] = start

        # bonus (préférences, débuts préférés) ; nul si la séance n'est pas placée
        smax = max(s["scores"].values())
        if smax > 0:
            b0 = m.NewIntVar(0, smax, f"b0_{tag}")
            m.AddAllowedAssignments([start, b0], [(st, sc) for st, sc in s["scores"].items()])
            be = m.NewIntVar(0, smax, f"be_{tag}")
            m.Add(be == b0).OnlyEnforceIf(p)
            m.Add(be == 0).OnlyEnforceIf(p.Not())
            cost.append(-be)

        # demi-journée : exactement une si placée
        halves = defaultdict(list)
        for st in s["starts"]:
            halves[inst.demi(st)].append(st)
        s["w"] = {}
        for hd, sts in halves.items():
            w = m.NewBoolVar(f"w_{tag}_{hd[0]}_{hd[1]}")
            s["w"][hd] = w
            m.Add(start >= min(sts)).OnlyEnforceIf(w)
            m.Add(start <= max(sts)).OnlyEnforceIf(w)
        m.Add(sum(s["w"].values()) == p)

        # salle : exactement une si placée
        s["y"] = {}
        for r in s["rooms"]:
            y = m.NewBoolVar(f"y_{tag}_{r}")
            s["y"][r] = y
            room_iv[r].append(m.NewOptionalFixedSizeIntervalVar(start, d, y, f"ri_{tag}_{r}"))
        m.Add(sum(s["y"].values()) == p)

        # indication de départ : la solution gloutonne
        if glouton:
            gp = gplace.get((cid, k))
            m.AddHint(p, 1 if gp else 0)
            if gp:
                m.AddHint(start, gp[0])
                for hd, w in s["w"].items():
                    m.AddHint(w, 1 if hd == inst.demi(gp[0]) else 0)
                for r, y in s["y"].items():
                    m.AddHint(y, 1 if r == gp[1] else 0)

        # site de la séance
        s["siteB"] = {}
        for nom in inst.sites:
            ys = [y for r, y in s["y"].items() if inst.salles[r]["site"] == nom]
            if not ys:
                continue
            if len(ys) == len(s["y"]):
                s["siteB"][nom] = p
            else:
                b = m.NewBoolVar(f"site_{tag}_{nom}")
                m.Add(b == sum(ys))
                s["siteB"][nom] = b

        # intervalle pour enseignant et groupes
        iv = m.NewOptionalFixedSizeIntervalVar(start, d, p, f"iv_{tag}")
        for e in list(s["entites"]) + [("E", s["ens"])]:
            ent_iv[e].append(iv)
            ent_sessions[e].append(s)
        par_cours[cid].append(s)

        # affinité de site de la promotion (cs09)
        mp = inst.classes[s["classe"]].get("site_principal")
        if mp in s["siteB"] and s["siteB"][mp] is not p:
            cost.append(W["cs09"] * (p - s["siteB"][mp]))
        elif mp in s["siteB"]:
            pass  # toutes les salles possibles sont sur le site principal
        # séance verrouillée
        if (cid, k) in locks:
            l = locks[(cid, k)]
            st = inst.jour_idx[l["jour"]] * SPD + l["heure_debut"]
            if st not in s["scores"] or l["id_salle"] not in s["y"]:
                raise ValueError(f"Séance verrouillée impossible (viole une contrainte dure) : {l}")
            m.Add(p == 1)
            m.Add(start == st)
            m.Add(s["y"][l["id_salle"]] == 1)

        cost.append(PEN_NON_PLACEE * (1 - p))

    posees = {(s["cid"], s["k"]) for s in S}
    for key in locks:
        if key not in posees:
            raise ValueError(f"Séance verrouillée sans placement possible : {locks[key]}")

    # pas de chevauchement
    for ivs in room_iv.values():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)
    for ivs in ent_iv.values():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)

    # heures par jour (dur 8 h, souple 6 h)
    hard, soft = prm["max_heures_jour"], prm["max_heures_jour_souple"]
    for e, L in ent_sessions.items():
        poids = W["cs06_enseignant"] if e[0] == "E" else W["cs06_groupe"]
        for j in range(nj):
            terms, possible = [], 0
            for s in L:
                for hf in (0, 1):
                    w = s["w"].get((j, hf))
                    if w is not None:
                        terms.append(s["duree"] * w)
                if (j, 0) in s["w"] or (j, 1) in s["w"]:
                    possible += s["duree"]
            if possible <= soft:
                continue
            load = sum(terms)
            if possible > hard:
                m.Add(load <= hard)
            ex = m.NewIntVar(0, hard, f"ex_{e[0]}{e[1]}_{j}")
            m.Add(ex >= load - soft)
            cost.append(poids * ex)

    # même site pendant une demi-journée ; changement à midi pénalisé (cs03)
    for e, L in ent_sessions.items():
        if len(L) < 2:
            continue
        uses = {}
        for j in range(nj):
            for hf in (0, 1):
                part = [s for s in L if (j, hf) in s["w"]]
                if len(part) < 2:
                    continue
                us = []
                for nom in inst.sites:
                    cands = [s for s in part if nom in s["siteB"]]
                    if not cands:
                        continue
                    u = m.NewBoolVar(f"u_{e[0]}{e[1]}_{j}_{hf}_{nom}")
                    uses[(j, hf, nom)] = u
                    us.append(u)
                    for s in cands:
                        m.AddBoolOr([s["w"][(j, hf)].Not(), s["siteB"][nom].Not(), u])
                if len(us) > 1:
                    m.AddAtMostOne(us)
        for j in range(nj):
            for a in inst.sites:
                for b in inst.sites:
                    if a == b:
                        continue
                    ua, ub = uses.get((j, 0, a)), uses.get((j, 1, b))
                    if ua is None or ub is None:
                        continue
                    ch = m.NewBoolVar(f"ch_{e[0]}{e[1]}_{j}_{a}_{b}")
                    m.AddBoolOr([ua.Not(), ub.Not(), ch])
                    cost.append(W["cs03"] * ch)

    # cs04 : séances d'un même cours sur des jours différents ; symétrie entre séances identiques
    for cid, L in par_cours.items():
        if len(L) < 2:
            continue
        for j in range(nj):
            terms = []
            for s in L:
                for hf in (0, 1):
                    w = s["w"].get((j, hf))
                    if w is not None:
                        terms.append(w)
            if len(terms) < 2:
                continue
            ex = m.NewIntVar(0, len(L), f"d4_{cid}_{j}")
            m.Add(ex >= sum(terms) - 1)
            cost.append(W["cs04"] * ex)
        if not any((cid, s["k"]) in locks for s in L):
            L.sort(key=lambda s: s["k"])
            for a, b in zip(L, L[1:]):
                if a["duree"] == b["duree"]:
                    m.Add(a["start"] <= b["start"]).OnlyEnforceIf([a["p"], b["p"]])

    seances, non_placees = [], []
    statut_nom = "AUCUNE_SEANCE"
    objectif = borne = None
    taille = {}
    t_modele = None
    solveur_saute = False
    if S:
        m.Minimize(sum(cost))
        t_modele = round(time.time() - t0, 2)
        proto = m.Proto()
        taille = {"variables": len(proto.variables), "contraintes": len(proto.constraints)}
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = prm["time_limit_s"]
        solver.parameters.num_workers = prm["num_workers"]
        solver.parameters.relative_gap_limit = prm["gap_relatif"]
        solver.parameters.log_search_progress = log
        if glouton and taille["variables"] > prm["max_variables_solveur"]:
            # trop gros pour que le solveur aboutisse (mesuré : échec à 65 000 variables sur 2 processeurs)
            solveur_saute = True
            statut = None
            statut_nom = f"GLOUTON (trop grand pour le solveur : {taille['variables']} variables)"
        else:
            statut = solver.Solve(m)
            statut_nom = solver.StatusName(statut)
        if statut in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            objectif, borne = solver.ObjectiveValue(), solver.BestObjectiveBound()
            for s in S:
                if solver.Value(s["p"]):
                    j, h = divmod(solver.Value(s["start"]), SPD)
                    r = next(r for r, y in s["y"].items() if solver.Value(y))
                    seances.append({"id_cours": s["cid"], "index": s["k"], "jour": inst.jours[j],
                                    "heure_debut": h, "heure_fin": h + s["duree"], "duree": s["duree"],
                                    "id_salle": r, "id_enseignant": s["ens"]})
                else:
                    non_placees.append({"id_cours": s["cid"], "index": s["k"],
                                        "motif": inst.explication(s)})
    for s in impossibles:
        non_placees.append({"id_cours": s["cid"], "index": s["k"], "motif": inst.explication(s)})

    jidx = {j: i for i, j in enumerate(inst.jours)}
    seances.sort(key=lambda x: (jidx[x["jour"]], x["heure_debut"], x["id_salle"]))
    # repli : si le solveur n'a rien trouvé ou fait moins bien que le glouton, on garde le glouton
    if glouton and (solveur_saute or len(seances) < len(glouton["seances"])):
        if not solveur_saute:
            statut_nom = f"GLOUTON (solveur : {statut_nom})"
        seances, non_placees = glouton["seances"], glouton["non_placees"]
    total = len(inst.sessions)
    return {"statut": statut_nom, "seances": seances, "non_placees": non_placees,
            "taux_placement": round(len(seances) / total, 4) if total else 1.0,
            "objectif": objectif, "borne": borne, "taille_modele": taille,
            "temps_construction_s": t_modele,
            "glouton": ({"taux_placement": glouton["taux_placement"], "temps_s": glouton["temps_s"]}
                        if glouton else None),
            "avertissements": inst.diagnostics(), "temps_s": round(time.time() - t0, 2)}


if __name__ == "__main__":
    import json
    import sys
    from validate import validate

    data = json.load(open(sys.argv[1], encoding="utf-8"))
    res = solve(data, log="--log" in sys.argv)
    res["violations"] = validate(data, res)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    sys.exit(1 if res["violations"] else 0)
