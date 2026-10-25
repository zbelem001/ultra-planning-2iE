// Tableau de bord : volumes horaires (BF-23), couverture du programme (CD-07),
// occupation des salles et charge des enseignants (BF-24).

import { AlertTriangle, CalendarRange, CheckCircle2, Clock, DoorOpen, Sparkles } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, cn, Meter, PageTitle, PillTabs, SectionTitle } from '@/components/ui'
import { couverture } from '@/lib/programme'
import { checkSeance } from '@/lib/rules'
import { couleurMatiere, enrichir, nomEnseignant, publicCours } from '@/lib/queries'
import { edtTravail, useStore } from '@/lib/store'
import { addDays, fmtJourMois, hours, isoWeek, mondayOf, todayIso } from '@/lib/time'

function Stat({ icon, label, value, sub, tone = 'navy' }: { icon: ReactNode; label: string; value: string; sub?: string; tone?: 'navy' | 'orange' | 'success' | 'danger' }) {
  const ring = { navy: 'bg-navy/10 text-navy', orange: 'bg-orange-soft text-[#7C4A03]', success: 'bg-[#DCFCE7] text-[#166534]', danger: 'bg-[#FEE2E2] text-[#991B1B]' }[tone]
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="section-label">{label}</p>
        <span className={cn('grid size-9 place-items-center rounded-full [&_svg]:size-4', ring)}>{icon}</span>
      </div>
      <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-sm text-ink-2">{sub}</p>}
    </Card>
  )
}

