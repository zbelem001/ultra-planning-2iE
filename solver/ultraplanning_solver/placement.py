"""Étage 2 : placement des séances d'une semaine.

Les heures de chaque cours (décidées à l'étage 1) sont découpées en séances
de 2 à 4 h, puis chaque séance reçoit un jour, un créneau de début et une
salle. Les contraintes dures sont appliquées soit en filtrant les placements
candidats (CD-04, CD-05, CD-06, CD-09, CD-10, CD-11, CD-12, contraintes
ajoutées), soit dans le modèle CP-SAT (CD-01, CD-02, CD-03). Les contraintes
souples CS-01, CS-02, CS-03, CS-05 et CS-06 entrent dans l'objectif.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, time

from ortools.sat.python import cp_model

from .demande import Demande, NonPlace
from .donnees import JOURS, Cours, Donnees, Seance, jour_de, minutes
from .semaines import jours_de_la_semaine

PENALITE_NON_PLACEE = 10_000  # par heure
SALLES_PAR_SEANCE = 5  # salles candidates les mieux ajustées à l'effectif


def decouper(heures: int, preferees: tuple[int, ...]) -> list[int]:
    """Découpe des heures en séances de 2 à 4 h, en suivant les durées
    préférées du cours (COURS_SEANCE_MODELE) tant que c'est possible."""
    prefs = [p for p in preferees if 2 <= p <= 4] or [2]
    out: list[int] = []
    reste, i = heures, 0
    while reste > 0:
        p = prefs[i % len(prefs)]
        i += 1
        if reste - p in (0,) or reste - p >= 2:
            out.append(p)
            reste -= p
        elif 2 <= reste <= 4:
            out.append(reste)
            reste = 0
        elif reste == 1:
            # une heure isolée : on allonge une séance existante si possible
            j = next((j for j, x in enumerate(out) if x < 4), None)
            if j is None:
                break
            out[j] += 1
            reste = 0
        else:  # reste - p == 1 : on choisit une durée qui laisse au moins 2 h
            q = reste - 2 if reste - 2 <= 4 else 3
            out.append(q)
            reste -= q
    return out


@dataclass(frozen=True)
class Placement:
    jour_date: date
    debut: int  # minutes
    fin: int
    id_salle: int
    id_creneau: int


@dataclass
class ResultatSemaine:
    seances: list[Seance]
    non_places: list[NonPlace]
    statut: str


