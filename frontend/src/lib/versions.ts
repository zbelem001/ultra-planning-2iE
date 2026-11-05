// Version à jour et version publiée d'un semestre : ce qu'il reste à publier, et la publication en
// mode simulé (en mode connecté, c'est l'API qui publie). Même comparaison que publication.py.

import type { Db, EmploiDuTemps, Seance } from '@/types/db'
import { estEpreuve } from './publics'
import { nextId } from './store'

// Ce que voient les invités : le verrouillage, propre au travail de planification, n'en fait pas partie
const VISIBLE = ['id_cours', 'date_seance', 'heure_debut', 'heure_fin', 'statut', 'id_enseignant', 'id_salle'] as const
const ENDROIT = ['date_seance', 'heure_debut', 'heure_fin', 'id_salle'] as const

/** Copie publiée du semestre : la version publiée, sinon la dernière qui l'a été */
export function copiePubliee(db: Db, id_semestre: number): EmploiDuTemps | undefined {
  const copies = db.emploi_du_temps.filter((e) => e.id_semestre === id_semestre && (e.statut === 'publie' || e.statut === 'archive'))
  return copies.sort((a, b) => Number(b.statut === 'publie') - Number(a.statut === 'publie') || b.version - a.version)[0]
}

export interface APublier {
  ajoutees: number
  retirees: number
  /** Dont les annulations, comptées à part */
  modifiees: number
  annulees: number
  total: number
  /** Enseignants concernés par un changement (les seuls prévenus) */
  enseignants: number
  sansAdresse: number
  /** La copie publiée n'est plus en ligne (un autre semestre a été publié depuis) : publier la remet */
  horsLigne: boolean
}

/** Ce qui changera pour les invités si on publie maintenant */
export function aPublier(db: Db, travail: EmploiDuTemps): APublier {
  const copie = copiePubliee(db, travail.id_semestre)
  const cle = (s: Seance) => [...VISIBLE.map((k) => s[k]), s.nature ?? 'cours'].join('|')
  const restantes = new Map<string, Seance[]>()
  for (const s of db.seance) {
    if (s.id_edt === copie?.id_edt) restantes.set(cle(s), [...(restantes.get(cle(s)) ?? []), s])
  }
  let ajoutees: Seance[] = []
  for (const s of db.seance) {
    if (s.id_edt !== travail.id_edt) continue
    const pareilles = restantes.get(cle(s))
    if (pareilles?.length) pareilles.pop()
    else ajoutees.push(s)
  }
  let retirees = [...restantes.values()].flat()

  // Une séance retirée et une séance ajoutée du même cours sont une même séance modifiée
  const modifiees: [Seance, Seance][] = []
  for (const parCreneau of [true, false]) {
    for (const b of ajoutees) {
      const a = retirees.find((x) => x.id_cours === b.id_cours && (x.nature ?? 'cours') === (b.nature ?? 'cours') && (!parCreneau || (x.date_seance === b.date_seance && x.heure_debut === b.heure_debut)))
      if (!a) continue
      modifiees.push([a, b])
      retirees = retirees.filter((x) => x !== a)
      ajoutees = ajoutees.filter((x) => x !== b)
    }
  }

  const annulee = (s: Seance) => s.statut === 'annulee'
  const concernes = new Set<number | null>()
  for (const s of [...ajoutees, ...retirees]) if (!annulee(s) && !estEpreuve(s)) concernes.add(s.id_enseignant)
  for (const [a, b] of modifiees) {
    if (a.id_enseignant !== b.id_enseignant) {
      if (!annulee(a)) concernes.add(a.id_enseignant)
      if (!annulee(b)) concernes.add(b.id_enseignant)
    } else if (annulee(a) !== annulee(b) || (!annulee(b) && ENDROIT.some((k) => a[k] !== b[k]))) {
      concernes.add(b.id_enseignant)
    }
  }
  concernes.delete(null)
  const annulees = modifiees.filter(([a, b]) => annulee(b) && !annulee(a)).length
  return {
    ajoutees: ajoutees.length,
    retirees: retirees.length,
    modifiees: modifiees.length - annulees,
    annulees,
    total: ajoutees.length + retirees.length + modifiees.length,
    enseignants: concernes.size,
    sansAdresse: [...concernes].filter((id) => !db.enseignant.find((e) => e.id_enseignant === id)?.email).length,
    horsLigne: !!copie && copie.statut !== 'publie',
  }
}

/** Mode simulé : la copie publiée reçoit les séances de la version à jour, dans le navigateur */
export function publierLocal(x: Db, travail: EmploiDuTemps) {
  let copie = copiePubliee(x, travail.id_semestre)
  if (!copie) {
    copie = {
      ...travail,
      id_edt: nextId(x.emploi_du_temps, 'id_edt'),
      version: Math.max(...x.emploi_du_temps.filter((e) => e.id_semestre === travail.id_semestre).map((e) => e.version)) + 1,
    }
    x.emploi_du_temps.push(copie)
  }
  const id_edt = copie.id_edt
  let id = nextId(x.seance, 'id_seance')
  const copiees = x.seance.filter((s) => s.id_edt === travail.id_edt).map((s) => ({ ...s, id_seance: id++, id_edt, est_verrouillee: false }))
  x.seance = [...x.seance.filter((s) => s.id_edt !== id_edt), ...copiees]
  for (const v of x.emploi_du_temps) if (v.statut === 'publie') v.statut = 'archive'
  copie.statut = 'publie'
  copie.date_publication = new Date().toISOString()
}
