import { byId } from '../store/DataContext';
import type { CodeCD, Db, Seance } from '../types';
import { dureeHeures, groupesLies, heuresPrevues, semestreActif } from './planning';

// Contrôle d'une séance contre les contraintes dures CD-01 à CD-09 (§4.1).
// La même fonction sert à la grille (BF-12), aux propositions (BF-13) et au
// moteur de génération ; en production, la base revérifie par déclencheur.

export interface Violation {
  code: CodeCD;
  message: string;
}

export type SeanceCandidate = Omit<Seance, 'id'> & { id: number };

export function verifierSeance(db: Db, s: SeanceCandidate, seances: Seance[] = db.seances): Violation[] {
  const v: Violation[] = [];
  const autres = seances.filter((x) => x.id !== s.id || s.id === 0);
  const cours = db.cours.find((x) => x.id === s.coursId);
  const type = db.typesSeance.find((x) => x.id === s.typeSeanceId);
  const groupe = db.groupes.find((x) => x.id === s.groupeId);
  const salle = db.salles.find((x) => x.id === s.salleId);
  const ens = db.enseignants.find((x) => x.id === s.enseignantId);
  const creneau = db.creneaux.find((x) => x.id === s.creneauId);
  if (!cours || !type || !groupe || !salle || !ens || !creneau) {
    return [{ code: 'CD-09', message: 'Séance incomplète : cours, type, groupe, enseignant, salle et créneau sont obligatoires.' }];
  }
  const groupes = byId(db.groupes);
  const lieu = `${creneau.jour} ${creneau.debut}`;
  const memeCreneau = autres.filter((x) => x.creneauId === s.creneauId);

  // CD-01 — une séance par salle et par créneau
  const salleOccupee = memeCreneau.find((x) => x.salleId === s.salleId);
  if (salleOccupee) v.push({ code: 'CD-01', message: `La salle ${salle.code} est déjà occupée le ${lieu} (${groupes.get(salleOccupee.groupeId)?.code}).` });

  // CD-02 — une séance par enseignant et par créneau
  if (memeCreneau.some((x) => x.enseignantId === s.enseignantId)) {
    v.push({ code: 'CD-02', message: `${ens.prenom} ${ens.nom} anime déjà une séance le ${lieu}.` });
  }

  // CD-03 — une séance par groupe et par créneau (promotion et sous-groupes compris)
  const lies = new Set(groupesLies(db, s.groupeId));
  const conflitGroupe = memeCreneau.find((x) => lies.has(x.groupeId));
  if (conflitGroupe) {
    const autre = groupes.get(conflitGroupe.groupeId)?.code;
    v.push({
      code: 'CD-03',
      message:
        conflitGroupe.groupeId === s.groupeId
          ? `Le groupe ${groupe.code} a déjà une séance le ${lieu}.`
          : `Le groupe ${groupe.code} partage ses étudiants avec ${autre}, qui a déjà une séance le ${lieu}.`,
    });
  }

  // CD-04 — capacité
  if (salle.capacite < groupe.effectif) {
    v.push({ code: 'CD-04', message: `${salle.code} compte ${salle.capacite} places pour ${groupe.effectif} étudiants (${groupe.code}).` });
  }

  // CD-05 — type de salle exigé par le type de séance
  if (salle.typeSalleId !== type.typeSalleId) {
    const exige = db.typesSalle.find((t) => t.id === type.typeSalleId)?.libelle ?? '?';
    const actuel = db.typesSalle.find((t) => t.id === salle.typeSalleId)?.libelle ?? '?';
    v.push({ code: 'CD-05', message: `Un ${type.code} exige : ${exige.toLowerCase()} ; ${salle.code} est de type ${actuel.toLowerCase()}.` });
  }

  // CD-06 — habilitation et disponibilité de l'enseignant
  if (!db.habilitations.some((h) => h.enseignantId === s.enseignantId && h.coursId === s.coursId)) {
    v.push({ code: 'CD-06', message: `${ens.prenom} ${ens.nom} n’est pas habilité(e) pour ${cours.code}.` });
  }
  const dispo = db.disponibilites.find((d) => d.enseignantId === s.enseignantId && d.creneauId === s.creneauId);
  if (dispo?.niveau === 'indisponible') {
    v.push({ code: 'CD-06', message: `${ens.prenom} ${ens.nom} s’est déclaré(e) indisponible le ${lieu}.` });
  }

  // CD-07 — le cours est au programme de la filière du groupe
  if (!db.programmes.some((p) => p.filiereId === groupe.filiereId && p.coursId === s.coursId)) {
    v.push({ code: 'CD-07', message: `${cours.code} ne figure pas au programme de la filière de ${groupe.code}.` });
  }

  // CD-08 — le volume horaire prévu n'est pas dépassé
  const prevu = heuresPrevues(db, s.coursId, s.typeSeanceId);
  const creneaux = byId(db.creneaux);
  const hebdo =
    autres
      .filter((x) => x.coursId === s.coursId && x.typeSeanceId === s.typeSeanceId && x.groupeId === s.groupeId)
      .reduce((t, x) => t + dureeHeures(creneaux.get(x.creneauId)!), 0) + dureeHeures(creneau);
  if (prevu === 0) v.push({ code: 'CD-08', message: `Aucun volume horaire ${type.code} n’est prévu pour ${cours.code}.` });
  else if (hebdo > prevu) v.push({ code: 'CD-08', message: `${hebdo} h de ${type.code} par semaine dépassent les ${prevu} h prévues pour ${cours.code}.` });

  // CD-09 — dates du semestre : un semestre clôturé n'est plus modifiable,
  // et les éléments archivés ne peuvent plus être planifiés.
  const semestre = semestreActif(db);
  if (semestre?.statut === 'cloturee') v.push({ code: 'CD-09', message: `Le semestre ${semestre.code} est clôturé.` });
  const archives = [cours, groupe, salle, ens, creneau].filter((x) => x.archived);
  if (archives.length) v.push({ code: 'CD-09', message: 'Un des éléments de la séance est archivé.' });

  return v;
}

