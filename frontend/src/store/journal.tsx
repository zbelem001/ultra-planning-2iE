import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { decrireSeance } from '../lib/planning';
import type { ActionAudit, Collection, Db, EntreeAudit, Seance } from '../types';
import { useData } from './DataContext';

// Journal d'audit (BF-25, BNF-08). Plutôt que d'appeler un « log » dans chaque
// page, un observateur compare le store avant/après chaque modification et
// inscrit qui a créé, modifié ou supprimé quoi. Il couvre donc aussi les pages
// du référentiel sans les modifier. Côté serveur, ce sera un déclencheur PostgreSQL.

const SUIVIES: Collection[] = [
  'seances',
  'departements',
  'filieres',
  'groupes',
  'cours',
  'volumes',
  'typesSalle',
  'typesSeance',
  'batiments',
  'salles',
  'creneaux',
  'programmes',
  'enseignants',
  'habilitations',
  'disponibilites',
  'utilisateurs',
  'annees',
  'semestres',
  'campagnes',
  'relances',
  'duplications',
  'validations',
  'versions',
  'signalements',
  'parametres',
  'gabarits',
];

/** Au-delà, les changements d'une collection (hors séances) sont résumés en une ligne. */
const SEUIL_RESUME = 5;

type Ligne = { id: number } & Record<string, unknown>;

function libelle(db: Db, collection: Collection, item: Ligne): string {
  if (collection === 'seances') return decrireSeance(db, item as unknown as Seance);
  if (collection === 'versions') return `Version ${item.numero}`;
  const texte = item.code ?? item.login ?? item.libelle ?? item.nom;
  return typeof texte === 'string' ? texte : `n° ${item.id}`;
}

function detailSeance(db: Db, avant: Seance, apres: Seance): string {
  const morceaux: string[] = [];
  if (avant.creneauId !== apres.creneauId) {
    const c = (id: number) => db.creneaux.find((x) => x.id === id);
    morceaux.push(`créneau ${c(avant.creneauId)?.jour} ${c(avant.creneauId)?.debut} → ${c(apres.creneauId)?.jour} ${c(apres.creneauId)?.debut}`);
  }
  if (avant.salleId !== apres.salleId) {
    const s = (id: number) => db.salles.find((x) => x.id === id)?.code;
    morceaux.push(`salle ${s(avant.salleId)} → ${s(apres.salleId)}`);
  }
  if (avant.enseignantId !== apres.enseignantId) morceaux.push('enseignant changé');
  if (!!avant.verrouillee !== !!apres.verrouillee) morceaux.push(apres.verrouillee ? 'verrouillée' : 'déverrouillée');
  return morceaux.join(', ');
}

export function diffAudit(avant: Db, apres: Db, utilisateurId: number, date: string): Omit<EntreeAudit, 'id'>[] {
  const res: Omit<EntreeAudit, 'id'>[] = [];
  for (const collection of SUIVIES) {
    const a = avant[collection] as unknown as Ligne[];
    const b = apres[collection] as unknown as Ligne[];
    if (a === b) continue;
    const ancien = new Map(a.map((x) => [x.id, x]));
    const nouveau = new Map(b.map((x) => [x.id, x]));
    const lignes: Omit<EntreeAudit, 'id'>[] = [];
    const ajouter = (action: ActionAudit, item: Ligne, resume: string) =>
      lignes.push({ date, utilisateurId, action, entite: collection, entiteId: item.id, resume });

    for (const item of b) {
      const old = ancien.get(item.id);
      if (!old) ajouter('creation', item, libelle(apres, collection, item));
      else if (old !== item && JSON.stringify(old) !== JSON.stringify(item)) {
        let detail: string;
        if (collection === 'seances') detail = detailSeance(apres, old as unknown as Seance, item as unknown as Seance);
        else if (old.archived !== item.archived) detail = item.archived ? 'archivé' : 'restauré';
        else detail = `champs : ${Object.keys(item).filter((k) => JSON.stringify(item[k]) !== JSON.stringify(old[k])).join(', ')}`;
        ajouter('modification', item, `${libelle(apres, collection, item)}${detail ? ` : ${detail}` : ''}`);
      }
    }
    for (const item of a) if (!nouveau.has(item.id)) ajouter('suppression', item, libelle(avant, collection, item));

    if (collection !== 'seances' && lignes.length > SEUIL_RESUME) {
      const parAction = new Map<ActionAudit, number>();
      for (const l of lignes) parAction.set(l.action, (parAction.get(l.action) ?? 0) + 1);
      for (const [action, n] of parAction) {
        res.push({ date, utilisateurId, action, entite: collection, entiteId: 0, resume: `${n} ligne(s) en une seule opération` });
      }
    } else res.push(...lignes);
  }
  return res;
}

/** À monter une fois sous la session : inscrit chaque changement du store. */
export function AuditWatcher() {
  const { db, insertMany } = useData();
  const { user } = useAuth();
  const precedent = useRef(db);

  useEffect(() => {
    const avant = precedent.current;
    precedent.current = db;
    if (avant === db || !user) return;
    // Réinitialisation des données de démonstration : on repart sans journaliser
    if (db.audit.length < avant.audit.length) return;
    const lignes = diffAudit(avant, db, user.id, new Date().toISOString());
    if (lignes.length) insertMany('audit', lignes);
  }, [db, user, insertMany]);

  return null;
}
