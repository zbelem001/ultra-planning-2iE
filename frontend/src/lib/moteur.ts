import { byId } from '../store/DataContext';
import { CODES_CS, type CodeCD, type Db, type Generation, type Poids, type Seance, type SeanceNonPlacee } from '../types';
import { verifierSeance, type Violation } from './contraintes';
import { departementDuGroupe, demandes, dureeHeures, groupesLies, parametres } from './planning';

// Moteur de génération simulé (BF-15 à BF-18). Le vrai moteur sera un modèle
// OR-Tools CP-SAT exécuté par une tâche Celery ; celui-ci est une heuristique
// gloutonne déterministe qui donne des résultats plausibles pour la démonstration :
// - toutes les contraintes dures passent par verifierSeance, comme dans la grille ;
// - les séances verrouillées et celles hors périmètre restent en place (BF-17) ;
// - les contraintes souples sont des pénalités pondérées par les poids choisis (BF-16) ;
// - chaque séance non placée est expliquée par sa contrainte bloquante (BF-18).

export type ResultatGeneration = NonNullable<Generation['resultat']>;

export function genererEmploiDuTemps(db: Db, gen: Pick<Generation, 'departementId' | 'poids'>): ResultatGeneration {
  const dansPerimetre = (groupeId: number) => !gen.departementId || departementDuGroupe(db, groupeId) === gen.departementId;
  const fixes = db.seances.filter((s) => s.verrouillee || !dansPerimetre(s.groupeId));
  const placees: Seance[] = [...fixes];
  const nonPlacees: SeanceNonPlacee[] = [];
  let prochainId = db.seances.reduce((m, s) => Math.max(m, s.id), 0) + 1;

  // Besoins restants une fois retirées les séances déjà fixées
  const aPlacer: { coursId: number; typeSeanceId: number; groupeId: number }[] = [];
  const toutes = demandes(db, gen.departementId);
  for (const d of toutes) {
    const deja = fixes.filter((s) => s.coursId === d.coursId && s.typeSeanceId === d.typeSeanceId && s.groupeId === d.groupeId).length;
    for (let i = deja; i < d.parSemaine; i++) aPlacer.push(d);
  }

  const groupes = byId(db.groupes);
  const types = byId(db.typesSeance);
  const creneaux = db.creneaux.filter((c) => !c.archived);
  const salles = db.salles.filter((s) => !s.archived);
  const habilites = (coursId: number) =>
    db.habilitations.filter((h) => h.coursId === coursId).map((h) => h.enseignantId).filter((id) => !db.enseignants.find((e) => e.id === id)?.archived);

  // Diagnostic structurel : ces séances ne peuvent aller nulle part, quel que soit le créneau
  const diagnostic = (d: (typeof aPlacer)[number]): SeanceNonPlacee | null => {
    const groupe = groupes.get(d.groupeId)!;
    const type = types.get(d.typeSeanceId)!;
    const typeSalle = db.typesSalle.find((t) => t.id === type.typeSalleId)?.libelle.toLowerCase() ?? '?';
    const duType = salles.filter((s) => s.typeSalleId === type.typeSalleId);
    if (habilites(d.coursId).length === 0) {
      return { ...d, contrainte: 'CD-06', motif: 'Aucun enseignant n’est habilité pour ce cours.', suggestion: 'Ajouter une habilitation (fiche enseignant).' };
    }
    if (duType.length === 0) {
      return { ...d, contrainte: 'CD-05', motif: `Aucune salle de type ${typeSalle}.`, suggestion: 'Créer une salle de ce type ou changer le type exigé.' };
    }
    const max = Math.max(...duType.map((s) => s.capacite));
    if (max < groupe.effectif) {
      return {
        ...d,
        contrainte: 'CD-04',
        motif: `La plus grande salle de type ${typeSalle} compte ${max} places pour ${groupe.effectif} étudiants.`,
        suggestion: `Scinder ${groupe.code} en ${Math.ceil(groupe.effectif / max)} sous-groupes ou ajouter une salle plus grande.`,
      };
    }
    return null;
  };

  const candidats = (d: (typeof aPlacer)[number]) => {
    const ok: Seance[] = [];
    const refus: Violation[] = [];
    for (const c of creneaux) {
      for (const enseignantId of habilites(d.coursId)) {
        for (const salle of salles) {
          const s = { id: 0, ...d, enseignantId, salleId: salle.id, creneauId: c.id };
          const v = verifierSeance(db, s, placees);
          if (v.length === 0) ok.push(s);
          else refus.push(...v);
        }
      }
    }
    return { ok, refus };
  };

  // Les séances aux options les plus rares d'abord ; à égalité, CM avant TD/TP (CS-05)
  const ordre = aPlacer
    .map((d) => ({ d, n: diagnostic(d) ? 0 : candidats(d).ok.length }))
    .sort((a, b) => a.n - b.n || a.d.typeSeanceId - b.d.typeSeanceId);

  for (const { d } of ordre) {
    const bloque = diagnostic(d);
    if (bloque) {
      nonPlacees.push(bloque);
      continue;
    }
    const { ok, refus } = candidats(d);
    if (ok.length === 0) {
      nonPlacees.push(expliquer(d, refus));
      continue;
    }
    const meilleur = ok
      .map((s) => ({ s, cout: penalite(db, s, placees, gen.poids) }))
      .sort((a, b) => a.cout - b.cout || a.s.creneauId - b.s.creneauId)[0].s;
    placees.push({ ...meilleur, id: prochainId++ });
  }

  return {
    seances: placees,
    nonPlacees,
    verrouillees: fixes.filter((s) => s.verrouillee).length,
    demandes: aPlacer.length,
    satisfaction: satisfaction(db, placees),
  };
}

