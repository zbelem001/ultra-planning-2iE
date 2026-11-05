// Planification manuelle (BF-11 à BF-14) : glisser-déposer sur la grille,
// contrôle des contraintes dures en temps réel et salles compatibles proposées.

import { Ban, CalendarPlus, CalendarRange, CheckCircle2, CopyPlus, GripVertical, History, Lock, LockOpen, Trash2, Undo2, UserMinus, Users, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import { BoutonPublier } from '@/components/BoutonPublier'
import { Badge, Button, Card, cn, Combobox, Dialog, EmptyState, PageTitle, PillTabs, Select, type ComboOption } from '@/components/ui'
import { DialogEpreuve, type DepartEpreuve } from '@/components/timetable/DialogEpreuve'
import { HistoriqueVersions, RestaurerVersion } from '@/components/timetable/HistoriqueVersions'
import { SeanceDetail } from '@/components/timetable/SeanceDetail'
import { joursGrille, WeekGrid, type Cible, type SelectionGrille, type SlotState } from '@/components/timetable/WeekGrid'
import { WeekStrip } from '@/components/timetable/WeekStrip'
import { seancesVersion, type VersionEdt } from '@/lib/api'
import { expandWeek } from '@/lib/generator'
import { couleurMatiere, enrichir, filtrer, lieuSalle, heuresPlanifiees, nomEnseignant, publicCours, type Ressource, type SeanceVue } from '@/lib/queries'
import { aPlacer } from '@/lib/aPlacer'
import { estEpreuve } from '@/lib/publics'
import { checkSeance, creneauAt, decoupage, evaluerCreneau, examenAvecRattrapage, sallesCompatibles, sallesDuCours, sallesPourEpreuves, type SeanceDraft } from '@/lib/rules'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { addDays, fmtDateHeure, fmtHeure, fmtJourCourt, fromMin, jourOf, mondayOf, todayIso, toMin, weeksBetween } from '@/lib/time'
import type { Seance } from '@/types/db'

// decalage : minutes entre le haut de la séance et le pointeur, là où elle a été saisie
type Drag =
  | { kind: 'seance'; seance: SeanceVue; decalage: number }
  | { kind: 'modele'; id_cours: number; duree: number; decalage: number }

// Une étiquette « 2 h » n'a pas de hauteur : le pointeur vise l'heure qu'il survole
const DECALAGE_MODELE = 30

export default function Planification() {
  const { db, mutate, connecte, recharger } = useStore()
  // « À jour » : la seule version modifiable, à publier. « Historique » : une version passée, en lecture seule.
  const edt = edtTravail(db)
  const [vue, setVue] = useState<'ajour' | 'historique'>('ajour')
  const lecture = vue === 'historique'
  const [versionChoisie, setVersionChoisie] = useState<{ version: VersionEdt; total: number } | null>(null)
  const [contenuVersion, setContenuVersion] = useState<{ numero: number; seances: Seance[]; hors_referentiel: number } | null>(null)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const weeks = useMemo(() => weeksBetween(semestre.date_debut, semestre.date_fin), [semestre])

  const [res, setRes] = useState<Exclude<Ressource, 'matiere'>>('classe')
  const [id, setId] = useState<number | null>(2)
  const [idGroupe, setIdGroupe] = useState<number | null>(null)
  const [semaine, setSemaine] = useState(() => (weeks.includes(mondayOf(todayIso())) ? mondayOf(todayIso()) : weeks[0]))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [cible, setCible] = useState<Cible | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmDup, setConfirmDup] = useState(false)
  // Épreuves : heures choisies sur la grille, menu du clic droit, fenêtre des détails
  const [selection, setSelection] = useState<SelectionGrille | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: SelectionGrille } | null>(null)
  const [epreuve, setEpreuve] = useState<DepartEpreuve | null>(null)

  const jours = joursGrille(db, semaine)
  const numeroChoisi = versionChoisie?.version.numero ?? null
  useEffect(() => {
    if (!lecture || numeroChoisi === null) return
    let actif = true
    seancesVersion(edt.id_edt, numeroChoisi)
      .then((r) => { if (actif) setContenuVersion(r) })
      .catch((e: Error) => { if (actif) toast.error('Version non chargée', { description: e.message }) })
    return () => { actif = false }
  }, [lecture, numeroChoisi, edt.id_edt])
  useEffect(() => {
    const surTouche = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setSelection(null) }
    }
    document.addEventListener('keydown', surTouche)
    return () => document.removeEventListener('keydown', surTouche)
  }, [])
  const ouvrirEpreuve = (nature: DepartEpreuve['nature'], s: SelectionGrille) => {
    setMenu(null)
    setEpreuve({
      nature, date: s.date, heure_debut: fromMin(s.debut), heure_fin: fromMin(s.fin),
      id_classe: res === 'classe' ? id : null, id_salle: res === 'salle' ? id : null,
    })
  }
  const changerDeVue = (v: 'ajour' | 'historique') => {
    setVue(v)
    setSelection(null)
    setSelected(null)
    setVersionChoisie(null)
    setContenuVersion(null)
  }
  const toutes = useMemo(
    () => enrichir(db, lecture ? contenuVersion?.seances ?? [] : db.seance.filter((s) => s.id_edt === edt.id_edt)),
    [db, edt.id_edt, lecture, contenuVersion],
  )
  const vues = useMemo(() => (id === null ? [] : filtrer(toutes, res, id, idGroupe, db.groupe)), [toutes, res, id, idGroupe, db.groupe])
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
        ? [
            { value: 0, label: 'À désigner', hint: `${toutes.filter((s) => s.id_enseignant === null && s.statut !== 'annulee').length} séance(s) sans enseignant` },
            ...db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom.toUpperCase()} ${e.prenom}`, hint: e.grade ?? undefined })),
          ]
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
      // séance déplacée : son enseignant ; nouvelle séance : l'enseignant prévu du cours
      id_enseignant: d.kind === 'seance' ? d.seance.id_enseignant : db.cours.find((c) => c.id_cours === d.id_cours)?.id_enseignant ?? null,
      id_salle: base?.id_salle ?? db.salle[0]?.id_salle ?? 0, // nouvelle séance : salle choisie après le contrôle
      id_creneau: cr.id_creneau,
      id_edt: edt.id_edt,
      nature: base?.nature,
    }
  }

  // Validité de chaque créneau de la semaine pour l'élément en cours de glisser. Seules comptent
  // les séances de la semaine affichée et celles du cours (son volume) ; les salles qui conviennent
  // au cours ne se calculent qu'une fois.
  const slots = useMemo(() => {
    const m = new Map<string, SlotState & { salle?: number }>()
    if (!drag) return m
    const id_cours = drag.kind === 'seance' ? drag.seance.id_cours : drag.id_cours
    const cours = db.cours.find((c) => c.id_cours === id_cours)
    if (!cours) return m
    const dimanche = addDays(semaine, 6)
    const nature = drag.kind === 'seance' ? drag.seance : {}
    const seances = db.seance.filter((s) => s.id_edt === edt.id_edt && (s.id_cours === id_cours || estEpreuve(s) || (s.date_seance >= semaine && s.date_seance <= dimanche)))
    const salles = estEpreuve(nature) ? sallesPourEpreuves(db) : sallesDuCours(db, cours)
    for (const date of jours) {
      const jour = jourOf(date)
      for (const cr of db.creneau) {
        if (cr.jour !== jour) continue
        const draft = draftFor(drag, date, cr.heure_debut)
        if (!draft) continue
        const r = evaluerCreneau(db, draft, seances, salles, drag.kind === 'seance')
        m.set(`${date}|${cr.heure_debut}`, r.ok
          ? { ok: true, salle: r.id_salle, detail: db.salle.find((s) => s.id_salle === r.id_salle)?.nom_salle }
          : { ok: false, raison: r.raison, detail: r.court })
      }
    }
    return m
  }, [drag, db, semaine, edt.id_edt]) // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (d: Drag, e: DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    // type propre à l'application : déposée dans un champ de saisie, la séance n'y écrit rien
    e.dataTransfer.setData('application/x-ultraplanning', d.kind)
    // différé : modifier la source pendant dragstart annule le glisser dans Chrome
    setTimeout(() => setDrag(d), 0)
  }
  const endDrag = () => { setDrag(null); setCible(null) }

  const onDrop = (c: Cible | null) => {
    if (!drag) return
    if (!c) {
      toast.error('Placement refusé', { description: "Ce jour n'a pas de créneau à cette heure." })
      return endDrag()
    }
    const { date, heure } = c
    // Reposée à sa place : rien à faire
    if (drag.kind === 'seance' && drag.seance.date_seance === date && drag.seance.heure_debut === heure) return endDrag()
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

  const hoverInfo = cible ? slots.get(`${cible.date}|${cible.heure}`) : undefined
  const dureeGlisse = !drag ? 0 : drag.kind === 'seance' ? drag.seance.duree : drag.duree

  // ---------- Duplication de la semaine (BF-14) ----------

  const dupliquer = () => {
    const modele = db.seance.filter(
      (s) => s.id_edt === edt.id_edt && s.statut !== 'annulee' && !estEpreuve(s) && s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6),
    )
    const suivant = addDays(semaine, 7)
    const gardees = db.seance.filter((s) => s.id_edt !== edt.id_edt || s.date_seance < suivant || s.est_verrouillee || estEpreuve(s))
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
    if (patch.statut === 'annulee' && examenAvecRattrapage(db, sel)) {
      return toast.error('Annulation refusée', { description: 'Ce module a un rattrapage : retirez-le avant son examen.' })
    }
    const vs = patch.statut === 'annulee' ? [] : checkSeance(db, next)
    if (vs.length) return toast.error('Modification refusée', { description: vs.map((v) => `${v.code} : ${v.message}`).join('\n') })
    mutate((x) => Object.assign(x.seance.find((k) => k.id_seance === sel.id_seance)!, patch))
    toast.success(msg)
  }

  // ---------- Enseignant de la séance (aucune habilitation : tout enseignant libre convient) ----------

  // Pour chaque enseignant : pourquoi il ne peut pas assurer cette séance (déjà en cours, absent, indisponible)
  const optionsEnseignant: ComboOption[] = useMemo(() => {
    if (!sel) return []
    return db.enseignant
      .map((e) => {
        const motif = checkSeance(db, { ...sel, id_enseignant: e.id_enseignant }).find((v) => v.code === 'CD-02' || v.code === 'CD-06')?.message
        return {
          value: e.id_enseignant,
          label: `${e.nom.toUpperCase()} ${e.prenom}`,
          hint: motif ?? e.grade ?? undefined,
          group: motif ? 'Non disponibles sur ce créneau' : 'Disponibles',
        }
      })
      .sort((a, b) => (a.group === b.group ? a.label.localeCompare(b.label) : a.group === 'Disponibles' ? -1 : 1))
  }, [db, sel])

  /** Même enseignant pour toutes les séances à venir du cours, et comme enseignant prévu du cours */
  const enseignantDuCours = (id_enseignant: number | null) => {
    if (!sel) return
    let travail = db.seance
    const retenues: number[] = []
    let refusees = 0
    for (const x of db.seance.filter((k) => k.id_edt === edt.id_edt && k.id_cours === sel.id_cours && k.statut === 'planifiee')) {
      const next = { ...x, id_enseignant }
      if (id_enseignant !== null && checkSeance(db, next, travail).length) {
        refusees++
        continue
      }
      retenues.push(x.id_seance)
      travail = travail.map((k) => (k.id_seance === x.id_seance ? next : k))
    }
    mutate((x) => {
      for (const k of x.seance) if (retenues.includes(k.id_seance)) k.id_enseignant = id_enseignant
      x.cours.find((c) => c.id_cours === sel.id_cours)!.id_enseignant = id_enseignant
    })
    const nom = nomEnseignant(db.enseignant.find((e) => e.id_enseignant === id_enseignant))
    toast.success(`${nom} pour ${retenues.length} séance(s) du cours`, {
      description: refusees ? `${refusees} séance(s) laissée(s) telle(s) quelle(s) : enseignant déjà pris, absent ou indisponible à ces heures.` : undefined,
    })
  }

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle visible eyebrow={lecture ? 'Historique des modifications' : 'Version à jour'} title="Planification">
        <PillTabs
          size="sm"
          label="Vue"
          value={vue}
          onChange={changerDeVue}
          items={[
            { value: 'ajour', label: 'À jour' },
            { value: 'historique', label: 'Historique' },
          ]}
        />
        {!lecture && (
          <>
            <Button variant="outline" onClick={() => setConfirmDup(true)}>
              <CopyPlus />Dupliquer la semaine
            </Button>
            <Button
              variant="outline"
              disabled={!jours.length}
              onClick={() => ouvrirEpreuve('examen', { date: jours[0], debut: 7 * 60, fin: 9 * 60 })}
            >
              <CalendarPlus />Programmer une épreuve
            </Button>
            <BoutonPublier travail={edt} />
          </>
        )}
      </PageTitle>

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

      {id === null && !lecture ? (
        <Card><EmptyState icon={<CalendarRange />} title="Choisissez une classe, un enseignant ou une salle" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[19rem_minmax(0,1fr)]">
          {lecture && (connecte ? (
            <HistoriqueVersions
              id_edt={edt.id_edt}
              numero={numeroChoisi}
              actualisation={db.seance}
              onChoisir={(version, total) => setVersionChoisie({ version, total })}
            />
          ) : (
            <Card className="h-fit p-4"><EmptyState icon={<History />} title="L'historique demande la connexion à la base" /></Card>
          ))}

          {/* Cours à placer */}
          {/* Sur grand écran, le panneau ne compte pas dans la hauteur de la ligne : c'est la grille qui la fixe, et sa liste défile */}
          {!lecture && <div className="relative min-w-0"><div className="xl:absolute xl:inset-0"><Card className="flex max-h-96 flex-col p-4 xl:sticky xl:top-4 xl:max-h-[min(100%,calc(100vh-2rem))]">
            <p className="section-label px-1">Cours à placer</p>
            <p className="mt-1 px-1 text-xs text-ink-2">Glissez une séance type sur la grille. Les créneaux verts respectent toutes les contraintes dures.</p>
            {res === 'salle' ? (
              <p className="mt-4 px-1 text-sm text-ink-2">Choisissez une classe ou un enseignant pour placer des cours. Ici, vous pouvez déplacer les séances de la salle.</p>
            ) : (
              <ul className="-mx-1 mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto px-1 py-px scroll-thin">
                {coursRes.map((c) => {
                  const m = db.matiere.find((x) => x.id_matiere === c.id_matiere)!
                  const cl = db.classe.find((x) => x.id_classe === c.id_classe)!
                  const g = db.groupe.find((x) => x.id_groupe === c.id_groupe) ?? null
                  const e = db.enseignant.find((x) => x.id_enseignant === c.id_enseignant)
                  const placees = toutes.filter((s) => s.id_cours === c.id_cours && s.statut !== 'annulee' && !estEpreuve(s) && s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6))
                  const plan = heuresPlanifiees(db, edt.id_edt, c.id_cours)
                  const { etat, durees, reste } = aPlacer({
                    volume: c.volume_horaire,
                    planifiees: plan,
                    maxSemaine: c.heures_semaine_max,
                    semaine: placees.reduce((a, p) => a + p.duree, 0),
                    modele: decoupage(db, c.id_cours).map((r) => r.duree_heures),
                  })
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
                        {etat === 'volume_atteint' && <Badge tone="success" dot>Volume atteint</Badge>}
                        {etat === 'semaine_complete' && <Badge tone="neutral" dot>Semaine complète</Badge>}
                        {etat === 'reste_trop_court' && <Badge tone="warning" dot>{reste} h restante : 2 h minimum</Badge>}
                        {etat === 'rythme_trop_court' && <Badge tone="warning" dot>{reste} h restantes, {c.heures_semaine_max} h par semaine</Badge>}
                        {durees.map((d) => (
                          <div
                            key={d}
                            draggable
                            onDragStart={(ev) => startDrag({ kind: 'modele', id_cours: c.id_cours, duree: d, decalage: DECALAGE_MODELE }, ev)}
                            onDragEnd={endDrag}
                            className="press flex cursor-grab items-center gap-1 rounded-full bg-navy px-2.5 py-1 text-xs font-medium text-white select-none active:cursor-grabbing"
                            title="Glisser sur la grille"
                          >
                            <GripVertical className="size-3" />{d} h
                          </div>
                        ))}
                        <span className="ml-auto font-mono text-[11px] text-ink-2 tabular-nums">{plan}/{c.volume_horaire} h</span>
                      </div>
                    </li>
                  )
                })}
                {coursRes.length === 0 && <li className="px-1 text-sm text-ink-2">Aucun cours pour cette sélection.</li>}
              </ul>
            )}
          </Card></div></div>}

          {/* Grille */}
          <Card className="min-w-0 self-start p-3 sm:p-5">
            {lecture ? (
              <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3 rounded-3xl bg-muted/70 px-4 py-2 text-sm text-ink-2">
                {versionChoisie ? (
                  <>
                    <span className="min-w-0">
                      <span className="font-medium text-ink">Version {versionChoisie.version.numero}</span> du {fmtDateHeure(versionChoisie.version.date)}, en lecture seule.
                      {!!contenuVersion?.hors_referentiel && ` ${contenuVersion.hors_referentiel} séance(s) non affichée(s) : leur cours, leur salle ou leur créneau n'existe plus.`}
                    </span>
                    <RestaurerVersion
                      id_edt={edt.id_edt}
                      version={versionChoisie.version}
                      derniere={versionChoisie.version.numero === versionChoisie.total}
                      onRestauree={async () => { await recharger(); changerDeVue('ajour') }}
                    />
                  </>
                ) : <>Choisissez une version dans la liste.</>}
              </div>
            ) : (
            <div className={cn('mb-3 flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors', !drag ? 'bg-muted/70 text-ink-2' : hoverInfo?.ok ? 'bg-[#DCFCE7] text-[#166534]' : hoverInfo ? 'bg-[#FEE2E2] text-[#991B1B]' : 'bg-highlight text-ink')}>
              {!drag && <>Cliquez une séance pour la modifier, ou glissez-la. Pour un examen : sélectionnez 2 ou 3 h sur une case vide, puis clic droit.</>}
              {drag && !hoverInfo && <>Amenez la séance sur la grille : le bloc en pointillé montre où elle atterrit (vert = possible, rouge = refusé).</>}
              {drag && cible && hoverInfo?.ok && (
                <><CheckCircle2 className="size-4 shrink-0" />Possible · {fmtJourCourt(cible.date)}, {fmtHeure(cible.heure)}–{fmtHeure(fromMin(toMin(cible.heure) + dureeGlisse * 60))} · {hoverInfo.detail}</>
              )}
              {drag && hoverInfo && !hoverInfo.ok && <><XCircle className="size-4 shrink-0" /><span className="line-clamp-2">{hoverInfo.raison}</span></>}
            </div>
            )}
            {id === null ? <EmptyState icon={<CalendarRange />} title="Choisissez une classe, un enseignant ou une salle" /> : <WeekGrid
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
                      selection,
                      onSelection: setSelection,
                      onMenu: (x, y, s) => setMenu({ x, y, selection: s }),
                      glisse: drag && {
                        duree: dureeGlisse,
                        decalage: drag.decalage,
                        id_seance: drag.kind === 'seance' ? drag.seance.id_seance : undefined,
                      },
                      cible,
                      slot: drag ? (d, h) => slots.get(`${d}|${h}`) : undefined,
                      onCible: (c) => setCible((avant) => (avant?.date === c?.date && avant?.heure === c?.heure ? avant : c)),
                      onDrop,
                      onDragStartSeance: (s, e, decalage) => startDrag({ kind: 'seance', seance: s, decalage }, e),
                      onDragEnd: endDrag,
                    }
              }
            />}
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
              <Button variant="destructive" onClick={() => {
                if (examenAvecRattrapage(db, sel)) return void toast.error('Suppression refusée', { description: 'Ce module a un rattrapage : retirez-le avant son examen.' })
                mutate((x) => { x.seance = x.seance.filter((k) => k.id_seance !== sel.id_seance) })
                setSelected(null)
                toast.success(estEpreuve(sel) ? 'Épreuve supprimée' : 'Séance supprimée')
              }}>
                <Trash2 />Supprimer
              </Button>
              {sel.statut === 'annulee' ? (
                <Button variant="outline" onClick={() => update({ statut: 'planifiee' }, 'Séance rétablie')}><Undo2 />Rétablir</Button>
              ) : (
                <Button variant="outline" onClick={() => update({ statut: 'annulee' }, 'Séance annulée')}><Ban />Annuler la séance</Button>
              )}
              {!estEpreuve(sel) && (
                <Button variant="primary" onClick={() => update({ est_verrouillee: !sel.est_verrouillee }, sel.est_verrouillee ? 'Séance déverrouillée' : 'Séance verrouillée pour la génération')}>
                  {sel.est_verrouillee ? <><LockOpen />Déverrouiller</> : <><Lock />Verrouiller</>}
                </Button>
              )}
            </>
          )
        }
      >
        {sel && (
          <div className="grid grid-cols-1 gap-5">
            <SeanceDetail s={sel} />
            {!lecture && sel.statut !== 'annulee' && !estEpreuve(sel) && (
              <div>
                <p className="section-label mb-2">Enseignant de la séance</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Combobox
                    className="min-w-56 flex-1"
                    options={optionsEnseignant}
                    value={sel.id_enseignant}
                    onChange={(v) => v !== null && v !== sel.id_enseignant
                      && update({ id_enseignant: v }, `Enseignant : ${nomEnseignant(db.enseignant.find((e) => e.id_enseignant === v))}`)}
                    placeholder="À désigner"
                    ariaLabel="Enseignant de la séance"
                  />
                  {sel.id_enseignant !== null && (
                    <Button variant="ghost" size="sm" onClick={() => update({ id_enseignant: null }, 'Enseignant retiré : à désigner')}>
                      <UserMinus />Retirer
                    </Button>
                  )}
                </div>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => enseignantDuCours(sel.id_enseignant)}>
                  <Users />{sel.id_enseignant === null ? 'Retirer l\'enseignant de' : 'Même enseignant pour'} toutes les séances à venir du cours
                </Button>
                <p className="mt-2 text-xs text-ink-2">
                  Enseignant prévu du cours : {nomEnseignant(db.enseignant.find((e) => e.id_enseignant === sel.cours.id_enseignant))}.
                  Un enseignant déjà en cours, absent ou indisponible à cette heure est refusé.
                </p>
              </div>
            )}
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
                <p className="mt-2 text-xs text-ink-2">
                  {estEpreuve(sel)
                    ? `Capacité ≥ ${sel.effectif} étudiants, épreuves partageant la salle comprises · de ${fmtHeure(sel.heure_debut)} à ${fmtHeure(sel.heure_fin)}.`
                    : `Capacité ≥ ${sel.groupe?.effectif ?? sel.classe.effectif} étudiants · type ${sel.type_salle?.libelle} · salle libre de ${fmtHeure(sel.heure_debut)} à ${fmtHeure(sel.heure_fin)}.`}
                </p>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* Menu du clic droit sur des heures de la grille */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} aria-hidden />
          <div
            role="menu"
            aria-label="Programmer une épreuve"
            className="fixed z-50 w-60 rounded-2xl bg-white p-1.5 text-sm shadow-xl ring-1 ring-line"
            style={{ left: Math.min(menu.x, window.innerWidth - 248), top: Math.min(menu.y, window.innerHeight - 156) }}
          >
            <p className="px-3 py-1.5 text-xs text-ink-2">
              {fmtJourCourt(menu.selection.date)}, {fmtHeure(fromMin(menu.selection.debut))}–{fmtHeure(fromMin(menu.selection.fin))}
            </p>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => ouvrirEpreuve('examen', menu.selection)}>Programmer un examen</button>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => ouvrirEpreuve('rattrapage', menu.selection)}>Programmer un rattrapage</button>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left text-ink-2 hover:bg-muted" onClick={() => { setMenu(null); setSelection(null) }}>Annuler la sélection</button>
          </div>
        </>
      )}

      {epreuve && (
        <DialogEpreuve
          edt={edt}
          depart={epreuve}
          onFermer={() => { setEpreuve(null); setSelection(null) }}
          onCreee={(date) => { setEpreuve(null); setSelection(null); setSemaine(mondayOf(date)) }}
        />
      )}

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
