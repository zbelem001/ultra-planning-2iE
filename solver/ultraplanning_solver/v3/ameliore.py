"""Amélioration par OR-Tools CP-SAT sur de petits sous-problèmes (recherche à grand voisinage).

Sous-problème = une promotion × une semaine. Ses séances de la semaine sont libérées
(elles DOIVENT être replacées : le résultat ne peut pas régresser), on ajoute en option
des séances pour ses cours encore incomplets, et CP-SAT maximise les heures ajoutées,
le reste de l'emploi du temps étant figé. OR-Tools reste ainsi efficace : quelques
milliers de variables par sous-problème, au lieu du problème entier qui ne passe pas.

Les séances figées (verrouillées, hors périmètre ou hors période) ne sont jamais libérées ;
CD-13 (matières par semaine) est une contrainte du sous-problème.
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
        c = inst.cours[s["id_cours"]]
        e.poser(c, di, h0, h1 - h0, s["id_salle"], ens=s.get("id_enseignant", c.enseignant))
    return e


def _candidats(inst: Instance, e: Etat, c, duree: int, w: int, apres, avant, origines=frozenset()):
    """Placements (jour, début, salle, coût) compatibles avec la partie figée. origines : places
    (jour, début, salle) d'où viennent des séances libérées, toujours proposées si elles sont libres."""
    P = inst.param["poids"]
    out = []
    k = c.enseignant
    pres = inst.ens_present[k]
    for di in inst.jours_semaine[w]:
        if not pres[di] or not inst.ouvert[di]:
            continue
        jour = JOURS[inst.dates[di].weekday()]
        eh = e.ens_h.get((k, di), set()) if k is not None else set()
        sites_ens = {x for x, n in e.ens_site.get((k, di), {}).items() if n > 0} if k is not None else set()
        heures_site = e.ens_heure_site.get((k, di), {}) if k is not None else {}
        for demi, (a, b) in enumerate(inst.plages[di]):
            if (jour, demi) in inst.ens_indispo[c.enseignant] or inst.interdit(c, jour, demi, di):
                continue
            for s in range(a, b - duree + 1):
                if (apres and (di, s) < apres) or (avant and (di, s + duree) > avant):
                    continue
                hs = range(s, s + duree)
                if any(h in eh for h in hs) or any(e.occupe.get((di, h), 0) & c.masque for h in hs):
                    continue
                if any((jour, h) in inst.ens_indispo_h[c.enseignant] for h in hs) or inst.hors_regles(c, di, s, duree):
                    continue

                def site_ok(r):   # salle sur un site compatible avec la journée de l'enseignant et des promotions
                    site = inst.salles[r]["id_site"]
                    if sites_ens - {site} and inst.deux_sites_dur:
                        return False
                    if e.autre_site(c, di, site):
                        return False
                    return trajet_ok([h for h, x in heures_site.items() if x != site], s, duree, inst.trajet_h)

                libres = [r for r in c.salles if all((r, di, h) not in e.salle_occ for h in hs) and site_ok(r)]
                garde = libres[:SALLES_PAR_CRENEAU]
                garde += [r for r in libres if (di, s, r) in origines and r not in garde]
                cout = 0
                if (jour, demi) in inst.ens_pref[c.enseignant]:
                    cout -= P["preference"]
                if s == a:
                    cout -= P["debut_demi"]
                if jour == "Samedi":
                    cout += P["samedi"]
                for r in garde:
                    autres = bool(sites_ens - {inst.salles[r]["id_site"]})
                    out.append((di, s, r, cout + (P["enseignant_deux_sites"] if autres else 0)))
    return out


def _bornes(inst: Instance, e: Etat, c, suivantes):
    preds = inst.precede.get(c.matiere, [])
    if any(e.reste_matiere[m] > 0 for m in preds):
        return None
    apres = max((e.fin_matiere[m] for m in preds if m in e.fin_matiere), default=None)
    avant = min((e.debut_matiere[m] for m in suivantes.get(c.matiere, []) if m in e.debut_matiere), default=None)
    return apres, avant


