"""Point d'entrée du solveur : générer ou replanifier un périmètre.

Déroulé :
1. les séances existantes sont réparties entre « figées » (hors périmètre,
   hors période, verrouillées) et « à remplacer » ;
2. l'étage 1 répartit les heures restantes de chaque cours sur les semaines ;
3. l'étage 2 place chaque semaine ;
4. si une semaine n'a pas pu placer toutes ses heures, on plafonne ce cours
   cette semaine-là et on relance l'étage 1, qui reporte le manque ailleurs.

Sur une courte période (une ou deux semaines), l'étage 1 planifie jusqu'à la
fin du semestre (Demande.horizon) pour garder le rythme de chaque cours ; seules
les semaines de la période sont placées, le reste est reporté.
"""

from __future__ import annotations

import time as chrono
from collections import defaultdict
from dataclasses import replace
from datetime import date, timedelta

from .demande import Demande, NonPlace, Resultat
from .donnees import Donnees, Seance, lundi_de
from .placement import placer_semaine
from .semaines import planifier_semaines


def semaines_de(d: Donnees, demande: Demande) -> list[date]:
    du = max(demande.du or d.semestre_debut, d.semestre_debut)
    au = min(demande.au or d.semestre_fin, d.semestre_fin)
    out, w = [], lundi_de(du)
    while w <= au:
        out.append(w)
        w += timedelta(days=7)
    return out


def generer(d: Donnees, demande: Demande | None = None) -> Resultat:
    """Programme le périmètre de la demande sur sa période (BF-15, BF-30) ;
    avec `minimiser_changements`, c'est une replanification minimale."""
    demande = demande or Demande()
    debut_calcul = chrono.perf_counter()
    du = max(demande.du or d.semestre_debut, d.semestre_debut)
    au = min(demande.au or d.semestre_fin, d.semestre_fin)
    semaines = semaines_de(d, demande)
    # Étage 1 : jusqu'à l'horizon (génération) ; étage 2 : la période seulement
    demande_plan, semaines_plan = demande, semaines
    if not demande.minimiser_changements:
        horizon = min(demande.horizon or d.semestre_fin, d.semestre_fin)
        if horizon > au:
            demande_plan = replace(demande, au=horizon)
            semaines_plan = semaines_de(d, demande_plan)

    cours = [c for c in d.cours.values() if demande.perimetre.contient(d, c)]
    ids = {c.id_cours for c in cours}

    def a_remplacer(s: Seance) -> bool:
        if demande.completer:
            return False
        return s.id_cours in ids and du <= s.date_seance <= au and not (demande.garder_verrouillees and s.est_verrouillee)

    remplacees = [s for s in d.seances if a_remplacer(s)]
    fixes = [s for s in d.seances if not a_remplacer(s)]

    deja: dict[int, int] = defaultdict(int)
    for s in fixes:
        deja[s.id_cours] += s.duree
    reference: dict[tuple[int, date], int] = defaultdict(int)
    dans_la_fenetre: dict[int, int] = defaultdict(int)
    for s in remplacees:
        reference[s.id_cours, lundi_de(s.date_seance)] += s.duree
        dans_la_fenetre[s.id_cours] += s.duree
    restant = {c.id_cours: max(c.volume_horaire - deja[c.id_cours], 0) for c in cours}
    # Génération : compléter le programme. Replanification : déplacer les heures
    # déjà prévues dans la fenêtre, sans chercher à y ajouter le reste du volume.
    besoins = (
        {k: min(restant[k], dans_la_fenetre[k]) for k in restant}
        if demande.minimiser_changements else restant
    )
    ref_par_semaine: dict[date, list[Seance]] = defaultdict(list)
    for s in remplacees:
        ref_par_semaine[lundi_de(s.date_seance)].append(s)

    plafonds: dict[tuple[int, date], int] = {}
    places: dict[date, tuple[dict[int, int], list[Seance], list[NonPlace]]] = {}
    plan = None
    iterations = 0
    for iterations in range(1, demande.iterations_max + 1):
        plan = planifier_semaines(d, demande_plan, cours, semaines_plan, fixes, besoins, plafonds, reference)
        manques_semaine = False
        for w in semaines:
            demande_w = {k: hv for (k, w2), hv in plan.heures.items() if w2 == w}
            if w in places and places[w][0] == demande_w:
                continue  # semaine inchangée : on garde son placement
            # séances figées : celles d'origine + celles déjà placées par le solveur les autres semaines
            res = placer_semaine(d, demande, w, demande_w, fixes, ref_par_semaine.get(w, []))
            places[w] = (demande_w, res.seances, res.non_places)
            obtenu: dict[int, int] = defaultdict(int)
            for s in res.seances:
                obtenu[s.id_cours] += s.duree
            for k, hv in demande_w.items():
                if obtenu[k] < hv:
                    plafonds[k, w] = obtenu[k]
                    manques_semaine = True
        if not manques_semaine:
            break

    seances = [s for _, ss, _ in places.values() for s in ss]
    placees: dict[int, int] = defaultdict(int)
    for s in seances:
        placees[s.id_cours] += s.duree

    # Heures que le plan met après la période : reportées (génération courte)
    dans_periode = set(semaines)
    prevues: dict[int, int] = defaultdict(int)
    for (k, w), hv in (plan.heures.items() if plan else []):
        if w not in dans_periode:
            prevues[k] += hv
    reportees = {k: min(hv, besoins[k] - placees[k]) for k, hv in prevues.items() if besoins[k] - placees[k] > 0}

    non_places: list[NonPlace] = []
    for c in cours:
        manque = besoins[c.id_cours] - placees[c.id_cours] - reportees.get(c.id_cours, 0)
        if manque <= 0:
            continue
        # raison : la plus fréquente remontée par l'étage 2, sinon capacité de la période
        raisons = [n for _, _, ns in places.values() for n in ns if n.id_cours == c.id_cours]
        if raisons:
            n = max(raisons, key=lambda r: sum(1 for x in raisons if x.raison == r.raison))
            non_places.append(NonPlace(c.id_cours, manque, n.code, n.raison))
        else:
            non_places.append(NonPlace(
                c.id_cours, manque, "CAPACITE",
                "Pas assez de semaines disponibles sur la période (disponibilités ou séjours de l'enseignant, "
                "rythme maximal, CD-13 ou charge de la classe).",
            ))

    return Resultat(
        seances=sorted(seances, key=lambda s: (s.date_seance, s.heure_debut, s.id_cours)),
        conservees=fixes,
        remplacees=remplacees,
        non_places=non_places,
        statistiques={
            "duree_s": round(chrono.perf_counter() - debut_calcul, 2),
            "iterations": iterations,
            "statut_etage1": plan.statut if plan else None,
            "cours": len(cours),
            "semaines": len(semaines),
            "heures_demandees": sum(besoins.values()) - sum(reportees.values()),
            "heures_placees": sum(placees.values()),
            "heures_reportees": sum(reportees.values()),
        },
        reportees=reportees,
    )
