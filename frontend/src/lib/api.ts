// Client de l'API (backend FastAPI). Mode connecté seulement si VITE_API_URL est défini ;
// sinon l'application fonctionne sur son jeu de données simulé.

import type { Db, Seance } from '@/types/db'
import { logout, sessionCourante } from './auth'
import { obtenirSupabase, sessionSupabasePresente, SUPABASE_ACTIF } from './supabase'

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
  if (SUPABASE_ACTIF) {
    if (!sessionSupabasePresente()) return {}  // invité : rien à charger
    const { data } = await (await obtenirSupabase()).auth.getSession()
    return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}
  }
  const session = sessionCourante()
  return session !== null ? { 'X-Utilisateur': String(session) } : {}
}

/** Requête vers l'API ; lève ErreurApi si elle échoue (motif renvoyé par l'API) */
async function requete(chemin: string, options: RequestInit = {}): Promise<Response> {
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
  if (rep.status === 401 && SUPABASE_ACTIF && sessionCourante() !== null) logout()
  if (!rep.ok && rep.status !== 304) { // 304 : rien de nouveau depuis l'étiquette envoyée (If-None-Match)
    let message = `Erreur ${rep.status}`
    try {
      const corps = await rep.json()
      message = typeof corps.detail === 'string' ? corps.detail : JSON.stringify(corps.detail ?? corps)
    } catch {
      /* corps vide */
    }
    throw new ErreurApi(rep.status, message)
  }
  return rep
}

async function appel<T>(chemin: string, options: RequestInit = {}): Promise<T> {
  return (await requete(chemin, options)).json() as Promise<T>
}

const post = <T>(chemin: string, corps?: unknown) =>
  appel<T>(chemin, { method: 'POST', body: corps === undefined ? undefined : JSON.stringify(corps) })

// --- base -------------------------------------------------------------------

/** École consultée par les invités : ?ecole=CODE dans l'adresse, sinon VITE_ECOLE, sinon la seule école active */
export const ECOLE_PUBLIQUE: string =
  new URLSearchParams(window.location.search).get('ecole') ?? (import.meta.env.VITE_ECOLE as string | undefined) ?? ''

const CHEMIN_PUBLIC = `/api/base/public${ECOLE_PUBLIQUE ? `?ecole=${encodeURIComponent(ECOLE_PUBLIQUE)}` : ''}`

/** Image de la base (console : complète ; invités : publique) et son étiquette ETag. Avec `connue`
 *  (étiquette déjà en main), db vaut null si rien n'a changé : réponse 304, presque aucune donnée. */
export async function chargerBase(complete: boolean, connue: string | null = null): Promise<{ db: Db | null; etiquette: string | null }> {
  const rep = await requete(complete ? '/api/base' : CHEMIN_PUBLIC, connue ? { headers: { 'If-None-Match': connue } } : {})
  const etiquette = rep.headers.get('ETag')
  if (rep.status === 304 || (connue !== null && etiquette === connue)) return { db: null, etiquette: etiquette ?? connue }
  return { db: (await rep.json()) as Db, etiquette }
}

export type Changements = Record<string, { upsert: unknown[]; supprimer: Record<string, unknown>[] }>
/** `identifiants` : nouvelles lignes renumérotées par l'API (numéro déjà pris par une autre école) */
export const synchroniser = (tables: Changements) =>
  post<{ upsert: number; supprimer: number; identifiants: Record<string, Record<string, number>> }>('/api/base/sync', { tables })

export interface ResultatPublication {
  id_edt: number
  id_publie: number
  ajoutees: number
  retirees: number
  modifiees: number
  notification: { statut: 'personne' | 'smtp_non_configure' | 'en_cours'; destinataires: number; sans_adresse: number }
}
/** Publie la version à jour et prévient par e-mail les seuls enseignants concernés par un changement */
export const publierEdt = (id_edt: number) => post<ResultatPublication>(`/api/emplois-du-temps/${id_edt}/publier`)

// --- historique de la version à jour ------------------------------------------------

export interface VersionEdt {
  numero: number
  date: string
  origine: string
  origine_libelle: string
  auteur: string | null
  titre: string
  ajoutees: number
  retirees: number
  modifiees: number
  /** Date de sa dernière publication, si elle a été publiée */
  publiee_le: string | null
  /** C'est la version que voient les invités */
  en_ligne: boolean
}
export interface ResultatRestauration {
  numero: number
  date: string
  ajoutees: number
  retirees: number
  modifiees: number
  inchangees: number
  refusees: number
  exemples: { seance: string; motif: string }[]
  appliquee: boolean
}
export const versionsEdt = (id_edt: number, avant?: number) =>
  appel<{ total: number; gardees?: number; versions: VersionEdt[] }>(`/api/emplois-du-temps/${id_edt}/versions?limite=100${avant ? `&avant=${avant}` : ''}`)
