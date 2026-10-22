import type { Db, GabaritEmail, Notification, Role } from '../types';

// Droits des pages 15 à 28 (cahier des charges §2, BNF-07), en complément de
// ceux d'AuthContext pour les pages 1 à 14.

const TOUS: Role[] = ['administrateur', 'planificateur', 'chef_departement', 'enseignant', 'etudiant'];

/** Scolarité et administrateur : planification, génération, publication, administration. */
export const PLANIFICATION_ROLES: Role[] = ['administrateur', 'planificateur'];
/** Page 20 : le chef valide son département ; la scolarité suit l'avancement. */
export const VALIDATION_ROLES: Role[] = ['administrateur', 'planificateur', 'chef_departement'];
/** Page 24 : le chef ne voit que son département. */
export const TABLEAUX_ROLES: Role[] = ['administrateur', 'planificateur', 'chef_departement'];
/** Pages 22 et 23 : chacun consulte, dans la limite de son périmètre. */
export const CONSULTATION_ROLES: Role[] = TOUS;
/** Rôles dont l'accueil par défaut est leur propre emploi du temps. */
export const ACCUEIL_EDT: Role[] = ['enseignant', 'etudiant'];

/** Remplace les {variables} d'un gabarit d'e-mail. */
export function remplir(texte: string, valeurs: Record<string, string | number>): string {
  return texte.replace(/\{(\w+)\}/g, (m, cle: string) => (cle in valeurs ? String(valeurs[cle]) : m));
}

export function gabarit(db: Db, code: string): GabaritEmail | undefined {
  return db.gabarits.find((g) => g.code === code);
}

/**
 * Notification dans l'application ; l'e-mail correspondant (BF-20) sera envoyé
 * par le module Notifications de l'API à partir du même gabarit.
 */
export function notification(utilisateurId: number, titre: string, texte: string): Omit<Notification, 'id'> {
  return { utilisateurId, date: new Date().toISOString(), titre, texte, lue: false };
}

/** Comptes à prévenir pour un enseignant ou un groupe. */
export function comptesConcernes(db: Db, enseignantIds: number[], groupeIds: number[]): number[] {
  const ens = new Set(enseignantIds);
  const grp = new Set(groupeIds);
  return db.utilisateurs
    .filter((u) => !u.archived && ((u.enseignantId !== undefined && ens.has(u.enseignantId)) || (u.groupeId !== undefined && grp.has(u.groupeId))))
    .map((u) => u.id);
}
