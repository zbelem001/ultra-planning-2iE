// Bandeau des pages qui modifient l'emploi du temps quand la version courante est publiée :
// elle ne se modifie plus, il faut une version de travail.

import { CopyPlus, Loader2, Lock } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui'
import { useSession } from '@/lib/auth'
import { useStore } from '@/lib/store'
import { creerVersionDeTravail } from '@/lib/versions'
import type { EmploiDuTemps } from '@/types/db'

export function VersionPubliee({ edt }: { edt: EmploiDuTemps }) {
  const store = useStore()
  const session = useSession()
  const [envoi, setEnvoi] = useState(false)
  if (edt.statut !== 'publie' && edt.statut !== 'archive') return null

  const creer = async () => {
    setEnvoi(true)
    await creerVersionDeTravail(edt, { ...store, session })
    setEnvoi(false)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl bg-highlight px-5 py-4 ring-1 ring-orange-soft">
      <p className="flex min-w-0 items-start gap-3 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0 text-[#7C4A03]" />
        <span>
          <span className="font-medium">La version {edt.version} est {edt.statut === 'publie' ? 'publiée' : 'archivée'} : elle ne se modifie plus.</span>{' '}
          Pour générer ou modifier l'emploi du temps, créez une version de travail (copie de celle-ci). Les invités continuent de voir la version publiée jusqu'à ce que vous publiiez la nouvelle.
        </span>
      </p>
      <Button onClick={() => void creer()} disabled={envoi}>
        {envoi ? <Loader2 className="animate-spin" /> : <CopyPlus />}Créer une version de travail
      </Button>
    </div>
  )
}
