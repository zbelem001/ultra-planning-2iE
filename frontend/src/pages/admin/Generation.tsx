// Génération automatique (BF-15 à BF-18).
// - Mode connecté : le moteur OR-Tools CP-SAT tourne côté serveur (POST /api/generations),
//   on suit la tâche puis on applique le résultat, revalidé par la base.
// - Mode simulé : générateur glouton de démonstration, dans le navigateur.

import { AlertTriangle, CheckCircle2, Loader2, Lock, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, PageTitle, PillTabs, SectionTitle, Select, Switch } from '@/components/ui'
import { joursGrille, WeekGrid } from '@/components/timetable/WeekGrid'
import { appliquerGeneration, etatGeneration, lancerGeneration, type TacheGeneration } from '@/lib/api'
import { expandWeek, generateWeek, type ResultatGeneration } from '@/lib/generator'
import { enrichir, libelleCours } from '@/lib/queries'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { addDays, fmtJourMois, isoWeek, jourOf, mondayOf, todayIso, weeksBetween } from '@/lib/time'
import type { Db, Seance } from '@/types/db'

const ETAPES = ['Chargement du référentiel', 'Contraintes dures', 'Optimisation des contraintes souples', 'Déroulé sur le semestre']
const ETAPES_SERVEUR = ['Demande envoyée au serveur', 'Calcul CP-SAT : plan hebdomadaire puis placement des séances']

/** Séances calculées par le serveur, au format de la base (identifiants provisoires négatifs) */
function seancesServeur(db: Db, t: TacheGeneration, id_edt: number): Seance[] {
  return (t.seances ?? []).map((s, i) => ({
    ...s,
    id_seance: -1 - i,
    statut: 'planifiee',
    est_verrouillee: false,
    id_edt,
    id_creneau: db.creneau.find((c) => c.jour === jourOf(s.date_seance) && c.heure_debut === s.heure_debut)?.id_creneau ?? 0,
  }))
}

/** Paramètre numérique d'une contrainte (ex. N de CD-13, plafond de CS-06) */
function ValeurContrainte({ valeur, unite, disabled, onChange }: { valeur: number; unite: string; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className="mt-2 ml-5.5 flex items-center gap-2 text-xs text-ink-2">
      <input
        type="number"
        min={1}
        max={20}
        value={valeur}
        disabled={disabled}
        onChange={(e) => e.target.value && onChange(Number(e.target.value))}
        className="h-8 w-16 rounded-full border border-line bg-white/80 px-3 text-center font-mono text-sm text-ink tabular-nums outline-none focus:ring-2 focus:ring-navy/70 disabled:opacity-50"
      />
      {unite}
    </label>
  )
}

