// Générateur de démonstration (BF-15 à BF-18).
// Placement glouton d'une semaine type : contraintes dures strictes (rules.ts),
// contraintes souples CS-01 à CS-06 pondérées par la table CONTRAINTE.
// Il tient le rôle du futur moteur OR-Tools CP-SAT côté serveur.

import type { Db, Seance } from '@/types/db'
import { checkSeance, CODES_DURS, decoupage, effectifCours, enParallele, type Violation } from './rules'
import { addDays, fromMin, hours, jourOf, toMin } from './time'

export interface NonPlace {
  id_cours: number
  rang: number
  duree_heures: number
  code: string
  raison: string
}

export interface ResultatGeneration {
  semaine: Seance[]
  nonPlaces: NonPlace[]
  score: number
}

function poidsActifs(db: Db, id_edt: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of db.contrainte) {
    if (c.id_edt === id_edt && c.nature === 'souple' && c.est_active) out[c.type_contrainte] = c.poids
  }
  return out
}

export function generateWeek(
  db: Db,
  id_edt: number,
  monday: string,
  opts: { keepLocked: boolean },
): ResultatGeneration {
  const w = poidsActifs(db, id_edt)
  const dates = Array.from({ length: 6 }, (_, i) => addDays(monday, i)).filter((d) =>
    db.creneau.some((c) => c.jour === jourOf(d)),
  )
  const inWeek = (s: Seance) => s.date_seance >= monday && s.date_seance <= addDays(monday, 6)

  const travail: Seance[] = opts.keepLocked
    ? db.seance.filter((s) => s.id_edt === id_edt && s.est_verrouillee && inWeek(s)).map((s) => ({ ...s }))
    : []
  let tmpId = -1

  const semestreIds = new Set(
    db.emploi_du_temps.filter((e) => e.id_edt === id_edt).map((e) => e.id_semestre),
  )
  const cours = db.cours
    .filter((c) => semestreIds.has(c.id_semestre))
    .sort((a, b) => b.priorite - a.priorite || effectifCours(db, b.id_cours) - effectifCours(db, a.id_cours))

  const nonPlaces: NonPlace[] = []
  let total = 0

  for (const c of cours) {
    const deja = travail.filter((s) => s.id_cours === c.id_cours)
    const modele = decoupage(db, c.id_cours).slice(deja.length)
    const effectif = effectifCours(db, c.id_cours)
    const salles = db.salle.filter(
      (s) => s.est_disponible && s.capacite >= effectif && (c.id_type_salle === null || s.id_type_salle === c.id_type_salle),
    )

    for (const m of modele) {
      let best: { s: Seance; score: number } | null = null
      const motifs = new Map<string, Violation>()
      const compte = new Map<string, number>()
      const note = (vs: Violation[]) =>
        vs.forEach((v) => {
          compte.set(v.code, (compte.get(v.code) ?? 0) + 1)
          if (!motifs.has(v.code)) motifs.set(v.code, v)
        })

      if (!salles.length) {
        const code = db.salle.some((s) => c.id_type_salle === null || s.id_type_salle === c.id_type_salle) ? 'CD-04' : 'CD-05'
        note([{ code, message: code === 'CD-04' ? `Aucune salle de ${effectif} places ou plus du type exigé.` : 'Aucune salle du type exigé.' }])
      }

      for (const date of dates) {
        const jour = jourOf(date)
        for (const cr of db.creneau.filter((x) => x.jour === jour)) {
          const fin = fromMin(toMin(cr.heure_debut) + m.duree_heures * 60)
          for (const salle of salles) {
            const draft: Seance = {
              id_seance: tmpId,
              date_seance: date,
              heure_debut: cr.heure_debut,
              heure_fin: fin,
              statut: 'planifiee',
              est_verrouillee: false,
              id_cours: c.id_cours,
              id_salle: salle.id_salle,
              id_creneau: cr.id_creneau,
              id_edt,
            }
            const vs = checkSeance(db, draft, travail)
            if (vs.length) {
              note(vs)
              continue
            }
            const sc = scoreSouple(db, draft, travail, w) - (salle.capacite - effectif) / 100
            if (!best || sc > best.score) best = { s: draft, score: sc }
          }
        }
      }

      if (best) {
        travail.push(best.s)
        tmpId--
        total += best.score
      } else {
        const [code] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['?']
        const exemple = motifs.get(code)?.message ?? ''
        nonPlaces.push({
          id_cours: c.id_cours,
          rang: m.rang,
          duree_heures: m.duree_heures,
          code,
          raison: `${CODES_DURS[code] ?? code} sur tous les créneaux essayés. ${exemple}`,
        })
      }
    }
  }

  return { semaine: travail, nonPlaces, score: Math.round(total) }
}

