import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../../auth/AuthContext';
import { EmptyState, PageHeader } from '../../components/ui';
import { formatDateTime } from '../../lib/helpers';
import { demandes, libelleSemestre, parametres, semestreActif } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import { CODES_CS, CS_LABELS, type Generation, type Poids, type StatutGeneration } from '../../types';

// Page 18 — Lancer une génération (BF-15, BF-16, BF-17).
// Le planificateur choisit le périmètre et pondère les contraintes souples ;
// les séances verrouillées dans la grille sont conservées telles quelles.

export const STATUT_GENERATION: Record<StatutGeneration, { label: string; badge: string }> = {
  en_attente: { label: 'En file d’attente', badge: '' },
  en_cours: { label: 'En cours', badge: 'badge-warn' },
  terminee: { label: 'À examiner', badge: 'badge-accent' },
  acceptee: { label: 'Acceptée', badge: 'badge-ok' },
  rejetee: { label: 'Rejetée', badge: 'badge-danger' },
};

const NIVEAUX = [
  { max: 0, label: 'Ignorée' },
  { max: 3, label: 'Faible' },
  { max: 6, label: 'Moyen' },
  { max: 10, label: 'Élevé' },
];
const niveau = (p: number) => NIVEAUX.find((n) => p <= n.max)!.label;

export default function LancerGenerationPage() {
  const user = useCurrentUser();
  const { db, save } = useData();
  const navigate = useNavigate();
  const semestre = semestreActif(db);
  const defaut = parametres(db).poidsDefaut;
  const [departementId, setDepartementId] = useState(0);
  const [poids, setPoids] = useState<Poids>(defaut);

  const verrouillees = db.seances.filter((s) => s.verrouillee).length;
  const nbDemandes = demandes(db, departementId || undefined).reduce((t, d) => t + d.parSemaine, 0);
  const historique = [...db.generations].sort((a, b) => b.lancee.localeCompare(a.lancee));
  const enCours = db.generations.some((g) => g.statut === 'en_attente' || g.statut === 'en_cours');

  function lancer() {
    if (!semestre) return;
    const id = db.generations.reduce((m, g) => Math.max(m, g.id), 0) + 1;
    const gen: Generation = {
      id,
      semestreId: semestre.id,
      departementId: departementId || undefined,
      poids,
      auteurId: user.id,
      lancee: new Date().toISOString(),
      // Durée simulée de la tâche : quelques secondes, proportionnelles au problème
      dureeMs: 3000 + nbDemandes * 120,
      statut: 'en_attente',
    };
    save('generations', gen);
    navigate(`/generation/${id}`);
  }

  if (!semestre || semestre.statut === 'cloturee') {
    return (
      <>
        <PageHeader title="Générer un emploi du temps" refs="BF-15, BF-16" />
        <EmptyState>Le semestre actif est clôturé ou absent : choisissez-en un autre dans les paramètres.</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Générer un emploi du temps"
        description={`Moteur d’optimisation sous contraintes · ${libelleSemestre(db, semestre)}`}
        refs="BF-15, BF-16, BF-17"
      />

      <div className="grid-2">
        <section className="card">
          <h2>Périmètre</h2>
          <div className="form">
            <div className="field">
              <label htmlFor="gen-dep">Département</label>
              <select id="gen-dep" className="input" value={departementId} onChange={(e) => setDepartementId(Number(e.target.value))}>
                <option value={0}>Toute l’université</option>
                {db.departements
                  .filter((d) => !d.archived)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} — {d.libelle}
                    </option>
                  ))}
              </select>
            </div>
            <dl className="details">
              <dt>Séances hebdomadaires à placer</dt>
              <dd>{nbDemandes}</dd>
              <dt>Séances verrouillées conservées</dt>
              <dd>
                {verrouillees} <Link to="/planification">(gérer dans la grille)</Link>
              </dd>
              <dt>Contraintes dures</dt>
              <dd>CD-01 à CD-09, toujours respectées</dd>
            </dl>
            <p className="muted small">
              Les séances hors périmètre restent en place et comptent comme occupées. Les autres séances du périmètre sont recalculées.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="section-head">
            <h2>Poids des contraintes souples</h2>
            <button className="btn btn-small btn-ghost" onClick={() => setPoids(defaut)}>
              Poids par défaut
            </button>
          </div>
          <div className="form">
            {CODES_CS.map((code) => (
              <div className="field slider-field" key={code}>
                <label htmlFor={`poids-${code}`}>
                  <span className="badge">{code}</span> {CS_LABELS[code]}
                </label>
                <div className="slider-row">
                  <input
                    id={`poids-${code}`}
                    type="range"
                    min={0}
                    max={10}
                    value={poids[code]}
                    onChange={(e) => setPoids((p) => ({ ...p, [code]: Number(e.target.value) }))}
                  />
                  <output htmlFor={`poids-${code}`} className="slider-value">
                    {poids[code]} · {niveau(poids[code])}
                  </output>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="form-actions">
        {enCours && <span className="muted small">Une génération est déjà en cours.</span>}
        <button className="btn btn-primary" onClick={lancer} disabled={enCours || nbDemandes === 0}>
          Lancer la génération
        </button>
      </div>

      <section className="card">
        <h2>Historique des générations</h2>
        {historique.length === 0 ? (
          <EmptyState>Aucune génération lancée pour l’instant.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Lancée le</th>
                  <th>Périmètre</th>
                  <th className="num">Placement</th>
                  <th>Statut</th>
                  <th className="actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {historique.map((g) => {
                  const r = g.resultat;
                  return (
                    <tr key={g.id}>
                      <td>#{g.id}</td>
                      <td>{formatDateTime(g.lancee)}</td>
                      <td>{g.departementId ? db.departements.find((d) => d.id === g.departementId)?.code : 'Université'}</td>
                      <td className="num">{r ? `${tauxPlacement(r)} %` : '—'}</td>
                      <td>
                        <span className={`badge ${STATUT_GENERATION[g.statut].badge}`}>{STATUT_GENERATION[g.statut].label}</span>
                      </td>
                      <td className="actions-col">
                        <Link className="btn btn-small" to={`/generation/${g.id}`}>
                          Ouvrir
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export function tauxPlacement(r: NonNullable<Generation['resultat']>): number {
  return r.demandes === 0 ? 100 : Math.round(((r.demandes - r.nonPlacees.length) / r.demandes) * 100);
}
