"""Amélioration par OR-Tools CP-SAT sur de petits sous-problèmes (recherche à grand voisinage).

Sous-problème = une promotion × une semaine. Ses séances de la semaine sont libérées
(elles DOIVENT être replacées : le résultat ne peut pas régresser), on ajoute en option
des séances pour ses cours encore incomplets, et CP-SAT maximise les heures ajoutées,
le reste de l'emploi du temps étant figé. OR-Tools reste ainsi efficace : quelques
milliers de variables par sous-problème, au lieu du problème entier qui ne passe pas.
"""
from __future__ import annotations

import time as chrono
from collections import defaultdict
from datetime import date

from .instance import JOURS, Instance
from .planif import Etat, trajet_ok

SALLES_PAR_CRENEAU = 3


def etat_depuis(inst: Instance, seances: list[dict]) -> Etat:
    """Reconstruit l'état de placement à partir de séances au format de sortie."""
    e = Etat(inst)
    index = {d: i for i, d in enumerate(inst.dates)}
    for s in seances:
        di = index[date.fromisoformat(s["date"])]
        h0, h1 = int(s["heure_debut"][:2]), int(s["heure_fin"][:2])
        e.poser(inst.cours[s["id_cours"]], di, h0, h1 - h0, s["id_salle"])
    return e


def _candidats(inst: Instance, e: Etat, c, duree: int, w: int, apres, avant, origine=None):
    """Placements (jour, début, salle, coût) compatibles avec la partie figée."""
    P = inst.param["poids"]
    out = []
    pres = inst.ens_present[c.enseignant]
    for di in inst.jours_semaine[w]:
        if not pres[di]:
            continue
        jour = JOURS[inst.dates[di].weekday()]
        eh = e.ens_h.get((c.enseignant, di), set())
        autres = {x for x, n in e.ens_site.get((c.enseignant, di), {}).items() if n > 0} - {c.site}
        loin = [h for h, x in e.ens_heure_site.get((c.enseignant, di), {}).items() if x != c.site]
        if autres and inst.deux_sites_dur:
            continue
        for demi, (a, b) in enumerate(inst.plages[di]):
            if (jour, demi) in inst.ens_indispo[c.enseignant] or inst.interdit(c, jour, demi, di):
                continue
            for s in range(a, b - duree + 1):
                if (apres and (di, s) < apres) or (avant and (di, s + duree) > avant):
                    continue
                hs = range(s, s + duree)
                if any(h in eh for h in hs) or any(e.occupe.get((di, h), 0) & c.masque for h in hs):
                    continue
                if not trajet_ok(loin, s, duree, inst.trajet_h):
                    continue
                if any((jour, h) in inst.ens_indispo_h[c.enseignant] for h in hs):
                    continue
                libres = [r for r in c.salles if all((r, di, h) not in e.salle_occ for h in hs)]
                garde = libres[:SALLES_PAR_CRENEAU]
                if origine and origine[0] == di and origine[1] == s and origine[2] in libres and origine[2] not in garde:
                    garde.append(origine[2])
                cout = 0
                if (jour, demi) in inst.ens_pref[c.enseignant]:
                    cout -= P["preference"]
                if s == a:
                    cout -= P["debut_demi"]
                if autres:
                    cout += P["enseignant_deux_sites"]
                if jour == "Samedi":
                    cout += P["samedi"]
                for r in garde:
                    out.append((di, s, r, cout))
    return out


def _bornes(inst: Instance, e: Etat, c, suivantes):
    preds = inst.precede.get(c.matiere, [])
    if any(e.reste_matiere[m] > 0 for m in preds):
        return None
    apres = max((e.fin_matiere[m] for m in preds if m in e.fin_matiere), default=None)
    avant = min((e.debut_matiere[m] for m in suivantes.get(c.matiere, []) if m in e.debut_matiere), default=None)
    return apres, avant