/** La contrainte qui a bloqué le plus de candidats est désignée comme bloquante. */
function expliquer(d: { coursId: number; typeSeanceId: number; groupeId: number }, refus: Violation[]): SeanceNonPlacee {
  const compte = new Map<CodeCD, number>();
  for (const v of refus) compte.set(v.code, (compte.get(v.code) ?? 0) + 1);
  const [code] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['CD-01'];
  const exemple = refus.find((v) => v.code === code)?.message ?? '';
  const suggestions: Partial<Record<CodeCD, string>> = {
    'CD-01': 'Libérer une salle ou ouvrir un créneau supplémentaire.',
    'CD-02': 'Habiliter un autre enseignant pour ce cours.',
    'CD-03': 'Déplacer une séance du groupe ou ouvrir le samedi.',
    'CD-06': 'Demander à l’enseignant d’élargir ses disponibilités.',
    'CD-08': 'Vérifier le volume horaire prévu.',
  };
  return { ...d, contrainte: code, motif: `Aucun créneau libre. Exemple de refus : ${exemple}`, suggestion: suggestions[code] ?? 'Assouplir les contraintes du référentiel.' };
}

/** Coût d'un placement pour les contraintes souples, pondéré par les poids (0 à 10). */
function penalite(db: Db, s: Seance, placees: Seance[], poids: Poids): number {
  const creneaux = byId(db.creneaux);
  const salles = byId(db.salles);
  const c = creneaux.get(s.creneauId)!;
  const plages = [...new Set(db.creneaux.map((x) => x.debut))].sort();
  const rang = (id: number) => plages.indexOf(creneaux.get(id)!.debut);
  const lies = new Set(groupesLies(db, s.groupeId));
  const memeJourGroupe = placees.filter((x) => lies.has(x.groupeId) && creneaux.get(x.creneauId)?.jour === c.jour);
  let cout = 0;

  // CS-01 — préférence de l'enseignant
  const dispo = db.disponibilites.find((x) => x.enseignantId === s.enseignantId && x.creneauId === s.creneauId);
  if (dispo?.niveau !== 'preference') cout += poids['CS-01'];

  // CS-02 — trous dans la journée du groupe
  const rangs = [...memeJourGroupe.map((x) => rang(x.creneauId)), rang(s.creneauId)].sort((a, b) => a - b);
  const trous = rangs.length > 1 ? rangs[rangs.length - 1] - rangs[0] + 1 - rangs.length : 0;
  cout += poids['CS-02'] * trous;

  // CS-03 — changement de bâtiment avec une séance adjacente
  const batiment = salles.get(s.salleId)?.batimentId;
  for (const x of memeJourGroupe) {
    if (Math.abs(rang(x.creneauId) - rang(s.creneauId)) === 1 && salles.get(x.salleId)?.batimentId !== batiment) cout += poids['CS-03'];
  }

  // CS-04 — deux séances du même cours le même jour
  if (memeJourGroupe.some((x) => x.coursId === s.coursId)) cout += poids['CS-04'];

  // CS-05 — TD/TP placé avant le CM du cours
  const jourIndex = (id: number) => db.creneaux.findIndex((x) => x.id === id);
  const cm = db.typesSeance.find((t) => t.code === 'CM')?.id;
  if (s.typeSeanceId !== cm) {
    const cmDuCours = placees.find((x) => x.coursId === s.coursId && x.typeSeanceId === cm && lies.has(x.groupeId));
    if (cmDuCours && jourIndex(cmDuCours.creneauId) > jourIndex(s.creneauId)) cout += poids['CS-05'];
  }

  // CS-06 — heures maximales par jour pour l'enseignant
  const heuresJour =
    placees.filter((x) => x.enseignantId === s.enseignantId && creneaux.get(x.creneauId)?.jour === c.jour).reduce((t, x) => t + dureeHeures(creneaux.get(x.creneauId)!), 0) +
    dureeHeures(c);
  if (heuresJour > (parametres(db)?.heuresMaxJour ?? 6)) cout += poids['CS-06'] * 3;

  // Départage : la salle la plus ajustée à l'effectif
  const groupe = db.groupes.find((g) => g.id === s.groupeId);
  cout += ((salles.get(s.salleId)?.capacite ?? 0) - (groupe?.effectif ?? 0)) / 1000;
  return cout;
}

