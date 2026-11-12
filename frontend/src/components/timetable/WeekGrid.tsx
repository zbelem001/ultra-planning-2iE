// Grille horaire (vue semaine ou jour). En mode édition, pendant un glisser, chaque créneau est
// coloré selon les contraintes dures et un bloc montre où la séance atterrirait. Le créneau visé
// se déduit de la position du pointeur et de l'endroit où la séance a été saisie (lib/glisser.ts).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as SourisReact, type PointerEvent as PointeurReact, type ReactNode } from 'react'
import { useSurfaceDepot } from '@/lib/glisser'
import { cn } from '@/components/ui'
import type { Db, Groupe } from '@/types/db'
import { chaineGroupe } from '@/lib/publics'
import type { SeanceVue } from '@/lib/queries'
import { fermeture } from '@/lib/rules'
import { addDays, fmtHeure, fmtJourCourt, fromMin, jourOf, todayIso, toMin } from '@/lib/time'
import { EventCard, type Champ, type ModifClic } from './EventCard'

const PX_HEURE = 68
const PX_HEURE_MIN_REMPLI = 36 // en dessous, une séance de 2 h n'afficherait plus que son titre
const MARGES_GRILLE = 16 // pt-1 et pb-3 de la grille
const REM_JOUR = 9.5 // largeur minimale d'un jour, en rem
const REM_JOUR_REMPLI = 8

export interface SlotState {
  ok: boolean
  raison?: string
  /** Quelques mots sur l'aperçu : la salle retenue, ou le motif du refus */
  detail?: string
}

/** Élément en cours de glisser */
export interface Glisse {
  /** Durée de la séance, en heures */
  duree: number
  /** Minutes entre le haut de la séance et le pointeur, là où elle a été saisie */
  decalage: number
  /** Séance déplacée (absente pour une nouvelle séance) */
  id_seance?: number
}

export interface Cible {
  date: string
  heure: string
}

/** Plage choisie à la souris sur la grille (minutes) */
export interface SelectionGrille {
  date: string
  debut: number
  fin: number
}

export interface GridEdition {
  glisse: Glisse | null
  selection?: SelectionGrille | null
  onSelection?: (s: SelectionGrille | null) => void
  /** Clic droit sur la grille : le menu s'ouvre à ces coordonnées, pour cette plage */
  onMenu?: (x: number, y: number, s: SelectionGrille) => void
  /** Clic droit sur une séance */
  onMenuSeance?: (x: number, y: number, s: SeanceVue) => void
  /** Jour et minute sous le pointeur (null : hors de la grille), pour coller une séance là où il se trouve */
  onSurvol?: (p: { date: string; minute: number } | null) => void
  /** Séances copiées (une ou plusieurs) : encadrées en pointillé */
  copiees?: Set<number>
  /** Les séances copiées sont coupées (Ctrl+X) : estompées en plus, elles seront déplacées au collage */
  coupee?: boolean
  /** Séances sélectionnées ensemble (Ctrl+clic), pour les copier, les verrouiller ou les supprimer d'un coup */
  cochees?: Set<number>
  /** Petits « + » et « − » d'une séance : l'info-bulle de l'heure en plus ou en moins, seulement quand elle
   *  passe toutes les règles (absente : pas de bouton) */
  ajustements?: Map<number, { plus?: string; moins?: string }>
  onAjuster?: (s: SeanceVue, sens: 1 | -1) => void
  /** Pendant un glisser : lundis des semaines voisines (null au bord du semestre). S'attarder sur la bande de
   *  gauche ou de droite de la grille passe à la semaine précédente ou suivante, où l'on peut lâcher la séance. */
  voisines?: { avant: string | null; apres: string | null }
  onSemaine?: (lundi: string) => void
  /** Créneau visé pendant le glisser */
  cible: Cible | null
  /** État d'un créneau pendant un glisser-déposer */
  slot?: (date: string, heure: string) => SlotState | undefined
  onCible: (c: Cible | null) => void
  /** null : déposée là où ce jour n'a aucun créneau */
  onDrop: (c: Cible | null) => void
  onDragStartSeance: (s: SeanceVue, e: DragEvent, decalage: number) => void
  onDragEnd: () => void
}

// ms sur une bande avant de changer de semaine, puis entre deux semaines si le pointeur y reste (la bande se
// remplit pendant ce temps : .remplir-bord)
const DELAI_BORD = 700
const DELAI_BORD_SUITE = 1100
const REM_BANDE = 2.5

