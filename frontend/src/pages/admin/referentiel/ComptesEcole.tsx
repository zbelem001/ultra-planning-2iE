// Comptes de l'école (mode connecté) : l'administrateur invite par e-mail, renvoie une
// invitation, modifie ou désactive un compte. Un compte n'existe que par invitation :
// la personne reçoit un lien pour choisir son mot de passe. Les planificateurs voient la liste.

import { Loader2, Mail, Send, UserPen, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, Dialog, Field, Input, Select, Switch } from '@/components/ui'
import { comptesEcole as api, type CompteEcole } from '@/lib/api'
import { useSession } from '@/lib/auth'
import { useStore } from '@/lib/store'

const INVITATIONS: Record<CompteEcole['invitation'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  acceptee: { label: 'Invitation acceptée', tone: 'success' },
  en_attente: { label: 'Invitation en attente', tone: 'warning' },
  non_envoyee: { label: 'Pas encore invité', tone: 'neutral' },
  inconnue: { label: 'État inconnu', tone: 'neutral' },
}

export function ComptesEcole() {
  const { db } = useStore()
  const session = useSession()
  const admin = db.utilisateur.find((u) => u.id_utilisateur === session)?.role === 'administrateur'
  const [comptes, setComptes] = useState<CompteEcole[] | null>(null)
  const [invitation, setInvitation] = useState(false)

  const charger = useCallback(() => {
    api.lister().then(setComptes).catch((e: Error) => { setComptes([]); toast.error('Comptes indisponibles', { description: e.message }) })
  }, [])
  useEffect(charger, [charger])

  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">
          {admin
            ? 'Chaque personne invitée reçoit un e-mail avec un lien pour choisir son mot de passe.'
            : 'Seul un administrateur de l’école invite ou modifie les comptes.'}
        </p>
        {admin && <Button onClick={() => setInvitation(true)}><UserPlus />Inviter un compte</Button>}
      </div>
      {comptes === null ? (
        <p className="py-6 text-sm text-ink-2">Chargement…</p>
      ) : (
        <ul className="mt-2 divide-y divide-line/70">
          {comptes.map((c) => <Ligne key={c.id_utilisateur} compte={c} admin={admin} moi={c.id_utilisateur === session} onChange={charger} />)}
        </ul>
      )}
      <Inviter open={invitation} onClose={() => setInvitation(false)} onInvite={charger} />
    </Card>
  )
}

function Ligne({ compte: c, admin, moi, onChange }: { compte: CompteEcole; admin: boolean; moi: boolean; onChange: () => void }) {
  const [envoi, setEnvoi] = useState(false)
  const [edition, setEdition] = useState(false)
  const s = INVITATIONS[c.invitation]

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
      await api.modifier(c.id_utilisateur, { est_actif: v })
      toast.success(v ? `Compte ${c.login} réactivé` : `Compte ${c.login} désactivé`, { description: v ? undefined : 'Il ne peut plus se connecter.' })
      onChange()
    } catch (e) {
      toast.error('Modification impossible', { description: (e as Error).message })
    }
  }

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_11rem_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {c.login}
          <Badge tone={c.role === 'administrateur' ? 'navy' : 'neutral'}>{c.role}</Badge>
          {moi && <Badge tone="orange">vous</Badge>}
          {!c.est_actif && <Badge tone="danger">désactivé</Badge>}
        </p>
        <p className="truncate text-sm text-ink-2">{c.email}</p>
      </div>
      <span className="order-last col-span-2 sm:order-none sm:col-span-1"><Badge tone={s.tone} dot>{s.label}</Badge></span>
      {admin ? (
        <span className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={() => setEdition(true)} title="Modifier le compte" aria-label={`Modifier le compte ${c.login}`}><UserPen /></Button>
          <Button size="sm" variant="outline" onClick={() => void renvoyer()} disabled={envoi || !c.est_actif}
            title={c.invitation === 'acceptee' ? 'Envoyer un lien de nouveau mot de passe' : "Renvoyer l'invitation"}>
            {envoi ? <Loader2 className="animate-spin" /> : c.invitation === 'acceptee' ? <Mail /> : <Send />}
            <span className="hidden md:inline">{c.invitation === 'acceptee' ? 'Mot de passe' : 'Renvoyer'}</span>
          </Button>
          <Switch checked={c.est_actif} disabled={moi} onChange={(v) => void activer(v)} label={`${c.est_actif ? 'Désactiver' : 'Réactiver'} le compte ${c.login}`} />
          <Modifier compte={c} moi={moi} open={edition} onClose={() => setEdition(false)} onModifie={onChange} />
        </span>
      ) : <span />}
    </li>
  )
}

