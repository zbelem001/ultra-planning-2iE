// Base partagée entre l'interface invité et l'administration.
//
// - Mode simulé (sans VITE_API_URL) : jeu de données de démonstration, conservé dans le navigateur.
// - Mode connecté : image de la base chargée par l'API ; chaque modification est envoyée à l'API
//   (POST /api/base/sync), où les déclencheurs de la base la revalident. Si la base la refuse,
//   le motif est affiché et l'état réel est rechargé.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Db, EmploiDuTemps } from '@/types/db'
import { useSession } from './auth'
import { chargerBase, ErreurApi, MODE_CONNECTE, synchroniser, type Changements } from './api'

const STORAGE_KEY = 'ultraplanning-db-v9'

type Etat = 'pret' | 'chargement' | 'erreur'

interface Store {
  db: Db
  /** Applique une modification sur une copie de la base (style « producer ») */
  mutate: (fn: (draft: Db) => void) => void
  reset: () => void
  /** Recharge l'image de la base (mode connecté) */
  recharger: () => Promise<void>
  connecte: boolean
  /** Invité sans école précisée alors que plusieurs écoles utilisent la plateforme */
  ecoleAChoisir: boolean
}

const Ctx = createContext<Store | null>(null)

/** Clé primaire de chaque table (mêmes colonnes que schema_supabase.sql) */
const CLES: Record<Exclude<keyof Db, 'ecole'>, string[]> = {
  site: ['id_site'], filiere: ['id_filiere'], classe: ['id_classe'], groupe: ['id_groupe'], matiere: ['id_matiere'],
  enseignant: ['id_enseignant'], habilitation: ['id_habilitation'], absence_enseignant: ['id_absence'],
  sejour_enseignant: ['id_sejour'], creneau: ['id_creneau'], pause: ['id_pause'], jour_ferie: ['date_ferie'],
  conge: ['id_conge'], type_salle: ['id_type_salle'], salle: ['id_salle'], semestre: ['id_semestre'],
  utilisateur: ['id_utilisateur'], programme: ['id_programme'], cours: ['id_cours'],
  cours_seance_modele: ['id_cours', 'rang'], disponibilite: ['id_enseignant', 'id_creneau'],
  emploi_du_temps: ['id_edt'], contrainte: ['id_contrainte'], conversation: ['id_conversation'],
  prompt: ['id_prompt'], proposition: ['id_proposition'], seance: ['id_seance'],
}

const vide = (): Db => Object.fromEntries(Object.keys(CLES).map((t) => [t, []])) as unknown as Db

/** Différence entre deux images de la base, au format de /api/base/sync */
function difference(avant: Db, apres: Db): Changements | null {
  const out: Changements = {}
  for (const table of Object.keys(CLES) as (keyof typeof CLES)[]) {
    if (avant[table] === apres[table]) continue
    const pk = CLES[table]
    const cle = (r: Record<string, unknown>) => pk.map((c) => String(r[c])).join('|')
    const anciennes = new Map((avant[table] as unknown as Record<string, unknown>[]).map((r) => [cle(r), r]))
    const nouvelles = new Map((apres[table] as unknown as Record<string, unknown>[]).map((r) => [cle(r), r]))
    const upsert = [...nouvelles].filter(([k, r]) => JSON.stringify(anciennes.get(k)) !== JSON.stringify(r)).map(([, r]) => r)
    const supprimer = [...anciennes].filter(([k]) => !nouvelles.has(k)).map(([, r]) => Object.fromEntries(pk.map((c) => [c, r[c]])))
    if (upsert.length || supprimer.length) out[table] = { upsert, supprimer }
  }
  return Object.keys(out).length ? out : null
}

/** Mode simulé : base gardée dans le navigateur, sinon null (jeu de test à charger) */
function chargerLocal(): Db | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Db
  } catch {
    /* stockage indisponible : on repart du jeu de test */
  }
  return null
}

/** Jeu de test, téléchargé seulement en mode simulé (absent de l'espace invités en production) */
const jeuDeTest = () => import('@/data/mock').then((m) => m.createMockDb())