const SELECTION_MAX = 300 // minutes : une séance de cours dure 5 h au plus (une épreuve, 3 h)

/** Créneaux consécutifs d'un jour, depuis celui de `ancre` jusqu'à `vise` : sans franchir une pause et sans
 *  dépasser 5 h. Null si `ancre` ne tombe sur aucun créneau. */
export function plageSelectionnee(db: Db, date: string, ancre: number, vise: number): { debut: number; fin: number } | null {
  const jour = jourOf(date)
  const cr = db.creneau.filter((c) => c.jour === jour).map((c) => [toMin(c.heure_debut), toMin(c.heure_fin)]).sort((a, b) => a[0] - b[0])
  const i = cr.findIndex(([a, b]) => a <= ancre && ancre < b)
  if (i < 0) return null
  let [debut, fin] = cr[i]
  if (vise >= fin) {
    for (let j = i + 1; j < cr.length && cr[j][0] === fin && cr[j][0] <= vise && cr[j][1] - debut <= SELECTION_MAX; j++) fin = cr[j][1]
  } else if (vise < debut) {
    for (let j = i - 1; j >= 0 && cr[j][1] === debut && cr[j][1] > vise && fin - cr[j][0] <= SELECTION_MAX; j--) debut = cr[j][0]
  }
  return { debut, fin }
}

/** Fins possibles d'une plage qui commence à `debut` ce jour-là, pour ces durées (minutes) : des créneaux
 *  consécutifs, sans franchir une pause */
export function finsPossibles(db: Db, date: string, debut: string, durees: number[]): string[] {
  const d = toMin(debut)
  return durees.filter((duree) => plageSelectionnee(db, date, d, d + duree - 1)?.fin === d + duree).map((duree) => fromMin(d + duree))
}

/** Écart maximal entre le haut de la séance et le créneau retenu ; au-delà, rien n'est visé */
const ECART_MAX = 60

/**
 * Créneau du jour le plus proche d'une heure de début souhaitée (minutes), après l'avoir ramenée
 * dans la grille pour que toute la séance y tienne.
 */
export function creneauLePlusProche(db: Db, date: string, minutes: number, duree: number, debutGrille: number, finGrille: number): string | null {
  const jour = jourOf(date)
  const haut = Math.max(debutGrille, Math.min(minutes, finGrille - duree * 60))
  let trouve: string | null = null
  let ecart = Infinity
  for (const c of db.creneau) {
    if (c.jour !== jour) continue
    const e = Math.abs(toMin(c.heure_debut) - haut)
    if (e < ecart) { ecart = e; trouve = c.heure_debut }
  }
  return ecart <= ECART_MAX ? trouve : null
}

export function bornesGrille(db: Db): [number, number] {
  if (!db.creneau.length) return [8 * 60, 18 * 60]
  return [Math.min(...db.creneau.map((c) => toMin(c.heure_debut))), Math.max(...db.creneau.map((c) => toMin(c.heure_fin)))]
}

/** Jours de la semaine (à partir du lundi) qui ont au moins un créneau dans la grille */
export function joursGrille(db: Db, monday: string): string[] {
  return Array.from({ length: 6 }, (_, i) => addDays(monday, i)).filter((d) => db.creneau.some((c) => c.jour === jourOf(d)))
}

/** Plages horaires d'un jour qui ne sont couvertes ni par un créneau ni par une pause */
function horsGrille(db: Db, jour: string | null, start: number, end: number): [number, number][] {
  const couvert = (m: number) =>
    db.creneau.some((c) => c.jour === jour && toMin(c.heure_debut) <= m && m < toMin(c.heure_fin)) ||
    db.pause.some((p) => toMin(p.heure_debut) <= m && m < toMin(p.heure_fin))
  const out: [number, number][] = []
  for (let m = start; m < end; m += 15) {
    if (couvert(m)) continue
    const last = out[out.length - 1]
    if (last && last[1] === m) last[1] = m + 15
    else out.push([m, m + 15])
  }
  return out
}

const debutPile = (p: SeanceVue[]) => Math.min(...p.map((s) => toMin(s.heure_debut)))
const finPile = (p: SeanceVue[]) => Math.max(...p.map((s) => toMin(s.heure_fin)))

