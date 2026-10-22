import { byId } from '../store/DataContext';
import { JOURS, type Creneau, type Db, type Jour, type Seance, type Semestre, type VersionEdt } from '../types';

// Calendrier du semestre, besoins en séances et comparaison de versions.
// Toutes les dates sont manipulées en UTC : Ouagadougou est à UTC+0 sans heure d'été.

const JOUR_MS = 86_400_000;

function parseIso(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function ajouterJours(iso: string, jours: number): string {
  return toIso(parseIso(iso) + jours * JOUR_MS);
}

/** Lundi de la semaine qui contient la date. */
export function lundiDe(iso: string): string {
  const jour = new Date(parseIso(iso)).getUTCDay(); // 0 = dimanche
  return ajouterJours(iso, jour === 0 ? -6 : 1 - jour);
}

export function jourDeDate(iso: string): Jour | null {
  const jour = new Date(parseIso(iso)).getUTCDay();
  return jour === 0 ? null : JOURS[jour - 1];
}

export function dateDuJour(lundi: string, jour: Jour): string {
  return ajouterJours(lundi, JOURS.indexOf(jour));
}

export function formatJourCourt(iso: string): string {
  return new Date(parseIso(iso)).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function formatDateCourte(iso: string): string {
  return new Date(parseIso(iso)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Lundis des semaines du semestre, de sa date de début à sa date de fin. */
export function semainesDuSemestre(semestre: Semestre): string[] {
  const res: string[] = [];
  const fin = parseIso(semestre.fin);
  for (let ms = parseIso(lundiDe(semestre.debut)); ms <= fin; ms += 7 * JOUR_MS) res.push(toIso(ms));
  return res;
}

export function dureeHeures(c: Creneau): number {
  const min = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return (min(c.fin) - min(c.debut)) / 60;
}

// ---------- Référentiel ----------

export function parametres(db: Db) {
  return db.parametres[0];
}

export function semestreActif(db: Db): Semestre | undefined {
  return db.semestres.find((s) => s.id === parametres(db)?.semestreActifId);
}

export function libelleSemestre(db: Db, semestre: Semestre | undefined): string {
  if (!semestre) return '—';
  const annee = db.annees.find((a) => a.id === semestre.anneeId);
  return `${semestre.code} ${annee?.libelle ?? ''}`.trim();
}

export function heuresPrevues(db: Db, coursId: number, typeSeanceId: number): number {
  return db.volumes.find((v) => v.coursId === coursId && v.typeSeanceId === typeSeanceId)?.heures ?? 0;
}

/**
 * Groupes qui partagent des étudiants. Le MLD ne relie pas les groupes entre eux :
 * on suppose que le plus grand groupe d'une filière est la promotion entière et
 * qu'il contient tous les autres (L1-ING-A contient L1-ING-TD1 et TD2).
 */
export function groupesLies(db: Db, groupeId: number): number[] {
  const groupe = db.groupes.find((g) => g.id === groupeId);
  if (!groupe) return [groupeId];
  const freres = db.groupes.filter((g) => !g.archived && g.filiereId === groupe.filiereId);
  const promo = freres.reduce((a, b) => (b.effectif > a.effectif ? b : a), groupe);
  if (freres.length <= 1) return [groupeId];
  return promo.id === groupeId ? freres.map((g) => g.id) : [groupeId, promo.id];
}

export function departementDuGroupe(db: Db, groupeId: number): number | undefined {
  const g = db.groupes.find((x) => x.id === groupeId);
  return db.filieres.find((f) => f.id === g?.filiereId)?.departementId;
}

export interface Demande {
  coursId: number;
  typeSeanceId: number;
  groupeId: number;
  /** Nombre de séances hebdomadaires nécessaires pour couvrir le volume. */
  parSemaine: number;
}

/**
 * Séances à planifier chaque semaine : cours du programme de la filière × types
 * de séance qui ont un volume horaire. Le CM va à la promotion, les TD et TP aux
 * sous-groupes quand la filière en a.
 */
export function demandes(db: Db, departementId?: number): Demande[] {
  const semestre = semestreActif(db);
  const nbSemaines = semestre ? nbSemainesEffectives(db, semestre) : 14;
  const res: Demande[] = [];
  for (const f of db.filieres.filter((x) => !x.archived && (!departementId || x.departementId === departementId))) {
    const groupes = db.groupes.filter((g) => !g.archived && g.filiereId === f.id);
    if (groupes.length === 0) continue;
    const promo = groupes.reduce((a, b) => (b.effectif > a.effectif ? b : a));
    const sousGroupes = groupes.length > 1 ? groupes.filter((g) => g.id !== promo.id) : [promo];
    const cours = db.programmes.filter((p) => p.filiereId === f.id).map((p) => p.coursId);
    for (const coursId of cours) {
      if (db.cours.find((c) => c.id === coursId)?.archived) continue;
      for (const v of db.volumes.filter((x) => x.coursId === coursId && x.heures > 0)) {
        const type = db.typesSeance.find((t) => t.id === v.typeSeanceId);
        const cibles = type?.code === 'CM' ? [promo] : sousGroupes;
        // La grille 2iE n'a que des créneaux de 2 h.
        const parSemaine = Math.max(1, Math.ceil(v.heures / (2 * nbSemaines)));
        for (const g of cibles) res.push({ coursId, typeSeanceId: v.typeSeanceId, groupeId: g.id, parSemaine });
      }
    }
  }
  return res;
}

// ---------- Semestre : duplication de la semaine type (BF-14) ----------

export function derniereDuplication(db: Db, semestreId: number) {
  return [...db.duplications].filter((d) => d.semestreId === semestreId).sort((a, b) => b.date.localeCompare(a.date))[0];
}

export function semainesDeCours(db: Db, semestre: Semestre, exclues?: string[]): string[] {
  const sans = new Set(exclues ?? derniereDuplication(db, semestre.id)?.semainesExclues ?? []);
  return semainesDuSemestre(semestre).filter((l) => !sans.has(l));
}

export function nbSemainesEffectives(db: Db, semestre: Semestre): number {
  return semainesDeCours(db, semestre).length;
}

export interface Occurrence {
  seance: Seance;
  date: string; // ISO date
  debut: string;
  fin: string;
}

/**
 * Séances datées du semestre : la semaine type répétée sur chaque semaine de cours.
 * Une série (cours, type, groupe) s'arrête dès que son volume prévu est atteint
 * (CD-08), et chaque date tombe le bon jour, dans les dates du semestre (CD-09).
 */
export function occurrences(db: Db, seances: Seance[], semestre: Semestre, exclues?: string[]): Occurrence[] {
  const creneaux = byId(db.creneaux);
  const semaines = semainesDeCours(db, semestre, exclues);
  const brut: Occurrence[] = [];
  for (const lundi of semaines) {
    for (const s of seances) {
      const c = creneaux.get(s.creneauId);
      if (!c) continue;
      const date = dateDuJour(lundi, c.jour);
      if (date < semestre.debut || date > semestre.fin) continue;
      brut.push({ seance: s, date, debut: c.debut, fin: c.fin });
    }
  }
  brut.sort((a, b) => a.date.localeCompare(b.date) || a.debut.localeCompare(b.debut));

  const cumul = new Map<string, number>();
  return brut.filter((o) => {
    const s = o.seance;
    const cle = `${s.coursId}-${s.typeSeanceId}-${s.groupeId}`;
    const heures = dureeHeures(creneaux.get(s.creneauId)!);
    const total = (cumul.get(cle) ?? 0) + heures;
    if (total > heuresPrevues(db, s.coursId, s.typeSeanceId)) return false;
    cumul.set(cle, total);
    return true;
  });
}

// ---------- Versions (BF-19) ----------

export function versionPubliee(db: Db, semestreId: number): VersionEdt | undefined {
  return db.versions.find((v) => v.semestreId === semestreId && v.statut === 'publiee');
}

export interface Ecart {
  avant?: Seance;
  apres?: Seance;
  champs: (keyof Seance)[];
}

const CHAMPS_COMPARES: (keyof Seance)[] = ['coursId', 'typeSeanceId', 'groupeId', 'enseignantId', 'salleId', 'creneauId'];

/** Séances ajoutées, supprimées ou modifiées entre deux états de la semaine type. */
export function comparer(avant: Seance[], apres: Seance[]): Ecart[] {
  const a = byId(avant);
  const b = byId(apres);
  const res: Ecart[] = [];
  for (const s of avant) {
    const n = b.get(s.id);
    if (!n) res.push({ avant: s, champs: [] });
    else {
      const champs = CHAMPS_COMPARES.filter((k) => s[k] !== n[k]);
      if (champs.length) res.push({ avant: s, apres: n, champs });
    }
  }
  for (const s of apres) if (!a.has(s.id)) res.push({ apres: s, champs: [] });
  return res;
}

export function decrireSeance(db: Db, s: Seance): string {
  const c = db.cours.find((x) => x.id === s.coursId);
  const t = db.typesSeance.find((x) => x.id === s.typeSeanceId);
  const g = db.groupes.find((x) => x.id === s.groupeId);
  const cr = db.creneaux.find((x) => x.id === s.creneauId);
  const salle = db.salles.find((x) => x.id === s.salleId);
  return `${c?.code ?? '?'} ${t?.code ?? ''} · ${g?.code ?? '?'} · ${cr ? `${cr.jour} ${cr.debut}` : '?'} · ${salle?.code ?? '?'}`;
}

export function nomEnseignant(db: Db, id: number): string {
  const e = db.enseignants.find((x) => x.id === id);
  return e ? `${e.prenom} ${e.nom}` : '—';
}
