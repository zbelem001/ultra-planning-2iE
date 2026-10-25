// Types calqués sur schema_supabase.sql (version 2).
// Les colonnes gardent leur nom SQL pour que le passage à Supabase soit direct.
// DATE = 'AAAA-MM-JJ', TIME = 'HH:MM', TIMESTAMPTZ = chaîne ISO.

export type Niveau = 'L1' | 'L2' | 'L3' | 'M1' | 'M2'
export type TypeSeance = 'CM' | 'TD' | 'TP'
/** Un groupe est de TD ou de TP ; un CM réunit la classe entière */
export type TypeGroupe = 'TD' | 'TP'
export type Jour = 'Lundi' | 'Mardi' | 'Mercredi' | 'Jeudi' | 'Vendredi' | 'Samedi'
/** Seuls les gestionnaires ont un compte ; enseignants et étudiants consultent sans connexion */
export type Role = 'administrateur' | 'planificateur'
export type TypeConge = 'vacances' | 'examens' | 'stage' | 'autre'
/** permanent : cours enchaînés ; vacataire_local : selon ses disponibilités ; externe : séjours datés */
export type StatutEnseignant = 'permanent' | 'vacataire_local' | 'externe'
export type StatutProposition = 'en_attente' | 'appliquee' | 'rejetee'
export type NiveauDispo = 'disponible' | 'preference' | 'indisponible'
export type StatutEdt = 'brouillon' | 'valide' | 'publie' | 'archive'
export type ModeGeneration = 'manuel' | 'automatique'
export type StatutSeance = 'planifiee' | 'validee' | 'annulee'
export type StatutPrompt = 'en_attente' | 'traite' | 'erreur'
export type NatureContrainte = 'dure' | 'souple'

export type TypeSite = 'campus' | 'annexe'

/** Campus ou annexe de l'école */
export interface Site {
  id_site: number
  code_site: string
  nom_site: string
  type_site: TypeSite
  adresse: string | null
}

export interface Filiere {
  id_filiere: number
  code_filiere: string
  libelle: string
  id_site: number | null
}

export interface Classe {
  id_classe: number
  code_classe: string
  libelle: string
  niveau: Niveau
  effectif: number
  id_filiere: number
}

export interface Groupe {
  id_groupe: number
  code_groupe: string
  type_groupe: TypeGroupe
  effectif: number
  id_classe: number
}

export interface Matiere {
  id_matiere: number
  code_matiere: string
  libelle: string
  coefficient: number
}

export interface Enseignant {
  id_enseignant: number
  matricule: string
  nom: string
  prenom: string
  email: string | null
  telephone: string | null
  grade: string | null
  nb_heures_max_semaine: number | null
  statut: StatutEnseignant
  id_site: number | null
}

/** Matière et type de cours qu'un enseignant est habilité à assurer (CD-06) */
export interface Habilitation {
  id_habilitation: number
  id_enseignant: number
  id_matiere: number
  type_cours: TypeSeance
}

/** Séjour prévu d'un intervenant externe sur le campus (CD-06) */
export interface SejourEnseignant {
  id_sejour: number
  id_enseignant: number
  date_debut: string
  date_fin: string
  commentaire: string | null
}

/** Absence datée d'un enseignant (CD-06) */
export interface AbsenceEnseignant {
  id_absence: number
  id_enseignant: number
  date_debut: string
  date_fin: string
  motif: string | null
}

export interface Creneau {
  id_creneau: number
  jour: Jour
  heure_debut: string
  heure_fin: string
}

export interface Pause {
  id_pause: number
  libelle: string
  heure_debut: string
  heure_fin: string
}

export interface JourFerie {
  date_ferie: string
  libelle: string
}

/** Période sans cours ; id_classe null = tout l'établissement */
export interface Conge {
  id_conge: number
  libelle: string
  type_conge: TypeConge
  date_debut: string
  date_fin: string
  id_classe: number | null
}

export interface TypeSalle {
  id_type_salle: number
  libelle: string
}

export interface Salle {
  id_salle: number
  code_salle: string
  nom_salle: string
  capacite: number
  batiment: string | null
  est_disponible: boolean
  id_type_salle: number
  id_site: number
}

export interface Semestre {
  id_semestre: number
  libelle: string
  annee_academique: string
  date_debut: string
  date_fin: string
}

export interface Utilisateur {
  id_utilisateur: number
  login: string
  mot_de_passe: string | null
  email: string
  role: Role
  /** école du compte (version 6) ; gérés par la console super admin */
  id_ecole?: number | null
  est_actif?: boolean
  auth_id?: string | null
  date_creation?: string
}

