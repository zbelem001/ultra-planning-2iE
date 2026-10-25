// Export iCalendar (BF-22). Ouagadougou est en UTC+0 sans heure d'été :
// les heures locales s'écrivent directement en UTC.

import { nomEnseignant, publicCours, type SeanceVue } from './queries'

const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n')
const stamp = (date: string, heure: string) => `${date.replace(/-/g, '')}T${heure.replace(':', '')}00Z`

export function toIcs(seances: SeanceVue[], nom: string): string {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UltraPlanning//FR',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${esc(nom)}`,
  ]
  for (const s of seances) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:seance-${s.id_seance}@ultraplanning.2ie`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(s.date_seance, s.heure_debut)}`,
      `DTEND:${stamp(s.date_seance, s.heure_fin)}`,
      `SUMMARY:${esc(`${s.matiere.libelle} (${s.cours.type_cours})`)}`,
      `LOCATION:${esc([s.salle.nom_salle, s.salle.batiment, s.site?.nom_site].filter(Boolean).join(' · '))}`,
      `DESCRIPTION:${esc(`${nomEnseignant(s.enseignant)} · ${publicCours(s.classe, s.groupe)}`)}`,
      `STATUS:${s.statut === 'annulee' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}

export function download(filename: string, content: string, type = 'text/calendar;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
