// Publier la version à jour : les invités voient ces changements, et seuls les enseignants concernés
// par un changement sont prévenus par e-mail.

import { CheckCircle2, Loader2, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog } from '@/components/ui'
import { publierEdt } from '@/lib/api'
import { useStore } from '@/lib/store'
import { fmtDateHeure } from '@/lib/time'
import { aPublier, copiePubliee, publierLocal } from '@/lib/versions'
import type { EmploiDuTemps } from '@/types/db'

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`
/** « 3 enseignants concernés » */
const concernes = (n: number) => `${n} enseignant${n > 1 ? 's' : ''} concerné${n > 1 ? 's' : ''}`

export function BoutonPublier({ travail }: { travail: EmploiDuTemps }) {
  const { db, mutate, connecte, recharger } = useStore()
  const diff = useMemo(() => aPublier(db, travail), [db, travail])
  const copie = copiePubliee(db, travail.id_semestre)
  const [confirmer, setConfirmer] = useState(false)
  const [envoi, setEnvoi] = useState(false)
  const possible = diff.total > 0 || diff.horsLigne

  const publier = async () => {
    setEnvoi(true)
    try {
      if (!connecte) {
        mutate((x) => publierLocal(x, travail))
        toast.success('Publié', { description: `${concernes(diff.enseignants)} (simulation : aucun e-mail).` })
      } else {
        const { notification: n } = await publierEdt(travail.id_edt)
        const sans = n.sans_adresse ? ` ${concernes(n.sans_adresse)} sans adresse e-mail : à renseigner dans le Référentiel.` : ''
        if (n.statut === 'smtp_non_configure') {
          toast.warning('Publié, e-mails non envoyés', {
            description: `${concernes(n.destinataires)} : aucun e-mail envoyé, car l'envoi n'est pas configuré (SMTP dans backend/.env).${sans}`,
          })
        } else if (n.statut === 'en_cours') {
          toast.success('Publié', { description: `Visible dès maintenant par les invités. E-mail en cours d'envoi : ${concernes(n.destinataires)}.${sans}` })
        } else if (n.sans_adresse) {
          toast.warning('Publié, personne de prévenu', { description: `Visible dès maintenant par les invités.${sans}` })
        } else {
          toast.success('Publié', { description: 'Visible dès maintenant par les invités. Aucun enseignant concerné.' })
        }
        await recharger()
      }
      setConfirmer(false)
    } catch (e) {
      toast.error('Publication refusée', { description: (e as Error).message, duration: 15000 })
      setConfirmer(false)
      await recharger()
    } finally {
      setEnvoi(false)
    }
  }

  const compteurs: [string, number][] = [
    ['Ajoutées', diff.ajoutees],
    ['Annulées', diff.annulees],
    ['Retirées', diff.retirees],
    ['Modifiées', diff.modifiees],
  ]

  return (
    <>
      <span className="flex items-center gap-1.5 text-sm text-ink-2" data-a-publier={diff.total}>
        {possible ? (
          diff.total > 0 ? `${pluriel(diff.total, 'modification')} non publiée${diff.total > 1 ? 's' : ''}` : 'Pas en ligne actuellement'
        ) : copie?.date_publication ? (
          <><CheckCircle2 className="size-4 text-[#15803D]" />Tout est publié · {fmtDateHeure(copie.date_publication)}</>
        ) : 'Rien à publier'}
      </span>
      <Button variant="accent" onClick={() => setConfirmer(true)} disabled={!possible}><Send />Publier</Button>

      <Dialog
        open={confirmer}
        onClose={() => !envoi && setConfirmer(false)}
        title="Publier la version à jour ?"
        description="Les invités verront ces changements immédiatement."
        footer={
          <>
            <Button variant="ghost" disabled={envoi} onClick={() => setConfirmer(false)}>Annuler</Button>
            <Button variant="accent" disabled={envoi} onClick={() => void publier()}>{envoi ? <Loader2 className="animate-spin" /> : <Send />}Publier</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {compteurs.map(([l, v]) => (
            <div key={l} className="rounded-2xl bg-subtle p-3">
              <p className="section-label">{l}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-ink-2">
          {diff.enseignants
            ? `${concernes(diff.enseignants)} par un changement ${diff.enseignants > 1 ? 'seront prévenus par e-mail, chacun avec ses seules séances touchées' : 'sera prévenu par e-mail, avec ses seules séances touchées'}. Les autres ne reçoivent rien.`
            : "Aucun enseignant n'est concerné : aucun e-mail ne partira."}
        </p>
        {diff.sansAdresse > 0 && (
          <p className="mt-2 rounded-2xl bg-highlight px-3 py-2 text-sm text-[#7C4A03]">
            {diff.sansAdresse === diff.enseignants ? (diff.enseignants > 1 ? 'Aucun de ces enseignants n\'a' : 'Cet enseignant n\'a pas') : `${pluriel(diff.sansAdresse, 'enseignant')} n'${diff.sansAdresse > 1 ? 'ont' : 'a'} pas`} d'adresse e-mail : {diff.sansAdresse > 1 ? 'ils ne recevront rien' : 'il ne recevra rien'}. À renseigner dans le Référentiel.
          </p>
        )}
      </Dialog>
    </>
  )
}
