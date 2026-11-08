// Programmer un examen ou un rattrapage : tous ses détails, à partir des heures choisies sur la grille.
// Une épreuve n'a pas d'enseignant ; plusieurs classes peuvent composer dans une salle assez grande.

import { CalendarPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog, Field, Input, PillTabs, Select } from '@/components/ui'
import { effectifPublics, estEpreuve, LIBELLE_NATURE, publicsSeance } from '@/lib/publics'
import { checkSeance, coursDuModule, creneauAt, REGLES_SALLE, sallesPourEpreuves, type SeanceDraft } from '@/lib/rules'
import { nextId, useStore } from '@/lib/store'
import { fmtHeure, fmtJourCourt, jourOf, toMin } from '@/lib/time'
import type { EmploiDuTemps, Seance } from '@/types/db'
import { finsPossibles } from './WeekGrid'

export interface DepartEpreuve {
  nature: 'examen' | 'rattrapage'
  date: string
  heure_debut: string
  heure_fin: string
  id_classe: number | null
  id_salle: number | null
}

export function DialogEpreuve({ edt, depart, onFermer, onCreee }: {
  edt: EmploiDuTemps
  depart: DepartEpreuve
  onFermer: () => void
  onCreee: (date: string) => void
}) {
  const { db, mutate } = useStore()
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const [nature, setNature] = useState(depart.nature)
  const [idClasse, setIdClasse] = useState<number | null>(depart.id_classe)
  const [idMatiere, setIdMatiere] = useState<number | null>(null)
  const [idSite, setIdSite] = useState<number | null>(() => {
    if (depart.id_salle !== null) return db.salle.find((s) => s.id_salle === depart.id_salle)?.id_site ?? null
    return db.classe.find((c) => c.id_classe === depart.id_classe)?.id_site ?? null
  })
  const [idSalle, setIdSalle] = useState<number | null>(depart.id_salle)
  const [date, setDate] = useState(depart.date)
  const [debutChoisi, setDebut] = useState(depart.heure_debut)
  const [finChoisie, setFin] = useState(depart.heure_fin)

  // Heures possibles ce jour-là : 2 ou 3 h de créneaux consécutifs
  const jour = jourOf(date)
  const finsDe = (debut: string) => finsPossibles(db, date, debut, [120, 180])
  const debuts = db.creneau.filter((c) => c.jour === jour).map((c) => c.heure_debut).sort().filter((h) => finsDe(h).length > 0)
  const debut = debuts.includes(debutChoisi) ? debutChoisi : debuts[0]
  const fins = debut ? finsDe(debut) : []
  // Une épreuve dure 3 h au plus : une sélection plus longue est ramenée
  const fin = fins.includes(finChoisie) ? finChoisie : [...fins].reverse().find((f) => toMin(f) <= toMin(finChoisie)) ?? fins[0]

  const modules = useMemo(() => {
    const ids = new Set(db.cours.filter((c) => c.id_classe === idClasse && c.id_semestre === edt.id_semestre).map((c) => c.id_matiere))
    return db.matiere.filter((m) => ids.has(m.id_matiere)).sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'))
  }, [db, idClasse, edt.id_semestre])
  const matiere = modules.some((m) => m.id_matiere === idMatiere) ? idMatiere : modules[0]?.id_matiere ?? null
  const cours = idClasse !== null && matiere !== null ? coursDuModule(db, idClasse, matiere, edt.id_semestre) : undefined

  const creneau = debut ? creneauAt(db, date, debut) : undefined
  const brouillon: SeanceDraft | null = cours && creneau && fin ? {
    date_seance: date, heure_debut: debut, heure_fin: fin, statut: 'planifiee', est_verrouillee: false, id_cours: cours.id_cours,
    id_enseignant: null, id_salle: 0, id_creneau: creneau.id_creneau, id_edt: edt.id_edt, nature,
  } : null

  // Ce jour-là et les épreuves (ordre examen, rattrapage) : le reste ne compte pas pour une épreuve
  const seances = useMemo(
    () => db.seance.filter((s) => s.id_edt === edt.id_edt && (s.date_seance === date || estEpreuve(s))),
    [db, edt.id_edt, date],
  )
  const candidates = sallesPourEpreuves(db)
  const motifs = useMemo(() => {
    if (!brouillon || !candidates[0]) return []
    return checkSeance(db, { ...brouillon, id_salle: candidates[0].id_salle }, seances).filter((v) => !REGLES_SALLE.has(v.code))
  }, [db, seances, brouillon?.id_cours, date, debut, fin, nature]) // eslint-disable-line react-hooks/exhaustive-deps

  // Salles du campus qui peuvent accueillir la classe sur cette plage ; on retient la plus petite
  const libres = useMemo(() => {
    if (!brouillon) return []
    const d1 = toMin(brouillon.heure_debut)
    const d2 = toMin(brouillon.heure_fin)
    return candidates
      .filter((s) => idSite === null || s.id_site === idSite)
      .filter((s) => !checkSeance(db, { ...brouillon, id_salle: s.id_salle }, seances).some((v) => REGLES_SALLE.has(v.code)))
      .map((s) => {
        const avec = seances.filter((x) => x.id_salle === s.id_salle && x.date_seance === date && x.statut !== 'annulee' && estEpreuve(x)
          && d1 < toMin(x.heure_fin) && toMin(x.heure_debut) < d2)
        const classes = avec.map((x) => db.classe.find((c) => c.id_classe === db.cours.find((k) => k.id_cours === x.id_cours)?.id_classe)?.code_classe)
        const places = avec.reduce((n, x) => n + effectifPublics(db, publicsSeance(db, db.cours.find((k) => k.id_cours === x.id_cours)!, x)), 0)
        return { salle: s, partage: classes.length ? `avec ${classes.join(', ')}, ${s.capacite - places} places restantes` : '' }
      })
  }, [db, seances, brouillon?.id_cours, date, debut, fin, nature, idSite]) // eslint-disable-line react-hooks/exhaustive-deps
  const salle = libres.find((x) => x.salle.id_salle === idSalle)?.salle ?? libres[0]?.salle

  const effectif = cours ? effectifPublics(db, publicsSeance(db, cours, { nature })) : 0
  const examenDuModule = cours && db.seance
    .filter((s) => s.id_edt === edt.id_edt && s.nature === 'examen' && s.statut !== 'annulee')
    .find((s) => { const k = db.cours.find((x) => x.id_cours === s.id_cours); return k?.id_matiere === cours.id_matiere && k?.id_classe === cours.id_classe })

  const possible = !!brouillon && !!salle && motifs.length === 0

  const programmer = () => {
    if (!brouillon || !salle) return
    mutate((x) => { x.seance.push({ ...brouillon, id_salle: salle.id_salle, id_seance: nextId(x.seance, 'id_seance') } as Seance) })
    toast.success(`${LIBELLE_NATURE[nature]} programmé`, {
      description: `${fmtJourCourt(date)} · ${fmtHeure(debut)}–${fmtHeure(fin)} · ${salle.nom_salle}. Visible par les invités après publication.`,
    })
    onCreee(date)
  }

  return (
    <Dialog
      open
      onClose={onFermer}
      title="Programmer une épreuve"
      description="Toute la classe compose, sans enseignant. D'autres classes peuvent partager la salle si elle est assez grande."
      footer={
        <>
          <Button variant="ghost" onClick={onFermer}>Annuler</Button>
          <Button variant="primary" disabled={!possible} onClick={programmer}><CalendarPlus />Programmer</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <PillTabs
          size="sm"
          label="Type d'épreuve"
          value={nature}
          onChange={setNature}
          items={[{ value: 'examen', label: 'Examen' }, { value: 'rattrapage', label: 'Rattrapage' }]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Classe">
            <Select value={idClasse ?? ''} onChange={(e) => setIdClasse(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Choisir…</option>
              {db.classe.map((c) => <option key={c.id_classe} value={c.id_classe}>{c.code_classe}</option>)}
            </Select>
          </Field>
          <Field label="Cours (module)" hint={idClasse !== null && modules.length === 0 ? 'Aucun cours pour cette classe ce semestre.' : undefined}>
            <Select value={matiere ?? ''} disabled={modules.length === 0} onChange={(e) => setIdMatiere(Number(e.target.value))}>
              {modules.map((m) => <option key={m.id_matiere} value={m.id_matiere}>{m.libelle}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={date} min={semestre.date_debut} max={semestre.date_fin} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Début">
            <Select value={debut ?? ''} disabled={!debuts.length} onChange={(e) => setDebut(e.target.value)}>
              {debuts.map((h) => <option key={h} value={h}>{fmtHeure(h)}</option>)}
            </Select>
          </Field>
          <Field label="Fin">
            <Select value={fin ?? ''} disabled={!fins.length} onChange={(e) => setFin(e.target.value)}>
              {fins.map((h) => <option key={h} value={h}>{fmtHeure(h)} ({(toMin(h) - toMin(debut)) / 60} h)</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Campus">
            <Select value={idSite ?? ''} onChange={(e) => setIdSite(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Tous les campus</option>
              {db.site.map((s) => <option key={s.id_site} value={s.id_site}>{s.nom_site}</option>)}
            </Select>
          </Field>
          <Field label="Salle" hint={cours ? `${effectif} étudiants à accueillir` : undefined}>
            <Select aria-label="Salle" value={salle?.id_salle ?? ''} disabled={!libres.length} onChange={(e) => setIdSalle(Number(e.target.value))}>
              {libres.map(({ salle: s, partage }) => (
                <option key={s.id_salle} value={s.id_salle}>{s.nom_salle} · {s.capacite} places{partage && ` (${partage})`}</option>
              ))}
            </Select>
          </Field>
        </div>
        {nature === 'rattrapage' && cours && (
          <p className="text-xs text-ink-2">
            {examenDuModule
              ? `Examen de ce module : ${fmtJourCourt(examenDuModule.date_seance)}. Le rattrapage vient après.`
              : "Aucun examen programmé pour ce module : programmez-le d'abord."}
          </p>
        )}
        {!jour && <p className="rounded-2xl bg-highlight px-3 py-2 text-sm text-[#7C4A03]">Pas de cours le dimanche.</p>}
        {jour && !debuts.length && <p className="rounded-2xl bg-highlight px-3 py-2 text-sm text-[#7C4A03]">Aucune plage de 2 h ce jour-là.</p>}
        {motifs.map((v, i) => <p key={i} className="rounded-2xl bg-[#FEE2E2] px-3 py-2 text-sm text-[#991B1B]">{v.code} : {v.message}</p>)}
        {brouillon && !motifs.length && !libres.length && (
          <p className="rounded-2xl bg-[#FEE2E2] px-3 py-2 text-sm text-[#991B1B]">Aucune salle libre assez grande sur cette plage{idSite !== null ? ' sur ce campus' : ''}.</p>
        )}
      </div>
    </Dialog>
  )
}
