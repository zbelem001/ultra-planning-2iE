// Tableau de bord : volumes horaires (BF-23), occupation des salles et charge des enseignants (BF-24).

import { AlertTriangle, CalendarRange, CheckCircle2, Clock, DoorOpen, Sparkles } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, cn, Meter, PageTitle, PillTabs, SectionTitle } from '@/components/ui'
import { checkSeance } from '@/lib/rules'
import { couleurType, enrichir, nomEnseignant, publicCours } from '@/lib/queries'
import { estEpreuve } from '@/lib/publics'
import { useGrandEcran } from '@/lib/hauteur'
import { edtTravail, useStore } from '@/lib/store'
import { addDays, fmtJourMois, hours, isoWeek, mondayOf, todayIso } from '@/lib/time'

// Sections de la colonne de droite, sur grand écran : parts égales de la hauteur, sans dépasser leur contenu (une
// section courte rend la place qu'elle n'utilise pas), et une liste qui défile
const SECTION = 'p-5 sm:p-6 xl:flex xl:min-h-0 xl:flex-1 xl:basis-0 xl:max-h-fit xl:flex-col xl:p-4'
const LISTE = 'mt-4 space-y-2.5 xl:mt-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1 scroll-thin'

function Stat({ icon, label, value, sub, tone = 'navy' }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: 'navy' | 'orange' | 'success' | 'danger' }) {
  const ring = { navy: 'bg-navy/10 text-navy', orange: 'bg-orange-soft text-[#7C4A03]', success: 'bg-[#DCFCE7] text-[#166534]', danger: 'bg-[#FEE2E2] text-[#991B1B]' }[tone]
  return (
    <Card className="p-5 xl:px-5 xl:py-3.5">
      <div className="flex items-center justify-between">
        <p className="section-label">{label}</p>
        <span className={cn('grid size-9 place-items-center rounded-full [&_svg]:size-4', ring)}>{icon}</span>
      </div>
      <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums xl:mt-1 xl:text-3xl">{value}</p>
      {sub && <p className="mt-1 text-sm text-ink-2">{sub}</p>}
    </Card>
  )
}

