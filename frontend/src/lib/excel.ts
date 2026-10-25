// Export Excel (.xlsx) d'un emploi du temps : une feuille avec toutes les séances,
// une feuille récapitulant les heures par matière et par type. La bibliothèque
// (exceljs) n'est chargée qu'au moment de l'export.

import type { SeanceVue } from './queries'
import { nomEnseignant } from './queries'
import { isoWeek, jourOf, parseDate } from './time'

const NAVY = 'FF03254C'

export async function exporterExcel(seances: SeanceVue[], titre: string, nomFichier: string) {
  const { default: ExcelJS } = await import('exceljs')
  const classeur = new ExcelJS.Workbook()
  classeur.creator = 'Ultraplanning'
  classeur.created = new Date()

  const liste = [...seances].sort((a, b) => a.date_seance.localeCompare(b.date_seance) || a.heure_debut.localeCompare(b.heure_debut))
  const f = classeur.addWorksheet('Séances', { views: [{ state: 'frozen', ySplit: 2 }] })
  f.columns = [
    { key: 'date', width: 12 }, { key: 'jour', width: 10 }, { key: 'semaine', width: 9 },
    { key: 'debut', width: 8 }, { key: 'fin', width: 8 }, { key: 'duree', width: 9 },
    { key: 'matiere', width: 28 }, { key: 'type', width: 6 }, { key: 'classe', width: 12 },
    { key: 'groupe', width: 10 }, { key: 'enseignant', width: 24 }, { key: 'salle', width: 22 },
    { key: 'site', width: 22 }, { key: 'statut', width: 11 },
  ]
  f.mergeCells(1, 1, 1, f.columns.length)
  f.getCell(1, 1).value = titre
  f.getCell(1, 1).font = { bold: true, size: 14, color: { argb: NAVY } }
  const entete = f.getRow(2)
  entete.values = ['Date', 'Jour', 'Semaine', 'Début', 'Fin', 'Durée (h)', 'Matière', 'Type', 'Classe', 'Groupe',
    'Enseignant', 'Salle', 'Site', 'Statut']
  entete.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
  for (const s of liste) {
    f.addRow({
      date: parseDate(s.date_seance), jour: jourOf(s.date_seance), semaine: isoWeek(s.date_seance),
      debut: s.heure_debut, fin: s.heure_fin, duree: s.duree,
      matiere: s.matiere.libelle, type: s.cours.type_cours, classe: s.classe.code_classe,
      groupe: s.groupe?.code_groupe ?? '', enseignant: nomEnseignant(s.enseignant),
      salle: s.salle.nom_salle, site: s.site?.nom_site ?? '', statut: s.statut === 'annulee' ? 'Annulée' : 'Prévue',
    })
  }
  f.getColumn('date').numFmt = 'dd/mm/yyyy'
  f.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: f.columns.length } }

  // Récapitulatif : heures par matière et par type (séances annulées exclues)
  const r = classeur.addWorksheet('Récapitulatif')
  r.columns = [{ key: 'matiere', width: 30 }, { key: 'CM', width: 8 }, { key: 'TD', width: 8 }, { key: 'TP', width: 8 }, { key: 'total', width: 9 }]
  const titreRecap = r.getRow(1)
  titreRecap.values = ['Matière', 'CM (h)', 'TD (h)', 'TP (h)', 'Total (h)']
  titreRecap.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  titreRecap.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }
  const heures = new Map<string, Record<string, number>>()
  for (const s of liste) {
    if (s.statut === 'annulee') continue
    const h = heures.get(s.matiere.libelle) ?? { CM: 0, TD: 0, TP: 0 }
    h[s.cours.type_cours] += s.duree
    heures.set(s.matiere.libelle, h)
  }
  for (const [matiere, h] of [...heures].sort(([a], [b]) => a.localeCompare(b, 'fr'))) {
    r.addRow({ matiere, ...h, total: h.CM + h.TD + h.TP })
  }
  const total = r.addRow({ matiere: 'Total', CM: 0, TD: 0, TP: 0, total: 0 })
  const n = total.number
  for (const [col, lettre] of [['CM', 'B'], ['TD', 'C'], ['TP', 'D'], ['total', 'E']] as const) {
    total.getCell(col).value = { formula: `SUM(${lettre}2:${lettre}${n - 1})` }
  }
  total.font = { bold: true }

  const tampon = await classeur.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([tampon], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = nomFichier
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
