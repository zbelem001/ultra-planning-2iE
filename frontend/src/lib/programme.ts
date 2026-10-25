// Programme (maquettes pédagogiques) : contrôle CD-07 et couverture des
// volumes prévus par les cours existants.

import type { Db, Programme, TypeSeance } from '@/types/db'

export function ligneProgramme(db: Db, id_classe: number, id_matiere: number, id_semestre: number): Programme | undefined {
  return db.programme.find((p) => p.id_classe === id_classe && p.id_matiere === id_matiere && p.id_semestre === id_semestre)
}

export function volumeType(p: Programme | undefined, type: TypeSeance): number {
  if (!p) return 0
  return type === 'CM' ? p.volume_cm : type === 'TD' ? p.volume_td : p.volume_tp
}

/** CD-07 : motif de refus d'un cours au regard du programme, ou null */
export function controleProgramme(
  db: Db,
  c: { id_classe: number; id_matiere: number; id_semestre: number; type_cours: TypeSeance; volume_horaire: number },
): string | null {
  const prevu = volumeType(ligneProgramme(db, c.id_classe, c.id_matiere, c.id_semestre), c.type_cours)
  const classe = db.classe.find((x) => x.id_classe === c.id_classe)?.code_classe
  const matiere = db.matiere.find((x) => x.id_matiere === c.id_matiere)?.libelle
  if (!prevu) return `CD-07 : ${matiere} n'est pas au programme de ${classe} en ${c.type_cours} pour ce semestre. Ajoutez-la dans Référentiel › Programme.`
  if (c.volume_horaire > prevu) return `CD-07 : le volume du cours (${c.volume_horaire} h) dépasse le volume prévu au programme (${prevu} h).`
  return null
}

export interface Ecart {
  id_programme: number
  id_classe: number
  id_matiere: number
  type: TypeSeance
  /** Public concerné : la classe entière, ou un groupe de TD / TP */
  public: string
  prevu: number
  couvert: number
}

/**
 * Pour chaque ligne du programme et chaque type prévu, heures couvertes par
 * les cours, public par public : la classe pour un CM ; chaque groupe du type
 * pour un TD ou un TP (la classe entière si elle n'a pas de tels groupes).
 */
export function couverture(db: Db, id_semestre?: number): Ecart[] {
  const out: Ecart[] = []
  for (const p of db.programme) {
    if (id_semestre !== undefined && p.id_semestre !== id_semestre) continue
    const classe = db.classe.find((c) => c.id_classe === p.id_classe)
    if (!classe) continue
    const cours = db.cours.filter((c) => c.id_classe === p.id_classe && c.id_matiere === p.id_matiere && c.id_semestre === p.id_semestre)
    for (const type of ['CM', 'TD', 'TP'] as TypeSeance[]) {
      const prevu = volumeType(p, type)
      if (!prevu) continue
      const groupes = type === 'CM' ? [] : db.groupe.filter((g) => g.id_classe === p.id_classe && g.type_groupe === type)
      const publics = groupes.length ? groupes.map((g) => ({ id: g.id_groupe as number | null, nom: `${classe.code_classe} · ${g.code_groupe}` })) : [{ id: null, nom: classe.code_classe }]
      for (const pub of publics) {
        const couvert = cours
          .filter((c) => c.type_cours === type && (c.id_groupe === null || c.id_groupe === pub.id))
          .reduce((a, c) => a + c.volume_horaire, 0)
        out.push({ id_programme: p.id_programme, id_classe: p.id_classe, id_matiere: p.id_matiere, type, public: pub.nom, prevu, couvert })
      }
    }
  }
  return out
}