function scoreSouple(db: Db, s: Seance, travail: Seance[], w: Record<string, number>): number {
  const cours = db.cours.find((c) => c.id_cours === s.id_cours)!
  const d1 = toMin(s.heure_debut)
  const d2 = toMin(s.heure_fin)
  const jour = jourOf(s.date_seance)
  let score = 0
  const meme = (x: Seance) => {
    const c = db.cours.find((k) => k.id_cours === x.id_cours)!
    return c.id_classe === cours.id_classe && !enParallele(db, cours, c)
  }
  const jourPublic = travail.filter((x) => x.date_seance === s.date_seance && meme(x))

  // CS-01 : préférences de l'enseignant
  if (w['CS-01']) {
    const couverts = db.creneau.filter((c) => c.jour === jour && toMin(c.heure_debut) >= d1 && toMin(c.heure_fin) <= d2)
    const pref = couverts.filter((c) =>
      db.disponibilite.some((d) => d.id_enseignant === cours.id_enseignant && d.id_creneau === c.id_creneau && d.niveau === 'preference'),
    ).length
    score += (w['CS-01'] * 3 * pref) / Math.max(1, couverts.length)
  }

  // CS-02 : pas de trous dans la journée du public
  if (w['CS-02'] && jourPublic.length) {
    const colle = jourPublic.some((x) => x.heure_fin === s.heure_debut || x.heure_debut === s.heure_fin)
    score += colle ? w['CS-02'] * 2 : -w['CS-02']
  }

  // CS-03 : éviter les changements de bâtiment entre séances consécutives
  if (w['CS-03']) {
    const lieu = (id_salle: number) => {
      const x = db.salle.find((k) => k.id_salle === id_salle)
      return `${x?.id_site}|${x?.batiment ?? ''}`
    }
    const bat = lieu(s.id_salle)
    for (const x of jourPublic) {
      if (x.heure_fin === s.heure_debut || x.heure_debut === s.heure_fin) {
        const b2 = lieu(x.id_salle)
        // changer de site coûte plus cher que changer de bâtiment dans le même site
        if (b2 !== bat) score -= w['CS-03'] * (b2.split('|')[0] !== bat.split('|')[0] ? 4 : 2)
      }
    }
  }

  // CS-04 : répartir les séances d'un même cours sur la semaine
  if (w['CS-04'] && travail.some((x) => x.id_cours === s.id_cours && x.date_seance === s.date_seance)) {
    score -= w['CS-04'] * 3
  }

  // CS-05 : CM avant TD et TP dans la semaine
  if (w['CS-05']) {
    const idx = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'].indexOf(jour ?? 'Lundi')
    if (cours.type_cours === 'CM') score += (w['CS-05'] * (5 - idx)) / 2
    else {
      const cmApres = travail.some((x) => {
        const c = db.cours.find((k) => k.id_cours === x.id_cours)!
        return c.type_cours === 'CM' && c.id_matiere === cours.id_matiere && c.id_classe === cours.id_classe && x.date_seance > s.date_seance
      })
      if (cmApres) score -= w['CS-05'] * 2
    }
  }

  // CS-06 : charge journalière de l'enseignant (plafond = valeur de la contrainte, 6 h par défaut)
  if (w['CS-06']) {
    const hJour = travail
      .filter((x) => x.date_seance === s.date_seance && db.cours.find((k) => k.id_cours === x.id_cours)!.id_enseignant === cours.id_enseignant)
      .reduce((a, x) => a + hours(x.heure_debut, x.heure_fin), 0)
    const plafond = db.contrainte.find((k) => k.id_edt === s.id_edt && k.type_contrainte === 'CS-06')?.valeur ?? 6
    if (hJour + (d2 - d1) / 60 > plafond) score -= w['CS-06'] * 3
  }

  // Légère préférence pour le matin
  score += (18 * 60 - d1) / 600
  return score
}

/**
 * Déroule une semaine type sur le semestre (BF-14), à partir du lundi `from`.
 * Saute les jours fériés et s'arrête pour chaque cours quand son volume
 * horaire est atteint (CD-08). Les séances déjà présentes sont conservées.
 */
export function expandWeek(
  db: Db,
  semaineType: Seance[],
  id_edt: number,
  from: string,
  existantes: Seance[],
  firstId: number,
): Seance[] {
  const edt = db.emploi_du_temps.find((e) => e.id_edt === id_edt)!
  const sem = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const refMonday = semaineType.length ? mondayOfSeances(semaineType) : from
  const out: Seance[] = [...existantes]
  let id = firstId

  for (let monday = from; monday <= sem.date_fin; monday = addDays(monday, 7)) {
    const delta = Math.round((Date.parse(monday) - Date.parse(refMonday)) / 86400000)
    for (const t of [...semaineType].sort((a, b) => a.date_seance.localeCompare(b.date_seance))) {
      const date = addDays(t.date_seance, delta)
      if (date < sem.date_debut || date > sem.date_fin) continue
      const s: Seance = { ...t, id_seance: id, date_seance: date, id_edt, statut: 'planifiee' }
      if (checkSeance(db, s, out).length) continue
      out.push(s)
      id++
    }
  }
  return out
}

function mondayOfSeances(list: Seance[]): string {
  const first = [...list].sort((a, b) => a.date_seance.localeCompare(b.date_seance))[0].date_seance
  const d = new Date(first + 'T12:00:00')
  const dow = (d.getDay() + 6) % 7
  return addDays(first, -dow)
}
