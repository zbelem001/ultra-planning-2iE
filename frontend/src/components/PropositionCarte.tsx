// Proposition de l'assistant IA : ce qu'elle change, ce qu'elle coûte, et la décision du planificateur.
// Deux natures : séances (déplacements, ajouts, génération…) ou changements du référentiel (lignes
// ajoutées, modifiées ou supprimées, calendrier et enseignants compris), suivis éventuellement d'une
// génération ou d'une replanification lancée dès leur validation.

import { AlertTriangle, Check, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, cn } from '@/components/ui'
import { appliquerProposition, rejeterProposition } from '@/lib/api'
import { useStore } from '@/lib/store'
import { fmtDateHeure, fmtJourMois } from '@/lib/time'
import type { OperationReferentiel, Proposition } from '@/types/db'

// Signe de chaque changement du référentiel : ajout, modification, suppression
function signe(o: OperationReferentiel): { car: string; couleur: string } {
  if (o.action === 'supprimer_ligne' || (o.action === 'disponibilite' && o.niveau == null)) return { car: '−', couleur: 'text-[#9F1239]' }
  if (o.action === 'ajouter_ligne') return { car: '+', couleur: 'text-[#166534]' }
  return { car: '~', couleur: 'text-[#7C4A03]' }
}

const APERCU_RETIREES = 6 // séances à supprimer montrées d'emblée

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`

const STATUTS = {
  en_attente: { label: 'En attente', tone: 'warning' },
  appliquee: { label: 'Appliquée', tone: 'success' },
  rejetee: { label: 'Rejetée', tone: 'neutral' },
} as const

export function PropositionCarte({ p, compacte }: { p: Proposition; compacte?: boolean }) {
  const { recharger, connecte } = useStore()
  const referentiel = p.nature === 'referentiel'
  const [encours, setEncours] = useState(false)
  const [toutVoir, setToutVoir] = useState(false)
  const i = p.impact ?? {}
  const conflits = i.conflits ?? []
  const perdues = (i.heures_perdues ?? []).reduce((a, h) => a + h.heures, 0)
  const reportees = (i.heures_reportees ?? []).reduce((a, h) => a + h.heures, 0)
  const retirees = i.seances_retirees ?? []
  const ajoutees = i.seances_ajoutees ?? []
  const st = STATUTS[p.statut]
  const fait = p.statut === 'appliquee' // au passé : ces séances sont déjà dans la version à jour

  const decider = async (action: 'appliquer' | 'rejeter') => {
    setEncours(true)
    try {
      if (action === 'appliquer') {
        const r = await appliquerProposition(p.id_proposition)
        if (r.nature === 'referentiel') {
          const faits = [
            r.lignes_ajoutees && pluriel(r.lignes_ajoutees, 'ajout'),
            r.lignes_modifiees && pluriel(r.lignes_modifiees, 'modification'),
            r.lignes_supprimees && pluriel(r.lignes_supprimees, 'suppression'),
          ].filter(Boolean).join(', ')
          toast.success(`Référentiel mis à jour${faits ? ` (${faits})` : ''}`, {
            description: r.suite?.message,
          })
          await recharger()
          return
        }
        toast.success(`Proposition ${p.id_proposition} appliquée`, {
          description: [
            r.seances_creees && `${r.seances_creees} ajoutée(s)`,
            r.seances_modifiees && `${r.seances_modifiees} modifiée(s)`,
            r.seances_supprimees && `${r.seances_supprimees} retirée(s)`,
          ].filter(Boolean).join(', ') + ', validées par la base. Visible par les invités après publication (page Planification).',
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
    <div className={cn('rounded-3xl bg-white/90 p-4 text-sm ring-1', perdues || conflits.length ? 'ring-orange-soft' : 'ring-line')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{fait && !referentiel ? 'Modification' : 'Proposition'} {p.id_proposition}</p>
          <p className="text-ink-2">{p.description}</p>
        </div>
        <Badge tone={st.tone} dot>{st.label}</Badge>
      </div>

      {referentiel ? (
        <>
          <p className="mt-3 section-label">Changements du référentiel</p>
          <ul className="mt-1 space-y-1 text-ink-2">
            {(p.modifications as OperationReferentiel[]).map((o, k) => {
              const s = signe(o)
              return (
                <li key={k} className="flex gap-1.5">
                  <span className={cn('w-2.5 shrink-0 text-center font-medium', s.couleur)} aria-hidden>{s.car}</span>
                  <span>{o.libelle}</span>
                </li>
              )
            })}
          </ul>
          {conflits.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 text-[#7C4A03]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0">
                <p>
                  {pluriel(conflits.reduce((a, c) => a + c.nombre, 0), 'séance')} ou cours ne respecteraient plus les règles
                  (rien n'est déplacé automatiquement) :
                </p>
                <ul className="mt-0.5 space-y-0.5">
                  {conflits.map((c) => (
                    <li key={c.regle}>
                      {c.regle} : {c.nombre}
                      {c.du && ` (${c.du === c.au ? `le ${fmtJourMois(c.du)}` : `du ${fmtJourMois(c.du)} au ${fmtJourMois(c.au!)}`})`}
                      <span className="block text-xs text-ink-2">{c.exemples.slice(0, 3).join(' ; ')}{c.nombre > 3 ? '…' : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {p.suite && (
            <p className="mt-2 text-ink-2">
              Puis {p.suite.mode === 'replanifier' ? 'replanification' : 'génération'} : {p.suite.description} (appliquée
              directement à la version à jour).
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
          {ajoutees.length > 0 && (
            <li>
              <p className="font-medium text-ink">{fait ? 'Ajoutées :' : 'À ajouter :'}</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {ajoutees.map((l, k) => <li key={k} className="flex gap-1.5"><span className="font-medium text-[#166534]" aria-hidden>+</span><span>{l}</span></li>)}
              </ul>
            </li>
          )}
          {retirees.length > 0 && (
            <li>
              <p className="font-medium text-ink">
                {fait ? 'Retirées' : 'À supprimer'} : {retirees.length} séance{retirees.length > 1 ? 's' : ''}
                {i.heures_retirees ? ` (${i.heures_retirees} h, à reprogrammer si besoin)` : ''}
              </p>
              <ul className={cn('mt-1 space-y-0.5 text-xs', toutVoir && 'max-h-64 overflow-y-auto pr-1 scroll-thin')}>
                {(toutVoir ? retirees : retirees.slice(0, APERCU_RETIREES)).map((l, k) => (
                  <li key={k} className="flex gap-1.5"><span className="font-medium text-[#9F1239]" aria-hidden>−</span><span>{l}</span></li>
                ))}
              </ul>
              {retirees.length > APERCU_RETIREES && (
                <button type="button" onClick={() => setToutVoir((v) => !v)} aria-expanded={toutVoir} className="mt-1 text-xs font-medium text-navy underline underline-offset-2">
                  {toutVoir ? 'Réduire' : `Voir les ${retirees.length} séances`}
                </button>
              )}
            </li>
          )}
          {perdues > 0 && (
            <li className="flex items-start gap-1.5 text-[#7C4A03]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {perdues} h {fait ? 'ne sont plus programmées' : 'ne seraient plus programmées (à confirmer avec le bouton Appliquer)'} :{' '}
                {(i.heures_perdues ?? []).map((h) => `${h.cours} (${h.heures} h, ${h.regle})`).join(' ; ')}
              </span>
            </li>
          )}
          {reportees > 0 && (
            <li>
              {reportees} h restent à programmer après la période : {(i.heures_reportees ?? []).map((h) => `${h.cours} ${h.heures} h`).join(', ')}
            </li>
          )}
          {!!i.restees_hors_periode?.length && (
            <li className="flex items-start gap-1.5 text-[#7C4A03]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <div className="min-w-0">
                <p>{pluriel(i.restees_hors_periode.length, 'séance')} sans place dans la période, laissée{i.restees_hors_periode.length > 1 ? 's' : ''} où {i.restees_hors_periode.length > 1 ? 'elles étaient' : 'elle était'} :</p>
                <ul className="mt-0.5 space-y-0.5 text-xs">
                  {i.restees_hors_periode.map((x) => (
                    <li key={x.cours + x.date + x.heure_debut}>{x.cours}, {fmtJourMois(x.date)} {x.heure_debut.slice(0, 5)}–{x.heure_fin.slice(0, 5)} : {x.raison}</li>
                  ))}
                </ul>
              </div>
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
          {fait && !referentiel
            ? <>Appliquée le {fmtDateHeure(p.date_decision!)} · <Link to="/admin/planification" className="font-medium text-navy underline underline-offset-2">voir dans Planification</Link></>
            : `Calculée le ${fmtDateHeure(p.date_creation)}`}
        </span>
        {p.statut === 'en_attente' && connecte && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={encours} onClick={() => void decider('rejeter')}><X />Rejeter</Button>
            <Button size="sm" variant={perdues ? 'outline' : 'primary'} disabled={encours} onClick={() => void decider('appliquer')}>
              <Check />{referentiel
                ? (p.suite ? (p.suite.mode === 'replanifier' ? 'Appliquer et replanifier' : 'Appliquer et planifier') : 'Appliquer au référentiel')
                : 'Appliquer'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
