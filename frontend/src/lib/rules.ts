// Contrôle des contraintes dures côté client (BF-12).
// Reprend la logique du déclencheur verifier_seance() et de la contrainte
// d'exclusion ex_seance_salle de schema_supabase.sql, pour expliquer un refus
// avant même d'écrire en base. La base reste l'arbitre final.

import type { Cours, Db, Seance, Salle } from '@/types/db'
import { effectifDuCours, effectifPublics, estEpreuve, publicsDuCours, publicsEnConflit, publicsSeance } from './publics'
import { hours, jourOf, mondayOf, toMin } from './time'

export interface Violation {
  code: string
  message: string
}

export type SeanceDraft = Omit<Seance, 'id_seance'> & { id_seance?: number }

export const CODES_DURS: Record<string, string> = {
  'CD-01': 'Salle déjà occupée',
  'CD-02': 'Enseignant déjà en séance',
  'CD-03': 'Classe déjà en séance',
  'CD-04': 'Capacité de salle insuffisante',
  'CD-05': 'Type de salle non conforme',
  'CD-06': 'Enseignant absent ou indisponible',
  'CD-08': 'Volume horaire dépassé',
  'CD-09': 'Date hors semestre ou jour férié',
  'CD-10': 'Séance non alignée sur la grille',
  'CD-11': 'Chevauche une pause',
  'CD-12': 'Salle indisponible ou réservée',
  SITE: 'Mêmes étudiants sur deux campus la même demi-journée',
  'CD-13': 'Trop de matières dans la semaine',
  DUREE: 'Durée hors 2 h – 5 h',
  EXAMEN: 'Examen et rattrapage dans le désordre',
}

const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 < b2 && b1 < a2

// --- Index : checkSeance est appelé pour chaque salle, chaque enseignant, chaque créneau, chaque séance du
// tableau de bord. Les séances se rangent une fois par liste (par date, par cours, par semaine) ; une liste
// qui grandit (le générateur ajoute ses séances une à une) est rangée de nouveau.
interface IndexSeances {
  longueur: number
  derniere: Seance | undefined
  parDate: Map<string, Seance[]>
  parCours: Map<number, Seance[]>
  parLundi: Map<string, Seance[]>
  epreuves: Seance[]
}
const index = new WeakMap<Seance[], IndexSeances>()
const lundis = new Map<string, string>()
export const lundiDe = (date: string) => {
  let l = lundis.get(date)
  if (l === undefined) lundis.set(date, (l = mondayOf(date)))
  return l
}
const ajouter = <K,>(m: Map<K, Seance[]>, k: K, s: Seance) => {
  const l = m.get(k)
  if (l) l.push(s)
  else m.set(k, [s])
}
function indexSeances(seances: Seance[]): IndexSeances {
  const deja = index.get(seances)
  if (deja && deja.longueur === seances.length && deja.derniere === seances[seances.length - 1]) return deja
  const ix: IndexSeances = { longueur: seances.length, derniere: seances[seances.length - 1], parDate: new Map(), parCours: new Map(), parLundi: new Map(), epreuves: [] }
  for (const x of seances) {
    ajouter(ix.parDate, x.date_seance, x)
    ajouter(ix.parCours, x.id_cours, x)
    ajouter(ix.parLundi, lundiDe(x.date_seance), x)
    if (estEpreuve(x)) ix.epreuves.push(x)
  }
  index.set(seances, ix)
  return ix
}
const sallesIndex = new WeakMap<Salle[], Map<number, Salle>>()
function salleIndex(db: Db): Map<number, Salle> {
  let m = sallesIndex.get(db.salle)
  if (!m) sallesIndex.set(db.salle, (m = new Map(db.salle.map((x) => [x.id_salle, x]))))
  return m
}

