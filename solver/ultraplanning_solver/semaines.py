"""Étage 1 : plan des semaines (enseignement par modules).

Pour chaque cours du périmètre et chaque semaine, décide combien d'heures
placer, sans encore choisir les créneaux :

- volume : la somme des heures atteint le besoin du cours (CD-08) ; un
  manque éventuel est autorisé mais très pénalisé, puis signalé (BF-18) ;
- rythme : 0 ou entre heures_semaine_min et heures_semaine_max (CD-14),
  une seule semaine « de fin » pouvant descendre sous le minimum ;
- CD-13 : au plus N matières différentes par classe et par semaine ;
- capacités agrégées : heures disponibles de l'enseignant (disponibilités,
  absences, séjours, plafond hebdomadaire), de la classe (jours ouverts,
  groupes parallèles), des salles par type ;
- objectif : CS-04 (ramasser les cours des externes, enchaîner ceux des
  permanents), CS-07 (commencer tôt les cours prioritaires) et, en
  replanification, rester proche du plan actuel.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from ortools.sat.python import cp_model

from .demande import Demande
from .donnees import Cours, Donnees, Seance, jour_de, lundi_de, minutes

PENALITE_MANQUE = 10_000  # par heure non programmée


@dataclass
class PlanSemaines:
    heures: dict[tuple[int, date], int]  # (id_cours, lundi) -> heures
    manque: dict[int, int]  # id_cours -> heures impossibles à programmer
    statut: str
    objectif: float


def jours_de_la_semaine(d: Donnees, lundi: date, demande: Demande) -> list[date]:
    du = demande.du or d.semestre_debut
    au = demande.au or d.semestre_fin
    return [lundi + timedelta(days=i) for i in range(6) if du <= lundi + timedelta(days=i) <= au]


def heures_ouvertes_cours(d: Donnees, c: Cours, lundi: date, demande: Demande) -> int:
    """Heures de la semaine où le cours peut avoir lieu : classe ouverte,
    enseignant présent et disponible, contraintes ajoutées respectées."""
    total = 0
    for jour_date in jours_de_la_semaine(d, lundi, demande):
        jour = jour_de(jour_date)
        if jour is None or d.jour_ferme(jour_date, c.id_classe) or not d.enseignant_present(c.id_enseignant, jour_date):
            continue
        for cr in d.creneaux_du_jour(jour):
            if d.disponibilites.get((c.id_enseignant, jour, cr.heure_debut)) == "indisponible":
                continue
            debut, fin = minutes(cr.heure_debut), minutes(cr.heure_fin)
            if all(k.autorise(c, jour_date, jour, debut, fin) for k in demande.contraintes):
                total += (fin - debut) // 60
    return total


def heures_ouvertes_enseignant(d: Donnees, id_enseignant: int, lundi: date, demande: Demande) -> int:
    """Heures de la semaine où l'enseignant est présent et disponible."""
    total = 0
    for jour_date in jours_de_la_semaine(d, lundi, demande):
        jour = jour_de(jour_date)
        if jour is None or d.jour_ferme(jour_date, None) or not d.enseignant_present(id_enseignant, jour_date):
            continue
        total += sum(
            1 for cr in d.creneaux_du_jour(jour)
            if d.disponibilites.get((id_enseignant, jour, cr.heure_debut)) != "indisponible"
        )
    return total


