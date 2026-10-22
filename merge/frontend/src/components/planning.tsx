import type { HTMLAttributes, ReactNode } from 'react';
import { formatJourCourt, dateDuJour } from '../lib/planning';
import { byId } from '../store/DataContext';
import { JOURS, type Creneau, type Db, type Jour, type Seance } from '../types';

// Composants partagés par la grille de planification (16), la validation (20)
// et la consultation (22). Même structure que la grille des disponibilités (14).

export function plagesHoraires(creneaux: Creneau[]): string[] {
  return Array.from(new Set(creneaux.filter((c) => !c.archived).map((c) => `${c.debut}-${c.fin}`))).sort();
}

export function WeekGrid({
  db,
  lundi,
  renderCell,
  cellProps,
  label,
}: {
  db: Db;
  /** Lundi de la semaine affichée ; absent = semaine type sans dates. */
  lundi?: string;
  renderCell: (creneau: Creneau) => ReactNode;
  cellProps?: (creneau: Creneau) => HTMLAttributes<HTMLTableCellElement>;
  label: string;
}) {
  const creneaux = db.creneaux.filter((c) => !c.archived);
  const jours = JOURS.filter((j) => creneaux.some((c) => c.jour === j));
  return (
    <div className="table-wrap">
      <table className="table grid-table week-grid" aria-label={label}>
        <thead>
          <tr>
            <th>Plage</th>
            {jours.map((j) => (
              <th key={j}>
                {j}
                {lundi && <span className="day-date">{formatJourCourt(dateDuJour(lundi, j)).replace(/^\S+\s/, '')}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plagesHoraires(creneaux).map((plage) => (
            <tr key={plage}>
              <th scope="row">{plage.replace('-', ' – ')}</th>
              {jours.map((jour) => {
                const c = creneaux.find((x) => x.jour === jour && `${x.debut}-${x.fin}` === plage);
                if (!c) return <td key={jour} className="slot slot-empty" />;
                const props = cellProps?.(c) ?? {};
                return (
                  <td key={jour} {...props} className={`slot ${props.className ?? ''}`}>
                    {renderCell(c)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Index pour afficher une séance sans refaire les jointures à chaque carte. */
export function indexer(db: Db) {
  return {
    cours: byId(db.cours),
    types: byId(db.typesSeance),
    groupes: byId(db.groupes),
    salles: byId(db.salles),
    enseignants: byId(db.enseignants),
    creneaux: byId(db.creneaux),
    batiments: byId(db.batiments),
  };
}

export type Index = ReturnType<typeof indexer>;

export function SeanceCard({
  seance,
  index,
  montrer = ['groupe', 'salle', 'enseignant'],
  className = '',
  children,
  ...rest
}: {
  seance: Seance;
  index: Index;
  montrer?: ('groupe' | 'salle' | 'enseignant')[];
  className?: string;
  children?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const cours = index.cours.get(seance.coursId);
  const type = index.types.get(seance.typeSeanceId);
  const ens = index.enseignants.get(seance.enseignantId);
  return (
    <div className={`seance-card type-${type?.code.toLowerCase() ?? 'x'} ${className}`} {...rest}>
      <span className="seance-head">
        <span className="badge">{type?.code}</span> <strong>{cours?.code}</strong>
        {seance.verrouillee && (
          <span className="lock" title="Séance verrouillée (BF-17)" aria-label="verrouillée">
            🔒
          </span>
        )}
      </span>
      <span className="seance-title">{cours?.intitule}</span>
      <span className="seance-meta">
        {montrer.includes('groupe') && <span>{index.groupes.get(seance.groupeId)?.code}</span>}
        {montrer.includes('salle') && <span>{index.salles.get(seance.salleId)?.code}</span>}
        {montrer.includes('enseignant') && ens && <span>{`${ens.prenom[0]}. ${ens.nom}`}</span>}
      </span>
      {children}
    </div>
  );
}

export function joursOuvres(db: Db): Jour[] {
  return JOURS.filter((j) => db.creneaux.some((c) => !c.archived && c.jour === j));
}

/** Jauge horizontale : la valeur est toujours écrite à côté. */
export function Jauge({
  valeur,
  max = 100,
  label,
  unite = '%',
  neutre = false,
}: {
  valeur: number;
  max?: number;
  label: string;
  unite?: string;
  /** Sans jugement : pas de couleur d'état (ex. taux d'occupation). */
  neutre?: boolean;
}) {
  const pct = max === 0 ? 0 : Math.min(100, (valeur / max) * 100);
  const etat = neutre || unite !== '%' ? 'neutre' : valeur >= 80 ? 'ok' : valeur >= 50 ? 'warn' : 'danger';
  return (
    <span className="jauge" title={label}>
      <span className={`jauge-track jauge-${etat}`} aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="jauge-value">
        {valeur}
        {unite === '%' ? ' %' : ` ${unite}`}
      </span>
    </span>
  );
}
