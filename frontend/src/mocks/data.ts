import type { Campagne, Creneau, Db, Jour, Seance } from '../types';

// Données fictives de démonstration, en attendant l'API FastAPI.
// Quelques anomalies sont volontaires (cours sans volume horaire, groupe
// trop grand pour toutes les salles) pour alimenter les alertes de l'accueil.

const plages: [string, string][] = [
  ['08:00', '10:00'],
  ['10:15', '12:15'],
  ['14:00', '16:00'],
  ['16:15', '18:15'],
];

function grilleCreneaux(): Creneau[] {
  const jours: Jour[] = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
  const res: Creneau[] = [];
  let id = 1;
  for (const jour of jours) {
    for (const [debut, fin] of plages) res.push({ id: id++, jour, debut, fin });
  }
  res.push({ id: id++, jour: 'Samedi', debut: '08:00', fin: '10:00' });
  res.push({ id: id++, jour: 'Samedi', debut: '10:15', fin: '12:15' });
  return res;
}

export const campagne: Campagne = {
  semestre: 'Semestre 1 — 2027-2028',
  dateLimite: '2027-06-30',
};

export function seedDb(): Db {
  return completerPages15a28({
    departements: [
      { id: 1, code: 'GEI', libelle: 'Génie électrique, énergétique et industriel' },
      { id: 2, code: 'GCH', libelle: 'Génie civil et hydraulique' },
      { id: 3, code: 'EAE', libelle: 'Eau, assainissement et environnement' },
      { id: 4, code: 'INF', libelle: 'Informatique et intelligence artificielle' },
    ],
    filieres: [
      { id: 1, code: 'L1-ING', libelle: 'Licence ingénierie — tronc commun', niveau: 'L1', departementId: 1 },
      { id: 2, code: 'L3-GEI', libelle: 'Licence génie électrique', niveau: 'L3', departementId: 1 },
      { id: 3, code: 'M1-GCH', libelle: 'Master génie civil', niveau: 'M1', departementId: 2 },
      { id: 4, code: 'M1-EAE', libelle: 'Master eau et assainissement', niveau: 'M1', departementId: 3 },
      { id: 5, code: 'M2-IA', libelle: 'Master intelligence artificielle', niveau: 'M2', departementId: 4 },
      { id: 6, code: 'L2-INF', libelle: 'Licence informatique', niveau: 'L2', departementId: 4, archived: true },
    ],
    groupes: [
      { id: 1, code: 'L1-ING-A', effectif: 180, filiereId: 1 },
      { id: 2, code: 'L1-ING-TD1', effectif: 45, filiereId: 1 },
      { id: 3, code: 'L1-ING-TD2', effectif: 45, filiereId: 1 },
      { id: 4, code: 'L3-GEI', effectif: 52, filiereId: 2 },
      { id: 5, code: 'M1-GCH', effectif: 38, filiereId: 3 },
      { id: 6, code: 'M1-EAE', effectif: 30, filiereId: 4 },
      { id: 7, code: 'M2-IA', effectif: 24, filiereId: 5 },
    ],
    cours: [
      { id: 1, code: 'MAT101', intitule: 'Analyse mathématique', ects: 6, semestre: 'S1', departementId: 1 },
      { id: 2, code: 'PHY102', intitule: 'Physique générale', ects: 5, semestre: 'S1', departementId: 1 },
      { id: 3, code: 'ELE301', intitule: 'Électronique de puissance', ects: 5, semestre: 'S5', departementId: 1 },
      { id: 4, code: 'HYD401', intitule: 'Hydraulique urbaine', ects: 4, semestre: 'S7', departementId: 2 },
      { id: 5, code: 'BET402', intitule: 'Béton armé', ects: 5, semestre: 'S7', departementId: 2 },
      { id: 6, code: 'ASS403', intitule: 'Traitement des eaux usées', ects: 4, semestre: 'S7', departementId: 3 },
      { id: 7, code: 'IA501', intitule: 'Apprentissage profond', ects: 6, semestre: 'S9', departementId: 4 },
      { id: 8, code: 'IA502', intitule: 'Optimisation combinatoire', ects: 4, semestre: 'S9', departementId: 4 },
      { id: 9, code: 'IA503', intitule: 'Éthique et droit des données', ects: 2, semestre: 'S9', departementId: 4 },
    ],
    typesSalle: [
      { id: 1, libelle: 'Amphithéâtre' },
      { id: 2, libelle: 'Salle de TD' },
      { id: 3, libelle: 'Laboratoire' },
      { id: 4, libelle: 'Salle informatique' },
    ],
    typesSeance: [
      { id: 1, code: 'CM', libelle: 'Cours magistral', typeSalleId: 1 },
      { id: 2, code: 'TD', libelle: 'Travaux dirigés', typeSalleId: 2 },
      { id: 3, code: 'TP', libelle: 'Travaux pratiques', typeSalleId: 3 },
    ],
    volumes: [
      { id: 1, coursId: 1, typeSeanceId: 1, heures: 30 },
      { id: 2, coursId: 1, typeSeanceId: 2, heures: 30 },
      { id: 3, coursId: 2, typeSeanceId: 1, heures: 24 },
      { id: 4, coursId: 2, typeSeanceId: 2, heures: 12 },
      { id: 5, coursId: 2, typeSeanceId: 3, heures: 12 },
      { id: 6, coursId: 3, typeSeanceId: 1, heures: 20 },
      { id: 7, coursId: 3, typeSeanceId: 3, heures: 16 },
      { id: 8, coursId: 4, typeSeanceId: 1, heures: 18 },
      { id: 9, coursId: 4, typeSeanceId: 2, heures: 12 },
      { id: 10, coursId: 5, typeSeanceId: 1, heures: 24 },
      { id: 11, coursId: 6, typeSeanceId: 1, heures: 16 },
      { id: 12, coursId: 6, typeSeanceId: 3, heures: 8 },
      { id: 13, coursId: 7, typeSeanceId: 1, heures: 24 },
      { id: 14, coursId: 7, typeSeanceId: 3, heures: 24 },
      { id: 15, coursId: 8, typeSeanceId: 1, heures: 18 },
      { id: 16, coursId: 8, typeSeanceId: 2, heures: 12 },
    ],
    batiments: [
      { id: 1, code: 'A', nom: 'Bâtiment A — Amphithéâtres' },
      { id: 2, code: 'B', nom: 'Bâtiment B — Enseignement' },
      { id: 3, code: 'L', nom: 'Bâtiment L — Laboratoires' },
    ],
    salles: [
      { id: 1, code: 'A-AMPHI1', nom: 'Amphi Kamboinsé', capacite: 150, etage: 0, batimentId: 1, typeSalleId: 1 },
      { id: 2, code: 'A-AMPHI2', nom: 'Amphi Ouaga', capacite: 120, etage: 0, batimentId: 1, typeSalleId: 1 },
      { id: 3, code: 'B-101', nom: 'Salle B101', capacite: 50, etage: 1, batimentId: 2, typeSalleId: 2 },
      { id: 4, code: 'B-102', nom: 'Salle B102', capacite: 50, etage: 1, batimentId: 2, typeSalleId: 2 },
      { id: 5, code: 'B-201', nom: 'Salle B201', capacite: 40, etage: 2, batimentId: 2, typeSalleId: 2 },
      { id: 6, code: 'B-INFO1', nom: 'Salle informatique 1', capacite: 30, etage: 2, batimentId: 2, typeSalleId: 4 },
      { id: 7, code: 'L-ELEC', nom: 'Labo électrotechnique', capacite: 24, etage: 0, batimentId: 3, typeSalleId: 3 },
      { id: 8, code: 'L-HYDRO', nom: 'Labo hydraulique', capacite: 24, etage: 0, batimentId: 3, typeSalleId: 3 },
      { id: 9, code: 'L-CHIM', nom: 'Labo chimie des eaux', capacite: 20, etage: 1, batimentId: 3, typeSalleId: 3, archived: true },
    ],
    creneaux: grilleCreneaux(),
    programmes: [
      { id: 1, filiereId: 1, coursId: 1 },
      { id: 2, filiereId: 1, coursId: 2 },
      { id: 3, filiereId: 2, coursId: 3 },
      { id: 4, filiereId: 3, coursId: 4 },
      { id: 5, filiereId: 3, coursId: 5 },
      { id: 6, filiereId: 4, coursId: 4 },
      { id: 7, filiereId: 4, coursId: 6 },
      { id: 8, filiereId: 5, coursId: 7 },
      { id: 9, filiereId: 5, coursId: 8 },
      { id: 10, filiereId: 5, coursId: 9 },
    ],
    enseignants: [
      { id: 1, matricule: 'ENS-0012', nom: 'Ouédraogo', prenom: 'Aminata', grade: 'Maître de conférences', email: 'aminata.ouedraogo@2ie-edu.org', telephone: '+226 70 00 00 12', departementId: 4 },
      { id: 2, matricule: 'ENS-0027', nom: 'Sawadogo', prenom: 'Issaka', grade: 'Professeur', email: 'issaka.sawadogo@2ie-edu.org', telephone: '+226 70 00 00 27', departementId: 1 },
      { id: 3, matricule: 'ENS-0031', nom: 'Kaboré', prenom: 'Mariam', grade: 'Assistante', email: 'mariam.kabore@2ie-edu.org', telephone: '+226 70 00 00 31', departementId: 2 },
      { id: 4, matricule: 'ENS-0044', nom: 'Traoré', prenom: 'Boubacar', grade: 'Maître assistant', email: 'boubacar.traore@2ie-edu.org', telephone: '+226 70 00 00 44', departementId: 3 },
      { id: 5, matricule: 'ENS-0058', nom: 'Zongo', prenom: 'Pascal', grade: 'Vacataire', email: 'pascal.zongo@2ie-edu.org', telephone: '+226 70 00 00 58', departementId: 1 },
      { id: 6, matricule: 'ENS-0063', nom: 'Compaoré', prenom: 'Félicité', grade: 'Maître de conférences', email: 'felicite.compaore@2ie-edu.org', telephone: '+226 70 00 00 63', departementId: 4 },
    ],
    habilitations: [
      { id: 1, enseignantId: 1, coursId: 7 },
      { id: 2, enseignantId: 1, coursId: 8 },
      { id: 3, enseignantId: 2, coursId: 3 },
      { id: 4, enseignantId: 2, coursId: 2 },
      { id: 5, enseignantId: 3, coursId: 4 },
      { id: 6, enseignantId: 3, coursId: 5 },
      { id: 7, enseignantId: 4, coursId: 6 },
      { id: 8, enseignantId: 5, coursId: 1 },
      { id: 9, enseignantId: 5, coursId: 2 },
      { id: 10, enseignantId: 6, coursId: 9 },
    ],
    disponibilites: [
      { id: 1, enseignantId: 1, creneauId: 1, niveau: 'preference' },
      { id: 2, enseignantId: 1, creneauId: 2, niveau: 'preference' },
      { id: 3, enseignantId: 1, creneauId: 13, niveau: 'indisponible' },
      { id: 4, enseignantId: 1, creneauId: 14, niveau: 'indisponible' },
      { id: 5, enseignantId: 2, creneauId: 4, niveau: 'indisponible' },
      { id: 6, enseignantId: 3, creneauId: 9, niveau: 'preference' },
    ],
    seances: [
      { id: 1, coursId: 7, typeSeanceId: 1, groupeId: 7, enseignantId: 1, salleId: 2, creneauId: 1 },
      { id: 2, coursId: 8, typeSeanceId: 2, groupeId: 7, enseignantId: 1, salleId: 5, creneauId: 6 },
      { id: 3, coursId: 7, typeSeanceId: 3, groupeId: 7, enseignantId: 1, salleId: 7, creneauId: 11 },
      { id: 4, coursId: 9, typeSeanceId: 1, groupeId: 7, enseignantId: 6, salleId: 2, creneauId: 15 },
      { id: 5, coursId: 8, typeSeanceId: 1, groupeId: 7, enseignantId: 1, salleId: 2, creneauId: 17 },
      { id: 6, coursId: 1, typeSeanceId: 1, groupeId: 1, enseignantId: 5, salleId: 1, creneauId: 2 },
      { id: 7, coursId: 3, typeSeanceId: 1, groupeId: 4, enseignantId: 2, salleId: 2, creneauId: 7 },
      ...seancesComplementaires,
    ],
    utilisateurs: [
      { id: 1, login: 'admin', nom: 'Administrateur système', email: 'admin@2ie-edu.org', role: 'administrateur' },
      { id: 2, login: 'scolarite', nom: 'Service de la scolarité', email: 'scolarite@2ie-edu.org', role: 'planificateur' },
      { id: 3, login: 'chef.inf', nom: 'Félicité Compaoré', email: 'felicite.compaore@2ie-edu.org', role: 'chef_departement', departementId: 4, enseignantId: 6 },
      { id: 4, login: 'aminata.ouedraogo', nom: 'Aminata Ouédraogo', email: 'aminata.ouedraogo@2ie-edu.org', role: 'enseignant', enseignantId: 1 },
      { id: 5, login: 'etu.m2ia', nom: 'Daniel Ilboudo', email: 'daniel.ilboudo@2ie-edu.org', role: 'etudiant', groupeId: 7 },
      ...utilisateursComplementaires,
    ],
    notifications: [
      { id: 1, utilisateurId: 4, date: '2027-06-02T09:00:00', titre: 'Saisie des disponibilités ouverte', texte: 'Merci de déclarer vos disponibilités avant le 30 juin 2027.', lue: false },
      { id: 2, utilisateurId: 4, date: '2027-05-20T15:30:00', titre: 'Habilitation ajoutée', texte: 'Vous êtes habilitée pour IA502 — Optimisation combinatoire.', lue: true },
      { id: 3, utilisateurId: 5, date: '2027-06-01T08:00:00', titre: 'Emploi du temps publié', texte: 'La version 3 de l’emploi du temps M2-IA est disponible.', lue: false },
      { id: 4, utilisateurId: 2, date: '2027-06-03T11:00:00', titre: 'Import terminé', texte: 'Import des salles : 8 lignes chargées, 1 rejetée.', lue: false },
      { id: 5, utilisateurId: 3, date: '2027-06-03T10:00:00', titre: 'Volumes à valider', texte: '3 cours du département INF attendent votre validation.', lue: false },
    ],
  });
}