/** Salles qui conviennent à la séance sur son créneau, la plus ajustée d'abord (BF-13). */
export function sallesCompatibles(db: Db, s: SeanceCandidate, seances: Seance[] = db.seances) {
  return db.salles
    .filter((salle) => !salle.archived)
    .filter((salle) => verifierSeance(db, { ...s, salleId: salle.id }, seances).length === 0)
    .sort((a, b) => a.capacite - b.capacite);
}

export interface Proposition {
  creneauId: number;
  salleId?: number;
  violations: Violation[];
}

/**
 * Pour chaque créneau : la séance peut-elle y aller, et dans quelle salle ?
 * On garde la salle actuelle si elle convient, sinon on prend la plus ajustée.
 */
export function propositions(db: Db, s: SeanceCandidate, seances: Seance[] = db.seances): Map<number, Proposition> {
  const res = new Map<number, Proposition>();
  for (const c of db.creneaux.filter((x) => !x.archived)) {
    const ici = { ...s, creneauId: c.id };
    const actuelle = verifierSeance(db, ici, seances);
    if (actuelle.length === 0) {
      res.set(c.id, { creneauId: c.id, salleId: s.salleId, violations: [] });
      continue;
    }
    const salle = sallesCompatibles(db, ici, seances)[0];
    res.set(c.id, salle ? { creneauId: c.id, salleId: salle.id, violations: [] } : { creneauId: c.id, violations: actuelle });
  }
  return res;
}

/** Séances de la semaine type qui violent déjà une contrainte dure. */
export function anomalies(db: Db, seances: Seance[] = db.seances) {
  return seances
    .map((s) => ({ seance: s, violations: verifierSeance(db, s, seances) }))
    .filter((x) => x.violations.length > 0);
}
