// Jeu de données fictif : reprise fidèle des sections 8 et 9 de
// schema_supabase.sql. Les identifiants suivent l'ordre d'insertion des
// colonnes IDENTITY, pour que les requêtes Supabase renvoient les mêmes lignes.

import type {
  AbsenceEnseignant, Classe, Conge, Contrainte, Conversation, Cours, CoursSeanceModele, Creneau, Db, Disponibilite, EmploiDuTemps,
  Enseignant, Filiere, Groupe, Habilitation, Jour, JourFerie, Matiere, Pause, Programme, Prompt, Salle, Seance,
  SejourEnseignant, Semestre, Site, TypeSalle, Utilisateur,
} from '@/types/db'
import { expandWeek } from '@/lib/generator'
import { addDays, fromMin, todayIso } from '@/lib/time'

const type_salle: TypeSalle[] = ['Amphithéâtre', 'Salle standard', 'Laboratoire', 'Salle informatique'].map(
  (libelle, i) => ({ id_type_salle: i + 1, libelle }),
)
const TS = { amphi: 1, standard: 2, labo: 3, info: 4 }

// Grille de base : créneaux de 1 h, 7 h–12 h et 13 h–16 h du lundi au vendredi,
// 7 h–12 h le samedi. Même ordre d'insertion que le script SQL.
const JOURS_GRILLE: Jour[] = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']
const HEURES = [7, 8, 9, 10, 11, 13, 14, 15]
const heuresDuJour = (jour: Jour) => (jour === 'Samedi' ? HEURES.filter((h) => h < 12) : HEURES)
const creneau: Creneau[] = JOURS_GRILLE.flatMap((jour, j) =>
  heuresDuJour(jour).map((h, k) => ({
    id_creneau: j * HEURES.length + k + 1,
    jour,
    heure_debut: fromMin(h * 60),
    heure_fin: fromMin((h + 1) * 60),
  })),
)
const cr = (jour: number, h: number) => jour * HEURES.length + HEURES.indexOf(h) + 1

const pause: Pause[] = [{ id_pause: 1, libelle: 'Pause déjeuner', heure_debut: '12:00', heure_fin: '13:00' }]

const semestre: Semestre[] = [
  { id_semestre: 1, libelle: 'Semestre 1', annee_academique: '2026-2027', date_debut: '2026-10-12', date_fin: '2027-02-19' },
]

const jour_ferie: JourFerie[] = [
  { date_ferie: '2026-11-01', libelle: 'Toussaint' },
  { date_ferie: '2026-12-11', libelle: "Fête nationale (proclamation de l'indépendance)" },
  { date_ferie: '2026-12-25', libelle: 'Noël' },
  { date_ferie: '2027-01-01', libelle: "Jour de l'An" },
  { date_ferie: '2027-01-03', libelle: 'Anniversaire du soulèvement populaire de 1966' },
]

const conge: Conge[] = [
  { id_conge: 1, libelle: "Vacances de fin d'année", type_conge: 'vacances', date_debut: '2026-12-21', date_fin: '2027-01-03', id_classe: null },
  { id_conge: 2, libelle: 'Examens du semestre 1', type_conge: 'examens', date_debut: '2027-02-15', date_fin: '2027-02-19', id_classe: null },
]

const utilisateur: Utilisateur[] = [
  { id_utilisateur: 1, login: 'planificateur', mot_de_passe: null, email: 'scolarite@univ.example', role: 'planificateur' },
  { id_utilisateur: 2, login: 'admin', mot_de_passe: null, email: 'dsi@univ.example', role: 'administrateur' },
]

const site: Site[] = [
  { id_site: 1, code_site: 'KAMB', nom_site: 'Campus de Kamboinsé', type_site: 'campus', adresse: 'Kamboinsé, Ouagadougou' },
  { id_site: 2, code_site: 'OUAGA', nom_site: 'Campus de Ouagadougou', type_site: 'campus', adresse: 'Ouagadougou' },
  { id_site: 3, code_site: 'ANNEXE', nom_site: 'Annexe de Ouagadougou', type_site: 'annexe', adresse: 'Ouagadougou' },
]
const SI = { kamb: 1, ouaga: 2, annexe: 3 }