function Inviter({ open, onClose, onInvite }: { open: boolean; onClose: () => void; onInvite: () => void }) {
  const vide = { email: '', login: '', role: 'planificateur' as CompteEcole['role'] }
  const [c, setC] = useState(vide)
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')
  const fermer = () => { setC(vide); setErreur(''); onClose() }

  const inviter = async (ev: FormEvent) => {
    ev.preventDefault()
    setEnvoi(true)
    setErreur('')
    try {
      await api.inviter({ email: c.email.trim(), login: c.login.trim(), role: c.role })
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
      <form id="inviter-compte" onSubmit={inviter} className="grid gap-4">
        <Field label="E-mail"><Input type="email" required value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        <Field label="Identifiant" hint="Nom affiché dans la console.">
          <Input required minLength={2} value={c.login} onChange={(e) => setC({ ...c, login: e.target.value })} />
        </Field>
        <Field label="Rôle" hint="Le planificateur prépare les emplois du temps ; l'administrateur gère aussi les comptes.">
          <Select value={c.role} onChange={(e) => setC({ ...c, role: e.target.value as CompteEcole['role'] })}>
            <option value="planificateur">Planificateur</option>
            <option value="administrateur">Administrateur</option>
          </Select>
        </Field>
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={fermer}>Annuler</Button>
        <Button type="submit" form="inviter-compte" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <Send />}Envoyer l'invitation</Button>
      </div>
    </Dialog>
  )
}

function Modifier({ compte, moi, open, onClose, onModifie }: { compte: CompteEcole; moi: boolean; open: boolean; onClose: () => void; onModifie: () => void }) {
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
      const r = await api.modifier(compte.id_utilisateur, champs)
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
      <form id={`modifier-${compte.id_utilisateur}`} onSubmit={enregistrer} className="grid gap-4">
        <Field label="E-mail"><Input type="email" required value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} /></Field>
        {emailChange && (
          <p className="rounded-3xl bg-highlight px-4 py-3 text-sm">
            {compte.invitation === 'acceptee'
              ? 'La personne se connectera avec la nouvelle adresse, avec le même mot de passe.'
              : "Une nouvelle invitation partira à cette adresse ; le lien envoyé à l'ancienne ne fonctionnera plus."}
          </p>
        )}
        <Field label="Identifiant"><Input required minLength={2} value={c.login} onChange={(e) => setC({ ...c, login: e.target.value })} /></Field>
        <Field label="Rôle" hint={moi ? 'Vous ne pouvez pas retirer votre propre rôle d’administrateur.' : undefined}>
          <Select value={c.role} disabled={moi} onChange={(e) => setC({ ...c, role: e.target.value as CompteEcole['role'] })}>
            <option value="administrateur">Administrateur</option>
            <option value="planificateur">Planificateur</option>
          </Select>
        </Field>
        {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      </form>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Annuler</Button>
        <Button type="submit" form={`modifier-${compte.id_utilisateur}`} disabled={envoi}>{envoi && <Loader2 className="animate-spin" />}Enregistrer</Button>
      </div>
    </Dialog>
  )
}