/** Deux séances d'un même jour sont-elles dans la même demi-journée (du même côté de la pause de midi) ? */
export function memeDemiJournee(db: Db): (a: { heure_fin: string }, b: { heure_fin: string }) => boolean {
  const midi = db.pause.length ? Math.min(...db.pause.map((p) => toMin(p.heure_debut))) : null
  return (a, b) => midi === null || (toMin(a.heure_fin) <= midi) === (toMin(b.heure_fin) <= midi)
}

/** Campus mère du cours : celui de sa classe, sinon celui de sa filière. La génération y place les cours ; à la main,
 *  les salles de ce campus sont proposées d'abord. */
export function campusMere(db: Db, cours: Cours): number | null {
  const classe = db.classe.find((c) => c.id_classe === cours.id_classe)
  return classe?.id_site ?? db.filiere.find((f) => f.id_filiere === classe?.id_filiere)?.id_site ?? null
}

/**
 * Rythme hebdomadaire souhaité du cours (CS-08, souple depuis la version 18) : heures du cours dans la semaine de la
 * séance, elle comprise, quand elles dépassent ce rythme ; null sinon. Ce n'est jamais une violation : la console
 * le signale seulement.
 */
export function rythmeDepasse(db: Db, s: SeanceDraft, seances: Seance[] = db.seance): { heures: number; rythme: number } | null {
  if (s.statut === 'annulee' || estEpreuve(s)) return null
  const cours = coursParId(db).get(s.id_cours)
  if (!cours) return null
  const deja = (indexSeances(seances).parLundi.get(lundiDe(s.date_seance)) ?? [])
    .filter((x) => x.id_cours === s.id_cours && x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance && !estEpreuve(x))
    .reduce((a, x) => a + hours(x.heure_debut, x.heure_fin), 0)
  const heures = deja + hours(s.heure_debut, s.heure_fin)
  return heures > cours.heures_semaine_max ? { heures, rythme: cours.heures_semaine_max } : null
}

/** Salle principale de la classe du cours (version 17) : proposée en premier quand elle convient, jamais imposée */
export function sallePrincipale(db: Db, cours: Cours): number | null {
  return db.classe.find((c) => c.id_classe === cours.id_classe)?.id_salle_principale ?? null
}

const coursIndex = new WeakMap<Cours[], Map<number, Cours>>()
function coursParId(db: Db): Map<number, Cours> {
  let m = coursIndex.get(db.cours)
  if (!m) coursIndex.set(db.cours, (m = new Map(db.cours.map((c) => [c.id_cours, c]))))
  return m
}

/**
 * Renvoie toutes les violations de contraintes dures pour une séance.
 * `seances` permet de contrôler contre un autre ensemble que db.seance
 * (utile au générateur, qui travaille sur une semaine en cours de construction).
 */
