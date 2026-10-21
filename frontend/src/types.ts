// Modèle de données côté interface.
// Il suit la liste des relations du cahier des charges (§7) plutôt que
// schema_supabase.sql : voir fichier.md §11 pour les écarts à arbitrer
// (département, habilitation, programme, disponibilité à trois niveaux).

export type Role =
  | 'administrateur'
  | 'planificateur'
  | 'chef_departement'
  | 'enseignant'
  | 'etudiant';

export const ROLE_LABELS: Record<Role, string> = {
  administrateur: 'Administrateur',
  planificateur: 'Scolarité (planificateur)',
  chef_departement: 'Chef de département',
  enseignant: 'Enseignant',
  etudiant: 'Étudiant / délégué',
};

export type Niveau = 'L1' | 'L2' | 'L3' | 'M1' | 'M2';
export const NIVEAUX: Niveau[] = ['L1', 'L2', 'L3', 'M1', 'M2'];

export type Jour = 'Lundi' | 'Mardi' | 'Mercredi' | 'Jeudi' | 'Vendredi' | 'Samedi';
export const JOURS: Jour[] = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

export type NiveauDispo = 'disponible' | 'preference' | 'indisponible';

export interface Entity {
  id: number;
  archived?: boolean;
}

export interface Departement extends Entity {
  code: string;
  libelle: string;
}

export interface Filiere extends Entity {
  code: string;
  libelle: string;
  niveau: Niveau;
  departementId: number;
}

export interface Groupe extends Entity {
  code: string;
  effectif: number;
  filiereId: number;
}

export interface Cours extends Entity {
  code: string;
  intitule: string;
  ects: number;
  semestre: string;
  departementId: number;
}

export interface TypeSalle extends Entity {
  libelle: string;
}

export interface TypeSeance extends Entity {
  code: string;
  libelle: string;
  typeSalleId: number;
}

export interface VolumeHoraire extends Entity {
  coursId: number;
  typeSeanceId: number;
  heures: number;
}

export interface Batiment extends Entity {
  code: string;
  nom: string;
}

export interface Salle extends Entity {
  code: string;
  nom: string;
  capacite: number;
  etage: number;
  batimentId: number;
  typeSalleId: number;
}

export interface Creneau extends Entity {
  jour: Jour;
  debut: string; // HH:MM
  fin: string;
}

export interface Programme extends Entity {
  filiereId: number;
  coursId: number;
}

export interface Enseignant extends Entity {
  matricule: string;
  nom: string;
  prenom: string;
  grade: string;
  email: string;
  telephone: string;
  departementId: number;
}

export interface Habilitation extends Entity {
  enseignantId: number;
  coursId: number;
}

// Un créneau sans ligne est considéré « disponible » (parade du risque §9.3).
export interface Disponibilite extends Entity {
  enseignantId: number;
  creneauId: number;
  niveau: NiveauDispo;
}

export interface Seance extends Entity {
  coursId: number;
  typeSeanceId: number;
  groupeId: number;
  enseignantId: number;
  salleId: number;
  creneauId: number;
}

export interface Utilisateur extends Entity {
  login: string;
  nom: string;
  email: string;
  role: Role;
  departementId?: number;
  enseignantId?: number;
  groupeId?: number;
}

export interface Notification extends Entity {
  utilisateurId: number;
  date: string; // ISO
  titre: string;
  texte: string;
  lue: boolean;
}

export interface Campagne {
  semestre: string;
  dateLimite: string; // ISO date
}

export interface Db {
  departements: Departement[];
  filieres: Filiere[];
  groupes: Groupe[];
  cours: Cours[];
  typesSalle: TypeSalle[];
  typesSeance: TypeSeance[];
  volumes: VolumeHoraire[];
  batiments: Batiment[];
  salles: Salle[];
  creneaux: Creneau[];
  programmes: Programme[];
  enseignants: Enseignant[];
  habilitations: Habilitation[];
  disponibilites: Disponibilite[];
  seances: Seance[];
  utilisateurs: Utilisateur[];
  notifications: Notification[];
}

export type Collection = keyof Db;
