import { Field, Input } from '@/components/ui'
import type { EcoleSaisie } from '@/lib/api'

export const ECOLE_VIDE: EcoleSaisie = { code_ecole: '', nom: '', ville: '', pays: '', email_contact: '' }

/** Champs d'une école ; le code n'est saisi qu'à la création */
export function FormulaireEcole({ valeur, onChange, creation }: { valeur: EcoleSaisie; onChange: (v: EcoleSaisie) => void; creation?: boolean }) {
  const champ = (k: keyof EcoleSaisie) => ({
    value: valeur[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...valeur, [k]: e.target.value }),
  })
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {creation && (
        <Field label="Code" hint="2 à 12 caractères : lettres, chiffres, tirets. Ne change plus ensuite.">
          <Input required maxLength={12} placeholder="2IE" className="uppercase" {...champ('code_ecole')} />
        </Field>
      )}
      <Field label="Nom de l'école" className={creation ? '' : 'sm:col-span-2'}>
        <Input required placeholder="Institut International d'Ingénierie…" {...champ('nom')} />
      </Field>
      <Field label="Ville"><Input placeholder="Ouagadougou" {...champ('ville')} /></Field>
      <Field label="Pays"><Input placeholder="Burkina Faso" {...champ('pays')} /></Field>
      <Field label="E-mail de contact" className="sm:col-span-2">
        <Input type="email" placeholder="scolarite@ecole.org" {...champ('email_contact')} />
      </Field>
    </div>
  )
}

/** Champs vides envoyés comme null */
export const nettoyer = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v])) as T