export function checkSeance(db: Db, s: SeanceDraft, seances: Seance[] = db.seance): Violation[] {
  if (s.statut === 'annulee') return []
  const v: Violation[] = []
  const cours = coursParId(db).get(s.id_cours)
  const salle = db.salle.find((x) => x.id_salle === s.id_salle)
  const creneau = db.creneau.find((x) => x.id_creneau === s.id_creneau)
  if (!cours || !salle || !creneau) return [{ code: 'REF', message: 'Cours, salle ou créneau introuvable' }]
  const classe = db.classe.find((c) => c.id_classe === cours.id_classe)!
  const publics = publicsDuCours(db, cours) // public principal et publics d'un cours mutualisé
  const semestre = db.semestre.find((x) => x.id_semestre === cours.id_semestre)!
  const d1 = toMin(s.heure_debut)
  const d2 = toMin(s.heure_fin)
  const duree = hours(s.heure_debut, s.heure_fin)
  const epreuve = estEpreuve(s)

  if (epreuve) {
    if (duree < 2 || duree > 3) v.push({ code: 'DUREE', message: `Une épreuve dure de 2 h à 3 h (ici ${duree} h).` })
    if (s.id_enseignant !== null) v.push({ code: 'DUREE', message: "Une épreuve n'a pas d'enseignant." })
  } else if (duree < 2 || duree > 5) v.push({ code: 'DUREE', message: `Une séance dure entre 2 h et 5 h (ici ${duree} h).` })

  // CD-10 : alignement sur la grille
  if (s.heure_debut !== creneau.heure_debut) {
    v.push({ code: 'CD-10', message: `L'heure de début ${s.heure_debut} ne correspond pas au créneau de début (${creneau.heure_debut}).` })
  }
  if (!db.creneau.some((c) => c.jour === creneau.jour && c.heure_fin === s.heure_fin)) {
    v.push({ code: 'CD-10', message: `L'heure de fin ${s.heure_fin} ne correspond à aucun créneau de la grille.` })
  }

  // CD-09 : le cours appartient au semestre de l'emploi du temps
  const edt = db.emploi_du_temps.find((e) => e.id_edt === s.id_edt)
  if (edt && edt.id_semestre !== cours.id_semestre) {
    v.push({ code: 'CD-09', message: "Le cours n'appartient pas au semestre de cet emploi du temps." })
  }

  // CD-11 : pause
  const pause = db.pause.find((p) => overlaps(d1, d2, toMin(p.heure_debut), toMin(p.heure_fin)))
  if (pause) v.push({ code: 'CD-11', message: `La séance chevauche la pause « ${pause.libelle} » (${pause.heure_debut}–${pause.heure_fin}).` })

  // CD-09 : semestre, jour du créneau, férié
  if (s.date_seance < semestre.date_debut || s.date_seance > semestre.date_fin) {
    v.push({ code: 'CD-09', message: 'La date est en dehors des dates du semestre.' })
  }
  if (jourOf(s.date_seance) !== creneau.jour) {
    v.push({ code: 'CD-09', message: `La date ne correspond pas au jour du créneau (${creneau.jour}).` })
  }
  const ferie = db.jour_ferie.find((f) => f.date_ferie === s.date_seance)
  if (ferie) v.push({ code: 'CD-09', message: `Le ${s.date_seance} est un jour férié (${ferie.libelle}).` })
  const conge = congeAt(db, s.date_seance, cours.id_classe, epreuve)
  if (conge) v.push({ code: 'CD-09', message: `Le ${s.date_seance} tombe pendant un congé (${conge.libelle}).` })

  const ix = indexSeances(seances)
  const autres = (ix.parDate.get(s.date_seance) ?? []).filter(
    (x) =>
      x.id_edt === s.id_edt &&
      x.statut !== 'annulee' &&
      x.id_seance !== s.id_seance &&
      x.date_seance === s.date_seance &&
      overlaps(d1, d2, toMin(x.heure_debut), toMin(x.heure_fin)),
  )
  const coursOf = (x: Seance) => coursParId(db).get(x.id_cours)!

  // CD-01 : salle. Des épreuves peuvent la partager (voir CD-04), jamais une épreuve et un cours.
  const conflitSalle = autres.find((x) => x.id_salle === s.id_salle && !(epreuve && estEpreuve(x)))
  if (conflitSalle) {
    v.push({ code: 'CD-01', message: `${salle.nom_salle} est déjà occupée de ${conflitSalle.heure_debut} à ${conflitSalle.heure_fin}.` })
  }

  // CD-02 : enseignant de la séance (séance sans enseignant : aucun contrôle d'enseignant)
  const ens = s.id_enseignant
  const conflitEns = ens === null ? undefined : autres.find((x) => x.id_enseignant === ens)
  if (conflitEns) {
    v.push({ code: 'CD-02', message: `L'enseignant a déjà une séance de ${conflitEns.heure_debut} à ${conflitEns.heure_fin}.` })
  }

  // CD-03 : pas deux séances à la fois pour des étudiants communs (publics des cours mutualisés
  // compris ; deux groupes frères du même type peuvent être en parallèle) ; salle et enseignant
  // différents sont déjà imposés par CD-01 et CD-02
  const publicsS = publicsSeance(db, cours, s)
  const conflitPublic = autres.find((x) => {
    const publicsX = publicsSeance(db, coursOf(x), x)
    return publicsS.some((a) => publicsX.some((b) => publicsEnConflit(db.groupe, a, b)))
  })
  if (conflitPublic) {
    v.push({ code: 'CD-03', message: `${classe.code_classe} a déjà une séance de ${conflitPublic.heure_debut} à ${conflitPublic.heure_fin}.` })
  }

  // Site : les mêmes étudiants n'ont cours que sur un campus par demi-journée ; ils changent de campus à la pause
  // de midi. Deux groupes différents peuvent être sur deux campus en même temps (contrôle SITE de la base, v16).
  const sallesParId = salleIndex(db)
  const midi = memeDemiJournee(db)
  const autreCampus = (ix.parDate.get(s.date_seance) ?? []).find((x) => {
    if (x.id_edt !== s.id_edt || x.statut === 'annulee' || x.id_seance === s.id_seance || !midi(x, s)) return false
    const sx = sallesParId.get(x.id_salle)
    if (!sx || sx.id_site === salle.id_site) return false
    const publicsX = publicsSeance(db, coursOf(x), x)
    return publicsS.some((a) => publicsX.some((b) => publicsEnConflit(db.groupe, a, b)))
  })
  if (autreCampus) {
    const commun = publicsSeance(db, coursOf(autreCampus), autreCampus).find((b) => publicsS.some((a) => publicsEnConflit(db.groupe, a, b)))
    const code = db.classe.find((c) => c.id_classe === commun?.id_classe)?.code_classe
    const groupe = commun?.id_groupe != null ? db.groupe.find((g) => g.id_groupe === commun.id_groupe)?.code_groupe : null
    const site = db.site.find((x) => x.id_site === sallesParId.get(autreCampus.id_salle)?.id_site)?.nom_site
    v.push({ code: 'SITE', message: `${code}${groupe ? ` · ${groupe}` : ''} a déjà cours sur le ${site} cette demi-journée : les mêmes étudiants ne changent de campus qu'à la pause de midi.` })
  }

  // CD-04, CD-05, CD-12 : ce qui ne dépend que de la salle et du cours
  v.push(...violationsSalle(db, cours, salle, epreuve))
  if (epreuve) {
    // CD-04 : toute la classe, et les autres épreuves qui partagent la salle
    const effectif = effectifPublics(db, publicsS) + autres
      .filter((x) => x.id_salle === s.id_salle && estEpreuve(x))
      .reduce((n, x) => n + effectifPublics(db, publicsSeance(db, coursOf(x), x)), 0)
    if (salle.capacite < effectif) {
      v.push({ code: 'CD-04', message: `${salle.nom_salle} compte ${salle.capacite} places pour ${effectif} étudiants.` })
    }
  }

  // CD-06 : absences datées et séjours de l'enseignant
  const absence = ens === null ? undefined : absenceAt(db, ens, s.date_seance)
  if (absence) v.push({ code: 'CD-06', message: `L'enseignant est absent du ${absence.date_debut} au ${absence.date_fin}${absence.motif ? ` (${absence.motif})` : ''}.` })
  if (ens !== null && horsSejour(db, ens, s.date_seance)) {
    v.push({ code: 'CD-06', message: `Intervenant externe : le ${s.date_seance} est en dehors de ses séjours prévus.` })
  }

  // CD-06 : disponibilités de la semaine type de l'enseignant
  const indispo = db.disponibilite.find((d) => {
    if (ens === null || d.id_enseignant !== ens || d.niveau !== 'indisponible') return false
    const c = db.creneau.find((x) => x.id_creneau === d.id_creneau)
    return !!c && c.jour === creneau.jour && overlaps(toMin(c.heure_debut), toMin(c.heure_fin), d1, d2)
  })
  if (indispo) {
    v.push({ code: 'CD-06', message: `L'enseignant est indisponible sur ce créneau${indispo.motif ? ` (${indispo.motif})` : ''}.` })
  }

  // Une épreuve ne compte ni dans le volume, ni dans le rythme, ni dans les matières de la semaine
  if (!epreuve) {
    // CD-08 : volume horaire
    const deja = (ix.parCours.get(s.id_cours) ?? [])
      .filter((x) => x.id_cours === s.id_cours && x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance && !estEpreuve(x))
      .reduce((acc, x) => acc + hours(x.heure_debut, x.heure_fin), 0)
    if (deja + duree > cours.volume_horaire) {
      v.push({ code: 'CD-08', message: `Volume prévu ${cours.volume_horaire} h dépassé (${deja} h déjà planifiées + ${duree} h).` })
    }

    // Le rythme hebdomadaire du cours n'est plus une règle (CS-08, souple : voir rythmeDepasse)
    // séances de la même semaine (l'index les range par lundi)
    const laSemaine = ix.parLundi.get(lundiDe(s.date_seance)) ?? []
    const memeSemaine = (x: Seance) =>
      x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance && !estEpreuve(x)

    // CD-13 : au plus N matières différentes par classe et par semaine, pour chaque promotion du cours
    const max = maxMatieresSemaine(db, s.id_edt)
    if (max !== null) {
      for (const id_classe of new Set(publics.map((p) => p.id_classe))) {
        const matieres = new Set(laSemaine.filter((x) => memeSemaine(x) && publicsDuCours(db, coursOf(x)).some((p) => p.id_classe === id_classe))
          .map((x) => coursOf(x).id_matiere))
        matieres.add(cours.id_matiere)
        if (matieres.size > max) {
          const code = db.classe.find((c) => c.id_classe === id_classe)?.code_classe
          v.push({ code: 'CD-13', message: `${code} aurait ${matieres.size} matières différentes cette semaine (maximum ${max}).` })
        }
      }
    }
  }

  // Dans un module (matière d'une classe), le rattrapage vient après l'examen
  if (epreuve) {
    const debut = `${s.date_seance} ${s.heure_debut}`
    const duModule = ix.epreuves.filter((x) => x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance
      && coursOf(x).id_matiere === cours.id_matiere && coursOf(x).id_classe === cours.id_classe)
    if (s.nature === 'rattrapage' && !duModule.some((x) => x.nature === 'examen' && `${x.date_seance} ${x.heure_fin}` <= debut)) {
      v.push({ code: 'EXAMEN', message: "Le rattrapage vient après l'examen du module : programmez d'abord l'examen, à une date antérieure." })
    }
    if (s.nature === 'examen' && duModule.some((x) => x.nature === 'rattrapage' && `${x.date_seance} ${x.heure_debut}` < `${s.date_seance} ${s.heure_fin}`)) {
      v.push({ code: 'EXAMEN', message: "L'examen d'un module vient avant son rattrapage." })
    }
  }

  return v
}