def sous_probleme(inst: Instance, e: Etat, ic: int, w: int, temps: float, suivantes) -> int:
    """Réoptimise la promotion ic sur la semaine w. Renvoie les heures gagnées."""
    from ortools.sat.python import cp_model

    regles = set(inst.precede) | {m for l in inst.precede.values() for m in l}
    jours = set(inst.jours_semaine[w])
    liberees = [s for s in e.seances if s["jour"] in jours and inst.cours[s["id_cours"]].classes == [ic]
                and inst.cours[s["id_cours"]].matiere not in regles]
    incomplets = [c for c in inst.cours.values() if ic in c.classes and e.reste[c.id] > 0]
    if not incomplets:
        return 0
    for s in liberees:
        e.enlever(s)
    e.recalculer_bornes({inst.cours[s["id_cours"]].matiere for s in liberees})

    m = cp_model.CpModel()
    items = []   # (cours, durée, obligatoire, origine, [(var, di, s, salle, coût)])
    for s in liberees:
        c = inst.cours[s["id_cours"]]
        cand = _candidats(inst, e, c, s["duree"], w, None, None, (s["jour"], s["debut"], s["id_salle"]))
        items.append((c, s["duree"], True, s, cand))
    for c in incomplets:
        b = _bornes(inst, e, c, suivantes)
        if b is None:
            continue
        libere = sum(s["duree"] for s in liberees if s["id_cours"] == c.id)
        place = c.h_max - e.cours_sem[c.id, w] - libere
        # reste compte aussi les séances libérées, qui seront replacées d'office
        r = min(e.reste[c.id] - libere, max(0, place))
        while r > 0:
            d = next((x for x in c.durees if x <= r), r)
            items.append((c, d, False, None, _candidats(inst, e, c, d, w, *b)))
            r -= d
    if not any(not ob and cand for _, _, ob, _, cand in items):
        for s in liberees:   # rien à gagner : on remet tel quel
            e.poser(inst.cours[s["id_cours"]], s["jour"], s["debut"], s["duree"], s["id_salle"], s.get("cout", 0))
        return 0

    occ_atome, occ_ens, occ_salle = defaultdict(list), defaultdict(list), defaultdict(list)
    jour_atome, jour_ens = defaultdict(list), defaultdict(list)
    sem_ens, sem_cours = defaultdict(list), defaultdict(list)
    objectif = []
    vars_items = []
    for c, d, ob, origine, cand in items:
        xs = []
        for di, s, r, cout in cand:
            x = m.NewBoolVar("")
            xs.append((x, di, s, r))
            for h in range(s, s + d):
                for a in c.atomes:
                    occ_atome[a, di, h].append(x)
                occ_ens[c.enseignant, di, h].append(x)
                occ_salle[r, di, h].append(x)
            for a in c.atomes:
                jour_atome[a, di].append((x, d))
            jour_ens[c.enseignant, di].append((x, d))
            sem_ens[c.enseignant].append((x, d))
            sem_cours[c.id].append((x, d))
            objectif.append(((1000 * d if not ob else 0) - 10 * cout, x))
            if origine and (di, s, r) == (origine["jour"], origine["debut"], origine["id_salle"]):
                m.AddHint(x, 1)
        if ob:
            m.AddExactlyOne([x for x, *_ in xs])
        elif xs:
            m.AddAtMostOne([x for x, *_ in xs])
        vars_items.append((c, d, xs))
    for liste in (occ_atome, occ_ens, occ_salle):
        for v in liste.values():
            if len(v) > 1:
                m.AddAtMostOne(v)
    plaf = inst.plafond_dur
    for (a, di), v in jour_atome.items():
        m.Add(sum(d * x for x, d in v) <= plaf - e.atome_h.get((di, a), 0))
    for (k, di), v in jour_ens.items():
        m.Add(sum(d * x for x, d in v) <= plaf - len(e.ens_h.get((k, di), ())))
    for k, v in sem_ens.items():
        cap = inst.enseignants[k].get("nb_heures_max_semaine") or 99
        m.Add(sum(d * x for x, d in v) <= max(0, cap - e.ens_sem[k, w]))
    for k, v in sem_cours.items():
        m.Add(sum(d * x for x, d in v) <= max(0, inst.cours[k].h_max - e.cours_sem[k, w]))
    m.Maximize(sum(coef * x for coef, x in objectif))

    sol = cp_model.CpSolver()
    sol.parameters.max_time_in_seconds = temps
    sol.parameters.num_workers = 4
    st = sol.Solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for s in liberees:
            e.poser(inst.cours[s["id_cours"]], s["jour"], s["debut"], s["duree"], s["id_salle"], s.get("cout", 0))
        return 0
    gain = 0
    for (c, d, xs), (_, _, ob, _, _) in zip(vars_items, items):
        for x, di, s, r in xs:
            if sol.Value(x):
                e.poser(c, di, s, d, r)
                gain += 0 if ob else d
    e.recalculer_bornes({c.matiere for c, _, _ in vars_items})
    return gain


def ameliorer(inst: Instance, e: Etat, temps_max: float = 60.0, temps_sous_probleme: float = 3.0) -> dict:
    """Parcourt les promotions qui ont du non programmé, semaine par semaine."""
    t0 = chrono.perf_counter()
    suivantes = defaultdict(list)
    for b, avants in inst.precede.items():
        for a in avants:
            suivantes[a].append(b)
    gain, n_sp = 0, 0
    deficit = defaultdict(int)
    for k, r in e.reste.items():
        if r > 0:
            for ic in inst.cours[k].classes:
                deficit[ic] += r
    for ic in sorted(deficit, key=lambda i: -deficit[i]):
        # semaines les moins chargées pour cette promotion d'abord
        charge = defaultdict(int)
        for s in e.seances:
            if ic in inst.cours[s["id_cours"]].classes:
                charge[inst.semaine_de[s["jour"]]] += s["duree"]
        for w in sorted(range(inst.n_semaines), key=lambda w: charge[w]):
            if chrono.perf_counter() - t0 > temps_max:
                break
            if not any(e.reste[c.id] > 0 for c in inst.cours.values() if ic in c.classes):
                break
            gain += sous_probleme(inst, e, ic, w, temps_sous_probleme, suivantes)
            n_sp += 1
    return {"heures_gagnees": gain, "sous_problemes": n_sp, "duree_s": round(chrono.perf_counter() - t0, 2)}