/** Taux de respect de chaque contrainte souple dans une semaine type (0 à 100). */
export function satisfaction(db: Db, seances: Seance[]): Poids {
  const creneaux = byId(db.creneaux);
  const salles = byId(db.salles);
  const plages = [...new Set(db.creneaux.map((x) => x.debut))].sort();
  const rang = (id: number) => plages.indexOf(creneaux.get(id)!.debut);
  const pct = (ok: number, total: number) => (total === 0 ? 100 : Math.round((ok / total) * 100));
  const parGroupeJour = new Map<string, Seance[]>();
  for (const s of seances) {
    const cle = `${s.groupeId}-${creneaux.get(s.creneauId)?.jour}`;
    parGroupeJour.set(cle, [...(parGroupeJour.get(cle) ?? []), s]);
  }
  const journees = [...parGroupeJour.values()];

  const avecPref = new Set(db.disponibilites.filter((d) => d.niveau === 'preference').map((d) => d.enseignantId));
  const concernees = seances.filter((s) => avecPref.has(s.enseignantId));
  const surPref = concernees.filter((s) => db.disponibilites.some((d) => d.enseignantId === s.enseignantId && d.creneauId === s.creneauId && d.niveau === 'preference'));

  const sansTrou = journees.filter((j) => {
    const r = j.map((s) => rang(s.creneauId)).sort((a, b) => a - b);
    return r[r.length - 1] - r[0] + 1 === r.length;
  });

  let paires = 0;
  let memeBatiment = 0;
  for (const j of journees) {
    const tri = [...j].sort((a, b) => rang(a.creneauId) - rang(b.creneauId));
    for (let i = 1; i < tri.length; i++) {
      if (rang(tri[i].creneauId) - rang(tri[i - 1].creneauId) !== 1) continue;
      paires++;
      if (salles.get(tri[i].salleId)?.batimentId === salles.get(tri[i - 1].salleId)?.batimentId) memeBatiment++;
    }
  }

  const sansDoublon = journees.filter((j) => new Set(j.map((s) => s.coursId)).size === j.length);

  const cm = db.typesSeance.find((t) => t.code === 'CM')?.id;
  const autres = seances.filter((s) => s.typeSeanceId !== cm);
  const index = (id: number) => db.creneaux.findIndex((x) => x.id === id);
  const apresCm = autres.filter((s) => {
    const lies = new Set(groupesLies(db, s.groupeId));
    const c = seances.find((x) => x.coursId === s.coursId && x.typeSeanceId === cm && lies.has(x.groupeId));
    return !c || index(c.creneauId) <= index(s.creneauId);
  });

  const max = parametres(db)?.heuresMaxJour ?? 6;
  const parEnsJour = new Map<string, number>();
  for (const s of seances) {
    const cle = `${s.enseignantId}-${creneaux.get(s.creneauId)?.jour}`;
    parEnsJour.set(cle, (parEnsJour.get(cle) ?? 0) + dureeHeures(creneaux.get(s.creneauId)!));
  }
  const charges = [...parEnsJour.values()];

  const res = {} as Poids;
  const valeurs = [
    pct(surPref.length, concernees.length),
    pct(sansTrou.length, journees.length),
    pct(memeBatiment, paires),
    pct(sansDoublon.length, journees.length),
    pct(apresCm.length, autres.length),
    pct(charges.filter((h) => h <= max).length, charges.length),
  ];
  CODES_CS.forEach((code, i) => (res[code] = valeurs[i]));
  return res;
}
