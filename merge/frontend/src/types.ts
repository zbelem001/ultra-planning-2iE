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
  /** Séance verrouillée : la génération automatique ne la déplace pas (BF-17). */
  verrouillee?: boolean;
}

// UTILISATEUR / ROLE n'existent pas encore dans le MLD (cahier des charges §7,
// « évolutions prévues ») : la table est mockée ici. archived = compte désactivé.
export interface Utilisateur extends Entity {
  login: string;
  nom: string;
  email: string;
  role: Role;
  departementId?: number;
  enseignantId?: number;
  groupeId?: number;
  derniereConnexion?: string; // ISO
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
  annees: AnneeUniversitaire[];
  semestres: Semestre[];
  campagnes: CampagneSaisie[];
  relances: Relance[];
  duplications: Duplication[];
  generations: Generation[];
  validations: ValidationDepartement[];
  versions: VersionEdt[];
  signalements: Signalement[];
  audit: EntreeAudit[];
  parametres: Parametres[];
  gabarits: GabaritEmail[];
}

export type Collection = keyof Db;

// ---------- Pages 15 à 28 ----------

// ANNEE_UNIVERSITAIRE / SEMESTRE : évolution prévue du modèle (§7, BF-26),
// absente du MLD actuel et de schema_supabase.sql ; mockée en attendant.
export type StatutPeriode = 'a_venir' | 'ouverte' | 'cloturee';

export const STATUT_PERIODE_LABELS: Record<StatutPeriode, string> = {
  a_venir: 'À venir',
  ouverte: 'Ouverte',
  cloturee: 'Clôturée',
};

export interface AnneeUniversitaire extends Entity {
  libelle: string; // 2027-2028
  debut: string; // ISO date
  fin: string;
  statut: StatutPeriode;
}

export interface Semestre extends Entity {
  anneeId: number;
  code: string; // S1, S2
  debut: string; // ISO date, un lundi
  fin: string;
  statut: StatutPeriode;
}

/** Campagne de saisie des disponibilités d'un semestre (BF-10). */
export interface CampagneSaisie extends Entity {
  semestreId: number;
  dateLimite: string; // ISO date
  relanceAuto: boolean;
  /** Relances automatiques à J-n de la date limite. */
  joursRelance: number[];
}

export interface Relance extends Entity {
  campagneId: number;
  date: string; // ISO
  auto: boolean;
  enseignantIds: number[];
}

/** Application de la semaine type sur les semaines du semestre (BF-14). */
export interface Duplication extends Entity {
  semestreId: number;
  date: string; // ISO
  auteurId: number;
  /** Lundis (ISO) des semaines sans cours : vacances, examens. */
  semainesExclues: string[];
  occurrences: number;
}

export type CodeCS = 'CS-01' | 'CS-02' | 'CS-03' | 'CS-04' | 'CS-05' | 'CS-06';
export const CODES_CS: CodeCS[] = ['CS-01', 'CS-02', 'CS-03', 'CS-04', 'CS-05', 'CS-06'];
export type Poids = Record<CodeCS, number>; // 0 (ignorée) à 10

export const CS_LABELS: Record<CodeCS, string> = {
  'CS-01': 'Créneaux « préférence » des enseignants',
  'CS-02': 'Éviter les trous dans la journée d’un groupe',
  'CS-03': 'Limiter les changements de bâtiment',
  'CS-04': 'Répartir les heures d’un cours sur la semaine',
  'CS-05': 'CM avant les TD et TP dans la semaine',
  'CS-06': 'Heures maximales par jour pour un enseignant',
};

export type CodeCD = 'CD-01' | 'CD-02' | 'CD-03' | 'CD-04' | 'CD-05' | 'CD-06' | 'CD-07' | 'CD-08' | 'CD-09';

export interface SeanceNonPlacee {
  coursId: number;
  typeSeanceId: number;
  groupeId: number;
  contrainte: CodeCD;
  motif: string;
  suggestion: string;
}

export type StatutGeneration = 'en_attente' | 'en_cours' | 'terminee' | 'acceptee' | 'rejetee';

export interface Generation extends Entity {
  semestreId: number;
  departementId?: number; // périmètre ; absent = toute l'université
  poids: Poids;
  auteurId: number;
  lancee: string; // ISO
  /** Durée simulée de la tâche Celery, en millisecondes. */
  dureeMs: number;
  statut: StatutGeneration;
  resultat?: {
    seances: Seance[];
    nonPlacees: SeanceNonPlacee[];
    verrouillees: number;
    demandes: number;
    satisfaction: Poids; // % de respect de chaque contrainte souple
  };
}

export type StatutValidation = 'en_attente' | 'validee' | 'corrections';

/** Validation par le chef de département (§2). */
export interface ValidationDepartement extends Entity {
  departementId: number;
  semestreId: number;
  statut: StatutValidation;
  date?: string; // ISO
  utilisateurId?: number;
  commentaire: string;
}

export type StatutVersion = 'publiee' | 'archivee';

/** Version publiée d'un emploi du temps (BF-19) : instantané des séances. */
export interface VersionEdt extends Entity {
  semestreId: number;
  numero: number;
  statut: StatutVersion;
  date: string; // ISO
  auteurId: number;
  commentaire: string;
  seances: Seance[];
}

export interface Signalement extends Entity {
  seanceId: number;
  utilisateurId: number;
  date: string; // ISO
  motif: string;
  texte: string;
  statut: 'ouvert' | 'traite';
}

export type ActionAudit = 'creation' | 'modification' | 'suppression';

/** Table d'audit (BNF-08, conservation 3 ans) : évolution prévue du modèle. */
export interface EntreeAudit extends Entity {
  date: string; // ISO
  utilisateurId: number;
  action: ActionAudit;
  entite: Collection;
  entiteId: number;
  resume: string;
}

export interface Parametres extends Entity {
  semestreActifId: number;
  heuresMaxJour: number; // CS-06
  poidsDefaut: Poids; // BF-16
}

export interface GabaritEmail extends Entity {
  code: string;
  libelle: string;
  sujet: string;
  corps: string;
}
