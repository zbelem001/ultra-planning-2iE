// Planification manuelle (BF-11 à BF-14) : glisser-déposer sur la grille,
// contrôle des contraintes dures en temps réel et salles compatibles proposées.

import { Ban, CalendarRange, CheckCircle2, CopyPlus, GripVertical, Lock, LockOpen, Trash2, Undo2, XCircle } from 'lucide-react'
import { useMemo, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Combobox, Dialog, EmptyState, PageTitle, PillTabs, Select, type ComboOption } from '@/components/ui'
import { SeanceDetail } from '@/components/timetable/SeanceDetail'
import { joursGrille, WeekGrid, type SlotState } from '@/components/timetable/WeekGrid'
import { WeekStrip } from '@/components/timetable/WeekStrip'
import { expandWeek } from '@/lib/generator'
import { couleurMatiere, enrichir, filtrer, lieuSalle, heuresPlanifiees, nomEnseignant, publicCours, type Ressource, type SeanceVue } from '@/lib/queries'
import { checkSeance, creneauAt, decoupage, sallesCompatibles, type SeanceDraft } from '@/lib/rules'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { addDays, fmtHeure, fmtJourCourt, fromMin, mondayOf, todayIso, toMin, weeksBetween } from '@/lib/time'
import type { Seance } from '@/types/db'

type Drag =
  | { kind: 'seance'; seance: SeanceVue }
  | { kind: 'modele'; id_cours: number; duree: number }