const salle: Salle[] = (
  [
    ['K-AMPHI1', 'Amphi 200', 200, 'Bloc A', TS.amphi, SI.kamb],
    ['K-AMPHI2', 'Amphi 120', 120, 'Bloc A', TS.amphi, SI.kamb],
    ['K-A101', 'Salle A101', 60, 'Bloc A', TS.standard, SI.kamb],
    ['K-A102', 'Salle A102', 50, 'Bloc A', TS.standard, SI.kamb],
    ['K-B201', 'Salle B201', 40, 'Bloc B', TS.standard, SI.kamb],
    ['K-LAB1', 'Laboratoire 1', 30, 'Bloc B', TS.labo, SI.kamb],
    ['K-LAB2', 'Laboratoire 2', 25, 'Bloc B', TS.labo, SI.kamb],
    ['K-INFO1', 'Salle informatique 1', 40, 'Bloc B', TS.info, SI.kamb],
    ['O-AMPHI1', 'Amphi 250', 250, 'Bâtiment principal', TS.amphi, SI.ouaga],
    ['O-B101', 'Salle 101', 80, 'Bâtiment principal', TS.standard, SI.ouaga],
    ['O-B102', 'Salle 102', 45, 'Bâtiment principal', TS.standard, SI.ouaga],
    ['O-INFO1', 'Salle informatique', 35, null, TS.info, SI.annexe],
    ['O-LAB1', 'Laboratoire', 30, null, TS.labo, SI.annexe],
  ] as const
).map(([code_salle, nom_salle, capacite, batiment, id_type_salle, id_site], i) => ({
  id_salle: i + 1, code_salle, nom_salle, capacite, batiment, est_disponible: true, id_type_salle, id_site,
}))

const filiere: Filiere[] = [
  { id_filiere: 1, code_filiere: 'INFO', libelle: 'Informatique', id_site: SI.kamb },
  { id_filiere: 2, code_filiere: 'IA', libelle: 'Intelligence artificielle', id_site: SI.kamb },
]

const classe: Classe[] = [
  { id_classe: 1, code_classe: 'L1INFO', libelle: 'Licence 1 Informatique', niveau: 'L1', effectif: 120, id_filiere: 1 },
  { id_classe: 2, code_classe: 'L2INFO', libelle: 'Licence 2 Informatique', niveau: 'L2', effectif: 80, id_filiere: 1 },
  { id_classe: 3, code_classe: 'L3INFO', libelle: 'Licence 3 Informatique', niveau: 'L3', effectif: 60, id_filiere: 1 },
  { id_classe: 4, code_classe: 'M1IA', libelle: 'Master 1 IA', niveau: 'M1', effectif: 30, id_filiere: 2 },
  { id_classe: 5, code_classe: 'M2IA', libelle: 'Master 2 IA', niveau: 'M2', effectif: 24, id_filiere: 2 },
]

const groupe: Groupe[] = (
  [
    ['TD-A', 'TD', 60, 1], ['TD-B', 'TD', 60, 1],
    ['TD-A', 'TD', 40, 2], ['TD-B', 'TD', 40, 2],
    ['TP-G1', 'TP', 25, 2], ['TP-G2', 'TP', 25, 2], ['TP-G3', 'TP', 30, 2],
    ['TP-G1', 'TP', 15, 4], ['TP-G2', 'TP', 15, 4],
  ] as const
).map(([code_groupe, type_groupe, effectif, id_classe], i) => ({ id_groupe: i + 1, code_groupe, type_groupe, effectif, id_classe }))

