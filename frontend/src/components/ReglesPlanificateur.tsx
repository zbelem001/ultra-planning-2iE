// Règles du planificateur (moteur v3 de Soraya Pitroipa) : saisies comme des données, sans
// toucher au code, et respectées par le solveur à chaque génération. Ce sont des lignes de
// CONTRAINTE avec des paramètres (type_contrainte 'interdire', 'precede' ou 'plafond_jour').

import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Card, cn, Field, Input, PillTabs, SectionTitle, Select, Switch } from '@/components/ui'
import { libelleCours, nomEnseignant } from '@/lib/queries'
import { nextId, useStore } from '@/lib/store'
import { fmtJourMois } from '@/lib/time'
import type { Contrainte, EmploiDuTemps, Jour, ParametresRegle } from '@/types/db'

const JOURS: Jour[] = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']
type TypeRegle = 'interdire' | 'precede' | 'plafond_jour'
type Cible = 'id_classe' | 'id_enseignant' | 'id_cours'
const TYPES: Record<TypeRegle, string> = { interdire: 'Interdire', precede: 'Ordre des matières', plafond_jour: 'Plafond par jour' }

export function ReglesPlanificateur({ edt }: { edt: EmploiDuTemps }) {
  const { db, mutate } = useStore()
  const regles = db.contrainte.filter((c) => c.id_edt === edt.id_edt && c.parametres)
  const [type, setType] = useState<TypeRegle>('interdire')
  const [cible, setCible] = useState<Cible>('id_classe')
  const [idCible, setIdCible] = useState('')
  const [jours, setJours] = useState<Jour[]>([])
  const [demi, setDemi] = useState<'' | '0' | '1'>('')
  const [du, setDu] = useState('')
  const [au, setAu] = useState('')
  const [avant, setAvant] = useState('')
  const [apres, setApres] = useState('')
  const [heures, setHeures] = useState('6')
  const [stricte, setStricte] = useState(true)

  const nomCible = (p: ParametresRegle) => {
    const c = p.cible ?? {}
    if (c.id_classe) return db.classe.find((x) => x.id_classe === c.id_classe)?.code_classe ?? 'classe'
    if (c.id_enseignant) return nomEnseignant(db.enseignant.find((x) => x.id_enseignant === c.id_enseignant))
    if (c.id_cours) { const k = db.cours.find((x) => x.id_cours === c.id_cours); return k ? libelleCours(db, k) : 'cours' }
    return 'tous'
  }
  const matiere = (id?: number) => db.matiere.find((m) => m.id_matiere === id)?.libelle ?? '?'

  const options = cible === 'id_classe'
    ? db.classe.map((c) => ({ value: c.id_classe, label: c.code_classe }))
    : cible === 'id_enseignant'
      ? db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom.toUpperCase()} ${e.prenom}` }))
      : db.cours.filter((c) => c.id_semestre === edt.id_semestre).map((c) => ({ value: c.id_cours, label: libelleCours(db, c) }))

  const ajouter = () => {
    let parametres: ParametresRegle
    let libelle: string
    let nature: Contrainte['nature'] = 'dure'
    let poids = 0
    if (type === 'interdire') {
      if (!idCible) return void toast.error('Choisissez la cible de la règle.')
      if (du && au && au < du) return void toast.error('La fin de la période précède son début.')
      parametres = { cible: { [cible]: Number(idCible) }, ...(jours.length ? { jours } : {}), ...(demi ? { demi: Number(demi) as 0 | 1 } : {}) }
      const quand = [jours.length ? jours.map((j) => j.toLowerCase()).join(', ') : 'tous les jours', demi === '0' ? 'matin' : demi === '1' ? 'après-midi' : ''].filter(Boolean).join(' ')
      libelle = `${nomCible(parametres)} : pas de cours ${quand}`
    } else if (type === 'precede') {
      if (!avant || !apres || avant === apres) return void toast.error('Choisissez deux matières différentes.')
      parametres = { matiere_avant: Number(avant), matiere_apres: Number(apres) }
      libelle = `${matiere(Number(avant))} finie avant le début de ${matiere(Number(apres))}`
    } else {
      const h = Number(heures)
      if (!(h >= 2 && h <= 12)) return void toast.error('Un plafond entre 2 et 12 h par jour.')
      parametres = { cible: { tous: true }, heures: h }
      nature = stricte ? 'dure' : 'souple'
      poids = stricte ? 0 : 2
      libelle = `${h} h par jour au plus${stricte ? '' : ' (de préférence)'}`
    }
    mutate((x) => {
      x.contrainte.push({
        id_contrainte: nextId(x.contrainte, 'id_contrainte'), libelle, type_contrainte: type, nature, poids, valeur: null,
        est_active: true, id_edt: edt.id_edt, parametres, date_debut: type === 'interdire' && du ? du : null,
        date_fin: type === 'interdire' && au ? au : null,
      })
    })
    toast.success('Règle ajoutée', { description: 'Le solveur la respectera à la prochaine génération.' })
    setIdCible('')
    setJours([])
  }

  const basculerJour = (j: Jour) => setJours((l) => (l.includes(j) ? l.filter((x) => x !== j) : [...l, j]))

  return (
    <Card className="p-5">
      <SectionTitle eyebrow="Saisies sans toucher au code" title="Règles du planificateur" />
      {regles.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">Aucune règle. Exemples : pas de cours le mercredi après-midi pour une classe, une matière finie avant une autre, 6 h par jour au plus.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {regles.map((r) => (
            <li key={r.id_contrainte} className={cn('flex items-start justify-between gap-3', !r.est_active && 'opacity-50')}>
              <div className="min-w-0">
                <p className="font-medium">{r.libelle}</p>
                <p className="mt-0.5 flex flex-wrap gap-1.5 text-xs text-ink-2">
                  <Badge>{TYPES[r.type_contrainte as TypeRegle] ?? r.type_contrainte}</Badge>
                  {r.nature === 'souple' && <Badge tone="neutral">préférence</Badge>}
                  {(r.date_debut || r.date_fin) && <span>{r.date_debut ? `du ${fmtJourMois(r.date_debut)} ` : ''}{r.date_fin ? `au ${fmtJourMois(r.date_fin)}` : ''}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch checked={r.est_active} label={`Activer « ${r.libelle} »`}
                  onChange={(v) => mutate((x) => { x.contrainte.find((c) => c.id_contrainte === r.id_contrainte)!.est_active = v })} />
                <Button variant="ghost" size="icon-sm" aria-label="Supprimer la règle"
                  onClick={() => mutate((x) => { x.contrainte = x.contrainte.filter((c) => c.id_contrainte !== r.id_contrainte) })}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3 border-t border-line/70 pt-4">
        <PillTabs size="sm" value={type} onChange={setType} label="Type de règle"
          items={(Object.keys(TYPES) as TypeRegle[]).map((t) => ({ value: t, label: TYPES[t] }))} />
        {type === 'interdire' && (
          <>
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
              <Select aria-label="Cible" value={cible} onChange={(e) => { setCible(e.target.value as Cible); setIdCible('') }}>
                <option value="id_classe">Classe</option>
                <option value="id_enseignant">Enseignant</option>
                <option value="id_cours">Cours</option>
              </Select>
              <Select aria-label="Cible de la règle" value={idCible} onChange={(e) => setIdCible(e.target.value)}>
                <option value="">Choisir…</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {JOURS.map((j) => (
                <button key={j} type="button" onClick={() => basculerJour(j)}
                  className={cn('press rounded-full px-3 py-1 text-xs ring-1', jours.includes(j) ? 'bg-navy text-white ring-navy' : 'bg-white ring-line')}>
                  {j.slice(0, 3)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Select aria-label="Demi-journée" value={demi} onChange={(e) => setDemi(e.target.value as '' | '0' | '1')}>
                <option value="">Toute la journée</option>
                <option value="0">Matin</option>
                <option value="1">Après-midi</option>
              </Select>
              <Input type="date" aria-label="Du" value={du} onChange={(e) => setDu(e.target.value)} />
              <Input type="date" aria-label="Au" value={au} onChange={(e) => setAu(e.target.value)} />
            </div>
            <p className="text-xs text-ink-2">Aucun jour choisi : tous les jours. Sans dates : tout le semestre.</p>
          </>
        )}
        {type === 'precede' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Cette matière finie…">
              <Select value={avant} onChange={(e) => setAvant(e.target.value)}>
                <option value="">Choisir…</option>
                {db.matiere.map((m) => <option key={m.id_matiere} value={m.id_matiere}>{m.libelle}</option>)}
              </Select>
            </Field>
            <Field label="…avant le début de">
              <Select value={apres} onChange={(e) => setApres(e.target.value)}>
                <option value="">Choisir…</option>
                {db.matiere.map((m) => <option key={m.id_matiere} value={m.id_matiere}>{m.libelle}</option>)}
              </Select>
            </Field>
          </div>
        )}
        {type === 'plafond_jour' && (
          <div className="flex flex-wrap items-center gap-3">
            <Input type="number" min={2} max={12} className="w-24" aria-label="Heures par jour" value={heures} onChange={(e) => setHeures(e.target.value)} />
            <span className="text-sm">h par jour, pour chaque classe et chaque enseignant</span>
            <Switch checked={stricte} onChange={setStricte} label="Plafond strict" />
            <span className="text-xs text-ink-2">{stricte ? 'strict' : 'de préférence'}</span>
          </div>
        )}
        <Button variant="outline" onClick={ajouter} className="justify-self-start"><Plus />Ajouter la règle</Button>
      </div>
    </Card>
  )
}
