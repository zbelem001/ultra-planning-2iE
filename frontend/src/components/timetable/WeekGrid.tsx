// Grille horaire (vue semaine ou jour). En mode édition, pendant un glisser, chaque créneau est
// coloré selon les contraintes dures et un bloc montre où la séance atterrirait. Le créneau visé
// se déduit de la position du pointeur et de l'endroit où la séance a été saisie (lib/glisser.ts).

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as SourisReact, type PointerEvent as PointeurReact, type ReactNode } from 'react'
import { useSurfaceDepot } from '@/lib/glisser'
import { cn } from '@/components/ui'
import type { Db } from '@/types/db'
import type { SeanceVue } from '@/lib/queries'
import { fermeture } from '@/lib/rules'
import { estEpreuve } from '@/lib/publics'
import { addDays, fmtHeure, fmtJourCourt, fromMin, jourOf, todayIso, toMin } from '@/lib/time'
import { EventCard, type Champ } from './EventCard'

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
  /** Séance copiée : encadrée en pointillé */
  copiee?: number | null
  /** Petit « + » d'une séance : l'allonger d'une heure */
  onAllonger?: (s: SeanceVue) => void
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

/** Répartit les séances qui se chevauchent sur des colonnes côte à côte */
function lanes(list: SeanceVue[]): Map<number, { lane: number; of: number }> {
  const sorted = [...list].sort((a, b) => a.heure_debut.localeCompare(b.heure_debut) || b.duree - a.duree)
  const out = new Map<number, { lane: number; of: number }>()
  let cluster: SeanceVue[] = []
  let clusterEnd = -1
  let ends: number[] = []
  const flush = () => {
    for (const s of cluster) out.get(s.id_seance)!.of = ends.length
    cluster = []
    ends = []
  }
  for (const s of sorted) {
    const d = toMin(s.heure_debut)
    if (d >= clusterEnd) { flush(); clusterEnd = -1 }
    let lane = ends.findIndex((e) => e <= d)
    if (lane === -1) { lane = ends.length; ends.push(0) }
    ends[lane] = toMin(s.heure_fin)
    clusterEnd = Math.max(clusterEnd, toMin(s.heure_fin))
    out.set(s.id_seance, { lane, of: 0 })
    cluster.push(s)
  }
  flush()
  return out
}

export function WeekGrid({ db, days, seances, hide, selectedId, onSelect, edition, renderEmptyDay, idClasse, remplir }: {
  db: Db
  /** Classe affichée : ses congés propres sont aussi grisés */
  idClasse?: number | null
  days: string[]
  seances: SeanceVue[]
  hide?: Champ[]
  selectedId?: number | null
  onSelect?: (s: SeanceVue) => void
  edition?: GridEdition
  renderEmptyDay?: (date: string) => ReactNode
  /** Ajuster les heures pour occuper exactement la hauteur du parent, dont la hauteur est fixée */
  remplir?: boolean
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
  const pxHeure = remplir && disponible ? Math.max(PX_HEURE_MIN_REMPLI, disponible / ((end - start) / 60)) : PX_HEURE
  const height = ((end - start) / 60) * pxHeure
  const remJour = remplir ? REM_JOUR_REMPLI : REM_JOUR
  const heuresLabels: number[] = []
  for (let m = start; m <= end; m += 60) heuresLabels.push(m)
  const today = todayIso()
  const y = (min: number) => ((min - start) / 60) * pxHeure
  const glisse = edition?.glisse ?? null
  const cible = edition?.cible ?? null

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
    <div ref={refGrille} className="overflow-x-auto pt-1 pb-3 scroll-thin">
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
        {days.map((d) => {
          const jour = jourOf(d)
          const ferie = fermeture(db, d, idClasse)
          const crs = db.creneau.filter((c) => c.jour === jour)
          const list = seances.filter((s) => s.date_seance === d)
          const pos = lanes(list)
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
              className={cn('relative mx-0.5 rounded-2xl bg-white/55 ring-1 ring-white', edition?.onSelection && 'cursor-cell select-none')}
              style={{ height }}
            >
              {/* lignes horaires */}
              {heuresLabels.slice(1, -1).map((m) => (
                <div key={m} className="absolute inset-x-0 border-t border-dashed border-line/80" style={{ top: y(m) }} />
              ))}
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
              {list.map((s) => {
                const p = pos.get(s.id_seance)!
                const top = y(toMin(s.heure_debut))
                const h = y(toMin(s.heure_fin)) - top
                const canDrag = !!edition && s.statut !== 'annulee' && !s.est_verrouillee
                // « + » seulement si l'heure suivante existe ce jour-là, sans pause, et sous la durée maximale
                const fin = toMin(s.heure_fin) + 60
                const peutAllonger = canDrag && !glisse && !!edition?.onAllonger
                  && s.duree + 1 <= (estEpreuve(s) ? 3 : 5)
                  && finsPossibles(db, s.date_seance, s.heure_debut, [fin - toMin(s.heure_debut)]).length > 0
                return (
                  <div
                    key={s.id_seance}
                    data-seance={s.id_seance}
                    className={cn(
                      'absolute p-0.5',
                      glisse && (glisse.id_seance === s.id_seance ? 'opacity-30' : 'opacity-75'),
                      edition?.copiee === s.id_seance && 'rounded-[1.1rem] outline-2 -outline-offset-1 outline-navy outline-dashed',
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
                      draggable={canDrag}
                      onDragStart={canDrag
                        ? (e) => edition!.onDragStartSeance(s, e, ((e.clientY - e.currentTarget.getBoundingClientRect().top) / pxHeure) * 60)
                        : undefined}
                      onDragEnd={edition?.onDragEnd}
                      onClick={onSelect ? () => onSelect(s) : undefined}
                      onPlus={peutAllonger ? () => edition!.onAllonger!(s) : undefined}
                      plusTitre={`Allonger d'une heure (jusqu'à ${fmtHeure(fromMin(fin))})`}
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
