// Contrôle des contraintes dures côté client (BF-12).
// Reprend la logique du déclencheur verifier_seance() et de la contrainte
// d'exclusion ex_seance_salle de schema_supabase.sql, pour expliquer un refus
// avant même d'écrire en base. La base reste l'arbitre final.

import type { Cours, Db, Seance, Salle } from '@/types/db'
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
  'CD-06': 'Enseignant non habilité, absent ou indisponible',
  'CD-08': 'Volume horaire dépassé',
  'CD-09': 'Date hors semestre ou jour férié',
  'CD-10': 'Séance non alignée sur la grille',
  'CD-11': 'Chevauche une pause',
  'CD-12': 'Salle indisponible',
  'CD-13': 'Trop de matières dans la semaine',
  'CD-14': 'Rythme hebdomadaire du cours dépassé',
  DUREE: 'Durée hors 2 h – 4 h',
}

const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 < b2 && b1 < a2

/**
 * Renvoie toutes les violations de contraintes dures pour une séance.
 * `seances` permet de contrôler contre un autre ensemble que db.seance
 * (utile au générateur, qui travaille sur une semaine en cours de construction).
 */
export function checkSeance(db: Db, s: SeanceDraft, seances: Seance[] = db.seance): Violation[] {
  if (s.statut === 'annulee') return []
  const v: Violation[] = []
  const cours = db.cours.find((c) => c.id_cours === s.id_cours)
  const salle = db.salle.find((x) => x.id_salle === s.id_salle)
  const creneau = db.creneau.find((x) => x.id_creneau === s.id_creneau)
  if (!cours || !salle || !creneau) return [{ code: 'REF', message: 'Cours, salle ou créneau introuvable' }]
  const classe = db.classe.find((c) => c.id_classe === cours.id_classe)!
  const semestre = db.semestre.find((x) => x.id_semestre === cours.id_semestre)!
  const d1 = toMin(s.heure_debut)
  const d2 = toMin(s.heure_fin)
  const duree = hours(s.heure_debut, s.heure_fin)

  if (duree < 2 || duree > 4) v.push({ code: 'DUREE', message: `Une séance dure entre 2 h et 4 h (ici ${duree} h).` })

  // CD-10 : alignement sur la grille
  if (s.heure_debut !== creneau.heure_debut) {
    v.push({ code: 'CD-10', message: `L'heure de début ${s.heure_debut} ne correspond pas au créneau de début (${creneau.heure_debut}).` })
  }
  if (!db.creneau.some((c) => c.jour === creneau.jour && c.heure_fin === s.heure_fin)) {
    v.push({ code: 'CD-10', message: `L'heure de fin ${s.heure_fin} ne correspond à aucun créneau de la grille.` })
  }

  // CD-12 : salle marquée indisponible
  if (!salle.est_disponible) v.push({ code: 'CD-12', message: `${salle.nom_salle} est marquée indisponible.` })

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
  const conge = congeAt(db, s.date_seance, cours.id_classe)
  if (conge) v.push({ code: 'CD-09', message: `Le ${s.date_seance} tombe pendant un congé (${conge.libelle}).` })

  const autres = seances.filter(
    (x) =>
      x.id_edt === s.id_edt &&
      x.statut !== 'annulee' &&
      x.id_seance !== s.id_seance &&
      x.date_seance === s.date_seance &&
      overlaps(d1, d2, toMin(x.heure_debut), toMin(x.heure_fin)),
  )
  const coursOf = (x: Seance) => db.cours.find((c) => c.id_cours === x.id_cours)!

  // CD-01 : salle
  const conflitSalle = autres.find((x) => x.id_salle === s.id_salle)
  if (conflitSalle) {
    v.push({ code: 'CD-01', message: `${salle.nom_salle} est déjà occupée de ${conflitSalle.heure_debut} à ${conflitSalle.heure_fin}.` })
  }

  // CD-02 : enseignant
  const conflitEns = autres.find((x) => coursOf(x).id_enseignant === cours.id_enseignant)
  if (conflitEns) {
    v.push({ code: 'CD-02', message: `L'enseignant a déjà une séance de ${conflitEns.heure_debut} à ${conflitEns.heure_fin}.` })
  }

  // CD-03 : une classe ne suit pas deux séances à la fois, sauf deux groupes
  // différents du même type (TP-G1 / TP-G2) ; salle et enseignant différents
  // sont déjà imposés par CD-01 et CD-02
  const conflitPublic = autres.find((x) => coursOf(x).id_classe === cours.id_classe && !enParallele(db, cours, coursOf(x)))
  if (conflitPublic) {
    v.push({ code: 'CD-03', message: `${classe.code_classe} a déjà une séance de ${conflitPublic.heure_debut} à ${conflitPublic.heure_fin}.` })
  }

  // CD-04 : capacité
  const effectif =
    cours.id_groupe !== null
      ? db.groupe.find((g) => g.id_groupe === cours.id_groupe)?.effectif ?? 0
      : classe.effectif
  if (salle.capacite < effectif) {
    v.push({ code: 'CD-04', message: `${salle.nom_salle} compte ${salle.capacite} places pour ${effectif} étudiants.` })
  }

  // CD-05 : type de salle
  if (cours.id_type_salle !== null && salle.id_type_salle !== cours.id_type_salle) {
    const attendu = db.type_salle.find((t) => t.id_type_salle === cours.id_type_salle)?.libelle
    v.push({ code: 'CD-05', message: `Ce cours exige une salle de type « ${attendu} ».` })
  }

  // CD-06 : habilitation et absences datées de l'enseignant
  if (!estHabilite(db, cours.id_enseignant, cours.id_matiere, cours.type_cours)) {
    v.push({ code: 'CD-06', message: `L'enseignant n'est pas habilité pour ce cours (${cours.type_cours} de cette matière).` })
  }
  const absence = absenceAt(db, cours.id_enseignant, s.date_seance)
  if (absence) v.push({ code: 'CD-06', message: `L'enseignant est absent du ${absence.date_debut} au ${absence.date_fin}${absence.motif ? ` (${absence.motif})` : ''}.` })
  if (horsSejour(db, cours.id_enseignant, s.date_seance)) {
    v.push({ code: 'CD-06', message: `Intervenant externe : le ${s.date_seance} est en dehors de ses séjours prévus.` })
  }

  // CD-06 : disponibilités de la semaine type de l'enseignant
  const indispo = db.disponibilite.find((d) => {
    if (d.id_enseignant !== cours.id_enseignant || d.niveau !== 'indisponible') return false
    const c = db.creneau.find((x) => x.id_creneau === d.id_creneau)
    return !!c && c.jour === creneau.jour && overlaps(toMin(c.heure_debut), toMin(c.heure_fin), d1, d2)
  })
  if (indispo) {
    v.push({ code: 'CD-06', message: `L'enseignant est indisponible sur ce créneau${indispo.motif ? ` (${indispo.motif})` : ''}.` })
  }

  // CD-08 : volume horaire
  const deja = seances
    .filter((x) => x.id_cours === s.id_cours && x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance)
    .reduce((acc, x) => acc + hours(x.heure_debut, x.heure_fin), 0)
  if (deja + duree > cours.volume_horaire) {
    v.push({ code: 'CD-08', message: `Volume prévu ${cours.volume_horaire} h dépassé (${deja} h déjà planifiées + ${duree} h).` })
  }

  // CD-14 : rythme hebdomadaire maximal du cours
  const lundi = mondayOf(s.date_seance)
  const memeSemaine = (x: Seance) =>
    x.id_edt === s.id_edt && x.statut !== 'annulee' && x.id_seance !== s.id_seance && mondayOf(x.date_seance) === lundi
  const semaine = seances.filter((x) => memeSemaine(x) && x.id_cours === s.id_cours).reduce((a, x) => a + hours(x.heure_debut, x.heure_fin), 0)
  if (semaine + duree > cours.heures_semaine_max) {
    v.push({ code: 'CD-14', message: `Le cours dépasserait ${semaine + duree} h cette semaine (maximum ${cours.heures_semaine_max} h).` })
  }

  // CD-13 : au plus N matières différentes par classe et par semaine
  const max = maxMatieresSemaine(db, s.id_edt)
  if (max !== null) {
    const matieres = new Set(seances.filter((x) => memeSemaine(x) && coursOf(x).id_classe === cours.id_classe).map((x) => coursOf(x).id_matiere))
    matieres.add(cours.id_matiere)
    if (matieres.size > max) {
      v.push({ code: 'CD-13', message: `${classe.code_classe} aurait ${matieres.size} matières différentes cette semaine (maximum ${max}).` })
    }
  }

  return v
}

