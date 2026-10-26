// Référentiel (BF-01 à BF-08, BF-25, BF-26) : une page générique pilotée par config.tsx.

import { Download, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { NavLink, Navigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button, Card, cn, Dialog, Field, Input, PageTitle, Select, Switch } from '@/components/ui'
import { download } from '@/lib/ics'
import { decoupage } from '@/lib/rules'
import { nextId, useStore } from '@/lib/store'
import type { Db } from '@/types/db'
import { ComptesEcole } from './ComptesEcole'
import { TABLES, type FieldDef, type Row, type TableDef } from './config'

type FormValues = Record<string, string | boolean>

function toForm(def: TableDef, db: Db, r: Row | null): FormValues {
  const v: FormValues = {}
  for (const f of def.fields) {
    if (f.type === 'decoupage') {
      const rows = r ? db.cours_seance_modele.filter((m) => m.id_cours === r.id_cours) : []
      v[f.key] = rows.length && r ? decoupage(db, r.id_cours).map((m) => m.duree_heures).join('+') : ''
    } else if (f.type === 'bool') v[f.key] = r ? Boolean(r[f.key]) : true
    else v[f.key] = r ? (r[f.key] == null ? '' : String(r[f.key])) : f.defaut ?? ''
  }
  return v
}

/** Comparaison souple (fichiers de la scolarité) : sans accents, majuscules ni ponctuation */
const normaliser = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Colonne d'un fichier importé -> champ : nom technique (code_classe), libellé (« Code »),
 *  ou nom sans « id_ » pour une référence (« Classe » pour id_classe) */
function champDeColonne(def: TableDef, entete: string): FieldDef | undefined {
  const n = normaliser(entete.replace(/\*$/, ''))
  const champs = def.fields.filter((f) => f.type !== 'decoupage')
  return champs.find((f) => normaliser(f.key) === n)
    ?? champs.find((f) => normaliser(f.label) === n)
    ?? champs.find((f) => f.key.startsWith('id_') && normaliser(f.key.slice(3)) === n)
}

function parseValue(f: FieldDef, raw: string | boolean, db: Db): unknown {
  if (f.type === 'bool') return typeof raw === 'boolean' ? raw : ['1', 'true', 'oui', 'vrai'].includes(String(raw).toLowerCase())
  const s = String(raw).trim()
  if (s === '') return null
  if (f.type === 'number') return Number(s.replace(',', '.'))
  if (f.type === 'select') {
    // Valeur exacte, libellé complet (« L2INFO · Licence 2… »), ou l'une de ses parties (« L2INFO »)
    const n = normaliser(s)
    const options = f.options!(db)
    const o = options.find((x) => String(x.value) === s || x.label === s)
      ?? options.find((x) => normaliser(x.label) === n)
      ?? options.find((x) => x.label.split(' · ').some((partie) => normaliser(partie) === n))
    return o ? (o.value === '' ? null : o.value) : s
  }
  return s
}

function parseDecoupage(s: string): number[] | string {
  if (!s.trim()) return []
  const parts = s.split('+').map((x) => Number(x.trim().replace(',', '.')))
  if (parts.some((x) => Number.isNaN(x) || x < 2 || x > 4)) return 'Chaque séance du découpage dure entre 2 et 4 h.'
  return parts
}

/** Construit la ligne typée et renvoie la première erreur rencontrée */
function build(def: TableDef, db: Db, values: FormValues, current: Row | null): { row?: Row; decoupe?: number[]; error?: string } {
  const row: Row = current ? { ...current } : {}
  let decoupe: number[] | undefined
  for (const f of def.fields) {
    if (f.type === 'decoupage') {
      const d = parseDecoupage(String(values[f.key] ?? ''))
      if (typeof d === 'string') return { error: d }
      decoupe = d
      continue
    }
    if (current && f.createOnly) continue
    const v = parseValue(f, values[f.key] ?? '', db)
    if (f.required && (v === null || v === '')) return { error: `« ${f.label} » est obligatoire.` }
    if (f.type === 'number' && v !== null) {
      if (Number.isNaN(v)) return { error: `« ${f.label} » doit être un nombre.` }
      if (f.min !== undefined && (v as number) < f.min) return { error: `« ${f.label} » doit être au moins ${f.min}.` }
      if (f.max !== undefined && (v as number) > f.max) return { error: `« ${f.label} » doit être au plus ${f.max}.` }
    }
    if (f.type === 'select' && v !== null && !f.options!(db).some((o) => o.value === v)) return { error: `Valeur inconnue pour « ${f.label} » : ${v}` }
    if (f.unique && v !== null) {
      const rows = db[def.table] as unknown as Row[]
      if (rows.some((x) => x[f.key] === v && (!current || x[def.pk] !== current[def.pk]))) return { error: `« ${f.label} » doit être unique : ${v} existe déjà.` }
    }
    row[f.key] = v
  }
  const err = def.validate?.(row, db)
  if (err) return { error: err }
  return { row, decoupe }
}

function parseCsv(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  const sep = lines[0]?.includes(';') ? ';' : ','
  return lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')))
}

export default function Referentiel() {
  const { table = 'classes' } = useParams()
  const def = TABLES.find((t) => t.id === table)
  const { db, mutate, connecte } = useStore()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<{ row: Row | null } | null>(null)
  const [values, setValues] = useState<FormValues>({})
  const [error, setError] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<Row | null>(null)
  const [rapport, setRapport] = useState<{ crees: number; majs: number; erreurs: string[]; ignorees: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const rows = useMemo(() => {
    if (!def) return []
    const list = db[def.table] as unknown as Row[]
    const n = q.trim().toLowerCase()
    return n ? list.filter((r) => def.search(r, db).toLowerCase().includes(n)) : list
  }, [db, def, q])

  if (!def) return <Navigate to="/admin/referentiel/classes" replace />

  const open = (row: Row | null) => {
    setEdit({ row })
    setValues(toForm(def, db, row))
    setError(null)
  }

  const save = () => {
    const current = edit?.row ?? null
    const { row, decoupe, error: err } = build(def, db, values, current)
    if (err || !row) return setError(err ?? 'Erreur')
    mutate((x) => {
      const list = x[def.table] as unknown as Row[]
      if (current) Object.assign(list.find((r) => r[def.pk] === current[def.pk])!, row)
      else {
        if (def.table === 'cours') Object.assign(row, { priorite_suggeree: null, justification_priorite: null })
        if (def.identity) row[def.pk] = nextId(list, def.pk)
        list.push(row)
      }
      if (decoupe) {
        const id = row.id_cours as number
        x.cours_seance_modele = x.cours_seance_modele.filter((m) => m.id_cours !== id)
        decoupe.forEach((d, i) => x.cours_seance_modele.push({ id_cours: id, rang: i + 1, duree_heures: d }))
      }
    })
    toast.success(current ? `${def.singulier[0].toUpperCase()}${def.singulier.slice(1)} modifié(e)` : `${def.singulier[0].toUpperCase()}${def.singulier.slice(1)} ajouté(e)`)
    setEdit(null)
  }

  const remove = (r: Row) => {
    const motif = def.restrict?.(r, db)
    if (motif) {
      toast.error('Suppression refusée (ON DELETE RESTRICT)', { description: motif })
      return setConfirmDel(null)
    }
    mutate((x) => {
      def.cascade?.(r, x)
      ;(x[def.table] as unknown as Row[]).splice((x[def.table] as unknown as Row[]).findIndex((k) => k[def.pk] === r[def.pk]), 1)
    })
    setConfirmDel(null)
    toast.success('Ligne supprimée')
  }

  // Import CSV : en-têtes souples ; une ligne déjà présente (même clé, config.cle) est mise à
  // jour avec les cellules remplies, les autres sont créées. Mêmes contrôles qu'à la saisie.
  const importer = async (file: File) => {
    const [head, ...lines] = parseCsv(await file.text())
    if (!head) return setRapport({ crees: 0, majs: 0, erreurs: ['Fichier vide'], ignorees: [] })
    const colonnes = head.map((h) => champDeColonne(def, h))
    const ignorees = head.filter((_, j) => !colonnes[j])
    const presents = new Set(colonnes.filter(Boolean).map((f) => f!.key))
    const cle = def.cle ?? def.fields.filter((f) => f.unique).slice(0, 1).map((f) => f.key)
    const parCle = cle.length > 0 && cle.every((k) => presents.has(k))
    const manquants = def.fields.filter((f) => f.required && f.type !== 'decoupage' && !presents.has(f.key)).map((f) => f.label)
    if (manquants.length && !parCle) {
      return setRapport({ crees: 0, majs: 0, erreurs: [`Colonnes obligatoires absentes : ${manquants.join(', ')}`], ignorees })
    }

    const erreurs: string[] = []
    const travail = structuredClone(db)
    const list = travail[def.table] as unknown as Row[]
    let crees = 0, majs = 0
    lines.forEach((cells, i) => {
      const lues: FormValues = {}
      colonnes.forEach((f, j) => { if (f && (cells[j] ?? '') !== '') lues[f.key] = cells[j] })
      const champsCle = cle.map((k) => def.fields.find((f) => f.key === k)!)
      const existante = parCle
        ? list.find((r) => champsCle.every((f) => {
          const v = parseValue(f, lues[f.key] ?? '', travail)
          // Codes et libellés : « tp-g1 » reconnaît « TP-G1 »
          return typeof v === 'string' && typeof r[f.key] === 'string' ? normaliser(v) === normaliser(r[f.key] as string) : r[f.key] === v
        }))
        : undefined
      // Mise à jour : les cellules vides et les champs de la clé gardent la valeur actuelle
      const valeurs = existante
        ? { ...toForm(def, travail, existante), ...Object.fromEntries(Object.entries(lues).filter(([k]) => !cle.includes(k))) }
        : lues
      const { row, error: err } = build(def, travail, valeurs, existante ?? null)
      if (err || !row) return erreurs.push(`Ligne ${i + 2} : ${err}`)
      if (existante) {
        Object.assign(existante, row)
        majs++
      } else {
        if (def.table === 'cours') Object.assign(row, { priorite_suggeree: null, justification_priorite: null })
        if (def.identity) row[def.pk] = nextId(list, def.pk)
        list.push(row)
        crees++
      }
    })
    if (crees + majs) mutate((x) => { Object.assign(x, { [def.table]: list }) })
    setRapport({ crees, majs, erreurs, ignorees })
  }

  const groupes = [...new Set(TABLES.map((t) => t.groupe))]
  // Mode connecté : les comptes se créent par invitation (Supabase Auth), pas par la table générique
  const comptes = connecte && def.id === 'utilisateurs'

  return (
    <div className="grid grid-cols-1 gap-6">
      <PageTitle visible eyebrow="Référentiel pédagogique et logistique" title={def.label}>
        {!comptes && <>
        <Button variant="outline" onClick={() => download(`gabarit-${def.id}.csv`, '\uFEFF' + def.fields.filter((f) => f.type !== 'decoupage').map((f) => f.label).join(';') + '\n', 'text/csv;charset=utf-8')}>
          <Download />Gabarit CSV
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload />Importer</Button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importer(f); e.target.value = '' }} />
        <Button onClick={() => open(null)}><Plus />Ajouter</Button>
        </>}
      </PageTitle>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label="Tables du référentiel" className="lg:sticky lg:top-4 lg:h-fit">
          <div className="flex gap-4 overflow-x-auto pb-1 lg:flex-col lg:gap-5 scroll-thin">
            {groupes.map((g) => (
              <div key={g} className="shrink-0">
                <p className="section-label mb-1.5 px-3">{g}</p>
                <ul className="flex gap-1 lg:flex-col">
                  {TABLES.filter((t) => t.groupe === g).map((t) => (
                    <li key={t.id}>
                      <NavLink
                        to={`/admin/referentiel/${t.id}`}
                        className={({ isActive }) => cn('press flex h-9 items-center justify-between gap-3 rounded-full px-3 text-sm whitespace-nowrap', isActive ? 'bg-navy text-white' : 'text-ink-2 hover:bg-white/70 hover:text-ink')}
                      >
                        {t.label}
                        <span className="font-mono text-[11px] tabular-nums opacity-70">{(db[t.table] as unknown[]).length}</span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        {comptes ? <ComptesEcole /> : <Card className="min-w-0 p-4 sm:p-5">
          <div className="relative mb-4 max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-2" />
            <Input className="pl-10" placeholder={`Rechercher (${rows.length})…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" />
          </div>
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2">
                  {def.columns.map((c) => <th key={c.label} className={cn('px-3 pb-2 font-medium', c.className)}>{c.label}</th>)}
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {rows.map((r) => (
                  <tr key={String(r[def.pk])} className="group hover:bg-white/60">
                    {def.columns.map((c) => <td key={c.label} className={cn('px-3 py-2.5', c.className)}>{c.render(r, db)}</td>)}
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon-sm" onClick={() => open(r)} aria-label="Modifier"><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setConfirmDel(r)} aria-label="Supprimer"><Trash2 /></Button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={def.columns.length + 1} className="px-3 py-10 text-center text-ink-2">Aucune ligne.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>}
      </div>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        wide={def.fields.length > 6}
        title={edit?.row ? `Modifier : ${def.singulier}` : `Ajouter : ${def.singulier}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>Annuler</Button>
            <Button onClick={save}>Enregistrer</Button>
          </>
        }
      >
        <form className={cn('grid gap-4', def.fields.length > 6 && 'sm:grid-cols-2')} onSubmit={(e) => { e.preventDefault(); save() }}>
          {def.fields.map((f) => {
            const v = values[f.key]
            const set = (nv: string | boolean) => setValues((p) => ({ ...p, [f.key]: nv }))
            const disabled = !!edit?.row && f.createOnly
            if (f.type === 'bool') {
              return (
                <label key={f.key} className="flex items-center justify-between gap-3 rounded-full bg-subtle px-4 py-3 sm:col-span-2">
                  <span className="text-sm font-medium">{f.label}</span>
                  <Switch checked={Boolean(v)} onChange={set} label={f.label} />
                </label>
              )
            }
            return (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint} className={f.type === 'decoupage' ? 'sm:col-span-2' : undefined}>
                {f.type === 'select' ? (
                  <Select value={String(v ?? '')} onChange={(e) => set(e.target.value)} disabled={disabled}>
                    {!f.required && !f.options!(db).some((o) => o.value === '') && <option value="">—</option>}
                    {f.required && v === '' && <option value="">Choisir…</option>}
                    {f.options!(db).map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                  </Select>
                ) : (
                  <Input
                    type={f.type === 'decoupage' ? 'text' : f.type}
                    value={String(v ?? '')}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    disabled={disabled}
                    placeholder={f.type === 'decoupage' ? '2+3' : undefined}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
              </Field>
            )
          })}
          {error && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B] sm:col-span-2">{error}</p>}
          <button type="submit" hidden />
        </form>
      </Dialog>

      <Dialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        title={`Supprimer ce(tte) ${def.singulier} ?`}
        description="Les lignes dépendantes en cascade seront aussi supprimées. Une ligne encore référencée ne peut pas l'être."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDel(null)}>Annuler</Button>
            <Button variant="destructive" onClick={() => confirmDel && remove(confirmDel)}><Trash2 />Supprimer</Button>
          </>
        }
      >
        {confirmDel && <p className="text-sm">{def.search(confirmDel, db)}</p>}
      </Dialog>

      <Dialog open={!!rapport} onClose={() => setRapport(null)} title="Rapport d'import" footer={<Button onClick={() => setRapport(null)}>Fermer</Button>}>
        {rapport && (
          <div className="space-y-3 text-sm">
            <p>
              <span className="font-semibold">{rapport.crees}</span> ligne(s) créée(s), <span className="font-semibold">{rapport.majs}</span> mise(s) à jour,{' '}
              <span className="font-semibold">{rapport.erreurs.length}</span> rejetée(s).
            </p>
            {rapport.ignorees.length > 0 && (
              <p className="rounded-3xl bg-highlight px-4 py-3">Colonnes non reconnues, ignorées : {rapport.ignorees.join(', ')}</p>
            )}
            {rapport.erreurs.length > 0 && (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-3xl bg-[#FEE2E2]/60 p-4 text-[#991B1B] scroll-thin">
                {rapport.erreurs.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}
