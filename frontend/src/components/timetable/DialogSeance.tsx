// Programmer une séance de cours à partir des heures choisies sur la grille : le cours, l'enseignant et une
// salle libre. Les mêmes règles que celles de la base sont vérifiées avant de créer la séance.

import { CalendarPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button, Dialog, Field, Input, Select } from '@/components/ui'
import { estEpreuve } from '@/lib/publics'
import { heuresPlanifiees, libelleCours, nomEnseignant } from '@/lib/queries'
import { checkSeance, creneauAt, REGLES_SALLE, sallesDuCours, type SeanceDraft } from '@/lib/rules'
import { nextId, useStore } from '@/lib/store'
import { addDays, fmtHeure, fmtJourCourt, jourOf, mondayOf, toMin } from '@/lib/time'
import type { Cours, EmploiDuTemps, Seance } from '@/types/db'
import { finsPossibles } from './WeekGrid'

const DUREES_SEANCE = [120, 180, 240, 300] // minutes : une séance dure de 2 à 5 h

export interface DepartSeance {
  date: string
  heure_debut: string
  heure_fin: string
  /** Cours proposés : ceux de la classe ou de l'enseignant affiché */
  cours: Cours[]
  id_salle: number | null
}

export function DialogSeance({ edt, depart, onFermer, onCreee }: {
  edt: EmploiDuTemps
  depart: DepartSeance
  onFermer: () => void
  onCreee: (date: string) => void
}) {
  const { db, mutate } = useStore()
  const semestre = db.semestre.find((s) => s.id_semestre === edt.id_semestre)!
  const reste = (c: Cours) => c.volume_horaire - heuresPlanifiees(db, edt.id_edt, c.id_cours)
  const [idCours, setIdCours] = useState<number | null>(() => (depart.cours.find((c) => reste(c) >= 2) ?? depart.cours[0])?.id_cours ?? null)
  // undefined : l'enseignant prévu du cours ; null : à désigner
  const [idEnseignant, setIdEnseignant] = useState<number | null | undefined>(undefined)
  const [idSalle, setIdSalle] = useState<number | null>(depart.id_salle)
  const [date, setDate] = useState(depart.date)
  const [debutChoisi, setDebut] = useState(depart.heure_debut)
  const [finChoisie, setFin] = useState(depart.heure_fin)

  // Heures possibles ce jour-là : 2 à 5 h de créneaux consécutifs ; une fin trop tardive est ramenée
  const jour = jourOf(date)
  const finsDe = (h: string) => finsPossibles(db, date, h, DUREES_SEANCE)
  const debuts = db.creneau.filter((c) => c.jour === jour).map((c) => c.heure_debut).sort().filter((h) => finsDe(h).length > 0)
  const debut = debuts.includes(debutChoisi) ? debutChoisi : debuts[0]
  const fins = debut ? finsDe(debut) : []
  const fin = fins.includes(finChoisie) ? finChoisie : [...fins].reverse().find((f) => toMin(f) <= toMin(finChoisie)) ?? fins[0]

  const cours = depart.cours.find((c) => c.id_cours === idCours) ?? null
  const enseignant = idEnseignant === undefined ? cours?.id_enseignant ?? null : idEnseignant
  const creneau = debut ? creneauAt(db, date, debut) : undefined
  const brouillon: SeanceDraft | null = cours && creneau && fin ? {
    date_seance: date, heure_debut: debut, heure_fin: fin, statut: 'planifiee', est_verrouillee: false, id_cours: cours.id_cours,
    id_enseignant: enseignant, id_salle: 0, id_creneau: creneau.id_creneau, id_edt: edt.id_edt, nature: 'cours',
  } : null

  // Ce qui compte pour les règles : la semaine (classe, enseignant, salles, rythme), le cours (volume), les épreuves
  const seances = useMemo(() => {
    const lundi = mondayOf(date)
    const dimanche = addDays(lundi, 6)
    return db.seance.filter((s) => s.id_edt === edt.id_edt
      && (s.id_cours === cours?.id_cours || estEpreuve(s) || (s.date_seance >= lundi && s.date_seance <= dimanche)))
  }, [db, edt.id_edt, date, cours?.id_cours])
  const candidates = useMemo(() => (cours ? sallesDuCours(db, cours) : []), [db, cours])
  const libres = useMemo(
    () => (brouillon
      ? candidates.filter((s) => !checkSeance(db, { ...brouillon, id_salle: s.id_salle }, seances).some((v) => REGLES_SALLE.has(v.code)))
      : []),
    [db, seances, candidates, brouillon?.id_cours, brouillon?.id_enseignant, date, debut, fin], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const salle = libres.find((s) => s.id_salle === idSalle) ?? libres[0]
  // Règles qui ne dépendent pas de la salle : classe, enseignant, volume, rythme, matières de la semaine...
  const motifs = useMemo(() => {
    const essai = salle ?? candidates[0]
    if (!brouillon || !essai) return []
    return checkSeance(db, { ...brouillon, id_salle: essai.id_salle }, seances).filter((v) => !REGLES_SALLE.has(v.code))
  }, [db, seances, salle, candidates, brouillon?.id_cours, brouillon?.id_enseignant, date, debut, fin]) // eslint-disable-line react-hooks/exhaustive-deps

  const possible = !!brouillon && !!salle && motifs.length === 0

  const programmer = () => {
    if (!brouillon || !salle) return
    mutate((x) => { x.seance.push({ ...brouillon, id_salle: salle.id_salle, id_seance: nextId(x.seance, 'id_seance') } as Seance) })
    toast.success('Séance créée', {
      description: `${fmtJourCourt(date)} · ${fmtHeure(debut)}–${fmtHeure(fin)} · ${salle.nom_salle}. Visible par les invités après publication.`,
    })
    onCreee(date)
  }

  const enseignants = [...db.enseignant].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))

  return (
    <Dialog
      open
      onClose={onFermer}
      title="Programmer une séance de cours"
      description="Choisissez le cours : l'enseignant prévu et la plus petite salle libre qui convient sont proposés."
      footer={
        <>
          <Button variant="ghost" onClick={onFermer}>Annuler</Button>
          <Button variant="primary" disabled={!possible} onClick={programmer}><CalendarPlus />Programmer</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field
          label="Cours"
          hint={cours ? `${heuresPlanifiees(db, edt.id_edt, cours.id_cours)} h planifiées sur ${cours.volume_horaire} h` : depart.cours.length ? undefined : 'Aucun cours à programmer pour cette sélection.'}
        >
          <Select value={idCours ?? ''} disabled={!depart.cours.length} onChange={(e) => { setIdCours(Number(e.target.value)); setIdEnseignant(undefined) }}>
            {depart.cours.map((c) => {
              const r = reste(c)
              return <option key={c.id_cours} value={c.id_cours}>{libelleCours(db, c)} · {r > 0 ? `${r} h restantes` : 'volume atteint'}</option>
            })}
          </Select>
        </Field>
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
          <Field label="Enseignant">
            <Select aria-label="Enseignant" value={enseignant ?? ''} onChange={(e) => setIdEnseignant(e.target.value ? Number(e.target.value) : null)}>
              <option value="">À désigner</option>
              {enseignants.map((e) => (
                <option key={e.id_enseignant} value={e.id_enseignant}>
                  {nomEnseignant(e)}{e.id_enseignant === cours?.id_enseignant ? ' (prévu)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Salle" hint={cours && !candidates.length ? 'Aucune salle ne convient à ce cours (type, capacité, campus).' : undefined}>
            <Select aria-label="Salle" value={salle?.id_salle ?? ''} disabled={!libres.length} onChange={(e) => setIdSalle(Number(e.target.value))}>
              {libres.map((s) => <option key={s.id_salle} value={s.id_salle}>{s.nom_salle} · {s.capacite} places</option>)}
            </Select>
          </Field>
        </div>
        {!jour && <p className="rounded-2xl bg-highlight px-3 py-2 text-sm text-[#7C4A03]">Pas de cours le dimanche.</p>}
        {jour && !debuts.length && <p className="rounded-2xl bg-highlight px-3 py-2 text-sm text-[#7C4A03]">Aucune plage de 2 h ce jour-là.</p>}
        {motifs.map((v, i) => <p key={i} className="rounded-2xl bg-[#FEE2E2] px-3 py-2 text-sm text-[#991B1B]">{v.code} : {v.message}</p>)}
        {brouillon && !motifs.length && candidates.length > 0 && !libres.length && (
          <p className="rounded-2xl bg-[#FEE2E2] px-3 py-2 text-sm text-[#991B1B]">Aucune salle qui convient n'est libre sur cette plage.</p>
        )}
      </div>
    </Dialog>
  )
}
