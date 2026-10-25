// Client de l'API (backend FastAPI). Mode connecté seulement si VITE_API_URL est défini ;
// sinon l'application fonctionne sur son jeu de données simulé.

import type { Db } from '@/types/db'
import { logout, sessionCourante } from './auth'
import { supabase } from './supabase'

export const API_URL: string = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
export const MODE_CONNECTE = API_URL !== ''

export class ErreurApi extends Error {
  statut: number
  constructor(statut: number, message: string) {
    super(message)
    this.statut = statut
  }
}

/** Supabase Auth : jeton de la session ; développement : identifiant du compte choisi */
async function identification(): Promise<Record<string, string>> {
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
  }
  const session = sessionCourante()
  return session !== null ? { 'X-Utilisateur': String(session) } : {}
}

async function appel<T>(chemin: string, options: RequestInit = {}): Promise<T> {
  let rep: Response
  try {
    rep = await fetch(`${API_URL}${chemin}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(await identification()), ...options.headers },
    })
  } catch {
    throw new ErreurApi(0, "L'API est injoignable.")
  }
  // Session Supabase expirée ou compte désactivé : retour à l'espace invités
  if (rep.status === 401 && supabase && sessionCourante() !== null) logout()
  if (!rep.ok) {
    let message = `Erreur ${rep.status}`
    try {
      const corps = await rep.json()
      message = typeof corps.detail === 'string' ? corps.detail : JSON.stringify(corps.detail ?? corps)
    } catch {
      /* corps vide */
    }
    throw new ErreurApi(rep.status, message)
  }
  return rep.json() as Promise<T>
}

const post = <T>(chemin: string, corps?: unknown) =>
  appel<T>(chemin, { method: 'POST', body: corps === undefined ? undefined : JSON.stringify(corps) })

// --- base -------------------------------------------------------------------

/** École consultée par les invités : ?ecole=CODE dans l'adresse, sinon VITE_ECOLE, sinon la seule école active */
export const ECOLE_PUBLIQUE: string =
  new URLSearchParams(window.location.search).get('ecole') ?? (import.meta.env.VITE_ECOLE as string | undefined) ?? ''

export const chargerBase = (complete: boolean) =>
  appel<Db>(complete ? '/api/base' : `/api/base/public${ECOLE_PUBLIQUE ? `?ecole=${encodeURIComponent(ECOLE_PUBLIQUE)}` : ''}`)

export type Changements = Record<string, { upsert: unknown[]; supprimer: Record<string, unknown>[] }>
/** `identifiants` : nouvelles lignes renumérotées par l'API (numéro déjà pris par une autre école) */
export const synchroniser = (tables: Changements) =>
  post<{ upsert: number; supprimer: number; identifiants: Record<string, Record<string, number>> }>('/api/base/sync', { tables })

export interface ResultatPublication {
  id_edt: number
  archive: number | null
  notification: { statut: 'desactivee' | 'personne' | 'smtp_non_configure' | 'en_cours'; destinataires?: number }
}
/** Publie une version (la précédente est archivée) et prévient par e-mail les enseignants concernés */
export const publierEdt = (id_edt: number, notifier: boolean) =>
  post<ResultatPublication>(`/api/emplois-du-temps/${id_edt}/publier`, { notifier })

// --- comptes de l'école (invitations par l'administrateur) --------------------------

export interface CompteEcole {
  id_utilisateur: number
  login: string
  email: string
  role: 'administrateur' | 'planificateur'
  est_actif: boolean
  date_creation: string
  invitation: 'en_attente' | 'acceptee' | 'non_envoyee' | 'inconnue'
}
const patch = <T>(chemin: string, corps: unknown) => appel<T>(chemin, { method: 'PATCH', body: JSON.stringify(corps) })
export const comptesEcole = {
  lister: () => appel<CompteEcole[]>('/api/ecole/comptes'),
  inviter: (c: { email: string; login: string; role: CompteEcole['role'] }) => post<CompteEcole>('/api/ecole/comptes', c),
  renvoyer: (id: number) => post<{ envoi: 'invitation' | 'reinitialisation' }>(`/api/ecole/comptes/${id}/inviter`),
  modifier: (id: number, c: Partial<Pick<CompteEcole, 'email' | 'login' | 'role' | 'est_actif'>>) =>
    patch<CompteEcole & { envoi: 'invitation' | null }>(`/api/ecole/comptes/${id}`, c),
}

/** Écoles actives (espace invités : choix de l'école quand l'adresse ne la précise pas) */
export const ecoles = () => appel<{ code_ecole: string; nom: string; ville: string | null }[]>('/api/ecoles')

/** Premier semestre et premier emploi du temps d'une école qui n'en a pas encore */
export const demarrer = (d: { libelle: string; annee_academique: string; date_debut: string; date_fin: string }) =>
  post<{ id_semestre: number; id_edt: number }>('/api/demarrage', d)

export const comptes = () => appel<{ id_utilisateur: number; login: string; role: string }[]>('/api/comptes')

export interface Moi {
  id_utilisateur: number
  login: string
  email: string
  role: 'superadmin' | 'administrateur' | 'planificateur'
  ecole: { id_ecole: number; code_ecole: string; nom: string } | null
}
export const moi = () => appel<Moi>('/api/moi')

// --- génération ---------------------------------------------------------------

export interface SeanceGeneree {
  id_cours: number
  date_seance: string
  heure_debut: string
  heure_fin: string
  id_salle: number
}

export interface TacheGeneration {
  id: string
  statut: 'en_attente' | 'en_cours' | 'terminee' | 'appliquee' | 'erreur'
  erreur: string | null
  statistiques?: { heures_demandees: number; heures_placees: number; heures_reportees?: number; duree_s: number; cours: number; semaines: number; iterations: number }
  non_places?: { id_cours: number; heures: number; code: string; raison: string }[]
  seances?: SeanceGeneree[]
  seances_remplacees?: number
}

export const lancerGeneration = (d: { id_edt: number; filieres: string[]; classes: string[]; du: string; au: string; minimiser_changements: boolean; garder_verrouillees: boolean }) =>
  post<TacheGeneration>('/api/generations', d)
export const etatGeneration = (id: string) => appel<TacheGeneration>(`/api/generations/${id}`)
export const appliquerGeneration = (id: string) => post<{ seances_enregistrees: number }>(`/api/generations/${id}/appliquer`)

// --- assistant et propositions ----------------------------------------------------

export interface ReponseAssistant {
  id_conversation: number
  id_prompt: number
  statut: 'traite' | 'erreur'
  reponse: string
  propositions: number[]
}

export const envoyerMessage = (id_edt: number, texte: string, id_conversation: number | null) =>
  post<ReponseAssistant>('/api/assistant/messages', { id_edt, texte, id_conversation })
export const appliquerProposition = (id: number) =>
  post<{ seances_supprimees: number; seances_creees: number }>(`/api/propositions/${id}/appliquer`)
export const rejeterProposition = (id: number) => post<{ statut: string }>(`/api/propositions/${id}/rejeter`)
