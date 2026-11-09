// Types calqués sur schema_supabase.sql (version 2).
// Les colonnes gardent leur nom SQL pour que le passage à Supabase soit direct.
// DATE = 'AAAA-MM-JJ', TIME = 'HH:MM', TIMESTAMPTZ = chaîne ISO.

export type Niveau = 'L1' | 'L2' | 'L3' | 'M1' | 'M2' | 'CPGE1' | 'CPGE2' | 'BT' | 'MAN' | 'AUTRE'
export type TypeSeance = 'CM' | 'TD' | 'TP'
/** Un groupe est de TD, de TP ou une option ; un CM réunit la classe entière ou une option */
export type TypeGroupe = 'TD' | 'TP' | 'OPTION'
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
  /** Campus mère de la promotion : la génération y place ses cours (null : celui de la filière) */
  id_site?: number | null
  /** Salle de cours habituelle (version 17) : préférée par la génération et la console quand elle convient,
   *  jamais imposée (null : aucune) */
  id_salle_principale?: number | null
}

/** Groupe d'une classe ; arbre : TD ou option, puis demi-groupe de TP ou sous-option */
export interface Groupe {
  id_groupe: number
  code_groupe: string
  type_groupe: TypeGroupe
  effectif: number
  id_classe: number
  id_groupe_parent?: number | null
}

/** Cours mutualisé : public suivi en plus du public principal du cours */
export interface CoursPublic {
  id_cours_public: number
  id_cours: number
  id_classe: number
  id_groupe: number | null
}

/** Copie publiée d'une mutualisation (COURS_PUBLIC_PUBLIE) : ce que voient les invités, écrite par la publication */
export interface CoursPublicPublie {
  id_cours_public_publie: number
  /** Version publiée (copie) */
  id_edt: number
  id_cours: number
  id_classe: number
  id_groupe: number | null
}

/** Type de salle accepté en plus du type exigé par le cours */
export interface CoursTypeSalle {
  id_cours_type_salle: number
  id_cours: number
  id_type_salle: number
}

/** Salle réservée à certaines formations (aucune ligne : salle libre) */
export interface SalleReservation {
  id_salle_reservation: number
  id_salle: number
  id_classe: number
}

/** Temps de trajet entre deux sites (id_site_a < id_site_b) */
export interface SiteTrajet {
  id_site_trajet: number
  id_site_a: number
  id_site_b: number
  minutes: number
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
  /** Enseignant prévu (facultatif), repris par défaut sur les séances générées */
  id_enseignant: number | null
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
  /** Règle du planificateur (type 'interdire', 'precede', 'plafond_jour') : ses paramètres et sa période */
  parametres?: ParametresRegle | null
  date_debut?: string | null
  date_fin?: string | null
}

export interface ParametresRegle {
  cible?: { id_classe?: number; id_enseignant?: number; id_cours?: number; tous?: boolean }
  jours?: Jour[]
  /** 0 : matin, 1 : après-midi ; absent : toute la journée */
  demi?: 0 | 1
  matiere_avant?: number
  matiere_apres?: number
  heures?: number
}

export interface ImpactProposition {
  seances_deplacees?: number
  seances_supprimees?: number
  seances_creees?: number
  /** Séances supprimées par la proposition : une ligne par séance, dans l'ordre chronologique */
  seances_retirees?: string[]
  heures_retirees?: number
  /** Séances ajoutées (épreuves) : une ligne par séance */
  seances_ajoutees?: string[]
  heures_perdues?: { cours: string; heures: number; regle: string; raison: string }[]
  /** génération sur une courte période : heures prévues après elle */
  heures_reportees?: { cours: string; heures: number }[]
  /** séances à ramener dans la période qui n'y ont pas trouvé de place : elles restent où elles sont */
  restees_hors_periode?: { cours: string; date: string; heure_debut: string; heure_fin: string; raison: string }[]
  enseignants_a_prevenir?: { enseignant: string; statut: string; seances_modifiees: number }[]
  classes_concernees?: string[]
  fins_decalees?: { cours: string; fin_avant: string; fin_apres: string; jours: number }[]
  journees_chargees?: { enseignant: string; date: string; heures: number; plafond: number }[]
  changements_de_site?: { classe: string; date: string; sites: number }[]
  /** Semaines où un cours dépasserait son rythme souhaité (CS-08, souple) : permis, signalé */
  au_dela_du_rythme?: { cours: string; semaine: string; heures: number; rythme: number }[]
  /** Changements du référentiel : séances (ou cours) qu'ils laisseraient hors des règles */
  conflits?: { regle: string; nombre: number; exemples: string[]; du: string | null; au: string | null }[]
}

/** Changement du référentiel proposé (PROPOSITION.modifications de nature « referentiel ») */
export interface OperationReferentiel {
  action: 'ajouter_ligne' | 'modifier_ligne' | 'supprimer_ligne' | 'disponibilite'
  table: string
  libelle: string
  /** disponibilite : null quand la saisie est retirée */
  niveau?: string | null
}

/** Modification proposée par l'assistant IA, en attente de validation */
export interface Proposition {
  id_proposition: number
  description: string
  modifications: unknown[]
  /** Conséquences calculées : heures perdues, enseignants à prévenir, cours décalés… */
  impact: ImpactProposition
  statut: StatutProposition
  /** seances : opérations sur des séances ; referentiel : lignes du référentiel, du calendrier ou
   *  des enseignants à ajouter, modifier ou supprimer */
  nature?: 'seances' | 'referentiel'
  /** Génération ou replanification lancée une fois les changements du référentiel validés */
  suite?: {
    description: string; mode?: 'generer' | 'replanifier'; classes?: string[]; filieres?: string[]; matieres?: string[]
    du?: string; au?: string
  } | null
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

/** Un cours, ou une épreuve : examen, puis rattrapage du même module */
export type NatureSeance = 'cours' | 'examen' | 'rattrapage'

export interface Seance {
  id_seance: number
  date_seance: string
  heure_debut: string
  heure_fin: string
  statut: StatutSeance
  est_verrouillee: boolean
  id_cours: number
  /** Enseignant de la séance ; null : à désigner */
  id_enseignant: number | null
  id_salle: number
  id_creneau: number
  id_edt: number
  /** Absente : un cours */
  nature?: NatureSeance
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
  absence_enseignant: AbsenceEnseignant[]
  sejour_enseignant: SejourEnseignant[]
  creneau: Creneau[]
  pause: Pause[]
  jour_ferie: JourFerie[]
  conge: Conge[]
  type_salle: TypeSalle[]
  salle: Salle[]
  salle_reservation: SalleReservation[]
  site_trajet: SiteTrajet[]
  semestre: Semestre[]
  utilisateur: Utilisateur[]
  programme: Programme[]
  cours: Cours[]
  cours_public: CoursPublic[]
  /** Lecture seule, jamais synchronisée : mutualisations publiées (console ; null : base avant la version 15,
   *  sans copie publiée ; absente en mode simulé tant que rien n'est publié) */
  cours_public_publie?: CoursPublicPublie[] | null
  cours_type_salle: CoursTypeSalle[]
  cours_seance_modele: CoursSeanceModele[]
  disponibilite: Disponibilite[]
  emploi_du_temps: EmploiDuTemps[]
  contrainte: Contrainte[]
  conversation: Conversation[]
  prompt: Prompt[]
  proposition: Proposition[]
  seance: Seance[]
}
