// Une ligne du panneau « Cours à placer » (Planification). Composant mémorisé : après une modification, seules
// les lignes dont les heures changent se redessinent (une classe peut avoir plus de 150 cours).
// Une ligne peut aussi être une matière au programme de la classe qui n'a pas encore de cours (`nouveau`) : son
// cours est créé au premier dépôt d'une durée sur la grille.

import { GripVertical } from 'lucide-react'
import { memo, type DragEvent } from 'react'
import { Badge, cn } from '@/components/ui'
import type { DureeAPlacer, EtatAPlacer } from '@/lib/aPlacer'
import { couleurType } from '@/lib/queries'
import type { Cours } from '@/types/db'

interface Props {
  c: Cours
  id_matiere: number
  libelle: string
  /** « CM · L2INFO · Adama Ouédraogo » */
  detail: string
  plan: number
  annulees: number
  etat: EtatAPlacer
  durees: DureeAPlacer[]
  reste: number
  /** Au programme, sans cours encore : le cours sera créé au dépôt */
  nouveau?: boolean
  /** Ces deux fonctions ne changent pas d'effet d'un rendu à l'autre : elles n'entrent pas dans la comparaison */
  onGlisser: (c: Cours, duree: number, ev: DragEvent) => void
  onFin: () => void
}

function Ligne({ c, libelle, detail, plan, annulees, etat, durees, reste, nouveau, onGlisser, onFin }: Props) {
  return (
    <li data-cours-a-placer={nouveau ? 'nouveau' : c.id_cours} className={cn('rounded-2xl p-3 ring-1', etat === 'volume_atteint' ? 'bg-white/45 ring-white/70' : nouveau ? 'border border-dashed border-navy/30 bg-white/80 ring-0' : 'bg-white/80 ring-white')}>
      <div className="flex items-start gap-2">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurType(c.type_cours) }} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{libelle}</p>
          <p className="truncate text-xs text-ink-2">{detail}</p>
          {nouveau && <p className="mt-0.5 text-[11px] text-navy">Au programme, pas encore de cours : il sera créé au dépôt</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {etat === 'volume_atteint' && <Badge tone="success" dot>Volume atteint</Badge>}
        {etat === 'reste_trop_court' && <Badge tone="warning" dot>{reste} h restante : 2 h minimum</Badge>}
        {etat === 'a_placer' && durees.map((o) => o.ok ? (
          <div
            key={o.duree}
            draggable
            onDragStart={(ev) => onGlisser(c, o.duree, ev)}
            onDragEnd={onFin}
            data-au-dela={o.auDela ? '' : undefined}
            className={cn(
              'press flex cursor-grab items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium select-none active:cursor-grabbing',
              o.habituelle ? 'bg-navy text-white' : 'bg-white text-navy ring-1 ring-navy/40 hover:bg-subtle',
              // au-delà du rythme souhaité (CS-08) : possible, signalé
              o.auDela && 'ring-2 ring-orange',
            )}
            title={`Glisser sur la grille : une séance de ${o.duree} h${o.habituelle ? ' (durée des séances types du cours)' : ''}${nouveau ? ' (le cours est créé avec le volume du programme)' : ''}${o.auDela ? `. ${o.auDela}` : ''}`}
          >
            <GripVertical className="size-3" />{o.duree} h
          </div>
        ) : (
          <span
            key={o.duree}
            aria-disabled
            className="flex cursor-not-allowed items-center rounded-full bg-muted px-2.5 py-1 text-xs text-ink-2/60 line-through decoration-ink-2/40 select-none"
            title={o.raison}
          >
            {o.duree} h
          </span>
        ))}
        <span className="ml-auto font-mono text-[11px] text-ink-2 tabular-nums">{plan}/{c.volume_horaire} h</span>
      </div>
      {annulees > 0 && reste > 0 && (
        <p className="mt-1.5 text-[11px] text-[#7C4A03]">dont {Math.min(annulees, reste)} h de séances annulées, à replacer</p>
      )}
    </li>
  )
}

export const LigneAPlacer = memo(Ligne, (a, b) =>
  a.c === b.c && a.id_matiere === b.id_matiere && a.libelle === b.libelle && a.detail === b.detail && a.plan === b.plan
  && a.annulees === b.annulees && a.etat === b.etat && a.reste === b.reste && a.nouveau === b.nouveau && JSON.stringify(a.durees) === JSON.stringify(b.durees))
