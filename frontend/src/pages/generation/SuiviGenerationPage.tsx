import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { indexer, Jauge, SeanceCard, WeekGrid } from '../../components/planning';
import { EmptyState, PageHeader, StatCard } from '../../components/ui';
import { anomalies } from '../../lib/contraintes';
import { formatDateTime } from '../../lib/helpers';
import { genererEmploiDuTemps } from '../../lib/moteur';
import { comparer, groupesLies, libelleSemestre } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import { CODES_CS, CS_LABELS, type Generation } from '../../types';
import { STATUT_GENERATION, tauxPlacement } from './LancerGenerationPage';

// Page 19 — Suivi et résultat d'une génération (BF-18).
// La tâche Celery est simulée : la page interroge son avancement à intervalle
// régulier, comme elle le fera avec GET /generations/{id}. Le calcul s'exécute
// à la fin de la durée simulée ; quitter la page ne l'interrompt pas.

const ETAPES = [
  { jusqua: 0.15, label: 'Chargement du référentiel et des disponibilités' },
  { jusqua: 0.35, label: 'Construction du modèle (variables et contraintes CD-01 à CD-09)' },
  { jusqua: 0.9, label: 'Résolution et optimisation des contraintes souples' },
  { jusqua: 1, label: 'Rédaction du rapport des séances non placées' },
];

export default function SuiviGenerationPage() {
  const { id } = useParams();
  const { db, save, remove } = useData();
  const gen = db.generations.find((g) => g.id === Number(id));
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const enCours = gen?.statut === 'en_attente' || gen?.statut === 'en_cours';

  useEffect(() => {
    if (!enCours) return;
    const timer = setInterval(() => setMaintenant(Date.now()), 250);
    return () => clearInterval(timer);
  }, [enCours]);

  const ecoule = gen ? maintenant - new Date(gen.lancee).getTime() : 0;
  const avancement = gen ? Math.min(1, ecoule / gen.dureeMs) : 0;

  useEffect(() => {
    if (!gen || !enCours) return;
    if (avancement >= 1) save('generations', { ...gen, statut: 'terminee', resultat: genererEmploiDuTemps(db, gen) });
    else if (gen.statut === 'en_attente' && ecoule > 500) save('generations', { ...gen, statut: 'en_cours' });
  }, [gen, enCours, avancement, ecoule, db, save]);

  if (!gen) {
    return (
      <>
        <PageHeader title="Génération introuvable" />
        <Link to="/generation">Retour aux générations</Link>
      </>
    );
  }

  const semestre = db.semestres.find((s) => s.id === gen.semestreId);
  const perimetre = gen.departementId ? db.departements.find((d) => d.id === gen.departementId)?.code : 'toute l’université';

  return (
    <>
      <p className="breadcrumb">
        <Link to="/generation">Générations</Link> › #{gen.id}
      </p>
      <PageHeader
        title={`Génération #${gen.id}`}
        description={`${libelleSemestre(db, semestre)} · ${perimetre} · lancée le ${formatDateTime(gen.lancee)}`}
        refs="BF-15, BF-17, BF-18"
        actions={<span className={`badge ${STATUT_GENERATION[gen.statut].badge}`}>{STATUT_GENERATION[gen.statut].label}</span>}
      />

      {enCours ? (
        <Avancement avancement={avancement} gen={gen} />
      ) : gen.resultat ? (
        <Resultat
          gen={gen}
          onAccepter={() => {
            const r = gen.resultat!;
            const gardees = new Set(r.seances.map((s) => s.id));
            for (const s of db.seances) if (!gardees.has(s.id)) remove('seances', s.id);
            for (const s of r.seances) save('seances', s);
            save('generations', { ...gen, statut: 'acceptee' });
          }}
          onRejeter={() => save('generations', { ...gen, statut: 'rejetee' })}
        />
      ) : (
        <EmptyState>Aucun résultat pour cette génération.</EmptyState>
      )}
    </>
  );
}

function Avancement({ avancement, gen }: { avancement: number; gen: Generation }) {
  const pct = Math.round(avancement * 100);
  const etape = ETAPES.findIndex((e) => avancement <= e.jusqua);
  return (
    <section className="card">
      <h2>Calcul en cours</h2>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Avancement de la génération">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="muted">
        {pct} % · tâche Celery <code>generation-{gen.id}</code> · {gen.statut === 'en_attente' ? 'en file d’attente' : 'calcul en cours'}
      </p>
      <ol className="etapes">
        {ETAPES.map((e, i) => (
          <li key={e.label} className={i < etape ? 'done' : i === etape ? 'current' : ''}>
            {e.label}
          </li>
        ))}
      </ol>
      <p className="muted small">Vous pouvez quitter cette page : le calcul continue et le résultat vous attendra.</p>
    </section>
  );
}