export function StoreProvider({ children }: { children: ReactNode }) {
  const session = useSession()
  const [db, setDb] = useState<Db>(() => (MODE_CONNECTE ? vide() : chargerLocal() ?? vide()))
  const [etat, setEtat] = useState<Etat>(MODE_CONNECTE || chargerLocal() === null ? 'chargement' : 'pret')
  const [erreur, setErreur] = useState('')
  const [ecoleAChoisir, setEcoleAChoisir] = useState(false)
  const courant = useRef(db)
  const file = useRef<Promise<unknown>>(Promise.resolve())

  const appliquer = useCallback((suivant: Db) => {
    courant.current = suivant
    setDb(suivant)
  }, [])

  const recharger = useCallback(async () => {
    if (!MODE_CONNECTE) return
    try {
      appliquer(await chargerBase(session !== null))
      setEcoleAChoisir(false)
      setEtat('pret')
    } catch (e) {
      if (session === null && e instanceof ErreurApi && e.statut === 422) {
        // Plusieurs écoles et aucune dans l'adresse : l'espace invités propose de choisir,
        // la page de connexion de la console reste accessible
        appliquer(vide())
        setEcoleAChoisir(true)
        setEtat('pret')
        return
      }
      setErreur(e instanceof Error ? e.message : String(e))
      setEtat('erreur')
    }
  }, [session, appliquer])

  // Mode simulé, première visite : jeu de test
  useEffect(() => {
    if (MODE_CONNECTE || etat !== 'chargement') return
    void jeuDeTest().then((d) => { appliquer(d); setEtat('pret') })
  }, [etat, appliquer])

  // Au démarrage et à chaque connexion / déconnexion : image publique ou complète
  useEffect(() => {
    if (!MODE_CONNECTE) return
    setEtat('chargement')
    void recharger()
  }, [recharger])

  useEffect(() => {
    if (MODE_CONNECTE) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
    } catch {
      /* ignoré */
    }
  }, [db])

  const mutate = useCallback((fn: (draft: Db) => void) => {
    const avant = courant.current
    const apres = structuredClone(avant)
    fn(apres)
    appliquer(apres)
    if (!MODE_CONNECTE) return
    const changements = difference(avant, apres)
    if (!changements) return
    // Envois dans l'ordre des modifications ; un refus annule l'affichage et recharge l'état réel
    file.current = file.current.then(() =>
      synchroniser(changements)
        // Identifiants déjà pris par une autre école : l'API a renuméroté, on relit les vrais
        .then((r) => (Object.keys(r.identifiants ?? {}).length ? recharger() : undefined))
        .catch(async (e: Error) => {
          toast.error('Modification refusée par la base', { description: e.message })
          await recharger()
        }),
    )
  }, [appliquer, recharger])

  const reset = useCallback(() => {
    if (MODE_CONNECTE) void recharger()
    else void jeuDeTest().then(appliquer)
  }, [appliquer, recharger])

  const value = useMemo(
    () => ({ db, mutate, reset, recharger, connecte: MODE_CONNECTE, ecoleAChoisir }),
    [db, mutate, reset, recharger, ecoleAChoisir],
  )

  if (etat === 'chargement') {
    return <div className="grid min-h-dvh place-items-center text-sm text-ink-2">Chargement des données…</div>
  }
  if (etat === 'erreur') {
    return (
      <div className="grid min-h-dvh place-items-center px-4 text-center">
        <div>
          <p className="text-xl font-light">Données indisponibles</p>
          <p className="mt-2 text-sm text-ink-2">{erreur}</p>
          <button type="button" onClick={() => void recharger()} className="mt-4 rounded-full bg-navy px-5 py-2 text-sm text-white">Réessayer</button>
        </div>
      </div>
    )
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore hors de StoreProvider')
  return s
}

/** Prochain identifiant pour une colonne IDENTITY */
export function nextId<T>(rows: T[], key: keyof T): number {
  return rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0) + 1
}

/** École affichée dans les en-têtes : celle du compte ou de l'invité ; 2iE pour les données simulées */
export function ecoleCourante(db: Db): { code: string; nom: string } | null {
  if (!MODE_CONNECTE) return { code: '2iE', nom: "Institut International d'Ingénierie de l'Eau et de l'Environnement" }
  const e = db.ecole?.[0]
  return e ? { code: e.code_ecole, nom: e.nom } : null
}

/** Emploi du temps publié (consultation) */
export function edtPublie(db: Db): EmploiDuTemps | undefined {
  return [...db.emploi_du_temps].filter((e) => e.statut === 'publie').sort((a, b) => b.version - a.version)[0]
}

/** Emploi du temps de travail de l'administration : dernier brouillon, sinon le plus récent */
export function edtTravail(db: Db): EmploiDuTemps {
  const list = [...db.emploi_du_temps].sort((a, b) => b.version - a.version)
  return list.find((e) => e.statut === 'brouillon' || e.statut === 'valide') ?? list[0]
}
