"""Données d'entrée du solveur, indépendantes de la base.

Les classes reprennent les tables de schema_supabase.sql (mêmes noms de
colonnes). `base.py` les remplit depuis PostgreSQL ; les tests les
construisent directement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time, timedelta

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]


def jour_de(d: date) -> str | None:
    """Jour de la semaine au sens de CRENEAU.jour (None le dimanche)."""
    i = d.weekday()
    return JOURS[i] if i < 6 else None


def lundi_de(d: date) -> date:
    return d - timedelta(days=d.weekday())


def minutes(t: time) -> int:
    return t.hour * 60 + t.minute


@dataclass(frozen=True)
class Classe:
    id_classe: int
    code_classe: str
    effectif: int
    id_filiere: int


@dataclass(frozen=True)
class Groupe:
    id_groupe: int
    code_groupe: str
    type_groupe: str  # 'TD' ou 'TP'
    effectif: int
    id_classe: int


@dataclass(frozen=True)
class Enseignant:
    id_enseignant: int
    nom: str
    statut: str  # 'permanent', 'vacataire_local', 'externe'
    nb_heures_max_semaine: int | None


@dataclass(frozen=True)
class Salle:
    id_salle: int
    nom_salle: str
    capacite: int
    id_type_salle: int
    id_site: int
    batiment: str | None
    est_disponible: bool


@dataclass(frozen=True)
class Creneau:
    id_creneau: int
    jour: str
    heure_debut: time
    heure_fin: time


@dataclass(frozen=True)
class Periode:
    """Plage de dates incluses (absence, séjour, congé)."""

    date_debut: date
    date_fin: date

    def contient(self, d: date) -> bool:
        return self.date_debut <= d <= self.date_fin


@dataclass(frozen=True)
class Conge(Periode):
    id_classe: int | None = None  # None = tout l'établissement


@dataclass(frozen=True)
class Cours:
    id_cours: int
    type_cours: str  # 'CM', 'TD', 'TP'
    volume_horaire: int
    id_matiere: int
    id_classe: int
    id_groupe: int | None
    id_enseignant: int
    id_type_salle: int | None
    priorite: int
    heures_semaine_min: int
    heures_semaine_max: int
    durees_preferees: tuple[int, ...]  # COURS_SEANCE_MODELE, sinon (duree_seance,)


@dataclass(frozen=True)
class Seance:
    """Séance datée (existante ou produite par le solveur)."""

    id_cours: int
    date_seance: date
    heure_debut: time
    heure_fin: time
    id_salle: int
    id_seance: int | None = None
    est_verrouillee: bool = False

    @property
    def duree(self) -> int:
        return (minutes(self.heure_fin) - minutes(self.heure_debut)) // 60


@dataclass
class Donnees:
    """Image du référentiel et de l'emploi du temps pour un semestre."""

    id_edt: int
    semestre_debut: date
    semestre_fin: date
    classes: dict[int, Classe]
    groupes: dict[int, Groupe]
    enseignants: dict[int, Enseignant]
    salles: dict[int, Salle]
    creneaux: list[Creneau]
    pauses: list[tuple[time, time]]
    jours_feries: set[date]
    conges: list[Conge]
    cours: dict[int, Cours]
    # (id_enseignant, jour, heure_debut) -> 'preference' | 'indisponible'
    disponibilites: dict[tuple[int, str, time], str]
    absences: dict[int, list[Periode]]
    sejours: dict[int, list[Periode]]
    seances: list[Seance]  # séances non annulées de l'emploi du temps
    poids: dict[str, int] = field(default_factory=dict)  # CS-xx actives -> poids
    max_matieres_semaine: int | None = 3  # CD-13 (None = désactivée)
    plafond_heures_jour: int = 6  # CS-06
    id_ecole: int | None = None  # école de l'emploi du temps (base partagée entre écoles)

    # --- dérivés -----------------------------------------------------------

    def effectif(self, c: Cours) -> int:
        if c.id_groupe is not None:
            return self.groupes[c.id_groupe].effectif
        return self.classes[c.id_classe].effectif

    def creneaux_du_jour(self, jour: str) -> list[Creneau]:
        return sorted((c for c in self.creneaux if c.jour == jour), key=lambda c: c.heure_debut)

    def jour_ferme(self, d: date, id_classe: int | None) -> bool:
        """Jour férié ou congé (de l'établissement ou de la classe)."""
        if d in self.jours_feries or d < self.semestre_debut or d > self.semestre_fin:
            return True
        return any(g.contient(d) and (g.id_classe is None or g.id_classe == id_classe) for g in self.conges)

    def enseignant_present(self, id_enseignant: int, d: date) -> bool:
        """Pas d'absence datée, et dans un séjour s'il est externe (CD-06)."""
        if any(a.contient(d) for a in self.absences.get(id_enseignant, [])):
            return False
        if self.enseignants[id_enseignant].statut == "externe":
            return any(s.contient(d) for s in self.sejours.get(id_enseignant, []))
        return True

    def debuts_possibles(self, jour: str, duree: int) -> list[Creneau]:
        """Créneaux de début d'une séance de `duree` heures : créneaux contigus,
        fin alignée sur la grille (CD-10), sans chevaucher une pause (CD-11)."""
        crs = self.creneaux_du_jour(jour)
        out = []
        for i, c in enumerate(crs):
            fin = minutes(c.heure_debut) + duree * 60
            j, t = i, minutes(c.heure_debut)
            while j < len(crs) and minutes(crs[j].heure_debut) == t and t < fin:
                t = minutes(crs[j].heure_fin)
                j += 1
            if t != fin:
                continue
            d0 = minutes(c.heure_debut)
            if any(d0 < minutes(pf) and fin > minutes(pd) for pd, pf in self.pauses):
                continue
            out.append(c)
        return out
