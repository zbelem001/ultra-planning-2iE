// Historique de la version à jour : la liste des versions, de la plus récente à la première, et la
// restauration d'une version, avec un aperçu de ce qu'elle change et une confirmation.

import { History, Loader2, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Dialog, EmptyState } from '@/components/ui'
import { restaurerVersion, versionsEdt, type ResultatRestauration, type VersionEdt } from '@/lib/api'
import { fmtDateHeure } from '@/lib/time'

const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`

/** « 47 ajoutées, 2 retirées » : le détail d'une version qui touche plusieurs séances */
function ampleur(v: VersionEdt): string {
  return [
    v.ajoutees && pluriel(v.ajoutees, 'ajoutée'),
    v.modifiees && pluriel(v.modifiees, 'modifiée'),
    v.retirees && pluriel(v.retirees, 'retirée'),
  ].filter(Boolean).join(', ')
}

export function HistoriqueVersions({ id_edt, numero, onChoisir, actualisation }: {
  id_edt: number
  numero: number | null
  onChoisir: (v: VersionEdt, total: number) => void
  /** Change quand les séances changent (autre planificateur, assistant) : la liste se relit */
  actualisation: unknown
}) {
  const [versions, setVersions] = useState<VersionEdt[]>([])
  const [total, setTotal] = useState(0)
  const [etat, setEtat] = useState<'chargement' | 'pret' | 'erreur'>('chargement')
  const [erreur, setErreur] = useState('')
  const [suite, setSuite] = useState(false)
  const choix = useRef({ numero, onChoisir })
  useEffect(() => { choix.current = { numero, onChoisir } })

  useEffect(() => {
    let actif = true
    versionsEdt(id_edt)
      .then((r) => {
        if (!actif) return
        setVersions(r.versions)
        setTotal(r.total)
        setEtat('pret')
        const courant = choix.current
        if (r.versions[0] && courant.numero === null) courant.onChoisir(r.versions[0], r.total)
      })
      .catch((e: Error) => {
        if (!actif) return
        setErreur(e.message)
        setEtat('erreur')
      })
    return () => { actif = false }
  }, [id_edt, actualisation])

  const plusAnciennes = useCallback(async () => {
    setSuite(true)
    try {
      const r = await versionsEdt(id_edt, versions[versions.length - 1]?.numero)
      setVersions((l) => [...l, ...r.versions.filter((v) => !l.some((x) => x.numero === v.numero))])
    } catch (e) {
      toast.error('Versions non chargées', { description: (e as Error).message })
    } finally {
      setSuite(false)
    }
  }, [id_edt, versions])

  return (
    <Card className="flex h-fit flex-col p-4 xl:max-h-full xl:p-3">
      <p className="section-label px-1">Versions{etat === 'pret' && total ? ` (${total})` : ''}</p>
      <p className="mt-1 px-1 text-xs text-ink-2">Chaque modification enregistrée est une version. Choisissez-en une pour l'afficher et, si besoin, la restaurer.</p>
      {etat === 'chargement' && <p className="mt-4 flex items-center gap-2 px-1 text-sm text-ink-2"><Loader2 className="size-4 animate-spin" />Lecture de l'historique…</p>}
      {etat === 'erreur' && <p className="mt-4 px-1 text-sm text-[#991B1B]">{erreur}</p>}
      {etat === 'pret' && versions.length === 0 && <EmptyState icon={<History />} title="Aucune modification enregistrée pour l'instant" />}
      {etat === 'pret' && versions.length > 0 && (
        <ul className="mt-3 max-h-[70vh] min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 scroll-thin xl:max-h-none">
          {versions.map((v) => {
            const actif = v.numero === numero
            return (
              <li key={v.numero}>
                <button
                  type="button"
                  aria-current={actif ? 'true' : undefined}
                  onClick={() => onChoisir(v, total)}
                  className={cn('press block w-full rounded-2xl px-3 py-2.5 text-left text-sm ring-1', actif ? 'bg-navy text-white ring-navy' : 'bg-white/80 ring-white hover:bg-white')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium whitespace-nowrap tabular-nums">N° {v.numero}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      {v.en_ligne && <Badge tone="success" dot>En ligne</Badge>}
                      {!v.en_ligne && v.publiee_le && <Badge tone="neutral">Publiée</Badge>}
                    </span>
                  </span>
                  <span className={cn('mt-0.5 block text-xs', actif ? 'text-on-navy-2' : 'text-ink-2')}>{fmtDateHeure(v.date)}</span>
                  <span className="mt-1 line-clamp-2 block">{v.titre}</span>
                  <span className={cn('mt-0.5 block truncate text-xs', actif ? 'text-on-navy-2' : 'text-ink-2')}>
                    {[v.auteur, v.ajoutees + v.retirees + v.modifiees > 1 ? ampleur(v) : null].filter(Boolean).join(' · ') || v.origine_libelle}
                  </span>
                </button>
              </li>
            )
          })}
          {versions.length < total && (
            <li>
              <Button variant="ghost" size="sm" className="w-full" disabled={suite} onClick={() => void plusAnciennes()}>
                {suite && <Loader2 className="animate-spin" />}Versions plus anciennes
              </Button>
            </li>
          )}
        </ul>
      )}
    </Card>
  )
}

/** Bouton « Restaurer » : aperçu dans la base (rien n'est écrit), confirmation, puis restauration */
export function RestaurerVersion({ id_edt, version, derniere, onRestauree }: {
  id_edt: number
  version: VersionEdt
  derniere: boolean
  onRestauree: () => Promise<void> | void
}) {
  const [apercu, setApercu] = useState<ResultatRestauration | null>(null)
  const [calcul, setCalcul] = useState(false)
  const [envoi, setEnvoi] = useState(false)

  const ouvrir = async () => {
    setCalcul(true)
    try {
      setApercu(await restaurerVersion(id_edt, version.numero, false))
    } catch (e) {
      toast.error('Aperçu impossible', { description: (e as Error).message })
    } finally {
      setCalcul(false)
    }
  }

  const confirmer = async () => {
    setEnvoi(true)
    try {
      const r = await restaurerVersion(id_edt, version.numero, true)
      setApercu(null)
      toast.success(`Version ${version.numero} restaurée`, {
        description: `Publiez pour que les invités la voient.${r.refusees ? ` ${pluriel(r.refusees, 'séance')} n'${r.refusees > 1 ? 'ont' : 'a'} pas pu revenir.` : ''}`,
      })
      await onRestauree()
    } catch (e) {
      toast.error('Restauration refusée', { description: (e as Error).message })
    } finally {
      setEnvoi(false)
    }
  }

  const change = apercu ? apercu.ajoutees + apercu.modifiees + apercu.retirees : 0

  return (
    <>
      <Button variant="outline" size="sm" disabled={derniere || calcul} onClick={() => void ouvrir()}>
        {calcul ? <Loader2 className="animate-spin" /> : <RotateCcw />}{derniere ? 'Version actuelle' : 'Restaurer cette version'}
      </Button>
      {/* Hors de la carte : son flou d'arrière-plan enfermerait la fenêtre dans la carte */}
      {createPortal(<Dialog
        open={!!apercu}
        onClose={() => !envoi && setApercu(null)}
        title={`Restaurer la version ${version.numero} ?`}
        description={`Version du ${fmtDateHeure(version.date)}. Elle remplace la version à jour ; les invités ne voient rien tant que vous ne publiez pas.`}
        footer={
          <>
            <Button variant="ghost" disabled={envoi} onClick={() => setApercu(null)}>Annuler</Button>
            <Button variant="primary" disabled={envoi || change === 0} onClick={() => void confirmer()}>
              {envoi ? <Loader2 className="animate-spin" /> : <RotateCcw />}Restaurer
            </Button>
          </>
        }
      >
        {apercu && (
          <div className="grid gap-3 text-sm">
            {change === 0 && apercu.refusees === 0 && <p>Cette version est identique à la version à jour : rien à restaurer.</p>}
            {change > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-ink-2">
                {apercu.ajoutees > 0 && <li>{pluriel(apercu.ajoutees, 'séance')} {apercu.ajoutees > 1 ? 'reviennent' : 'revient'}</li>}
                {apercu.modifiees > 0 && <li>{pluriel(apercu.modifiees, 'séance')} {apercu.modifiees > 1 ? 'reprennent leur' : 'reprend son'} état de cette version</li>}
                {apercu.retirees > 0 && <li>{pluriel(apercu.retirees, 'séance')} ajoutée{apercu.retirees > 1 ? 's' : ''} depuis {apercu.retirees > 1 ? 'sont retirées' : 'est retirée'}</li>}
              </ul>
            )}
            {apercu.refusees > 0 && (
              <div className="rounded-2xl bg-highlight px-3 py-2 text-[#7C4A03]">
                <p className="font-medium">{pluriel(apercu.refusees, 'séance')} ne {apercu.refusees > 1 ? 'peuvent' : 'peut'} pas revenir :</p>
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs scroll-thin">
                  {apercu.exemples.map((x, i) => <li key={i}>{x.seance} : {x.motif}</li>)}
                </ul>
                {apercu.refusees > apercu.exemples.length && <p className="mt-1 text-xs">… et {apercu.refusees - apercu.exemples.length} autre(s)</p>}
              </div>
            )}
            {change > 0 && <p className="text-xs text-ink-2">Cette restauration s'ajoute à l'historique : vous pourrez revenir en arrière.</p>}
          </div>
        )}
      </Dialog>, document.body)}
    </>
  )
}
