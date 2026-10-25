// Disponibilités des enseignants par créneau de la grille de base (BF-09),
// et absences datées (mission, congé...). Sans ligne en base, un créneau vaut
// « disponible ». Les deux alimentent CD-06.

import { AlertTriangle, Ban, CalendarOff, Check, Plane, Plus, Star, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Combobox, Input, PageTitle } from '@/components/ui'
import { enrichir, nomEnseignant } from '@/lib/queries'
import { horsSejour } from '@/lib/rules'
import { edtTravail, nextId, useStore } from '@/lib/store'
import { fmtHeure, fmtJourCourt, fmtJourMois, jourOf, JOURS, toMin } from '@/lib/time'
import type { NiveauDispo } from '@/types/db'

const NIVEAUX: Record<NiveauDispo, { label: string; icon: ReactNode; cell: string }> = {
  disponible: { label: 'Disponible', icon: <Check />, cell: 'bg-white/80 text-ink-2' },
  preference: { label: 'Préférence', icon: <Star />, cell: 'bg-[#DCFCE7] text-[#166534]' },
  indisponible: { label: 'Indisponible', icon: <Ban />, cell: 'hatched bg-[#FEE2E2] text-[#991B1B]' },
}

export default function Disponibilites() {
  const { db, mutate } = useStore()
  const [id, setId] = useState<number | null>(db.enseignant[0]?.id_enseignant ?? null)
  const [pinceau, setPinceau] = useState<NiveauDispo>('indisponible')
  const [motif, setMotif] = useState('')
  const [peinture, setPeinture] = useState(false)
  const [abs, setAbs] = useState({ debut: '', fin: '', motif: '' })
  const [sej, setSej] = useState({ debut: '', fin: '', commentaire: '' })

  useEffect(() => {
    const stop = () => setPeinture(false)
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [])

  const ens = db.enseignant.find((e) => e.id_enseignant === id)
  const jours = JOURS.filter((j) => db.creneau.some((c) => c.jour === j))
  const heures = [...new Set(db.creneau.map((c) => c.heure_debut))].sort()
  const niveau = (id_creneau: number): NiveauDispo =>
    db.disponibilite.find((d) => d.id_enseignant === id && d.id_creneau === id_creneau)?.niveau ?? 'disponible'
  const motifDe = (id_creneau: number) => db.disponibilite.find((d) => d.id_enseignant === id && d.id_creneau === id_creneau)?.motif

  const appliquer = (id_creneau: number) => {
    if (id === null || niveau(id_creneau) === pinceau && (motifDe(id_creneau) ?? '') === (pinceau === 'indisponible' ? motif : '')) return
    mutate((x) => {
      x.disponibilite = x.disponibilite.filter((d) => !(d.id_enseignant === id && d.id_creneau === id_creneau))
      if (pinceau !== 'disponible') {
        x.disponibilite.push({ id_enseignant: id, id_creneau, niveau: pinceau, motif: pinceau === 'indisponible' && motif ? motif : null })
      }
    })
  }

  const absences = db.absence_enseignant.filter((a) => a.id_enseignant === id).sort((a, b) => a.date_debut.localeCompare(b.date_debut))
  const ajouterAbsence = () => {
    if (id === null) return
    if (!abs.debut || !abs.fin) return toast.error('Indiquez les dates de début et de fin.')
    if (abs.fin < abs.debut) return toast.error('La date de fin doit suivre la date de début.')
    mutate((x) => {
      x.absence_enseignant.push({ id_absence: nextId(x.absence_enseignant, 'id_absence'), id_enseignant: id, date_debut: abs.debut, date_fin: abs.fin, motif: abs.motif.trim() || null })
    })
    setAbs({ debut: '', fin: '', motif: '' })
    toast.success('Absence enregistrée')
  }

  const sejours = db.sejour_enseignant.filter((j) => j.id_enseignant === id).sort((a, b) => a.date_debut.localeCompare(b.date_debut))
  const ajouterSejour = () => {
    if (id === null) return
    if (!sej.debut || !sej.fin) return toast.error("Indiquez les dates d'arrivée et de départ.")
    if (sej.fin < sej.debut) return toast.error("La date de départ doit suivre la date d'arrivée.")
    mutate((x) => {
      x.sejour_enseignant.push({ id_sejour: nextId(x.sejour_enseignant, 'id_sejour'), id_enseignant: id, date_debut: sej.debut, date_fin: sej.fin, commentaire: sej.commentaire.trim() || null })
    })
    setSej({ debut: '', fin: '', commentaire: '' })
    toast.success('Séjour enregistré')
  }

  // Séances déjà planifiées sur un créneau indisponible, pendant une absence ou hors séjour (CD-06)
  const edt = edtTravail(db)
  const conflits = useMemo(() => {
    if (id === null) return []
    const ind = db.disponibilite.filter((d) => d.id_enseignant === id && d.niveau === 'indisponible')
    const abs = db.absence_enseignant.filter((a) => a.id_enseignant === id)
    const list = enrichir(db, db.seance.filter((s) => s.id_edt === edt.id_edt && s.statut !== 'annulee'))
      .filter((s) => s.enseignant.id_enseignant === id)
      .filter(
        (s) =>
          horsSejour(db, id, s.date_seance) ||
          abs.some((a) => s.date_seance >= a.date_debut && s.date_seance <= a.date_fin) ||
          ind.some((d) => {
            const c = db.creneau.find((k) => k.id_creneau === d.id_creneau)!
            return c.jour === jourOf(s.date_seance) && toMin(c.heure_debut) < toMin(s.heure_fin) && toMin(c.heure_fin) > toMin(s.heure_debut)
          }),
      )
    return list.sort((a, b) => a.date_seance.localeCompare(b.date_seance))
  }, [db, id, edt.id_edt])

  const nb = (n: NiveauDispo) => db.creneau.filter((c) => niveau(c.id_creneau) === n).length

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle eyebrow="BF-09 · contraintes CD-06 et CS-01" title="Disponibilités" />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit p-5">
          <p className="section-label mb-2">Enseignant</p>
          <Combobox
            ariaLabel="Enseignant"
            placeholder="Rechercher un enseignant…"
            value={id}
            onChange={setId}
            options={db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom.toUpperCase()} ${e.prenom}`, hint: `${e.matricule} · ${e.grade}` }))}
          />
          {ens && (
            <div className="mt-4 rounded-2xl bg-white/70 p-4 text-sm ring-1 ring-white">
              <p className="font-medium">{nomEnseignant(ens)}</p>
              <p className="text-ink-2">{ens.grade} · {ens.nb_heures_max_semaine ?? '–'} h max / semaine</p>
              <p className="mt-1 text-xs text-ink-2">
                {ens.statut === 'externe' ? 'Intervenant externe : enseigne pendant ses séjours, cours ramassés' : ens.statut === 'vacataire_local' ? 'Vacataire local : selon ses disponibilités' : 'Permanent : cours enchaînés'}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge tone="success" dot>{nb('preference')} préférés</Badge>
                <Badge tone="danger" dot>{nb('indisponible')} indisponibles</Badge>
              </div>
            </div>
          )}

          <p className="section-label mt-6 mb-2">Pinceau</p>
          <div role="radiogroup" aria-label="Pinceau" className="grid grid-cols-3 gap-1 rounded-3xl bg-white/70 p-1 ring-1 ring-white">
            {(Object.keys(NIVEAUX) as NiveauDispo[]).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={pinceau === n}
                onClick={() => setPinceau(n)}
                className={cn('press flex flex-col items-center gap-1 rounded-[1.25rem] px-2 py-2 text-xs font-medium [&_svg]:size-4', pinceau === n ? 'bg-navy text-white' : 'text-ink-2 hover:bg-muted')}
              >
                {NIVEAUX[n].icon}
                {NIVEAUX[n].label}
              </button>
            ))}
          </div>
          {pinceau === 'indisponible' && (
            <Input className="mt-3" placeholder="Motif (facultatif)" value={motif} onChange={(e) => setMotif(e.target.value)} aria-label="Motif de l'indisponibilité" />
          )}
          <p className="mt-3 text-xs text-ink-2">Cliquez ou faites glisser sur la grille pour appliquer. Sans déclaration, un créneau est disponible.</p>

          {ens?.statut === 'externe' && (
            <>
              <p className="section-label mt-6 mb-2 flex items-center gap-1.5"><Plane className="size-3.5" />Séjours sur le campus</p>
              {sejours.length === 0 ? (
                <p className="rounded-2xl bg-orange-soft/60 px-3 py-2 text-sm text-[#7C4A03]">Aucun séjour prévu : aucune séance ne peut être programmée.</p>
              ) : (
                <ul className="space-y-1.5">
                  {sejours.map((j) => (
                    <li key={j.id_sejour} className="flex items-center gap-2 rounded-2xl bg-[#DCFCE7]/60 py-2 pr-1.5 pl-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{fmtJourMois(j.date_debut)} → {fmtJourMois(j.date_fin)}</p>
                        {j.commentaire && <p className="truncate text-xs text-ink-2">{j.commentaire}</p>}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Supprimer le séjour"
                        onClick={() => { mutate((x) => { x.sejour_enseignant = x.sejour_enseignant.filter((k) => k.id_sejour !== j.id_sejour) }); toast.success('Séjour supprimé') }}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-ink-2">Arrivée<Input type="date" value={sej.debut} onChange={(e) => setSej({ ...sej, debut: e.target.value, fin: sej.fin || e.target.value })} /></label>
                <label className="flex flex-col gap-1 text-xs text-ink-2">Départ<Input type="date" value={sej.fin} min={sej.debut || undefined} onChange={(e) => setSej({ ...sej, fin: e.target.value })} /></label>
              </div>
              <Input className="mt-2" placeholder="Commentaire (facultatif)" value={sej.commentaire} onChange={(e) => setSej({ ...sej, commentaire: e.target.value })} aria-label="Commentaire du séjour" />
              <Button variant="outline" className="mt-2 w-full" onClick={ajouterSejour}><Plus />Ajouter le séjour</Button>
            </>
          )}

          <p className="section-label mt-6 mb-2 flex items-center gap-1.5"><CalendarOff className="size-3.5" />Absences datées</p>
          {absences.length === 0 ? (
            <p className="text-sm text-ink-2">Aucune absence déclarée.</p>
          ) : (
            <ul className="space-y-1.5">
              {absences.map((a) => (
                <li key={a.id_absence} className="flex items-center gap-2 rounded-2xl bg-[#FEE2E2]/50 py-2 pr-1.5 pl-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{a.date_debut === a.date_fin ? fmtJourMois(a.date_debut) : `${fmtJourMois(a.date_debut)} → ${fmtJourMois(a.date_fin)}`}</p>
                    {a.motif && <p className="truncate text-xs text-ink-2">{a.motif}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Supprimer l'absence"
                    onClick={() => { mutate((x) => { x.absence_enseignant = x.absence_enseignant.filter((k) => k.id_absence !== a.id_absence) }); toast.success('Absence supprimée') }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-ink-2">Du<Input type="date" value={abs.debut} onChange={(e) => setAbs({ ...abs, debut: e.target.value, fin: abs.fin || e.target.value })} disabled={id === null} /></label>
            <label className="flex flex-col gap-1 text-xs text-ink-2">Au (inclus)<Input type="date" value={abs.fin} min={abs.debut || undefined} onChange={(e) => setAbs({ ...abs, fin: e.target.value })} disabled={id === null} /></label>
          </div>
          <Input className="mt-2" placeholder="Motif (mission, congé...)" value={abs.motif} onChange={(e) => setAbs({ ...abs, motif: e.target.value })} aria-label="Motif de l'absence" disabled={id === null} />
          <Button variant="outline" className="mt-2 w-full" onClick={ajouterAbsence} disabled={id === null}><Plus />Ajouter l'absence</Button>
        </Card>

        <div className="grid grid-cols-1 gap-6">
          <Card className="p-4 sm:p-5">
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full min-w-[34rem] table-fixed border-separate border-spacing-1 select-none" onPointerLeave={() => setPeinture(false)}>
                <thead>
                  <tr>
                    <th className="w-14" />
                    {jours.map((j) => <th key={j} className="pb-1 text-sm font-medium">{j}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {heures.map((h) => (
                    <tr key={h}>
                      <td className="pr-1 text-right font-mono text-xs text-ink-2 tabular-nums">{fmtHeure(h)}</td>
                      {jours.map((j) => {
                        const c = db.creneau.find((k) => k.jour === j && k.heure_debut === h)
                        if (!c) return <td key={j} className="hatched rounded-xl" />
                        const n = niveau(c.id_creneau)
                        const m = motifDe(c.id_creneau)
                        return (
                          <td key={j} className="p-0">
                            <button
                              type="button"
                              disabled={id === null}
                              aria-label={`${j} ${fmtHeure(h)} : ${NIVEAUX[n].label}${m ? `, ${m}` : ''}`}
                              title={m ?? NIVEAUX[n].label}
                              onPointerDown={(e) => { e.preventDefault(); setPeinture(true); appliquer(c.id_creneau) }}
                              onPointerEnter={() => peinture && appliquer(c.id_creneau)}
                              className={cn('flex h-11 w-full items-center justify-center gap-1 rounded-xl text-xs font-medium ring-1 ring-white transition-colors [&_svg]:size-3.5', NIVEAUX[n].cell)}
                            >
                              {n !== 'disponible' && NIVEAUX[n].icon}
                              <span className="hidden truncate sm:inline">{n === 'indisponible' ? m ?? 'Indispo.' : n === 'preference' ? 'Préféré' : ''}</span>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {conflits.length > 0 && (
            <Card className="border-[#FEE2E2] p-5">
              <p className="flex items-center gap-2 font-medium text-[#991B1B]"><AlertTriangle className="size-4" />{conflits.length} séance(s) planifiée(s) sur un créneau indisponible, pendant une absence ou hors séjour</p>
              <p className="mt-1 text-sm text-ink-2">La base refusera ces séances (CD-06) : déplacez-les dans Planification ou relancez la génération.</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {conflits.slice(0, 12).map((s) => (
                  <li key={s.id_seance}><Badge tone="danger">{fmtJourCourt(s.date_seance)} · {fmtHeure(s.heure_debut)} · {s.matiere.libelle}</Badge></li>
                ))}
                {conflits.length > 12 && <li><Badge>+{conflits.length - 12}</Badge></li>}
              </ul>
              <button type="button" className="mt-3 text-sm text-navy underline-offset-2 hover:underline" onClick={() => toast.info('Ouvrez Planification > Enseignant pour déplacer ces séances.')}>
                Comment corriger ?
              </button>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
