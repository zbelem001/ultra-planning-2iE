// Description des tables du référentiel : colonnes affichées, champs du
// formulaire (avec les CHECK du schéma) et règles ON DELETE RESTRICT / CASCADE.

import type { ReactNode } from 'react'
import { Badge } from '@/components/ui'
import { decoupage } from '@/lib/rules'
import { libelleCours, nomEnseignant, publicCours } from '@/lib/queries'
import { chaineGroupe } from '@/lib/publics'
import { controleProgramme, couverture } from '@/lib/programme'
import { fmtJourLong } from '@/lib/time'
import type { Db } from '@/types/db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>
export type Opt = { value: string | number; label: string }

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'bool' | 'time' | 'date' | 'email' | 'decoupage'
  options?: (db: Db) => Opt[]
  required?: boolean
  min?: number
  max?: number
  step?: number
  unique?: boolean
  hint?: string
  /** Modifiable seulement à la création (clé primaire naturelle) */
  createOnly?: boolean
  /** Valeur proposée à la création (DEFAULT du schéma) */
  defaut?: string
}

export interface TableDef {
  id: string
  label: string
  singulier: string
  groupe: string
  table: keyof Db
  pk: string
  identity: boolean
  columns: { label: string; render: (r: Row, db: Db) => ReactNode; className?: string }[]
  fields: FieldDef[]
  search: (r: Row, db: Db) => string
  /** Motif de refus de suppression (ON DELETE RESTRICT), sinon null */
  restrict?: (r: Row, db: Db) => string | null
  /** Suppressions en cascade */
  cascade?: (r: Row, db: Db) => void
  validate?: (r: Row, db: Db) => string | null
  /** Import : champs qui reconnaissent une ligne existante (mise à jour au lieu d'un doublon).
   *  Par défaut, le premier champ unique ; sans clé, chaque ligne importée est créée. */
  cle?: string[]
}

const opt = {
  filiere: (db: Db) => db.filiere.map((f) => ({ value: f.id_filiere, label: `${f.code_filiere} · ${f.libelle}` })),
  classe: (db: Db) => db.classe.map((c) => ({ value: c.id_classe, label: `${c.code_classe} · ${c.libelle}` })),
  groupe: (db: Db) => [{ value: '', label: '— Classe entière —' }, ...db.groupe.map((g) => ({ value: g.id_groupe, label: `${db.classe.find((c) => c.id_classe === g.id_classe)?.code_classe} · ${g.code_groupe}` }))],
  matiere: (db: Db) => db.matiere.map((m) => ({ value: m.id_matiere, label: `${m.code_matiere} · ${m.libelle}` })),
  enseignant: (db: Db) => db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom} ${e.prenom}` })),
  enseignantNull: (db: Db) => [{ value: '', label: '— À désigner —' }, ...db.enseignant.map((e) => ({ value: e.id_enseignant, label: `${e.nom} ${e.prenom}` }))],
  typeSalle: (db: Db) => db.type_salle.map((t) => ({ value: t.id_type_salle, label: t.libelle })),
  typeSalleNull: (db: Db) => [{ value: '', label: '— Aucun type exigé —' }, ...db.type_salle.map((t) => ({ value: t.id_type_salle, label: t.libelle }))],
  semestre: (db: Db) => db.semestre.map((s) => ({ value: s.id_semestre, label: `${s.libelle} ${s.annee_academique}` })),
  siteNull: (db: Db) => [{ value: '', label: '— Aucun —' }, ...db.site.map((s) => ({ value: s.id_site, label: s.nom_site }))],
  sitePromotion: (db: Db) => [{ value: '', label: '— Non fixé (salles de tous les sites) —' }, ...db.site.map((s) => ({ value: s.id_site, label: s.nom_site }))],
  groupeParent: (db: Db) => [{ value: '', label: '— Aucun : directement dans la classe —' }, ...db.groupe.map((g) => ({ value: g.id_groupe, label: `${db.classe.find((c) => c.id_classe === g.id_classe)?.code_classe} · ${g.code_groupe} (${g.type_groupe})` }))],
  cours: (db: Db) => db.cours.map((c) => ({ value: c.id_cours, label: libelleCours(db, c) })),
  salle: (db: Db) => db.salle.map((s) => ({ value: s.id_salle, label: `${s.code_salle} · ${s.nom_salle}` })),
  site: (db: Db) => db.site.map((s) => ({ value: s.id_site, label: `${s.nom_site}${s.type_site === 'annexe' ? ' (annexe)' : ''}` })),
  enumOf: (vals: string[]) => () => vals.map((v) => ({ value: v, label: v })),
}

const compte = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`
const refus = (n: number, mot: string) => (n ? `Impossible : ${compte(n, mot)} y fait référence.` : null)
const STATUTS = { permanent: 'Permanent', vacataire_local: 'Vacataire local', externe: 'Externe' } as const
const nomSite = (db: Db, id: number | null) => (id == null ? '–' : db.site.find((s) => s.id_site === id)?.nom_site ?? '–')