export default function Planification() {
  const { db, mutate } = useStore()
  const edt = edtTravail(db)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const weeks = useMemo(() => weeksBetween(semestre.date_debut, semestre.date_fin), [semestre])
  const lecture = edt.statut === 'publie' || edt.statut === 'archive'

  const [res, setRes] = useState<Exclude<Ressource, 'matiere'>>('classe')
  const [id, setId] = useState<number | null>(2)
  const [idGroupe, setIdGroupe] = useState<number | null>(null)
  const [semaine, setSemaine] = useState(() => (weeks.includes(mondayOf(todayIso())) ? mondayOf(todayIso()) : weeks[0]))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmDup, setConfirmDup] = useState(false)

  const jours = joursGrille(db, semaine)
  const toutes = useMemo(() => enrichir(db, db.seance.filter((s) => s.id_edt === edt.id_edt)), [db, edt.id_edt])
  const vues = useMemo(() => (id === null ? [] : filtrer(toutes, res, id, idGroupe)), [toutes, res, id, idGroupe])
  const semaineList = vues.filter((s) => s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6))
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of vues) m.set(mondayOf(s.date_seance), (m.get(mondayOf(s.date_seance)) ?? 0) + 1)
    return m
  }, [vues])

  // Cours concernés par la ressource affichée (panneau « à placer »)
  const coursRes = db.cours.filter((c) => {
    if (c.id_semestre !== semestre.id_semestre || id === null) return false
    if (res === 'classe') return c.id_classe === id && (idGroupe === null || c.id_groupe === null || c.id_groupe === idGroupe)
    if (res === 'enseignant') return c.id_enseignant === id
    return false
  })

  const options: ComboOption[] =
    res === 'classe'
      ? db.classe.map((c) => ({ value: c.id_classe, label: c.code_classe, hint: `${c.libelle} · ${c.effectif} étudiants` }))
      : res === 'enseignant'
        ? db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom.toUpperCase()} ${e.prenom}`, hint: e.grade ?? undefined }))
        : db.salle.map((s) => ({ value: s.id_salle, label: s.nom_salle, hint: `${s.capacite} places · ${lieuSalle(db, s)}` }))

  // ---------- Glisser-déposer ----------

  const draftFor = (d: Drag, date: string, heure: string): SeanceDraft | null => {
    const cr = creneauAt(db, date, heure)
    if (!cr) return null
    const duree = d.kind === 'seance' ? d.seance.duree : d.duree
    const base = d.kind === 'seance' ? d.seance : null
    return {
      id_seance: base?.id_seance,
      date_seance: date,
      heure_debut: heure,
      heure_fin: fromMin(toMin(heure) + duree * 60),
      statut: base?.statut === 'validee' ? 'planifiee' : base?.statut ?? 'planifiee',
      est_verrouillee: false,
      id_cours: d.kind === 'seance' ? d.seance.id_cours : d.id_cours,
      id_salle: base?.id_salle ?? db.salle[0].id_salle,
      id_creneau: cr.id_creneau,
      id_edt: edt.id_edt,
    }
  }

  // Validité de chaque créneau de la semaine pour l'élément en cours de glisser
  const slots = useMemo(() => {
    const m = new Map<string, SlotState & { salle?: number }>()
    if (!drag) return m
    for (const date of jours) {
      for (const cr of db.creneau) {
        const draft = draftFor(drag, date, cr.heure_debut)
        if (!draft) continue
        const key = `${date}|${cr.heure_debut}`
        if (drag.kind === 'seance' && checkSeance(db, draft).length === 0) {
          m.set(key, { ok: true, salle: draft.id_salle })
          continue
        }
        const compat = sallesCompatibles(db, draft)
        if (compat.length) m.set(key, { ok: true, salle: compat[0].id_salle })
        else {
          // motif : on contrôle avec une salle du bon type pour ne garder que l'essentiel
          const cours = db.cours.find((c) => c.id_cours === draft.id_cours)!
          const typee = db.salle.find((s) => cours.id_type_salle === null || s.id_type_salle === cours.id_type_salle)
          const vs = checkSeance(db, { ...draft, id_salle: drag.kind === 'seance' ? draft.id_salle : typee?.id_salle ?? draft.id_salle })
          const motif = vs.filter((v) => v.code !== 'CD-01').concat(vs.filter((v) => v.code === 'CD-01'))
          m.set(key, { ok: false, raison: motif.length ? motif.map((v) => `${v.code} : ${v.message}`).join('\n') : 'Aucune salle compatible libre (CD-01, CD-04, CD-05).' })
        }
      }
    }
    return m
  }, [drag, db, semaine]) // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (d: Drag, e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', JSON.stringify(d.kind))
    // différé : modifier la source pendant dragstart annule le glisser dans Chrome
    setTimeout(() => setDrag(d), 0)
  }
  const endDrag = () => { setDrag(null); setHover(null) }

  const onDrop = (date: string, heure: string) => {
    if (!drag) return
    const st = slots.get(`${date}|${heure}`)
    const draft = draftFor(drag, date, heure)
    if (!draft || !st?.ok || !st.salle) {
      toast.error('Placement refusé', { description: st?.raison })
      return endDrag()
    }
    const salle = db.salle.find((s) => s.id_salle === st.salle)!
    if (drag.kind === 'seance') {
      const avant = drag.seance.id_salle
      mutate((x) => {
        const s = x.seance.find((k) => k.id_seance === drag.seance.id_seance)!
        Object.assign(s, { ...draft, id_seance: s.id_seance, id_salle: salle.id_salle })
      })
      toast.success('Séance déplacée', {
        description: `${fmtJourCourt(date)} · ${fmtHeure(heure)}–${fmtHeure(draft.heure_fin)} · ${salle.nom_salle}${avant !== salle.id_salle ? ' (salle changée)' : ''}`,
      })
    } else {
      mutate((x) => {
        x.seance.push({ ...(draft as Seance), id_seance: nextId(x.seance, 'id_seance'), id_salle: salle.id_salle })
      })
      toast.success('Séance créée', { description: `${fmtJourCourt(date)} · ${fmtHeure(heure)}–${fmtHeure(draft.heure_fin)} · ${salle.nom_salle}` })
    }
    endDrag()
  }

  const hoverInfo = hover ? slots.get(hover) : undefined

  // ---------- Duplication de la semaine (BF-14) ----------

  const dupliquer = () => {
    const modele = db.seance.filter(
      (s) => s.id_edt === edt.id_edt && s.statut !== 'annulee' && s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6),
    )
    const suivant = addDays(semaine, 7)
    const gardees = db.seance.filter((s) => s.id_edt !== edt.id_edt || s.date_seance < suivant || s.est_verrouillee)
    const autres = gardees.filter((s) => s.id_edt !== edt.id_edt)
    const memeEdt = gardees.filter((s) => s.id_edt === edt.id_edt)
    const resultat = expandWeek(db, modele, edt.id_edt, suivant, memeEdt, nextId(db.seance, 'id_seance'))
    const ajoutees = resultat.length - memeEdt.length
    mutate((x) => { x.seance = [...autres, ...resultat] })
    setConfirmDup(false)
    toast.success('Semaine type dupliquée', { description: `${ajoutees} séances créées jusqu'au ${fmtJourCourt(semestre.date_fin)} (jours fériés et volumes respectés).` })
  }

  // ---------- Séance sélectionnée ----------

  const sel = selected !== null ? toutes.find((s) => s.id_seance === selected) ?? null : null
  const sallesPossibles = sel ? sallesCompatibles(db, sel) : []
  const update = (patch: Partial<Seance>, msg: string) => {
    if (!sel) return
    const next = { ...sel, ...patch }
    const vs = patch.statut === 'annulee' ? [] : checkSeance(db, next)
    if (vs.length) return toast.error('Modification refusée', { description: vs.map((v) => `${v.code} : ${v.message}`).join('\n') })
    mutate((x) => Object.assign(x.seance.find((k) => k.id_seance === sel.id_seance)!, patch))
    toast.success(msg)
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle visible eyebrow={`Version ${edt.version} · ${edt.statut}`} title="Planification">
        <Button variant="outline" onClick={() => setConfirmDup(true)} disabled={lecture}>
          <CopyPlus />Dupliquer la semaine
        </Button>
      </PageTitle>

      {lecture && (
        <Card className="bg-highlight/80 p-4 text-sm">Cette version est {edt.statut === 'publie' ? 'publiée' : 'archivée'} : créez une nouvelle version depuis l'onglet Publication pour la modifier.</Card>
      )}

      <Card className="p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)] lg:items-center">
          <PillTabs
            size="sm"
            value={res}
            onChange={(r) => { setRes(r); setId(null); setIdGroupe(null) }}
            items={[{ value: 'classe', label: 'Classe' }, { value: 'enseignant', label: 'Enseignant' }, { value: 'salle', label: 'Salle' }]}
          />
          <Combobox ariaLabel="Ressource à planifier" placeholder="Rechercher…" options={options} value={id} onChange={(v) => { setId(v); setIdGroupe(null) }} />
          {res === 'classe' && id !== null && db.groupe.some((g) => g.id_classe === id) ? (
            <Select aria-label="Groupe" value={idGroupe ?? ''} onChange={(e) => setIdGroupe(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Tous les groupes</option>
              {db.groupe.filter((g) => g.id_classe === id).map((g) => <option key={g.id_groupe} value={g.id_groupe}>{g.code_groupe}</option>)}
            </Select>
          ) : <div />}
        </div>
        <div className="mt-4">
          <WeekStrip weeks={weeks} value={semaine} onChange={setSemaine} counts={counts} />
        </div>
      </Card>

      {id === null ? (
        <Card><EmptyState icon={<CalendarRange />} title="Choisissez une classe, un enseignant ou une salle" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[19rem_minmax(0,1fr)]">
          {/* Cours à placer */}
          <Card className="h-fit p-4 xl:sticky xl:top-4">
            <p className="section-label px-1">Cours à placer</p>
            <p className="mt-1 px-1 text-xs text-ink-2">Glissez une séance type sur la grille. Les créneaux verts respectent toutes les contraintes dures.</p>
            {res === 'salle' ? (
              <p className="mt-4 px-1 text-sm text-ink-2">Choisissez une classe ou un enseignant pour placer des cours. Ici, vous pouvez déplacer les séances de la salle.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {coursRes.map((c) => {
                  const m = db.matiere.find((x) => x.id_matiere === c.id_matiere)!
                  const cl = db.classe.find((x) => x.id_classe === c.id_classe)!
                  const g = db.groupe.find((x) => x.id_groupe === c.id_groupe) ?? null
                  const e = db.enseignant.find((x) => x.id_enseignant === c.id_enseignant)!
                  const placees = toutes.filter((s) => s.id_cours === c.id_cours && s.statut !== 'annulee' && s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6))
                  const modele = decoupage(db, c.id_cours)
                  const restants = [...modele]
                  for (const p of placees) {
                    const i = restants.findIndex((r) => r.duree_heures === p.duree)
                    if (i >= 0) restants.splice(i, 1)
                  }
                  const plan = heuresPlanifiees(db, edt.id_edt, c.id_cours)
                  const plein = plan >= c.volume_horaire
                  return (
                    <li key={c.id_cours} className="rounded-2xl bg-white/80 p-3 ring-1 ring-white">
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurMatiere(m.id_matiere) }} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{m.libelle}</p>
                          <p className="truncate text-xs text-ink-2">{c.type_cours} · {publicCours(cl, g)} · {nomEnseignant(e)}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {restants.length === 0 && <Badge tone="success" dot>Semaine complète</Badge>}
                        {plein && restants.length > 0 && <Badge tone="warning" dot>Volume atteint</Badge>}
                        {!plein && !lecture && restants.map((r, i) => (
                          <button
                            key={`${r.rang}-${i}`}
                            type="button"
                            draggable
                            onDragStart={(ev) => startDrag({ kind: 'modele', id_cours: c.id_cours, duree: r.duree_heures }, ev)}
                            onDragEnd={endDrag}
                            className="press flex cursor-grab items-center gap-1 rounded-full bg-navy px-2.5 py-1 text-xs font-medium text-white active:cursor-grabbing"
                            title="Glisser sur la grille"
                          >
                            <GripVertical className="size-3" />{r.duree_heures} h
                          </button>
                        ))}
                        <span className="ml-auto font-mono text-[11px] text-ink-2 tabular-nums">{plan}/{c.volume_horaire} h</span>
                      </div>
                    </li>
                  )
                })}
                {coursRes.length === 0 && <li className="px-1 text-sm text-ink-2">Aucun cours pour cette sélection.</li>}
              </ul>
            )}
          </Card>

          {/* Grille */}
          <Card className="min-w-0 p-3 sm:p-5">
            <div className={cn('mb-3 flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors', !drag ? 'bg-muted/70 text-ink-2' : hoverInfo?.ok ? 'bg-[#DCFCE7] text-[#166534]' : hoverInfo ? 'bg-[#FEE2E2] text-[#991B1B]' : 'bg-highlight text-ink')}>
              {!drag && <>Cliquez une séance pour la modifier, ou glissez-la vers un autre créneau.</>}
              {drag && !hoverInfo && <>Survolez un créneau : vert = possible, rouge = contrainte dure violée.</>}
              {drag && hoverInfo?.ok && <><CheckCircle2 className="size-4 shrink-0" />Possible · {db.salle.find((s) => s.id_salle === hoverInfo.salle)?.nom_salle}</>}
              {drag && hoverInfo && !hoverInfo.ok && <><XCircle className="size-4 shrink-0" /><span className="line-clamp-2">{hoverInfo.raison}</span></>}
            </div>
            <WeekGrid
              db={db}
              idClasse={res === 'classe' ? id : null}
              days={jours}
              seances={semaineList}
              hide={res === 'enseignant' ? ['enseignant'] : res === 'salle' ? ['salle'] : []}
              selectedId={selected}
              onSelect={(s) => setSelected(s.id_seance)}
              edition={
                lecture
                  ? undefined
                  : {
                      dragging: !!drag,
                      slot: drag ? (d, h) => slots.get(`${d}|${h}`) : undefined,
                      onDrop: (d, h) => onDrop(d, h),
                      onDragStartSeance: (s, e) => startDrag({ kind: 'seance', seance: s }, e),
                      onDragEnd: endDrag,
                      onHover: (d, h) => setHover(`${d}|${h}`),
                    }
              }
            />
          </Card>
        </div>
      )}

      {/* Détail et actions sur une séance */}
      <Dialog
        open={!!sel}
        onClose={() => setSelected(null)}
        title="Séance"
        footer={
          sel && !lecture && (
            <>
              <Button variant="destructive" onClick={() => { mutate((x) => { x.seance = x.seance.filter((k) => k.id_seance !== sel.id_seance) }); setSelected(null); toast.success('Séance supprimée') }}>
                <Trash2 />Supprimer
              </Button>
              {sel.statut === 'annulee' ? (
                <Button variant="outline" onClick={() => update({ statut: 'planifiee' }, 'Séance rétablie')}><Undo2 />Rétablir</Button>
              ) : (
                <Button variant="outline" onClick={() => update({ statut: 'annulee' }, 'Séance annulée')}><Ban />Annuler la séance</Button>
              )}
              <Button variant="primary" onClick={() => update({ est_verrouillee: !sel.est_verrouillee }, sel.est_verrouillee ? 'Séance déverrouillée' : 'Séance verrouillée pour la génération')}>
                {sel.est_verrouillee ? <><LockOpen />Déverrouiller</> : <><Lock />Verrouiller</>}
              </Button>
            </>
          )
        }
      >
        {sel && (
          <div className="grid grid-cols-1 gap-5">
            <SeanceDetail s={sel} />
            {!lecture && sel.statut !== 'annulee' && (
              <div>
                <p className="section-label mb-2">Changer de salle (BF-13)</p>
                {sallesPossibles.length === 0 ? (
                  <p className="text-sm text-ink-2">Aucune autre salle compatible libre sur ce créneau.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {sallesPossibles.map((s) => (
                      <button
                        key={s.id_salle}
                        type="button"
                        onClick={() => update({ id_salle: s.id_salle }, `Salle changée : ${s.nom_salle}`)}
                        className={cn('press rounded-full px-3 py-1.5 text-xs font-medium ring-1', s.id_salle === sel.id_salle ? 'bg-navy text-white ring-navy' : 'bg-white text-ink ring-line hover:bg-subtle')}
                      >
                        {s.nom_salle} · {s.capacite} pl.
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-xs text-ink-2">Capacité ≥ {sel.groupe?.effectif ?? sel.classe.effectif} étudiants · type {sel.type_salle?.libelle} · salle libre de {fmtHeure(sel.heure_debut)} à {fmtHeure(sel.heure_fin)}.</p>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <Dialog
        open={confirmDup}
        onClose={() => setConfirmDup(false)}
        title="Dupliquer la semaine type"
        description={`Les séances de la semaine du ${fmtJourCourt(semaine)} seront recopiées sur toutes les semaines suivantes du semestre.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDup(false)}>Annuler</Button>
            <Button onClick={dupliquer}><CopyPlus />Dupliquer</Button>
          </>
        }
      >
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>Les séances non verrouillées des semaines suivantes sont remplacées, pour toutes les classes.</li>
          <li>Les jours fériés sont sautés (CD-09) et chaque cours s'arrête à son volume horaire (CD-08).</li>
          <li>{db.seance.filter((s) => s.id_edt === edt.id_edt && s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6) && s.statut !== 'annulee').length} séances dans la semaine type.</li>
        </ul>
      </Dialog>
    </div>
  )
}