/** Ce qui empêche une salle d'accueillir un cours, quel que soit le créneau */
export function violationsSalle(db: Db, cours: Cours, salle: Salle, epreuve = false): Violation[] {
  const v: Violation[] = []
  const publics = publicsDuCours(db, cours)

  // CD-12 : salle marquée indisponible
  if (!salle.est_disponible) v.push({ code: 'CD-12', message: `${salle.nom_salle} est marquée indisponible.` })

  // CD-04 : capacité (effectif de tous les publics du cours) ; une épreuve se contrôle à part
  const effectif = effectifDuCours(db, cours)
  if (!epreuve && salle.capacite < effectif) {
    v.push({ code: 'CD-04', message: `${salle.nom_salle} compte ${salle.capacite} places pour ${effectif} étudiants.` })
  }

  // CD-05 : type de salle exigé, ou l'un des types acceptés (COURS_TYPE_SALLE)
  const types = [cours.id_type_salle, ...db.cours_type_salle.filter((t) => t.id_cours === cours.id_cours).map((t) => t.id_type_salle)]
    .filter((t): t is number => t !== null)
  if (!epreuve && types.length && !types.includes(salle.id_type_salle)) {
    const attendus = types.map((t) => db.type_salle.find((x) => x.id_type_salle === t)?.libelle).join(' » ou « ')
    v.push({ code: 'CD-05', message: `Ce cours exige une salle de type « ${attendus} ».` })
  }

  // CD-12 : salle réservée à certaines formations
  const reservations = db.salle_reservation.filter((r) => r.id_salle === salle.id_salle)
  if (reservations.length && !reservations.some((r) => publics.some((p) => p.id_classe === r.id_classe))) {
    v.push({ code: 'CD-12', message: `${salle.nom_salle} est réservée à d'autres formations.` })
  }
  return v
}

