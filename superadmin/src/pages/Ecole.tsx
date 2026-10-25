// Fiche d'une école : informations, suspension, comptes de gestion et invitations.

import { ArrowLeft, Ban, Loader2, Mail, Pencil, PlayCircle, Send, UserPen, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { FormulaireEcole, nettoyer } from '@/components/FormulaireEcole'
import { StatutEcole, StatutInvitation } from '@/components/Statut'
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageTitle, SectionTitle, Select, Switch } from '@/components/ui'
import { api, type CompteEcole, type Ecole as TEcole, type EcoleSaisie } from '@/lib/api'
import { fmtDate } from '@/lib/format'

export default function Ecole() {
  const id = Number(useParams().id)
  const [ecole, setEcole] = useState<TEcole | null>(null)
  const [comptes, setComptes] = useState<CompteEcole[] | null>(null)
  const [erreur, setErreur] = useState('')
  const [edition, setEdition] = useState(false)
  const [suspension, setSuspension] = useState(false)
  const [invitation, setInvitation] = useState(false)

  const charger = useCallback(() => {
    api.ecoles()
      .then((l) => {
        const e = l.find((x) => x.id_ecole === id)
        if (!e) throw new Error('École introuvable')
        setEcole(e)
      })
      .catch((e: Error) => setErreur(e.message))
    api.comptes(id).then(setComptes).catch((e: Error) => setErreur(e.message))
  }, [id])
  useEffect(charger, [charger])

  if (erreur) {
    return (
      <div className="grid gap-4">
        <Retour />
        <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>
      </div>
    )
  }
  if (!ecole) return <p className="flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" />Chargement…</p>

  const suspendue = ecole.statut === 'suspendue'

  return (
    <div className="grid grid-cols-1 gap-6">
      <Retour />
      <PageTitle eyebrow={`École ${ecole.code_ecole}`} title={ecole.nom}>
        <StatutEcole statut={ecole.statut} />
        <Button variant="outline" onClick={() => setEdition(true)}><Pencil />Modifier</Button>
        <Button variant={suspendue ? 'primary' : 'destructive'} onClick={() => setSuspension(true)}>
          {suspendue ? <><PlayCircle />Réactiver</> : <><Ban />Suspendre</>}
        </Button>
      </PageTitle>

      {suspendue && (
        <p className="rounded-3xl bg-[#FEE2E2] px-5 py-4 text-sm text-[#991B1B]">
          École suspendue : aucun de ses comptes ne peut se connecter, et aucune invitation ne peut être envoyée.
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit p-5 sm:p-6">
          <SectionTitle eyebrow="Fiche" title="Informations" />
          <dl className="mt-4 grid gap-3 text-sm">
            <Info label="Code" valeur={<span className="font-mono">{ecole.code_ecole}</span>} />
            <Info label="Lieu" valeur={[ecole.ville, ecole.pays].filter(Boolean).join(', ') || '—'} />
            <Info label="Contact" valeur={ecole.email_contact ? <a className="text-navy underline-offset-4 hover:underline" href={`mailto:${ecole.email_contact}`}>{ecole.email_contact}</a> : '—'} />
            <Info label="Cliente depuis le" valeur={fmtDate(ecole.date_creation)} />
          </dl>
        </Card>

        <Card className="p-5 sm:p-6">
          <SectionTitle
            eyebrow="Accès à la console de l'école"
            title={`Comptes (${comptes?.length ?? '…'})`}
            action={<Button onClick={() => setInvitation(true)} disabled={suspendue}><UserPlus />Inviter un compte</Button>}
          />
          {comptes === null ? (
            <p className="mt-5 flex items-center gap-2 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" />Chargement des comptes…</p>
          ) : comptes.length === 0 ? (
            <EmptyState icon={<Users />} title="Aucun compte">Invitez l'administrateur de l'école : il gérera ensuite sa console.</EmptyState>
          ) : (
            <ul className="mt-4 divide-y divide-line/70">
              {comptes.map((c) => <LigneCompte key={c.id_utilisateur} compte={c} suspendue={suspendue} onChange={charger} />)}
            </ul>
          )}
        </Card>
      </div>

      <ModifierEcole ecole={ecole} open={edition} onClose={() => setEdition(false)} onModifiee={setEcole} />
      <Suspendre ecole={ecole} open={suspension} onClose={() => setSuspension(false)} onModifiee={setEcole} />
      <Inviter id_ecole={ecole.id_ecole} open={invitation} onClose={() => setInvitation(false)} onInvite={charger} />
    </div>
  )
}

function Retour() {
  return <Link to="/" className="inline-flex w-fit items-center gap-1.5 text-sm text-ink-2 hover:text-ink"><ArrowLeft className="size-4" />Toutes les écoles</Link>
}

function Info({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words">{valeur}</dd>
    </div>
  )
}

function LigneCompte({ compte: c, suspendue, onChange }: { compte: CompteEcole; suspendue: boolean; onChange: () => void }) {
  const [envoi, setEnvoi] = useState(false)
  const [edition, setEdition] = useState(false)

  const renvoyer = async () => {
    setEnvoi(true)
    try {
      const r = await api.renvoyer(c.id_utilisateur)
      toast.success(r.envoi === 'invitation' ? 'Invitation renvoyée' : 'Lien de nouveau mot de passe envoyé', { description: c.email })
      onChange()
    } catch (e) {
      toast.error('E-mail non envoyé', { description: (e as Error).message })
    } finally {
      setEnvoi(false)
    }
  }

  const activer = async (v: boolean) => {
    try {
      await api.activer(c.id_utilisateur, v)
      toast.success(v ? `Compte ${c.login} réactivé` : `Compte ${c.login} désactivé`, { description: v ? undefined : 'Il ne peut plus se connecter.' })
      onChange()
    } catch (e) {
      toast.error('Modification impossible', { description: (e as Error).message })
    }
  }

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto_auto_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {c.login}
          <Badge tone={c.role === 'administrateur' ? 'navy' : 'neutral'}>{c.role}</Badge>
          {!c.est_actif && <Badge tone="danger">désactivé</Badge>}
        </p>
        <p className="truncate text-sm text-ink-2">{c.email}</p>
      </div>
      <span className="order-last col-span-3 sm:order-none sm:col-span-1"><StatutInvitation invitation={c.invitation} /></span>
      <Button size="icon-sm" variant="ghost" onClick={() => setEdition(true)} title="Modifier le compte" aria-label={`Modifier le compte ${c.login}`}>
        <UserPen />
      </Button>
      <Button size="sm" variant="outline" onClick={() => void renvoyer()} disabled={envoi || suspendue || !c.est_actif}
        title={c.invitation === 'acceptee' ? 'Envoyer un lien de nouveau mot de passe' : "Renvoyer l'invitation"}>
        {envoi ? <Loader2 className="animate-spin" /> : c.invitation === 'acceptee' ? <Mail /> : <Send />}
        <span className="hidden md:inline">{c.invitation === 'acceptee' ? 'Mot de passe' : 'Renvoyer'}</span>
      </Button>
      <Switch checked={c.est_actif} onChange={(v) => void activer(v)} label={`${c.est_actif ? 'Désactiver' : 'Réactiver'} le compte ${c.login}`} />
      <ModifierCompte compte={c} open={edition} onClose={() => setEdition(false)} onModifie={onChange} />
    </li>
  )
}

function ModifierCompte({ compte, open, onClose, onModifie }: { compte: CompteEcole; open: boolean; onClose: () => void; onModifie: () => void }) {
  const [c, setC] = useState({ email: compte.email, login: compte.login, role: compte.role })
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    if (open) {
      setC({ email: compte.email, login: compte.login, role: compte.role })
      setErreur('')
    }
  }, [open, compte])

  const email = c.email.trim().toLowerCase()
  const emailChange = email !== compte.email
  const enregistrer = async (ev: FormEvent) => {
    ev.preventDefault()
    const champs = {
      ...(emailChange ? { email } : {}),
      ...(c.login.trim() !== compte.login ? { login: c.login.trim() } : {}),
      ...(c.role !== compte.role ? { role: c.role } : {}),
    }
    if (!Object.keys(champs).length) return onClose()
    setEnvoi(true)
    setErreur('')
    try {
      const r = await api.modifierCompte(compte.id_utilisateur, champs)
      toast.success(`Compte ${r.login} modifié`, {
        description: r.envoi === 'invitation'
          ? `Nouvelle invitation envoyée à ${r.email} ; l'ancien lien ne fonctionne plus.`
          : emailChange ? `Connexion désormais avec ${r.email}, même mot de passe.` : undefined,
      })
      onModifie()
      onClose()
    } catch (err) {
      setErreur((err as Error).message)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Modifier le compte" description={`${compte.login} · ${compte.email}`}>
      <form id={`modifier-compte-${compte.id_utilisateur}`} onSubmit={enregistrer} className="grid gap-4">
        <Field label="E-mail">
          <Input type="email" required value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
        </Field>
        {emailChange && (
          <p className="rounded-3xl bg-highlight px-4 py-3 text-sm">
            {compte.invitation === 'acceptee'
              ? 'La personne se connectera avec la nouvelle adresse, avec le même mot de passe.'
              : compte.invitation === 'non_envoyee'
                ? "L'adresse sera seulement enregistrée : aucune invitation n'a encore été envoyée."
                : "Une nouvelle invitation partira à cette adresse ; le lien envoyé à l'ancienne ne fonctionnera plus."}
          </p>
        )}
        <Field label="Identifiant" hint="Nom affiché dans la console de l'école.">
          <Input required minLength={2} value={c.login} onChange={(e) => setC({ ...c, login: e.target.value })} />
        </Field>
        <Field label="Rôle">
          <Select value={c.role} onChange={(e) => setC({ ...c, role: e.target.value as CompteEcole['role'] })}>
            <option value="administrateur">Administrateur</option>
            <option value="planificateur">Planificateur</option>
          </Select>
        </Field>
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button type="submit" form={`modifier-compte-${compte.id_utilisateur}`} disabled={envoi}>
          {envoi && <Loader2 className="animate-spin" />}Enregistrer
        </Button>
      </div>
    </Dialog>
  )
}

