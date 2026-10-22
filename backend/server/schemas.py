"""Modèles d'entrée de l'API (validation + documentation OpenAPI, BNF-14).

Ils reprennent les colonnes de schema_supabase.sql. Pour chaque table :
- XxxCreation : champs envoyés à la création ;
- XxxModification : mêmes champs, tous facultatifs (PATCH partiel).
Les réponses renvoient les lignes de la base telles quelles.
"""

from datetime import date, time
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, create_model

Niveau = Literal["L1", "L2", "L3", "M1", "M2"]
TypeCours = Literal["CM", "TD", "TP"]
Jour = Literal["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
Role = Literal["administrateur", "planificateur", "chef_departement", "enseignant", "etudiant"]
NiveauDispo = Literal["disponible", "preference", "indisponible"]
StatutSeance = Literal["planifiee", "validee", "annulee"]


class Entree(BaseModel):
    model_config = ConfigDict(extra="forbid")


def modification(modele: type[BaseModel]) -> type[BaseModel]:
    """Construit la variante « tous champs facultatifs » d'un modèle de création."""
    champs = {nom: (champ.annotation | None, None) for nom, champ in modele.model_fields.items()}
    return create_model(modele.__name__.replace("Creation", "Modification"), __base__=Entree, **champs)


# --- Référentiel -------------------------------------------------------------

class FiliereCreation(Entree):
    code_filiere: str
    libelle: str


class ClasseCreation(Entree):
    code_classe: str
    libelle: str
    niveau: Niveau
    effectif: int = Field(0, ge=0)
    id_filiere: int


class GroupeCreation(Entree):
    code_groupe: str
    type_groupe: TypeCours
    effectif: int = Field(0, ge=0)
    id_classe: int


class MatiereCreation(Entree):
    code_matiere: str
    libelle: str
    coefficient: Decimal = Field(Decimal(1), ge=0)


class EnseignantCreation(Entree):
    matricule: str
    nom: str
    prenom: str
    email: EmailStr | None = None
    telephone: str | None = None
    grade: str | None = None
    nb_heures_max_semaine: int | None = Field(None, gt=0)


class CreneauCreation(Entree):
    jour: Jour
    heure_debut: time
    heure_fin: time


class PauseCreation(Entree):
    libelle: str
    heure_debut: time
    heure_fin: time


class JourFerieCreation(Entree):
    date_ferie: date
    libelle: str


class TypeSalleCreation(Entree):
    libelle: str


class SalleCreation(Entree):
    code_salle: str
    nom_salle: str
    capacite: int = Field(gt=0)
    batiment: str | None = None
    est_disponible: bool = True
    id_type_salle: int


class SemestreCreation(Entree):
    libelle: str
    annee_academique: str = Field(examples=["2026-2027"])
    date_debut: date
    date_fin: date


class CoursCreation(Entree):
    type_cours: TypeCours
    volume_horaire: Decimal = Field(gt=0, description="Heures sur tout le semestre")
    duree_seance: Decimal = Field(ge=2, le=4, description="Durée par défaut d'une séance (h)")
    nb_seances_semaine: int = Field(1, gt=0)
    priorite: int = 0
    id_matiere: int
    id_classe: int
    id_groupe: int | None = Field(None, description="Vide = classe entière")
    id_enseignant: int
    id_type_salle: int | None = None
    id_semestre: int


class SeanceModele(Entree):
    rang: int = Field(gt=0)
    duree_heures: Decimal = Field(ge=2, le=4)


# --- Utilisateurs --------------------------------------------------------------

class UtilisateurCreation(Entree):
    login: str
    email: EmailStr
    role: Role = "etudiant"
    mot_de_passe: str | None = Field(None, min_length=8, description="Stocké haché ; facultatif avec le SSO")


class Connexion(Entree):
    login: str
    mot_de_passe: str


# --- Disponibilités --------------------------------------------------------------

class Disponibilite(Entree):
    id_creneau: int
    niveau: NiveauDispo
    motif: str | None = None


# --- Emplois du temps, contraintes, prompts ----------------------------------------

class EmploiDuTempsCreation(Entree):
    libelle: str
    id_semestre: int
    mode_generation: Literal["manuel", "automatique"] = "manuel"
    id_utilisateur: int | None = Field(None, description="Par défaut : l'utilisateur connecté")


class EmploiDuTempsModification(Entree):
    libelle: str | None = None
    mode_generation: Literal["manuel", "automatique"] | None = None


class ContrainteCreation(Entree):
    libelle: str
    type_contrainte: str = Field(examples=["CS-01"])
    nature: Literal["dure", "souple"]
    poids: int = Field(0, ge=0)
    est_active: bool = True


class PromptCreation(Entree):
    texte: str
    id_utilisateur: int | None = Field(None, description="Par défaut : l'utilisateur connecté")


class PromptReponse(Entree):
    reponse: str
    statut: Literal["en_attente", "traite", "erreur"] = "traite"


# --- Séances -----------------------------------------------------------------------

class SeanceCreation(Entree):
    id_edt: int
    id_cours: int
    id_salle: int
    id_creneau: int = Field(description="Créneau de début (donne le jour et l'heure de début)")
    date_seance: date
    duree_heures: Decimal | None = Field(
        None, ge=2, le=4, description="Par défaut : duree_seance du cours"
    )
    est_verrouillee: bool = False


class SeanceModification(Entree):
    """Déplacement (glisser-déposer) ou changement de salle / statut."""
    id_salle: int | None = None
    id_creneau: int | None = None
    date_seance: date | None = None
    duree_heures: Decimal | None = Field(None, ge=2, le=4)
    statut: StatutSeance | None = None
    est_verrouillee: bool | None = None


class Placement(Entree):
    """Une séance de la semaine type, telle que produite par le moteur (tâche 2)."""
    id_cours: int
    id_salle: int
    id_creneau: int
    duree_heures: Decimal = Field(ge=2, le=4)
    est_verrouillee: bool = False


class SemaineType(Entree):
    placements: list[Placement]
    remplacer: bool = Field(
        True, description="Supprime d'abord les séances non verrouillées de l'emploi du temps"
    )


class DuplicationSemaine(Entree):
    date_semaine: date = Field(description="N'importe quelle date de la semaine modèle")
    remplacer: bool = Field(
        False, description="Supprime d'abord les séances non verrouillées des autres semaines"
    )


class Generation(Entree):
    duree_max_secondes: int = Field(600, gt=0, le=900, description="BNF-03 : moins de 15 min")