const enseignant: Enseignant[] = (
  [
    ['ENS-001', 'Ouédraogo', 'Adama', 'a.ouedraogo@univ.example', 'Professeur', 16],
    ['ENS-002', 'Sawadogo', 'Mariam', 'm.sawadogo@univ.example', 'Maître de conférences', 16],
    ['ENS-003', 'Kaboré', 'Issouf', 'i.kabore@univ.example', 'Maître-assistant', 18],
    ['ENS-004', 'Compaoré', 'Aïssata', 'a.compaore@univ.example', 'Maître de conférences', 16],
    ['ENS-005', 'Zongo', 'Boureima', 'b.zongo@univ.example', 'Professeur', 14],
    ['ENS-006', 'Traoré', 'Fatoumata', 'f.traore@univ.example', 'Maître de conférences', 16],
    ['ENS-007', 'Nikièma', 'Paul', 'p.nikiema@univ.example', 'Assistant', 20],
    ['ENS-008', 'Bationo', 'Salif', 's.bationo@univ.example', 'Maître-assistant', 18],
    ['ENS-009', 'Diallo', 'Moussa', 'm.diallo@univ.example', 'Professeur invité', 24],
  ] as const
).map(([matricule, nom, prenom, email, grade, nb_heures_max_semaine], i) => ({
  id_enseignant: i + 1, matricule, nom, prenom, email, telephone: null, grade, nb_heures_max_semaine,
  // Zongo et Bationo sont vacataires locaux ; Diallo est attendu en novembre pour le M2IA
  statut: matricule === 'ENS-009' ? 'externe' : matricule === 'ENS-005' || matricule === 'ENS-008' ? 'vacataire_local' : 'permanent',
  id_site: matricule === 'ENS-008' ? SI.ouaga : SI.kamb,
}))

// Habilitations : enseignant, matière, type de cours (CD-06)
// matières : 1 ALGO, 2 BD, 3 RES, 4 WEB, 5 SE, 6 PROBA, 7 ML, 8 ANG
const habilitation: Habilitation[] = (
  [
    [1, 1, 'CM'], [1, 5, 'CM'], [2, 1, 'TD'], [2, 1, 'TP'], [3, 3, 'TP'], [3, 3, 'CM'],
    [4, 2, 'CM'], [4, 2, 'TD'], [5, 4, 'CM'], [6, 7, 'CM'], [6, 7, 'TP'], [6, 6, 'CM'],
    [7, 3, 'TP'], [7, 8, 'CM'], [8, 3, 'TP'], [8, 6, 'TD'], [9, 7, 'CM'], [9, 7, 'TP'],
  ] as const
).map(([id_enseignant, id_matiere, type_cours], i) => ({ id_habilitation: i + 1, id_enseignant, id_matiere, type_cours }))

// Séjours des intervenants externes (CD-06)
const sejour_enseignant: SejourEnseignant[] = [
  { id_sejour: 1, id_enseignant: 9, date_debut: '2026-11-09', date_fin: '2026-11-28', commentaire: "Mission d'enseignement, M2IA" },
]

// Absences datées (CD-06)
const absence_enseignant: AbsenceEnseignant[] = [
  { id_absence: 1, id_enseignant: 5, date_debut: '2026-11-16', date_fin: '2026-11-20', motif: "Mission d'enseignement à Bobo-Dioulasso" },
]

const matiere: Matiere[] = (
  [
    ['ALGO', 'Algorithmique', 3], ['BD', 'Bases de données', 3], ['RES', 'Réseaux informatiques', 2],
    ['WEB', 'Programmation Web', 2], ['SE', "Systèmes d'exploitation", 2], ['PROBA', 'Probabilités et statistiques', 3],
    ['ML', 'Apprentissage automatique', 4], ['ANG', 'Anglais technique', 1],
  ] as const
).map(([code_matiere, libelle, coefficient], i) => ({ id_matiere: i + 1, code_matiere, libelle, coefficient }))