export const seancesVersion = (id_edt: number, numero: number) =>
  appel<{ numero: number; date: string; seances: Seance[]; hors_referentiel: number }>(`/api/emplois-du-temps/${id_edt}/versions/${numero}`)
/** appliquer faux : aperçu, rien n'est écrit */
export const restaurerVersion = (id_edt: number, numero: number, appliquer: boolean) =>
  post<ResultatRestauration>(`/api/emplois-du-temps/${id_edt}/versions/${numero}/restaurer`, { appliquer })

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
  id_enseignant: number | null
}

export interface TacheGeneration {
  id: string
  statut: 'en_attente' | 'en_cours' | 'terminee' | 'appliquee' | 'erreur'
  erreur: string | null
  /** Modules demandés mais pas prêts (matière inconnue, hors programme, sans cours) */
  avertissements?: string[]
  statistiques?: { heures_demandees: number; heures_placees: number; heures_reportees?: number; duree_s: number; cours: number; semaines: number; iterations: number }
  non_places?: { id_cours: number; heures: number; code: string; raison: string }[]
  seances?: SeanceGeneree[]
  seances_remplacees?: number
}

export const lancerGeneration = (d: { id_edt: number; filieres: string[]; classes: string[]; matieres: string[]; du: string; au: string; minimiser_changements: boolean; garder_verrouillees: boolean; completer: boolean }) =>
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
  modele?: string | null
}

/** Étape du traitement d'un message : contextualisation, analyse, verification, calcul, reflexion,
 *  redaction, relais ; « resultat » complète l'étape précédente (issue d'une vérification, d'un calcul) */
export interface EtapeAssistant {
  etape: string
  detail: string
}

/** Envoie un message et reçoit les étapes au fur et à mesure (Server-Sent Events), puis la réponse */
/** Fichier joint à un message : `contenu` en base64 (5 Mo au plus avant encodage) */
export interface PieceJointe { nom: string; contenu: string }
export const FORMATS_PIECE_JOINTE = '.csv,.xlsx,.pdf,.txt,.png,.jpg,.jpeg,.webp'
export const TAILLE_MAX_PIECE_JOINTE = 5 * 1024 * 1024

export async function lirePieceJointe(f: File): Promise<PieceJointe> {
  const url = await new Promise<string>((ok, ko) => {
    const r = new FileReader()
    r.onload = () => ok(r.result as string)
    r.onerror = () => ko(new Error('Fichier illisible'))
    r.readAsDataURL(f)
  })
  return { nom: f.name, contenu: url.slice(url.indexOf(',') + 1) }
}

export async function envoyerMessageFlux(
  id_edt: number, texte: string, id_conversation: number | null, surEtape: (e: EtapeAssistant) => void,
  piece_jointe?: PieceJointe, surTexte?: (morceau: string | null) => void,
): Promise<ReponseAssistant> {
  const rep = await requete('/api/assistant/messages/flux', {
    method: 'POST', body: JSON.stringify({ id_edt, texte, id_conversation, piece_jointe }),
  })
  const lecteur = rep.body!.getReader()
  const decodeur = new TextDecoder()
  let tampon = ''
  for (;;) {
    const { value, done } = await lecteur.read()
    if (done) break
    tampon += decodeur.decode(value, { stream: true })
    let fin: number
    while ((fin = tampon.indexOf('\n\n')) >= 0) {
      const bloc = tampon.slice(0, fin)
      tampon = tampon.slice(fin + 2)
      if (!bloc.startsWith('data: ')) continue
      const ev = JSON.parse(bloc.slice(6))
      if (ev.type === 'etape') surEtape({ etape: ev.etape, detail: ev.detail })
      else if (ev.type === 'texte') surTexte?.(ev.morceau)
      else if (ev.type === 'efface') surTexte?.(null) // ce texte n'était pas la réponse
      else if (ev.type === 'erreur') throw new ErreurApi(0, ev.detail)
      else if (ev.type === 'fin') return ev as ReponseAssistant
    }
  }
  throw new ErreurApi(0, "La réponse de l'assistant s'est interrompue.")
}

export const envoyerMessage = (id_edt: number, texte: string, id_conversation: number | null) =>
  post<ReponseAssistant>('/api/assistant/messages', { id_edt, texte, id_conversation })
export interface ResultatApplication {
  seances_supprimees: number
  seances_creees: number
  seances_modifiees: number
  /** Changements du référentiel */
  nature: 'seances' | 'referentiel'
  lignes_ajoutees?: number
  lignes_modifiees?: number
  lignes_supprimees?: number
  lignes_deja_presentes?: number
  /** Génération ou replanification lancée après les changements du référentiel : nouvelle proposition de séances */
  suite: { id_proposition: number | null; message: string } | null
}
export const appliquerProposition = (id: number) => post<ResultatApplication>(`/api/propositions/${id}/appliquer`)
export const rejeterProposition = (id: number) => post<{ statut: string }>(`/api/propositions/${id}/rejeter`)
