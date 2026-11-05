// Panneau « Cours à placer » : ce qu'on peut encore poser d'un cours dans la semaine affichée.
// Une durée proposée tient dans ce qui reste du volume (CD-08) et dans la place de la semaine (CD-14),
// et ne laisse jamais un reste qu'aucune séance ne pourrait couvrir (une séance dure de 2 à 4 h).

const DUREE_MIN = 2
const DUREES = [4, 3, 2]

export type EtatAPlacer =
  | 'a_placer'
  | 'volume_atteint'
  | 'semaine_complete' // rien ne tient cette semaine ; une autre semaine, si
  | 'reste_trop_court' // moins d'une séance à placer
  | 'rythme_trop_court' // le maximum hebdomadaire du cours ne permet pas de placer ce qui reste

export interface CoursAPlacer {
  volume: number
  planifiees: number
  maxSemaine: number
  /** Heures du cours déjà posées dans la semaine affichée */
  semaine: number
  /** Durées des séances types du cours */
  modele: number[]
}

export function aPlacer({ volume, planifiees, maxSemaine, semaine, modele }: CoursAPlacer): { etat: EtatAPlacer; durees: number[]; reste: number } {
  const reste = volume - planifiees
  if (reste <= 0) return { etat: 'volume_atteint', durees: [], reste: 0 }
  if (reste < DUREE_MIN) return { etat: 'reste_trop_court', durees: [], reste }

  const place = maxSemaine - semaine
  const possible = (d: number) => d <= place && (d === reste || reste - d >= DUREE_MIN)

  const types = [...new Set(modele)].filter(possible)
  if (types.length) return { etat: 'a_placer', durees: types, reste }

  // La durée type ne convient plus : la durée possible qui s'en approche le plus, la plus longue à égalité
  const reference = modele[0] ?? DUREE_MIN
  const proche = DUREES.filter(possible).sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference) || b - a)[0]
  if (proche !== undefined) return { etat: 'a_placer', durees: [proche], reste }

  return { etat: semaine > 0 ? 'semaine_complete' : 'rythme_trop_court', durees: [], reste }
}