export default function Generation() {
  const { db, mutate, connecte, recharger } = useStore()
  const edt = edtTravail(db)
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const weeks = useMemo(() => weeksBetween(semestre.date_debut, semestre.date_fin), [semestre])
  const lecture = edt.statut === 'publie' || edt.statut === 'archive'
  const contraintes = db.contrainte.filter((c) => c.id_edt === edt.id_edt)

  const [depart, setDepart] = useState(() => {
    const next = addDays(mondayOf(todayIso()), 7)
    return weeks.includes(next) ? next : weeks[0]
  })
  const [garderVerrou, setGarderVerrou] = useState(true)
  const [etape, setEtape] = useState(-1)
  const [resultat, setResultat] = useState<(ResultatGeneration & { depart: string }) | null>(null)
  const [apercu, setApercu] = useState<number>(db.classe[1]?.id_classe ?? db.classe[0].id_classe)
  const [perimetre, setPerimetre] = useState('')
  const [duree, setDuree] = useState(0) // semaines ; 0 = jusqu'à la fin du semestre
  const [tache, setTache] = useState<TacheGeneration | null>(null)
  const [semaineApercu, setSemaineApercu] = useState('')
  const [application, setApplication] = useState(false)

  const setContrainte = (id: number, patch: { poids?: number; est_active?: boolean; valeur?: number | null }) =>
    mutate((x) => Object.assign(x.contrainte.find((c) => c.id_contrainte === id)!, patch))

  const lancerServeur = async () => {
    setTache(null)
    setEtape(0)
    try {
      let t = await lancerGeneration({
        id_edt: edt.id_edt,
        filieres: perimetre ? [perimetre] : [],
        classes: [],
        du: depart,
        au: duree ? addDays(depart, 7 * duree - 2) : semestre.date_fin,
        minimiser_changements: false,
        garder_verrouillees: garderVerrou,
      })
      while (t.statut === 'en_attente' || t.statut === 'en_cours') {
        setEtape(t.statut === 'en_cours' ? 1 : 0)
        await new Promise((r) => setTimeout(r, 1000))
        t = await etatGeneration(t.id)
      }
      if (t.statut === 'erreur') toast.error('La génération a échoué', { description: t.erreur ?? undefined })
      else {
        setTache(t)
        setSemaineApercu(depart)
      }
    } catch (e) {
      toast.error('Génération impossible', { description: (e as Error).message })
    } finally {
      setEtape(-1)
    }
  }

  const appliquerServeur = async () => {
    if (!tache) return
    setApplication(true)
    try {
      const r = await appliquerGeneration(tache.id)
      toast.success('Emploi du temps généré', {
        description: `${r.seances_enregistrees} séances enregistrées (${tache.seances_remplacees ?? 0} remplacées), validées par la base.`,
      })
      setTache(null)
    } catch (e) {
      toast.error('Application refusée', { description: (e as Error).message })
    } finally {
      setApplication(false)
      await recharger()
    }
  }

  const lancer = () => {
    if (connecte) return void lancerServeur()
    setResultat(null)
    setEtape(0)
    ETAPES.forEach((_, i) => setTimeout(() => setEtape(i + 1), 450 * (i + 1)))
    setTimeout(() => {
      const r = generateWeek(db, edt.id_edt, depart, { keepLocked: garderVerrou })
      setResultat({ ...r, depart })
      setEtape(-1)
    }, 450 * ETAPES.length + 200)
  }

  const appliquer = () => {
    if (connecte) return void appliquerServeur()
    if (!resultat) return
    const garder = db.seance.filter((s) => s.id_edt !== edt.id_edt || s.date_seance < resultat.depart || (garderVerrou && s.est_verrouillee))
    const autres = garder.filter((s) => s.id_edt !== edt.id_edt)
    const memeEdt = garder.filter((s) => s.id_edt === edt.id_edt)
    const nouvelles = resultat.semaine.filter((s) => s.id_seance < 0)
    const res = expandWeek(db, nouvelles, edt.id_edt, resultat.depart, memeEdt, nextId(db.seance, 'id_seance'))
    mutate((x) => {
      x.seance = [...autres, ...res]
      const e = x.emploi_du_temps.find((k) => k.id_edt === edt.id_edt)!
      e.mode_generation = 'automatique'
    })
    toast.success('Emploi du temps généré', { description: `${res.length - memeEdt.length} séances créées à partir de la semaine ${isoWeek(resultat.depart)}.` })
    setResultat(null)
  }

  // Vue commune du résultat : semaine type (simulé) ou période complète en heures (serveur)
  const st = tache?.statistiques
  const vue = connecte
    ? tache && st && {
        titre: `${st.semaines} semaine(s) à partir de la semaine ${isoWeek(depart)}`,
        placees: st.heures_placees,
        total: st.heures_demandees,
        unite: ' h',
        seances: seancesServeur(db, tache, edt.id_edt),
        semaine: semaineApercu,
        nonPlaces: (tache.non_places ?? []).map((n) => ({ cle: String(n.id_cours), id_cours: n.id_cours, detail: `${n.heures} h`, code: n.code, raison: n.raison })),
      }
    : resultat && {
        titre: `Semaine type · semaine ${isoWeek(resultat.depart)}`,
        placees: resultat.semaine.length,
        total: resultat.semaine.length + resultat.nonPlaces.length,
        unite: '',
        seances: resultat.semaine,
        semaine: resultat.depart,
        nonPlaces: resultat.nonPlaces.map((n) => ({ cle: `${n.id_cours}-${n.rang}`, id_cours: n.id_cours, detail: `séance ${n.rang} (${n.duree_heures} h)`, code: n.code, raison: n.raison })),
      }
  const taux = vue && vue.total ? Math.round((vue.placees / vue.total) * 100) : 0
  const finSemaine = vue ? addDays(vue.semaine, 6) : ''
  const apercuSeances = vue
    ? enrichir(db, vue.seances.filter((s) => s.date_seance >= vue.semaine && s.date_seance < finSemaine)).filter((s) => s.classe.id_classe === apercu)
    : []
  const semainesResultat = vue ? weeks.filter((w) => vue.seances.some((s) => s.date_seance >= w && s.date_seance < addDays(w, 6))) : []
  const etapes = connecte ? ETAPES_SERVEUR : ETAPES

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle eyebrow={`Version ${edt.version} · mode ${edt.mode_generation}`} title="Génération automatique" />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[24rem_minmax(0,1fr)]">
        <div className="grid h-fit grid-cols-1 gap-6">
          <Card className="p-5">
            <SectionTitle eyebrow="BF-16" title="Contraintes souples" />
            <ul className="mt-4 space-y-4">
              {contraintes.filter((c) => c.nature === 'souple').map((c) => (
                <li key={c.id_contrainte}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium"><span className="font-mono text-xs text-ink-2">{c.type_contrainte}</span> {c.libelle}</p>
                    </div>
                    <Switch checked={c.est_active} onChange={(v) => setContrainte(c.id_contrainte, { est_active: v })} label={`Activer ${c.type_contrainte}`} disabled={lecture} />
                  </div>
                  <div className={cn('mt-2 flex items-center gap-3', !c.est_active && 'opacity-40')}>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      value={c.poids}
                      disabled={!c.est_active || lecture}
                      onChange={(e) => setContrainte(c.id_contrainte, { poids: Number(e.target.value) })}
                      className="h-2 w-full cursor-pointer accent-[#03254C]"
                      aria-label={`Poids de ${c.type_contrainte}`}
                    />
                    <span className="w-6 text-right font-mono text-sm tabular-nums">{c.poids}</span>
                  </div>
                  {c.valeur !== null && (
                    <ValeurContrainte valeur={c.valeur} unite="h par jour" disabled={!c.est_active || lecture} onChange={(v) => setContrainte(c.id_contrainte, { valeur: v })} />
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <SectionTitle eyebrow="Toujours respectées" title="Contraintes dures" />
            <ul className="mt-3 space-y-1.5 text-sm">
              {contraintes.filter((c) => c.nature === 'dure').map((c) => (
                <li key={c.id_contrainte}>
                  <div className="flex items-center gap-2">
                    <Lock className="size-3.5 shrink-0 text-navy" />
                    <span className="font-mono text-xs whitespace-nowrap text-ink-2">{c.type_contrainte}</span>
                    <span className="truncate">{c.libelle}</span>
                  </div>
                  {c.valeur !== null && (
                    <ValeurContrainte valeur={c.valeur} unite="matières par semaine" disabled={lecture} onChange={(v) => setContrainte(c.id_contrainte, { valeur: v })} />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="grid h-fit grid-cols-1 gap-6">
          <Card className="p-5 sm:p-6">
            <SectionTitle eyebrow="BF-15 · BF-17" title="Lancer une génération" />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="pl-1 text-sm font-medium">Générer à partir de</span>
                <Select value={depart} onChange={(e) => setDepart(e.target.value)} disabled={lecture}>
                  {weeks.map((w) => <option key={w} value={w}>Semaine {isoWeek(w)} · {fmtJourMois(w)}</option>)}
                </Select>
                <span className="pl-1 text-xs text-ink-2">Les semaines précédentes ne sont pas modifiées.</span>
              </label>
              {connecte && (
                <label className="flex flex-col gap-1.5">
                  <span className="pl-1 text-sm font-medium">Périmètre</span>
                  <Select value={perimetre} onChange={(e) => setPerimetre(e.target.value)} disabled={lecture}>
                    <option value="">Tout l'établissement</option>
                    {db.filiere.map((f) => <option key={f.id_filiere} value={f.code_filiere}>{f.code_filiere} · {f.libelle}</option>)}
                  </Select>
                </label>
              )}
              {connecte && (
                <label className="flex flex-col gap-1.5">
                  <span className="pl-1 text-sm font-medium">Période</span>
                  <Select value={String(duree)} onChange={(e) => setDuree(Number(e.target.value))} disabled={lecture}>
                    <option value="0">Jusqu'à la fin du semestre ({fmtJourMois(semestre.date_fin)})</option>
                    <option value="1">Cette semaine seulement</option>
                    <option value="2">Deux semaines</option>
                  </Select>
                  <span className="pl-1 text-xs text-ink-2">Sur une période courte, chaque cours reçoit sa part du volume restant ; le reste est reporté.</span>
                </label>
              )}
              <div className="flex items-center justify-between gap-3 rounded-3xl bg-white/70 px-4 py-3 ring-1 ring-white">
                <div>
                  <p className="text-sm font-medium">Garder les séances verrouillées</p>
                  <p className="text-xs text-ink-2">{db.seance.filter((s) => s.id_edt === edt.id_edt && s.est_verrouillee && s.date_seance >= depart).length} séances verrouillées à partir de cette semaine</p>
                </div>
                <Switch checked={garderVerrou} onChange={setGarderVerrou} label="Garder les séances verrouillées" disabled={lecture} />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="accent" size="lg" onClick={lancer} disabled={etape >= 0 || lecture}>
                {etape >= 0 ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {etape >= 0 ? 'Génération en cours…' : 'Lancer la génération'}
              </Button>
              {lecture && <span className="text-sm text-ink-2">Version publiée : créez un brouillon pour générer.</span>}
            </div>

            {etape >= 0 && (
              <ol className="mt-5 space-y-2">
                {etapes.map((e, i) => (
                  <li key={e} className="flex items-center gap-2 text-sm">
                    {i < etape ? <CheckCircle2 className="size-4 text-[#15803D]" /> : i === etape ? <Loader2 className="size-4 animate-spin text-navy" /> : <span className="size-4 rounded-full border border-line" />}
                    <span className={i <= etape ? 'text-ink' : 'text-ink-2'}>{e}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {vue && (
            <Card className="rise p-5 sm:p-6">
              <SectionTitle
                eyebrow={vue.titre}
                title="Résultat"
                action={<Button onClick={appliquer} disabled={application}>{application ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}Appliquer à la version {edt.version}</Button>}
              />
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-3xl bg-white/70 p-4 ring-1 ring-white">
                  <p className="section-label">{connecte ? 'Heures placées' : 'Séances placées'}</p>
                  <p className="mt-1 text-3xl font-semibold tabular-nums">{vue.placees}<span className="text-lg font-light text-ink-2"> / {vue.total}{vue.unite}</span></p>
                </div>
                <div className="rounded-3xl bg-white/70 p-4 ring-1 ring-white">
                  <p className="section-label">Taux de placement</p>
                  <p className={cn('mt-1 text-3xl font-semibold tabular-nums', taux < 95 && 'text-[#9A5B0B]')}>{taux} %</p>
                  <p className="text-xs text-ink-2">Objectif de recette : 95 %</p>
                </div>
                <div className="rounded-3xl bg-white/70 p-4 ring-1 ring-white">
                  {st ? (
                    <>
                      <p className="section-label">Calcul</p>
                      <p className="mt-1 text-3xl font-semibold tabular-nums">{st.duree_s.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s</p>
                      <p className="text-xs text-ink-2">
                        {tache?.seances?.length} séances · {tache?.seances_remplacees} remplacées
                        {st.heures_reportees ? ` · ${st.heures_reportees} h reportées après la période` : ''}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="section-label">Score souple</p>
                      <p className="mt-1 text-3xl font-semibold tabular-nums">{resultat?.score}</p>
                      <p className="text-xs text-ink-2">Plus haut = meilleur</p>
                    </>
                  )}
                </div>
              </div>

              {vue.nonPlaces.length > 0 && (
                <div className="mt-5 rounded-3xl bg-highlight p-4">
                  <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-[#9A5B0B]" />Séances non placées (BF-18)</p>
                  <ul className="mt-2 space-y-2 text-sm">
                    {vue.nonPlaces.map((n) => {
                      const c = db.cours.find((x) => x.id_cours === n.id_cours)
                      return (
                        <li key={n.cle}>
                          <span className="font-medium">{c ? libelleCours(db, c) : `Cours ${n.id_cours}`}</span> · {n.detail} <Badge tone="warning">{n.code}</Badge>
                          <p className="text-ink-2">{n.raison}</p>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}

              <div className="mt-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <p className="section-label">Aperçu par classe</p>
                    {connecte && (
                      <Select value={semaineApercu} onChange={(e) => setSemaineApercu(e.target.value)} aria-label="Semaine affichée">
                        {semainesResultat.map((w) => <option key={w} value={w}>Semaine {isoWeek(w)} · {fmtJourMois(w)}</option>)}
                      </Select>
                    )}
                  </div>
                  <PillTabs size="sm" value={String(apercu)} onChange={(v) => setApercu(Number(v))} items={db.classe.map((c) => ({ value: String(c.id_classe), label: c.code_classe }))} />
                </div>
                <WeekGrid db={db} days={joursGrille(db, vue.semaine)} seances={apercuSeances} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