// Programme (maquettes) : classe, matière, CM, TD, TP. Deux écarts volontaires :
// le TD-B de L1INFO n'a pas de cours de Probabilités, le M2IA n'a aucun cours.
const programme: Programme[] = (
  [
    [1, 8, 24, 0, 0], [1, 6, 0, 24, 0],
    [2, 1, 24, 24, 0], [2, 2, 60, 0, 0], [2, 3, 0, 0, 36],
    [3, 4, 36, 0, 0], [3, 5, 36, 0, 0],
    [4, 7, 30, 0, 24],
    [5, 7, 24, 0, 24],
  ] as const
).map(([id_classe, id_matiere, volume_cm, volume_td, volume_tp], i) => ({
  id_programme: i + 1, id_classe, id_matiere, id_semestre: 1, volume_cm, volume_td, volume_tp,
}))

// matière, type, volume, durée, nb/sem, priorité, classe, groupe, enseignant, type de salle
const cours: Cours[] = (
  [
    [1, 'CM', 24, 2, 1, 2, 2, null, 1, TS.amphi],
    [1, 'TD', 24, 2, 1, 1, 2, 3, 2, TS.standard],
    [1, 'TD', 24, 2, 1, 1, 2, 4, 2, TS.standard],
    [3, 'TP', 36, 3, 1, 1, 2, 5, 3, TS.labo],
    [3, 'TP', 36, 3, 1, 1, 2, 6, 7, TS.labo],
    [3, 'TP', 36, 3, 1, 1, 2, 7, 8, TS.labo],
    [2, 'CM', 60, 2, 2, 2, 2, null, 4, TS.amphi],
    [4, 'CM', 36, 2, 2, 1, 3, null, 5, TS.standard],
    [5, 'CM', 36, 3, 1, 1, 3, null, 1, TS.standard],
    [7, 'CM', 30, 3, 1, 2, 4, null, 6, TS.standard],
    [7, 'TP', 24, 2, 1, 1, 4, 8, 6, TS.info],
    [8, 'CM', 24, 2, 1, 0, 1, null, 7, TS.amphi],
    [6, 'TD', 24, 2, 1, 1, 1, 1, 8, TS.standard],
  ] as const
).map(([id_matiere, type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite, id_classe, id_groupe, id_enseignant, id_type_salle], i) => ({
  id_cours: i + 1, type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite,
  priorite_suggeree: null, justification_priorite: null, heures_semaine_min: 2, heures_semaine_max: 15,
  id_matiere, id_classe, id_groupe, id_enseignant, id_type_salle, id_semestre: 1,
}))

const cours_seance_modele: CoursSeanceModele[] = (
  [[1, 1, 2], [2, 1, 2], [3, 1, 2], [4, 1, 3], [5, 1, 3], [6, 1, 3], [7, 1, 2], [7, 2, 3],
   [8, 1, 2], [8, 2, 2], [9, 1, 3], [10, 1, 3], [11, 1, 2], [12, 1, 2], [13, 1, 2]] as const
).map(([id_cours, rang, duree_heures]) => ({ id_cours, rang, duree_heures }))

// Disponibilités : une ligne par créneau couvert par chaque plage déclarée
const disponibilite: Disponibilite[] = (
  [
    [1, 0, 8, 10, 'indisponible', "Mission à l'extérieur"],
    [2, 2, 13, 16, 'indisponible', 'Recherche'],
    [4, 1, 8, 12, 'preference', null],
    [5, 4, 13, 16, 'indisponible', 'Réunion de département'],
    [6, 3, 8, 12, 'preference', null],
  ] as const
).flatMap(([id_enseignant, jour, de, a, niveau, motif]) =>
  HEURES.filter((h) => h >= de && h + 1 <= a).map((h) => ({ id_enseignant, id_creneau: cr(jour, h), niveau, motif })),
)

