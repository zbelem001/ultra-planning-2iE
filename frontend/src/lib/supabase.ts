// Supabase Auth (connexion par e-mail). Sans VITE_SUPABASE_URL, la console garde la
// connexion de développement (choix du compte, API lancée avec ULTRAPLANNING_AUTH_DEV=1).
// La bibliothèque n'est chargée qu'à la connexion d'un gestionnaire : l'espace invités ne la
// télécharge jamais.

import type { SupabaseClient } from '@supabase/supabase-js'

// Lien d'invitation ou de nouveau mot de passe : lu avant que Supabase ne nettoie l'adresse
const fragment = new URLSearchParams(window.location.hash.slice(1))

/** Messages fréquents de Supabase Auth, en français */
export function traduireErreurAuth(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'E-mail ou mot de passe incorrect.'
  if (/link is invalid or has expired/i.test(message)) return 'Ce lien a expiré ou a déjà servi : demandez un nouveau lien.'
  if (/should be different from the old password/i.test(message)) return "Choisissez un mot de passe différent de l'ancien."
  if (/rate limit|too many requests/i.test(message)) return 'Trop de tentatives : réessayez dans quelques minutes.'
  if (/email not confirmed/i.test(message)) return "Adresse e-mail pas encore confirmée : suivez le lien de l'invitation."
  return message
}

export const LIEN_AUTH = {
  type: fragment.get('type') as 'invite' | 'recovery' | 'signup' | null,
  erreur: fragment.get('error_description') ? traduireErreurAuth(fragment.get('error_description')!) : null,
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const cle = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

/** Connexion par Supabase Auth configurée (sinon : connexion de développement) */
export const SUPABASE_ACTIF = Boolean(url && cle)

let client: Promise<SupabaseClient> | null = null
export function obtenirSupabase(): Promise<SupabaseClient> {
  client ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(url!, cle!))
  return client
}

/** Une session Supabase est enregistrée dans ce navigateur (sans charger la bibliothèque) */
export function sessionSupabasePresente(): boolean {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'))
  } catch {
    return false
  }
}
