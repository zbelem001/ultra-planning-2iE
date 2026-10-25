// Jointures utilisées par les vues (l'équivalent des SELECT ... JOIN de l'API).

import type { Classe, Cours, Db, Enseignant, Groupe, Matiere, Salle, Seance, Site, TypeSalle } from '@/types/db'
import { hours } from './time'

export interface SeanceVue extends Seance {
  cours: Cours
  matiere: Matiere
  enseignant: Enseignant
  salle: Salle
  site: Site | undefined
  type_salle: TypeSalle | undefined
  classe: Classe
  groupe: Groupe | null
  duree: number
}

export type Ressource = 'classe' | 'enseignant' | 'salle' | 'matiere'

export function index<T, K extends keyof T>(rows: T[], key: K): Map<T[K], T> {
  return new Map(rows.map((r) => [r[key], r]))
}

export function enrichir(db: Db, seances: Seance[]): SeanceVue[] {
  const cours = index(db.cours, 'id_cours')
  const mat = index(db.matiere, 'id_matiere')
  const ens = index(db.enseignant, 'id_enseignant')
  const sal = index(db.salle, 'id_salle')
  const ts = index(db.type_salle, 'id_type_salle')
  const sites = index(db.site, 'id_site')
  const cla = index(db.classe, 'id_classe')
  const grp = index(db.groupe, 'id_groupe')
  return seances.map((s) => {
    const c = cours.get(s.id_cours)!
    const salle = sal.get(s.id_salle)!
    return {
      ...s,
      cours: c,
      matiere: mat.get(c.id_matiere)!,
      enseignant: ens.get(c.id_enseignant)!,
      salle,
      site: sites.get(salle.id_site),
      type_salle: ts.get(salle.id_type_salle),
      classe: cla.get(c.id_classe)!,
      groupe: c.id_groupe !== null ? grp.get(c.id_groupe) ?? null : null,
      duree: hours(s.heure_debut, s.heure_fin),
    }
  })
}

/**
 * Séances d'une ressource. Pour une classe, `id_groupe` restreint aux séances
 * de classe entière et à celles du groupe choisi (même logique que CD-03).
 */
export function filtrer(list: SeanceVue[], res: Ressource, id: number, id_groupe?: number | null): SeanceVue[] {
  switch (res) {
    case 'classe':
      return list.filter(
        (s) => s.classe.id_classe === id && (id_groupe == null || s.cours.id_groupe === null || s.cours.id_groupe === id_groupe),
      )
    case 'enseignant':
      return list.filter((s) => s.enseignant.id_enseignant === id)
    case 'salle':
      return list.filter((s) => s.salle.id_salle === id)
    case 'matiere':
      return list.filter((s) => s.matiere.id_matiere === id)
  }
}

export const nomEnseignant = (e: Enseignant) => `${e.prenom} ${e.nom}`

/** « Campus de Kamboinsé · Bloc A » */
export function lieuSalle(db: Db, s: Salle): string {
  const site = db.site.find((x) => x.id_site === s.id_site)
  return [site?.nom_site, s.batiment].filter(Boolean).join(' · ')
}

export const publicCours = (classe: Classe, groupe: Groupe | null) =>
  groupe ? `${classe.code_classe} · ${groupe.code_groupe}` : classe.code_classe

/** Couleur par matière : palette « intervenants » de DESIGN.md */
const PALETTE = ['#6366F1', '#14B8A6', '#A855F7', '#0EA5E9', '#EC4899', '#84CC16', '#78716C', '#0891B2']
export const couleurMatiere = (id_matiere: number) => PALETTE[(id_matiere - 1) % PALETTE.length]

/** Heures planifiées (hors annulées) d'un cours dans un emploi du temps */
export function heuresPlanifiees(db: Db, id_edt: number, id_cours: number, jusqua?: string): number {
  return db.seance
    .filter((s) => s.id_edt === id_edt && s.id_cours === id_cours && s.statut !== 'annulee' && (!jusqua || s.date_seance <= jusqua))
    .reduce((a, s) => a + hours(s.heure_debut, s.heure_fin), 0)
}

export function libelleCours(db: Db, c: Cours): string {
  const m = db.matiere.find((x) => x.id_matiere === c.id_matiere)!
  const cl = db.classe.find((x) => x.id_classe === c.id_classe)!
  const g = c.id_groupe !== null ? db.groupe.find((x) => x.id_groupe === c.id_groupe) ?? null : null
  return `${m.libelle} · ${c.type_cours} · ${publicCours(cl, g)}`
}
