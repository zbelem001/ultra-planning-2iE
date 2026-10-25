import { Lock } from 'lucide-react'
import { Badge, cn } from '@/components/ui'
import { couleurMatiere, nomEnseignant, publicCours, type SeanceVue } from '@/lib/queries'
import { fmtHeure, fmtJourLong } from '@/lib/time'
import { TypeChip } from './EventCard'

/** Vue « en liste » : séances regroupées par jour */
export function ListView({ seances, onSelect }: { seances: SeanceVue[]; onSelect?: (s: SeanceVue) => void }) {
  const byDay = new Map<string, SeanceVue[]>()
  for (const s of [...seances].sort((a, b) => (a.date_seance + a.heure_debut).localeCompare(b.date_seance + b.heure_debut))) {
    byDay.set(s.date_seance, [...(byDay.get(s.date_seance) ?? []), s])
  }
  return (
    <div className="space-y-5">
      {[...byDay.entries()].map(([d, list]) => (
        <section key={d}>
          <h3 className="section-label mb-2 px-1 first-letter:uppercase">{fmtJourLong(d)}</h3>
          <ul className="divide-y divide-line/70 overflow-hidden rounded-3xl bg-white/75 ring-1 ring-white">
            {list.map((s) => {
              const annulee = s.statut === 'annulee'
              const Row = onSelect ? 'button' : 'div'
              return (
                <li key={s.id_seance}>
                  <Row
                    type={onSelect ? 'button' : undefined}
                    onClick={onSelect ? () => onSelect(s) : undefined}
                    className={cn(
                      'grid w-full grid-cols-[4.5rem_1fr] gap-x-4 gap-y-1 px-4 py-3 text-left text-sm sm:grid-cols-[6rem_minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center',
                      onSelect && 'hover:bg-white',
                      annulee && 'hatched',
                    )}
                  >
                    <span className="row-span-3 font-mono text-xs text-ink-2 tabular-nums sm:row-span-1">
                      {fmtHeure(s.heure_debut)}<span className="text-ink-2/60"> – </span>{fmtHeure(s.heure_fin)}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurMatiere(s.matiere.id_matiere) }} />
                      <span className={cn('truncate font-medium', annulee && 'line-through')}>{s.matiere.libelle}</span>
                      <TypeChip type={s.cours.type_cours} />
                      {s.est_verrouillee && <Lock className="size-3.5 text-navy" aria-label="Verrouillée" />}
                    </span>
                    <span className="truncate text-ink-2">{nomEnseignant(s.enseignant)}</span>
                    <span className="truncate text-ink-2">{publicCours(s.classe, s.groupe)}</span>
                    <span className="truncate text-ink-2">{s.salle.nom_salle}</span>
                    <span className="sm:justify-self-end">
                      {annulee ? <Badge tone="danger" dot>Annulée</Badge> : s.statut === 'validee' ? <Badge tone="success" dot>Effectuée</Badge> : <Badge tone="navy" dot>Prévue</Badge>}
                    </span>
                  </Row>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