/** Répartit les piles qui se chevauchent sur des colonnes côte à côte */
function lanes(piles: SeanceVue[][]): Map<SeanceVue[], { lane: number; of: number }> {
  const sorted = [...piles].sort((a, b) => debutPile(a) - debutPile(b) || finPile(b) - finPile(a))
  const out = new Map<SeanceVue[], { lane: number; of: number }>()
  let cluster: SeanceVue[][] = []
  let clusterEnd = -1
  let ends: number[] = []
  const flush = () => {
    for (const p of cluster) out.get(p)!.of = ends.length
    cluster = []
    ends = []
  }
  for (const p of sorted) {
    const d = debutPile(p)
    if (d >= clusterEnd) { flush(); clusterEnd = -1 }
    let lane = ends.findIndex((e) => e <= d)
    if (lane === -1) { lane = ends.length; ends.push(0) }
    ends[lane] = finPile(p)
    clusterEnd = Math.max(clusterEnd, finPile(p))
    out.set(p, { lane, of: 0 })
    cluster.push(p)
  }
  flush()
  return out
}

/**
 * Séances d'un jour, en piles : les séances de groupes distincts d'une même classe qui se chevauchent (TP G1, G2,
 * G3 à la même heure, ou décalées mais qui se recouvrent) forment une pile, dont l'écran ne montre qu'une carte à la
 * fois, avec des numéros pour passer d'un groupe à l'autre. Toute autre séance est seule dans sa pile : deux séances
 * qui se chevauchent sans être des groupes distincts d'une classe (la classe entière et un groupe, un groupe et son
 * demi-groupe, deux classes) restent côte à côte, pour qu'un conflit se voie. Une pile est rangée par groupe
 * (G1, G2, … G10), une séance annulée après celle qui ne l'est pas.
 */
function empiler(list: SeanceVue[], groupes: Groupe[]): SeanceVue[][] {
  const piles: SeanceVue[][] = []
  const ouvertes = new Map<number, { pile: SeanceVue[]; fin: number }>() // dernière pile de chaque classe
  const lies = (a: Groupe, b: Groupe) =>
    a.id_groupe === b.id_groupe || chaineGroupe(groupes, a.id_groupe).includes(b.id_groupe) || chaineGroupe(groupes, b.id_groupe).includes(a.id_groupe)
  const sorted = [...list].sort((a, b) => a.heure_debut.localeCompare(b.heure_debut) || b.duree - a.duree)
  for (const s of sorted) {
    const g = s.groupe
    if (!g) { piles.push([s]); continue }
    const o = ouvertes.get(s.classe.id_classe)
    if (o && toMin(s.heure_debut) < o.fin) {
      if (o.pile.some((x) => lies(x.groupe!, g))) { piles.push([s]); continue } // même groupe en même temps : côte à côte
      o.pile.push(s)
      o.fin = Math.max(o.fin, toMin(s.heure_fin))
      continue
    }
    const pile = [s]
    piles.push(pile)
    ouvertes.set(s.classe.id_classe, { pile, fin: toMin(s.heure_fin) })
  }
  for (const p of piles) {
    if (p.length > 1) p.sort((a, b) =>
      a.groupe!.code_groupe.localeCompare(b.groupe!.code_groupe, 'fr', { numeric: true })
      || Number(a.statut === 'annulee') - Number(b.statut === 'annulee')
      || a.heure_debut.localeCompare(b.heure_debut))
  }
  return piles
}

