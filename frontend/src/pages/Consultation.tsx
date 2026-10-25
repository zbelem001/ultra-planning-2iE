// Espace invité : consultation des emplois du temps publiés (BF-21, BF-22),
// avec les filtres d'HyperPlanning (classe, enseignant, salle, matière).

import {
  BookOpen, CalendarDays, CalendarPlus, FileSpreadsheet, Columns3, DoorOpen, GraduationCap, LayoutList, Link2, Printer,
  Rows3, Settings2, SquareUser,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Combobox, Dialog, EmptyState, Logo, PillTabs, Select, Switch, type ComboOption } from '@/components/ui'
import { ListView } from '@/components/timetable/ListView'
import { SeanceDetail } from '@/components/timetable/SeanceDetail'
import { SemesterView } from '@/components/timetable/SemesterView'
import { WeekGrid } from '@/components/timetable/WeekGrid'
import { WeekStrip } from '@/components/timetable/WeekStrip'
import type { Champ } from '@/components/timetable/EventCard'
import { ecoles as ecolesApi } from '@/lib/api'
import { exporterExcel } from '@/lib/excel'
import { download, toIcs } from '@/lib/ics'
import { couleurMatiere, enrichir, filtrer, nomEnseignant, type Ressource, type SeanceVue } from '@/lib/queries'
import { ecoleCourante, edtPublie, useStore } from '@/lib/store'
import { addDays, fmtDateHeure, fmtJourCourt, jourOf, mondayOf, todayIso, weeksBetween } from '@/lib/time'
import type { TypeSeance } from '@/types/db'

type Vue = 'semaine' | 'jour' | 'liste' | 'semestre'

const RESSOURCES: { value: Ressource; label: string; icon: ReactNode; placeholder: string }[] = [
  { value: 'classe', label: 'Classes', icon: <GraduationCap />, placeholder: 'Rechercher une classe…' },
  { value: 'enseignant', label: 'Enseignants', icon: <SquareUser />, placeholder: 'Rechercher un enseignant…' },
  { value: 'salle', label: 'Salles', icon: <DoorOpen />, placeholder: 'Rechercher une salle…' },
  { value: 'matiere', label: 'Matières', icon: <BookOpen />, placeholder: 'Rechercher une matière…' },
]

const HIDE: Record<Ressource, Champ[]> = { classe: [], enseignant: ['enseignant'], salle: ['salle'], matiere: [] }

export default function Consultation() {
  const { db, ecoleAChoisir } = useStore()
  if (ecoleAChoisir) return <ChoixEcole />
  // École sans semestre (nouvelle, ou rien encore publié) : rien à consulter
  return db.semestre.length ? <Contenu /> : <AucunEmploiDuTemps />
}

