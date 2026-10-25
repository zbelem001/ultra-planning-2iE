// Sélecteur de semaines inspiré d'HyperPlanning : numéros de semaine regroupés par mois.

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button, cn } from '@/components/ui'
import { addDays, fmtJourMois, fmtMois, isoWeek, mondayOf, todayIso } from '@/lib/time'

export function WeekStrip({ weeks, value, onChange, counts }: {
  weeks: string[]
  value: string
  onChange: (monday: string) => void
  /** Nombre de séances par semaine, pour griser les semaines vides */
  counts?: Map<string, number>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const current = mondayOf(todayIso())
  const idx = weeks.indexOf(value)

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [value])

  const months: { label: string; weeks: string[] }[] = []
  for (const w of weeks) {
    const label = fmtMois(addDays(w, 3))
    const last = months[months.length - 1]
    if (last?.label === label) last.weeks.push(w)
    else months.push({ label, weeks: [w] })
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon-sm" aria-label="Semaine précédente" disabled={idx <= 0} onClick={() => onChange(weeks[idx - 1])}>
        <ChevronLeft />
      </Button>
      <div ref={ref} className="flex min-w-0 flex-1 gap-3 overflow-x-auto py-1 scroll-thin">
        {months.map((m) => (
          <div key={m.label + m.weeks[0]} className="shrink-0">
            <p className="section-label mb-1 px-1 capitalize">{m.label}</p>
            <div className="flex gap-1">
              {m.weeks.map((w) => {
                const selected = w === value
                const empty = counts && !counts.get(w)
                return (
                  <button
                    key={w}
                    type="button"
                    data-selected={selected}
                    onClick={() => onChange(w)}
                    title={`Semaine ${isoWeek(w)} · du ${fmtJourMois(w)} au ${fmtJourMois(addDays(w, 5))}`}
                    aria-label={`Semaine ${isoWeek(w)}, du ${fmtJourMois(w)} au ${fmtJourMois(addDays(w, 5))}`}
                    aria-pressed={selected}
                    className={cn(
                      'press relative grid h-9 w-10 place-items-center rounded-full font-mono text-xs tabular-nums',
                      selected ? 'bg-navy text-white shadow-sm' : 'bg-white/70 text-ink hover:bg-white',
                      empty && !selected && 'text-ink-2/60',
                    )}
                  >
                    {isoWeek(w)}
                    {w === current && <span className={cn('absolute -bottom-0.5 size-1.5 rounded-full', selected ? 'bg-orange' : 'bg-orange')} aria-hidden />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <Button variant="outline" size="icon-sm" aria-label="Semaine suivante" disabled={idx >= weeks.length - 1} onClick={() => onChange(weeks[idx + 1])}>
        <ChevronRight />
      </Button>
    </div>
  )
}
