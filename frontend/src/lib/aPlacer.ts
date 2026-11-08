// Panneau « Cours à placer » : ce qu'on peut encore poser d'un cours dans la semaine affichée.
// Toutes les durées d'une séance sont proposées, de 2 à 5 h (on pose ici à la main ; la génération s'arrête
// à 4 h). Une durée tient dans ce qui reste du volume (CD-08) et dans la place de la semaine (CD-14), et ne
// laisse jamais un reste qu'aucune séance ne pourrait couvrir. Les durées des séances types du cours sont
// signalées comme habituelles.

export const DUREE_MIN = 2
export const DUREE_MAX = 5
const DUREES = Array.from({ length: DUREE_MAX - DUREE_MIN + 1 }, (_, i) => DUREE_MIN + i)

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

export interface DureeAPlacer {
  duree: number
  /** Peut être posée cette semaine */
  ok: boolean
  /** Durée d'une séance type du cours */
  habituelle: boolean
  /** Pourquoi elle ne peut pas l'être */
  raison?: string
}

const h = (n: number) => `${Number(n.toFixed(2))} h`

export function aPlacer({ volume, planifiees, maxSemaine, semaine, modele }: CoursAPlacer): {
  etat: EtatAPlacer
  /** Durées possibles, de la plus courte à la plus longue */
  durees: number[]
  /** Chaque durée de 2 à 5 h, possible ou non, avec la raison */
  options: DureeAPlacer[]
  reste: number
} {
  const reste = volume - planifiees
  if (reste <= 0) return { etat: 'volume_atteint', durees: [], options: [], reste: 0 }
  if (reste < DUREE_MIN) return { etat: 'reste_trop_court', durees: [], options: [], reste }

  const place = maxSemaine - semaine
  const habituelles = new Set(modele)
  const options = DUREES.map((d): DureeAPlacer => {
    const raison =
      d > reste ? `Il ne reste que ${h(reste)} à placer pour ce cours.`
        : d > place ? `Le cours dépasserait ${h(maxSemaine)} cette semaine (déjà ${h(semaine)} posées).`
          : d !== reste && reste - d < DUREE_MIN ? `Il resterait ${h(reste - d)}, trop peu pour une séance (${DUREE_MIN} h au moins).`
            : undefined
    return { duree: d, ok: !raison, habituelle: habituelles.has(d), raison }
  })
  const durees = options.filter((o) => o.ok).map((o) => o.duree)
  if (durees.length) return { etat: 'a_placer', durees, options, reste }
  return { etat: semaine > 0 ? 'semaine_complete' : 'rythme_trop_court', durees: [], options, reste }
}
