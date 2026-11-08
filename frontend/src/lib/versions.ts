// Version à jour et version publiée d'un semestre : ce qu'il reste à publier, et la publication en
// mode simulé (en mode connecté, c'est l'API qui publie). Même comparaison que publication.py.

import type { CoursPublic, Db, EmploiDuTemps, Seance } from '@/types/db'
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
  /** Mutualisations ajoutées ou retirées depuis la dernière publication (comptées dans le total) */
  mutualisations: number
}

const clePublic = (p: { id_cours: number; id_classe: number; id_groupe: number | null }) => `${p.id_cours}|${p.id_classe}|${p.id_groupe ?? 0}`

/** Mutualisations publiées d'une copie ; null si la base ne les publie pas encore (avant la version 15) */
function publieesDe(db: Db, id_copie: number | undefined): CoursPublic[] | null {
  if (db.cours_public_publie === null) return null
  return (db.cours_public_publie ?? []).filter((p) => p.id_edt === id_copie)
    .map((p) => ({ id_cours_public: p.id_cours_public_publie, id_cours: p.id_cours, id_classe: p.id_classe, id_groupe: p.id_groupe }))
}

/** Ce que voient les invités : les mutualisations de la version publiée, pas celles en cours de travail.
 *  Une image d'invité les a déjà (l'API les y met) ; une image de la console les remplace par la copie publiée. */
export function vueInvites(db: Db): Db {
  if (!Array.isArray(db.cours_public_publie)) return db
  const enLigne = new Set(db.emploi_du_temps.filter((e) => e.statut === 'publie').map((e) => e.id_edt))
  return {
    ...db,
    cours_public: db.cours_public_publie.filter((p) => enLigne.has(p.id_edt))
      .map((p) => ({ id_cours_public: p.id_cours_public_publie, id_cours: p.id_cours, id_classe: p.id_classe, id_groupe: p.id_groupe })),
  }
}

// Clé de comparaison de chaque séance, gardée tant que la séance reste le même objet (lib/store.tsx)
const cles = new WeakMap<Seance, string>()

/** Ce qui changera pour les invités si on publie maintenant */
export function aPublier(db: Db, travail: EmploiDuTemps): APublier {
  const copie = copiePubliee(db, travail.id_semestre)
  const cle = (s: Seance) => {
    let k = cles.get(s)
    if (k === undefined) cles.set(s, (k = [...VISIBLE.map((c) => s[c]), s.nature ?? 'cours'].join('|')))
    return k
  }
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

  // Mutualisations des cours du semestre : celles de travail contre celles de la copie publiée
  const publiees = publieesDe(db, copie?.id_edt)
  let mutualisations = 0
  if (publiees) {
    const duSemestre = new Set(db.cours.filter((c) => c.id_semestre === travail.id_semestre).map((c) => c.id_cours))
    const travailCles = new Set(db.cours_public.filter((p) => duSemestre.has(p.id_cours)).map(clePublic))
    const publieesCles = new Set(publiees.map(clePublic))
    mutualisations = [...travailCles].filter((k) => !publieesCles.has(k)).length + [...publieesCles].filter((k) => !travailCles.has(k)).length
  }
  return {
    ajoutees: ajoutees.length,
    retirees: retirees.length,
    modifiees: modifiees.length - annulees,
    annulees,
    total: ajoutees.length + retirees.length + modifiees.length + mutualisations,
    enseignants: concernes.size,
    sansAdresse: [...concernes].filter((id) => !db.enseignant.find((e) => e.id_enseignant === id)?.email).length,
    horsLigne: !!copie && copie.statut !== 'publie',
    mutualisations,
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
  // les mutualisations du semestre passent dans la copie publiée
  const duSemestre = new Set(x.cours.filter((c) => c.id_semestre === travail.id_semestre).map((c) => c.id_cours))
  let idp = Math.max(0, ...(x.cours_public_publie ?? []).map((p) => p.id_cours_public_publie)) + 1
  x.cours_public_publie = [
    ...(x.cours_public_publie ?? []).filter((p) => p.id_edt !== id_edt),
    ...x.cours_public.filter((p) => duSemestre.has(p.id_cours))
      .map((p) => ({ id_cours_public_publie: idp++, id_edt, id_cours: p.id_cours, id_classe: p.id_classe, id_groupe: p.id_groupe })),
  ]
  for (const v of x.emploi_du_temps) if (v.statut === 'publie') v.statut = 'archive'
  copie.statut = 'publie'
  copie.date_publication = new Date().toISOString()
}
