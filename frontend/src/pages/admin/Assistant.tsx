// Assistant en langage naturel (tables CONVERSATION, PROMPT et PROPOSITION).
// Mode connecté : les messages partent à l'agent du backend (POST /api/assistant/messages),
// qui interroge le solveur et enregistre ses propositions. Mode simulé : on repère
// jour, période, classe et enseignant, puis on décrit les séances concernées.

import { ArrowUp, Bot, History, Loader2, MessageSquarePlus, Search, Trash2, UserRound } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PropositionCarte } from '@/components/PropositionCarte'
import { Badge, Button, Card, cn, Dialog, Input, PageTitle } from '@/components/ui'
import { envoyerMessage } from '@/lib/api'
import { useSession } from '@/lib/auth'
import { enrichir, nomEnseignant, publicCours } from '@/lib/queries'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { addDays, fmtDateHeure, fmtHeure, fmtJourCourt, fmtJourMois, jourOf, JOURS, mondayOf, todayIso, toIso, toMin } from '@/lib/time'
import type { Conversation, Db, Prompt } from '@/types/db'

const SUGGESTIONS = [
  'Libère le vendredi après-midi pour la L2INFO.',
  'Quelles séances a Ouédraogo le mardi ?',
  'Évite les cours de M1IA le jeudi matin.',
]

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** `precedent` : message précédent de la discussion, pour reprendre la classe ou l'enseignant cités */
function repondre(db: Db, id_edt: number, texte: string, precedent?: string): { reponse: string; statut: Prompt['statut'] } {
  const t = norm(texte)
  const jour = JOURS.find((j) => t.includes(norm(j)))
  const periode = /apres-midi|apres midi|aprem/.test(t) ? 'après-midi' : /matin/.test(t) ? 'matin' : null
  const trouverClasse = (s: string) => db.classe.find((c) => s.includes(norm(c.code_classe))) ?? db.classe.find((c) => new RegExp(`\\b${c.niveau.toLowerCase()}\\b`).test(s))
  const trouverEns = (s: string) => db.enseignant.find((e) => s.includes(norm(e.nom)))
  let classe = trouverClasse(t)
  let ens = trouverEns(t)
  if (precedent && !classe && !ens) {
    const p = norm(precedent)
    classe = trouverClasse(p)
    ens = trouverEns(p)
  }

  if (!jour && !classe && !ens) {
    return {
      statut: 'erreur',
      reponse: "Je n'ai reconnu ni jour, ni classe, ni enseignant dans la demande. Exemple : « Libère le vendredi après-midi pour la L2INFO ».",
    }
  }

  const lundi = mondayOf(todayIso())
  const list = enrichir(db, db.seance.filter((s) => s.id_edt === id_edt && s.statut !== 'annulee' && s.date_seance >= lundi && s.date_seance <= addDays(lundi, 6)))
    .filter((s) => !jour || jourOf(s.date_seance) === jour)
    .filter((s) => !periode || (periode === 'matin' ? toMin(s.heure_debut) < 12 * 60 : toMin(s.heure_debut) >= 12 * 60))
    .filter((s) => !classe || s.classe.id_classe === classe.id_classe)
    .filter((s) => !ens || s.enseignant.id_enseignant === ens.id_enseignant)

  const cible = [jour?.toLowerCase(), periode, classe?.code_classe, ens && nomEnseignant(ens)].filter(Boolean).join(' · ')
  if (!list.length) {
    return { statut: 'traite', reponse: `Aucune séance ne correspond (${cible}) cette semaine : rien à modifier.` }
  }
  const lignes = list
    .sort((a, b) => (a.date_seance + a.heure_debut).localeCompare(b.date_seance + b.heure_debut))
    .map((s) => `• ${fmtJourCourt(s.date_seance)} ${fmtHeure(s.heure_debut)}–${fmtHeure(s.heure_fin)} : ${s.matiere.libelle} (${s.cours.type_cours}), ${publicCours(s.classe, s.groupe)}, ${s.salle.nom_salle}`)
    .join('\n')
  const action = /libere|evite|deplace|supprime|retire/.test(t)
  return {
    statut: 'traite',
    reponse:
      `${list.length} séance(s) concernée(s) cette semaine (${cible}) :\n${lignes}` +
      (action
        ? `\n\nPour appliquer la demande, il faudrait déplacer ces séances en respectant CD-01 à CD-14. Simulation : rien n'a été modifié. Le moteur IA proposera les nouveaux créneaux une fois branché.`
        : ''),
  }
}

