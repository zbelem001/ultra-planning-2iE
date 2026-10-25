// Liste des écoles clientes, création d'une école et invitation de son premier administrateur.

import { Building2, ChevronRight, Loader2, Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ECOLE_VIDE, FormulaireEcole, nettoyer } from '@/components/FormulaireEcole'
import { StatutEcole } from '@/components/Statut'
import { Button, Card, Dialog, EmptyState, Field, Input, PageTitle, PillTabs } from '@/components/ui'
import { api, type Ecole, type EcoleSaisie } from '@/lib/api'
import { fmtDate } from '@/lib/format'

type Filtre = 'toutes' | 'active' | 'suspendue'

export default function Ecoles() {
  const [ecoles, setEcoles] = useState<Ecole[] | null>(null)
  const [erreur, setErreur] = useState('')
  const [q, setQ] = useState('')
  const [filtre, setFiltre] = useState<Filtre>('toutes')
  const [creation, setCreation] = useState(false)

  const charger = useCallback(() => {
    api.ecoles().then((e) => { setEcoles(e); setErreur('') }).catch((e: Error) => setErreur(e.message))
  }, [])
  useEffect(charger, [charger])

  const visibles = useMemo(() => {
    const n = q.trim().toLowerCase()
    return (ecoles ?? []).filter((e) =>
      (filtre === 'toutes' || e.statut === filtre) &&
      (!n || `${e.code_ecole} ${e.nom} ${e.ville ?? ''} ${e.pays ?? ''}`.toLowerCase().includes(n)))
  }, [ecoles, q, filtre])

  const actives = ecoles?.filter((e) => e.statut === 'active').length ?? 0
  const comptes = ecoles?.reduce((a, e) => a + (e.nb_comptes_actifs ?? 0), 0) ?? 0

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle eyebrow="Plateforme Ultraplanning" title="Écoles">
        <Button variant="accent" size="lg" onClick={() => setCreation(true)}><Plus />Nouvelle école</Button>
      </PageTitle>

      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <Indicateur label="Écoles actives" valeur={actives} />
        <Indicateur label="Écoles suspendues" valeur={(ecoles?.length ?? 0) - actives} />
        <Indicateur label="Comptes actifs" valeur={comptes} detail="administrateurs et planificateurs" />
      </div>

      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-2" />
            <Input className="pl-10" placeholder="Rechercher une école, une ville…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une école" />
          </div>
          <PillTabs<Filtre> label="Filtrer par statut" value={filtre} onChange={setFiltre}
            items={[{ value: 'toutes', label: 'Toutes' }, { value: 'active', label: 'Actives' }, { value: 'suspendue', label: 'Suspendues' }]} />
        </div>

        {erreur ? (
          <p role="alert" className="mt-6 rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>
        ) : ecoles === null ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" />Chargement des écoles…</p>
        ) : visibles.length === 0 ? (
          <EmptyState icon={<Building2 />} title={ecoles.length ? 'Aucune école ne correspond' : 'Aucune école'}>
            {ecoles.length ? 'Modifiez la recherche ou le filtre.' : 'Créez la première école et invitez son administrateur.'}
          </EmptyState>
        ) : (
          <ul className="mt-5 divide-y divide-line/70">
            {visibles.map((e) => (
              <li key={e.id_ecole}>
                <Link to={`/ecoles/${e.id_ecole}`} className="press -mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-3xl px-2 py-4 hover:bg-white/70 sm:grid-cols-[6rem_minmax(0,1fr)_10rem_8rem_auto]">
                  <span className="hidden font-mono text-sm text-ink-2 sm:block">{e.code_ecole}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{e.nom}</span>
                    <span className="block truncate text-xs text-ink-2">
                      <span className="font-mono sm:hidden">{e.code_ecole} · </span>
                      {[e.ville, e.pays].filter(Boolean).join(', ') || 'Lieu non renseigné'} · depuis le {fmtDate(e.date_creation)}
                    </span>
                    {e.statut === 'suspendue' && <span className="mt-1 block sm:hidden"><StatutEcole statut={e.statut} /></span>}
                  </span>
                  <span className="hidden text-sm text-ink-2 sm:block">
                    {e.nb_administrateurs} admin{(e.nb_administrateurs ?? 0) > 1 ? 's' : ''} · {e.nb_comptes} compte{(e.nb_comptes ?? 0) > 1 ? 's' : ''}
                  </span>
                  <span className="hidden sm:block"><StatutEcole statut={e.statut} /></span>
                  <ChevronRight className="size-4 text-ink-2" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <NouvelleEcole open={creation} onClose={() => setCreation(false)} onCreee={charger} />
    </div>
  )
}

function Indicateur({ label, valeur, detail }: { label: string; valeur: number; detail?: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="section-label">{label}</p>
      <p className="mt-1 text-3xl font-normal sm:text-4xl">{valeur}</p>
      {detail && <p className="hidden text-xs text-ink-2 sm:block">{detail}</p>}
    </Card>
  )
}

function NouvelleEcole({ open, onClose, onCreee }: { open: boolean; onClose: () => void; onCreee: () => void }) {
  const nav = useNavigate()
  const [ecole, setEcole] = useState<EcoleSaisie>(ECOLE_VIDE)
  const [admin, setAdmin] = useState({ email: '', login: '' })
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')

  const fermer = () => {
    setEcole(ECOLE_VIDE)
    setAdmin({ email: '', login: '' })
    setErreur('')
    onClose()
  }

  const creer = async (ev: FormEvent) => {
    ev.preventDefault()
    setEnvoi(true)
    setErreur('')
    try {
      const e = await api.creerEcole(nettoyer(ecole))
      onCreee()
      if (admin.email.trim()) {
        try {
          await api.inviter(e.id_ecole, { email: admin.email.trim(), login: admin.login.trim() || 'admin', role: 'administrateur' })
          toast.success(`École ${e.code_ecole} créée`, { description: `Invitation envoyée à ${admin.email.trim()}.` })
        } catch (err) {
          toast.warning(`École ${e.code_ecole} créée, mais l'invitation a échoué`, { description: (err as Error).message })
        }
      } else {
        toast.success(`École ${e.code_ecole} créée`)
      }
      fermer()
      nav(`/ecoles/${e.id_ecole}`)
    } catch (err) {
      setErreur((err as Error).message)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <Dialog open={open} onClose={fermer} wide title="Nouvelle école" description="L'école aura sa propre console ; son administrateur reçoit une invitation par e-mail.">
      <form id="nouvelle-ecole" onSubmit={creer} className="grid gap-6">
        <FormulaireEcole valeur={ecole} onChange={setEcole} creation />
        <fieldset className="grid gap-4 rounded-3xl bg-subtle/70 p-4 sm:grid-cols-2">
          <legend className="section-label px-1">Premier administrateur (facultatif)</legend>
          <Field label="E-mail" hint="Il choisira son mot de passe en suivant le lien.">
            <Input type="email" placeholder="direction@ecole.org" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
          </Field>
          <Field label="Identifiant" hint="Nom affiché dans la console.">
            <Input placeholder="admin" value={admin.login} onChange={(e) => setAdmin({ ...admin, login: e.target.value })} />
          </Field>
        </fieldset>
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={fermer}>Annuler</Button>
        <Button type="submit" form="nouvelle-ecole" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <Plus />}Créer l'école</Button>
      </div>
    </Dialog>
  )
}