export default function Dashboard() {
  const { db } = useStore()
  const edt = edtTravail(db)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  // Calculs sur toutes les séances : une fois par changement de la base, pas à chaque rendu
  const seances = useMemo(() => db.seance.filter((s) => s.id_edt === edt.id_edt), [db, edt])
  const actives = useMemo(() => seances.filter((s) => s.statut !== 'annulee'), [seances])
  const today = todayIso()
  const lundi = mondayOf(today >= semestre.date_debut ? today : semestre.date_debut)
  const [tri, setTri] = useState<'ecart' | 'matiere'>('ecart')
  const [toutesLesLignes, setToutesLesLignes] = useState(false)
  // Grand écran : la page tient en un bloc et chaque section défile ; tout y est montré
  const unBloc = useGrandEcran(1280)

  const coursSemestre = useMemo(() => db.cours.filter((c) => c.id_semestre === semestre.id_semestre), [db.cours, semestre.id_semestre])
  const prevues = coursSemestre.reduce((a, c) => a + c.volume_horaire, 0)
  const cours = useMemo(() => actives.filter((s) => !estEpreuve(s)), [actives]) // les épreuves ne comptent pas dans les volumes
  const planifiees = useMemo(() => cours.reduce((a, s) => a + hours(s.heure_debut, s.heure_fin), 0), [cours])

  const violations = useMemo(() => actives.reduce((n, s) => n + (checkSeance(db, s).length ? 1 : 0), 0), [db, actives])

  const lignes = useMemo(() => {
    // heures planifiées et effectuées de chaque cours, en un passage sur les séances
    const parCours = new Map<number, { plan: number; faites: number }>()
    for (const s of cours) {
      const h = hours(s.heure_debut, s.heure_fin)
      const a = parCours.get(s.id_cours) ?? { plan: 0, faites: 0 }
      a.plan += h
      if (s.date_seance < today) a.faites += h
      parCours.set(s.id_cours, a)
    }
    const mat = new Map(db.matiere.map((x) => [x.id_matiere, x]))
    const cla = new Map(db.classe.map((x) => [x.id_classe, x]))
    const grp = new Map(db.groupe.map((x) => [x.id_groupe, x]))
    const ens = new Map(db.enseignant.map((x) => [x.id_enseignant, x]))
    return coursSemestre
      .map((c) => {
        const { plan, faites } = parCours.get(c.id_cours) ?? { plan: 0, faites: 0 }
        const m = mat.get(c.id_matiere)!
        const g = c.id_groupe !== null ? grp.get(c.id_groupe) ?? null : null
        const e = c.id_enseignant !== null ? ens.get(c.id_enseignant) : undefined
        return { c, m, public: publicCours(cla.get(c.id_classe)!, g), ens: nomEnseignant(e), plan, faites, reste: c.volume_horaire - plan }
      })
      .sort((a, b) => (tri === 'ecart' ? b.reste - a.reste : a.m.libelle.localeCompare(b.m.libelle)))
  }, [db.matiere, db.classe, db.groupe, db.enseignant, cours, coursSemestre, today, tri])
  const LIGNES_VISIBLES = 40

  // Semaine courante
  const semaine = enrichir(db, actives.filter((s) => s.date_seance >= lundi && s.date_seance <= addDays(lundi, 6)))
  const heuresGrille = db.creneau.length // créneaux de 1 h disponibles par semaine
  const salles = db.salle
    .map((s) => ({ s, h: semaine.filter((x) => x.id_salle === s.id_salle).reduce((a, x) => a + x.duree, 0) }))
    .sort((a, b) => b.h - a.h)
  const occupation = salles.reduce((a, x) => a + x.h, 0) / (db.salle.length * heuresGrille)
  const charges = db.enseignant
    .map((e) => ({ e, h: semaine.filter((x) => x.enseignant?.id_enseignant === e.id_enseignant).reduce((a, x) => a + x.duree, 0) }))
    .sort((a, b) => b.h - a.h)

  return (
    <div className="grid grid-cols-1 gap-6 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:gap-3">
      <PageTitle visible eyebrow={`${semestre.libelle} · ${semestre.annee_academique}`} title="Tableau de bord">
        <Link to="/admin/generation" className="press inline-flex h-10 items-center gap-2 rounded-full border border-line bg-white/80 px-4 text-sm font-medium hover:bg-white [&_svg]:size-4"><Sparkles />Générer</Link>
        <Link to="/admin/planification" className="press inline-flex h-12 items-center gap-2 rounded-full bg-orange px-6 text-sm font-medium text-navy shadow-sm hover:brightness-105 [&_svg]:size-4"><CalendarRange />Planifier</Link>
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 xl:shrink-0 xl:grid-cols-4 xl:gap-3">
        <Stat icon={<CalendarRange />} label="Séances planifiées" value={String(actives.length)} sub={`${seances.length - actives.length} annulée(s)`} />
        <Stat icon={<Clock />} label="Heures planifiées" value={`${Math.round((planifiees / prevues) * 100)} %`} sub={`${planifiees} h sur ${prevues} h prévues`} tone="orange" />
        <Stat icon={<DoorOpen />} label="Occupation des salles" value={`${Math.round(occupation * 100)} %`} sub={`Semaine ${isoWeek(lundi)} · ${db.salle.length} salles`} />
        <Stat
          icon={violations ? <AlertTriangle /> : <CheckCircle2 />}
          label="Contraintes dures"
          value={violations ? String(violations) : '0'}
          sub={violations ? 'séance(s) en infraction' : 'aucune violation (CD-01 à CD-13)'}
          tone={violations ? 'danger' : 'success'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:gap-3">
        <Card className="p-5 sm:p-6 xl:flex xl:min-h-0 xl:flex-col xl:p-4" data-section="volumes">
          <SectionTitle
            eyebrow="BF-23"
            title="Volume horaire par cours"
            action={<PillTabs size="sm" value={tri} onChange={setTri} items={[{ value: 'ecart', label: 'Reste à planifier' }, { value: 'matiere', label: 'Matière' }]} />}
          />
          <div className="mt-4 overflow-x-auto scroll-thin xl:mt-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto" data-defile>
            <table className="w-full min-w-[36rem] text-sm">
              {/* en-tête fixe pendant que les lignes défilent */}
              <thead className="xl:sticky xl:top-0 xl:z-10 xl:bg-white">
                <tr className="text-left text-xs text-ink-2">
                  <th className="pb-2 font-medium">Cours</th>
                  <th className="pb-2 font-medium">Public</th>
                  <th className="w-[32%] pb-2 font-medium">Planifié / prévu</th>
                  <th className="pb-2 text-right font-medium">Effectué</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {(toutesLesLignes || unBloc ? lignes : lignes.slice(0, LIGNES_VISIBLES)).map((l) => (
                  <tr key={l.c.id_cours}>
                    <td className="py-2.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurType(l.c.type_cours) }} />
                        <span className="font-medium">{l.m.libelle}</span>
                        <Badge>{l.c.type_cours}</Badge>
                      </span>
                      <span className="text-xs text-ink-2">{l.ens}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-ink-2">{l.public}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <Meter value={l.plan} max={l.c.volume_horaire} tone={l.plan >= l.c.volume_horaire ? 'navy' : 'orange'} label={`${l.m.libelle} planifié`} />
                        <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums">{l.plan}/{l.c.volume_horaire} h</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono text-xs text-ink-2 tabular-nums">{l.faites} h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!unBloc && lignes.length > LIGNES_VISIBLES && (
            <button type="button" className="press mt-3 rounded-full px-3 py-1.5 text-sm font-medium text-navy hover:bg-muted" onClick={() => setToutesLesLignes((x) => !x)}>
              {toutesLesLignes ? 'Afficher moins' : `Afficher les ${lignes.length - LIGNES_VISIBLES} autres cours`}
            </button>
          )}
        </Card>

        {/* Grand écran : les deux sections se partagent la hauteur et défilent */}
        <div className="grid grid-cols-1 content-start gap-6 xl:flex xl:min-h-0 xl:flex-col xl:gap-3">
          <Card className={SECTION} data-section="salles">
            <SectionTitle eyebrow={`Semaine ${isoWeek(lundi)} · ${fmtJourMois(lundi)}`} title="Occupation des salles" />
            <ul className={LISTE} data-defile>
              {(unBloc ? salles : salles.slice(0, 7)).map(({ s, h }) => (
                <li key={s.id_salle} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 text-sm">
                  <span className="truncate">{s.nom_salle}</span>
                  <Meter value={h} max={heuresGrille} label={`Occupation ${s.nom_salle}`} />
                  <span className="text-right font-mono text-xs text-ink-2 tabular-nums">{h} h</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className={SECTION} data-section="enseignants">
            <SectionTitle eyebrow={`Semaine ${isoWeek(lundi)}`} title="Charge des enseignants" />
            <ul className={LISTE} data-defile>
              {charges.map(({ e, h }) => {
                const max = e.nb_heures_max_semaine ?? 20
                return (
                  <li key={e.id_enseignant} className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem] items-center gap-3 text-sm">
                    <span className="truncate">{nomEnseignant(e)}</span>
                    <Meter value={h} max={max} tone={h > max ? 'danger' : 'navy'} label={`Charge ${e.nom}`} />
                    <span className={cn('text-right font-mono text-xs tabular-nums', h > max ? 'text-red-700' : 'text-ink-2')}>{h}/{max} h</span>
                  </li>
                )
              })}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
