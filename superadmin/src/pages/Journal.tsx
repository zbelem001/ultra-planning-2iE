// Journal d'audit (BNF-08) : chaque création, modification ou suppression de séance,
// dans toutes les écoles, avec le compte et l'origine du changement.

import { History, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, EmptyState, Field, Input, PageTitle, Select } from '@/components/ui'
import { api, type Ecole, type FiltresJournal, type LigneJournal } from '@/lib/api'

const ACTIONS: Record<LigneJournal['action'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  creation: { label: 'Création', tone: 'success' },
  modification: { label: 'Modification', tone: 'warning' },
  suppression: { label: 'Suppression', tone: 'danger' },
}
const ORIGINES: Record<string, string> = {
  console: 'Console', generation: 'Génération automatique', assistant: 'Assistant IA', systeme: 'Système',
}

const fmtHorodatage = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtJour = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'
const valeur = (v: unknown) => (v === true ? 'oui' : v === false ? 'non' : v == null ? '—' : String(v))

export default function Journal() {
  const [ecoles, setEcoles] = useState<Ecole[]>([])
  const [filtres, setFiltres] = useState<FiltresJournal>({})
  const [lignes, setLignes] = useState<LigneJournal[] | null>(null)
  const [suivant, setSuivant] = useState<number | null>(null)
  const [chargement, setChargement] = useState(false)

  useEffect(() => { api.ecoles().then(setEcoles).catch(() => setEcoles([])) }, [])

  const charger = useCallback(async (suite: number | null) => {
    setChargement(true)
    try {
      const r = await api.journal({ ...filtres, avant: suite ?? undefined })
      setLignes((l) => (suite && l ? [...l, ...r.lignes] : r.lignes))
      setSuivant(r.suivant)
    } catch (e) {
      toast.error('Journal indisponible', { description: (e as Error).message })
      setLignes((l) => l ?? [])
    } finally {
      setChargement(false)
    }
  }, [filtres])
  useEffect(() => { void charger(null) }, [charger])

  const filtre = <K extends keyof FiltresJournal>(k: K, v: FiltresJournal[K] | '') =>
    setFiltres((f) => ({ ...f, [k]: v === '' ? undefined : v }))

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle eyebrow="BNF-08 · traçabilité" title="Journal" />

      <Card className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-5">
        <Field label="École">
          <Select value={filtres.id_ecole ?? ''} onChange={(e) => filtre('id_ecole', e.target.value ? Number(e.target.value) : '')}>
            <option value="">Toutes</option>
            {ecoles.map((e) => <option key={e.id_ecole} value={e.id_ecole}>{e.code_ecole} · {e.nom}</option>)}
          </Select>
        </Field>
        <Field label="Action">
          <Select value={filtres.action ?? ''} onChange={(e) => filtre('action', e.target.value as LigneJournal['action'] | '')}>
            <option value="">Toutes</option>
            {Object.entries(ACTIONS).map(([k, a]) => <option key={k} value={k}>{a.label}</option>)}
          </Select>
        </Field>
        <Field label="Origine">
          <Select value={filtres.origine ?? ''} onChange={(e) => filtre('origine', e.target.value)}>
            <option value="">Toutes</option>
            {Object.entries(ORIGINES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Du"><Input type="date" value={filtres.du ?? ''} onChange={(e) => filtre('du', e.target.value)} /></Field>
        <Field label="Au"><Input type="date" value={filtres.au ?? ''} onChange={(e) => filtre('au', e.target.value)} /></Field>
      </Card>

      <Card className="p-2 sm:p-3">
        {lignes === null ? (
          <p className="p-4 text-sm text-ink-2">Chargement…</p>
        ) : lignes.length === 0 ? (
          <EmptyState icon={<History />} title="Aucun changement">Aucune séance n'a été créée, modifiée ou supprimée pour ces critères.</EmptyState>
        ) : (
          <ul className="divide-y divide-line/70">
            {lignes.map((l) => (
              <li key={l.id_journal} className="grid gap-1 px-3 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
                <div className="text-xs text-ink-2">
                  <p className="font-medium text-ink">{fmtHorodatage(l.date_action)}</p>
                  <p>{l.utilisateur ?? 'hors console'} · {ORIGINES[l.origine] ?? l.origine}</p>
                </div>
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={ACTIONS[l.action].tone} dot>{ACTIONS[l.action].label}</Badge>
                    <span className="font-medium">{l.cours}</span>
                    {l.classe && <span className="text-ink-2">{l.classe}</span>}
                  </p>
                  <p className="mt-1 text-ink-2">
                    {fmtJour(l.seance.date)} {l.seance.debut}–{l.seance.fin}{l.seance.salle ? ` · ${l.seance.salle}` : ''}
                  </p>
                  {l.changements.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {l.changements.map((c) => (
                        <li key={c.champ}>
                          <span className="text-ink-2">{c.champ} :</span> {valeur(c.avant)} → <span className="font-medium">{valeur(c.apres)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="text-xs text-ink-2 sm:text-right">
                  <span className="font-mono">{l.ecole}</span>{l.version ? ` · v${l.version}` : ''}<br />séance {l.id_seance}
                </p>
              </li>
            ))}
          </ul>
        )}
        {suivant !== null && (
          <div className="flex justify-center p-3">
            <Button variant="outline" disabled={chargement} onClick={() => void charger(suivant)}>
              {chargement && <Loader2 className="animate-spin" />}Plus ancien
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
