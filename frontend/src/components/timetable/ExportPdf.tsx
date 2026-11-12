// Export PDF de l'emploi du temps d'une classe, côté console comme côté invités : une page A4 paysage par
// semaine, avec la grille telle qu'à l'écran. On choisit la classe (et un groupe), les semaines, les types de
// séance et les matières, ce que montrent les cartes. Les pages sont rendues hors de l'écran, puis l'impression
// du navigateur en fait un PDF (« Enregistrer au format PDF ») : texte net, sans bibliothèque de plus.

import { FileDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, cn, Combobox, Dialog, Select, Switch, type ComboOption } from '@/components/ui'
import type { Champ } from '@/components/timetable/EventCard'
import { bornesGrille, joursGrille, WeekGrid } from '@/components/timetable/WeekGrid'
import { estEpreuve } from '@/lib/publics'
import { COULEURS_TYPE, filtrer, LIBELLES_TYPE, typeSeance, type SeanceVue, type TypeCouleur } from '@/lib/queries'
import { ecoleCourante } from '@/lib/store'
import { addDays, fmtDateHeure, fmtJourMois, isoWeek, jourOf, parseDate } from '@/lib/time'
import type { Db } from '@/types/db'

const TYPES = ['CM', 'TD', 'TP', 'EXAMEN'] as const
type TypeExport = (typeof TYPES)[number]
const LIBELLE_TYPE: Record<TypeExport, string> = { CM: 'CM', TD: 'TD', TP: 'TP', EXAMEN: 'Examens et rattrapages' }

// Page A4 paysage, marges de 8 mm (index.css, @page export) : 281 × 194 mm, soit 733 px de haut à 96 px/pouce.
// En-tête, pied et noms des jours (avec un jour férié) ôtés, il reste environ 576 px pour les heures de la journée.
const HAUTEUR_HEURES = 576

export interface DepartExport {
  idClasse: number | null
  idGroupe: number | null
  /** Lundi de la semaine affichée */
  semaine: string
}

interface Filtres {
  idClasse: number | null
  idGroupe: number | null
  du: string
  au: string
  types: TypeExport[]
  matieresExclues: number[]
  annulees: boolean
  vides: boolean
  enseignant: boolean
  salle: boolean
}

interface PageExport {
  lundi: string
  jours: string[]
  seances: SeanceVue[]
}

interface Impression {
  pages: PageExport[]
  titre: string
  sousTitre: string
  filtres: string
  hide: Champ[]
  idClasse: number
}

const typeDe = (s: SeanceVue): TypeExport => (estEpreuve(s) ? 'EXAMEN' : (s.cours.type_cours as TypeExport))

/**
 * Fenêtre d'export et impression. `seances` : celles de la version exportée (publiée pour les invités, à jour
 * dans Planification), déjà enrichies ; `version` : ce qu'en dit l'en-tête de chaque page.
 */
export function ExportPdf({ open, onClose, db, seances, semaines, depart, version }: {
  open: boolean
  onClose: () => void
  db: Db
  seances: SeanceVue[]
  semaines: string[]
  depart: DepartExport
  version: string
}) {
  const [impression, setImpression] = useState<Impression | null>(null)

  useEffect(() => {
    if (!impression) return
    let fini = false
    document.body.classList.add('impression-export-active')
    const fin = () => {
      fini = true
      document.body.classList.remove('impression-export-active')
      setImpression(null)
    }
    window.addEventListener('afterprint', fin, { once: true })
    // Polices chargées et pages mises en page avant d'ouvrir l'impression
    void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => { if (!fini) window.print() })))
    return () => {
      window.removeEventListener('afterprint', fin)
      document.body.classList.remove('impression-export-active')
    }
  }, [impression])

  return (
    <>
      {/* refait à chaque ouverture : il repart de ce qu'affiche la page */}
      {open && (
        <Formulaire
          db={db}
          seances={seances}
          semaines={semaines}
          depart={depart}
          version={version}
          onClose={onClose}
          onExporter={(i) => { setImpression(i); onClose() }}
        />
      )}
      {impression && <Pages db={db} impression={impression} />}
    </>
  )
}