/** Plusieurs écoles utilisent la plateforme : l'invité choisit la sienne (?ecole=CODE, à garder en favori) */
function ChoixEcole() {
  const [liste, setListe] = useState<{ code_ecole: string; nom: string; ville: string | null }[] | null>(null)
  useEffect(() => { ecolesApi().then(setListe).catch(() => setListe([])) }, [])
  return (
    <div className="flex min-h-dvh w-full flex-col px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <span className="rounded-full bg-white/70 py-1.5 pr-4 pl-1.5 ring-1 ring-white"><Logo suffix="Invités" /></span>
        <Link to="/admin" className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 text-xs font-medium hover:bg-white [&_svg]:size-4">
          <Settings2 />Administration
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl pb-10">
        <p className="section-label mb-2">Espace invités · enseignants et étudiants</p>
        <h1 className="text-4xl font-light tracking-tight sm:text-5xl">Votre école</h1>
        <Card className="mt-6 p-2">
          {liste === null ? <p className="p-4 text-sm text-ink-2">Chargement…</p> : (
            <ul className="divide-y divide-line/70">
              {liste.map((e) => (
                <li key={e.code_ecole}>
                  <a href={`/?ecole=${encodeURIComponent(e.code_ecole)}`} className="press flex items-center justify-between gap-3 rounded-3xl px-4 py-4 hover:bg-white/70">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{e.nom}</span>
                      <span className="block text-xs text-ink-2">{[e.code_ecole, e.ville].filter(Boolean).join(' · ')}</span>
                    </span>
                    <CalendarDays className="size-4 shrink-0 text-navy" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </main>
    </div>
  )
}

function AucunEmploiDuTemps() {
  const { db } = useStore()
  return (
    <div className="flex min-h-dvh w-full flex-col px-4 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <span className="rounded-full bg-white/70 py-1.5 pr-4 pl-1.5 ring-1 ring-white"><Logo suffix="Invités" ecole={ecoleCourante(db)} /></span>
        <Link to="/admin" className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 text-xs font-medium hover:bg-white [&_svg]:size-4">
          <Settings2 />Administration
        </Link>
      </header>
      <Card><EmptyState icon={<CalendarDays />} title="Aucun emploi du temps publié">La scolarité n'a pas encore publié d'emploi du temps.</EmptyState></Card>
    </div>
  )
}

function Contenu() {
  const { db } = useStore()
  const [params, setParams] = useSearchParams()
  const edt = edtPublie(db)
  const semestre = db.semestre.find((s) => s.id_semestre === edt?.id_semestre) ?? db.semestre[0]
  const weeks = useMemo(() => weeksBetween(semestre.date_debut, semestre.date_fin), [semestre])

  // --- état porté par l'URL (lien partageable) ---
  const res = (params.get('r') as Ressource) || 'classe'
  const id = params.get('id') ? Number(params.get('id')) : null
  const idGroupe = params.get('g') ? Number(params.get('g')) : null
  const defaultWeek = weeks.includes(mondayOf(todayIso())) ? mondayOf(todayIso()) : weeks[0]
  const semaine = params.get('s') && weeks.includes(params.get('s')!) ? params.get('s')! : defaultWeek
  const vue = (params.get('v') as Vue) || (typeof window !== 'undefined' && window.innerWidth < 640 ? 'jour' : 'semaine')
  const set = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, String(v))
    }
    setParams(next, { replace: true })
  }

  const [idSite, setIdSite] = useState<number | null>(null)
  const [idFiliere, setIdFiliere] = useState<number | null>(null)
  const [types, setTypes] = useState<TypeSeance[]>(['CM', 'TD', 'TP'])
  const [masquerAnnulees, setMasquerAnnulees] = useState(false)
  const [detail, setDetail] = useState<SeanceVue | null>(null)

  const joursSemaine = Array.from({ length: 6 }, (_, i) => addDays(semaine, i))
  const [jour, setJour] = useState(() => (joursSemaine.includes(todayIso()) ? todayIso() : semaine))
  useEffect(() => {
    if (!joursSemaine.includes(jour)) setJour(joursSemaine.includes(todayIso()) ? todayIso() : semaine)
  }, [semaine]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- options de la recherche ---
  const options: ComboOption[] = useMemo(() => {
    switch (res) {
      case 'classe':
        return db.classe
          .filter((c) => idFiliere === null || c.id_filiere === idFiliere)
          .filter((c) => idSite === null || db.filiere.find((f) => f.id_filiere === c.id_filiere)?.id_site === idSite)
          .map((c) => ({
            value: c.id_classe,
            label: c.code_classe,
            hint: `${c.libelle} · ${c.effectif} étudiants`,
            group: db.filiere.find((f) => f.id_filiere === c.id_filiere)?.libelle,
          }))
      case 'enseignant':
        return [...db.enseignant]
          .filter((e) => idSite === null || e.id_site === idSite)
          .sort((a, b) => a.nom.localeCompare(b.nom))
          .map((e) => ({ value: e.id_enseignant, label: `${e.nom.toUpperCase()} ${e.prenom}`, hint: e.grade ?? undefined }))
      case 'salle':
        return [...db.salle]
          .filter((s) => idSite === null || s.id_site === idSite)
          .sort((a, b) => a.id_site - b.id_site || (a.batiment ?? '').localeCompare(b.batiment ?? '') || a.nom_salle.localeCompare(b.nom_salle))
          .map((s) => ({
            value: s.id_salle,
            label: s.nom_salle,
            hint: `${db.type_salle.find((t) => t.id_type_salle === s.id_type_salle)?.libelle} · ${s.capacite} places${s.batiment ? ` · ${s.batiment}` : ''}`,
            group: db.site.find((x) => x.id_site === s.id_site)?.nom_site,
          }))
      case 'matiere':
        return db.matiere.map((m) => ({ value: m.id_matiere, label: m.libelle, hint: m.code_matiere }))
    }
  }, [db, res, idFiliere, idSite])

  const groupes = res === 'classe' && id !== null ? db.groupe.filter((g) => g.id_classe === id) : []

  // --- séances affichées ---
  const toutes = useMemo(() => (edt ? enrichir(db, db.seance.filter((s) => s.id_edt === edt.id_edt)) : []), [db, edt])
  const ressource = useMemo(() => {
    if (id === null) return []
    return filtrer(toutes, res, id, idGroupe).filter(
      (s) => types.includes(s.cours.type_cours) && !(masquerAnnulees && s.statut === 'annulee'),
    )
  }, [toutes, res, id, idGroupe, types, masquerAnnulees])
  const semaineList = ressource.filter((s) => s.date_seance >= semaine && s.date_seance <= addDays(semaine, 6))
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of ressource) m.set(mondayOf(s.date_seance), (m.get(mondayOf(s.date_seance)) ?? 0) + 1)
    return m
  }, [ressource])

  const avecSamedi = db.creneau.some((c) => c.jour === 'Samedi') || semaineList.some((s) => jourOf(s.date_seance) === 'Samedi')
  const jours = joursSemaine.slice(0, avecSamedi ? 6 : 5)
  const heures = semaineList.filter((s) => s.statut !== 'annulee').reduce((a, s) => a + s.duree, 0)
  const matieresSemaine = [...new Map(semaineList.map((s) => [s.matiere.id_matiere, s.matiere])).values()]

  const titre = useMemo(() => {
    if (id === null) return null
    if (res === 'classe') {
      const c = db.classe.find((x) => x.id_classe === id)
      const g = db.groupe.find((x) => x.id_groupe === idGroupe)
      return c ? `${c.code_classe}${g ? ` · ${g.code_groupe}` : ''}` : null
    }
    if (res === 'enseignant') {
      const e = db.enseignant.find((x) => x.id_enseignant === id)
      return e ? nomEnseignant(e) : null
    }
    if (res === 'salle') return db.salle.find((x) => x.id_salle === id)?.nom_salle ?? null
    return db.matiere.find((x) => x.id_matiere === id)?.libelle ?? null
  }, [db, res, id, idGroupe])

  const exporterTableur = () => {
    exporterExcel(ressource, `Emploi du temps ${titre ?? ''} · ${semestre.libelle} ${semestre.annee_academique}`,
      `edt-${(titre ?? 'export').replace(/\W+/g, '-').toLowerCase()}.xlsx`)
      .catch((e: Error) => toast.error('Export Excel impossible', { description: e.message }))
  }
  const exporter = () => {
    download(`edt-${(titre ?? 'export').replace(/\W+/g, '-').toLowerCase()}.ics`, toIcs(ressource, `EDT ${titre}`))
    toast.success('Fichier iCalendar téléchargé', { description: 'Importez-le dans Google Agenda, Outlook ou Calendrier.' })
  }
  const copierLien = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast.success('Lien copié', { description: 'Il ouvre directement cet emploi du temps.' })
    } catch {
      toast.error('Copie impossible dans ce navigateur')
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col px-4 sm:px-8">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-navy focus:px-4 focus:py-2 focus:text-white">
        Aller au contenu
      </a>

      {/* En-tête */}
      <header className="no-print flex flex-wrap items-center justify-between gap-3 py-5">
        <Link to="/" className="rounded-full bg-white/70 py-1.5 pr-4 pl-1.5 ring-1 ring-white" aria-label="Ultraplanning, accueil">
          <Logo suffix="Invités" ecole={ecoleCourante(db)} />
        </Link>
        <div className="flex items-center gap-2">
          {edt && (
            <span className="hidden sm:block">
              <Badge tone="success" dot>
                {semestre.libelle} {semestre.annee_academique} · publié le {fmtDateHeure(edt.date_publication ?? edt.date_creation).split(' à')[0]}
              </Badge>
            </span>
          )}
          <Link to="/admin" className="press inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-white/80 px-3 text-xs font-medium hover:bg-white [&_svg]:size-4">
            <Settings2 />Administration
          </Link>
        </div>
      </header>

      <main id="contenu" className="flex-1 pb-10">
        <div className="no-print mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="section-label mb-2">Espace invités · enseignants et étudiants</p>
            <h1 className="text-4xl font-light tracking-tight sm:text-5xl">Emplois du temps</h1>
          </div>
        </div>

        {!edt ? (
          <Card><EmptyState icon={<CalendarDays />} title="Aucun emploi du temps publié">La scolarité n'a pas encore publié l'emploi du temps de ce semestre.</EmptyState></Card>
        ) : (
          <div className="grid grid-cols-1 gap-5">
            {/* Filtres */}
            <Card className="no-print p-4 sm:p-5">
              <PillTabs
                label="Type de ressource"
                value={res}
                onChange={(r) => set({ r, id: null, g: null })}
                items={RESSOURCES.map(({ value, label, icon }) => ({ value, label, icon }))}
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,13rem)_minmax(0,13rem)_minmax(0,1fr)_minmax(0,14rem)]">
                {res !== 'matiere' ? (
                  <Select aria-label="Campus" value={idSite ?? ''} onChange={(e) => { setIdSite(e.target.value ? Number(e.target.value) : null); setIdFiliere(null) }}>
                    <option value="">Tous les campus</option>
                    {db.site.map((s) => <option key={s.id_site} value={s.id_site}>{s.nom_site}</option>)}
                  </Select>
                ) : <div className="hidden lg:block" />}
                {res === 'classe' ? (
                  <Select aria-label="Filière" value={idFiliere ?? ''} onChange={(e) => setIdFiliere(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Toutes les filières</option>
                    {db.filiere.filter((f) => idSite === null || f.id_site === idSite).map((f) => <option key={f.id_filiere} value={f.id_filiere}>{f.libelle}</option>)}
                  </Select>
                ) : <div className="hidden lg:block" />}
                <Combobox
                  className="sm:col-span-2 lg:col-span-1"
                  ariaLabel={RESSOURCES.find((r) => r.value === res)!.placeholder}
                  placeholder={RESSOURCES.find((r) => r.value === res)!.placeholder}
                  options={options}
                  value={id}
                  onChange={(v) => set({ id: v, g: null })}
                />
                {res === 'classe' && groupes.length > 0 ? (
                  <Select aria-label="Groupe" value={idGroupe ?? ''} onChange={(e) => set({ g: e.target.value || null })}>
                    <option value="">Tous les groupes</option>
                    {groupes.map((g) => <option key={g.id_groupe} value={g.id_groupe}>Groupe {g.code_groupe} ({g.effectif})</option>)}
                  </Select>
                ) : <div className="hidden lg:block" />}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                <div className="flex items-center gap-1.5" role="group" aria-label="Types de séance">
                  <span className="mr-1 text-sm text-ink-2">Types</span>
                  {(['CM', 'TD', 'TP'] as TypeSeance[]).map((t) => {
                    const on = types.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])}
                        className={cn('press h-8 rounded-full px-3 text-xs font-semibold', on ? 'bg-navy text-white' : 'bg-white/70 text-ink-2 ring-1 ring-line')}
                      >
                        {t}
                      </button>
                    )
                  })}
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <Switch checked={masquerAnnulees} onChange={setMasquerAnnulees} label="Masquer les séances annulées" />
                  Masquer les annulées
                </label>
              </div>
            </Card>

            {id === null ? (
              <Card>
                <EmptyState icon={<CalendarDays />} title={`Choisissez ${res === 'classe' ? 'une classe' : res === 'enseignant' ? 'un enseignant' : res === 'salle' ? 'une salle' : 'une matière'}`}>
                  <p>Tapez quelques lettres dans la recherche, ou partez d'un raccourci :</p>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {options.slice(0, 8).map((o) => (
                      <Button key={o.value} variant="outline" size="sm" onClick={() => set({ id: o.value })}>{o.label}</Button>
                    ))}
                  </div>
                </EmptyState>
              </Card>
            ) : (
              <Card className="p-3 sm:p-5">
                {/* Barre d'outils */}
                <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                  <div className="min-w-0">
                    <h2 className="truncate text-2xl font-light tracking-tight sm:text-3xl">{titre}</h2>
                    <p className="text-sm text-ink-2">
                      {vue === 'semestre'
                        ? `${ressource.filter((s) => s.statut !== 'annulee').reduce((a, s) => a + s.duree, 0)} h sur le semestre`
                        : `${semaineList.length} séance${semaineList.length > 1 ? 's' : ''} · ${heures} h cette semaine`}
                    </p>
                  </div>
                  <div className="no-print flex flex-wrap items-center gap-2">
                    <PillTabs
                      label="Vue"
                      size="sm"
                      value={vue}
                      onChange={(v) => set({ v })}
                      items={[
                        { value: 'semaine', label: 'Semaine', icon: <Columns3 /> },
                        { value: 'jour', label: 'Jour', icon: <Rows3 /> },
                        { value: 'liste', label: 'Liste', icon: <LayoutList /> },
                        { value: 'semestre', label: 'Semestre', icon: <CalendarDays /> },
                      ]}
                    />
                    <Button variant="outline" size="icon-sm" onClick={exporter} aria-label="Exporter en iCalendar" title="Exporter en iCalendar"><CalendarPlus /></Button>
                    <Button variant="outline" size="icon-sm" onClick={exporterTableur} aria-label="Exporter en Excel" title="Exporter en Excel (tout le semestre)"><FileSpreadsheet /></Button>
                    <Button variant="outline" size="icon-sm" onClick={() => window.print()} aria-label="Imprimer" title="Imprimer ou PDF"><Printer /></Button>
                    <Button variant="outline" size="icon-sm" onClick={copierLien} aria-label="Copier le lien" title="Copier le lien"><Link2 /></Button>
                  </div>
                </div>

                {vue !== 'semestre' && (
                  <div className="no-print mt-4">
                    <WeekStrip weeks={weeks} value={semaine} onChange={(s) => set({ s })} counts={counts} />
                  </div>
                )}

                {vue === 'jour' && (
                  <div className="no-print mt-3 flex gap-1.5 overflow-x-auto scroll-thin">
                    {jours.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setJour(d)}
                        aria-pressed={d === jour}
                        className={cn('press h-9 shrink-0 rounded-full px-3.5 text-sm capitalize', d === jour ? 'bg-navy text-white' : 'bg-white/70 text-ink-2 hover:bg-white')}
                      >
                        {fmtJourCourt(d)}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mt-4">
                  {vue === 'semaine' && <WeekGrid db={db} days={jours} seances={semaineList} hide={HIDE[res]} onSelect={setDetail} idClasse={res === 'classe' ? id : null} />}
                  {vue === 'jour' && <WeekGrid db={db} days={[jour]} seances={semaineList} hide={HIDE[res]} onSelect={setDetail} idClasse={res === 'classe' ? id : null} />}
                  {vue === 'liste' &&
                    (semaineList.length ? (
                      <ListView seances={semaineList} onSelect={setDetail} />
                    ) : (
                      <EmptyState icon={<CalendarDays />} title="Aucune séance cette semaine" />
                    ))}
                  {vue === 'semestre' && <SemesterView db={db} weeks={weeks} seances={ressource} onPickWeek={(s) => set({ s, v: 'semaine' })} idClasse={res === 'classe' ? id : null} />}
                </div>

                {matieresSemaine.length > 0 && vue !== 'semestre' && (
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-xs text-ink-2">
                    {matieresSemaine.map((m) => (
                      <span key={m.id_matiere} className="flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ backgroundColor: couleurMatiere(m.id_matiere) }} />
                        {m.libelle}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        )}
      </main>

      <footer className="no-print flex flex-wrap items-center justify-between gap-2 border-t border-black/5 py-5 text-xs text-ink-2">
        <span>Ultraplanning{ecoleCourante(db) ? ` · ${ecoleCourante(db)!.nom}` : ''}</span>
        <span>Consultation en lecture seule · {edt ? `version ${edt.version}` : ''}</span>
      </footer>

      <Dialog
        open={!!detail}
        onClose={() => setDetail(null)}
        title="Détail de la séance"
        footer={
          detail && (
            <Button variant="outline" onClick={() => download(`seance-${detail.id_seance}.ics`, toIcs([detail], detail.matiere.libelle))}>
              <CalendarPlus />Ajouter à mon agenda
            </Button>
          )
        }
      >
        {detail && <SeanceDetail s={detail} publique />}
      </Dialog>
    </div>
  )
}
