// Compte connecté à la console (son identifiant). Avec Supabase Auth, il est fixé après la
// connexion par e-mail (/api/moi) et la session Supabase porte le jeton ; sinon, connexion
// de développement (compte choisi dans une liste).

import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'

const KEY = 'ultraplanning-session'
const listeners = new Set<() => void>()

function read(): number | null {
  try {
    const v = sessionStorage.getItem(KEY)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

/** Utilisateur connecté (lu hors React, pour l'en-tête des appels à l'API) */
export const sessionCourante = read

export function login(id_utilisateur: number) {
  try { sessionStorage.setItem(KEY, String(id_utilisateur)) } catch { /* ignoré */ }
  listeners.forEach((l) => l())
}

export function logout() {
  try { sessionStorage.removeItem(KEY) } catch { /* ignoré */ }
  if (supabase) void supabase.auth.signOut()
  listeners.forEach((l) => l())
}

export function useSession(): number | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    read,
    () => null,
  )
}