function Formulaire({ db, seances, semaines, depart, version, onClose, onExporter }: {
  db: Db
  seances: SeanceVue[]
  semaines: string[]
  depart: DepartExport
  version: string
  onClose: () => void
  onExporter: (i: Impression) => void
}) {
  const [f, setF] = useState<Filtres>(() => ({
    idClasse: depart.idClasse,
    idGroupe: depart.idGroupe,
    du: semaines.includes(depart.semaine) ? depart.semaine : semaines[0],
    au: semaines[semaines.length - 1],
    types: [...TYPES],
    matieresExclues: [],
    annulees: true,
    vides: false,
    enseignant: true,
    salle: true,
  }))
  const maj = (patch: Partial<Filtres>) => setF((x) => ({ ...x, ...patch }))

  const classes: ComboOption[] = useMemo(() => [...db.classe]
    .sort((a, b) => a.code_classe.localeCompare(b.code_classe))
    .map((c) => ({ value: c.id_classe, label: c.code_classe, hint: c.libelle, group: db.filiere.find((x) => x.id_filiere === c.id_filiere)?.libelle })),
  [db.classe, db.filiere])
  const groupes = f.idClasse === null ? [] : db.groupe.filter((g) => g.id_classe === f.idClasse).sort((a, b) => a.code_groupe.localeCompare(b.code_groupe))
  const classe = db.classe.find((c) => c.id_classe === f.idClasse)
  const groupe = db.groupe.find((g) => g.id_groupe === f.idGroupe)

  // Séances de la classe sur la période, puis celles que gardent les filtres
  const periode = useMemo(() => {
    if (f.idClasse === null) return []
    return filtrer(seances, 'classe', f.idClasse, f.idGroupe, db.groupe).filter((s) => s.date_seance >= f.du && s.date_seance <= addDays(f.au, 6))
  }, [seances, f.idClasse, f.idGroupe, f.du, f.au, db.groupe])
  const matieres = useMemo(() => [...new Map(periode.map((s) => [s.matiere.id_matiere, s.matiere])).values()]
    .sort((a, b) => a.libelle.localeCompare(b.libelle)), [periode])
  const retenues = periode.filter((s) => f.types.includes(typeDe(s)) && !f.matieresExclues.includes(s.matiere.id_matiere) && (f.annulees || s.statut !== 'annulee'))

  const pages: PageExport[] = semaines
    .filter((l) => l >= f.du && l <= f.au)
    .map((lundi) => {
      const liste = retenues.filter((s) => s.date_seance >= lundi && s.date_seance <= addDays(lundi, 6))
      // les jours de la grille, et le samedi s'il porte une séance
      const jours = joursGrille(db, lundi)
      for (const s of liste) if (!jours.includes(s.date_seance)) jours.push(s.date_seance)
      return { lundi, jours: jours.sort(), seances: liste }
    })
    .filter((p) => f.vides || p.seances.length > 0)

  const optionsSemaine = semaines.map((l) => <option key={l} value={l}>S{isoWeek(l)} · {fmtJourMois(l)}</option>)
  const resume = [
    f.types.length < TYPES.length && f.types.map((t) => LIBELLE_TYPE[t]).join(', '),
    f.matieresExclues.length > 0 && matieres.length > 0 && `${matieres.filter((m) => !f.matieresExclues.includes(m.id_matiere)).length} matière(s) sur ${matieres.length}`,
    !f.annulees && 'sans les séances annulées',
  ].filter(Boolean).join(' · ')

  const exporter = () => {
    if (!classe || !pages.length) return
    onExporter({
      pages,
      titre: `${classe.code_classe}${groupe ? ` · ${groupe.code_groupe}` : ''} · ${classe.libelle}`,
      sousTitre: version,
      filtres: resume,
      hide: [...(f.enseignant ? [] : ['enseignant' as const]), ...(f.salle ? [] : ['salle' as const])],
      idClasse: classe.id_classe,
    })
  }

  const puce = (actif: boolean) => cn('press h-8 rounded-full px-3 text-xs font-semibold', actif ? 'bg-navy text-white' : 'bg-white/70 text-ink-2 ring-1 ring-line')

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Exporter en PDF"
      description="Une page par semaine, avec la grille telle qu'à l'écran. Le navigateur ouvre ensuite l'impression : choisissez « Enregistrer au format PDF »."
      footer={(
        <>
          <span className="mr-auto text-sm text-ink-2" data-resume-export>
            {f.idClasse === null ? 'Choisissez une classe.'
              : pages.length ? `${pages.length} page${pages.length > 1 ? 's' : ''} · ${retenues.length} séance${retenues.length > 1 ? 's' : ''}`
                : 'Aucune séance avec ces filtres.'}
          </span>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={!classe || !pages.length} onClick={exporter} data-exporter-pdf><FileDown />Exporter en PDF</Button>
        </>
      )}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="pl-1 text-sm font-medium text-ink">Classe</span>
          <Combobox options={classes} value={f.idClasse} onChange={(v) => maj({ idClasse: v, idGroupe: null, matieresExclues: [] })} placeholder="Rechercher une classe…" ariaLabel="Classe à exporter" />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="pl-1 text-sm font-medium text-ink">Groupe</span>
          <Select value={f.idGroupe ?? ''} disabled={!groupes.length} onChange={(e) => maj({ idGroupe: e.target.value ? Number(e.target.value) : null })} aria-label="Groupe">
            <option value="">Toute la classe</option>
            {groupes.map((g) => <option key={g.id_groupe} value={g.id_groupe}>{g.code_groupe}</option>)}
          </Select>
        </label>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="pl-1 text-sm font-medium text-ink">Semaines</span>
          <div className="flex flex-wrap items-center gap-2">
            <Select className="w-40" value={f.du} onChange={(e) => maj({ du: e.target.value, au: e.target.value > f.au ? e.target.value : f.au })} aria-label="Première semaine">{optionsSemaine}</Select>
            <span className="text-sm text-ink-2">à</span>
            <Select className="w-40" value={f.au} onChange={(e) => maj({ au: e.target.value, du: e.target.value < f.du ? e.target.value : f.du })} aria-label="Dernière semaine">{optionsSemaine}</Select>
            <span className="flex flex-wrap gap-1.5 sm:ml-2">
              <button type="button" className={puce(f.du === depart.semaine && f.au === depart.semaine)} onClick={() => maj({ du: depart.semaine, au: depart.semaine })}>Semaine affichée</button>
              <button type="button" className={puce(f.du === depart.semaine && f.au === semaines[semaines.length - 1])} onClick={() => maj({ du: depart.semaine, au: semaines[semaines.length - 1] })}>Jusqu'à la fin</button>
              <button type="button" className={puce(f.du === semaines[0] && f.au === semaines[semaines.length - 1])} onClick={() => maj({ du: semaines[0], au: semaines[semaines.length - 1] })}>Tout le semestre</button>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="pl-1 text-sm font-medium text-ink">Séances</span>
          <div className="flex flex-wrap gap-1.5">
            {TYPES.map((t) => {
              const on = f.types.includes(t)
              return <button key={t} type="button" aria-pressed={on} className={puce(on)} onClick={() => maj({ types: on ? f.types.filter((x) => x !== t) : [...f.types, t] })}>{LIBELLE_TYPE[t]}</button>
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="flex items-center gap-3 pl-1 text-sm font-medium text-ink">
            Matières
            {matieres.length > 1 && (
              <button type="button" className="text-xs font-medium text-navy underline underline-offset-2" onClick={() => maj({ matieresExclues: f.matieresExclues.length ? [] : matieres.map((m) => m.id_matiere) })}>
                {f.matieresExclues.length ? 'Toutes' : 'Aucune'}
              </button>
            )}
          </span>
          {matieres.length ? (
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto scroll-thin" data-matieres-export>
              {matieres.map((m) => {
                const on = !f.matieresExclues.includes(m.id_matiere)
                return (
                  <button key={m.id_matiere} type="button" aria-pressed={on} className={cn(puce(on), 'flex items-center gap-1.5 font-medium')}
                    onClick={() => maj({ matieresExclues: on ? [...f.matieresExclues, m.id_matiere] : f.matieresExclues.filter((x) => x !== m.id_matiere) })}>
                    {m.libelle}
                  </button>
                )
              })}
            </div>
          ) : <p className="pl-1 text-sm text-ink-2">{f.idClasse === null ? 'Choisissez une classe.' : 'Aucune séance sur ces semaines.'}</p>}
        </div>

        <div className="grid gap-2 text-sm text-ink-2 sm:col-span-2 sm:grid-cols-2">
          <label className="flex items-center gap-2"><Switch checked={f.enseignant} onChange={(v) => maj({ enseignant: v })} label="Enseignant sur les cartes" />Enseignant sur les cartes</label>
          <label className="flex items-center gap-2"><Switch checked={f.salle} onChange={(v) => maj({ salle: v })} label="Salle sur les cartes" />Salle et campus sur les cartes</label>
          <label className="flex items-center gap-2"><Switch checked={f.annulees} onChange={(v) => maj({ annulees: v })} label="Séances annulées" />Séances annulées (barrées)</label>
          <label className="flex items-center gap-2"><Switch checked={f.vides} onChange={(v) => maj({ vides: v })} label="Semaines sans séance" />Semaines sans séance</label>
        </div>
      </div>
    </Dialog>
  )
}

/** Les pages, hors de l'écran ; à l'impression, elles seules s'affichent (index.css) */
function Pages({ db, impression }: { db: Db; impression: Impression }) {
  const [debut, fin] = bornesGrille(db)
  const pxHeure = Math.floor(HAUTEUR_HEURES / ((fin - debut) / 60))
  const ecole = ecoleCourante(db)?.nom
  const le = fmtDateHeure(new Date().toISOString())
  const n = impression.pages.length
  return createPortal(
    <div id="impression-export" aria-hidden>
      {impression.pages.map((p, i) => {
        const dernier = p.jours[p.jours.length - 1] ?? addDays(p.lundi, 5)
        const heures = p.seances.filter((s) => s.statut !== 'annulee').reduce((a, s) => a + s.duree, 0)
        return (
          <section key={p.lundi} className="page-export" data-page-export={p.lundi}>
            <header className="flex items-end justify-between gap-6 border-b border-line pb-2">
              <div className="min-w-0">
                {ecole && <p className="truncate text-[11px] text-ink-2">{ecole}</p>}
                <h1 className="truncate text-xl leading-tight font-medium text-ink">Emploi du temps · {impression.titre}</h1>
                <p className="truncate text-[11px] text-ink-2">{impression.sousTitre}{impression.filtres && ` · ${impression.filtres}`}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg leading-tight font-medium text-navy">
                  Semaine {isoWeek(p.lundi)} · du {fmtJourMois(p.lundi)} au {fmtJourMois(dernier)} {parseDate(dernier).getFullYear()}
                </p>
                <p className="text-[11px] text-ink-2">{p.seances.length} séance{p.seances.length > 1 ? 's' : ''} · {heures} h · page {i + 1}/{n}</p>
              </div>
            </header>
            <div className="min-h-0 flex-1 pt-2">
              <WeekGrid db={db} days={p.jours.filter((d) => jourOf(d) !== null)} seances={p.seances} hide={impression.hide} idClasse={impression.idClasse} impression={{ pxHeure }} />
            </div>
            <footer className="flex justify-between text-[10px] text-ink-2">
              <span className="flex items-center gap-3">
                Ultraplanning
                {/* légende : les types présents sur la page */}
                {(Object.keys(COULEURS_TYPE) as TypeCouleur[]).filter((t) => p.seances.some((s) => typeSeance(s) === t)).map((t) => (
                  <span key={t} className="flex items-center gap-1"><span className="size-2 rounded-full" style={{ backgroundColor: COULEURS_TYPE[t] }} />{LIBELLES_TYPE[t]}</span>
                ))}
              </span>
              <span>Exporté le {le}</span>
            </footer>
          </section>
        )
      })}
    </div>,
    document.body,
  )
}