/** Salles qui conviennent à un cours, quel que soit le créneau, de la plus ajustée à la plus grande */
export function sallesDuCours(db: Db, cours: Cours): Salle[] {
  const mere = campusMere(db, cours)
  const principale = sallePrincipale(db, cours)
  // la salle principale de la classe d'abord, puis le campus mère, puis la plus petite qui convient
  return db.salle.filter((salle) => violationsSalle(db, cours, salle).length === 0)
    .sort((a, b) => Number(a.id_salle !== principale) - Number(b.id_salle !== principale)
      || Number(a.id_site !== mere) - Number(b.id_site !== mere) || a.capacite - b.capacite)
}

// Règles qui dépendent de la salle choisie : les autres valent pour toutes les salles d'un créneau
export const REGLES_SALLE = new Set(['CD-01', 'CD-04', 'CD-05', 'CD-12', 'SITE'])

export type EvaluationCreneau =
  | { ok: true; id_salle: number }
  /** raison : le motif complet ; court : quelques mots, pour l'aperçu sur la grille */
  | { ok: false; raison: string; court: string }

/**
 * Une séance peut-elle aller sur ce créneau, et dans quelle salle ? Même résultat que d'essayer
 * sallesCompatibles salle par salle, mais assez rapide pour colorer toute la semaine pendant un
 * glisser : les règles sans rapport avec la salle ne sont contrôlées qu'une fois, puis on cherche
 * une salle libre parmi `salles` (sallesDuCours, calculées une fois pour le cours).
 * `garderSalle` : la salle du brouillon est conservée si elle convient (séance déplacée).
 */
