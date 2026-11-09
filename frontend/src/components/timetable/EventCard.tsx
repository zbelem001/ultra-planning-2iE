import { Check, Lock, MapPin, Minus, Plus, User, Users } from 'lucide-react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/components/ui'
import { estEpreuve, LIBELLE_NATURE } from '@/lib/publics'
import { couleurMatiere, nomCourtSite, nomEnseignant, type SeanceVue } from '@/lib/queries'
import { fmtHeure } from '@/lib/time'

export type Champ = 'enseignant' | 'salle' | 'public'

/** Touches tenues pendant le clic : Ctrl (Cmd sur Mac) ou Maj ajoutent la séance à une sélection de plusieurs */
export type ModifClic = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export const clicMultiple = (m?: ModifClic) => !!m && (m.ctrlKey || m.metaKey || m.shiftKey)

export function TypeChip({ type }: { type: string }) {
  return <span className="rounded-full bg-white/80 px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink ring-1 ring-black/5">{type}</span>
}

/** Bloc d'une séance dans la grille */
// Hauteurs d'une carte, en px : marges, ligne d'horaire, ligne de titre, ligne de détail, badge « Annulée »
const CARTE_SERREE = 90 // en dessous, marges réduites
const MARGES_CARTE = 20
const MARGES_CARTE_SERREE = 12
const LIGNE_HORAIRE = 18
const LIGNE_TITRE = 19
const LIGNE_DETAIL = 18.5
const BADGE_ANNULEE = 18