export function estHabilite(db: Db, id_enseignant: number, id_matiere: number, type_cours: string): boolean {
  return db.habilitation.some((h) => h.id_enseignant === id_enseignant && h.id_matiere === id_matiere && h.type_cours === type_cours)
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

/** Deux cours d'une même classe peuvent-ils avoir lieu en même temps ? (CD-03) */
export function enParallele(db: Db, a: Cours, b: Cours): boolean {
  if (a.id_groupe === null || b.id_groupe === null || a.id_groupe === b.id_groupe) return false
  const ga = db.groupe.find((g) => g.id_groupe === a.id_groupe)
  const gb = db.groupe.find((g) => g.id_groupe === b.id_groupe)
  return !!ga && !!gb && ga.type_groupe === gb.type_groupe
}

/** Congé couvrant une date, pour tout l'établissement ou pour la classe donnée */
export function congeAt(db: Db, date: string, id_classe?: number | null) {
  return db.conge.find(
    (g) => date >= g.date_debut && date <= g.date_fin && (g.id_classe === null || (id_classe != null && g.id_classe === id_classe)),
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
  if (!c) return 0
  if (c.id_groupe !== null) return db.groupe.find((g) => g.id_groupe === c.id_groupe)?.effectif ?? 0
  return db.classe.find((x) => x.id_classe === c.id_classe)?.effectif ?? 0
}

/** Découpage hebdomadaire d'un cours (COURS_SEANCE_MODELE, sinon duree_seance × nb_seances_semaine) */
export function decoupage(db: Db, id_cours: number): { rang: number; duree_heures: number }[] {
  const lignes = db.cours_seance_modele.filter((m) => m.id_cours === id_cours).sort((a, b) => a.rang - b.rang)
  if (lignes.length) return lignes
  const c = db.cours.find((x) => x.id_cours === id_cours)!
  return Array.from({ length: c.nb_seances_semaine }, (_, i) => ({ rang: i + 1, duree_heures: c.duree_seance }))
}
