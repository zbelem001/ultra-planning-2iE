// Publics d'un cours et étudiants communs : même règle que les fonctions publics_du_cours et
// publics_en_conflit de la base (schema_supabase.sql, version 11).
//
// Un cours a un public principal (classe, groupe éventuel) et, s'il est mutualisé, des publics
// en plus (COURS_PUBLIC). Chaque classe est un arbre de groupes : TD ou options, puis demi-groupes
// de TP ou sous-options. Deux frères du même type (TD1 et TD2, deux options) sont disjoints.

import type { Cours, Db, Groupe, NatureSeance } from '@/types/db'

export interface Public {
  id_classe: number
  id_groupe: number | null
}

export function publicsDuCours(db: Db, c: Cours): Public[] {
  return [
    { id_classe: c.id_classe, id_groupe: c.id_groupe },
    ...db.cours_public.filter((p) => p.id_cours === c.id_cours).map((p) => ({ id_classe: p.id_classe, id_groupe: p.id_groupe })),
  ]
}

export const LIBELLE_NATURE: Record<NatureSeance, string> = { cours: 'Cours', examen: 'Examen', rattrapage: 'Rattrapage' }

/** Examen ou rattrapage : 2 à 3 h, sans enseignant, hors volumes du cours */
export const estEpreuve = (s: { nature?: NatureSeance }) => !!s.nature && s.nature !== 'cours'

/** Publics d'une séance : ceux de son cours ; une épreuve concerne toute la classe */
export function publicsSeance(db: Db, c: Cours, s: { nature?: NatureSeance }): Public[] {
  const publics = publicsDuCours(db, c)
  if (!estEpreuve(s)) return publics
  return [...new Set(publics.map((p) => p.id_classe))].map((id_classe) => ({ id_classe, id_groupe: null }))
}

/** Le groupe et ses parents, depuis la racine de l'arbre */
export function chaineGroupe(groupes: Groupe[], id_groupe: number): number[] {
  const out: number[] = []
  let g: number | null | undefined = id_groupe
  while (g != null && !out.includes(g)) {
    out.unshift(g)
    g = groupes.find((x) => x.id_groupe === g)?.id_groupe_parent
  }
  return out
}

/** Deux publics ont-ils des étudiants communs ? */
export function publicsEnConflit(groupes: Groupe[], a: Public, b: Public): boolean {
  if (a.id_classe !== b.id_classe) return false
  if (a.id_groupe === null || b.id_groupe === null || a.id_groupe === b.id_groupe) return true
  const ca = chaineGroupe(groupes, a.id_groupe)
  const cb = chaineGroupe(groupes, b.id_groupe)
  let i = 0
  while (i < Math.min(ca.length, cb.length) && ca[i] === cb[i]) i++
  if (i === ca.length || i === cb.length) return true // l'un contient l'autre
  const type = (id: number) => groupes.find((g) => g.id_groupe === id)?.type_groupe
  return type(ca[i]) !== type(cb[i]) // découpages croisés (ex. TD et TP sans parent)
}

/** Deux cours ont-ils des étudiants communs (CD-03) ? */
export function coursEnConflit(db: Db, a: Cours, b: Cours): boolean {
  const pa = publicsDuCours(db, a)
  const pb = publicsDuCours(db, b)
  return pa.some((x) => pb.some((y) => publicsEnConflit(db.groupe, x, y)))
}

/** Effectif d'une liste de publics */
export function effectifPublics(db: Db, publics: Public[]): number {
  return publics.reduce((n, p) => {
    const g = p.id_groupe !== null ? db.groupe.find((x) => x.id_groupe === p.id_groupe) : undefined
    return n + (g ? g.effectif : db.classe.find((x) => x.id_classe === p.id_classe)?.effectif ?? 0)
  }, 0)
}

/** Effectif de tous les publics du cours (CD-04) */
export function effectifDuCours(db: Db, c: Cours): number {
  return publicsDuCours(db, c).reduce((n, p) => {
    const g = p.id_groupe !== null ? db.groupe.find((x) => x.id_groupe === p.id_groupe) : undefined
    return n + (g ? g.effectif : db.classe.find((x) => x.id_classe === p.id_classe)?.effectif ?? 0)
  }, 0)
}