def sous_probleme(inst: Instance, e: Etat, ic: int, w: int, temps: float, suivantes, cours_ok=None,
                  plafond_ajout: dict | None = None, bonus_origine: int = 0) -> int:
    """Réoptimise la promotion ic sur la semaine w. Renvoie les heures gagnées.

    Pour chaque cours, ses heures libérées et ses heures encore dues forment un total redécoupé
    librement en séances de 2 à 4 h (2 h + 2 h peuvent devenir 2 h + 3 h) : au moins les heures
    libérées (pas de régression), au plus le total. cours_ok : cours qu'on peut libérer et
    compléter ; plafond_ajout : heures qu'on peut encore ajouter par cours (replanification) ;
    bonus_origine : préférence pour garder une séance à sa place (moins de changements)."""
    from ortools.sat.python import cp_model

    regles = set(inst.precede) | {m for l in inst.precede.values() for m in l}
    jours = set(inst.jours_semaine[w])

    def modifiable(k):
        return cours_ok is None or k in cours_ok

    liberees = [s for s in e.seances if s["jour"] in jours and not s.get("fixe")
                and inst.cours[s["id_cours"]].classes == [ic]
                and inst.cours[s["id_cours"]].matiere not in regles and modifiable(s["id_cours"])]
    incomplets = [c for c in inst.cours.values() if ic in c.classes and e.reste[c.id] > 0 and modifiable(c.id)
                  and (plafond_ajout is None or plafond_ajout.get(c.id, 0) > 0)]
    if not incomplets:
        return 0
    for s in liberees:
        e.enlever(s)
    e.recalculer_bornes({inst.cours[s["id_cours"]].matiere for s in liberees})
    # CD-13 : matières qui restent cette semaine, pour chaque promotion (séances non libérées)
    fixes_mat = {x: set(e.mat_sem.get((x, w), ())) for x in inst.classes}

    def remettre():
        for s in liberees:
            e.poser(inst.cours[s["id_cours"]], s["jour"], s["debut"], s["duree"], s["id_salle"], s.get("cout", 0),
                    ens=s.get("ens"))

    # Réserves d'heures par cours : (cours, heures libérées, heures au plus, places d'origine, bornes)
    reserves: dict[int, list] = {}
    for s in liberees:
        c = inst.cours[s["id_cours"]]
        r = reserves.setdefault(c.id, [c, 0, 0, set(), (None, None)])
        r[1] += s["duree"]
        r[2] += s["duree"]
        r[3].add((s["jour"], s["debut"], s["id_salle"], s["duree"]))
    for c in incomplets:
        b = _bornes(inst, e, c, suivantes)
        if b is None:
            continue
        # cours mutualisé : sa matière doit déjà être là pour les autres promotions (CD-13)
        if inst.max_matieres and any(c.matiere not in fixes_mat[x] and len(fixes_mat[x]) >= inst.max_matieres
                                     for x in c.classes if x != ic):
            continue
        r = reserves.setdefault(c.id, [c, 0, 0, set(), b])
        r[4] = b
        libere = r[1]
        place = max(0, c.h_max - e.cours_sem[c.id, w] - libere)
        ajout = min(e.reste[c.id] - libere, place)
        if plafond_ajout is not None:
            ajout = min(ajout, plafond_ajout.get(c.id, 0))
        if ajout > 0 and e.reste[c.id] - libere - ajout == 1:   # pas d'heure isolée laissée au cours
            ajout -= 1
        r[2] = libere + max(ajout, 0)
    if not any(r[2] > r[1] for r in reserves.values()):
        remettre()   # rien à gagner : on remet tel quel
        return 0

    m = cp_model.CpModel()
    occ_atome, occ_ens, occ_salle = defaultdict(list), defaultdict(list), defaultdict(list)
    jour_atome, jour_ens = defaultdict(list), defaultdict(list)
    mat_vars = defaultdict(list)
    site_jour = defaultdict(lambda: defaultdict(list))   # (promotion, jour) -> campus -> séances candidates
    sem_ens, sem_cours = defaultdict(list), defaultdict(list)
    objectif = []
    choix = []   # (cours, durée, [(var, di, s, salle)])
    for c, libere, total, origines, (apres, avant) in reserves.values():
        heures = []
        for d in (2, 3, 4):
            if d > total:
                continue
            cand = _candidats(inst, e, c, d, w, apres, avant, {(di, s, r) for di, s, r, dd in origines if dd == d})
            if not cand:
                continue
            copies = []
            for _ in range(min(total // d, 4)):
                xs = []
                for di, s, r, cout in cand:
                    x = m.NewBoolVar("")
                    xs.append((x, di, s, r))
                    for h in range(s, s + d):
                        for a in c.atomes:
                            occ_atome[a, di, h].append(x)
                        if c.enseignant is not None:
                            occ_ens[c.enseignant, di, h].append(x)
                        occ_salle[r, di, h].append(x)
                    for a in c.atomes:
                        jour_atome[a, di].append((x, d))
                    if c.enseignant is not None:
                        jour_ens[c.enseignant, di].append((x, d))
                        sem_ens[c.enseignant].append((x, d))
                    sem_cours[c.id].append((x, d))
                    mat_vars[c.matiere].append(x)
                    for ic in c.classes:
                        site_jour[ic, di][inst.salles[r]["id_site"]].append(x)
                    heures.append((x, d))
                    gardee = bonus_origine if (di, s, r, d) in origines else 0
                    objectif.append((1000 * d - 10 * cout + gardee - (5 if d not in c.durees else 0), x))
                utilise = m.NewBoolVar("")
                m.Add(sum(x for x, *_ in xs) == utilise)   # une place au plus par séance
                copies.append(utilise)
                choix.append((c, d, xs))
            for u1, u2 in zip(copies, copies[1:]):   # copies interchangeables : dans l'ordre
                m.Add(u1 >= u2)
        for di, s, r, d in origines:   # point de départ : la situation actuelle
            x = next((x for (cc, dd, xs) in choix if cc is c and dd == d for x, a, b, rr in xs
                      if (a, b, rr) == (di, s, r)), None)
            if x is not None:
                m.AddHint(x, 1)
        if libere and not heures:
            remettre()   # séances libérées sans aucune place possible : on n'y touche pas
            return 0
        m.Add(sum(d * x for x, d in heures) >= libere)   # aucune régression
        m.Add(sum(d * x for x, d in heures) <= total)
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
    # une promotion n'a cours que sur un campus par jour (les séances restées en place sont déjà filtrées)
    for par_site in site_jour.values():
        if len(par_site) > 1:
            choisis = []
            for xs in par_site.values():
                y = m.NewBoolVar("")
                for x in xs:
                    m.AddImplication(x, y)
                choisis.append(y)
            m.Add(sum(choisis) <= 1)
    if inst.max_matieres:   # CD-13 : nouvelles matières de la promotion dans la limite
        nouvelles = []
        for mat, xs in mat_vars.items():
            if mat in fixes_mat[ic]:
                continue
            y = m.NewBoolVar("")
            for x in xs:
                m.AddImplication(x, y)
            nouvelles.append(y)
        if nouvelles:
            m.Add(sum(nouvelles) <= max(0, inst.max_matieres - len(fixes_mat[ic])))
    m.Maximize(sum(coef * x for coef, x in objectif))

    sol = cp_model.CpSolver()
    sol.parameters.max_time_in_seconds = temps
    sol.parameters.num_workers = 4
    st = sol.Solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        remettre()
        return 0
    gain = 0
    for c, d, xs in choix:
        for x, di, s, r in xs:
            if sol.Value(x):
                e.poser(c, di, s, d, r)
                gain += d
    gain -= sum(r[1] for r in reserves.values())
    if plafond_ajout is not None:
        for k, r in reserves.items():
            plafond_ajout[k] = plafond_ajout.get(k, 0) - (sum(d for c, d, xs in choix if c.id == k
                                                               for x, *_ in xs if sol.Value(x)) - r[1])
    e.recalculer_bornes({r[0].matiere for r in reserves.values()})
    return gain


def ameliorer(inst: Instance, e: Etat, temps_max: float = 60.0, temps_sous_probleme: float = 3.0,
              semaines=None, cours_ok=None, plafond_ajout: dict | None = None, bonus_origine: int = 0) -> dict:
    """Parcourt les promotions qui ont du non programmé, semaine par semaine.
    semaines / cours_ok : période et périmètre de la demande (défaut : tout) ; plafond_ajout et
    bonus_origine : voir sous_probleme (replanification)."""
    t0 = chrono.perf_counter()
    suivantes = defaultdict(list)
    for b, avants in inst.precede.items():
        for a in avants:
            suivantes[a].append(b)
    gain, n_sp = 0, 0

    def a_completer(k):
        return e.reste[k] > 0 and (cours_ok is None or k in cours_ok) and (plafond_ajout is None or plafond_ajout.get(k, 0) > 0)

    deficit = defaultdict(int)
    for k in e.reste:
        if a_completer(k):
            for ic in inst.cours[k].classes:
                deficit[ic] += e.reste[k]
    semaines = list(semaines) if semaines is not None else list(range(inst.n_semaines))
    for ic in sorted(deficit, key=lambda i: -deficit[i]):
        # semaines les moins chargées pour cette promotion d'abord
        charge = defaultdict(int)
        for s in e.seances:
            if ic in inst.cours[s["id_cours"]].classes:
                charge[inst.semaine_de[s["jour"]]] += s["duree"]
        for w in sorted(semaines, key=lambda w: charge[w]):
            if chrono.perf_counter() - t0 > temps_max:
                break
            if not any(a_completer(c.id) for c in inst.cours.values() if ic in c.classes):
                break
            gain += sous_probleme(inst, e, ic, w, temps_sous_probleme, suivantes, cours_ok, plafond_ajout, bonus_origine)
            n_sp += 1
    return {"heures_gagnees": gain, "sous_problemes": n_sp, "duree_s": round(chrono.perf_counter() - t0, 2)}
