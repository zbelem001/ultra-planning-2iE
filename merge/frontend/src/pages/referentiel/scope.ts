import type { Db, Utilisateur } from '../../types';

/** Un chef de département ne voit que son département (BNF-07). */
export function departementScope(user: Utilisateur): number | undefined {
  return user.role === 'chef_departement' ? user.departementId : undefined;
}

export function departementOptions(db: Db) {
  return db.departements
    .filter((d) => !d.archived)
    .map((d) => ({ value: d.id, label: `${d.code} — ${d.libelle}` }));
}
