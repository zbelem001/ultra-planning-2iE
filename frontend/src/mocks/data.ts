import type { Campagne, Creneau, Db, Jour } from '../types';

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
  return {
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
    ],
    utilisateurs: [
      { id: 1, login: 'admin', nom: 'Administrateur système', email: 'admin@2ie-edu.org', role: 'administrateur' },
      { id: 2, login: 'scolarite', nom: 'Service de la scolarité', email: 'scolarite@2ie-edu.org', role: 'planificateur' },
      { id: 3, login: 'chef.inf', nom: 'Félicité Compaoré', email: 'felicite.compaore@2ie-edu.org', role: 'chef_departement', departementId: 4, enseignantId: 6 },
      { id: 4, login: 'aminata.ouedraogo', nom: 'Aminata Ouédraogo', email: 'aminata.ouedraogo@2ie-edu.org', role: 'enseignant', enseignantId: 1 },
      { id: 5, login: 'etu.m2ia', nom: 'Daniel Ilboudo', email: 'daniel.ilboudo@2ie-edu.org', role: 'etudiant', groupeId: 7 },
    ],
    notifications: [
      { id: 1, utilisateurId: 4, date: '2027-06-02T09:00:00', titre: 'Saisie des disponibilités ouverte', texte: 'Merci de déclarer vos disponibilités avant le 30 juin 2027.', lue: false },
      { id: 2, utilisateurId: 4, date: '2027-05-20T15:30:00', titre: 'Habilitation ajoutée', texte: 'Vous êtes habilitée pour IA502 — Optimisation combinatoire.', lue: true },
      { id: 3, utilisateurId: 5, date: '2027-06-01T08:00:00', titre: 'Emploi du temps publié', texte: 'La version 3 de l’emploi du temps M2-IA est disponible.', lue: false },
      { id: 4, utilisateurId: 2, date: '2027-06-03T11:00:00', titre: 'Import terminé', texte: 'Import des salles : 8 lignes chargées, 1 rejetée.', lue: false },
      { id: 5, utilisateurId: 3, date: '2027-06-03T10:00:00', titre: 'Volumes à valider', texte: '3 cours du département INF attendent votre validation.', lue: false },
    ],
  };
}