export function evaluerCreneau(db: Db, draft: SeanceDraft, seances: Seance[], salles: Salle[], garderSalle: boolean): EvaluationCreneau {
  const vs = checkSeance(db, draft, seances)
  if (garderSalle && vs.length === 0) return { ok: true, id_salle: draft.id_salle }
  if (estEpreuve(draft) && !vs.some((v) => !REGLES_SALLE.has(v.code))) {
    // Une épreuve peut partager une salle : chaque salle se contrôle en entier
    const libre = salles.find((x) => checkSeance(db, { ...draft, id_salle: x.id_salle }, seances).length === 0)
    return libre
      ? { ok: true, id_salle: libre.id_salle }
      : { ok: false, raison: "Aucune salle libre assez grande sur cette plage (CD-01, CD-04).", court: 'Aucune salle libre' }
  }
  const bloquantes = vs.filter((v) => !REGLES_SALLE.has(v.code))
  if (bloquantes.length) {
    return {
      ok: false,
      raison: bloquantes.map((v) => `${v.code} : ${v.message}`).join('\n'),
      court: CODES_DURS[bloquantes[0].code] ?? bloquantes[0].message,
    }
  }
  const d1 = toMin(draft.heure_debut)
  const d2 = toMin(draft.heure_fin)
  const occupees = new Set(
    seances
      .filter((x) => x.id_edt === draft.id_edt && x.statut !== 'annulee' && x.id_seance !== draft.id_seance
        && x.date_seance === draft.date_seance && overlaps(d1, d2, toMin(x.heure_debut), toMin(x.heure_fin)))
      .map((x) => x.id_salle),
  )
  const salle = salles.find((x) => !occupees.has(x.id_salle))
  if (salle) return { ok: true, id_salle: salle.id_salle }
  return salles.length
    ? { ok: false, raison: `CD-01 : les ${salles.length} salles adaptées à ce cours sont occupées sur cette plage.`, court: 'Aucune salle libre' }
    : { ok: false, raison: 'Aucune salle ne convient à ce cours : capacité, type, site ou réservation (CD-04, CD-05, CD-12).', court: 'Aucune salle adaptée' }
}

