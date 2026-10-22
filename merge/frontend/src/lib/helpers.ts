import { JOURS, type Db, type Jour, type Seance, type Utilisateur } from '../types';

export function jourDuJour(date = new Date()): Jour | null {
  // getDay() : 0 = dimanche
  const index = date.getDay();
  return index === 0 ? null : JOURS[index - 1];
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function joursRestants(isoDate: string, now = new Date()): number {
  const fin = new Date(`${isoDate}T23:59:59`);
  return Math.ceil((fin.getTime() - now.getTime()) / 86_400_000);
}

/** Séances qui concernent l'utilisateur pour un jour donné de la semaine type. */
export function seancesDuJour(db: Db, user: Utilisateur, jour: Jour | null): Seance[] {
  if (!jour) return [];
  const creneaux = new Set(db.creneaux.filter((c) => c.jour === jour).map((c) => c.id));
  return db.seances
    .filter((s) => creneaux.has(s.creneauId))
    .filter((s) =>
      user.role === 'etudiant'
        ? s.groupeId === user.groupeId
        : user.enseignantId !== undefined && s.enseignantId === user.enseignantId,
    )
    .sort((a, b) => a.creneauId - b.creneauId);
}

/** Enseignants actifs qui n'ont encore rien déclaré (BF-10). */
export function retardatairesDisponibilites(db: Db) {
  const saisis = new Set(db.disponibilites.map((d) => d.enseignantId));
  return db.enseignants.filter((e) => !e.archived && !saisis.has(e.id));
}

export interface Alerte {
  niveau: 'erreur' | 'attention';
  texte: string;
  lien: string;
}

/**
 * Contrôles de cohérence du référentiel, à corriger avant toute planification
 * (risque n°1 du cahier des charges : données de départ incohérentes).
 */
export function alertesReferentiel(db: Db, departementId?: number): Alerte[] {
  const alertes: Alerte[] = [];
  const cours = db.cours.filter((c) => !c.archived && (!departementId || c.departementId === departementId));
  const salles = db.salles.filter((s) => !s.archived);
  const maxCapacite = Math.max(0, ...salles.map((s) => s.capacite));

  for (const c of cours) {
    if (!db.volumes.some((v) => v.coursId === c.id && v.heures > 0)) {
      alertes.push({ niveau: 'erreur', texte: `${c.code} n’a aucun volume horaire (BF-03).`, lien: `/referentiel/cours/${c.id}` });
    }
    if (!db.programmes.some((p) => p.coursId === c.id)) {
      alertes.push({ niveau: 'attention', texte: `${c.code} n’est rattaché à aucune filière (BF-06).`, lien: `/referentiel/cours/${c.id}` });
    }
    if (!db.habilitations.some((h) => h.coursId === c.id)) {
      alertes.push({ niveau: 'attention', texte: `Aucun enseignant habilité pour ${c.code} (CD-06).`, lien: `/referentiel/cours/${c.id}` });
    }
  }

  const filieres = new Set(
    db.filieres.filter((f) => !departementId || f.departementId === departementId).map((f) => f.id),
  );
  for (const g of db.groupes.filter((g) => !g.archived && filieres.has(g.filiereId))) {
    if (g.effectif > maxCapacite) {
      alertes.push({
        niveau: 'erreur',
        texte: `Le groupe ${g.code} (${g.effectif} étudiants) dépasse la plus grande salle (${maxCapacite} places, CD-04).`,
        lien: '/referentiel/groupes',
      });
    }
  }
  return alertes;
}
