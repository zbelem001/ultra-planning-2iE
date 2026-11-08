// Planification manuelle (BF-11 à BF-14) : glisser-déposer sur la grille,
// contrôle des contraintes dures en temps réel et salles compatibles proposées.

import { Ban, CalendarPlus, CalendarRange, CheckCircle2, ClipboardPaste, Copy, CopyPlus, History, Lock, LockOpen, SquareArrowOutUpRight, Trash2, Undo2, UserMinus, Users, X, XCircle } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import { BoutonPublier } from '@/components/BoutonPublier'
import { Button, Card, cn, Combobox, Dialog, EmptyState, PageTitle, PillTabs, Select, type ComboOption } from '@/components/ui'
import { DialogEpreuve, type DepartEpreuve } from '@/components/timetable/DialogEpreuve'
import { DialogSeance, type DepartSeance } from '@/components/timetable/DialogSeance'
import { LigneAPlacer } from '@/components/timetable/LigneAPlacer'
import { HistoriqueVersions, RestaurerVersion } from '@/components/timetable/HistoriqueVersions'
import { SeanceDetail } from '@/components/timetable/SeanceDetail'
import { finsPossibles, joursGrille, WeekGrid, type Cible, type SelectionGrille, type SlotState } from '@/components/timetable/WeekGrid'
import { WeekStrip } from '@/components/timetable/WeekStrip'
import { seancesVersion, type VersionEdt } from '@/lib/api'
import { expandWeek } from '@/lib/generator'
import { enrichir, filtrer, lieuSalle, nomEnseignant, publicCours, type Ressource, type SeanceVue } from '@/lib/queries'
import { aPlacer } from '@/lib/aPlacer'
import { useFiltre } from '@/lib/filtres'
import { useGrandEcran } from '@/lib/hauteur'
import { estEpreuve } from '@/lib/publics'
import { capaciteConnue, checkSeance, creneauAt, decoupage, evaluerCreneau, examenAvecRattrapage, REGLES_SALLE, sallesDuCours, sallesLibresSeance, sallesPourEpreuves, type SeanceDraft } from '@/lib/rules'
import { disponibiliteMutualisation } from '@/lib/mutualisation'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { addDays, fmtDateHeure, fmtHeure, fmtJourCourt, fromMin, hours, jourOf, mondayOf, parseDate, todayIso, toMin, weeksBetween } from '@/lib/time'
import type { Seance } from '@/types/db'

// decalage : minutes entre le haut de la séance et le pointeur, là où elle a été saisie
type Drag =
  | { kind: 'seance'; seance: SeanceVue; decalage: number }
  | { kind: 'modele'; id_cours: number; duree: number; decalage: number }

// Une étiquette « 2 h » n'a pas de hauteur : le pointeur vise l'heure qu'il survole
const DECALAGE_MODELE = 30

