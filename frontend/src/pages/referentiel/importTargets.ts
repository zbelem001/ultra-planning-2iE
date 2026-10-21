import type { Collection, Db } from '../../types';

// Gabarits d'import (BF-07 et reprise des données, §7 du cahier des charges).
// Chaque gabarit sait convertir une ligne CSV en élément et lister ses erreurs.

export type Row = Record<string, string>;

export interface ImportTarget {
  id: string;
  label: string;
  collection: Collection;
  headers: string[];
  example: string[][];
  /** Clé d'unicité (code, matricule…) pour repérer les doublons. */
  key: (row: Row) => string;
  existingKeys: (db: Db) => Set<string>;
  convert: (row: Row, db: Db) => { item?: Record<string, unknown>; erreurs: string[] };
}

const lower = (s: string) => s.trim().toLowerCase();

function required(row: Row, fields: string[], erreurs: string[]) {
  for (const f of fields) if (!row[f]?.trim()) erreurs.push(`« ${f} » est vide`);
}

function positiveInt(value: string, label: string, erreurs: string[], allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) erreurs.push(`« ${label} » doit être un entier ${allowZero ? '≥ 0' : '> 0'}`);
  return n;
}

function lookup<T extends { id: number }>(
  list: T[],
  value: string,
  match: (x: T) => string,
  label: string,
  erreurs: string[],
): number {
  const found = list.find((x) => lower(match(x)) === lower(value));
  if (value.trim() && !found) erreurs.push(`${label} « ${value} » inconnu`);
  return found?.id ?? 0;
}

export const IMPORT_TARGETS: ImportTarget[] = [
  {
    id: 'salles',
    label: 'Salles',
    collection: 'salles',
    headers: ['code', 'nom', 'capacite', 'etage', 'batiment', 'type_salle'],
    example: [
      ['B-301', 'Salle B301', '40', '3', 'B', 'Salle de TD'],
      ['A-AMPHI3', 'Amphi Bobo', '200', '0', 'A', 'Amphithéâtre'],
    ],
    key: (r) => lower(r.code ?? ''),
    existingKeys: (db) => new Set(db.salles.map((s) => lower(s.code))),
    convert: (r, db) => {
      const erreurs: string[] = [];
      required(r, ['code', 'nom', 'capacite', 'batiment', 'type_salle'], erreurs);
      const item = {
        code: r.code.trim(),
        nom: r.nom.trim(),
        capacite: positiveInt(r.capacite, 'capacite', erreurs),
        etage: r.etage?.trim() ? positiveInt(r.etage, 'etage', erreurs, true) : 0,
        batimentId: lookup(db.batiments, r.batiment, (b) => b.code, 'Bâtiment', erreurs),
        typeSalleId: lookup(db.typesSalle, r.type_salle, (t) => t.libelle, 'Type de salle', erreurs),
      };
      return { item, erreurs };
    },
  },
  {
    id: 'cours',
    label: 'Cours',
    collection: 'cours',
    headers: ['code', 'intitule', 'ects', 'semestre', 'departement'],
    example: [['GEN510', 'Gestion de projet', '3', 'S9', 'INF']],
    key: (r) => lower(r.code ?? ''),
    existingKeys: (db) => new Set(db.cours.map((c) => lower(c.code))),
    convert: (r, db) => {
      const erreurs: string[] = [];
      required(r, ['code', 'intitule', 'ects', 'semestre', 'departement'], erreurs);
      if (r.semestre && !/^S([1-9]|10)$/.test(r.semestre.trim())) erreurs.push('« semestre » doit valoir S1 à S10');
      const item = {
        code: r.code.trim(),
        intitule: r.intitule.trim(),
        ects: positiveInt(r.ects, 'ects', erreurs, true),
        semestre: r.semestre.trim(),
        departementId: lookup(db.departements, r.departement, (d) => d.code, 'Département', erreurs),
      };
      return { item, erreurs };
    },
  },
  {
    id: 'enseignants',
    label: 'Enseignants',
    collection: 'enseignants',
    headers: ['matricule', 'nom', 'prenom', 'grade', 'email', 'telephone', 'departement'],
    example: [['ENS-0101', 'Sanou', 'Rasmata', 'Maître assistante', 'rasmata.sanou@2ie-edu.org', '+226 70 00 01 01', 'EAE']],
    key: (r) => lower(r.matricule ?? ''),
    existingKeys: (db) => new Set(db.enseignants.map((e) => lower(e.matricule))),
    convert: (r, db) => {
      const erreurs: string[] = [];
      required(r, ['matricule', 'nom', 'prenom', 'email', 'departement'], erreurs);
      if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim())) erreurs.push('« email » invalide');
      const item = {
        matricule: r.matricule.trim(),
        nom: r.nom.trim(),
        prenom: r.prenom.trim(),
        grade: r.grade?.trim() ?? '',
        email: r.email.trim(),
        telephone: r.telephone?.trim() ?? '',
        departementId: lookup(db.departements, r.departement, (d) => d.code, 'Département', erreurs),
      };
      return { item, erreurs };
    },
  },
  {
    id: 'groupes',
    label: 'Groupes',
    collection: 'groupes',
    headers: ['code', 'effectif', 'filiere'],
    example: [['M1-GCH-TP1', '19', 'M1-GCH']],
    key: (r) => lower(r.code ?? ''),
    existingKeys: (db) => new Set(db.groupes.map((g) => lower(g.code))),
    convert: (r, db) => {
      const erreurs: string[] = [];
      required(r, ['code', 'effectif', 'filiere'], erreurs);
      const item = {
        code: r.code.trim(),
        effectif: positiveInt(r.effectif, 'effectif', erreurs),
        filiereId: lookup(db.filieres, r.filiere, (f) => f.code, 'Filière', erreurs),
      };
      return { item, erreurs };
    },
  },
];
