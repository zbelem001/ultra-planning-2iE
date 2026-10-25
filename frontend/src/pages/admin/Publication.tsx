// Validation, publication et historique des versions (BF-19), avec
// l'aperçu des changements et les e-mails aux enseignants concernés (BF-20).
// Mode connecté : la publication et les e-mails passent par l'API ; mode simulé : simulation.

import { Archive, CheckCircle2, CopyPlus, Eye, Send, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { PropositionCarte } from '@/components/PropositionCarte'
import { Badge, Button, Card, Dialog, PageTitle, SectionTitle, Switch } from '@/components/ui'
import { publierEdt } from '@/lib/api'
import { useSession } from '@/lib/auth'
import { edtPublie, edtTravail, nextId, useStore } from '@/lib/store'
import { fmtDateHeure } from '@/lib/time'
import type { Db, EmploiDuTemps, Seance } from '@/types/db'
import { STATUT_EDT } from './AdminLayout'

const cle = (s: Seance) => `${s.id_cours}|${s.date_seance}|${s.heure_debut}`

function differences(db: Db, a: EmploiDuTemps | undefined, b: EmploiDuTemps) {
  const A = new Map(db.seance.filter((s) => a && s.id_edt === a.id_edt).map((s) => [cle(s), s]))
  const B = new Map(db.seance.filter((s) => s.id_edt === b.id_edt).map((s) => [cle(s), s]))
  const ajoutees = [...B.keys()].filter((k) => !A.has(k)).map((k) => B.get(k)!)
  const retirees = [...A.keys()].filter((k) => !B.has(k)).map((k) => A.get(k)!)
  const modifiees = [...B.keys()].filter((k) => A.has(k)).filter((k) => {
    const x = A.get(k)!, y = B.get(k)!
    return x.id_salle !== y.id_salle || x.heure_fin !== y.heure_fin || (x.statut === 'annulee') !== (y.statut === 'annulee')
  }).map((k) => B.get(k)!)
  const touchees = [...ajoutees, ...retirees, ...modifiees]
  const cours = touchees.map((s) => db.cours.find((c) => c.id_cours === s.id_cours)!)
  return {
    ajoutees: ajoutees.length,
    retirees: retirees.length,
    modifiees: modifiees.length,
    enseignants: new Set(cours.map((c) => c.id_enseignant)).size,
    classes: new Set(cours.map((c) => c.id_classe)).size,
  }
}

export default function Publication() {
  const { db, mutate, connecte, recharger } = useStore()
  const session = useSession()
  const publie = edtPublie(db)
  const travail = edtTravail(db)
  const versions = [...db.emploi_du_temps].sort((a, b) => b.version - a.version)
  const diff = useMemo(() => (travail.id_edt !== publie?.id_edt ? differences(db, publie, travail) : null), [db, publie, travail])
  const [confirm, setConfirm] = useState<EmploiDuTemps | null>(null)
  const [notifier, setNotifier] = useState(true)

  const setStatut = (id_edt: number, statut: EmploiDuTemps['statut']) =>
    mutate((x) => { x.emploi_du_temps.find((e) => e.id_edt === id_edt)!.statut = statut })

  const publierServeur = async (e: EmploiDuTemps) => {
    setConfirm(null)
    try {
      const { notification: n } = await publierEdt(e.id_edt, notifier)
      const description = {
        desactivee: "Visible dès maintenant dans l'espace invités.",
        personne: 'Aucun enseignant concerné par les changements : aucun e-mail envoyé.',
        en_cours: `E-mail en cours d'envoi à ${n.destinataires} enseignant(s) concerné(s).`,
        smtp_non_configure: `${n.destinataires} enseignant(s) auraient dû être prévenus, mais l'envoi d'e-mails n'est pas configuré (SMTP dans backend/.env).`,
      }[n.statut]
      if (n.statut === 'smtp_non_configure') toast.warning(`Version ${e.version} publiée, e-mails non envoyés`, { description })
      else toast.success(`Version ${e.version} publiée`, { description })
    } catch (err) {
      toast.error('Publication refusée', { description: (err as Error).message })
    } finally {
      await recharger()
    }
  }

  const publier = (e: EmploiDuTemps) => {
    if (connecte) return void publierServeur(e)
    mutate((x) => {
      for (const v of x.emploi_du_temps) if (v.statut === 'publie') v.statut = 'archive'
      const cible = x.emploi_du_temps.find((k) => k.id_edt === e.id_edt)!
      cible.statut = 'publie'
      cible.date_publication = new Date().toISOString()
    })
    setConfirm(null)
    toast.success(`Version ${e.version} publiée`, {
      description: notifier && diff ? `Notification envoyée à ${diff.enseignants} enseignant(s) et ${diff.classes} classe(s) (simulation).` : "Visible dès maintenant dans l'espace invités.",
    })
  }

  const nouvelleVersion = (source: EmploiDuTemps) => {
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

  const enAttente = db.proposition
    .filter((p) => p.id_edt === travail.id_edt && p.statut === 'en_attente')
    .sort((a, b) => b.date_creation.localeCompare(a.date_creation))

  const aUnBrouillon = db.emploi_du_temps.some((e) => e.statut === 'brouillon' || e.statut === 'valide')

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle visible eyebrow="BF-19 · BF-20" title="Publication">
        <Link to="/" className="press inline-flex h-10 items-center gap-2 rounded-full border border-line bg-white/80 px-4 text-sm font-medium hover:bg-white [&_svg]:size-4"><Eye />Espace invités</Link>
      </PageTitle>

      {diff && (
        <Card className="p-5 sm:p-6">
          <SectionTitle eyebrow={`Version ${travail.version} comparée à la version publiée ${publie ? publie.version : '—'}`} title="Changements à publier" />
          <div className="mt-4 grid gap-3 sm:grid-cols-5">
            {[
              ['Ajoutées', diff.ajoutees],
              ['Retirées', diff.retirees],
              ['Modifiées', diff.modifiees],
              ['Enseignants touchés', diff.enseignants],
              ['Classes touchées', diff.classes],
            ].map(([l, v]) => (
              <div key={l} className="rounded-3xl bg-white/70 p-4 ring-1 ring-white">
                <p className="section-label">{l}</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums">{v}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {enAttente.length > 0 && (
        <Card className="p-5 sm:p-6">
          <SectionTitle eyebrow="Assistant IA" title={`Propositions à valider (${enAttente.length})`} />
          <p className="mt-1 text-sm text-ink-2">Calculées par le solveur à la demande de l'assistant. Appliquer une proposition modifie la version {travail.version} ; la base revalide chaque séance.</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {enAttente.map((p) => <PropositionCarte key={p.id_proposition} p={p} />)}
          </div>
        </Card>
      )}

      <Card className="p-5 sm:p-6">
        <SectionTitle eyebrow="Historique" title="Versions de l'emploi du temps" />
        <ul className="mt-4 divide-y divide-line/70">
          {versions.map((e) => {
            const st = STATUT_EDT[e.statut]
            const n = db.seance.filter((s) => s.id_edt === e.id_edt).length
            const u = db.utilisateur.find((x) => x.id_utilisateur === e.id_utilisateur)
            return (
              <li key={e.id_edt} className="flex flex-wrap items-center gap-4 py-4">
                <span className="grid size-12 place-items-center rounded-full bg-navy font-semibold text-white">v{e.version}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{e.libelle}</p>
                  <p className="text-sm text-ink-2">
                    {n} séances · {e.mode_generation} · créée le {fmtDateHeure(e.date_creation)} par {u?.login}
                    {e.date_publication && ` · publiée le ${fmtDateHeure(e.date_publication)}`}
                  </p>
                </div>
                <Badge tone={st.tone} dot pulse={e.statut === 'brouillon'}>{st.label}</Badge>
                <div className="flex flex-wrap gap-2">
                  {e.statut === 'brouillon' && <Button size="sm" variant="outline" onClick={() => { setStatut(e.id_edt, 'valide'); toast.success(`Version ${e.version} validée`) }}><CheckCircle2 />Valider</Button>}
                  {e.statut === 'valide' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setStatut(e.id_edt, 'brouillon')}><Undo2 />Brouillon</Button>
                      <Button size="sm" variant="accent" onClick={() => setConfirm(e)}><Send />Publier</Button>
                    </>
                  )}
                  {(e.statut === 'publie' || e.statut === 'archive') && !aUnBrouillon && (
                    <Button size="sm" variant="outline" onClick={() => nouvelleVersion(e)}><CopyPlus />Nouvelle version</Button>
                  )}
                  {e.statut === 'archive' && <Archive className="size-4 text-ink-2" aria-hidden />}
                </div>
              </li>
            )
          })}
        </ul>
      </Card>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Publier la version ${confirm?.version} ?`}
        description="Elle remplace la version publiée actuelle, qui sera archivée. Les invités la verront immédiatement."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
            <Button variant="accent" onClick={() => confirm && publier(confirm)}><Send />Publier</Button>
          </>
        }
      >
        <label className="flex items-center justify-between gap-4 rounded-3xl bg-subtle p-4">
          <span>
            <span className="block text-sm font-medium">Prévenir par e-mail les enseignants concernés</span>
            <span className="text-xs text-ink-2">
              {diff ? `${diff.enseignants} enseignant(s), avec la liste de leurs séances changées. ` : 'Aucun changement détecté. '}
              Les étudiants consultent l'espace invités.
            </span>
          </span>
          <Switch checked={notifier} onChange={setNotifier} label="Notifier par e-mail" />
        </label>
      </Dialog>
    </div>
  )
}