/** Numéros des groupes d'une pile, en haut à gauche de la carte : celui de la carte montrée est plein */
function Onglets({ pile, montree, onChoisir, marquees }: {
  pile: SeanceVue[]
  montree: number
  onChoisir: (id: number) => void
  /** Séances sélectionnées ou cochées : leur numéro est cerclé même quand leur carte est cachée */
  marquees: (id: number) => boolean
}) {
  return (
    <div role="group" aria-label={`${pile.length} groupes à cette heure`} className="flex flex-wrap gap-1">
      {pile.map((x, i) => {
        const actif = x.id_seance === montree
        const infos = `${x.groupe?.code_groupe ?? x.public_affiche} · ${x.cours.type_cours} · ${fmtHeure(x.heure_debut)}–${fmtHeure(x.heure_fin)} · ${x.salle.nom_salle}${x.statut === 'annulee' ? ' · annulée' : ''}`
        return (
          <button
            key={x.id_seance}
            type="button"
            data-onglet={i + 1}
            aria-pressed={actif}
            aria-label={`Groupe ${i + 1} sur ${pile.length} : ${infos}`}
            title={infos}
            // ni sélectionner la carte, ni ouvrir son détail
            onClick={(e) => { e.stopPropagation(); onChoisir(x.id_seance) }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
            className={cn(
              'press grid size-4 shrink-0 place-items-center rounded-full text-[10px] leading-none font-semibold tabular-nums transition-colors duration-150',
              actif ? 'bg-navy text-white' : 'bg-white/90 text-navy ring-1 ring-navy/25 hover:bg-navy/10',
              !actif && marquees(x.id_seance) && 'ring-2 ring-navy',
              x.statut === 'annulee' && 'line-through opacity-60',
            )}
          >
            {i + 1}
          </button>
        )
      })}
    </div>
  )
}

export function WeekGrid({ db, days, seances, hide, selectedId, onSelect, onOuvrir, edition, renderEmptyDay, idClasse, remplir, impression }: {
  db: Db
  /** Classe affichée : ses congés propres sont aussi grisés */
  idClasse?: number | null
  days: string[]
  seances: SeanceVue[]
  hide?: Champ[]
  selectedId?: number | null
  /** Clic sur une séance, avec les touches tenues (Ctrl+clic : sélection de plusieurs, en Planification) */
  onSelect?: (s: SeanceVue, m?: ModifClic) => void
  /** Ouvrir le détail d'une séance par un double-clic ou Entrée (quand le clic simple sert à sélectionner) */
  onOuvrir?: (s: SeanceVue) => void
  edition?: GridEdition
  renderEmptyDay?: (date: string) => ReactNode
  /** Ajuster les heures pour occuper exactement la hauteur du parent, dont la hauteur est fixée */
  remplir?: boolean
  /** Export PDF : heures de hauteur fixe (la semaine tient sur sa page), ni « aujourd'hui » ni défilement */
  impression?: { pxHeure: number }
}) {
  const [start, end] = bornesGrille(db)
  const refGrille = useRef<HTMLDivElement>(null)
  const refEnTete = useRef<HTMLDivElement>(null)
  const [disponible, setDisponible] = useState<number | null>(null)
  useLayoutEffect(() => {
    const parent = refGrille.current?.parentElement
    const enTete = refEnTete.current
    if (!remplir || !parent || !enTete) return setDisponible(null)
    const mesurer = () => setDisponible(parent.clientHeight - enTete.offsetHeight - MARGES_GRILLE)
    mesurer()
    const observateur = new ResizeObserver(mesurer) // fenêtre, ou nom de jour férié dans l'en-tête
    observateur.observe(parent)
    observateur.observe(enTete)
    return () => observateur.disconnect()
  }, [remplir])
  const pxHeure = impression ? impression.pxHeure
    : remplir && disponible ? Math.max(PX_HEURE_MIN_REMPLI, disponible / ((end - start) / 60)) : PX_HEURE
  const height = ((end - start) / 60) * pxHeure
  const remJour = remplir || impression ? REM_JOUR_REMPLI : REM_JOUR
  const heuresLabels: number[] = []
  for (let m = start; m <= end; m += 60) heuresLabels.push(m)
  const today = impression ? '' : todayIso()
  const y = (min: number) => ((min - start) / 60) * pxHeure
  const glisse = edition?.glisse ?? null
  const cible = edition?.cible ?? null

  // Groupes en même temps : la carte montrée dans chaque pile est la dernière choisie (clic sur son numéro), ou
  // sélectionnée, copiée, déplacée ou modifiée ; sinon celle du premier groupe. Un choix ne vaut que pour sa pile.
  const [affichees, setAffichees] = useState<number[]>([])
  const montrer = useCallback((ids: number[]) => setAffichees((a) => {
    if (ids.every((id, i) => a[a.length - ids.length + i] === id)) return a
    return [...a.filter((x) => !ids.includes(x)), ...ids].slice(-80)
  }), [])
  const montree = (pile: SeanceVue[]) => {
    for (let i = affichees.length - 1; i >= 0; i--) {
      const s = pile.find((x) => x.id_seance === affichees[i])
      if (s) return s
    }
    return pile[0]
  }
  // identifiants des séances copiées, en texte : l'ensemble est recréé à chaque modification de la base
  const copiees = edition?.copiees ? [...edition.copiees].join() : ''
  useEffect(() => { if (selectedId != null) montrer([selectedId]) }, [selectedId, montrer])
  useEffect(() => { if (copiees) montrer(copiees.split(',').map(Number)) }, [copiees, montrer])
  // Séance ajoutée, déplacée, allongée, annulée… (collage, dépôt, assistant) : sa carte passe devant. Pas quand la
  // semaine ou la ressource change (rien en commun avec l'affichage d'avant).
  const positions = useRef<{ jours: string; places: Map<number, string> } | null>(null)
  const joursCle = days.join()
  useEffect(() => {
    const avant = positions.current
    const places = new Map(seances.map((s) => [s.id_seance, `${s.date_seance}|${s.heure_debut}|${s.heure_fin}|${s.statut}`]))
    positions.current = { jours: joursCle, places }
    if (!avant || avant.jours !== joursCle || ![...places.keys()].some((id) => avant.places.has(id))) return
    const changees = [...places].filter(([id, place]) => avant.places.get(id) !== place).map(([id]) => id)
    if (changees.length) montrer(changees)
  }, [seances, joursCle, montrer])

  // Bandes de changement de semaine, visibles pendant un glisser
  const bandes = !!glisse && !!edition?.onSemaine
  const refAvant = useRef<HTMLDivElement>(null)
  const refApres = useRef<HTMLDivElement>(null)
  const [bord, setBord] = useState<{ sens: -1 | 1; tour: number } | null>(null)
  const minuterie = useRef<{ sens: -1 | 1; id: number } | null>(null)
  const editionCourante = useRef(edition)
  useEffect(() => { editionCourante.current = edition })
  const voisine = (sens: -1 | 1) => (sens === -1 ? editionCourante.current?.voisines?.avant : editionCourante.current?.voisines?.apres) ?? null
  const arreterBord = () => {
    if (minuterie.current) clearTimeout(minuterie.current.id)
    minuterie.current = null
    setBord(null)
  }
  // Bande sous le pointeur : tout ce qui est à gauche des heures, ou à droite du dernier jour
  const bandeSous = (px: number): -1 | 1 | null => {
    if (!bandes) return null
    const a = refAvant.current?.getBoundingClientRect()
    const b = refApres.current?.getBoundingClientRect()
    return a && px <= a.right ? -1 : b && px >= b.left ? 1 : null
  }
  const viserBord = (sens: -1 | 1 | null) => {
    if (sens === null || !voisine(sens)) return void (minuterie.current && arreterBord())
    if (minuterie.current?.sens === sens) return
    if (minuterie.current) clearTimeout(minuterie.current.id)
    // tant que le pointeur reste sur la bande, une semaine de plus à chaque délai
    const lancer = (tour: number) => {
      setBord({ sens, tour })
      minuterie.current = {
        sens,
        id: window.setTimeout(() => {
          const lundi = voisine(sens)
          if (!lundi) return arreterBord()
          editionCourante.current?.onSemaine?.(lundi)
          lancer(tour + 1)
        }, tour === 0 ? DELAI_BORD : DELAI_BORD_SUITE),
      }
    }
    lancer(0)
  }
  useEffect(() => { if (!glisse) arreterBord() }, [glisse])
  useEffect(() => () => { if (minuterie.current) clearTimeout(minuterie.current.id) }, [])

  // Créneau visé : colonne la plus proche du pointeur, heure donnée par le haut de la séance
  const cibleAu = (px: number, py: number): Cible | null => {
    if (!glisse) return null
    let colonne: HTMLElement | null = null
    let distance = Infinity
    for (const el of refGrille.current?.querySelectorAll<HTMLElement>('[data-jour]') ?? []) {
      const r = el.getBoundingClientRect()
      const d = px < r.left ? r.left - px : px > r.right ? px - r.right : 0
      if (d < distance) { distance = d; colonne = el }
    }
    if (!colonne) return null
    const date = colonne.dataset.jour!
    const minutes = start + ((py - colonne.getBoundingClientRect().top) / pxHeure) * 60 - glisse.decalage
    const heure = creneauLePlusProche(db, date, minutes, glisse.duree, start, end)
    return heure ? { date, heure } : null
  }

  // Sélection d'heures : on presse sur une case vide et on glisse ; moins de 2 h à la fin : rien de retenu
  const selection = edition?.selection ?? null
  const commencerSelection = (e: PointeurReact<HTMLDivElement>, d: string) => {
    const choisir = edition?.onSelection
    if (!choisir || e.button !== 0 || glisse || (e.target as HTMLElement).closest('[data-seance]')) return
    const colonne = e.currentTarget
    const minuteAu = (cy: number) => start + ((cy - colonne.getBoundingClientRect().top) / pxHeure) * 60
    const ancre = minuteAu(e.clientY)
    let courante = plageSelectionnee(db, d, ancre, ancre)
    choisir(courante && { date: d, ...courante })
    if (!courante) return
    e.preventDefault()
    const bouger = (ev: PointerEvent) => {
      courante = plageSelectionnee(db, d, ancre, minuteAu(ev.clientY))
      if (courante) choisir({ date: d, ...courante })
    }
    const finir = () => {
      document.removeEventListener('pointermove', bouger)
      document.removeEventListener('pointerup', finir)
      if (!courante || courante.fin - courante.debut < 120) choisir(null)
    }
    document.addEventListener('pointermove', bouger)
    document.addEventListener('pointerup', finir)
  }

  // Clic droit : sur la sélection, ou sans sélection deux heures à partir de cette case
  const menuContextuel = (e: SourisReact<HTMLDivElement>, d: string) => {
    if (!edition?.onMenu || (e.target as HTMLElement).closest('[data-seance]')) return
    e.preventDefault()
    const m = start + ((e.clientY - e.currentTarget.getBoundingClientRect().top) / pxHeure) * 60
    if (selection?.date === d && m >= selection.debut && m < selection.fin) return edition.onMenu(e.clientX, e.clientY, selection)
    const suivante = plageSelectionnee(db, d, m, m + 60)
    const plage = suivante && suivante.fin - suivante.debut >= 120 ? suivante : plageSelectionnee(db, d, m, m - 60)
    if (!plage || plage.fin - plage.debut < 120) return
    edition.onSelection?.({ date: d, ...plage })
    edition.onMenu(e.clientX, e.clientY, { date: d, ...plage })
  }

  useSurfaceDepot(refGrille, !!glisse, {
    surPointeur: (px, py) => {
      const sens = bandeSous(px)
      viserBord(sens)
      edition?.onCible(sens ? null : cibleAu(px, py))
    },
    surSortie: () => { viserBord(null); edition?.onCible(null) },
    surDepot: (px, py) => {
      const surBande = bandeSous(px) !== null
      viserBord(null)
      if (surBande) return edition?.onDragEnd() // lâchée sur une bande : rien ne bouge
      edition?.onDrop(cibleAu(px, py))
    },
  })

  const bande = (sens: -1 | 1) => {
    const lundi = sens === -1 ? edition?.voisines?.avant : edition?.voisines?.apres
    const active = bord?.sens === sens
    return (
      <div
        ref={sens === -1 ? refAvant : refApres}
        data-bande={sens === -1 ? 'precedente' : 'suivante'}
        className={cn(
          'relative mx-0.5 grid place-items-center overflow-hidden rounded-2xl ring-1 transition-colors duration-150',
          !lundi ? 'bg-muted/60 text-ink-2/60 ring-white' : active ? 'bg-navy/10 text-navy ring-navy' : 'bg-white/70 text-ink-2 ring-line',
        )}
        style={{ height }}
      >
        {active && lundi && (
          <div key={bord.tour} className="remplir-bord absolute inset-0 bg-navy/15" style={{ animationDuration: `${bord.tour === 0 ? DELAI_BORD : DELAI_BORD_SUITE}ms` }} aria-hidden />
        )}
        <span className={cn('relative text-[11px] font-medium whitespace-nowrap [writing-mode:vertical-rl]', sens === -1 && 'rotate-180')}>
          {lundi ? `${sens === -1 ? '← ' : ''}Semaine du ${fmtJourCourt(lundi)}${sens === 1 ? ' →' : ''}` : 'Fin du semestre'}
        </span>
      </div>
    )
  }

  return (
    <div ref={refGrille} className={impression ? 'pt-1 pb-1' : 'overflow-x-auto pt-1 pb-3 scroll-thin'}>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${bandes ? `${REM_BANDE}rem ` : ''}3.25rem repeat(${days.length}, minmax(${days.length > 1 ? `${remJour}rem` : '0'}, 1fr))${bandes ? ` ${REM_BANDE}rem` : ''}`,
          minWidth: days.length > 1 ? `${3.25 + days.length * remJour + (bandes ? 2 * REM_BANDE : 0)}rem` : undefined,
        }}
      >
        {/* En-têtes */}
        {bandes && <div />}
        <div ref={refEnTete} />
        {days.map((d) => {
          const ferie = fermeture(db, d, idClasse)
          const isToday = d === today
          return (
            <div key={d} className="px-1 pb-2 text-center">
              <p className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium capitalize', isToday ? 'bg-navy text-white' : 'text-ink')}>
                {isToday && <span className="size-1.5 rounded-full bg-orange" aria-hidden />}
                {fmtJourCourt(d)}
              </p>
              {ferie && <p className="mt-1 truncate text-xs text-[#7C4A03]">{ferie.libelle}</p>}
            </div>
          )
        })}
        {bandes && <div />}

        {/* Heures */}
        {bandes && bande(-1)}
        <div className="relative" style={{ height }}>
          {heuresLabels.map((m) => (
            <span key={m} className="absolute right-2 -translate-y-1/2 font-mono text-[11px] text-ink-2 tabular-nums" style={{ top: y(m) }}>
              {fmtHeure(fromMin(m))}
            </span>
          ))}
        </div>

        {/* Colonnes des jours */}
        {days.map((d, i) => {
          const jour = jourOf(d)
          const ferie = fermeture(db, d, idClasse)
          const crs = db.creneau.filter((c) => c.jour === jour)
          const list = seances.filter((s) => s.date_seance === d)
          // Export PDF : pas de numéros à cliquer sur papier, les groupes restent côte à côte
          const piles = impression ? list.map((s) => [s]) : empiler(list, db.groupe)
          const pos = lanes(piles)
          return (
            <div
              key={d}
              data-jour={d}
              onPointerDown={edition?.onSelection ? (e) => commencerSelection(e, d) : undefined}
              onContextMenu={edition?.onMenu ? (e) => menuContextuel(e, d) : undefined}
              onPointerMove={edition?.onSurvol
                ? (e) => edition.onSurvol!({ date: d, minute: start + ((e.clientY - e.currentTarget.getBoundingClientRect().top) / pxHeure) * 60 })
                : undefined}
              onPointerLeave={edition?.onSurvol ? () => edition.onSurvol!(null) : undefined}
              className={cn('relative mx-0.5 rounded-2xl ring-1', impression ? 'ring-line' : 'bg-white/55 ring-white', edition?.onSelection && 'cursor-cell select-none')}
              style={{ height }}
            >
              {/* lignes horaires */}
              {heuresLabels.slice(1, -1).map((m) => (
                <div key={m} className="absolute inset-x-0 border-t border-dashed border-line/80" style={{ top: y(m) }} />
              ))}
              {/* ligne verticale entre deux jours, comme celles des heures (au milieu de l'espace entre les colonnes) */}
              {i < days.length - 1 && (
                <div className="pointer-events-none absolute inset-y-0 -right-[3px] border-l border-dashed border-line/80" aria-hidden />
              )}
              {/* hors grille : jour sans créneau, pause, férié */}
              {!ferie && horsGrille(db, jour, start, end).map(([a, b]) => (
                <div key={a} className="hatched absolute inset-x-0 bg-muted/60" style={{ top: y(a), height: y(b) - y(a) }} aria-hidden />
              ))}
              {db.pause.map((p) => (
                <div key={p.id_pause} className="hatched absolute inset-x-0 grid place-items-center" style={{ top: y(toMin(p.heure_debut)), height: y(toMin(p.heure_fin)) - y(toMin(p.heure_debut)) }}>
                  <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-ink-2">{p.libelle}</span>
                </div>
              ))}
              {ferie && (
                <div className="hatched absolute inset-0 grid place-items-center rounded-2xl bg-orange-soft/40">
                  <span className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-[#7C4A03]">{ferie.nature}</span>
                </div>
              )}

              {/* pendant un glisser : où la séance peut commencer */}
              {glisse && !ferie && crs.map((c) => {
                const st = edition?.slot?.(d, c.heure_debut)
                return (
                  <div
                    key={c.id_creneau}
                    data-slot={`${d}|${c.heure_debut}`}
                    className={cn(
                      'pointer-events-none absolute inset-x-1 rounded-xl transition-colors duration-150',
                      st?.ok && 'bg-[#DCFCE7]/80 ring-1 ring-[#15803D]/30',
                      st && !st.ok && 'bg-[#FEE2E2]/45',
                    )}
                    style={{ top: y(toMin(c.heure_debut)) + 1, height: pxHeure - 2 }}
                  />
                )
              })}

              {/* séances */}
              {piles.map((pile) => {
                const p = pos.get(pile)!
                const s = pile.length > 1 ? montree(pile) : pile[0]
                const top = y(toMin(s.heure_debut))
                const h = y(toMin(s.heure_fin)) - top
                const canDrag = !!edition && s.statut !== 'annulee' && !s.est_verrouillee
                const aj = canDrag && !glisse && edition?.onAjuster ? edition.ajustements?.get(s.id_seance) : undefined
                return (
                  <div
                    key={pile.length > 1 ? `pile-${pile[0].id_seance}` : s.id_seance}
                    data-seance={s.id_seance}
                    data-pile={pile.length > 1 ? pile.length : undefined}
                    className={cn(
                      'absolute p-0.5',
                      glisse && (glisse.id_seance === s.id_seance ? 'opacity-30' : 'opacity-75'),
                      edition?.copiees?.has(s.id_seance) && 'rounded-[1.1rem] outline-2 -outline-offset-1 outline-navy outline-dashed',
                      edition?.copiees?.has(s.id_seance) && edition.coupee && 'opacity-50',
                    )}
                    style={{ top, height: h, left: `${(p.lane / p.of) * 100}%`, width: `${100 / p.of}%` }}
                    onContextMenu={edition?.onMenuSeance
                      ? (e) => { e.preventDefault(); e.stopPropagation(); edition.onMenuSeance!(e.clientX, e.clientY, s) }
                      : undefined}
                  >
                    <EventCard
                      s={s}
                      hide={hide}
                      compact={p.of > 2}
                      hauteur={h - 4 /* p-0.5 autour de la carte */}
                      selected={selectedId === s.id_seance}
                      cochee={edition?.cochees?.has(s.id_seance)}
                      draggable={canDrag}
                      onDragStart={canDrag
                        ? (e) => edition!.onDragStartSeance(s, e, ((e.clientY - e.currentTarget.getBoundingClientRect().top) / pxHeure) * 60)
                        : undefined}
                      onDragEnd={edition?.onDragEnd}
                      onClick={onSelect ? (m) => onSelect(s, m) : undefined}
                      onOuvrir={onOuvrir ? () => onOuvrir(s) : undefined}
                      onPlus={aj?.plus ? () => edition!.onAjuster!(s, 1) : undefined}
                      plusTitre={aj?.plus}
                      onMoins={aj?.moins ? () => edition!.onAjuster!(s, -1) : undefined}
                      moinsTitre={aj?.moins}
                      onglets={pile.length > 1 && (
                        <Onglets
                          pile={pile}
                          montree={s.id_seance}
                          onChoisir={(id) => montrer([id])}
                          marquees={(id) => selectedId === id || !!edition?.cochees?.has(id)}
                        />
                      )}
                    />
                  </div>
                )
              })}
              {list.length === 0 && !ferie && crs.length > 0 && renderEmptyDay?.(d)}

              {/* heures sélectionnées, pour programmer une séance de cours ou une épreuve */}
              {selection?.date === d && (
                <div
                  data-selection
                  className={cn(
                    'pointer-events-none absolute inset-x-1 z-10 flex flex-col overflow-hidden rounded-2xl border-2 px-2.5 py-1.5 text-[12px] leading-snug shadow-sm',
                    selection.fin - selection.debut >= 120 ? 'border-navy bg-navy/10 text-navy' : 'border-dashed border-ink-2 bg-white/70 text-ink-2',
                  )}
                  style={{ top: y(selection.debut), height: y(selection.fin) - y(selection.debut) }}
                >
                  <span className="font-mono text-[11px] tabular-nums">{fmtHeure(fromMin(selection.debut))}–{fmtHeure(fromMin(selection.fin))}</span>
                  {selection.fin - selection.debut >= 120
                    ? <span className="font-medium">{(selection.fin - selection.debut) / 60} h · clic droit</span>
                    : <span>2 h au moins</span>}
                </div>
              )}

              {/* où la séance atterrirait */}
              {glisse && cible?.date === d && (() => {
                const st = edition?.slot?.(d, cible.heure)
                const debut = toMin(cible.heure)
                return (
                  <div
                    data-apercu={st?.ok ? 'ok' : 'refus'}
                    aria-hidden
                    className={cn(
                      'pointer-events-none absolute inset-x-1 z-20 flex flex-col overflow-hidden rounded-2xl border-2 border-dashed px-2.5 py-1.5 text-[12px] leading-snug shadow-lg transition-[top] duration-75 motion-reduce:transition-none',
                      st?.ok ? 'border-[#15803D] bg-[#DCFCE7]/95 text-[#166534]' : 'border-[#B91C1C] bg-[#FEE2E2]/95 text-[#991B1B]',
                    )}
                    style={{ top: y(debut), height: glisse.duree * pxHeure }}
                  >
                    <span className="font-mono text-[11px] tabular-nums">{fmtHeure(cible.heure)}–{fmtHeure(fromMin(debut + glisse.duree * 60))}</span>
                    {st?.detail && <span className="truncate font-medium">{st.detail}</span>}
                  </div>
                )
              })()}
            </div>
          )
        })}
        {bandes && bande(1)}
      </div>
    </div>
  )
}
