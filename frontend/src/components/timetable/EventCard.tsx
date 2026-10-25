import { Lock, MapPin, User, Users } from 'lucide-react'
import type { DragEvent } from 'react'
import { cn } from '@/components/ui'
import { couleurMatiere, nomEnseignant, publicCours, type SeanceVue } from '@/lib/queries'
import { fmtHeure } from '@/lib/time'

export type Champ = 'enseignant' | 'salle' | 'public'

export function TypeChip({ type }: { type: string }) {
  return <span className="rounded-full bg-white/80 px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink ring-1 ring-black/5">{type}</span>
}

/** Bloc d'une séance dans la grille */
export function EventCard({ s, hide = [], selected, compact, draggable, onDragStart, onDragEnd, onClick }: {
  s: SeanceVue
  hide?: Champ[]
  selected?: boolean
  compact?: boolean
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  onClick?: () => void
}) {
  const color = couleurMatiere(s.matiere.id_matiere)
  const annulee = s.statut === 'annulee'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      aria-label={`${s.matiere.libelle}, ${s.cours.type_cours}, ${fmtHeure(s.heure_debut)} à ${fmtHeure(s.heure_fin)}, ${s.salle.nom_salle}${annulee ? ', annulée' : ''}`}
      className={cn(
        'group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-l-[3px] px-2.5 py-2 text-left text-[12px] leading-snug transition-shadow duration-150',
        draggable && 'cursor-grab active:cursor-grabbing',
        onClick && 'hover:shadow-md focus-visible:shadow-md',
        selected && 'ring-2 ring-navy ring-offset-1',
        annulee && 'hatched opacity-70',
      )}
      style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 13%, white)` }}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[11px] whitespace-nowrap text-ink-2 tabular-nums">
          {fmtHeure(s.heure_debut)}–{fmtHeure(s.heure_fin)}
        </span>
        <span className="flex items-center gap-1">
          {s.est_verrouillee && <Lock className="size-3 text-navy" aria-label="Verrouillée" />}
          <TypeChip type={s.cours.type_cours} />
        </span>
      </div>
      <p className={cn('mt-0.5 font-medium text-ink', annulee && 'line-through', compact ? 'truncate' : 'line-clamp-2')}>{s.matiere.libelle}</p>
      {annulee && <span className="mt-0.5 w-fit rounded-full bg-[#FEE2E2] px-1.5 text-[10px] font-semibold text-[#991B1B]">Annulée</span>}
      {!compact && (
        <div className="mt-auto space-y-0.5 pt-1 text-ink-2">
          {!hide.includes('enseignant') && (
            <p className="flex items-center gap-1 truncate"><User className="size-3 shrink-0" />{nomEnseignant(s.enseignant)}</p>
          )}
          {!hide.includes('public') && (
            <p className="flex items-center gap-1 truncate"><Users className="size-3 shrink-0" />{publicCours(s.classe, s.groupe)}</p>
          )}
          {!hide.includes('salle') && (
            <p className="flex items-center gap-1 truncate"><MapPin className="size-3 shrink-0" />{s.salle.nom_salle}</p>
          )}
        </div>
      )}
    </Tag>
  )
}