/** Intervenant externe sans séjour prévu à cette date */
export function horsSejour(db: Db, id_enseignant: number, date: string): boolean {
  const e = db.enseignant.find((x) => x.id_enseignant === id_enseignant)
  if (e?.statut !== 'externe') return false
  return !db.sejour_enseignant.some((j) => j.id_enseignant === id_enseignant && date >= j.date_debut && date <= j.date_fin)
}

/** Valeur de CD-13 pour un emploi du temps (3 par défaut), ou null si la contrainte est désactivée */
export function maxMatieresSemaine(db: Db, id_edt: number): number | null {
  const c = db.contrainte.find((k) => k.id_edt === id_edt && k.type_contrainte === 'CD-13')
  if (!c) return 3
  return c.est_active ? c.valeur ?? 3 : null
}

/** Absence datée d'un enseignant couvrant une date */
export function absenceAt(db: Db, id_enseignant: number, date: string) {
  return db.absence_enseignant.find((a) => a.id_enseignant === id_enseignant && date >= a.date_debut && date <= a.date_fin)
}


/** Congé couvrant une date, pour tout l'établissement ou pour la classe donnée. `epreuve` : une période
 *  d'examens est fermée aux cours, pas aux épreuves. */
export function congeAt(db: Db, date: string, id_classe?: number | null, epreuve = false) {
  return db.conge.find(
    (g) => date >= g.date_debut && date <= g.date_fin && (g.id_classe === null || (id_classe != null && g.id_classe === id_classe))
      && !(epreuve && g.type_conge === 'examens'),
  )
}

/** Jour sans cours (férié ou congé) : libellé et nature, pour l'affichage */
export function fermeture(db: Db, date: string, id_classe?: number | null): { libelle: string; nature: 'Férié' | 'Congé' } | undefined {
  const f = db.jour_ferie.find((x) => x.date_ferie === date)
  if (f) return { libelle: f.libelle, nature: 'Férié' }
  const g = congeAt(db, date, id_classe)
  return g ? { libelle: g.libelle, nature: 'Congé' } : undefined
}

/** Créneau de la grille qui commence à `heure` le jour de `date` */
export function creneauAt(db: Db, date: string, heure: string) {
  const jour = jourOf(date)
  return db.creneau.find((c) => c.jour === jour && c.heure_debut === heure)
}

/** Salles compatibles avec une séance, de la plus ajustée à la plus grande (BF-13) */
export function sallesCompatibles(db: Db, draft: SeanceDraft, seances: Seance[] = db.seance): Salle[] {
  return db.salle
    .filter((salle) => salle.est_disponible)
    .filter((salle) => checkSeance(db, { ...draft, id_salle: salle.id_salle }, seances).length === 0)
    .sort((a, b) => a.capacite - b.capacite)
}

export function effectifCours(db: Db, id_cours: number): number {
  const c = db.cours.find((x) => x.id_cours === id_cours)
  return c ? effectifDuCours(db, c) : 0
}

