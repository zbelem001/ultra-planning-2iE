import type { Jour } from '@/types/db'

export const JOURS: Jour[] = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']

/** 'HH:MM' -> minutes depuis minuit */
export function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

export function fromMin(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function hours(debut: string, fin: string): number {
  return (toMin(fin) - toMin(debut)) / 60
}

/** Affichage court d'une heure : '08:00' -> '8h', '13:30' -> '13h30' */
export function fmtHeure(t: string): string {
  const [h, m] = t.split(':')
  return `${Number(h)}h${m !== '00' ? m : ''}`
}

/** 'AAAA-MM-JJ' -> Date locale à midi (évite les effets de changement d'heure) */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayIso(): string {
  return toIso(new Date())
}

export function addDays(iso: string, n: number): string {
  const d = parseDate(iso)
  d.setDate(d.getDate() + n)
  return toIso(d)
}

export function mondayOf(iso: string): string {
  const d = parseDate(iso)
  const dow = (d.getDay() + 6) % 7
  return addDays(iso, -dow)
}

/** Jour de la semaine au sens de CRENEAU.jour, ou null le dimanche */
export function jourOf(iso: string): Jour | null {
  const dow = (parseDate(iso).getDay() + 6) % 7
  return JOURS[dow] ?? null
}

export function isoWeek(iso: string): number {
  const d = parseDate(iso)
  const target = new Date(d.valueOf())
  const dayNr = (d.getDay() + 6) % 7
  target.setDate(target.getDate() - dayNr + 3)
  const firstThursday = new Date(target.getFullYear(), 0, 4, 12)
  const diff = (target.valueOf() - firstThursday.valueOf()) / 86400000
  return 1 + Math.round((diff - 3 + ((firstThursday.getDay() + 6) % 7)) / 7)
}

/** Lundis de toutes les semaines couvertes par [debut, fin] */
export function weeksBetween(debut: string, fin: string): string[] {
  const out: string[] = []
  for (let m = mondayOf(debut); m <= fin; m = addDays(m, 7)) out.push(m)
  return out
}

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(opts: Intl.DateTimeFormatOptions) {
  const k = JSON.stringify(opts)
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('fr-FR', opts))
  return fmtCache.get(k)!
}

/** 'lun. 19 oct.' */
export const fmtJourCourt = (iso: string) =>
  fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(parseDate(iso))
/** 'lundi 19 octobre 2026' */
export const fmtJourLong = (iso: string) =>
  fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parseDate(iso))
/** '19 oct.' */
export const fmtJourMois = (iso: string) => fmt({ day: 'numeric', month: 'short' }).format(parseDate(iso))
/** 'octobre' */
export const fmtMois = (iso: string) => fmt({ month: 'long' }).format(parseDate(iso))
export const fmtDateHeure = (isoTs: string) =>
  fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(isoTs))
