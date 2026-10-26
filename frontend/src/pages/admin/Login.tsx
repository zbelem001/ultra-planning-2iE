// Connexion à la console. Avec Supabase Auth (VITE_SUPABASE_URL) : e-mail et mot de passe,
// ou choix du mot de passe en arrivant par le lien d'invitation ; sinon, connexion de
// développement (choix d'un compte).

import { ArrowLeft, KeyRound, Loader2, MailCheck, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Button, Card, Field, Input, Logo, Select } from '@/components/ui'
import { comptes as comptesApi, MODE_CONNECTE, moi } from '@/lib/api'
import { login } from '@/lib/auth'
import { ecoleCourante, useStore } from '@/lib/store'
import { LIEN_AUTH, obtenirSupabase, SUPABASE_ACTIF, traduireErreurAuth } from '@/lib/supabase'

const ROLES_ADMIN = ['administrateur', 'planificateur']

export default function Login() {
  const { db } = useStore()
  const nav = useNavigate()
  const loc = useLocation()
  const entrer = (id: number) => {
    login(id)
    nav((loc.state as { from?: string } | null)?.from ?? '/admin', { replace: true })
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"><ArrowLeft className="size-4" />Espace invités</Link>
        <Card className="p-7 sm:p-9">
          <Logo suffix="Console" ecole={ecoleCourante(db)} />
          {SUPABASE_ACTIF && MODE_CONNECTE ? <ConnexionSupabase onConnecte={entrer} /> : <ConnexionDev onConnecte={entrer} />}
        </Card>
      </div>
    </div>
  )
}

type Vue = 'connexion' | 'mot_de_passe' | 'oubli' | 'envoye'

