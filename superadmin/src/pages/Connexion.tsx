// Connexion du super admin. Trois cas :
// - e-mail et mot de passe (Supabase Auth) ;
// - arrivée par le lien d'invitation ou de nouveau mot de passe : choix du mot de passe ;
// - sans Supabase configuré : choix d'un compte de développement.

import { KeyRound, Loader2, MailCheck, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { Button, Card, Field, Input, Logo, Select } from '@/components/ui'
import { api, compteDev } from '@/lib/api'
import { useSession } from '@/lib/session'
import { LIEN_AUTH, supabase, traduireErreurAuth } from '@/lib/supabase'

type Vue = 'connexion' | 'mot_de_passe' | 'oubli' | 'envoye'

export default function Connexion() {
  const { compte, erreur: erreurSession, actualiser } = useSession()
  const [vue, setVue] = useState<Vue>(LIEN_AUTH.type === 'invite' || LIEN_AUTH.type === 'recovery' ? 'mot_de_passe' : 'connexion')
  const [email, setEmail] = useState('')
  const [mdp, setMdp] = useState('')
  const [mdp2, setMdp2] = useState('')
  const [erreur, setErreur] = useState(LIEN_AUTH.erreur ?? '')
  const [envoi, setEnvoi] = useState(false)

  if (compte && vue !== 'mot_de_passe') return <Navigate to="/" replace />

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
      const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password: mdp })
      if (error) throw new Error(traduireErreurAuth(error.message))
      await actualiser()
    })
  }

  const choisirMotDePasse = (e: FormEvent) => {
    e.preventDefault()
    if (mdp.length < 8) return setErreur('Le mot de passe doit faire au moins 8 caractères.')
    if (mdp !== mdp2) return setErreur('Les deux mots de passe ne sont pas identiques.')
    void executer(async () => {
      const { error } = await supabase!.auth.updateUser({ password: mdp })
      if (error) throw new Error(traduireErreurAuth(error.message))
      history.replaceState(null, '', window.location.pathname)
      await actualiser()
      setVue('connexion')
    })
  }

  const demanderLien = (e: FormEvent) => {
    e.preventDefault()
    void executer(async () => {
      const { error } = await supabase!.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/connexion` })
      if (error) throw new Error(traduireErreurAuth(error.message))
      setVue('envoye')
    })
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Card className="p-7 sm:p-9">
          <Logo suffix="Super admin" />
          <h1 className="mt-8 text-4xl font-light tracking-tight">
            {vue === 'mot_de_passe' ? 'Votre mot de passe' : vue === 'oubli' || vue === 'envoye' ? 'Mot de passe oublié' : 'Plateforme'}
          </h1>
          <p className="mt-2 text-sm text-ink-2">
            {vue === 'mot_de_passe'
              ? 'Choisissez le mot de passe de votre compte super admin.'
              : 'Gestion des écoles clientes et de leurs comptes administrateurs.'}
          </p>

          {!supabase ? (
            <ConnexionDev onConnecte={actualiser} />
          ) : vue === 'connexion' ? (
            <form onSubmit={seConnecter} className="mt-8 grid gap-4">
              <Field label="E-mail">
                <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Mot de passe">
                <Input type="password" autoComplete="current-password" required value={mdp} onChange={(e) => setMdp(e.target.value)} />
              </Field>
              <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <KeyRound />}Se connecter</Button>
              <button type="button" className="justify-self-center text-sm text-ink-2 underline-offset-4 hover:text-ink hover:underline" onClick={() => { setErreur(''); setVue('oubli') }}>
                Mot de passe oublié ?
              </button>
            </form>
          ) : vue === 'mot_de_passe' ? (
            <form onSubmit={choisirMotDePasse} className="mt-8 grid gap-4">
              <Field label="Nouveau mot de passe" hint="8 caractères au moins.">
                <Input type="password" autoComplete="new-password" required value={mdp} onChange={(e) => setMdp(e.target.value)} />
              </Field>
              <Field label="Confirmation">
                <Input type="password" autoComplete="new-password" required value={mdp2} onChange={(e) => setMdp2(e.target.value)} />
              </Field>
              <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <KeyRound />}Enregistrer et entrer</Button>
            </form>
          ) : vue === 'oubli' ? (
            <form onSubmit={demanderLien} className="mt-8 grid gap-4">
              <Field label="E-mail du compte">
                <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Button type="submit" size="lg" disabled={envoi}>{envoi ? <Loader2 className="animate-spin" /> : <MailCheck />}Recevoir un lien</Button>
              <button type="button" className="justify-self-center text-sm text-ink-2 hover:text-ink" onClick={() => setVue('connexion')}>Retour</button>
            </form>
          ) : (
            <div className="mt-8 grid gap-4">
              <p className="rounded-3xl bg-white/70 p-4 text-sm ring-1 ring-white">
                Si un compte existe pour {email}, un e-mail avec un lien vient d'être envoyé.
              </p>
              <Button variant="outline" onClick={() => setVue('connexion')}>Retour à la connexion</Button>
            </div>
          )}

          {(erreur || erreurSession) && (
            <p role="alert" className="mt-5 rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B]">{erreur || erreurSession}</p>
          )}
          <p className="mt-6 flex items-center gap-2 text-xs text-ink-2">
            <ShieldCheck className="size-4 text-[#15803D]" />
            {supabase ? 'Connexion sécurisée par Supabase Auth.' : 'Connexion de développement : ne pas mettre en ligne.'}
          </p>
        </Card>
      </div>
    </div>
  )
}

function ConnexionDev({ onConnecte }: { onConnecte: () => Promise<void> }) {
  const [comptes, setComptes] = useState<{ id_utilisateur: number; login: string }[] | null>(null)
  const [id, setId] = useState<number | null>(null)
  const [erreur, setErreur] = useState('')
  useEffect(() => {
    api.comptesDev().then(setComptes).catch((e: Error) => { setComptes([]); setErreur(e.message) })
  }, [])
  const choisi = id ?? comptes?.[0]?.id_utilisateur ?? null

  return (
    <div className="mt-8 grid gap-4">
      <Field label="Compte de développement" hint="Créé par python -m app.creer_superadmin, ou directement en base.">
        <Select value={choisi ?? ''} onChange={(e) => setId(Number(e.target.value))} disabled={!comptes?.length}>
          {comptes?.length === 0 && <option value="">Aucun compte super admin</option>}
          {comptes?.map((c) => <option key={c.id_utilisateur} value={c.id_utilisateur}>{c.login}</option>)}
        </Select>
      </Field>
      <Button size="lg" disabled={choisi === null} onClick={() => { compteDev.ecrire(choisi); void onConnecte() }}>
        <KeyRound />Entrer
      </Button>
      {erreur && <p className="text-sm text-[#991B1B]">{erreur}</p>}
    </div>
  )
}