/** Examen dont le module a encore un rattrapage (et aucun autre examen) : il ne se retire pas */
export function examenAvecRattrapage(db: Db, s: Seance): boolean {
  if (s.nature !== 'examen') return false
  const cours = db.cours.find((c) => c.id_cours === s.id_cours)
  const duModule = db.seance.filter((x) => {
    const k = db.cours.find((c) => c.id_cours === x.id_cours)
    return x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance && k?.id_matiere === cours?.id_matiere && k?.id_classe === cours?.id_classe
  })
  return duModule.some((x) => x.nature === 'rattrapage') && !duModule.some((x) => x.nature === 'examen')
}

/** Salles possibles pour une épreuve, de la plus petite à la plus grande */
export function sallesPourEpreuves(db: Db): Salle[] {
  return db.salle.filter((s) => s.est_disponible).sort((a, b) => a.capacite - b.capacite)
}

/** Cours auquel rattacher l'épreuve d'un module : de préférence le CM de toute la classe */
export function coursDuModule(db: Db, id_classe: number, id_matiere: number, id_semestre: number): Cours | undefined {
  return db.cours
    .filter((c) => c.id_classe === id_classe && c.id_matiere === id_matiere && c.id_semestre === id_semestre)
    .sort((a, b) => Number(a.id_groupe !== null) - Number(b.id_groupe !== null) || Number(a.type_cours !== 'CM') - Number(b.type_cours !== 'CM') || a.id_cours - b.id_cours)[0]
}

/** Découpage hebdomadaire d'un cours (COURS_SEANCE_MODELE, sinon duree_seance × nb_seances_semaine) */
export function decoupage(db: Db, id_cours: number): { rang: number; duree_heures: number }[] {
  const lignes = db.cours_seance_modele.filter((m) => m.id_cours === id_cours).sort((a, b) => a.rang - b.rang)
  if (lignes.length) return lignes
  const c = db.cours.find((x) => x.id_cours === id_cours)!
  return Array.from({ length: c.nb_seances_semaine }, (_, i) => ({ rang: i + 1, duree_heures: c.duree_seance }))
}

/** Une salle dont la capacité n'est pas renseignée (importée sans elle) porte 1 place */
export const capaciteConnue = (s: Salle) => s.capacite > 1

/**
 * Salles où une séance peut avoir lieu à son horaire (détail d'une séance) : libres (CD-01), du type exigé
 * (CD-05), ni indisponibles ni réservées (CD-12), assez grandes (CD-04), sur un campus où ses promotions n'ont
 * pas déjà cours autre part cette demi-journée (SITE). Les règles qui ne dépendent pas de la salle (classe, enseignant...)
 * ne vident pas la liste. Comme dans la base, une classe sans effectif renseigné (0) ne fait écarter aucune salle
 * pour sa capacité. Ordre : la salle actuelle, puis le campus mère du cours, puis l'autre campus.
 */
export function sallesLibresSeance(db: Db, s: SeanceDraft, seances: Seance[] = db.seance): { salles: Salle[]; id_site: number | null } {
  const cours = db.cours.find((c) => c.id_cours === s.id_cours)
  if (!cours) return { salles: [], id_site: null }
  const id_site = campusMere(db, cours) ?? db.salle.find((x) => x.id_salle === s.id_salle)?.id_site ?? null
  const principale = sallePrincipale(db, cours)
  // la salle actuelle, puis la salle principale de la classe, puis le campus mère, puis la plus petite
  const salles = db.salle
    .filter((salle) => !checkSeance(db, { ...s, id_salle: salle.id_salle }, seances).some((v) => REGLES_SALLE.has(v.code)))
    .sort((a, b) => (a.id_salle === s.id_salle ? -1 : b.id_salle === s.id_salle ? 1
      : Number(a.id_salle !== principale) - Number(b.id_salle !== principale)
        || Number(a.id_site !== id_site) - Number(b.id_site !== id_site) || a.capacite - b.capacite || a.nom_salle.localeCompare(b.nom_salle)))
  return { salles, id_site }
}