// Contraintes paramétrées pour chaque emploi du temps (poids : élevé 8, moyen 5,
// faible 2 ; valeur = paramètre). Même liste que le script SQL.
const CONTRAINTES_TYPE: Omit<Contrainte, 'id_contrainte' | 'id_edt'>[] = (
  [
    ['CD-01', 'dure', 0, null, 'Une salle accueille une seule séance à la fois'],
    ['CD-02', 'dure', 0, null, 'Un enseignant anime une seule séance à la fois'],
    ['CD-03', 'dure', 0, null, 'Une classe suit une seule séance à la fois (sauf groupes du même type)'],
    ['CD-04', 'dure', 0, null, 'Capacité de la salle ≥ effectif'],
    ['CD-05', 'dure', 0, null, 'Type de salle conforme au type exigé'],
    ['CD-06', 'dure', 0, null, 'Enseignant habilité, présent et disponible'],
    ['CD-07', 'dure', 0, null, 'Cours conforme au programme de la classe'],
    ['CD-08', 'dure', 0, null, 'Volume horaire du cours non dépassé'],
    ['CD-09', 'dure', 0, null, 'Date dans le semestre, hors jours fériés et congés'],
    ['CD-10', 'dure', 0, null, 'Séance alignée sur la grille de créneaux'],
    ['CD-11', 'dure', 0, null, 'Aucune séance pendant la pause déjeuner'],
    ['CD-12', 'dure', 0, null, 'Aucune séance dans une salle indisponible'],
    ['CD-13', 'dure', 0, 3, 'Au plus N matières différentes par classe et par semaine'],
    ['CD-14', 'dure', 0, null, 'Rythme hebdomadaire maximal de chaque cours'],
    ['CS-01', 'souple', 8, null, 'Respecter les créneaux préférés des enseignants'],
    ['CS-02', 'souple', 5, null, "Éviter les trous dans la journée d'une classe"],
    ['CS-03', 'souple', 5, null, 'Limiter les changements de bâtiment et de site'],
    ['CS-04', 'souple', 5, null, 'Ramasser les cours des externes, enchaîner ceux des permanents'],
    ['CS-05', 'souple', 2, null, 'Placer le CM avant les TD et TP de la semaine'],
    ['CS-06', 'souple', 2, 6, "Plafonner les heures par jour d'un enseignant"],
    ['CS-07', 'souple', 5, null, 'Commencer tôt les cours prioritaires'],
  ] as const
).map(([type_contrainte, nature, poids, valeur, libelle]) => ({ type_contrainte, nature, poids, valeur, libelle, est_active: true }))

const emploi_du_temps: EmploiDuTemps[] = [
  {
    id_edt: 1, libelle: 'EDT Semestre 1 2026-2027', version: 1, mode_generation: 'manuel', statut: 'publie',
    date_creation: '2026-09-28T09:00:00Z', date_publication: '2026-10-05T16:30:00Z', id_semestre: 1, id_utilisateur: 1,
  },
  {
    id_edt: 2, libelle: 'EDT Semestre 1 2026-2027', version: 2, mode_generation: 'manuel', statut: 'brouillon',
    date_creation: '2026-10-15T08:10:00Z', date_publication: null, id_semestre: 1, id_utilisateur: 1,
  },
]

const contrainte: Contrainte[] = emploi_du_temps.flatMap((e, k) =>
  CONTRAINTES_TYPE.map((c, i) => ({ ...c, id_contrainte: k * CONTRAINTES_TYPE.length + i + 1, id_edt: e.id_edt })),
)

const conversation: Conversation[] = [
  { id_conversation: 1, titre: 'Vendredi après-midi des L2', date_creation: '2026-10-16T10:12:00Z', id_utilisateur: 1, id_edt: 2 },
  { id_conversation: 2, titre: 'TP Réseaux le samedi', date_creation: '2026-10-16T10:20:00Z', id_utilisateur: 1, id_edt: 2 },
  { id_conversation: 3, titre: "Charge d'Adama Ouédraogo", date_creation: '2026-10-08T15:02:00Z', id_utilisateur: 1, id_edt: 1 },
]

