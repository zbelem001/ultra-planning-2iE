"""Petit jeu de données synthétique et vérificateur indépendant du solveur."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, time

from ultraplanning_solver.donnees import (
    Classe, Cours, Creneau, Donnees, Enseignant, Groupe, Periode, Salle, Seance, jour_de, lundi_de, minutes,
)

LUNDI = date(2026, 10, 12)
AMPHI, STANDARD, LABO = 1, 2, 3


def grille() -> list[Creneau]:
    """Grille de 2iE : 7 h–12 h et 13 h–16 h en semaine, 7 h–12 h le samedi."""
    out, i = [], 1
    for jour in ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]:
        heures = [7, 8, 9, 10, 11] + ([] if jour == "Samedi" else [13, 14, 15])
        for h in heures:
            out.append(Creneau(i, jour, time(h), time(h + 1)))
            i += 1
    return out


def cours(id_cours, type_cours, volume, id_matiere, id_classe, id_enseignant, id_type_salle, *,
          id_groupe=None, priorite=1, hmin=2, hmax=15, durees=(2,)) -> Cours:
    return Cours(id_cours, type_cours, volume, id_matiere, id_classe, id_groupe, id_enseignant, id_type_salle,
                 priorite, hmin, hmax, durees)


def donnees(cours_liste: list[Cours], *, semaines=3, enseignants=None, seances=(), sejours=None,
            disponibilites=None, max_matieres=3) -> Donnees:
    ens = enseignants or {e: Enseignant(e, f"E{e}", "permanent", 30) for e in {c.id_enseignant for c in cours_liste}}
    return Donnees(
        id_edt=1,
        semestre_debut=LUNDI,
        semestre_fin=date.fromordinal(LUNDI.toordinal() + 7 * semaines - 2),
        classes={1: Classe(1, "A", 60, 1), 2: Classe(2, "B", 40, 2)},
        groupes={
            10: Groupe(10, "TD-A", "TD", 30, 1), 11: Groupe(11, "TD-B", "TD", 30, 1),
            20: Groupe(20, "TP-G1", "TP", 25, 1), 21: Groupe(21, "TP-G2", "TP", 25, 1),
        },
        enseignants=ens,
        salles={
            1: Salle(1, "Amphi", 120, AMPHI, 1, None, True),
            2: Salle(2, "S1", 40, STANDARD, 1, None, True),
            3: Salle(3, "S2", 40, STANDARD, 1, None, True),
            4: Salle(4, "Labo 1", 30, LABO, 1, None, True),
            5: Salle(5, "Labo 2", 30, LABO, 1, None, True),
            6: Salle(6, "S3 fermée", 80, STANDARD, 1, None, False),
        },
        creneaux=grille(),
        pauses=[(time(12), time(13))],
        jours_feries=set(),
        conges=[],
        cours={c.id_cours: c for c in cours_liste},
        disponibilites=disponibilites or {},
        absences={},
        sejours=sejours or {},
        seances=list(seances),
        poids={"CS-01": 8, "CS-02": 5, "CS-03": 5, "CS-04": 5, "CS-05": 2, "CS-06": 2, "CS-07": 5},
        max_matieres_semaine=max_matieres,
    )


def violations(d: Donnees, seances: list[Seance]) -> list[str]:
    """Recontrôle indépendant des contraintes dures sur un ensemble de séances."""
    v: list[str] = []
    grille_debuts = {(c.jour, c.heure_debut) for c in d.creneaux}
    grille_fins = {(c.jour, c.heure_fin) for c in d.creneaux}

    def chevauche(a: Seance, b: Seance) -> bool:
        return a.date_seance == b.date_seance and minutes(a.heure_debut) < minutes(b.heure_fin) and minutes(b.heure_debut) < minutes(a.heure_fin)

    for s in seances:
        c = d.cours[s.id_cours]
        salle = d.salles[s.id_salle]
        jour = jour_de(s.date_seance)
        if not 2 <= s.duree <= 4:
            v.append(f"DUREE {s}")
        if (jour, s.heure_debut) not in grille_debuts or (jour, s.heure_fin) not in grille_fins:
            v.append(f"CD-10 {s}")
        if any(minutes(s.heure_debut) < minutes(pf) and minutes(s.heure_fin) > minutes(pd) for pd, pf in d.pauses):
            v.append(f"CD-11 {s}")
        if salle.capacite < d.effectif(c):
            v.append(f"CD-04 {s}")
        if c.id_type_salle is not None and salle.id_type_salle != c.id_type_salle:
            v.append(f"CD-05 {s}")
        if not salle.est_disponible:
            v.append(f"CD-12 {s}")
        if d.jour_ferme(s.date_seance, c.id_classe):
            v.append(f"CD-09 {s}")
        if not d.enseignant_present(c.id_enseignant, s.date_seance):
            v.append(f"CD-06 présence {s}")
        for h in range(minutes(s.heure_debut), minutes(s.heure_fin), 60):
            if d.disponibilites.get((c.id_enseignant, jour, time(h // 60))) == "indisponible":
                v.append(f"CD-06 indisponible {s}")

    for i, a in enumerate(seances):
        ca = d.cours[a.id_cours]
        for b in seances[i + 1:]:
            if not chevauche(a, b):
                continue
            cb = d.cours[b.id_cours]
            if a.id_salle == b.id_salle:
                v.append(f"CD-01 {a} {b}")
            if ca.id_enseignant == cb.id_enseignant:
                v.append(f"CD-02 {a} {b}")
            if ca.id_classe == cb.id_classe:
                paralleles = (
                    ca.id_groupe is not None and cb.id_groupe is not None and ca.id_groupe != cb.id_groupe
                    and d.groupes[ca.id_groupe].type_groupe == d.groupes[cb.id_groupe].type_groupe
                )
                if not paralleles:
                    v.append(f"CD-03 {a} {b}")

    heures_cours: dict[int, int] = defaultdict(int)
    heures_semaine: dict[tuple[int, date], int] = defaultdict(int)
    matieres: dict[tuple[int, date], set[int]] = defaultdict(set)
    for s in seances:
        c = d.cours[s.id_cours]
        heures_cours[c.id_cours] += s.duree
        heures_semaine[c.id_cours, lundi_de(s.date_seance)] += s.duree
        matieres[c.id_classe, lundi_de(s.date_seance)].add(c.id_matiere)
    for k, h in heures_cours.items():
        if h > d.cours[k].volume_horaire:
            v.append(f"CD-08 cours {k} : {h} h")
    for (k, w), h in heures_semaine.items():
        if h > d.cours[k].heures_semaine_max:
            v.append(f"CD-14 cours {k} semaine {w} : {h} h")
    if d.max_matieres_semaine is not None:
        for (cl, w), ms in matieres.items():
            if len(ms) > d.max_matieres_semaine:
                v.append(f"CD-13 classe {cl} semaine {w} : {len(ms)} matières")
    return v


def sejour(debut: date, fin: date) -> list[Periode]:
    return [Periode(debut, fin)]
