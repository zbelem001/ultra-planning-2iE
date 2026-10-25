// Proposition de l'assistant IA : ce qu'elle change, ce qu'elle coûte, et la décision du planificateur.

import { AlertTriangle, Check, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@/components/ui'
import { appliquerProposition, rejeterProposition } from '@/lib/api'
import { useStore } from '@/lib/store'
import { fmtDateHeure, fmtJourMois } from '@/lib/time'
import type { Proposition } from '@/types/db'

const STATUTS = {
  en_attente: { label: 'En attente', tone: 'warning' },
  appliquee: { label: 'Appliquée', tone: 'success' },
  rejetee: { label: 'Rejetée', tone: 'neutral' },
} as const

export function PropositionCarte({ p, compacte }: { p: Proposition; compacte?: boolean }) {
  const { recharger, connecte } = useStore()
  const [encours, setEncours] = useState(false)
  const i = p.impact ?? {}
  const perdues = (i.heures_perdues ?? []).reduce((a, h) => a + h.heures, 0)
  const reportees = (i.heures_reportees ?? []).reduce((a, h) => a + h.heures, 0)
  const st = STATUTS[p.statut]

  const decider = async (action: 'appliquer' | 'rejeter') => {
    setEncours(true)
    try {
      if (action === 'appliquer') {
        const r = await appliquerProposition(p.id_proposition)
        toast.success(`Proposition ${p.id_proposition} appliquée`, {
          description: `${r.seances_supprimees} séance(s) retirée(s), ${r.seances_creees} créée(s), validées par la base.`,
        })
      } else {
        await rejeterProposition(p.id_proposition)
        toast.success(`Proposition ${p.id_proposition} rejetée`)
      }
      await recharger()
    } catch (e) {
      toast.error(action === 'appliquer' ? 'Application refusée' : 'Rejet impossible', { description: (e as Error).message })
      await recharger()
    } finally {
      setEncours(false)
    }
  }

  return (
    <div className={cn('rounded-3xl bg-white/90 p-4 text-sm ring-1', perdues ? 'ring-orange-soft' : 'ring-line')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">Proposition {p.id_proposition}</p>
          <p className="text-ink-2">{p.description}</p>
        </div>
        <Badge tone={st.tone} dot>{st.label}</Badge>
      </div>

      <ul className="mt-3 space-y-1 text-ink-2">
        <li>
          {i.seances_deplacees ?? 0} séance(s) déplacée(s)
          {i.classes_concernees?.length ? ` · ${i.classes_concernees.join(', ')}` : ''}
          {!compacte && ` · ${i.seances_supprimees ?? 0} retirée(s), ${i.seances_creees ?? 0} créée(s)`}
        </li>
        {perdues > 0 && (
          <li className="flex items-start gap-1.5 text-[#7C4A03]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {perdues} h ne seraient plus programmées :{' '}
              {(i.heures_perdues ?? []).map((h) => `${h.cours} (${h.heures} h, ${h.regle})`).join(' ; ')}
            </span>
          </li>
        )}
        {reportees > 0 && (
          <li>
            {reportees} h restent à programmer après la période : {(i.heures_reportees ?? []).map((h) => `${h.cours} ${h.heures} h`).join(', ')}
          </li>
        )}
        {!!i.enseignants_a_prevenir?.length && (
          <li>Enseignants à prévenir : {i.enseignants_a_prevenir.map((e) => e.enseignant).join(', ')}</li>
        )}
        {(i.fins_decalees ?? []).map((f) => (
          <li key={f.cours}>
            {f.cours} finit le {fmtJourMois(f.fin_apres)} au lieu du {fmtJourMois(f.fin_avant)}
          </li>
        ))}
        {(i.journees_chargees ?? []).map((j) => (
          <li key={j.enseignant + j.date}>Journée chargée : {j.enseignant}, {j.heures} h le {fmtJourMois(j.date)}</li>
        ))}
        {(i.changements_de_site ?? []).map((s) => (
          <li key={s.classe + s.date}>{s.classe} change de site le {fmtJourMois(s.date)}</li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-2">Calculée le {fmtDateHeure(p.date_creation)}</span>
        {p.statut === 'en_attente' && connecte && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={encours} onClick={() => void decider('rejeter')}><X />Rejeter</Button>
            <Button size="sm" variant={perdues ? 'outline' : 'primary'} disabled={encours} onClick={() => void decider('appliquer')}>
              <Check />Appliquer
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