export default function Planification() {
  const grandEcran = useGrandEcran(1280) // à partir de là, le panneau est à côté de la grille et la page tient en un bloc
  const { db, mutate, connecte, recharger } = useStore()
  // « À jour » : la seule version modifiable, à publier. « Historique » : une version passée, en lecture seule.
  const edt = edtTravail(db)
  const [vue, setVue] = useState<'ajour' | 'historique'>('ajour')
  const lecture = vue === 'historique'
  const [versionChoisie, setVersionChoisie] = useState<{ version: VersionEdt; total: number } | null>(null)
  const [contenuVersion, setContenuVersion] = useState<{ numero: number; seances: Seance[]; hors_referentiel: number } | null>(null)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const weeks = useMemo(() => weeksBetween(semestre.date_debut, semestre.date_fin), [semestre])

  // Filtre : rien de choisi par défaut ; il reste en place d'une page à l'autre jusqu'à ce qu'on le change
  const [res, setRes] = useFiltre<Exclude<Ressource, 'matiere'>>('planification.ressource', 'classe')
  const [idChoisi, setId] = useFiltre<number | null>('planification.id', null)
  const [idGroupeChoisi, setIdGroupe] = useFiltre<number | null>('planification.groupe', null)
  const [semaineChoisie, setSemaine] = useFiltre<string | null>('planification.semaine', null)
  // Une ressource, un groupe ou une semaine qui n'existe plus (supprimé, autre semestre) : plus de filtre
  const existe = res === 'classe' ? db.classe.some((c) => c.id_classe === idChoisi)
    : res === 'enseignant' ? idChoisi === 0 || db.enseignant.some((e) => e.id_enseignant === idChoisi)
      : db.salle.some((s) => s.id_salle === idChoisi)
  const id = idChoisi !== null && existe ? idChoisi : null
  const idGroupe = idGroupeChoisi !== null && res === 'classe' && db.groupe.some((g) => g.id_groupe === idGroupeChoisi && g.id_classe === id) ? idGroupeChoisi : null
  const semaine = semaineChoisie && weeks.includes(semaineChoisie) ? semaineChoisie
    : weeks.includes(mondayOf(todayIso())) ? mondayOf(todayIso()) : weeks[0]
  const [drag, setDrag] = useState<Drag | null>(null)
  const [cible, setCible] = useState<Cible | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [confirmDup, setConfirmDup] = useState(false)
  // Heures choisies sur la grille, menu du clic droit, fenêtre des détails (séance de cours ou épreuve)
  const [selection, setSelection] = useState<SelectionGrille | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: SelectionGrille } | null>(null)
  const [epreuve, setEpreuve] = useState<DepartEpreuve | null>(null)
  const [seanceAPoser, setSeanceAPoser] = useState<DepartSeance | null>(null)
  // Copier-coller : la séance copiée reste en mémoire d'une page à l'autre ; menu du clic droit sur une séance ;
  // jour et minute sous le pointeur, là où Ctrl+V colle
  const [idCopie, setIdCopie] = useFiltre<number | null>('planification.copie', null)
  const [menuSeance, setMenuSeance] = useState<{ x: number; y: number; s: SeanceVue } | null>(null)
  const survol = useRef<{ date: string; minute: number } | null>(null)

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
  const raccourci = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    const surTouche = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setMenuSeance(null); setSelection(null) }
      raccourci.current(e)
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
  const ouvrirSeance = (s: SelectionGrille) => {
    setMenu(null)
    setSeanceAPoser({
      date: s.date, heure_debut: fromMin(s.debut), heure_fin: fromMin(s.fin), id_salle: res === 'salle' ? id : null,
      // une salle : tous les cours du semestre ; sinon ceux de la classe ou de l'enseignant affiché
      cours: res === 'salle' ? db.cours.filter((c) => c.id_semestre === semestre.id_semestre) : coursRes,
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
  const coursRes = useMemo(() => db.cours.filter((c) => {
    if (c.id_semestre !== semestre.id_semestre || id === null) return false
    if (res === 'classe') return c.id_classe === id && (idGroupe === null || c.id_groupe === null || c.id_groupe === idGroupe)
    if (res === 'enseignant') return c.id_enseignant === id
    return false
  }), [db.cours, semestre.id_semestre, id, res, idGroupe])

  // Heures de chaque cours dans la version à jour, en un seul passage sur les séances : planifiées (une séance
  // annulée ne compte plus, ses heures redeviennent à placer), posées dans la semaine affichée, annulées
  const heuresParCours = useMemo(() => {
    const m = new Map<number, { plan: number; semaine: number; annulees: number }>()
    const dimanche = addDays(semaine, 6)
    for (const s of db.seance) {
      if (s.id_edt !== edt.id_edt || estEpreuve(s)) continue
      const h = hours(s.heure_debut, s.heure_fin)
      const a = m.get(s.id_cours) ?? { plan: 0, semaine: 0, annulees: 0 }
      if (s.statut === 'annulee') a.annulees += h
      else {
        a.plan += h
        if (s.date_seance >= semaine && s.date_seance <= dimanche) a.semaine += h
      }
      m.set(s.id_cours, a)
    }
    return m
  }, [db.seance, edt.id_edt, semaine])
  // Ce qui reste à placer en haut ; les cours terminés, regroupés en bas
  const lignesAPlacer = useMemo(() => coursRes
    .map((c) => {
      const h = heuresParCours.get(c.id_cours) ?? { plan: 0, semaine: 0, annulees: 0 }
      const r = aPlacer({
        volume: c.volume_horaire,
        planifiees: h.plan,
        maxSemaine: c.heures_semaine_max,
        semaine: h.semaine,
        modele: decoupage(db, c.id_cours).map((x) => x.duree_heures),
      })
      return { c, plan: h.plan, annulees: h.annulees, ...r }
    })
    .sort((a, b) => Number(a.etat === 'volume_atteint') - Number(b.etat === 'volume_atteint')),
  [coursRes, heuresParCours, db])
  // Une ligne par cours (composant mémorisé : seules les lignes qui changent se redessinent) ; startDrag et endDrag
  // n'utilisent que des setters d'état, leur effet ne change pas d'un rendu à l'autre
  const listeAPlacer = useMemo(() => {
    const mat = new Map(db.matiere.map((x) => [x.id_matiere, x]))
    const cla = new Map(db.classe.map((x) => [x.id_classe, x]))
    const grp = new Map(db.groupe.map((x) => [x.id_groupe, x]))
    const ens = new Map(db.enseignant.map((x) => [x.id_enseignant, x]))
    return (
      <>
        {lignesAPlacer.map(({ c, plan, annulees, etat, options, reste }, i, liste) => {
          const m = mat.get(c.id_matiere)!
          const g = c.id_groupe !== null ? grp.get(c.id_groupe) ?? null : null
          const e = c.id_enseignant !== null ? ens.get(c.id_enseignant) : undefined
          // séparateur avant les cours terminés, s'il y en a d'autres au-dessus
          const premierTermine = etat === 'volume_atteint' && i > 0 && liste[i - 1].etat !== 'volume_atteint'
          return (
            <Fragment key={c.id_cours}>
              {premierTermine && (
                <li className="flex items-center gap-2 px-1 pt-2 text-[11px] font-medium tracking-wide text-ink-2 uppercase" aria-hidden>
                  Volume atteint · {liste.length - i}<span className="h-px flex-1 bg-line" />
                </li>
              )}
              <LigneAPlacer
                c={c}
                id_matiere={m.id_matiere}
                libelle={m.libelle}
                detail={`${c.type_cours} · ${publicCours(cla.get(c.id_classe)!, g)} · ${nomEnseignant(e)}`}
                plan={plan}
                annulees={annulees}
                etat={etat}
                durees={options}
                reste={reste}
                onGlisser={(id_cours, duree, ev) => startDrag({ kind: 'modele', id_cours, duree, decalage: DECALAGE_MODELE }, ev)}
                onFin={() => endDrag()}
              />
            </Fragment>
          )
        })}
        {coursRes.length === 0 && <li className="px-1 text-sm text-ink-2">Aucun cours pour cette sélection.</li>}
      </>
    )
  }, [lignesAPlacer, db.matiere, db.classe, db.groupe, db.enseignant, coursRes.length]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const endDrag = () => { setDrag(null); setCible(null); setHorsSource(false) }

  // Séance glissée vers une autre semaine : sa carte n'est plus affichée et son « dragend » ne remonte plus.
  // Si elle est lâchée hors de la grille, le premier mouvement de la souris après le glisser le remplace
  // (pendant un glisser, le navigateur n'en envoie aucun).
  const [horsSource, setHorsSource] = useState(false)
  useEffect(() => {
    if (!drag || !horsSource) return
    const fin = () => { setDrag(null); setCible(null); setHorsSource(false) }
    document.addEventListener('pointermove', fin)
    document.addEventListener('pointerdown', fin)
    return () => {
      document.removeEventListener('pointermove', fin)
      document.removeEventListener('pointerdown', fin)
    }
  }, [drag, horsSource])

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
  // Salles libres à l'horaire de la séance, sur son campus (voir sallesLibresSeance)
  const sallesLibres = useMemo(() => (sel ? sallesLibresSeance(db, sel) : { salles: [], id_site: null }), [db, sel])

  // Classes qui suivent le cours de la séance, et celles qu'on peut y ajouter (mutualisation)
  const publicsEnPlus = sel ? db.cours_public.filter((p) => p.id_cours === sel.id_cours) : []
  const optionsMutualisation: ComboOption[] = useMemo(() => {
    if (!sel) return []
    const deja = new Set([sel.cours.id_classe, ...db.cours_public.filter((p) => p.id_cours === sel.id_cours).map((p) => p.id_classe)])
    return db.classe
      .filter((c) => !deja.has(c.id_classe))
      .map((c) => {
        const d = disponibiliteMutualisation(db, edt.id_edt, sel.cours, c.id_classe)
        return {
          value: c.id_classe,
          label: c.code_classe,
          hint: d.ok ? `${c.libelle} · libre sur ${d.nb === 1 ? 'la séance' : `les ${d.nb} séances`} du cours` : d.motif,
          group: d.ok ? 'Disponibles' : 'Non disponibles',
          disabled: !d.ok,
        }
      })
      .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label))
  }, [db, sel, edt.id_edt])
  const mutualiser = (id_classe: number) => {
    if (!sel) return
    const classe = db.classe.find((c) => c.id_classe === id_classe)!
    const d = disponibiliteMutualisation(db, edt.id_edt, sel.cours, id_classe)
    if (!d.ok) return void toast.error(`${classe.code_classe} n'est pas disponible`, { description: d.motif })
    mutate((x) => { x.cours_public.push({ id_cours_public: nextId(x.cours_public, 'id_cours_public'), id_cours: sel.id_cours, id_classe, id_groupe: null }) })
    toast.success(`Cours mutualisé avec ${classe.code_classe}`, { description: `${d.nb === 1 ? 'Sa séance apparaît' : `Ses ${d.nb} séances apparaissent`} aussi dans l'emploi du temps de ${classe.code_classe}.` })
  }
  const demutualiser = (id_cours_public: number) => {
    const p = db.cours_public.find((x) => x.id_cours_public === id_cours_public)
    const classe = db.classe.find((c) => c.id_classe === p?.id_classe)
    mutate((x) => { x.cours_public = x.cours_public.filter((k) => k.id_cours_public !== id_cours_public) })
    toast.success(`${classe?.code_classe ?? 'La classe'} ne suit plus ce cours`, { description: 'Ses séances sortent de son emploi du temps.' })
  }

  /** Annuler une séance (ses heures redeviennent à placer) ou la rétablir, depuis le menu ou le détail */
  const changerStatut = (s: Seance, statut: 'annulee' | 'planifiee') => {
    setMenuSeance(null)
    const epreuve = estEpreuve(s)
    if (statut === 'annulee' && examenAvecRattrapage(db, s)) {
      return void toast.error('Annulation refusée', { description: 'Ce module a un rattrapage : retirez-le avant son examen.' })
    }
    if (statut !== 'annulee') {
      const vs = checkSeance(db, { ...s, statut })
      if (vs.length) return void toast.error('Rétablissement refusé', { description: vs.map((v) => `${v.code} : ${v.message}`).join('\n') })
    }
    mutate((x) => { x.seance.find((k) => k.id_seance === s.id_seance)!.statut = statut })
    const quoi = `${libelleSeance(s)} · ${fmtJourCourt(s.date_seance)}, ${fmtHeure(s.heure_debut)}–${fmtHeure(s.heure_fin)}`
    if (statut === 'annulee') {
      toast.success(epreuve ? 'Épreuve annulée' : 'Séance annulée', {
        description: epreuve ? quoi : `${quoi} : ${dureeSeance(s)} h à placer de nouveau.`,
        action: { label: 'Rétablir', onClick: () => changerStatut(s, 'planifiee') },
      })
    } else toast.success(epreuve ? 'Épreuve rétablie' : 'Séance rétablie', { description: quoi })
  }
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

  // ---------- Allonger une séance d'une heure (petit « + » de la carte) ----------

  const allonger = (sv: SeanceVue) => {
    const s = db.seance.find((x) => x.id_seance === sv.id_seance)
    if (!s) return
    const fin = fromMin(toMin(s.heure_fin) + 60)
    const duree = hours(s.heure_debut, fin)
    const refus = (description: string) => void toast.error('Allongement refusé', { description })
    if (duree > (estEpreuve(s) ? 3 : 5)) return refus(estEpreuve(s) ? 'Une épreuve dure 3 h au plus.' : 'Une séance dure 5 h au plus.')
    if (!finsPossibles(db, s.date_seance, s.heure_debut, [duree * 60]).length) {
      return refus(`Pas d'heure de cours juste après ${fmtHeure(s.heure_fin)} ce jour-là (pause ou fin de journée).`)
    }
    const seances = db.seance.filter((x) => x.id_edt === edt.id_edt)
    let suivante: Seance = { ...s, heure_fin: fin }
    let vs = checkSeance(db, suivante, seances)
    // seule la salle est prise sur l'heure en plus : la plus petite salle libre qui convient
    if (vs.length && vs.every((v) => REGLES_SALLE.has(v.code))) {
      const autre = sallesLibresSeance(db, suivante, seances).salles[0]
      if (autre) {
        suivante = { ...suivante, id_salle: autre.id_salle }
        vs = checkSeance(db, suivante, seances)
      }
    }
    if (vs.length) return refus(vs.map((v) => `${v.code} : ${v.message}`).join('\n'))
    const avant = { heure_fin: s.heure_fin, id_salle: s.id_salle }
    mutate((x) => { Object.assign(x.seance.find((k) => k.id_seance === s.id_seance)!, { heure_fin: suivante.heure_fin, id_salle: suivante.id_salle }) })
    const salle = suivante.id_salle !== s.id_salle ? db.salle.find((x) => x.id_salle === suivante.id_salle)?.nom_salle : null
    toast.success(estEpreuve(s) ? 'Épreuve allongée' : 'Séance allongée', {
      description: `${libelleSeance(s)} · ${fmtJourCourt(s.date_seance)}, ${fmtHeure(s.heure_debut)}–${fmtHeure(fin)} (${duree} h)${salle ? ` · salle changée : ${salle}` : ''}`,
      action: {
        label: 'Annuler',
        onClick: () => mutate((x) => { Object.assign(x.seance.find((k) => k.id_seance === s.id_seance)!, avant) }),
      },
    })
  }

  // ---------- Copier-coller d'une séance ----------

  const copie = idCopie !== null ? db.seance.find((s) => s.id_seance === idCopie && s.id_edt === edt.id_edt) ?? null : null
  const libelleSeance = (s: Seance) => db.matiere.find((m) => m.id_matiere === db.cours.find((c) => c.id_cours === s.id_cours)?.id_matiere)?.libelle ?? 'Séance'
  const dureeSeance = (s: Seance) => (toMin(s.heure_fin) - toMin(s.heure_debut)) / 60

  const copier = (s: Seance) => {
    setIdCopie(s.id_seance)
    setMenuSeance(null)
    toast.success('Séance copiée', { description: `${libelleSeance(s)} · ${dureeSeance(s)} h. Ctrl+V la colle sous le pointeur ; clic droit sur une case : « Coller ».` })
  }

  /** Nouvelle séance comme `source`, le `date` à `heure` : même salle si elle est libre, sinon la plus ajustée ;
   *  si seul son enseignant est pris ou absent, la séance est posée sans enseignant (à désigner). */
  const poserCopie = (source: Seance, date: string, heure: string) => {
    setMenu(null)
    setMenuSeance(null)
    setSelection(null) // réussi ou refusé, le prochain Ctrl+V vise le pointeur
    const cr = creneauAt(db, date, heure)
    const cours = db.cours.find((c) => c.id_cours === source.id_cours)
    if (!cr || !cours) return void toast.error('Collage refusé', { description: "Ce jour n'a pas de créneau qui commence à cette heure." })
    const draft: SeanceDraft = {
      date_seance: date,
      heure_debut: heure,
      heure_fin: fromMin(toMin(heure) + dureeSeance(source) * 60),
      statut: 'planifiee',
      est_verrouillee: false,
      id_cours: source.id_cours,
      id_enseignant: source.id_enseignant,
      id_salle: source.id_salle,
      id_creneau: cr.id_creneau,
      id_edt: edt.id_edt,
      nature: source.nature,
    }
    const seances = db.seance.filter((s) => s.id_edt === edt.id_edt)
    const salles = estEpreuve(source) ? sallesPourEpreuves(db) : sallesDuCours(db, cours)
    let r = evaluerCreneau(db, draft, seances, salles, true)
    let sansEnseignant = false
    if (!r.ok && draft.id_enseignant !== null) {
      const bloquantes = checkSeance(db, draft, seances).filter((v) => !REGLES_SALLE.has(v.code))
      if (bloquantes.length && bloquantes.every((v) => v.code === 'CD-02' || v.code === 'CD-06')) {
        const r2 = evaluerCreneau(db, { ...draft, id_enseignant: null }, seances, salles, true)
        if (r2.ok) { r = r2; sansEnseignant = true }
      }
    }
    if (!r.ok) return void toast.error('Collage refusé', { description: r.raison })
    const id_salle = r.id_salle
    const salle = db.salle.find((x) => x.id_salle === id_salle)
    mutate((x) => {
      x.seance.push({ ...(draft as Seance), id_seance: nextId(x.seance, 'id_seance'), id_salle, id_enseignant: sansEnseignant ? null : draft.id_enseignant })
    })
    toast.success(estEpreuve(source) ? 'Épreuve dupliquée' : 'Séance dupliquée', {
      description: `${libelleSeance(source)} · ${fmtJourCourt(date)}, ${fmtHeure(heure)}–${fmtHeure(draft.heure_fin)} · ${salle?.nom_salle ?? ''}`
        + (sansEnseignant ? " · enseignant à désigner : le sien n'est pas libre" : ''),
    })
  }

  /** Où Ctrl+V colle : début des heures sélectionnées, sinon le créneau sous le pointeur, sinon le même jour de
   *  la semaine et la même heure que la séance copiée, dans la semaine affichée */
  const collerAuClavier = (source: Seance) => {
    if (selection) return poserCopie(source, selection.date, fromMin(selection.debut))
    const p = survol.current
    if (p) {
      const cr = db.creneau.find((c) => c.jour === jourOf(p.date) && toMin(c.heure_debut) <= p.minute && p.minute < toMin(c.heure_fin))
      if (!cr) return void toast.error('Collage refusé', { description: "Pas de créneau à cet endroit : visez une heure de cours de la grille." })
      return poserCopie(source, p.date, cr.heure_debut)
    }
    const jourSemaine = Math.round((parseDate(source.date_seance).getTime() - parseDate(mondayOf(source.date_seance)).getTime()) / 86_400_000)
    poserCopie(source, addDays(semaine, jourSemaine), source.heure_debut)
  }

  // à chaque rendu : le raccourci voit l'état du moment
  useEffect(() => { raccourci.current = (e: KeyboardEvent) => {
    if (lecture || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
    const cible = e.target as HTMLElement | null
    if (cible?.closest('input, textarea, select, [contenteditable="true"]')) return
    const touche = e.key.toLowerCase()
    if (touche === 'c') {
      if (window.getSelection()?.toString()) return // du texte choisi : la copie habituelle
      const carte = (document.activeElement?.closest('[data-seance]') ?? document.querySelector('[data-seance]:hover')) as HTMLElement | null
      const idCarte = sel?.id_seance ?? (carte ? Number(carte.dataset.seance) : null)
      const s = idCarte !== null ? db.seance.find((x) => x.id_seance === idCarte) : undefined
      if (!s) return
      e.preventDefault()
      copier(s)
    } else if (touche === 'v') {
      if (!copie || id === null || sel || seanceAPoser || epreuve || confirmDup) return
      e.preventDefault()
      collerAuClavier(copie)
    }
  } })

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
    <div className="grid grid-cols-1 gap-6 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:gap-2 print:block">
      <PageTitle visible={!grandEcran} eyebrow={lecture ? 'Historique des modifications' : 'Version à jour'} title="Planification">
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
              disabled={!jours.length || id === null}
              title={id === null ? "Choisissez d'abord une classe, un enseignant ou une salle" : undefined}
              onClick={() => ouvrirEpreuve('examen', { date: jours[0], debut: 7 * 60, fin: 9 * 60 })}
            >
              <CalendarPlus />Programmer une épreuve
            </Button>
            <BoutonPublier travail={edt} />
          </>
        )}
      </PageTitle>

      <Card className="p-4 sm:p-5 xl:flex xl:shrink-0 xl:items-center xl:gap-3 xl:p-2">
        <div className="grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)] lg:items-center xl:flex xl:shrink-0 xl:gap-2">
          <PillTabs
            size="sm"
            value={res}
            onChange={(r) => { setRes(r); setId(null); setIdGroupe(null) }}
            items={[{ value: 'classe', label: 'Classe' }, { value: 'enseignant', label: 'Enseignant' }, { value: 'salle', label: 'Salle' }]}
          />
          <Combobox className="xl:w-44" ariaLabel="Ressource à planifier" placeholder="Rechercher…" options={options} value={id} onChange={(v) => { setId(v); setIdGroupe(null) }} />
          {res === 'classe' && id !== null && db.groupe.some((g) => g.id_classe === id) ? (
            <Select className="xl:w-36 xl:[&_select]:pr-8 xl:[&_select]:pl-3 xl:[&_select]:text-xs" aria-label="Groupe" value={idGroupe ?? ''} onChange={(e) => setIdGroupe(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Tous les groupes</option>
              {db.groupe.filter((g) => g.id_classe === id).map((g) => <option key={g.id_groupe} value={g.id_groupe}>{g.code_groupe}</option>)}
            </Select>
          ) : <div />}
        </div>
        <div className="mt-4 xl:mt-0 xl:min-w-0 xl:flex-1">
          <WeekStrip weeks={weeks} value={semaine} onChange={setSemaine} counts={counts} />
        </div>
      </Card>

      {id === null && !lecture ? (
        <Card><EmptyState icon={<CalendarRange />} title="Choisissez une classe, un enseignant ou une salle" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[17rem_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)] xl:gap-2 print:block">
          {lecture && <div className="relative min-w-0"><div className="xl:absolute xl:inset-0">{connecte ? (
            <HistoriqueVersions
              id_edt={edt.id_edt}
              numero={numeroChoisi}
              actualisation={db.seance}
              onChoisir={(version, total) => setVersionChoisie({ version, total })}
            />
          ) : (
            <Card className="h-fit p-4"><EmptyState icon={<History />} title="L'historique demande la connexion à la base" /></Card>
          )}</div></div>}

          {/* Cours à placer */}
          {/* Sur grand écran, le panneau ne dépasse pas la hauteur de la ligne : sa liste défile */}
          {!lecture && <div className="relative min-w-0"><div className="xl:absolute xl:inset-0"><Card className="flex max-h-96 flex-col p-4 xl:max-h-full xl:p-3">
            <p className="section-label px-1">Cours à placer</p>
            <p className="mt-1 px-1 text-xs text-ink-2">Glissez une durée sur la grille (en foncé, celle des séances types du cours). Les créneaux verts respectent toutes les contraintes dures.</p>
            {res === 'salle' ? (
              <p className="mt-4 px-1 text-sm text-ink-2">Choisissez une classe ou un enseignant pour placer des cours. Ici, vous pouvez déplacer les séances de la salle.</p>
            ) : (
              <ul className="-mx-1 mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto px-1 py-px scroll-thin">
                {listeAPlacer}
              </ul>
            )}
          </Card></div></div>}

          {/* Grille */}
          <Card className="min-w-0 self-start p-3 sm:p-5 xl:flex xl:min-h-0 xl:flex-col xl:self-stretch xl:p-3 print:block">
            {lecture ? (
              <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3 rounded-3xl bg-muted/70 px-4 py-2 text-sm text-ink-2 xl:mb-1 xl:min-h-8 xl:shrink-0 xl:py-0.5 xl:text-xs">
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
            <div className={cn('mb-3 flex min-h-10 items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors xl:mb-1 xl:min-h-8 xl:shrink-0 xl:py-1 xl:text-xs', !drag ? 'bg-muted/70 text-ink-2' : hoverInfo?.ok ? 'bg-[#DCFCE7] text-[#166534]' : hoverInfo ? 'bg-[#FEE2E2] text-[#991B1B]' : 'bg-highlight text-ink')}>
              {!drag && !copie && <>Cliquez une séance pour la modifier, glissez-la, ou clic droit pour la copier. Pour ajouter une séance ou un examen : sélectionnez 2 à 5 h sur une case vide, puis clic droit.</>}
              {!drag && copie && (
                <>
                  <Copy className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-ink">{libelleSeance(copie)}</span> copiée ({dureeSeance(copie)} h) : Ctrl+V la colle sous le pointeur, ou clic droit sur une case puis « Coller ».
                  </span>
                  <button type="button" className="press -mr-2 grid size-6 shrink-0 place-items-center rounded-full hover:bg-white" aria-label="Oublier la séance copiée" title="Oublier la séance copiée" onClick={() => setIdCopie(null)}>
                    <X className="size-3.5" />
                  </button>
                </>
              )}
              {drag && !hoverInfo && <>Amenez la séance sur la grille : le bloc en pointillé montre où elle atterrit (vert = possible, rouge = refusé). Gardez-la sur la bande de gauche ou de droite pour changer de semaine.</>}
              {drag && cible && hoverInfo?.ok && (
                <><CheckCircle2 className="size-4 shrink-0" />Possible · {fmtJourCourt(cible.date)}, {fmtHeure(cible.heure)}–{fmtHeure(fromMin(toMin(cible.heure) + dureeGlisse * 60))} · {hoverInfo.detail}</>
              )}
              {drag && hoverInfo && !hoverInfo.ok && <><XCircle className="size-4 shrink-0" /><span className="line-clamp-2">{hoverInfo.raison}</span></>}
            </div>
            )}
            <div className="scroll-thin xl:min-h-0 xl:flex-1 xl:overflow-y-auto print:overflow-visible">
            {id === null ? <EmptyState icon={<CalendarRange />} title="Choisissez une classe, un enseignant ou une salle" /> : <WeekGrid
              remplir={grandEcran}
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
                      onMenu: (x, y, s) => { setMenuSeance(null); setMenu({ x, y, selection: s }) },
                      onMenuSeance: (x, y, s) => { setMenu(null); setMenuSeance({ x, y, s }) },
                      onSurvol: (p) => { survol.current = p },
                      copiee: copie?.id_seance ?? null,
                      onAllonger: allonger,
                      voisines: { avant: weeks[weeks.indexOf(semaine) - 1] ?? null, apres: weeks[weeks.indexOf(semaine) + 1] ?? null },
                      onSemaine: (lundi) => { setSemaine(lundi); if (drag?.kind === 'seance') setHorsSource(true) },
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
            </div>
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
                <Button variant="outline" onClick={() => changerStatut(sel, 'planifiee')}><Undo2 />Rétablir</Button>
              ) : (
                <Button variant="outline" onClick={() => changerStatut(sel, 'annulee')}><Ban />Annuler la séance</Button>
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
                {sallesLibres.salles.filter((s) => s.id_salle !== sel.id_salle).length === 0 ? (
                  <p className="text-sm text-ink-2">Aucune autre salle libre ne convient sur ce créneau.</p>
                ) : (
                  <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto p-px scroll-thin">
                    {sallesLibres.salles.map((s) => (
                      <button
                        key={s.id_salle}
                        type="button"
                        onClick={() => s.id_salle !== sel.id_salle && update({ id_salle: s.id_salle }, `Salle changée : ${s.nom_salle}`)}
                        className={cn('press rounded-full px-3 py-1.5 text-xs font-medium ring-1', s.id_salle === sel.id_salle ? 'bg-navy text-white ring-navy' : 'bg-white text-ink ring-line hover:bg-subtle')}
                        title={`${capaciteConnue(s) ? `${s.capacite} places` : 'Capacité non renseignée'} · ${db.site.find((x) => x.id_site === s.id_site)?.nom_site ?? ''}`}
                      >
                        {s.nom_salle} · {capaciteConnue(s) ? `${s.capacite} pl.` : 'capacité ?'}
                        {sallesLibres.id_site !== null && s.id_site !== sallesLibres.id_site && (
                          <span className="ml-1 rounded-full bg-orange-soft px-1.5 text-[10px] text-[#7C4A03]">{(db.site.find((x) => x.id_site === s.id_site)?.nom_site ?? 'autre campus').replace(/^Campus de /, '')}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-xs text-ink-2">
                  Salles libres de {fmtHeure(sel.heure_debut)} à {fmtHeure(sel.heure_fin)}
                  {!estEpreuve(sel) && sel.type_salle && <>, du type « {sel.type_salle.libelle} »</>}
                  {sel.effectif > 0
                    ? <>, d'au moins {sel.effectif} places{estEpreuve(sel) && ', épreuves partageant la salle comprises'}.</>
                    : <>. L'effectif de la classe n'est pas renseigné : la capacité des salles n'est pas vérifiée.</>}
                  {sallesLibres.id_site !== null && <> D'abord celles du {db.site.find((x) => x.id_site === sallesLibres.id_site)?.nom_site ?? 'campus de la classe'} (campus de la classe).</>}
                  {' '}Une promotion n'a cours que sur un campus par jour.
                </p>
              </div>
            )}
            {!lecture && (
              <div>
                <p className="section-label mb-2">Classes qui suivent ce cours</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-navy px-3 py-1 text-xs font-medium text-white" title="Classe du cours">
                    {publicCours(sel.classe, sel.groupe ?? null)}
                  </span>
                  {publicsEnPlus.map((p) => {
                    const c = db.classe.find((x) => x.id_classe === p.id_classe)
                    const g = db.groupe.find((x) => x.id_groupe === p.id_groupe) ?? null
                    return (
                      <span key={p.id_cours_public} className="flex items-center gap-1 rounded-full bg-white py-1 pr-1 pl-3 text-xs font-medium ring-1 ring-line">
                        {c ? publicCours(c, g) : '?'}
                        <button type="button" className="press grid size-5 place-items-center rounded-full text-ink-2 hover:bg-muted" aria-label={`Retirer ${c?.code_classe}`} title="Ne plus mutualiser avec cette classe" onClick={() => demutualiser(p.id_cours_public)}>
                          <X className="size-3" />
                        </button>
                      </span>
                    )
                  })}
                </div>
                <Combobox
                  className="mt-2"
                  options={optionsMutualisation}
                  value={null}
                  onChange={(v) => v !== null && mutualiser(v)}
                  placeholder="Mutualiser avec une classe…"
                  emptyText="Aucune classe"
                  ariaLabel="Mutualiser le cours avec une classe"
                />
                <p className="mt-2 text-xs text-ink-2">
                  Toutes les séances du cours apparaissent aussi dans l'emploi du temps des classes ajoutées. En rouge : une classe déjà occupée à l'heure d'une de ces séances, ou une salle trop petite pour tout le monde.
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
            aria-label="Programmer sur ces heures"
            className="fixed z-50 w-64 rounded-2xl bg-white p-1.5 text-sm shadow-xl ring-1 ring-line"
            style={{ left: Math.min(menu.x, window.innerWidth - 264), top: Math.min(menu.y, window.innerHeight - (copie ? 240 : 200)) }}
          >
            <p className="px-3 py-1.5 text-xs text-ink-2">
              {fmtJourCourt(menu.selection.date)}, {fmtHeure(fromMin(menu.selection.debut))}–{fmtHeure(fromMin(menu.selection.fin))}
            </p>
            {copie && (
              <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium hover:bg-muted" onClick={() => poserCopie(copie, menu.selection.date, fromMin(menu.selection.debut))}>
                <ClipboardPaste className="size-4 shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1 truncate">Coller {libelleSeance(copie)} ({dureeSeance(copie)} h)</span>
                <kbd className="font-mono text-[10px] text-ink-2">Ctrl+V</kbd>
              </button>
            )}
            <button type="button" role="menuitem" className={cn('press block w-full rounded-xl px-3 py-2 text-left hover:bg-muted', !copie && 'font-medium')} onClick={() => ouvrirSeance(menu.selection)}>Programmer une séance de cours</button>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => ouvrirEpreuve('examen', menu.selection)}>Programmer un examen</button>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => ouvrirEpreuve('rattrapage', menu.selection)}>Programmer un rattrapage</button>
            <button type="button" role="menuitem" className="press block w-full rounded-xl px-3 py-2 text-left text-ink-2 hover:bg-muted" onClick={() => { setMenu(null); setSelection(null) }}>Annuler la sélection</button>
          </div>
        </>
      )}

      {/* Menu du clic droit sur une séance */}
      {menuSeance && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuSeance(null)} onContextMenu={(e) => { e.preventDefault(); setMenuSeance(null) }} aria-hidden />
          <div
            role="menu"
            aria-label="Séance"
            className="fixed z-50 w-64 rounded-2xl bg-white p-1.5 text-sm shadow-xl ring-1 ring-line"
            style={{ left: Math.min(menuSeance.x, window.innerWidth - 264), top: Math.min(menuSeance.y, window.innerHeight - 230) }}
          >
            <p className="truncate px-3 py-1.5 text-xs text-ink-2">
              {menuSeance.s.matiere.libelle} · {fmtJourCourt(menuSeance.s.date_seance)}, {fmtHeure(menuSeance.s.heure_debut)}–{fmtHeure(menuSeance.s.heure_fin)}
            </p>
            <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left font-medium hover:bg-muted" onClick={() => copier(menuSeance.s)}>
              <Copy className="size-4 shrink-0 text-ink-2" /><span className="flex-1">Copier</span><kbd className="font-mono text-[10px] text-ink-2">Ctrl+C</kbd>
            </button>
            <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => poserCopie(menuSeance.s, addDays(menuSeance.s.date_seance, 7), menuSeance.s.heure_debut)}>
              <CopyPlus className="size-4 shrink-0 text-ink-2" />Dupliquer la semaine suivante
            </button>
            <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => { setSelected(menuSeance.s.id_seance); setMenuSeance(null) }}>
              <SquareArrowOutUpRight className="size-4 shrink-0 text-ink-2" />Ouvrir la séance
            </button>
            {menuSeance.s.statut === 'annulee' ? (
              <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-muted" onClick={() => changerStatut(menuSeance.s, 'planifiee')}>
                <Undo2 className="size-4 shrink-0 text-ink-2" />Rétablir la séance
              </button>
            ) : (
              <button type="button" role="menuitem" className="press flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[#B91C1C] hover:bg-[#FEE2E2]/60" onClick={() => changerStatut(menuSeance.s, 'annulee')}>
                <Ban className="size-4 shrink-0" />{estEpreuve(menuSeance.s) ? "Annuler l'épreuve" : 'Annuler la séance'}
              </button>
            )}
          </div>
        </>
      )}

      {seanceAPoser && (
        <DialogSeance
          edt={edt}
          depart={seanceAPoser}
          onFermer={() => { setSeanceAPoser(null); setSelection(null) }}
          onCreee={(date) => { setSeanceAPoser(null); setSelection(null); setSemaine(mondayOf(date)) }}
        />
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
