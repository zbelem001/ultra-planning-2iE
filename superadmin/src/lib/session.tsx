// Compte connecté. Supabase : session Auth puis /api/moi ; développement : compte choisi.
// Seul un super admin entre dans cette console.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, compteDev, type Compte } from './api'
import { supabase } from './supabase'

interface Session {
  compte: Compte | null
  chargement: boolean
  erreur: string
  /** Relit le compte après une connexion */
  actualiser: () => Promise<void>
  deconnecter: () => Promise<void>
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [compte, setCompte] = useState<Compte | null>(null)
  const [chargement, setChargement] = useState(true)
  const [erreur, setErreur] = useState('')

  const deconnecter = useCallback(async () => {
    compteDev.ecrire(null)
    if (supabase) await supabase.auth.signOut()
    setCompte(null)
  }, [])

  const actualiser = useCallback(async () => {
    const connecte = supabase ? (await supabase.auth.getSession()).data.session !== null : compteDev.lire() !== null
    if (!connecte) {
      setCompte(null)
      setChargement(false)
      return
    }
    try {
      const c = await api.moi()
      if (c.role !== 'superadmin') {
        await deconnecter()
        setErreur("Ce compte n'est pas un compte super admin. Les écoles se connectent à leur console.")
      } else {
        setCompte(c)
        setErreur('')
      }
    } catch (e) {
      await deconnecter()
      setErreur((e as Error).message)
    } finally {
      setChargement(false)
    }
  }, [deconnecter])

  useEffect(() => {
    void actualiser()
    if (!supabase) return
    // Jeton renouvelé ou session fermée dans un autre onglet
    const { data } = supabase.auth.onAuthStateChange((evenement) => {
      if (evenement === 'SIGNED_OUT') setCompte(null)
    })
    return () => data.subscription.unsubscribe()
  }, [actualiser])

  return <Ctx.Provider value={{ compte, chargement, erreur, actualiser, deconnecter }}>{children}</Ctx.Provider>
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession hors de SessionProvider')
  return s
}
