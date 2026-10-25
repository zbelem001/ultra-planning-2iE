// Vue « semestre » (équivalent du « planning » d'HyperPlanning) :
// une ligne par semaine, une frise horaire par jour.

import { cn } from '@/components/ui'
import type { Db } from '@/types/db'
import { couleurMatiere, type SeanceVue } from '@/lib/queries'
import { fermeture } from '@/lib/rules'
import { addDays, fmtJourMois, fmtHeure, isoWeek, jourOf, JOURS, mondayOf, todayIso, toMin } from '@/lib/time'
import { bornesGrille } from './WeekGrid'

export function SemesterView({ db, weeks, seances, onPickWeek, idClasse }: {
  idClasse?: number | null
  db: Db
  weeks: string[]
  seances: SeanceVue[]
  onPickWeek: (monday: string) => void
}) {
  const [start, end] = bornesGrille(db)
  const nbJours = db.creneau.some((c) => c.jour === 'Samedi') || seances.some((s) => jourOf(s.date_seance) === 'Samedi') ? 6 : 5
  const jours = JOURS.slice(0, nbJours)
  const current = mondayOf(todayIso())
  const pct = (m: number) => ((m - start) / (end - start)) * 100

  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-y-1 text-sm">
        <thead>
          <tr>
            <th className="section-label w-32 px-2 pb-1 text-left font-medium">Semaine</th>
            {jours.map((j) => (
              <th key={j} className="section-label px-1 pb-1 text-left font-medium">{j}</th>
            ))}
            <th className="section-label w-16 px-2 pb-1 text-right font-medium">Heures</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => {
            const ws = seances.filter((s) => s.date_seance >= w && s.date_seance <= addDays(w, 6))
            const h = ws.filter((s) => s.statut !== 'annulee').reduce((a, s) => a + s.duree, 0)
            return (
              <tr key={w} className="group cursor-pointer" onClick={() => onPickWeek(w)}>
                <td className={cn('rounded-l-2xl px-2 py-1.5 group-hover:bg-white', w === current ? 'bg-white' : 'bg-white/50')}>
                  <span className="flex items-center gap-2">
                    <span className={cn('grid h-7 w-9 place-items-center rounded-full font-mono text-xs tabular-nums', w === current ? 'bg-navy text-white' : 'bg-muted')}>{isoWeek(w)}</span>
                    <span className="text-xs text-ink-2">{fmtJourMois(w)}</span>
                  </span>
                </td>
                {jours.map((_, i) => {
                  const d = addDays(w, i)
                  const ferie = fermeture(db, d, idClasse)
                  return (
                    <td key={i} className={cn('px-1 py-1.5 group-hover:bg-white', w === current ? 'bg-white' : 'bg-white/50')}>
                      <div className={cn('relative h-6 rounded-full bg-muted', ferie && 'hatched bg-orange-soft/60')} title={ferie?.libelle}>
                        {db.pause.map((p) => (
                          <div key={p.id_pause} className="hatched absolute inset-y-0" style={{ left: `${pct(toMin(p.heure_debut))}%`, width: `${pct(toMin(p.heure_fin)) - pct(toMin(p.heure_debut))}%` }} />
                        ))}
                        {ws.filter((s) => s.date_seance === d).map((s) => (
                          <div
                            key={s.id_seance}
                            title={`${s.matiere.libelle} (${s.cours.type_cours}) · ${fmtHeure(s.heure_debut)}–${fmtHeure(s.heure_fin)} · ${s.salle.nom_salle}${s.statut === 'annulee' ? ' · annulée' : ''}`}
                            className={cn('absolute inset-y-0.5 rounded-full', s.statut === 'annulee' && 'opacity-35')}
                            style={{ left: `${pct(toMin(s.heure_debut))}%`, width: `calc(${pct(toMin(s.heure_fin)) - pct(toMin(s.heure_debut))}% - 2px)`, backgroundColor: couleurMatiere(s.matiere.id_matiere) }}
                          />
                        ))}
                      </div>
                    </td>
                  )
                })}
                <td className={cn('rounded-r-2xl px-2 py-1.5 text-right font-mono text-xs tabular-nums group-hover:bg-white', w === current ? 'bg-white' : 'bg-white/50')}>{h} h</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
