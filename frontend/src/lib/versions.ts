// Version de travail : copie (séances et contraintes) d'une version publiée ou archivée, en
// brouillon. Mode connecté : copie faite par l'API ; mode simulé : dans le navigateur.

import { toast } from 'sonner'
import type { Db, EmploiDuTemps } from '@/types/db'
import { nouvelleVersion as nouvelleVersionApi } from './api'
import { nextId } from './store'

export async function creerVersionDeTravail(
  source: EmploiDuTemps,
  { db, mutate, connecte, recharger, session }: {
    db: Db; mutate: (fn: (d: Db) => void) => void; connecte: boolean; recharger: () => Promise<void>; session: number | null
  },
) {
  if (connecte) {
    try {
      const r = await nouvelleVersionApi(source.id_edt)
      await recharger()
      toast.success(`Version ${r.version} créée en brouillon`, { description: `Copie de la version ${source.version} (${r.seances} séances).` })
    } catch (e) {
      toast.error('Version non créée', { description: (e as Error).message })
    }
    return
  }
  const id_edt = nextId(db.emploi_du_temps, 'id_edt')
  const version = Math.max(...db.emploi_du_temps.filter((e) => e.id_semestre === source.id_semestre).map((e) => e.version)) + 1
  mutate((x) => {
    x.emploi_du_temps.push({
      ...source, id_edt, version, statut: 'brouillon', mode_generation: 'manuel',
      date_creation: new Date().toISOString(), date_publication: null, id_utilisateur: session ?? source.id_utilisateur,
    })
    let idS = nextId(x.seance, 'id_seance')
    x.seance.push(...x.seance.filter((s) => s.id_edt === source.id_edt).map((s) => ({ ...s, id_seance: idS++, id_edt })))
    let idC = nextId(x.contrainte, 'id_contrainte')
    x.contrainte.push(...x.contrainte.filter((c) => c.id_edt === source.id_edt).map((c) => ({ ...c, id_contrainte: idC++, id_edt })))
  })
  toast.success(`Version ${version} créée en brouillon`, { description: `Copie de la version ${source.version}.` })
}