export default function Dashboard() {
  const { db } = useStore()
  const edt = edtTravail(db)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const seances = useMemo(() => db.seance.filter((s) => s.id_edt === edt.id_edt), [db, edt])
  const actives = seances.filter((s) => s.statut !== 'annulee')
  const today = todayIso()
  const lundi = mondayOf(today >= semestre.date_debut ? today : semestre.date_debut)
  const [tri, setTri] = useState<'ecart' | 'matiere'>('ecart')

  const coursSemestre = db.cours.filter((c) => c.id_semestre === semestre.id_semestre)
  const manques = couverture(db, semestre.id_semestre).filter((e) => e.couvert < e.prevu)
  const prevues = coursSemestre.reduce((a, c) => a + c.volume_horaire, 0)
  const planifiees = actives.reduce((a, s) => a + hours(s.heure_debut, s.heure_fin), 0)

  const violations = useMemo(() => actives.reduce((n, s) => n + (checkSeance(db, s).length ? 1 : 0), 0), [db, actives])

  const lignes = coursSemestre
    .map((c) => {
      const list = actives.filter((s) => s.id_cours === c.id_cours)
      const plan = list.reduce((a, s) => a + hours(s.heure_debut, s.heure_fin), 0)
      const faites = list.filter((s) => s.date_seance < today).reduce((a, s) => a + hours(s.heure_debut, s.heure_fin), 0)
      const m = db.matiere.find((x) => x.id_matiere === c.id_matiere)!
      const cl = db.classe.find((x) => x.id_classe === c.id_classe)!
      const g = db.groupe.find((x) => x.id_groupe === c.id_groupe) ?? null
      const e = db.enseignant.find((x) => x.id_enseignant === c.id_enseignant)!
      return { c, m, public: publicCours(cl, g), ens: nomEnseignant(e), plan, faites, reste: c.volume_horaire - plan }
    })
    .sort((a, b) => (tri === 'ecart' ? b.reste - a.reste : a.m.libelle.localeCompare(b.m.libelle)))

  // Semaine courante
  const semaine = enrichir(db, actives.filter((s) => s.date_seance >= lundi && s.date_seance <= addDays(lundi, 6)))
  const heuresGrille = db.creneau.length // créneaux de 1 h disponibles par semaine
  const salles = db.salle
    .map((s) => ({ s, h: semaine.filter((x) => x.id_salle === s.id_salle).reduce((a, x) => a + x.duree, 0) }))
    .sort((a, b) => b.h - a.h)
  const occupation = salles.reduce((a, x) => a + x.h, 0) / (db.salle.length * heuresGrille)
  const charges = db.enseignant
    .map((e) => ({ e, h: semaine.filter((x) => x.enseignant.id_enseignant === e.id_enseignant).reduce((a, x) => a + x.duree, 0) }))
    .sort((a, b) => b.h - a.h)

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle visible eyebrow={`${semestre.libelle} · ${semestre.annee_academique} · version ${edt.version}`} title="Tableau de bord">
        <Link to="/admin/generation" className="press inline-flex h-10 items-center gap-2 rounded-full border border-line bg-white/80 px-4 text-sm font-medium hover:bg-white [&_svg]:size-4"><Sparkles />Générer</Link>
        <Link to="/admin/planification" className="press inline-flex h-12 items-center gap-2 rounded-full bg-orange px-6 text-sm font-medium text-navy shadow-sm hover:brightness-105 [&_svg]:size-4"><CalendarRange />Planifier</Link>
      </PageTitle>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<CalendarRange />} label="Séances planifiées" value={String(actives.length)} sub={`${seances.length - actives.length} annulée(s)`} />
        <Stat icon={<Clock />} label="Heures planifiées" value={`${Math.round((planifiees / prevues) * 100)} %`} sub={`${planifiees} h sur ${prevues} h prévues`} tone="orange" />
        <Stat icon={<DoorOpen />} label="Occupation des salles" value={`${Math.round(occupation * 100)} %`} sub={`Semaine ${isoWeek(lundi)} · ${db.salle.length} salles`} />
        <Stat
          icon={violations ? <AlertTriangle /> : <CheckCircle2 />}
          label="Contraintes dures"
          value={violations ? String(violations) : '0'}
          sub={violations ? 'séance(s) en infraction' : 'aucune violation (CD-01 à CD-14)'}
          tone={violations ? 'danger' : 'success'}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="p-5 sm:p-6">
          <SectionTitle
            eyebrow="BF-23"
            title="Volume horaire par cours"
            action={<PillTabs size="sm" value={tri} onChange={setTri} items={[{ value: 'ecart', label: 'Reste à planifier' }, { value: 'matiere', label: 'Matière' }]} />}
          />
          <div className="mt-4 overflow-x-auto scroll-thin">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2">
                  <th className="pb-2 font-medium">Cours</th>
                  <th className="pb-2 font-medium">Public</th>
                  <th className="w-[32%] pb-2 font-medium">Planifié / prévu</th>
                  <th className="pb-2 text-right font-medium">Effectué</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {lignes.map((l) => (
                  <tr key={l.c.id_cours}>
                    <td className="py-2.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurMatiere(l.m.id_matiere) }} />
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
        </Card>

        <div className="grid grid-cols-1 content-start gap-6">
          <Card className="p-5 sm:p-6">
            <SectionTitle
              eyebrow="Programme · CD-07"
              title="Heures non couvertes"
              action={<Link to="/admin/referentiel/programme" className="text-sm text-navy underline-offset-2 hover:underline">Voir le programme</Link>}
            />
            {manques.length === 0 ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-[#166534]"><CheckCircle2 className="size-4" />Toutes les heures du programme ont un cours.</p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {manques.map((e) => {
                  const m = db.matiere.find((x) => x.id_matiere === e.id_matiere)!
                  return (
                    <li key={`${e.id_programme}-${e.type}-${e.public}`} className="grid grid-cols-[minmax(0,1fr)_7rem_3.5rem] items-center gap-3 text-sm">
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 truncate font-medium">
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: couleurMatiere(m.id_matiere) }} />
                          {m.libelle}
                          <Badge>{e.type}</Badge>
                        </span>
                        <span className="block truncate pl-4.5 text-xs text-ink-2">{e.public}</span>
                      </span>
                      <Meter value={e.couvert} max={e.prevu} tone="orange" label={`${m.libelle} ${e.type} ${e.public}`} />
                      <span className="text-right font-mono text-xs text-ink-2 tabular-nums">{e.couvert}/{e.prevu} h</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
          <Card className="p-5 sm:p-6">
            <SectionTitle eyebrow={`Semaine ${isoWeek(lundi)} · ${fmtJourMois(lundi)}`} title="Occupation des salles" />
            <ul className="mt-4 space-y-2.5">
              {salles.slice(0, 7).map(({ s, h }) => (
                <li key={s.id_salle} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 text-sm">
                  <span className="truncate">{s.nom_salle}</span>
                  <Meter value={h} max={heuresGrille} label={`Occupation ${s.nom_salle}`} />
                  <span className="text-right font-mono text-xs text-ink-2 tabular-nums">{h} h</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-5 sm:p-6">
            <SectionTitle eyebrow={`Semaine ${isoWeek(lundi)}`} title="Charge des enseignants" />
            <ul className="mt-4 space-y-2.5">
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