export const TABLES: TableDef[] = [
  {
    id: 'filieres', label: 'Filières', singulier: 'filière', groupe: 'Publics', table: 'filiere', pk: 'id_filiere', identity: true,
    columns: [
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_filiere}</span> },
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Campus', render: (r, db) => <span className="text-ink-2">{nomSite(db, r.id_site)}</span> },
      { label: 'Classes', render: (r, db) => db.classe.filter((c) => c.id_filiere === r.id_filiere).length, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'code_filiere', label: 'Code', type: 'text', required: true, unique: true },
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'id_site', label: 'Campus principal', type: 'select', options: opt.siteNull, hint: 'Site où la filière est principalement enseignée' },
    ],
    search: (r) => `${r.code_filiere} ${r.libelle}`,
    restrict: (r, db) => refus(db.classe.filter((c) => c.id_filiere === r.id_filiere).length, 'classe'),
  },
  {
    id: 'classes', label: 'Classes', singulier: 'classe', groupe: 'Publics', table: 'classe', pk: 'id_classe', identity: true,
    columns: [
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_classe}</span> },
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Niveau', render: (r) => <Badge tone="navy">{r.niveau}</Badge> },
      { label: 'Filière', render: (r, db) => db.filiere.find((f) => f.id_filiere === r.id_filiere)?.code_filiere },
      { label: 'Site des cours', render: (r, db) => <span className="text-ink-2">{r.id_site ? nomSite(db, r.id_site) : 'Non fixé'}</span> },
      { label: 'Effectif', render: (r) => r.effectif, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'code_classe', label: 'Code', type: 'text', required: true, unique: true },
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'niveau', label: 'Niveau', type: 'select', options: opt.enumOf(['L1', 'L2', 'L3', 'M1', 'M2', 'CPGE1', 'CPGE2', 'BT', 'MAN', 'AUTRE']), required: true, hint: 'BT : bachelor technologique ; MAN : mise à niveau' },
      { key: 'effectif', label: 'Effectif', type: 'number', min: 0, required: true },
      { key: 'id_filiere', label: 'Filière', type: 'select', options: opt.filiere, required: true },
      { key: 'id_site', label: 'Site des cours', type: 'select', options: opt.sitePromotion, hint: 'Si la promotion n\'a cours que sur un site (ex. Ouaga pour les IA), ses séances n\'iront que dans les salles de ce site.' },
    ],
    search: (r) => `${r.code_classe} ${r.libelle} ${r.niveau}`,
    restrict: (r, db) => refus(db.cours.filter((c) => c.id_classe === r.id_classe).length, 'cours'),
    cascade: (r, db) => {
      db.groupe = db.groupe.filter((g) => g.id_classe !== r.id_classe)
      db.conge = db.conge.filter((g) => g.id_classe !== r.id_classe)
      db.cours_public = db.cours_public.filter((p) => p.id_classe !== r.id_classe)
      db.salle_reservation = db.salle_reservation.filter((x) => x.id_classe !== r.id_classe)
      db.programme = db.programme.filter((p) => p.id_classe !== r.id_classe)
    },
  },
  {
    id: 'groupes', label: 'Groupes', singulier: 'groupe', groupe: 'Publics', table: 'groupe', pk: 'id_groupe', identity: true,
    cle: ['id_classe', 'code_groupe'],
    columns: [
      { label: 'Classe', render: (r, db) => db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe },
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_groupe}</span> },
      { label: 'Type', render: (r) => <Badge tone={r.type_groupe === 'OPTION' ? 'orange' : 'neutral'}>{r.type_groupe === 'OPTION' ? 'Option' : r.type_groupe}</Badge> },
      { label: 'Dans', render: (r, db) => <span className="text-ink-2">{db.groupe.find((g) => g.id_groupe === r.id_groupe_parent)?.code_groupe ?? 'la classe'}</span> },
      { label: 'Effectif', render: (r) => r.effectif, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'id_classe', label: 'Classe', type: 'select', options: opt.classe, required: true },
      { key: 'code_groupe', label: 'Code', type: 'text', required: true, hint: 'Unique dans la classe' },
      { key: 'type_groupe', label: 'Type', type: 'select', options: opt.enumOf(['TD', 'TP', 'OPTION']), required: true, hint: 'TD ou TP : groupe pour ces cours ; option : partie de la promotion qui suit ses propres cours (CM compris)' },
      { key: 'id_groupe_parent', label: 'Dans le groupe', type: 'select', options: opt.groupeParent, hint: 'Ex. un demi-groupe de TP dans son groupe de TD, une sous-option dans son option. Deux groupes frères du même type peuvent avoir cours en même temps.' },
      { key: 'effectif', label: 'Effectif', type: 'number', min: 0, required: true },
    ],
    search: (r, db) => `${r.code_groupe} ${db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe}`,
    validate: (r, db) => {
      if (db.groupe.some((g) => g.id_classe === Number(r.id_classe) && g.code_groupe === r.code_groupe && g.id_groupe !== r.id_groupe)) return 'Ce code de groupe existe déjà dans la classe.'
      if (r.id_groupe && r.type_groupe !== 'OPTION' && db.cours.some((c) => c.id_groupe === r.id_groupe && c.type_cours !== r.type_groupe)) return 'Des cours ciblent ce groupe avec un autre type : modifiez-les avant de changer le type du groupe.'
      if (r.id_groupe_parent) {
        const parent = db.groupe.find((g) => g.id_groupe === Number(r.id_groupe_parent))
        if (parent && parent.id_classe !== Number(r.id_classe)) return 'Le groupe parent doit appartenir à la même classe.'
        if (r.id_groupe && chaineGroupe(db.groupe, Number(r.id_groupe_parent)).includes(r.id_groupe)) return 'Un groupe ne peut pas être dans lui-même ni dans l\'un de ses sous-groupes.'
      }
      return null
    },
    restrict: (r, db) => refus(db.cours.filter((c) => c.id_groupe === r.id_groupe).length, 'cours'),
    // comme ON DELETE CASCADE : sous-groupes et publics mutualisés de ce groupe
    cascade: (r, db) => {
      const sous = new Set(db.groupe.filter((g) => chaineGroupe(db.groupe, g.id_groupe).includes(r.id_groupe)).map((g) => g.id_groupe))
      db.groupe = db.groupe.filter((g) => !sous.has(g.id_groupe) || g.id_groupe === r.id_groupe)
      db.cours_public = db.cours_public.filter((p) => p.id_groupe === null || !sous.has(p.id_groupe))
    },
  },
  {
    id: 'matieres', label: 'Matières', singulier: 'matière', groupe: 'Enseignement', table: 'matiere', pk: 'id_matiere', identity: true,
    columns: [
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_matiere}</span> },
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Coefficient', render: (r) => r.coefficient, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'code_matiere', label: 'Code', type: 'text', required: true, unique: true },
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'coefficient', label: 'Coefficient', type: 'number', min: 0, step: 0.5, required: true },
    ],
    search: (r) => `${r.code_matiere} ${r.libelle}`,
    restrict: (r, db) => refus(db.cours.filter((c) => c.id_matiere === r.id_matiere).length + db.programme.filter((p) => p.id_matiere === r.id_matiere).length, 'cours ou ligne de programme'),
  },
  {
    id: 'programme', label: 'Programme', singulier: 'ligne de programme', groupe: 'Enseignement', table: 'programme', pk: 'id_programme', identity: true,
    cle: ['id_classe', 'id_matiere', 'id_semestre'],
    columns: [
      { label: 'Classe', render: (r, db) => db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe },
      { label: 'Matière', render: (r, db) => db.matiere.find((m) => m.id_matiere === r.id_matiere)?.libelle },
      { label: 'CM', render: (r) => (r.volume_cm ? `${r.volume_cm} h` : '–'), className: 'text-right tabular-nums' },
      { label: 'TD', render: (r) => (r.volume_td ? `${r.volume_td} h` : '–'), className: 'text-right tabular-nums' },
      { label: 'TP', render: (r) => (r.volume_tp ? `${r.volume_tp} h` : '–'), className: 'text-right tabular-nums' },
      {
        label: 'Couverture par les cours',
        render: (r, db) => {
          const manques = couverture(db).filter((e) => e.id_programme === r.id_programme && e.couvert < e.prevu)
          if (!manques.length) return <Badge tone="success" dot>Complet</Badge>
          return (
            <span className="flex flex-wrap gap-1">
              {manques.map((e) => <Badge key={`${e.type}${e.public}`} tone="warning" dot>{e.public.split(' · ')[1] ?? e.public} {e.type} : {e.couvert}/{e.prevu} h</Badge>)}
            </span>
          )
        },
      },
    ],
    fields: [
      { key: 'id_classe', label: 'Classe', type: 'select', options: opt.classe, required: true },
      { key: 'id_matiere', label: 'Matière', type: 'select', options: opt.matiere, required: true },
      { key: 'id_semestre', label: 'Semestre', type: 'select', options: opt.semestre, required: true },
      { key: 'volume_cm', label: 'Volume CM (h)', type: 'number', min: 0, step: 0.5, required: true },
      { key: 'volume_td', label: 'Volume TD (h, par groupe)', type: 'number', min: 0, step: 0.5, required: true },
      { key: 'volume_tp', label: 'Volume TP (h, par groupe)', type: 'number', min: 0, step: 0.5, required: true },
    ],
    search: (r, db) => `${db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe} ${db.matiere.find((m) => m.id_matiere === r.id_matiere)?.libelle}`,
    validate: (r, db) => {
      if (Number(r.volume_cm) + Number(r.volume_td) + Number(r.volume_tp) <= 0) return 'Indiquez au moins un volume (CM, TD ou TP).'
      if (db.programme.some((p) => p.id_classe === Number(r.id_classe) && p.id_matiere === Number(r.id_matiere) && p.id_semestre === Number(r.id_semestre) && p.id_programme !== r.id_programme)) {
        return 'Cette matière est déjà au programme de la classe pour ce semestre.'
      }
      // On ne réduit pas un volume sous celui des cours existants (CD-07)
      if (r.id_programme) {
        const avant = db.programme.find((p) => p.id_programme === r.id_programme)!
        for (const [type, cle] of [['CM', 'volume_cm'], ['TD', 'volume_td'], ['TP', 'volume_tp']] as const) {
          const max = Math.max(0, ...db.cours.filter((c) => c.id_classe === avant.id_classe && c.id_matiere === avant.id_matiere && c.id_semestre === avant.id_semestre && c.type_cours === type).map((c) => c.volume_horaire))
          const memeLigne = avant.id_classe === Number(r.id_classe) && avant.id_matiere === Number(r.id_matiere) && avant.id_semestre === Number(r.id_semestre)
          if (max > (memeLigne ? Number(r[cle]) : 0)) return `CD-07 : des cours de ${type} utilisent cette ligne (jusqu'à ${max} h) : modifiez-les d'abord.`
        }
      }
      return null
    },
    restrict: (r, db) => refus(db.cours.filter((c) => c.id_classe === r.id_classe && c.id_matiere === r.id_matiere && c.id_semestre === r.id_semestre).length, 'cours'),
  },
  {
    id: 'cours', label: 'Cours', singulier: 'cours', groupe: 'Enseignement', table: 'cours', pk: 'id_cours', identity: true,
    cle: ['id_classe', 'id_matiere', 'type_cours', 'id_groupe', 'id_semestre'],
    columns: [
      { label: 'Matière', render: (r, db) => db.matiere.find((m) => m.id_matiere === r.id_matiere)?.libelle },
      { label: 'Type', render: (r) => <Badge tone="navy">{r.type_cours}</Badge> },
      { label: 'Public', render: (r, db) => publicCours(db.classe.find((c) => c.id_classe === r.id_classe)!, db.groupe.find((g) => g.id_groupe === r.id_groupe) ?? null) },
      { label: 'Enseignant prévu', render: (r, db) => <span className={r.id_enseignant ? '' : 'text-ink-2'}>{nomEnseignant(db.enseignant.find((x) => x.id_enseignant === r.id_enseignant))}</span> },
      { label: 'Volume', render: (r) => `${r.volume_horaire} h`, className: 'text-right tabular-nums' },
      { label: 'Rythme / sem.', render: (r) => `${r.heures_semaine_min}–${r.heures_semaine_max} h`, className: 'tabular-nums whitespace-nowrap' },
      { label: 'Séances', render: (r, db) => decoupage(db, r.id_cours).map((m) => `${m.duree_heures} h`).join(' + '), className: 'tabular-nums' },
      {
        label: 'Priorité',
        render: (r) => (
          <span className="flex items-center gap-1.5 tabular-nums" title={r.justification_priorite ?? undefined}>
            {r.priorite}
            {r.priorite_suggeree !== null && r.priorite_suggeree !== r.priorite && <Badge tone="orange">IA : {r.priorite_suggeree}</Badge>}
          </span>
        ),
      },
    ],
    fields: [
      { key: 'id_matiere', label: 'Matière', type: 'select', options: opt.matiere, required: true },
      { key: 'type_cours', label: 'Type', type: 'select', options: opt.enumOf(['CM', 'TD', 'TP']), required: true },
      { key: 'id_classe', label: 'Classe', type: 'select', options: opt.classe, required: true },
      { key: 'id_groupe', label: 'Groupe ciblé', type: 'select', options: opt.groupe, hint: 'Vide = classe entière (obligatoire pour un CM). Un TD cible un groupe de TD, un TP un groupe de TP.' },
      { key: 'id_enseignant', label: 'Enseignant prévu', type: 'select', options: opt.enseignantNull, hint: 'Facultatif : repris sur les séances générées. L\'enseignant se change ensuite séance par séance dans la planification.' },
      { key: 'id_type_salle', label: 'Type de salle exigé', type: 'select', options: opt.typeSalleNull },
      { key: 'volume_horaire', label: 'Volume horaire (h, semestre)', type: 'number', min: 0.5, step: 0.5, required: true },
      { key: 'duree_seance', label: 'Durée par défaut (h)', type: 'number', min: 2, max: 4, step: 0.5, required: true },
      { key: 'nb_seances_semaine', label: 'Séances par semaine', type: 'number', min: 1, required: true },
      { key: 'priorite', label: 'Priorité', type: 'number', min: 0, required: true, hint: 'Plus haut = commence plus tôt (CS-07). L\'assistant IA peut en suggérer une.' },
      { key: 'heures_semaine_min', label: 'Heures par semaine : minimum', type: 'number', min: 0, step: 0.5, required: true, defaut: '2' },
      { key: 'heures_semaine_max', label: 'Heures par semaine : maximum', type: 'number', min: 2, step: 0.5, required: true, defaut: '15', hint: 'Le solveur choisit le rythme entre ces bornes (CD-14)' },
      { key: 'id_semestre', label: 'Semestre', type: 'select', options: opt.semestre, required: true },
      { key: '__decoupage', label: 'Durées de séance préférées', type: 'decoupage', hint: 'Ex. « 2+3 ». Chaque séance dure de 2 à 4 h (COURS_SEANCE_MODELE). Indicatif : le rythme réel est choisi par le solveur.' },
    ],
    search: (r, db) => `${db.matiere.find((m) => m.id_matiere === r.id_matiere)?.libelle} ${r.type_cours} ${db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe}`,
    validate: (r, db) => {
      const g = r.id_groupe ? db.groupe.find((x) => x.id_groupe === Number(r.id_groupe)) : undefined
      if (g && g.id_classe !== Number(r.id_classe)) return 'Le groupe doit appartenir à la classe du cours.'
      if (g && g.type_groupe !== 'OPTION' && r.type_cours === 'CM') return "Un CM s'adresse à la classe entière ou à une option : laissez le groupe vide ou choisissez une option."
      if (g && g.type_groupe !== 'OPTION' && g.type_groupe !== r.type_cours) return `Un cours de ${r.type_cours} ne peut cibler qu'un groupe de ${r.type_cours} ou une option (${g.code_groupe} est un groupe de ${g.type_groupe}).`
      if (Number(r.heures_semaine_max) < Number(r.heures_semaine_min)) return 'Le maximum d\'heures par semaine doit être supérieur ou égal au minimum.'
      const horsProgramme = controleProgramme(db, {
        id_classe: Number(r.id_classe), id_matiere: Number(r.id_matiere), id_semestre: Number(r.id_semestre),
        type_cours: r.type_cours, volume_horaire: Number(r.volume_horaire),
      })
      if (horsProgramme) return horsProgramme
      return null
    },
    restrict: (r, db) => refus(db.seance.filter((s) => s.id_cours === r.id_cours).length, 'séance'),
    cascade: (r, db) => {
      db.cours_seance_modele = db.cours_seance_modele.filter((m) => m.id_cours !== r.id_cours)
      db.cours_public = db.cours_public.filter((p) => p.id_cours !== r.id_cours)
      db.cours_type_salle = db.cours_type_salle.filter((t) => t.id_cours !== r.id_cours)
    },
  },
  {
    id: 'cours-mutualises', label: 'Cours mutualisés', singulier: 'public mutualisé', groupe: 'Enseignement', table: 'cours_public', pk: 'id_cours_public', identity: true,
    cle: ['id_cours', 'id_classe', 'id_groupe'],
    columns: [
      { label: 'Cours', render: (r, db) => { const c = db.cours.find((x) => x.id_cours === r.id_cours); return c ? libelleCours(db, c) : '' } },
      { label: 'Suivi aussi par', render: (r, db) => publicCours(db.classe.find((c) => c.id_classe === r.id_classe)!, db.groupe.find((g) => g.id_groupe === r.id_groupe) ?? null) },
    ],
    fields: [
      { key: 'id_cours', label: 'Cours', type: 'select', options: opt.cours, required: true, hint: 'Le cours, avec son public principal (sa classe ou son groupe)' },
      { key: 'id_classe', label: 'Suivi aussi par la classe', type: 'select', options: opt.classe, required: true },
      { key: 'id_groupe', label: 'Groupe de cette classe', type: 'select', options: opt.groupe, hint: 'Vide : la classe entière' },
    ],
    search: (r, db) => { const c = db.cours.find((x) => x.id_cours === r.id_cours); return `${c ? libelleCours(db, c) : ''} ${db.classe.find((x) => x.id_classe === r.id_classe)?.code_classe}` },
    validate: (r, db) => {
      const g = r.id_groupe ? db.groupe.find((x) => x.id_groupe === Number(r.id_groupe)) : undefined
      if (g && g.id_classe !== Number(r.id_classe)) return 'Le groupe doit appartenir à la classe choisie.'
      const c = db.cours.find((x) => x.id_cours === Number(r.id_cours))
      if (c && c.id_classe === Number(r.id_classe) && (c.id_groupe ?? null) === (r.id_groupe ? Number(r.id_groupe) : null)) return 'C\'est déjà le public principal du cours.'
      if (db.cours_public.some((p) => p.id_cours === Number(r.id_cours) && p.id_classe === Number(r.id_classe) && (p.id_groupe ?? null) === (r.id_groupe ? Number(r.id_groupe) : null) && p.id_cours_public !== r.id_cours_public)) return 'Ce public suit déjà ce cours.'
      return null
    },
  },
  {
    id: 'enseignants', label: 'Enseignants', singulier: 'enseignant', groupe: 'Enseignement', table: 'enseignant', pk: 'id_enseignant', identity: true,
    columns: [
      { label: 'Matricule', render: (r) => <span className="font-mono text-xs">{r.matricule}</span> },
      { label: 'Nom', render: (r) => `${r.nom.toUpperCase()} ${r.prenom}` },
      { label: 'Grade', render: (r) => r.grade },
      { label: 'Statut', render: (r) => <Badge tone={r.statut === 'externe' ? 'orange' : r.statut === 'vacataire_local' ? 'neutral' : 'navy'}>{STATUTS[r.statut as keyof typeof STATUTS]}</Badge> },
      { label: 'E-mail', render: (r) => <span className="text-ink-2">{r.email}</span> },
      { label: 'Campus', render: (r, db) => <span className="text-ink-2">{nomSite(db, r.id_site)}</span> },
      { label: 'Cours prévus', render: (r, db) => db.cours.filter((c) => c.id_enseignant === r.id_enseignant).length, className: 'text-right tabular-nums' },
      { label: 'Max / sem.', render: (r) => (r.nb_heures_max_semaine ? `${r.nb_heures_max_semaine} h` : '–'), className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'matricule', label: 'Matricule', type: 'text', required: true, unique: true },
      { key: 'nom', label: 'Nom', type: 'text', required: true },
      { key: 'prenom', label: 'Prénom', type: 'text', required: true },
      { key: 'email', label: 'E-mail', type: 'email', unique: true },
      { key: 'telephone', label: 'Téléphone', type: 'text' },
      { key: 'grade', label: 'Grade', type: 'text' },
      { key: 'nb_heures_max_semaine', label: 'Heures max par semaine', type: 'number', min: 1 },
      {
        key: 'statut', label: 'Statut', type: 'select', required: true, defaut: 'permanent',
        options: () => Object.entries(STATUTS).map(([value, label]) => ({ value, label })),
        hint: 'Externe : séances limitées à ses séjours (page Disponibilités), cours ramassés. Permanent : cours enchaînés. Vacataire local : selon ses disponibilités.',
      },
      { key: 'id_site', label: 'Campus de rattachement', type: 'select', options: opt.siteNull },
    ],
    search: (r) => `${r.matricule} ${r.nom} ${r.prenom} ${r.grade}`,
    // Ses cours et séances restent, sans enseignant (à désigner), comme ON DELETE SET NULL dans la base
    cascade: (r, db) => {
      for (const c of db.cours) if (c.id_enseignant === r.id_enseignant) c.id_enseignant = null
      for (const x of db.seance) if (x.id_enseignant === r.id_enseignant) x.id_enseignant = null
      db.disponibilite = db.disponibilite.filter((d) => d.id_enseignant !== r.id_enseignant)
      db.absence_enseignant = db.absence_enseignant.filter((a) => a.id_enseignant !== r.id_enseignant)
      db.sejour_enseignant = db.sejour_enseignant.filter((j) => j.id_enseignant !== r.id_enseignant)
    },
  },
  {
    id: 'sites', label: 'Sites', singulier: 'site', groupe: 'Campus et locaux', table: 'site', pk: 'id_site', identity: true,
    columns: [
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_site}</span> },
      { label: 'Nom', render: (r) => r.nom_site },
      { label: 'Type', render: (r) => <Badge tone={r.type_site === 'campus' ? 'navy' : 'orange'}>{r.type_site === 'campus' ? 'Campus' : 'Annexe'}</Badge> },
      { label: 'Adresse', render: (r) => <span className="text-ink-2">{r.adresse}</span> },
      { label: 'Salles', render: (r, db) => db.salle.filter((s) => s.id_site === r.id_site).length, className: 'text-right tabular-nums' },
      { label: 'Filières', render: (r, db) => db.filiere.filter((f) => f.id_site === r.id_site).length, className: 'text-right tabular-nums' },
      { label: 'Enseignants', render: (r, db) => db.enseignant.filter((e) => e.id_site === r.id_site).length, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'code_site', label: 'Code', type: 'text', required: true, unique: true, hint: 'Ex. KAMB' },
      { key: 'nom_site', label: 'Nom', type: 'text', required: true, hint: 'Ex. « Campus de Kamboinsé »' },
      { key: 'type_site', label: 'Type', type: 'select', options: () => [{ value: 'campus', label: 'Campus' }, { value: 'annexe', label: 'Annexe' }], required: true },
      { key: 'adresse', label: 'Adresse', type: 'text' },
    ],
    search: (r) => `${r.code_site} ${r.nom_site} ${r.adresse ?? ''}`,
    restrict: (r, db) => refus(db.salle.filter((s) => s.id_site === r.id_site).length + db.filiere.filter((f) => f.id_site === r.id_site).length + db.classe.filter((c) => c.id_site === r.id_site).length, 'salle, filière ou classe'),
    cascade: (r, db) => {
      for (const e of db.enseignant) if (e.id_site === r.id_site) e.id_site = null
      db.site_trajet = db.site_trajet.filter((t) => t.id_site_a !== r.id_site && t.id_site_b !== r.id_site)
    },
  },
  {
    id: 'salles', label: 'Salles', singulier: 'salle', groupe: 'Campus et locaux', table: 'salle', pk: 'id_salle', identity: true,
    columns: [
      { label: 'Code', render: (r) => <span className="font-mono text-xs">{r.code_salle}</span> },
      { label: 'Nom', render: (r) => r.nom_salle },
      { label: 'Type', render: (r, db) => db.type_salle.find((t) => t.id_type_salle === r.id_type_salle)?.libelle },
      { label: 'Campus', render: (r, db) => nomSite(db, r.id_site) },
      { label: 'Bâtiment', render: (r) => <span className="text-ink-2">{r.batiment}</span> },
      { label: 'Capacité', render: (r) => r.capacite, className: 'text-right tabular-nums' },
      { label: 'État', render: (r) => (r.est_disponible ? <Badge tone="success" dot>Disponible</Badge> : <Badge tone="danger" dot>Indisponible</Badge>) },
    ],
    fields: [
      { key: 'code_salle', label: 'Code', type: 'text', required: true, unique: true },
      { key: 'nom_salle', label: 'Nom', type: 'text', required: true },
      { key: 'id_type_salle', label: 'Type', type: 'select', options: opt.typeSalle, required: true },
      { key: 'capacite', label: 'Capacité', type: 'number', min: 1, required: true },
      { key: 'id_site', label: 'Campus', type: 'select', options: opt.site, required: true },
      { key: 'batiment', label: 'Bâtiment', type: 'text', hint: 'Bâtiment dans le campus, ex. « Bloc A »' },
      { key: 'est_disponible', label: 'Disponible à la réservation', type: 'bool' },
    ],
    search: (r, db) => `${r.code_salle} ${r.nom_salle} ${r.batiment ?? ''} ${nomSite(db, r.id_site)}`,
    restrict: (r, db) => refus(db.seance.filter((s) => s.id_salle === r.id_salle).length, 'séance'),
    cascade: (r, db) => { db.salle_reservation = db.salle_reservation.filter((x) => x.id_salle !== r.id_salle) },
  },
  {
    id: 'salles-reservees', label: 'Salles réservées', singulier: 'réservation de salle', groupe: 'Campus et locaux', table: 'salle_reservation', pk: 'id_salle_reservation', identity: true,
    cle: ['id_salle', 'id_classe'],
    columns: [
      { label: 'Salle', render: (r, db) => db.salle.find((s) => s.id_salle === r.id_salle)?.nom_salle },
      { label: 'Réservée à', render: (r, db) => db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe },
    ],
    fields: [
      { key: 'id_salle', label: 'Salle', type: 'select', options: opt.salle, required: true, hint: 'Une salle listée ici ne reçoit que les classes listées (EMIH, EREE, CPGE…)' },
      { key: 'id_classe', label: 'Classe ayant droit', type: 'select', options: opt.classe, required: true },
    ],
    search: (r, db) => `${db.salle.find((s) => s.id_salle === r.id_salle)?.nom_salle} ${db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe}`,
    validate: (r, db) => (db.salle_reservation.some((x) => x.id_salle === Number(r.id_salle) && x.id_classe === Number(r.id_classe) && x.id_salle_reservation !== r.id_salle_reservation) ? 'Cette réservation existe déjà.' : null),
  },
  {
    id: 'types-salle-acceptes', label: 'Types de salle acceptés', singulier: 'type de salle accepté', groupe: 'Campus et locaux', table: 'cours_type_salle', pk: 'id_cours_type_salle', identity: true,
    cle: ['id_cours', 'id_type_salle'],
    columns: [
      { label: 'Cours', render: (r, db) => { const c = db.cours.find((x) => x.id_cours === r.id_cours); return c ? libelleCours(db, c) : '' } },
      { label: 'Accepte aussi', render: (r, db) => db.type_salle.find((t) => t.id_type_salle === r.id_type_salle)?.libelle },
    ],
    fields: [
      { key: 'id_cours', label: 'Cours', type: 'select', options: opt.cours, required: true, hint: 'En plus du type de salle exigé par le cours (ex. un CM en amphithéâtre ou dans une grande salle standard)' },
      { key: 'id_type_salle', label: 'Type de salle accepté', type: 'select', options: opt.typeSalle, required: true },
    ],
    search: (r, db) => { const c = db.cours.find((x) => x.id_cours === r.id_cours); return `${c ? libelleCours(db, c) : ''} ${db.type_salle.find((t) => t.id_type_salle === r.id_type_salle)?.libelle}` },
    validate: (r, db) => (db.cours_type_salle.some((x) => x.id_cours === Number(r.id_cours) && x.id_type_salle === Number(r.id_type_salle) && x.id_cours_type_salle !== r.id_cours_type_salle) ? 'Ce type est déjà accepté pour ce cours.' : null),
  },
  {
    id: 'trajets', label: 'Trajets entre sites', singulier: 'trajet', groupe: 'Campus et locaux', table: 'site_trajet', pk: 'id_site_trajet', identity: true,
    cle: ['id_site_a', 'id_site_b'],
    columns: [
      { label: 'Entre', render: (r, db) => `${nomSite(db, r.id_site_a)} et ${nomSite(db, r.id_site_b)}` },
      { label: 'Trajet', render: (r) => `${r.minutes} min`, className: 'text-right tabular-nums' },
    ],
    fields: [
      { key: 'id_site_a', label: 'Site', type: 'select', options: opt.site, required: true },
      { key: 'id_site_b', label: 'Autre site', type: 'select', options: opt.site, required: true },
      { key: 'minutes', label: 'Temps de trajet (min)', type: 'number', min: 0, required: true, hint: 'Écart minimal entre deux séances d\'un enseignant sur ces deux sites le même jour' },
    ],
    search: (r, db) => `${nomSite(db, r.id_site_a)} ${nomSite(db, r.id_site_b)}`,
    validate: (r, db) => {
      if (Number(r.id_site_a) === Number(r.id_site_b)) return 'Choisissez deux sites différents.'
      // la base range chaque paire dans l'ordre (id_site_a < id_site_b)
      if (Number(r.id_site_a) > Number(r.id_site_b)) [r.id_site_a, r.id_site_b] = [r.id_site_b, r.id_site_a]
      return db.site_trajet.some((x) => x.id_site_a === Number(r.id_site_a) && x.id_site_b === Number(r.id_site_b) && x.id_site_trajet !== r.id_site_trajet)
        ? 'Le trajet entre ces deux sites est déjà saisi.' : null
    },
  },
  {
    id: 'types-salle', label: 'Types de salle', singulier: 'type de salle', groupe: 'Campus et locaux', table: 'type_salle', pk: 'id_type_salle', identity: true,
    columns: [
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Salles', render: (r, db) => db.salle.filter((s) => s.id_type_salle === r.id_type_salle).length, className: 'text-right tabular-nums' },
    ],
    fields: [{ key: 'libelle', label: 'Libellé', type: 'text', required: true, unique: true }],
    search: (r) => r.libelle,
    restrict: (r, db) => refus(db.salle.filter((s) => s.id_type_salle === r.id_type_salle).length, 'salle'),
    cascade: (r, db) => {
      for (const c of db.cours) if (c.id_type_salle === r.id_type_salle) c.id_type_salle = null
      db.cours_type_salle = db.cours_type_salle.filter((t) => t.id_type_salle !== r.id_type_salle)
    },
  },
  {
    id: 'semestres', label: 'Semestres', singulier: 'semestre', groupe: 'Calendrier', table: 'semestre', pk: 'id_semestre', identity: true,
    cle: ['annee_academique', 'libelle'],
    columns: [
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Année', render: (r) => r.annee_academique },
      { label: 'Début', render: (r) => r.date_debut, className: 'tabular-nums' },
      { label: 'Fin', render: (r) => r.date_fin, className: 'tabular-nums' },
    ],
    fields: [
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'annee_academique', label: 'Année universitaire', type: 'text', required: true, hint: 'Ex. 2026-2027' },
      { key: 'date_debut', label: 'Début', type: 'date', required: true },
      { key: 'date_fin', label: 'Fin', type: 'date', required: true },
    ],
    search: (r) => `${r.libelle} ${r.annee_academique}`,
    validate: (r) => (r.date_fin <= r.date_debut ? 'La date de fin doit suivre la date de début.' : null),
    restrict: (r, db) => refus(db.cours.filter((c) => c.id_semestre === r.id_semestre).length + db.emploi_du_temps.filter((e) => e.id_semestre === r.id_semestre).length + db.programme.filter((p) => p.id_semestre === r.id_semestre).length, 'cours, emploi du temps ou ligne de programme'),
  },
  {
    id: 'creneaux', label: 'Créneaux', singulier: 'créneau', groupe: 'Calendrier', table: 'creneau', pk: 'id_creneau', identity: true,
    cle: ['jour', 'heure_debut', 'heure_fin'],
    columns: [
      { label: 'Jour', render: (r) => r.jour },
      { label: 'Début', render: (r) => <span className="font-mono text-xs">{r.heure_debut}</span> },
      { label: 'Fin', render: (r) => <span className="font-mono text-xs">{r.heure_fin}</span> },
    ],
    fields: [
      { key: 'jour', label: 'Jour', type: 'select', options: opt.enumOf(['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']), required: true },
      { key: 'heure_debut', label: 'Début', type: 'time', required: true },
      { key: 'heure_fin', label: 'Fin', type: 'time', required: true },
    ],
    search: (r) => `${r.jour} ${r.heure_debut}`,
    validate: (r, db) =>
      r.heure_fin <= r.heure_debut ? 'La fin doit suivre le début.'
        : db.creneau.some((c) => c.jour === r.jour && c.heure_debut === r.heure_debut && c.heure_fin === r.heure_fin && c.id_creneau !== r.id_creneau) ? 'Ce créneau existe déjà.' : null,
    restrict: (r, db) => refus(db.seance.filter((s) => s.id_creneau === r.id_creneau).length, 'séance'),
    cascade: (r, db) => { db.disponibilite = db.disponibilite.filter((d) => d.id_creneau !== r.id_creneau) },
  },
  {
    id: 'pauses', label: 'Pauses', singulier: 'pause', groupe: 'Calendrier', table: 'pause', pk: 'id_pause', identity: true,
    cle: ['libelle'],
    columns: [
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Début', render: (r) => <span className="font-mono text-xs">{r.heure_debut}</span> },
      { label: 'Fin', render: (r) => <span className="font-mono text-xs">{r.heure_fin}</span> },
    ],
    fields: [
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'heure_debut', label: 'Début', type: 'time', required: true },
      { key: 'heure_fin', label: 'Fin', type: 'time', required: true },
    ],
    search: (r) => r.libelle,
    validate: (r) => (r.heure_fin <= r.heure_debut ? 'La fin doit suivre le début.' : null),
  },
  {
    id: 'jours-feries', label: 'Jours fériés', singulier: 'jour férié', groupe: 'Calendrier', table: 'jour_ferie', pk: 'date_ferie', identity: false,
    columns: [
      { label: 'Date', render: (r) => <span className="first-letter:uppercase">{fmtJourLong(r.date_ferie)}</span> },
      { label: 'Libellé', render: (r) => r.libelle },
    ],
    fields: [
      { key: 'date_ferie', label: 'Date', type: 'date', required: true, unique: true, createOnly: true },
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
    ],
    search: (r) => `${r.date_ferie} ${r.libelle}`,
  },
  {
    id: 'conges', label: 'Congés', singulier: 'congé', groupe: 'Calendrier', table: 'conge', pk: 'id_conge', identity: true,
    cle: ['libelle', 'date_debut'],
    columns: [
      { label: 'Libellé', render: (r) => r.libelle },
      { label: 'Type', render: (r) => <Badge tone={r.type_conge === 'examens' ? 'navy' : 'orange'}>{r.type_conge}</Badge> },
      { label: 'Du', render: (r) => <span className="first-letter:uppercase">{fmtJourLong(r.date_debut)}</span> },
      { label: 'Au', render: (r) => <span className="first-letter:uppercase">{fmtJourLong(r.date_fin)}</span> },
      { label: 'Concerne', render: (r, db) => (r.id_classe ? db.classe.find((c) => c.id_classe === r.id_classe)?.code_classe : 'Tout l\'établissement') },
    ],
    fields: [
      { key: 'libelle', label: 'Libellé', type: 'text', required: true },
      { key: 'type_conge', label: 'Type', type: 'select', options: opt.enumOf(['vacances', 'examens', 'stage', 'autre']), required: true },
      { key: 'date_debut', label: 'Du', type: 'date', required: true },
      { key: 'date_fin', label: 'Au (inclus)', type: 'date', required: true },
      { key: 'id_classe', label: 'Classe concernée', type: 'select', options: (db) => [{ value: '', label: "— Tout l'établissement —" }, ...opt.classe(db)], hint: 'Vide = aucun cours pour personne pendant la période' },
    ],
    search: (r) => `${r.libelle} ${r.type_conge}`,
    validate: (r) => (r.date_fin < r.date_debut ? 'La date de fin doit suivre la date de début.' : null),
  },
  {
    id: 'utilisateurs', label: 'Utilisateurs', singulier: 'utilisateur', groupe: 'Accès', table: 'utilisateur', pk: 'id_utilisateur', identity: true,
    columns: [
      { label: 'Identifiant', render: (r) => <span className="font-mono text-xs">{r.login}</span> },
      { label: 'E-mail', render: (r) => r.email },
      { label: 'Rôle', render: (r) => <Badge tone="navy">{r.role}</Badge> },
    ],
    fields: [
      { key: 'login', label: 'Identifiant', type: 'text', required: true, unique: true },
      { key: 'email', label: 'E-mail', type: 'email', required: true, unique: true },
      { key: 'role', label: 'Rôle', type: 'select', options: opt.enumOf(['administrateur', 'planificateur']), required: true, hint: "Enseignants et étudiants consultent sans compte (espace invités). Pour qu'un compte puisse se connecter, il doit être invité depuis la console Ultraplanning (super admin)." },
    ],
    search: (r) => `${r.login} ${r.email} ${r.role}`,
    restrict: (r, db) => refus(db.emploi_du_temps.filter((e) => e.id_utilisateur === r.id_utilisateur).length + db.conversation.filter((c) => c.id_utilisateur === r.id_utilisateur).length, 'emploi du temps ou discussion'),
  },
]
