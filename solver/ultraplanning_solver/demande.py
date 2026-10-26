"""Ce qu'on demande au solveur (périmètre, période, contraintes ajoutées) et
ce qu'il renvoie."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time
from typing import Literal

from .donnees import Cours, Donnees, Seance, minutes


@dataclass(frozen=True)
class Perimetre:
    """Cours à (re)programmer. Vide = tout l'établissement (BF-30)."""

    id_filieres: frozenset[int] = frozenset()
    id_classes: frozenset[int] = frozenset()
    id_cours: frozenset[int] = frozenset()

    def contient(self, d: Donnees, c: Cours) -> bool:
        if not (self.id_filieres or self.id_classes or self.id_cours):
            return True
        return (
            c.id_cours in self.id_cours
            or c.id_classe in self.id_classes
            or d.classes[c.id_classe].id_filiere in self.id_filieres
        )


@dataclass(frozen=True)
class ContrainteAjoutee:
    """Contrainte ponctuelle, par exemple issue d'une demande en langage naturel.

    - `imposer` : les séances des cours ciblés doivent tomber dans la fenêtre ;
    - `interdire` : aucune séance ciblée ne doit toucher la fenêtre.

    La cible est un cours, une classe ou un enseignant ; la fenêtre combine des
    jours, une plage horaire et une plage de dates (chaque critère est facultatif).
    """

    type: Literal["imposer", "interdire"]
    id_cours: int | None = None
    id_classe: int | None = None
    id_enseignant: int | None = None
    jours: tuple[str, ...] = ()
    heure_min: time | None = None
    heure_max: time | None = None
    date_debut: date | None = None
    date_fin: date | None = None
    libelle: str = ""

    def cible(self, c: Cours) -> bool:
        return (
            (self.id_cours is None or c.id_cours == self.id_cours)
            and (self.id_classe is None or c.id_classe == self.id_classe)
            and (self.id_enseignant is None or c.id_enseignant == self.id_enseignant)
        )

    def _dans_fenetre(self, d: date, jour: str, debut: int, fin: int) -> bool:
        if self.jours and jour not in self.jours:
            return False
        if self.date_debut and d < self.date_debut:
            return False
        if self.date_fin and d > self.date_fin:
            return False
        lo = minutes(self.heure_min) if self.heure_min else 0
        hi = minutes(self.heure_max) if self.heure_max else 24 * 60
        return debut >= lo and fin <= hi

    def _touche_fenetre(self, d: date, jour: str, debut: int, fin: int) -> bool:
        if self.jours and jour not in self.jours:
            return False
        if self.date_debut and d < self.date_debut:
            return False
        if self.date_fin and d > self.date_fin:
            return False
        lo = minutes(self.heure_min) if self.heure_min else 0
        hi = minutes(self.heure_max) if self.heure_max else 24 * 60
        return debut < hi and fin > lo

    def autorise(self, c: Cours, d: date, jour: str, debut: int, fin: int) -> bool:
        if not self.cible(c):
            return True
        if self.type == "imposer":
            return self._dans_fenetre(d, jour, debut, fin)
        return not self._touche_fenetre(d, jour, debut, fin)


@dataclass
class Demande:
    perimetre: Perimetre = field(default_factory=Perimetre)
    du: date | None = None  # défaut : début du semestre
    au: date | None = None  # défaut : fin du semestre
    contraintes: list[ContrainteAjoutee] = field(default_factory=list)
    garder_verrouillees: bool = True  # BF-17
    # Compléter seulement : toutes les séances existantes restent en place (comme verrouillées) ;
    # seules les heures qui manquent au volume de chaque cours sont placées
    completer: bool = False
    # Replanification : déplacer au minimum les séances déjà prévues dans la
    # fenêtre (mêmes heures par cours), au lieu de compléter le programme
    minimiser_changements: bool = False
    # Génération sur une courte période (une ou deux semaines) : l'étage 1
    # répartit le volume restant jusqu'à cet horizon (défaut : fin du semestre)
    # selon le rythme de chaque cours, l'étage 2 ne place que la période ; les
    # heures prévues après elle sont reportées, pas perdues.
    horizon: date | None = None
    temps_max_semaines: float = 20.0  # secondes, étage 1
    temps_max_placement: float = 10.0  # secondes par semaine, étage 2
    iterations_max: int = 8
    # Part des heures ouvertes que l'étage 1 s'autorise à remplir : les séances
    # de 2 à 4 h ne s'emboîtent pas parfaitement entre les pauses
    marge_classe: float = 0.85
    marge_enseignant: float = 0.9


@dataclass(frozen=True)
class NonPlace:
    id_cours: int
    heures: int
    code: str
    raison: str
    semaine: date | None = None


@dataclass
class Resultat:
    seances: list[Seance]  # séances du périmètre produites par le solveur
    conservees: list[Seance]  # séances figées (hors périmètre, hors période, verrouillées)
    remplacees: list[Seance]  # séances du périmètre qui seraient remplacées
    non_places: list[NonPlace]
    statistiques: dict = field(default_factory=dict)
    # heures restant à programmer après la période (génération sur une courte période)
    reportees: dict[int, int] = field(default_factory=dict)

    @property
    def heures_placees(self) -> int:
        return sum(s.duree for s in self.seances)

    def modifications(self) -> list[dict]:
        """Différence avec l'emploi du temps actuel du périmètre, au format
        de PROPOSITION.modifications."""

        def cle(s: Seance):
            # toute la séance : une même heure de début avec une autre durée est un changement
            return (s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle)

        avant = {cle(s): s for s in self.remplacees}
        apres = {cle(s): s for s in self.seances}
        ops: list[dict] = []
        for k, s in avant.items():
            if k not in apres:
                ops.append({"action": "supprimer", "id_seance": s.id_seance, "avant": _json(s)})
        for k, s in apres.items():
            if k not in avant:
                ops.append({"action": "creer", "apres": _json(s)})
        return ops


def _json(s: Seance) -> dict:
    return {
        "id_cours": s.id_cours,
        "date_seance": s.date_seance.isoformat(),
        "heure_debut": s.heure_debut.strftime("%H:%M"),
        "heure_fin": s.heure_fin.strftime("%H:%M"),
        "id_salle": s.id_salle,
    }