function Resultat({ gen, onAccepter, onRejeter }: { gen: Generation; onAccepter: () => void; onRejeter: () => void }) {
  const { db } = useData();
  const r = gen.resultat!;
  const index = indexer(db);
  const groupes = [...new Set(r.seances.map((s) => s.groupeId))].map((id) => index.groupes.get(id)!).filter(Boolean);
  const [groupeId, setGroupeId] = useState(groupes[0]?.id ?? 0);
  const ecarts = comparer(db.seances, r.seances);
  const enAnomalie = anomalies(db, r.seances);
  const taux = tauxPlacement(r);
  const decide = gen.statut !== 'terminee';

  return (
    <>
      <div className="grid-4">
        <StatCard label="Taux de placement" value={`${taux} %`} hint={taux >= 95 ? 'Objectif de recette atteint (≥ 95 %)' : 'Objectif de recette : ≥ 95 %'} />
        <StatCard label="Séances placées" value={`${r.demandes - r.nonPlacees.length} / ${r.demandes}`} />
        <StatCard label="Verrouillées conservées" value={r.verrouillees} />
        <StatCard label="Changements" value={ecarts.length} hint="Par rapport à la semaine type actuelle" />
      </div>

      {enAnomalie.length > 0 && (
        <p className="notice">
          {enAnomalie.length} séance(s) verrouillée(s) ou hors périmètre violent déjà une contrainte dure ; la génération ne les a pas modifiées.
        </p>
      )}

      <section className="card">
        <h2>Séances non placées ({r.nonPlacees.length})</h2>
        {r.nonPlacees.length === 0 ? (
          <EmptyState>Toutes les séances ont été placées.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Séance</th>
                  <th>Groupe</th>
                  <th>Contrainte bloquante</th>
                  <th>Motif</th>
                  <th>Piste</th>
                </tr>
              </thead>
              <tbody>
                {r.nonPlacees.map((n, i) => (
                  <tr key={i}>
                    <td>
                      {index.cours.get(n.coursId)?.code} <span className="badge">{index.types.get(n.typeSeanceId)?.code}</span>
                    </td>
                    <td>{index.groupes.get(n.groupeId)?.code}</td>
                    <td>
                      <span className="badge badge-danger">{n.contrainte}</span>
                    </td>
                    <td>{n.motif}</td>
                    <td className="muted">{n.suggestion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Contraintes souples</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Contrainte</th>
                <th className="num">Poids</th>
                <th>Respect</th>
              </tr>
            </thead>
            <tbody>
              {CODES_CS.map((code) => (
                <tr key={code}>
                  <td>
                    <span className="badge">{code}</span> {CS_LABELS[code]}
                  </td>
                  <td className="num">{gen.poids[code]}</td>
                  <td>
                    <Jauge valeur={r.satisfaction[code]} label={`${code} respectée à ${r.satisfaction[code]} %`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Semaine type proposée</h2>
          <select className="input" aria-label="Groupe" value={groupeId} onChange={(e) => setGroupeId(Number(e.target.value))}>
            {groupes.map((g) => (
              <option key={g.id} value={g.id}>
                {g.code}
              </option>
            ))}
          </select>
        </div>
        <WeekGrid
          db={db}
          label="Semaine type proposée"
          renderCell={(c) => (
            <div className="cell-stack">
              {r.seances
                .filter((s) => s.creneauId === c.id && groupesLies(db, groupeId).includes(s.groupeId))
                .map((s) => (
                  <SeanceCard key={s.id} seance={s} index={index} montrer={['salle', 'enseignant']} className={s.groupeId !== groupeId ? 'linked' : ''} />
                ))}
            </div>
          )}
        />
      </section>

      <div className="form-actions">
        {decide ? (
          <span className={gen.statut === 'acceptee' ? 'text-success' : 'muted'} role="status">
            {gen.statut === 'acceptee' ? 'Résultat appliqué à la grille de planification.' : 'Résultat rejeté : la grille est inchangée.'}
          </span>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onRejeter}>
              Rejeter
            </button>
            <button className="btn btn-primary" onClick={onAccepter}>
              Accepter et remplacer la semaine type
            </button>
          </>
        )}
        {gen.statut === 'acceptee' && (
          <Link className="btn" to="/planification">
            Ouvrir la grille
          </Link>
        )}
      </div>
    </>
  );
}