def planifier_semaines(
    d: Donnees,
    demande: Demande,
    cours: list[Cours],
    semaines: list[date],
    fixes: list[Seance],
    besoins: dict[int, int],
    plafonds: dict[tuple[int, date], int],
    reference: dict[tuple[int, date], int],
) -> PlanSemaines:
    m = cp_model.CpModel()
    poids = d.poids
    w_index = {w: i for i, w in enumerate(semaines)}

    # --- occupations figées par semaine -----------------------------------
    # Les capacités ne comptent que les jours de la période ; les séances
    # figées des autres jours de la semaine n'y prennent donc pas de place.
    # Le plafond hebdomadaire de l'enseignant (fixe_ens_semaine) et CD-13
    # portent en revanche sur toute la semaine.
    du = demande.du or d.semestre_debut
    au = demande.au or d.semestre_fin
    fixe_ens: dict[tuple[int, date], int] = defaultdict(int)
    fixe_ens_semaine: dict[tuple[int, date], int] = defaultdict(int)
    fixe_classe: dict[tuple[int, date], int] = defaultdict(int)
    fixe_type: dict[tuple[int, date], int] = defaultdict(int)
    fixe_matieres: dict[tuple[int, date], set[int]] = defaultdict(set)
    for s in fixes:
        c = d.cours.get(s.id_cours)
        if c is None:
            continue
        w = lundi_de(s.date_seance)
        fixe_ens_semaine[c.id_enseignant, w] += s.duree
        fixe_matieres[c.id_classe, w].add(c.id_matiere)
        if du <= s.date_seance <= au:
            fixe_ens[c.id_enseignant, w] += s.duree
            fixe_classe[c.id_classe, w] += s.duree
            fixe_type[d.salles[s.id_salle].id_type_salle, w] += s.duree

    h: dict[tuple[int, date], cp_model.IntVar] = {}
    a: dict[tuple[int, date], cp_model.IntVar] = {}
    obj = []
    manque = {}

    for c in cours:
        k = c.id_cours
        besoin = besoins.get(k, 0)
        if besoin <= 0:
            continue
        queue = []
        for w in semaines:
            ub = min(c.heures_semaine_max, heures_ouvertes_cours(d, c, w, demande), plafonds.get((k, w), 10**6))
            hv = m.new_int_var(0, max(ub, 0), f"h_{k}_{w}")
            av = m.new_bool_var(f"a_{k}_{w}")
            fin = m.new_bool_var(f"fin_{k}_{w}")  # semaine de fin, sous le minimum
            m.add(hv >= 2).only_enforce_if(av)
            m.add(hv == 0).only_enforce_if(~av)
            hmin = min(c.heures_semaine_min, besoin)
            m.add(hv >= hmin).only_enforce_if(av, ~fin)
            m.add_implication(fin, av)
            queue.append(fin)
            h[k, w], a[k, w] = hv, av
        m.add(sum(queue) <= 1)
        mq = m.new_int_var(0, besoin, f"manque_{k}")
        m.add(sum(h[k, w] for w in semaines) + mq == besoin)
        manque[k] = mq
        obj.append(PENALITE_MANQUE * mq)

        actives = [a[k, w] for w in semaines]
        # CS-07 : commencer tôt, d'autant plus que le cours est prioritaire
        w7 = poids.get("CS-07", 0)
        if w7:
            obj.append(sum(w7 * (1 + max(c.priorite, 0)) * w_index[w] * a[k, w] for w in semaines))
        # CS-04 : selon le statut de l'enseignant
        w4 = poids.get("CS-04", 0)
        if w4:
            statut = d.enseignants[c.id_enseignant].statut
            if statut == "externe":
                obj.append(3 * w4 * sum(actives))  # le moins de semaines possible
            debuts = []
            for i, w in enumerate(semaines):
                st = m.new_bool_var(f"debut_{k}_{w}")
                prec = a[k, semaines[i - 1]] if i else 0
                m.add(st >= a[k, w] - prec)
                debuts.append(st)
            facteur = {"permanent": 4, "externe": 4, "vacataire_local": 1}.get(statut, 2)
            obj.append(facteur * w4 * sum(debuts))  # interruptions
        # Replanification : rester proche du plan actuel
        if demande.minimiser_changements:
            for w in semaines:
                # |h - référence| par deux inégalités (l'écart est minimisé) ;
                # add_abs_equality d'OR-Tools 9.12 rejette une expression de signe fixe
                ref = reference.get((k, w), 0)
                ecart = m.new_int_var(0, 200, f"ecart_{k}_{w}")
                m.add(ecart >= h[k, w] - ref)
                m.add(ecart >= ref - h[k, w])
                obj.append(50 * ecart)

    cours_actifs = [c for c in cours if (c.id_cours, semaines[0]) in h] if semaines else []

    # CS-05 : un TD ou un TP ne commence pas avant le CM de sa matière
    w5 = poids.get("CS-05", 0)
    if w5:
        for cm in cours_actifs:
            if cm.type_cours != "CM":
                continue
            commence = {}
            for i, w in enumerate(semaines):
                v = m.new_bool_var(f"cm_commence_{cm.id_cours}_{w}")
                m.add_implication(a[cm.id_cours, w], v)
                if i:
                    m.add_implication(commence[semaines[i - 1]], v)
                    m.add_bool_or([a[cm.id_cours, w], commence[semaines[i - 1]]]).only_enforce_if(v)
                else:
                    m.add_implication(v, a[cm.id_cours, w])
                commence[w] = v
            for td in cours_actifs:
                if td.type_cours != "CM" and td.id_classe == cm.id_classe and td.id_matiere == cm.id_matiere:
                    for w in semaines:
                        avant = m.new_bool_var(f"avant_cm_{td.id_cours}_{w}")
                        m.add(avant >= a[td.id_cours, w] - commence[w])
                        obj.append(20 * w5 * avant)

    for w in semaines:
        # Enseignant : plafond hebdomadaire et heures disponibles
        par_ens: dict[int, list] = defaultdict(list)
        for c in cours_actifs:
            par_ens[c.id_enseignant].append(h[c.id_cours, w])
        for e, hs in par_ens.items():
            plafond = d.enseignants[e].nb_heures_max_semaine
            libre = int(demande.marge_enseignant * max(heures_ouvertes_enseignant(d, e, w, demande) - fixe_ens[e, w], 0))
            if plafond is not None:
                libre = min(libre, max(plafond - fixe_ens_semaine[e, w], 0))
            m.add(sum(hs) <= libre)

        # Classe : groupes du même type en parallèle, CM et types différents en série
        par_classe: dict[int, list[Cours]] = defaultdict(list)
        for c in cours_actifs:
            par_classe[c.id_classe].append(c)
        for cl, liste in par_classe.items():
            ouvertes = sum(
                len(d.creneaux_du_jour(jour_de(j) or ""))
                for j in jours_de_la_semaine(d, w, demande)
                if jour_de(j) and not d.jour_ferme(j, cl)
            )
            charge = [h[c.id_cours, w] for c in liste if c.id_groupe is None]
            for t in ("TD", "TP"):
                par_groupe: dict[int, list] = defaultdict(list)
                for c in liste:
                    if c.id_groupe is not None and d.groupes[c.id_groupe].type_groupe == t:
                        par_groupe[c.id_groupe].append(h[c.id_cours, w])
                if par_groupe:
                    y = m.new_int_var(0, 200, f"y_{cl}_{t}_{w}")
                    for hs in par_groupe.values():
                        m.add(y >= sum(hs))
                    # des groupes qui partagent un enseignant ne sont pas en parallèle
                    par_ens_type: dict[int, list] = defaultdict(list)
                    for c in liste:
                        if c.id_groupe is not None and d.groupes[c.id_groupe].type_groupe == t:
                            par_ens_type[c.id_enseignant].append(h[c.id_cours, w])
                    for hs in par_ens_type.values():
                        if len(hs) > 1:
                            m.add(y >= sum(hs))
                    charge.append(y)
            m.add(sum(charge) <= max(int(demande.marge_classe * ouvertes) - fixe_classe[cl, w], 0))

            # CD-13 : matières différentes dans la semaine
            if d.max_matieres_semaine is not None:
                deja = fixe_matieres[cl, w]
                nouvelles: dict[int, list] = defaultdict(list)
                for c in liste:
                    if c.id_matiere not in deja:
                        nouvelles[c.id_matiere].append(a[c.id_cours, w])
                mats = []
                for mat, acts in nouvelles.items():
                    mv = m.new_bool_var(f"mat_{cl}_{mat}_{w}")
                    for av in acts:
                        m.add_implication(av, mv)
                    mats.append(mv)
                m.add(sum(mats) <= max(d.max_matieres_semaine - len(deja), 0))

        # Salles : heures disponibles par type (marge pour la fragmentation)
        par_type: dict[int, list] = defaultdict(list)
        for c in cours_actifs:
            if c.id_type_salle is not None:
                par_type[c.id_type_salle].append(h[c.id_cours, w])
        jours_ouverts = [j for j in jours_de_la_semaine(d, w, demande) if jour_de(j) and not d.jour_ferme(j, None)]
        for t, hs in par_type.items():
            nb_salles = sum(1 for s in d.salles.values() if s.id_type_salle == t and s.est_disponible)
            grille = sum(len(d.creneaux_du_jour(jour_de(j) or "")) for j in jours_ouverts)
            m.add(sum(hs) <= max(int(0.9 * nb_salles * grille) - fixe_type[t, w], 0))

    if obj:
        m.minimize(sum(obj))
    solveur = cp_model.CpSolver()
    solveur.parameters.max_time_in_seconds = demande.temps_max_semaines
    solveur.parameters.relative_gap_limit = 0.01
    solveur.parameters.num_workers = 8
    statut = solveur.solve(m)
    nom = solveur.status_name(statut)
    if statut not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return PlanSemaines({}, {k: besoins[k] for k in manque}, nom, 0)
    heures = {kw: solveur.value(v) for kw, v in h.items() if solveur.value(v) > 0}
    return PlanSemaines(heures, {k: solveur.value(v) for k, v in manque.items() if solveur.value(v)}, nom, solveur.objective_value)