function ModifierEcole({ ecole, open, onClose, onModifiee }: { ecole: TEcole; open: boolean; onClose: () => void; onModifiee: (e: TEcole) => void }) {
  const [valeur, setValeur] = useState<EcoleSaisie>(ecole)
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')
  useEffect(() => { if (open) setValeur(ecole) }, [open, ecole])

  const enregistrer = async (ev: FormEvent) => {
    ev.preventDefault()
    setEnvoi(true)
    setErreur('')
    try {
      const { nom, ville, pays, email_contact } = nettoyer(valeur)
      const e = await api.modifierEcole(ecole.id_ecole, { nom, ville, pays, email_contact })
      onModifiee({ ...ecole, ...e })
      toast.success('École modifiée')
      onClose()
    } catch (err) {
      setErreur((err as Error).message)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} wide title="Modifier l'école" description={`Code ${ecole.code_ecole}`}>
      <form id="modifier-ecole" onSubmit={enregistrer} className="grid gap-5">
        <FormulaireEcole valeur={valeur} onChange={setValeur} />
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button type="submit" form="modifier-ecole" disabled={envoi}>{envoi && <Loader2 className="animate-spin" />}Enregistrer</Button>
      </div>
    </Dialog>
  )
}

function Suspendre({ ecole, open, onClose, onModifiee }: { ecole: TEcole; open: boolean; onClose: () => void; onModifiee: (e: TEcole) => void }) {
  const suspendue = ecole.statut === 'suspendue'
  const [envoi, setEnvoi] = useState(false)
  const confirmer = async () => {
    setEnvoi(true)
    try {
      const e = await api.modifierEcole(ecole.id_ecole, { statut: suspendue ? 'active' : 'suspendue' })
      onModifiee({ ...ecole, ...e })
      toast.success(suspendue ? `${ecole.code_ecole} réactivée` : `${ecole.code_ecole} suspendue`)
      onClose()
    } catch (err) {
      toast.error('Modification impossible', { description: (err as Error).message })
    } finally {
      setEnvoi(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={suspendue ? `Réactiver ${ecole.code_ecole} ?` : `Suspendre ${ecole.code_ecole} ?`}
      description={suspendue
        ? 'Ses comptes actifs pourront de nouveau se connecter.'
        : "Plus aucun compte de l'école ne pourra se connecter. Ses données sont conservées ; vous pourrez la réactiver."}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button variant={suspendue ? 'primary' : 'destructive'} onClick={() => void confirmer()} disabled={envoi}>
          {envoi && <Loader2 className="animate-spin" />}{suspendue ? 'Réactiver' : 'Suspendre'}
        </Button>
      </>}
    >
      <span />
    </Dialog>
  )
}

function Inviter({ id_ecole, open, onClose, onInvite }: { id_ecole: number; open: boolean; onClose: () => void; onInvite: () => void }) {
  const vide = { email: '', login: '', role: 'administrateur' as CompteEcole['role'] }
  const [c, setC] = useState(vide)
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')
  const fermer = () => { setC(vide); setErreur(''); onClose() }

  const inviter = async (ev: FormEvent) => {
    ev.preventDefault()
    setEnvoi(true)
    setErreur('')
    try {
      await api.inviter(id_ecole, { email: c.email.trim(), login: c.login.trim(), role: c.role })
      toast.success('Invitation envoyée', { description: c.email.trim() })
      onInvite()
      fermer()
    } catch (err) {
      setErreur((err as Error).message)
    } finally {
      setEnvoi(false)
    }
  }

  return (
    <Dialog open={open} onClose={fermer} title="Inviter un compte" description="La personne reçoit un e-mail avec un lien pour choisir son mot de passe.">
      <form id="inviter" onSubmit={inviter} className="grid gap-4">
        <Field label="E-mail"><Input type="email" required value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        <Field label="Identifiant" hint="Nom affiché dans la console de l'école.">
          <Input required minLength={2} value={c.login} onChange={(e) => setC({ ...c, login: e.target.value })} />
        </Field>
        <Field label="Rôle" hint="L'administrateur gère toute la console ; le planificateur prépare les emplois du temps.">
          <Select value={c.role} onChange={(e) => setC({ ...c, role: e.target.value as CompteEcole['role'] })}>
            <option value="administrateur">Administrateur</option>
            <option value="planificateur">Planificateur</option>
          </Select>
        </Field>
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={fermer}>Annuler</Button>
        <Button type="submit" form="inviter" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <Send />}Envoyer l'invitation</Button>
      </div>
    </Dialog>
  )
}