// ---------- Pages 15 à 28 ----------
// Les séances 1 à 7 forment la semaine type de départ ; on en ajoute quelques-unes,
// toutes conformes à CD-01…CD-09, pour remplir la grille et les consultations.

const seancesComplementaires: Seance[] = [
  { id: 8, coursId: 1, typeSeanceId: 2, groupeId: 2, enseignantId: 5, salleId: 3, creneauId: 3 },
  { id: 9, coursId: 1, typeSeanceId: 2, groupeId: 3, enseignantId: 5, salleId: 4, creneauId: 4 },
  { id: 10, coursId: 2, typeSeanceId: 2, groupeId: 2, enseignantId: 2, salleId: 3, creneauId: 5 },
  { id: 11, coursId: 4, typeSeanceId: 1, groupeId: 5, enseignantId: 3, salleId: 2, creneauId: 9 },
  { id: 12, coursId: 5, typeSeanceId: 1, groupeId: 5, enseignantId: 3, salleId: 1, creneauId: 10 },
  { id: 13, coursId: 4, typeSeanceId: 1, groupeId: 6, enseignantId: 3, salleId: 2, creneauId: 13 },
  { id: 14, coursId: 6, typeSeanceId: 1, groupeId: 6, enseignantId: 4, salleId: 1, creneauId: 14 },
];