/** Maquette pédagogique : volumes prévus par classe, matière et semestre (CD-07).
 *  Pour un TD ou un TP fait par groupes, le volume vaut pour chaque groupe. */
export interface Programme {
  id_programme: number
  id_classe: number
  id_matiere: number
  id_semestre: number
  volume_cm: number
  volume_td: number
  volume_tp: number
}

export interface Cours {
  id_cours: number
  type_cours: TypeSeance
  volume_horaire: number
  duree_seance: number
  nb_seances_semaine: number
  priorite: number
  priorite_suggeree: number | null
  justification_priorite: string | null
  heures_semaine_min: number
  heures_semaine_max: number
  id_matiere: number
  id_classe: number
  id_groupe: number | null
  id_enseignant: number
  id_type_salle: number | null
  id_semestre: number
}

export interface CoursSeanceModele {
  id_cours: number
  rang: number
  duree_heures: number
}

export interface Disponibilite {
  id_enseignant: number
  id_creneau: number
  niveau: NiveauDispo
  motif: string | null
}

export interface EmploiDuTemps {
  id_edt: number
  libelle: string
  version: number
  mode_generation: ModeGeneration
  statut: StatutEdt
  date_creation: string
  date_publication: string | null
  id_semestre: number
  id_utilisateur: number
}

export interface Contrainte {
  id_contrainte: number
  libelle: string
  type_contrainte: string
  nature: NatureContrainte
  poids: number
  /** Paramètre de la contrainte : ex. 3 matières par semaine (CD-13), 6 h par jour (CS-06) */
  valeur: number | null
  est_active: boolean
  id_edt: number
}

export interface ImpactProposition {
  seances_deplacees?: number
  seances_supprimees?: number
  seances_creees?: number
  heures_perdues?: { cours: string; heures: number; regle: string; raison: string }[]
  /** génération sur une courte période : heures prévues après elle */
  heures_reportees?: { cours: string; heures: number }[]
  enseignants_a_prevenir?: { enseignant: string; statut: string; seances_modifiees: number }[]
  classes_concernees?: string[]
  fins_decalees?: { cours: string; fin_avant: string; fin_apres: string; jours: number }[]
  journees_chargees?: { enseignant: string; date: string; heures: number; plafond: number }[]
  changements_de_site?: { classe: string; date: string; sites: number }[]
}

/** Modification proposée par l'assistant IA, en attente de validation */
export interface Proposition {
  id_proposition: number
  description: string
  modifications: unknown[]
  /** Conséquences calculées : heures perdues, enseignants à prévenir, cours décalés… */
  impact: ImpactProposition
  statut: StatutProposition
  date_creation: string
  date_decision: string | null
  id_prompt: number
  id_edt: number
  id_utilisateur_decision: number | null
}

/** Fil de discussion avec l'assistant IA (regroupe des prompts) */
export interface Conversation {
  id_conversation: number
  titre: string
  date_creation: string
  id_utilisateur: number
  id_edt: number
}

export interface Prompt {
  id_prompt: number
  texte: string
  reponse: string | null
  statut: StatutPrompt
  date_prompt: string
  id_utilisateur: number
  id_edt: number
  id_conversation: number
}

export interface Seance {
  id_seance: number
  date_seance: string
  heure_debut: string
  heure_fin: string
  statut: StatutSeance
  est_verrouillee: boolean
  id_cours: number
  id_salle: number
  id_creneau: number
  id_edt: number
}

/** Image complète de la base, telle que le front la manipule. */
/** École de la console (ou consultée par l'invité) ; absente en mode simulé */
export interface Ecole {
  id_ecole: number
  code_ecole: string
  nom: string
  ville: string | null
  pays: string | null
}

export interface Db {
  /** Lecture seule : envoyée par l'API, jamais synchronisée */
  ecole?: Ecole[]
  site: Site[]
  filiere: Filiere[]
  classe: Classe[]
  groupe: Groupe[]
  matiere: Matiere[]
  enseignant: Enseignant[]
  habilitation: Habilitation[]
  absence_enseignant: AbsenceEnseignant[]
  sejour_enseignant: SejourEnseignant[]
  creneau: Creneau[]
  pause: Pause[]
  jour_ferie: JourFerie[]
  conge: Conge[]
  type_salle: TypeSalle[]
  salle: Salle[]
  semestre: Semestre[]
  utilisateur: Utilisateur[]
  programme: Programme[]
  cours: Cours[]
  cours_seance_modele: CoursSeanceModele[]
  disponibilite: Disponibilite[]
  emploi_du_temps: EmploiDuTemps[]
  contrainte: Contrainte[]
  conversation: Conversation[]
  prompt: Prompt[]
  proposition: Proposition[]
  seance: Seance[]
}