const prompt: Prompt[] = [
  {
    id_prompt: 1, texte: 'Libère le vendredi après-midi pour toutes les classes de L2.',
    reponse: "Aucune séance de L2INFO n'est placée le vendredi après-midi dans la version 2 : rien à modifier.",
    statut: 'traite', date_prompt: '2026-10-16T10:12:00Z', id_utilisateur: 1, id_edt: 2, id_conversation: 1,
  },
  {
    id_prompt: 2, texte: 'Et le jeudi après-midi ?',
    reponse: "1 séance concernée : jeu. 13h–16h, Bases de données (CM), L2INFO, Amphi 120. Simulation : rien n'a été modifié.",
    statut: 'traite', date_prompt: '2026-10-16T10:14:00Z', id_utilisateur: 1, id_edt: 2, id_conversation: 1,
  },
  {
    id_prompt: 3, texte: 'Mets le TP de Réseaux du groupe TP-G1 le samedi après-midi.',
    reponse: "Impossible : le samedi ne comporte que des créneaux du matin (7 h – 12 h). Aucune séance ne peut y être placée l'après-midi (CD-10).",
    statut: 'erreur', date_prompt: '2026-10-16T10:20:00Z', id_utilisateur: 1, id_edt: 2, id_conversation: 2,
  },
  {
    id_prompt: 4, texte: 'Quelles séances a Ouédraogo le mardi ?',
    reponse: "1 séance concernée : mar. 13h–16h, Systèmes d'exploitation (CM), L3INFO, Salle 101.",
    statut: 'traite', date_prompt: '2026-10-08T15:02:00Z', id_utilisateur: 1, id_edt: 1, id_conversation: 3,
  },
]

// Semaine type placée à la main (lundi 12 octobre 2026), puis déroulée sur le semestre
const SEMAINE_TYPE: [cours: number, jour: number, debut: number, fin: number, salle: number][] = [
  [1, 0, 10, 12, 1],
  [8, 0, 8, 10, 3],
  [4, 0, 13, 16, 6],
  [5, 0, 13, 16, 7],
  [7, 1, 8, 10, 2],
  [6, 1, 13, 16, 6],
  [9, 1, 13, 16, 10],
  [2, 2, 8, 10, 3],
  [3, 2, 10, 12, 3],
  [8, 3, 8, 10, 3],
  [10, 3, 8, 11, 5],
  [7, 3, 13, 16, 2],
  [11, 4, 8, 10, 8],
  [12, 4, 10, 12, 2],
  [13, 5, 8, 10, 10],
]

function buildSeances(db: Db): Seance[] {
  const monday = semestre[0].date_debut
  const type = (id_edt: number): Seance[] =>
    SEMAINE_TYPE.map(([id_cours, jour, debut, fin, id_salle], i) => ({
      id_seance: -(i + 1),
      date_seance: addDays(monday, jour),
      heure_debut: fromMin(debut * 60),
      heure_fin: fromMin(fin * 60),
      statut: 'planifiee',
      est_verrouillee: false,
      id_cours,
      id_salle,
      id_creneau: cr(jour, debut),
      id_edt,
    }))

  const v1 = expandWeek(db, type(1), 1, monday, [], 1)
  const v2 = expandWeek(db, type(2), 2, monday, [], v1.length + 1)
  const today = todayIso()
  const all = [...v1, ...v2].map((s) => ({
    ...s,
    statut: s.date_seance < today ? ('validee' as const) : s.statut,
    // Le CM d'algorithmique est verrouillé dans le brouillon (BF-17)
    est_verrouillee: s.id_edt === 2 && s.id_cours === 1,
  }))
  // Une séance annulée pour montrer le rendu
  for (const s of all) if (s.id_cours === 12 && s.date_seance === '2026-10-23') s.statut = 'annulee'
  return all
}

export function createMockDb(): Db {
  const db: Db = {
    site, filiere, classe, groupe, matiere, enseignant, habilitation, absence_enseignant, sejour_enseignant, creneau, pause, jour_ferie, conge, type_salle, salle,
    semestre, utilisateur, programme, cours, cours_seance_modele, disponibilite, emploi_du_temps, contrainte, conversation, prompt, proposition: [],
    seance: [],
  }
  db.seance = buildSeances(db)
  return structuredClone(db)
}