const utilisateursComplementaires: Db['utilisateurs'] = [
  { id: 6, login: 'chef.gch', nom: 'Mariam Kaboré', email: 'mariam.kabore@2ie-edu.org', role: 'chef_departement', departementId: 2, enseignantId: 3, derniereConnexion: '2027-06-02T08:12:00' },
  { id: 7, login: 'issaka.sawadogo', nom: 'Issaka Sawadogo', email: 'issaka.sawadogo@2ie-edu.org', role: 'enseignant', enseignantId: 2, derniereConnexion: '2027-05-28T17:40:00' },
  { id: 8, login: 'etu.l1ing', nom: 'Awa Sanou', email: 'awa.sanou@2ie-edu.org', role: 'etudiant', groupeId: 2 },
];

type CollectionsPages15a28 =
  | 'annees'
  | 'semestres'
  | 'campagnes'
  | 'relances'
  | 'duplications'
  | 'generations'
  | 'validations'
  | 'versions'
  | 'signalements'
  | 'audit'
  | 'parametres'
  | 'gabarits';

function completerPages15a28(base: Omit<Db, CollectionsPages15a28>): Db {
  // Instantané de la semaine type pour les versions déjà publiées ; `deplace`
  // remet certaines séances sur leur ancien créneau pour que la comparaison montre un écart.
  const instantane = (ids: number[], deplace: Record<number, number> = {}): Seance[] =>
    base.seances
      .filter((s) => ids.includes(s.id))
      .map((s) => (deplace[s.id] ? { ...s, creneauId: deplace[s.id] } : { ...s }));

  return {
    ...base,
    seances: base.seances.map((s) => (s.id === 1 || s.id === 6 ? { ...s, verrouillee: true } : s)),
    annees: [
      { id: 1, libelle: '2025-2026', debut: '2025-09-01', fin: '2026-07-31', statut: 'cloturee' },
      { id: 2, libelle: '2026-2027', debut: '2026-09-01', fin: '2027-07-31', statut: 'ouverte' },
      { id: 3, libelle: '2027-2028', debut: '2027-09-01', fin: '2028-07-31', statut: 'ouverte' },
    ],
    semestres: [
      { id: 1, anneeId: 1, code: 'S1', debut: '2025-09-22', fin: '2026-01-23', statut: 'cloturee' },
      { id: 2, anneeId: 1, code: 'S2', debut: '2026-02-09', fin: '2026-06-19', statut: 'cloturee' },
      { id: 3, anneeId: 2, code: 'S1', debut: '2026-09-21', fin: '2027-01-22', statut: 'cloturee' },
      { id: 4, anneeId: 2, code: 'S2', debut: '2027-02-08', fin: '2027-06-18', statut: 'ouverte' },
      { id: 5, anneeId: 3, code: 'S1', debut: '2027-09-20', fin: '2028-01-21', statut: 'ouverte' },
      { id: 6, anneeId: 3, code: 'S2', debut: '2028-02-07', fin: '2028-06-16', statut: 'a_venir' },
    ],
    campagnes: [{ id: 1, semestreId: 5, dateLimite: campagne.dateLimite, relanceAuto: true, joursRelance: [14, 7, 1] }],
    relances: [{ id: 1, campagneId: 1, date: '2027-06-16T09:00:00', auto: true, enseignantIds: [4, 5, 6] }],
    duplications: [
      { id: 1, semestreId: 5, date: '2027-06-01T10:00:00', auteurId: 2, semainesExclues: ['2027-12-20', '2027-12-27', '2028-01-17'], occurrences: 98 },
    ],
    generations: [],
    validations: [
      { id: 1, departementId: 1, semestreId: 5, statut: 'validee', date: '2027-06-02T11:00:00', utilisateurId: 1, commentaire: 'Validé en conseil de département.' },
      { id: 2, departementId: 2, semestreId: 5, statut: 'validee', date: '2027-06-02T15:20:00', utilisateurId: 6, commentaire: '' },
      { id: 3, departementId: 3, semestreId: 5, statut: 'corrections', date: '2027-06-03T09:05:00', utilisateurId: 1, commentaire: 'Le TP de ASS403 n’est pas planifié : aucun laboratoire de 30 places.' },
      { id: 4, departementId: 4, semestreId: 5, statut: 'en_attente', commentaire: '' },
    ],
    versions: [
      { id: 1, semestreId: 5, numero: 1, statut: 'archivee', date: '2027-05-10T16:00:00', auteurId: 2, commentaire: 'Première version : CM du tronc commun.', seances: instantane([1, 6]) },
      { id: 2, semestreId: 5, numero: 2, statut: 'archivee', date: '2027-05-24T16:00:00', auteurId: 2, commentaire: 'Ajout des cours de M2-IA et L3-GEI.', seances: instantane([1, 2, 3, 6, 7], { 2: 5 }) },
      { id: 3, semestreId: 5, numero: 3, statut: 'publiee', date: '2027-06-01T08:00:00', auteurId: 2, commentaire: 'Séances M2-IA complètes.', seances: instantane([1, 2, 3, 4, 5, 6, 7], { 2: 5 }) },
    ],
    signalements: [
      { id: 1, seanceId: 3, utilisateurId: 4, date: '2027-06-02T18:30:00', motif: 'Salle inadaptée', texte: 'Le labo électrotechnique n’a pas les postes GPU nécessaires au TP d’apprentissage profond.', statut: 'ouvert' },
    ],
    audit: [
      { id: 1, date: '2027-05-10T15:58:00', utilisateurId: 2, action: 'creation', entite: 'seances', entiteId: 1, resume: 'IA501 CM · M2-IA · Lundi 08:00 · A-AMPHI2' },
      { id: 2, date: '2027-05-10T15:59:00', utilisateurId: 2, action: 'creation', entite: 'seances', entiteId: 6, resume: 'MAT101 CM · L1-ING-A · Lundi 10:15 · A-AMPHI1' },
      { id: 3, date: '2027-05-10T16:00:00', utilisateurId: 2, action: 'creation', entite: 'versions', entiteId: 1, resume: 'Version 1 publiée' },
      { id: 4, date: '2027-05-24T14:10:00', utilisateurId: 2, action: 'creation', entite: 'seances', entiteId: 2, resume: 'IA502 TD · M2-IA · Mardi 08:00 · B-201' },
      { id: 5, date: '2027-05-31T09:42:00', utilisateurId: 2, action: 'modification', entite: 'seances', entiteId: 2, resume: 'IA502 TD · M2-IA : créneau Mardi 08:00 → Mardi 10:15' },
      { id: 6, date: '2027-06-01T08:00:00', utilisateurId: 2, action: 'creation', entite: 'versions', entiteId: 3, resume: 'Version 3 publiée' },
      { id: 7, date: '2027-06-01T10:00:00', utilisateurId: 2, action: 'creation', entite: 'duplications', entiteId: 1, resume: 'Semaine type dupliquée sur S1 2027-2028' },
      { id: 8, date: '2027-06-02T08:15:00', utilisateurId: 1, action: 'modification', entite: 'utilisateurs', entiteId: 6, resume: 'chef.gch : rôle Chef de département (GCH)' },
      { id: 9, date: '2027-06-02T15:20:00', utilisateurId: 6, action: 'modification', entite: 'validations', entiteId: 2, resume: 'GCH : validée' },
      { id: 10, date: '2027-06-03T09:05:00', utilisateurId: 1, action: 'modification', entite: 'validations', entiteId: 3, resume: 'EAE : corrections demandées' },
      { id: 11, date: '2027-06-03T11:02:00', utilisateurId: 2, action: 'suppression', entite: 'seances', entiteId: 15, resume: 'ASS403 TP · M1-EAE · Mercredi 14:00 · L-CHIM' },
    ],
    parametres: [
      { id: 1, semestreActifId: 5, heuresMaxJour: 6, poidsDefaut: { 'CS-01': 8, 'CS-02': 5, 'CS-03': 5, 'CS-04': 5, 'CS-05': 2, 'CS-06': 2 } },
    ],
    gabarits: [
      {
        id: 1,
        code: 'publication',
        libelle: 'Emploi du temps publié (BF-20)',
        sujet: '[2iE] Emploi du temps {semestre} : version {version}',
        corps:
          'Bonjour {nom},\n\nLa version {version} de l’emploi du temps {semestre} vient d’être publiée. Elle modifie {changements} séance(s) qui vous concernent.\n\nConsultez-la sur https://planning.2ie-edu.org.\n\nLe service de la scolarité',
      },
      {
        id: 2,
        code: 'relance',
        libelle: 'Relance des disponibilités (BF-10)',
        sujet: '[2iE] Rappel : vos disponibilités avant le {date_limite}',
        corps:
          'Bonjour {nom},\n\nVous n’avez pas encore déclaré vos disponibilités pour le {semestre}. Merci de le faire avant le {date_limite}. Sans réponse, tous vos créneaux seront considérés comme disponibles.\n\nLe service de la scolarité',
      },
      {
        id: 3,
        code: 'signalement',
        libelle: 'Accusé de réception d’un signalement',
        sujet: '[2iE] Signalement reçu : {seance}',
        corps: 'Bonjour {nom},\n\nVotre signalement sur la séance {seance} a bien été transmis à la scolarité.\n\nLe service de la scolarité',
      },
    ],
  };
}