export function EventCard({ s, hide = [], selected, cochee, compact, hauteur = Infinity, draggable, onDragStart, onDragEnd, onClick, onOuvrir, onPlus, plusTitre, onMoins, moinsTitre }: {
  s: SeanceVue
  hide?: Champ[]
  selected?: boolean
  /** Dans la sélection de plusieurs séances (Planification) */
  cochee?: boolean
  compact?: boolean
  /** Hauteur de la carte : seul ce qui y tient s'affiche, le détail complet reste au clic */
  hauteur?: number
  draggable?: boolean
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  onClick?: (m: ModifClic) => void
  /** Ouvrir le détail (Planification : double-clic ou Entrée ; le clic simple sélectionne) */
  onOuvrir?: () => void
  /** Petit « + » en bas à droite : allonger la séance d'une heure (Planification), seulement si c'est possible */
  onPlus?: () => void
  plusTitre?: string
  /** Petit « − » à côté : la raccourcir d'une heure */
  onMoins?: () => void
  moinsTitre?: string
}) {
  const color = couleurMatiere(s.matiere.id_matiere)
  const annulee = s.statut === 'annulee'
  const epreuve = estEpreuve(s)
  // Firefox ne glisse pas un <button> : une carte déplaçable est un bloc, cliquable au clavier aussi
  const bouton = !!onClick && !draggable
  const cliquable = !!onClick && !bouton
  const Tag = bouton ? 'button' : 'div'
  const serree = hauteur < CARTE_SERREE
  const place = hauteur - (serree ? MARGES_CARTE_SERREE : MARGES_CARTE) - LIGNE_HORAIRE - LIGNE_TITRE - (annulee ? BADGE_ANNULEE : 0)
  // Le plus utile d'abord : où aller, avec qui (cours mutualisé : une classe par ligne), puis qui enseigne
  const champs = (['salle', 'public', 'enseignant'] as Champ[]).filter((c) => !hide.includes(c) && !(c === 'enseignant' && epreuve))
  const lignes = compact ? 0 : Math.max(0, Math.floor(place / LIGNE_DETAIL))
  const montres: Champ[] = []
  let utilisees = 0
  let nbPublics = 0
  for (const c of champs) {
    if (utilisees >= lignes) break
    montres.push(c)
    if (c === 'public') nbPublics = Math.min(s.publics_libelles.length, lignes - utilisees)
    utilisees += c === 'public' ? nbPublics : 1
  }
  const titreLong = !compact && place - utilisees * LIGNE_DETAIL >= LIGNE_TITRE
  return (
    <Tag
      type={bouton ? 'button' : undefined}
      role={cliquable ? 'button' : undefined}
      tabIndex={cliquable ? 0 : undefined}
      onKeyDown={cliquable ? (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (e.key === 'Enter' && onOuvrir) onOuvrir(); else onClick!(e) }
      } : undefined}
      onDoubleClick={onOuvrir}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      aria-label={`${epreuve ? `${LIBELLE_NATURE[s.nature!]}, ` : ''}${s.matiere.libelle}, ${s.cours.type_cours}, ${fmtHeure(s.heure_debut)} à ${fmtHeure(s.heure_fin)}, ${s.salle.nom_salle}${s.site ? `, ${s.site.nom_site}` : ''}${annulee ? ', annulée' : ''}${cochee ? ', sélectionnée' : ''}`}
      className={cn(
        'group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border-l-[3px] px-2.5 text-left text-[12px] leading-snug transition-shadow duration-150',
        serree ? 'py-1' : 'py-2',
        draggable && 'cursor-grab select-none active:cursor-grabbing',
        onClick && 'hover:shadow-md focus-visible:shadow-md',
        epreuve && 'ring-2 ring-orange',
        (selected || cochee) && 'ring-2 ring-navy ring-offset-1',
        annulee && 'hatched opacity-70',
      )}
      style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 13%, white)` }}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1">
          {cochee && <span className="grid size-3.5 shrink-0 place-items-center rounded-full bg-navy text-white"><Check className="size-2.5" strokeWidth={3.5} /></span>}
          <span className="truncate font-mono text-[11px] whitespace-nowrap text-ink-2 tabular-nums">
            {fmtHeure(s.heure_debut)}–{fmtHeure(s.heure_fin)}
          </span>
        </span>
        <span className="flex items-center gap-1">
          {s.est_verrouillee && <Lock className="size-3 text-navy" aria-label="Verrouillée" />}
          {epreuve
            ? <span className="rounded-full bg-orange px-1.5 py-px text-[10px] font-semibold tracking-wide text-navy">{LIBELLE_NATURE[s.nature!]}</span>
            : <TypeChip type={s.cours.type_cours} />}
        </span>
      </div>
      <p className={cn('mt-0.5 font-medium text-ink', annulee && 'line-through', titreLong ? 'line-clamp-2' : 'truncate')}>{s.matiere.libelle}</p>
      {annulee && <span className="mt-0.5 w-fit rounded-full bg-[#FEE2E2] px-1.5 text-[10px] font-semibold text-[#991B1B]">Annulée</span>}
      {montres.length > 0 && (
        // place laissée aux petits « + » et « − » du coin : le texte s'arrête avant eux
        <div className={cn('mt-auto space-y-0.5 pt-1 text-ink-2', !bouton && (onPlus && onMoins ? 'pr-11' : (onPlus || onMoins) && 'pr-5'))}>
          {montres.includes('enseignant') && (
            <p className="flex items-center gap-1 truncate"><User className="size-3 shrink-0" />{nomEnseignant(s.enseignant)}</p>
          )}
          {montres.includes('public') && <Publics libelles={s.publics_libelles} lignes={nbPublics} />}
          {montres.includes('salle') && (
            <p className="flex items-center gap-1 truncate" title={s.site?.nom_site}>
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{s.salle.nom_salle}{s.site && <span className="text-ink-2/80"> · {nomCourtSite(s.site)}</span>}</span>
            </p>
          )}
        </div>
      )}
      {(onPlus || onMoins) && !bouton && (
        <span className="absolute right-1 bottom-1 z-10 flex gap-1">
          {onMoins && <BoutonDuree titre={moinsTitre ?? "Raccourcir la séance d'une heure"} onClick={onMoins} attribut="data-moins"><Minus className="size-3" strokeWidth={2.5} /></BoutonDuree>}
          {onPlus && <BoutonDuree titre={plusTitre ?? "Allonger la séance d'une heure"} onClick={onPlus} attribut="data-plus"><Plus className="size-3" strokeWidth={2.5} /></BoutonDuree>}
        </span>
      )}
    </Tag>
  )
}

/** Les classes d'une séance, une par ligne (cours mutualisé) ; « +2 » au bout quand toutes ne tiennent pas */
function Publics({ libelles, lignes }: { libelles: string[]; lignes: number }) {
  const vus = libelles.slice(0, lignes)
  const caches = libelles.length - vus.length
  return vus.map((l, i) => (
    <p key={l} className="flex items-center gap-1" title={libelles.length > 1 ? libelles.join('\n') : undefined}>
      <Users className="size-3 shrink-0" />
      <span className="truncate">{l}</span>
      {i === vus.length - 1 && caches > 0 && <span className="shrink-0 font-semibold">+{caches}</span>}
    </p>
  ))
}

function BoutonDuree({ titre, onClick, attribut, children }: { titre: string; onClick: () => void; attribut: 'data-plus' | 'data-moins'; children: ReactNode }) {
  return (
    <button
      type="button"
      {...{ [attribut]: '' }}
      aria-label={titre}
      title={titre}
      // ni ouvrir le détail, ni commencer une sélection d'heures
      onClick={(e) => { e.stopPropagation(); onClick() }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="press grid size-5 place-items-center rounded-full bg-white text-navy opacity-70 shadow-sm ring-1 ring-navy/25 transition-opacity group-hover:opacity-100 hover:bg-navy hover:text-white focus-visible:opacity-100"
    >
      {children}
    </button>
  )
}
