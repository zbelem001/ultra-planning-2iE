// Grille horaire (vue semaine ou jour). En mode édition, chaque créneau de la
// grille de base devient une zone de dépôt colorée selon les contraintes dures.

import type { DragEvent, ReactNode } from 'react'
import { useHauteurRestante } from '@/lib/hauteur'
import { cn } from '@/components/ui'
import type { Db } from '@/types/db'
import type { SeanceVue } from '@/lib/queries'
import { fermeture } from '@/lib/rules'
import { addDays, fmtHeure, fmtJourCourt, fromMin, jourOf, todayIso, toMin } from '@/lib/time'
import { EventCard, type Champ } from './EventCard'

const PX_HEURE = 68

export interface SlotState {
  ok: boolean
  raison?: string
}

export interface GridEdition {
  /** Vrai pendant un glisser : les séances laissent passer le pointeur vers les zones de dépôt */
  dragging: boolean
  /** État d'un créneau pendant un glisser-déposer (undefined = pas de glisser en cours) */
  slot?: (date: string, heure: string) => SlotState | undefined
  onDrop: (date: string, heure: string, e: DragEvent) => void
  onDragStartSeance: (s: SeanceVue, e: DragEvent) => void
  onDragEnd: () => void
  /** Créneau survolé pendant le glisser, pour afficher le motif d'un refus */
  onHover?: (date: string, heure: string) => void
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
  /** Agrandir les heures pour occuper l'espace restant jusqu'au bas de l'écran */
  remplir?: boolean
}) {
  const [start, end] = bornesGrille(db)
  const [refGrille, disponible] = useHauteurRestante<HTMLDivElement>(16)
  // En-tête des jours (≈ 44 px) et marge du bas (12 px) déduits ; jamais plus petit qu'avant
  const pxHeure = remplir && disponible ? Math.max(PX_HEURE, (disponible - 56) / ((end - start) / 60)) : PX_HEURE
  const height = ((end - start) / 60) * pxHeure
  const heuresLabels: number[] = []
  for (let m = start; m <= end; m += 60) heuresLabels.push(m)
  const today = todayIso()
  const y = (min: number) => ((min - start) / 60) * pxHeure

  return (
    <div ref={refGrille} className="overflow-x-auto pt-1 pb-3 scroll-thin">
      <div
        className="grid"
        style={{ gridTemplateColumns: `3.25rem repeat(${days.length}, minmax(${days.length > 1 ? '9.5rem' : '0'}, 1fr))`, minWidth: days.length > 1 ? `${3.25 + days.length * 9.5}rem` : undefined }}
      >
        {/* En-têtes */}
        <div />
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

        {/* Heures */}
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
            <div key={d} className="relative mx-0.5 rounded-2xl bg-white/55 ring-1 ring-white" style={{ height }}>
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

              {/* zones de dépôt */}
              {edition && !ferie && crs.map((c) => {
                const st = edition.slot?.(d, c.heure_debut)
                return (
                  <div
                    key={c.id_creneau}
                    data-slot={`${d}|${c.heure_debut}`}
                    title={st && !st.ok ? st.raison : undefined}
                    onDragEnter={() => edition.onHover?.(d, c.heure_debut)}
                    onDragOver={(e) => { if (st?.ok) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } }}
                    onDrop={(e) => { e.preventDefault(); edition.onDrop(d, c.heure_debut, e) }}
                    className={cn(
                      'absolute inset-x-1 rounded-xl transition-colors duration-150',
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
                return (
                  <div
                    key={s.id_seance}
                    className={cn('absolute p-0.5', edition?.dragging && 'pointer-events-none')}
                    style={{ top, height: h, left: `${(p.lane / p.of) * 100}%`, width: `${100 / p.of}%` }}
                  >
                    <EventCard
                      s={s}
                      hide={hide}
                      compact={h < 80 || p.of > 2}
                      selected={selectedId === s.id_seance}
                      draggable={canDrag}
                      onDragStart={canDrag ? (e) => edition!.onDragStartSeance(s, e) : undefined}
                      onDragEnd={edition?.onDragEnd}
                      onClick={onSelect ? () => onSelect(s) : undefined}
                    />
                  </div>
                )
              })}
              {list.length === 0 && !ferie && crs.length > 0 && renderEmptyDay?.(d)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