/** Date de dernière activité d'une conversation */
function derniere(db: Db, c: Conversation): string {
  return db.prompt.filter((p) => p.id_conversation === c.id_conversation).reduce((m, p) => (p.date_prompt > m ? p.date_prompt : m), c.date_creation)
}

function groupeDate(iso: string): string {
  const jour = toIso(new Date(iso))
  const today = todayIso()
  if (jour === today) return "Aujourd'hui"
  if (jour === addDays(today, -1)) return 'Hier'
  if (jour > addDays(today, -7)) return '7 derniers jours'
  return 'Plus ancien'
}

export default function Assistant() {
  const { db, mutate, connecte, recharger } = useStore()
  // Mode connecté : message en cours de traitement par l'agent (affiché en attendant sa réponse)
  const [envoi, setEnvoi] = useState<{ texte: string; id_conversation: number | null } | null>(null)
  const session = useSession()
  const edt = edtTravail(db)
  const [params, setParams] = useSearchParams()
  const [texte, setTexte] = useState('')
  const [enCours, setEnCours] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [historiqueMobile, setHistoriqueMobile] = useState(false)
  const [aSupprimer, setASupprimer] = useState<Conversation | null>(null)
  const fin = useRef<HTMLDivElement>(null)
  const saisie = useRef<HTMLTextAreaElement>(null)

  // Discussions de l'utilisateur connecté, de la plus récente à la plus ancienne
  const conversations = useMemo(
    () =>
      db.conversation
        .filter((c) => c.id_utilisateur === (session ?? 1))
        .map((c) => ({ c, last: derniere(db, c) }))
        .sort((a, b) => b.last.localeCompare(a.last)),
    [db, session],
  )
  const filtrees = useMemo(() => {
    const n = norm(q.trim())
    if (!n) return conversations
    return conversations.filter(({ c }) =>
      norm(c.titre).includes(n) || db.prompt.some((p) => p.id_conversation === c.id_conversation && norm(p.texte).includes(n)),
    )
  }, [conversations, q, db.prompt])

  // Discussion ouverte : paramètre ?c=, sinon la plus récente ; 'nouvelle' = brouillon vide
  const param = params.get('c')
  const courante =
    param === 'nouvelle' ? null : conversations.find(({ c }) => c.id_conversation === Number(param))?.c ?? (param ? null : conversations[0]?.c ?? null)
  const ouvrir = (id: number | 'nouvelle') => {
    setParams({ c: String(id) }, { replace: true })
    setHistoriqueMobile(false)
  }

  const prompts = courante
    ? db.prompt.filter((p) => p.id_conversation === courante.id_conversation).sort((a, b) => a.date_prompt.localeCompare(b.date_prompt))
    : []
  const edtConv = db.emploi_du_temps.find((e) => e.id_edt === (courante?.id_edt ?? edt.id_edt))!

  useEffect(() => {
    fin.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [prompts.length, enCours, courante?.id_conversation])

  const envoyerAuServeur = async (txt: string) => {
    const idConv = courante?.id_conversation ?? null
    setEnvoi({ texte: txt, id_conversation: idConv })
    setTexte('')
    try {
      const r = await envoyerMessage(courante?.id_edt ?? edt.id_edt, txt, idConv)
      await recharger()
      setParams({ c: String(r.id_conversation) }, { replace: true })
    } catch (e) {
      toast.error("L'assistant n'a pas pu répondre", { description: (e as Error).message })
      setTexte(txt)
    } finally {
      setEnvoi(null)
    }
  }

  const envoyer = (t: string) => {
    const txt = t.trim()
    if (!txt || enCours !== null || envoi !== null) return
    if (connecte) return void envoyerAuServeur(txt)
    const now = new Date().toISOString()
    const idPrompt = nextId(db.prompt, 'id_prompt')
    const nouvelle = !courante
    const idConv = courante?.id_conversation ?? nextId(db.conversation, 'id_conversation')
    const idEdt = courante?.id_edt ?? edt.id_edt
    const precedent = prompts[prompts.length - 1]?.texte
    mutate((x) => {
      if (nouvelle) {
        x.conversation.push({
          id_conversation: idConv,
          titre: txt.length > 48 ? `${txt.slice(0, 47).trimEnd()}…` : txt,
          date_creation: now,
          id_utilisateur: session ?? 1,
          id_edt: idEdt,
        })
      }
      x.prompt.push({ id_prompt: idPrompt, texte: txt, reponse: null, statut: 'en_attente', date_prompt: now, id_utilisateur: session ?? 1, id_edt: idEdt, id_conversation: idConv })
    })
    if (nouvelle) setParams({ c: String(idConv) }, { replace: true })
    setTexte('')
    setEnCours(idPrompt)
    setTimeout(() => {
      mutate((x) => Object.assign(x.prompt.find((p) => p.id_prompt === idPrompt)!, repondre(x, idEdt, txt, precedent)))
      setEnCours(null)
    }, 1100)
  }

  const supprimer = (c: Conversation) => {
    mutate((x) => {
      x.prompt = x.prompt.filter((p) => p.id_conversation !== c.id_conversation)
      x.conversation = x.conversation.filter((k) => k.id_conversation !== c.id_conversation)
    })
    if (courante?.id_conversation === c.id_conversation) setParams({ c: 'nouvelle' }, { replace: true })
    setASupprimer(null)
    toast.success('Discussion supprimée')
  }

  let dernierGroupe = ''

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle eyebrow="Tables CONVERSATION et PROMPT" title="Assistant IA" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {/* Historique des discussions */}
        <Card className={cn('h-[calc(100dvh-16rem)] min-h-[28rem] flex-col p-3 lg:sticky lg:top-4 lg:flex', historiqueMobile ? 'flex' : 'hidden')}>
          <Button variant="accent" className="w-full" onClick={() => { ouvrir('nouvelle'); setTimeout(() => saisie.current?.focus(), 0) }}>
            <MessageSquarePlus />Nouvelle discussion
          </Button>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-2" />
            <Input className="h-10 pl-10 sm:h-10" placeholder="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher dans l'historique" />
          </div>
          <nav aria-label="Historique des discussions" className="-mx-1 mt-3 flex-1 overflow-y-auto px-1 scroll-thin">
            {filtrees.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-2">{q ? 'Aucune discussion trouvée.' : 'Aucune discussion pour le moment.'}</p>}
            <ul className="space-y-0.5">
              {filtrees.map(({ c, last }) => {
                const g = groupeDate(last)
                const header = g !== dernierGroupe ? g : null
                dernierGroupe = g
                const actif = courante?.id_conversation === c.id_conversation
                const apercu = db.prompt.filter((p) => p.id_conversation === c.id_conversation).sort((a, b) => b.date_prompt.localeCompare(a.date_prompt))[0]
                const v = db.emploi_du_temps.find((e) => e.id_edt === c.id_edt)
                return (
                  <li key={c.id_conversation}>
                    {header && <p className="section-label px-3 pt-3 pb-1.5">{header}</p>}
                    <div className={cn('group relative rounded-2xl', actif ? 'bg-navy text-white' : 'hover:bg-white/80')}>
                      <button type="button" onClick={() => ouvrir(c.id_conversation)} aria-current={actif ? 'true' : undefined} className="block w-full rounded-2xl px-3 py-2.5 pr-10 text-left">
                        <span className="block truncate text-sm font-medium">{c.titre}</span>
                        <span className={cn('mt-0.5 flex items-center gap-1.5 text-xs', actif ? 'text-on-navy-2' : 'text-ink-2')}>
                          <span className={cn('shrink-0 rounded-full px-1.5 font-mono text-[10px]', actif ? 'bg-white/15' : 'bg-muted')}>v{v?.version}</span>
                          <span className="truncate">{apercu?.texte ?? 'Discussion vide'}</span>
                        </span>
                        <span className={cn('mt-0.5 block text-[11px]', actif ? 'text-on-navy-2' : 'text-ink-2/80')}>{fmtJourMois(toIso(new Date(last)))}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setASupprimer(c)}
                        aria-label={`Supprimer la discussion « ${c.titre} »`}
                        className={cn('absolute top-2 right-2 grid size-7 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', actif ? 'text-white hover:bg-white/15' : 'text-ink-2 hover:bg-muted')}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </nav>
        </Card>

        {/* Discussion */}
        <Card className="flex h-[calc(100dvh-16rem)] min-h-[28rem] min-w-0 flex-col p-0">
          <div className="flex items-center gap-3 border-b border-white/80 px-5 py-4 sm:px-7">
            <Button variant="outline" size="icon-sm" className="lg:hidden" onClick={() => setHistoriqueMobile((v) => !v)} aria-label="Afficher l'historique" aria-expanded={historiqueMobile}>
              <History />
            </Button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-xl font-light">{courante?.titre ?? 'Nouvelle discussion'}</h2>
              <p className="text-xs text-ink-2">
                {courante ? `Ouverte le ${fmtDateHeure(courante.date_creation)} · ` : ''}emploi du temps v{edtConv.version} ({edtConv.statut})
              </p>
            </div>
            <Badge tone="navy">{prompts.length} message{prompts.length > 1 ? 's' : ''}</Badge>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto p-5 sm:p-7 scroll-thin">
            {prompts.length === 0 && !envoi && (
              <div className="py-10 text-center text-ink-2">
                <Bot className="mx-auto size-8 text-navy" />
                <p className="mt-3">Décrivez une modification de l'emploi du temps en langage naturel.</p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => envoyer(s)} disabled={enCours !== null || envoi !== null} className="press rounded-full bg-white/80 px-3 py-1.5 text-xs text-ink-2 ring-1 ring-line hover:text-ink disabled:opacity-50">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {prompts.map((p) => {
              const u = db.utilisateur.find((x) => x.id_utilisateur === p.id_utilisateur)
              return (
                <div key={p.id_prompt} className="space-y-3">
                  <div className="flex justify-end gap-2">
                    <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-navy px-4 py-3 text-sm text-white">
                      <p>{p.texte}</p>
                      <p className="mt-1 text-[11px] text-on-navy-2">{u?.login} · {fmtDateHeure(p.date_prompt)}</p>
                    </div>
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line"><UserRound className="size-4" /></span>
                  </div>
                  <div className="flex gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-orange text-navy"><Bot className="size-4" /></span>
                    <div className={cn('max-w-[85%] rounded-3xl rounded-bl-lg px-4 py-3 text-sm ring-1', p.statut === 'erreur' ? 'bg-[#FEE2E2]/60 ring-[#FEE2E2]' : 'bg-white/85 ring-white')}>
                      {p.statut === 'en_attente' ? (
                        <span className="flex items-center gap-2 text-ink-2"><Loader2 className="size-4 animate-spin" />Analyse de la demande…</span>
                      ) : (
                        <>
                          <p className="whitespace-pre-line">{p.reponse}</p>
                          <div className="mt-2">{p.statut === 'traite' ? <Badge tone="success" dot>Traité</Badge> : <Badge tone="danger" dot>Erreur</Badge>}</div>
                          {db.proposition.filter((x) => x.id_prompt === p.id_prompt && x.statut !== 'rejetee').map((x) => (
                            <div key={x.id_proposition} className="mt-3"><PropositionCarte p={x} compacte /></div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {envoi && (envoi.id_conversation === (courante?.id_conversation ?? null)) && (
              <div className="space-y-3">
                <div className="flex justify-end gap-2">
                  <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-navy px-4 py-3 text-sm text-white"><p>{envoi.texte}</p></div>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white ring-1 ring-line"><UserRound className="size-4" /></span>
                </div>
                <div className="flex gap-2">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-orange text-navy"><Bot className="size-4" /></span>
                  <div className="rounded-3xl rounded-bl-lg bg-white/85 px-4 py-3 text-sm ring-1 ring-white">
                    <span className="flex items-center gap-2 text-ink-2"><Loader2 className="size-4 animate-spin" />L'assistant consulte l'emploi du temps et le solveur…</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={fin} />
          </div>

          <div className="border-t border-white/80 p-4 sm:p-5">
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); envoyer(texte) }}>
              <textarea
                ref={saisie}
                value={texte}
                onChange={(e) => setTexte(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); envoyer(texte) } }}
                rows={1}
                placeholder="Ex. : déplace le TP Réseaux du groupe TP-G3 au mercredi matin"
                aria-label="Demande à l'assistant"
                className="max-h-40 min-h-12 flex-1 resize-none rounded-3xl border border-white bg-white/80 px-5 py-3 text-base outline-none focus:ring-2 focus:ring-navy/70 sm:text-sm"
              />
              <Button type="submit" size="icon" className="size-12" disabled={!texte.trim() || enCours !== null || envoi !== null} aria-label="Envoyer">
                <ArrowUp />
              </Button>
            </form>
          </div>
        </Card>
      </div>

      <Dialog
        open={!!aSupprimer}
        onClose={() => setASupprimer(null)}
        title="Supprimer la discussion ?"
        description={aSupprimer ? `« ${aSupprimer.titre} » et ses messages seront supprimés.` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setASupprimer(null)}>Annuler</Button>
            <Button variant="destructive" onClick={() => aSupprimer && supprimer(aSupprimer)}><Trash2 />Supprimer</Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Les emplois du temps ne sont pas modifiés.</p>
      </Dialog>
    </div>
  )
}
