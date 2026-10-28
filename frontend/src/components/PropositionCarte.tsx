// Proposition de l'assistant IA : ce qu'elle change, ce qu'elle coûte, et la décision du planificateur.
// Deux natures : séances (déplacements, ajouts, génération…) ou ajouts au référentiel, suivis
// éventuellement d'une génération lancée dès leur validation.

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
  const { db, recharger, connecte } = useStore()
  const referentiel = p.nature === 'referentiel'
  const enDirect = !referentiel && db.emploi_du_temps.find((e) => e.id_edt === p.id_edt)?.statut === 'publie'
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
        if (r.nature === 'referentiel') {
          toast.success(`Référentiel complété (${r.lignes_ajoutees} ligne(s) ajoutée(s))`, {
            description: r.suite
              ? r.suite.id_proposition
                ? `Génération lancée : proposition ${r.suite.id_proposition} à valider dans la discussion.`
                : r.suite.message
              : undefined,
          })
          await recharger()
          return
        }
        const n = r.notification
        const prevenus = n?.statut === 'en_cours' ? ` ${n.destinataires} enseignant(s) prévenu(s) par e-mail.`
          : n?.statut === 'smtp_non_configure' ? ' E-mails non envoyés (SMTP non configuré).' : ''
        toast.success(r.en_direct ? `Proposition ${p.id_proposition} appliquée en direct` : `Proposition ${p.id_proposition} appliquée`, {
          description: [
            r.seances_creees && `${r.seances_creees} ajoutée(s)`,
            r.seances_modifiees && `${r.seances_modifiees} modifiée(s)`,
            r.seances_supprimees && `${r.seances_supprimees} retirée(s)`,
          ].filter(Boolean).join(', ') + ', validées par la base.'
            + (r.en_direct ? ` Déjà visible dans l'espace invités.${prevenus}` : ' Visible par les invités après publication.'),
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

      {referentiel ? (
        <>
          <p className="mt-3 section-label">Ajouts au référentiel</p>
          <ul className="mt-1 space-y-1 text-ink-2">
            {(p.modifications as { libelle: string }[]).map((o) => (
              <li key={o.libelle} className="flex gap-1.5"><span className="text-[#166534]">+</span><span>{o.libelle}</span></li>
            ))}
          </ul>
          {p.suite && (
            <p className="mt-2 text-ink-2">
              Puis génération : {p.suite.description} (nouvelle proposition de séances, à valider à son tour).
            </p>
          )}
        </>
      ) : (
        <ul className="mt-3 space-y-1 text-ink-2">
          <li>
            {[
              `${i.seances_deplacees ?? 0} séance(s) déplacée(s)`,
              (!compacte || !!i.seances_supprimees) && `${i.seances_supprimees ?? 0} retirée(s) ou annulée(s)`,
              (!compacte || !!i.seances_creees) && `${i.seances_creees ?? 0} ajoutée(s)`,
            ].filter(Boolean).join(', ')}
            {i.classes_concernees?.length ? ` · ${i.classes_concernees.join(', ')}` : ''}
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
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-2">
          Calculée le {fmtDateHeure(p.date_creation)}
          {p.statut === 'en_attente' && enDirect && ' · version publiée : visible tout de suite par les invités'}
        </span>
        {p.statut === 'en_attente' && connecte && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={encours} onClick={() => void decider('rejeter')}><X />Rejeter</Button>
            <Button size="sm" variant={perdues ? 'outline' : 'primary'} disabled={encours} onClick={() => void decider('appliquer')}>
              <Check />{referentiel ? (p.suite ? 'Ajouter et planifier' : 'Ajouter au référentiel') : enDirect ? 'Appliquer en direct' : 'Appliquer'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
