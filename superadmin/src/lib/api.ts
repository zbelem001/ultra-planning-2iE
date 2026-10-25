// Client de l'API (../backend), routes /api/superadmin/*.

import { supabase } from './supabase'

export const API_URL: string = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const CLE_DEV = 'ultraplanning-superadmin-dev'

export class ErreurApi extends Error {
  statut: number
  constructor(statut: number, message: string) {
    super(message)
    this.statut = statut
  }
}

/** Compte choisi en connexion de développement (sans Supabase) */
export const compteDev = {
  lire: () => { try { return sessionStorage.getItem(CLE_DEV) } catch { return null } },
  ecrire: (id: number | null) => {
    try { if (id === null) sessionStorage.removeItem(CLE_DEV); else sessionStorage.setItem(CLE_DEV, String(id)) } catch { /* ignoré */ }
  },
}

// Erreurs de validation de l'API (pydantic), en français
const CHAMPS: Record<string, string> = {
  code_ecole: 'Code', nom: 'Nom', ville: 'Ville', pays: 'Pays', email_contact: 'E-mail de contact', email: 'E-mail', login: 'Identifiant',
}
function traduire(d: { loc?: string[]; msg: string; type?: string }): string {
  const champ = d.loc ? d.loc[d.loc.length - 1] : ''
  const quoi = /email/i.test(d.msg) ? 'adresse e-mail invalide'
    : d.type === 'string_too_short' ? 'trop court'
    : d.type === 'string_too_long' ? 'trop long'
    : d.msg.replace(/^Value error, /, '')
  return `${CHAMPS[champ] ?? champ} : ${quoi}`
}

async function entetes(): Promise<Record<string, string>> {
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
  }
  const id = compteDev.lire()
  return id ? { 'X-Utilisateur': id } : {}
}

async function appel<T>(chemin: string, options: RequestInit = {}): Promise<T> {
  let rep: Response
  try {
    rep = await fetch(`${API_URL}${chemin}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(await entetes()), ...options.headers },
    })
  } catch {
    throw new ErreurApi(0, "L'API est injoignable.")
  }
  if (!rep.ok) {
    let message = `Erreur ${rep.status}`
    try {
      const corps = await rep.json()
      if (typeof corps.detail === 'string') message = corps.detail
      else if (Array.isArray(corps.detail)) message = corps.detail.map(traduire).join(' ; ')
    } catch { /* corps vide */ }
    throw new ErreurApi(rep.status, message)
  }
  return rep.json() as Promise<T>
}

const envoyer = <T>(methode: 'POST' | 'PATCH', chemin: string, corps?: unknown) =>
  appel<T>(chemin, { method: methode, body: corps === undefined ? undefined : JSON.stringify(corps) })

export interface Compte {
  id_utilisateur: number
  login: string
  email: string
  role: 'superadmin' | 'administrateur' | 'planificateur'
  ecole: { id_ecole: number; code_ecole: string; nom: string } | null
}

export interface Ecole {
  id_ecole: number
  code_ecole: string
  nom: string
  ville: string | null
  pays: string | null
  email_contact: string | null
  statut: 'active' | 'suspendue'
  date_creation: string
  nb_comptes?: number
  nb_comptes_actifs?: number
  nb_administrateurs?: number
}

export type EcoleSaisie = Pick<Ecole, 'code_ecole' | 'nom' | 'ville' | 'pays' | 'email_contact'>

export interface CompteEcole {
  id_utilisateur: number
  login: string
  email: string
  role: 'administrateur' | 'planificateur'
  est_actif: boolean
  date_creation: string
  invitation: 'en_attente' | 'acceptee' | 'non_envoyee' | 'inconnue'
}

export interface LigneJournal {
  id_journal: number
  date_action: string
  action: 'creation' | 'modification' | 'suppression'
  origine: string
  id_seance: number
  id_edt: number
  version: number | null
  ecole: string
  utilisateur: string | null
  cours: string
  classe: string | null
  seance: { date: string | null; debut: string; fin: string; salle: string | null }
  changements: { champ: string; avant: unknown; apres: unknown }[]
}

export interface FiltresJournal {
  id_ecole?: number
  du?: string
  au?: string
  action?: LigneJournal['action']
  origine?: string
  avant?: number
}

export const api = {
  moi: () => appel<Compte>('/api/moi'),
  comptesDev: () => appel<{ id_utilisateur: number; login: string; role: string }[]>('/api/comptes?console=superadmin'),
  ecoles: () => appel<Ecole[]>('/api/superadmin/ecoles'),
  journal: (f: FiltresJournal) => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
    return appel<{ lignes: LigneJournal[]; suivant: number | null }>(`/api/superadmin/journal?${q}`)
  },
  creerEcole: (e: EcoleSaisie) => envoyer<Ecole>('POST', '/api/superadmin/ecoles', e),
  modifierEcole: (id: number, e: Partial<EcoleSaisie> & { statut?: Ecole['statut'] }) =>
    envoyer<Ecole>('PATCH', `/api/superadmin/ecoles/${id}`, e),
  comptes: (id: number) => appel<CompteEcole[]>(`/api/superadmin/ecoles/${id}/comptes`),
  inviter: (id: number, c: { email: string; login: string; role: CompteEcole['role'] }) =>
    envoyer<CompteEcole>('POST', `/api/superadmin/ecoles/${id}/comptes`, c),
  renvoyer: (id_utilisateur: number) =>
    envoyer<{ envoi: 'invitation' | 'reinitialisation' }>('POST', `/api/superadmin/comptes/${id_utilisateur}/inviter`),
  activer: (id_utilisateur: number, est_actif: boolean) =>
    envoyer<CompteEcole>('PATCH', `/api/superadmin/comptes/${id_utilisateur}`, { est_actif }),
  /** E-mail, login ou rôle ; `envoi` = 'invitation' si une nouvelle invitation est partie */
  modifierCompte: (id_utilisateur: number, c: Partial<Pick<CompteEcole, 'email' | 'login' | 'role'>>) =>
    envoyer<CompteEcole & { envoi: 'invitation' | null }>('PATCH', `/api/superadmin/comptes/${id_utilisateur}`, c),
}