def _heure(mn: int) -> time:
    return time(mn // 60, mn % 60)


def _slots(debut: int, fin: int) -> list[int]:
    return list(range(debut, fin, 60))


def placer_semaine(
    d: Donnees,
    demande: Demande,
    lundi: date,
    heures: dict[int, int],
    fixes: list[Seance],
    reference: list[Seance],
) -> ResultatSemaine:
    poids = d.poids
    jours = [j for j in jours_de_la_semaine(d, lundi, demande) if jour_de(j)]

    # --- occupations figées de la semaine ----------------------------------
    occ_salle: set[tuple[int, date, int]] = set()
    occ_ens: set[tuple[int, date, int]] = set()
    occ_classe: dict[tuple[int, date, int], list[Cours]] = defaultdict(list)
    for s in fixes:
        if s.date_seance not in jours:
            continue
        c = d.cours.get(s.id_cours)
        if c is None:
            continue
        for sl in _slots(minutes(s.heure_debut), minutes(s.heure_fin)):
            occ_salle.add((s.id_salle, s.date_seance, sl))
            occ_ens.add((c.id_enseignant, s.date_seance, sl))
            occ_classe[c.id_classe, s.date_seance, sl].append(c)

    def compatible_classe(c: Cours, j: date, sl: int) -> bool:
        """CD-03 avec les séances figées : seuls deux groupes différents du
        même type peuvent être en parallèle."""
        for autre in occ_classe.get((c.id_classe, j, sl), []):
            if c.id_groupe is None or autre.id_groupe is None or c.id_groupe == autre.id_groupe:
                return False
            if d.groupes[c.id_groupe].type_groupe != d.groupes[autre.id_groupe].type_groupe:
                return False
        return True

    # --- séances à placer et placements candidats ----------------------------
    seances: list[tuple[Cours, int]] = []
    for k, hk in sorted(heures.items()):
        c = d.cours[k]
        for duree in decouper(hk, c.durees_preferees):
            seances.append((c, duree))

    candidats: list[list[Placement]] = []
    raisons: list[str] = []
    for c, duree in seances:
        effectif = d.effectif(c)
        salles = sorted(
            (
                s for s in d.salles.values()
                if s.est_disponible and s.capacite >= effectif and (c.id_type_salle is None or s.id_type_salle == c.id_type_salle)
            ),
            key=lambda s: s.capacite,
        )
        liste: list[Placement] = []
        motif = "CD-04/CD-05 : aucune salle du bon type et assez grande" if not salles else ""
        for j in jours:
            jour = jour_de(j)
            if d.jour_ferme(j, c.id_classe):
                motif = motif or "CD-09 : jours fériés ou congés"
                continue
            if not d.enseignant_present(c.id_enseignant, j):
                motif = motif or "CD-06 : enseignant absent ou hors de ses séjours"
                continue
            for cr in d.debuts_possibles(jour, duree):
                debut = minutes(cr.heure_debut)
                fin = debut + duree * 60
                sls = _slots(debut, fin)
                if any(
                    d.disponibilites.get((c.id_enseignant, jour, _heure(sl))) == "indisponible" for sl in sls
                ):
                    motif = motif or "CD-06 : enseignant indisponible"
                    continue
                if not all(k.autorise(c, j, jour, debut, fin) for k in demande.contraintes):
                    motif = motif or "Contrainte ajoutée : aucun créneau dans la fenêtre demandée"
                    continue
                if any((c.id_enseignant, j, sl) in occ_ens for sl in sls) or not all(compatible_classe(c, j, sl) for sl in sls):
                    motif = motif or "CD-02/CD-03 : enseignant ou classe déjà pris"
                    continue
                libres = [s for s in salles if not any((s.id_salle, j, sl) in occ_salle for sl in sls)]
                for s in libres[:SALLES_PAR_SEANCE]:
                    liste.append(Placement(j, debut, fin, s.id_salle, cr.id_creneau))
        candidats.append(liste)
        # Le motif d'un filtre n'explique un échec que si aucun placement n'a survécu
        raisons.append(
            "CD-01/CD-02/CD-03 : plus de créneau libre compatible cette semaine (salle, enseignant ou classe déjà pris)"
            if liste else motif or "Aucun créneau possible cette semaine"
        )

    # --- modèle -------------------------------------------------------------
    m = cp_model.CpModel()
    x: list[list[cp_model.IntVar]] = []
    non_place: list[cp_model.IntVar] = []
    obj = []
    par_salle: dict[tuple[int, date, int], list] = defaultdict(list)
    par_ens: dict[tuple[int, date, int], list] = defaultdict(list)
    entier: dict[tuple[int, date, int], list] = defaultdict(list)  # séances de classe entière
    par_groupe: dict[tuple[int, date, int, int], list] = defaultdict(list)
    ref = {(s.id_cours, s.date_seance, minutes(s.heure_debut), s.id_salle) for s in reference}
    ref_jour = {(s.id_cours, s.date_seance, minutes(s.heure_debut)) for s in reference}
    w1, w2, w3, w5, w6 = (poids.get(f"CS-0{i}", 0) for i in (1, 2, 3, 5, 6))

    jour_seance: list[cp_model.LinearExpr] = []
    heures_ens_jour: dict[tuple[int, date], list] = defaultdict(list)
    classe_jour: dict[tuple[int, date], list] = defaultdict(list)
    classe_site_jour: dict[tuple[int, date, int], list] = defaultdict(list)

    for i, ((c, duree), cands) in enumerate(zip(seances, candidats)):
        u = m.new_bool_var(f"u_{i}")
        xs = [m.new_bool_var(f"x_{i}_{p}") for p in range(len(cands))]
        m.add(sum(xs) + u == 1)
        obj.append(PENALITE_NON_PLACEE * duree * u)
        x.append(xs)
        non_place.append(u)
        jour_seance.append(sum(JOURS.index(jour_de(p.jour_date)) * v for p, v in zip(cands, xs)))
        jour = None
        for p, v in zip(cands, xs):
            jour = jour_de(p.jour_date)
            for sl in _slots(p.debut, p.fin):
                par_salle[p.id_salle, p.jour_date, sl].append(v)
                par_ens[c.id_enseignant, p.jour_date, sl].append(v)
                if c.id_groupe is None:
                    entier[c.id_classe, p.jour_date, sl].append(v)
                else:
                    par_groupe[c.id_classe, p.jour_date, sl, c.id_groupe].append(v)
            heures_ens_jour[c.id_enseignant, p.jour_date].append(duree * v)
            classe_jour[c.id_classe, p.jour_date].append(v)
            classe_site_jour[c.id_classe, p.jour_date, d.salles[p.id_salle].id_site].append(v)
            cout = (p.debut - 7 * 60) // 60  # légère préférence pour le matin
            # CS-01 : créneaux préférés de l'enseignant
            if w1:
                pref = sum(1 for sl in _slots(p.debut, p.fin) if d.disponibilites.get((c.id_enseignant, jour, _heure(sl))) == "preference")
                cout -= 3 * w1 * pref
            # Salle ajustée à l'effectif
            cout += (d.salles[p.id_salle].capacite - d.effectif(c)) // 50
            # Replanification : garder la séance à l'identique
            if demande.minimiser_changements:
                if (c.id_cours, p.jour_date, p.debut, p.id_salle) in ref:
                    cout -= 200
                elif (c.id_cours, p.jour_date, p.debut) in ref_jour:
                    cout -= 120
            if cout:
                obj.append(cout * v)

    # Séances identiques d'un même cours : on fixe leur ordre (brise les symétries)
    position = [
        sum(((JOURS.index(jour_de(p.jour_date)) * 24 * 60 + p.debut) * v for p, v in zip(cands, xs)))
        for cands, xs in zip(candidats, x)
    ]
    for i in range(1, len(seances)):
        if seances[i] == seances[i - 1]:
            m.add(position[i - 1] < position[i]).only_enforce_if(~non_place[i - 1], ~non_place[i])
            m.add_implication(non_place[i - 1], non_place[i])

    # CD-01 et CD-02 : une salle, un enseignant, une séance à la fois
    for vs in list(par_salle.values()) + list(par_ens.values()):
        if len(vs) > 1:
            m.add(sum(vs) <= 1)
    # CD-03 : classe entière exclusive ; groupes du même type en parallèle
    cles_classe = {(cl, j, sl) for (cl, j, sl) in entier} | {(cl, j, sl) for (cl, j, sl, _) in par_groupe}
    for cl, j, sl in cles_classe:
        termes = list(entier.get((cl, j, sl), []))
        for t in ("TD", "TP"):
            gs = [g for (cl2, j2, sl2, g) in par_groupe if (cl2, j2, sl2) == (cl, j, sl) and d.groupes[g].type_groupe == t]
            if not gs:
                continue
            b = m.new_bool_var(f"b_{cl}_{j}_{sl}_{t}")
            for g in gs:
                m.add(sum(par_groupe[cl, j, sl, g]) <= b)
            termes.append(b)
        if len(termes) > 1:
            m.add(sum(termes) <= 1)

    # CS-02 (approché) : regrouper les séances d'une classe sur moins de jours
    if w2:
        for vs in classe_jour.values():
            used = m.new_bool_var("jour_utilise")
            for v in vs:
                m.add_implication(v, used)
            obj.append(2 * w2 * used)
    # CS-03 : éviter plusieurs sites dans la même journée d'une classe
    if w3:
        for vs in classe_site_jour.values():
            used = m.new_bool_var("site_utilise")
            for v in vs:
                m.add_implication(v, used)
            obj.append(3 * w3 * used)
    # CS-05 : le CM d'une matière avant ses TD et TP dans la semaine
    if w5:
        for i, (ci, _) in enumerate(seances):
            if ci.type_cours != "CM":
                continue
            for j2, (cj, _) in enumerate(seances):
                if cj.type_cours != "CM" and cj.id_classe == ci.id_classe and cj.id_matiere == ci.id_matiere:
                    retard = m.new_int_var(0, 6, f"retard_{i}_{j2}")
                    m.add(retard >= jour_seance[i] - jour_seance[j2])
                    obj.append(w5 * retard)
    # CS-06 : plafond d'heures par jour d'un enseignant
    if w6:
        for hs in heures_ens_jour.values():
            exces = m.new_int_var(0, 12, "exces")
            m.add(exces >= sum(hs) - d.plafond_heures_jour)
            obj.append(3 * w6 * exces)

    m.minimize(sum(obj))
    solveur = cp_model.CpSolver()
    solveur.parameters.max_time_in_seconds = demande.temps_max_placement
    solveur.parameters.relative_gap_limit = 0.01
    solveur.parameters.num_workers = 8
    statut = solveur.solve(m)
    nom = solveur.status_name(statut)

    resultat: list[Seance] = []
    non_places: list[NonPlace] = []
    ok = statut in (cp_model.OPTIMAL, cp_model.FEASIBLE)
    for i, ((c, duree), cands) in enumerate(zip(seances, candidats)):
        choisi = None
        if ok:
            choisi = next((p for p, v in zip(cands, x[i]) if solveur.value(v)), None)
        if choisi is None:
            non_places.append(NonPlace(c.id_cours, duree, raisons[i].split(" : ")[0], raisons[i], lundi))
            continue
        resultat.append(Seance(c.id_cours, choisi.jour_date, _heure(choisi.debut), _heure(choisi.fin), choisi.id_salle))
    return ResultatSemaine(resultat, non_places, nom)
