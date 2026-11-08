// Mutualiser un cours avec une autre classe (COURS_PUBLIC), depuis le détail d'une séance : toutes les séances
// du cours entrent dans l'emploi du temps de cette classe. Elle ne doit donc avoir aucune autre séance en même
// temps (CD-03), ni cours sur l'autre campus ces demi-journées-là (SITE), et chaque salle doit rester assez grande (CD-04)
// quand les effectifs sont connus. La base ne
// contrôle pas l'ajout d'un public : ce contrôle-ci l'évite.

import type { Cours, Db, Seance } from '@/types/db'
import { capaciteConnue, memeDemiJournee } from './rules'
import { effectifDuCours, estEpreuve, publicsSeance } from './publics'
import { fmtHeure, fmtJourCourt, toMin } from './time'

export interface Disponibilite {
  ok: boolean
  /** Séances du cours (non annulées) que la classe suivrait */
  nb: number
  motif?: string
}

export function disponibiliteMutualisation(db: Db, id_edt: number, cours: Cours, id_classe: number): Disponibilite {
  const classe = db.classe.find((c) => c.id_classe === id_classe)
  const actives = (s: Seance) => s.id_edt === id_edt && s.statut !== 'annulee'
  const duCours = db.seance.filter((s) => actives(s) && s.id_cours === cours.id_cours)
  if (!classe) return { ok: false, nb: duCours.length, motif: 'Classe introuvable' }
  const dates = new Set(duCours.map((s) => s.date_seance))
  const coursPar = new Map(db.cours.map((c) => [c.id_cours, c]))
  const libelle = (s: Seance) => db.matiere.find((m) => m.id_matiere === coursPar.get(s.id_cours)?.id_matiere)?.libelle ?? 'une séance'
  // Séances de la classe ces jours-là (épreuves comprises : elles concernent toute la classe)
  const deLaClasse = db.seance.filter((s) => actives(s) && s.id_cours !== cours.id_cours && dates.has(s.date_seance)
    && publicsSeance(db, coursPar.get(s.id_cours)!, s).some((p) => p.id_classe === id_classe))
  const conflits: [Seance, Seance][] = []
  for (const a of duCours) {
    const b = deLaClasse.find((x) => x.date_seance === a.date_seance && toMin(x.heure_debut) < toMin(a.heure_fin) && toMin(a.heure_debut) < toMin(x.heure_fin))
    if (b) conflits.push([a, b])
  }
  if (conflits.length) {
    const [a, b] = conflits[0]
    return {
      ok: false, nb: duCours.length,
      motif: `Déjà en cours le ${fmtJourCourt(a.date_seance)} ${fmtHeure(b.heure_debut)}–${fmtHeure(b.heure_fin)} (${libelle(b)})`
        + (conflits.length > 1 ? `, et ${conflits.length - 1} autre${conflits.length > 2 ? 's' : ''} séance${conflits.length > 2 ? 's' : ''} du cours` : ''),
    }
  }
  // Un campus par demi-journée : toute la classe suivrait la séance, elle ne peut pas avoir cours sur l'autre
  // campus la même demi-journée (elle change de campus à la pause de midi)
  const siteDe = (s: Seance) => db.salle.find((x) => x.id_salle === s.id_salle)?.id_site
  const memeDemi = memeDemiJournee(db)
  for (const a of duCours) {
    const b = deLaClasse.find((x) => x.date_seance === a.date_seance && memeDemi(x, a) && siteDe(x) !== siteDe(a))
    if (b) {
      const nom = (s: Seance) => db.site.find((x) => x.id_site === siteDe(s))?.nom_site ?? 'un autre campus'
      return { ok: false, nb: duCours.length, motif: `Aurait cours sur deux campus la même demi-journée le ${fmtJourCourt(a.date_seance)} (${nom(b)} pour ${libelle(b)}, ${nom(a)} pour ce cours)` }
    }
  }
  // Capacité : seulement si l'effectif de la classe et la capacité de la salle sont renseignés
  if (classe.effectif > 0) {
    const total = effectifDuCours(db, cours) + classe.effectif
    const petite = duCours.find((s) => {
      const salle = db.salle.find((x) => x.id_salle === s.id_salle)
      return !estEpreuve(s) && salle && capaciteConnue(salle) && salle.capacite < total
    })
    if (petite) {
      const salle = db.salle.find((x) => x.id_salle === petite.id_salle)!
      return { ok: false, nb: duCours.length, motif: `${salle.nom_salle} (${salle.capacite} places) trop petite pour ${total} étudiants le ${fmtJourCourt(petite.date_seance)}` }
    }
  }
  return { ok: true, nb: duCours.length }
}