function ConnexionSupabase({ onConnecte }: { onConnecte: (id: number) => void }) {
  const [vue, setVue] = useState<Vue>(LIEN_AUTH.type === 'invite' || LIEN_AUTH.type === 'recovery' ? 'mot_de_passe' : 'connexion')
  const [email, setEmail] = useState('')
  const [mdp, setMdp] = useState('')
  const [mdp2, setMdp2] = useState('')
  const [erreur, setErreur] = useState(LIEN_AUTH.erreur ?? '')
  const [envoi, setEnvoi] = useState(false)

  /** Compte UltraPlanning de la session Supabase, réservé aux gestionnaires d'une école */
  const ouvrir = async () => {
    const c = await moi()
    if (!ROLES_ADMIN.includes(c.role)) {
      await (await obtenirSupabase()).auth.signOut()
      throw new Error("Ce compte n'a pas accès à la console d'une école.")
    }
    onConnecte(c.id_utilisateur)
  }

  // Déjà connecté à Supabase (autre onglet, retour sur la page) : on entre directement
  useEffect(() => {
    if (vue !== 'connexion') return
    void obtenirSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => { if (data.session) ouvrir().catch((e: Error) => setErreur(e.message)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const executer = async (fn: () => Promise<void>) => {
    setEnvoi(true)
    setErreur('')
    try {
      await fn()
    } catch (e) {
      setErreur((e as Error).message)
    } finally {
      setEnvoi(false)
    }
  }

  const seConnecter = (e: FormEvent) => {
    e.preventDefault()
    void executer(async () => {
      const { error } = await (await obtenirSupabase()).auth.signInWithPassword({ email: email.trim(), password: mdp })
      if (error) throw new Error(traduireErreurAuth(error.message))
      await ouvrir()
    })
  }

  const choisirMotDePasse = (e: FormEvent) => {
    e.preventDefault()
    if (mdp.length < 8) return setErreur('Le mot de passe doit faire au moins 8 caractères.')
    if (mdp !== mdp2) return setErreur('Les deux mots de passe ne sont pas identiques.')
    void executer(async () => {
      const { error } = await (await obtenirSupabase()).auth.updateUser({ password: mdp })
      if (error) throw new Error(traduireErreurAuth(error.message))
      history.replaceState(null, '', window.location.pathname)
      await ouvrir()
    })
  }

  const demanderLien = (e: FormEvent) => {
    e.preventDefault()
    void executer(async () => {
      const { error } = await (await obtenirSupabase()).auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/admin/connexion` })
      if (error) throw new Error(traduireErreurAuth(error.message))
      setVue('envoye')
    })
  }

  return (
    <>
      <h1 className="mt-8 text-4xl font-light tracking-tight">{vue === 'mot_de_passe' ? 'Votre mot de passe' : vue === 'connexion' ? 'Administration' : 'Mot de passe oublié'}</h1>
      <p className="mt-2 text-sm text-ink-2">
        {vue === 'mot_de_passe' ? 'Bienvenue : choisissez le mot de passe de votre compte.' : 'Programmation des emplois du temps, réservée à la scolarité et aux administrateurs.'}
      </p>

      {vue === 'connexion' ? (
        <form onSubmit={seConnecter} className="mt-8 grid gap-4">
          <Field label="E-mail"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Mot de passe"><Input type="password" autoComplete="current-password" required value={mdp} onChange={(e) => setMdp(e.target.value)} /></Field>
          <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <KeyRound />}Se connecter</Button>
          <button type="button" className="justify-self-center text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline" onClick={() => { setErreur(''); setVue('oubli') }}>
            Mot de passe oublié ?
          </button>
        </form>
      ) : vue === 'mot_de_passe' ? (
        <form onSubmit={choisirMotDePasse} className="mt-8 grid gap-4">
          <Field label="Nouveau mot de passe" hint="8 caractères au moins."><Input type="password" autoComplete="new-password" required value={mdp} onChange={(e) => setMdp(e.target.value)} /></Field>
          <Field label="Confirmation"><Input type="password" autoComplete="new-password" required value={mdp2} onChange={(e) => setMdp2(e.target.value)} /></Field>
          <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <KeyRound />}Enregistrer et entrer</Button>
        </form>
      ) : vue === 'oubli' ? (
        <form onSubmit={demanderLien} className="mt-8 grid gap-4">
          <Field label="E-mail du compte"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <MailCheck />}Recevoir un lien</Button>
          <button type="button" className="justify-self-center text-sm text-ink-2 hover:text-ink" onClick={() => setVue('connexion')}>Retour</button>
        </form>
      ) : (
        <div className="mt-8 grid gap-4">
          <p className="rounded-3xl bg-white/70 p-4 text-sm ring-1 ring-white">Si un compte existe pour {email}, un e-mail avec un lien vient d'être envoyé.</p>
          <Button variant="outline" onClick={() => setVue('connexion')}>Retour à la connexion</Button>
        </div>
      )}

      {erreur && <p role="alert" className="mt-5 rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur}</p>}
      <p className="mt-6 flex items-center gap-2 text-xs text-ink-2"><ShieldCheck className="size-4 text-[#15803D]" />Votre compte est créé par l'équipe Ultraplanning, sur invitation.</p>
    </>
  )
}

function ConnexionDev({ onConnecte }: { onConnecte: (id: number) => void }) {
  const { db } = useStore()
  // En mode connecté, l'image publique ne contient pas les comptes : on les demande à l'API
  const [distants, setDistants] = useState<{ id_utilisateur: number; login: string; role: string }[]>([])
  useEffect(() => {
    if (MODE_CONNECTE) comptesApi().then(setDistants).catch(() => setDistants([]))
  }, [])
  const comptes = MODE_CONNECTE ? distants : db.utilisateur.filter((u) => ROLES_ADMIN.includes(u.role))
  const [choisi, setId] = useState<number | null>(null)
  const id = choisi ?? comptes[0]?.id_utilisateur ?? 0

  return (
    <>
      <h1 className="mt-8 text-4xl font-light tracking-tight">Administration</h1>
      <p className="mt-2 text-sm text-ink-2">Programmation des emplois du temps, réservée à la scolarité et aux administrateurs.</p>
      <div className="mt-8 grid gap-4">
        <Field label="Compte de démonstration" hint="Connexion de développement. Avec Supabase Auth (VITE_SUPABASE_URL), la connexion se fait par e-mail.">
          <Select value={id} onChange={(e) => setId(Number(e.target.value))}>
            {comptes.map((u) => (
              <option key={u.id_utilisateur} value={u.id_utilisateur}>{u.login} · {u.role}</option>
            ))}
          </Select>
        </Field>
        <Button size="lg" onClick={() => onConnecte(id)} disabled={!id}>
          <KeyRound />Se connecter
        </Button>
      </div>
      <p className="mt-6 flex items-center gap-2 text-xs text-ink-2"><ShieldCheck className="size-4 text-[#15803D]" />Connexion simulée : aucun mot de passe.</p>
    </>
  )
}
