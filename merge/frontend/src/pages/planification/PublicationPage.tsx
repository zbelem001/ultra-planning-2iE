import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../../auth/AuthContext';
import { comptesConcernes, gabarit, notification, remplir } from '../../auth/droits';
import { indexer } from '../../components/planning';
import { EmptyState, PageHeader, StatCard } from '../../components/ui';
import { anomalies } from '../../lib/contraintes';
import { formatDateTime } from '../../lib/helpers';
import { comparer, decrireSeance, libelleSemestre, nomEnseignant, semestreActif, versionPubliee, type Ecart } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import type { Db, Seance } from '../../types';
import { STATUT_VALIDATION } from './ValidationPage';

// Page 21 — Publication et versions (BF-19, BF-20).
// Publier fige la semaine type dans une nouvelle version, archive la précédente
// et prévient les enseignants et groupes touchés par un changement.

export default function PublicationPage() {
  const user = useCurrentUser();
  const { db, save, insertMany } = useData();
  const semestre = semestreActif(db);
  const [commentaire, setCommentaire] = useState('');
  const [notifier, setNotifier] = useState(true);
  const [forcer, setForcer] = useState(false);
  const [publiee, setPubliee] = useState<string | null>(null);
  const versions = semestre ? db.versions.filter((v) => v.semestreId === semestre.id).sort((a, b) => b.numero - a.numero) : [];
  const [comparaison, setComparaison] = useState<[number, number] | null>(null);

  if (!semestre) return <EmptyState>Aucun semestre actif.</EmptyState>;

  const actuelle = versionPubliee(db, semestre.id);
  const ecarts = comparer(actuelle?.seances ?? [], db.seances);
  const enAnomalie = anomalies(db);
  const departements = db.departements.filter((d) => !d.archived);
  const nonValides = departements.filter((d) => db.validations.find((v) => v.departementId === d.id && v.semestreId === semestre.id)?.statut !== 'validee');
  const touchees = ecarts.flatMap((e) => [e.avant, e.apres].filter((s): s is Seance => !!s));
  const destinataires = comptesConcernes(db, touchees.map((s) => s.enseignantId), touchees.map((s) => s.groupeId));
  const numero = (versions[0]?.numero ?? 0) + 1;
  const modele = gabarit(db, 'publication');
  const premier = db.utilisateurs.find((u) => u.id === destinataires[0]);
  const bloque = enAnomalie.length > 0 || ecarts.length === 0 || (nonValides.length > 0 && !forcer);

  function publier() {
    if (bloque) return;
    if (actuelle) save('versions', { ...actuelle, statut: 'archivee' });
    save('versions', {
      id: 0,
      semestreId: semestre!.id,
      numero,
      statut: 'publiee',
      date: new Date().toISOString(),
      auteurId: user.id,
      commentaire: commentaire.trim(),
      seances: db.seances.map((s) => ({ ...s })),
    });
    if (notifier) {
      insertMany(
        'notifications',
        destinataires.map((id) => {
          const u = db.utilisateurs.find((x) => x.id === id)!;
          const n = touchees.filter((s) => s.enseignantId === u.enseignantId || s.groupeId === u.groupeId).length;
          return notification(id, 'Emploi du temps publié', `La version ${numero} de l’emploi du temps ${libelleSemestre(db, semestre)} est disponible : ${n} changement(s) vous concernent.`);
        }),
      );
    }
    setPubliee(`Version ${numero} publiée${notifier ? `, ${destinataires.length} personne(s) prévenue(s)` : ''}.`);
    setCommentaire('');
    setForcer(false);
  }

  return (
    <>
      <PageHeader title="Publication et versions" description={libelleSemestre(db, semestre)} refs="BF-19, BF-20" />

      {publiee && (
        <p className="notice notice-success" role="status">
          {publiee} <Link to="/emploi-du-temps">Voir l’emploi du temps publié</Link>
        </p>
      )}

      <div className="grid-4">
        <StatCard label="Version en ligne" value={actuelle ? `v${actuelle.numero}` : 'Aucune'} hint={actuelle ? formatDateTime(actuelle.date) : undefined} />
        <StatCard label="Changements à publier" value={ecarts.length} />
        <StatCard label="Séances en anomalie" value={enAnomalie.length} hint="Doivent être corrigées (CD-01 à CD-09)" />
        <StatCard label="Départements validés" value={`${departements.length - nonValides.length} / ${departements.length}`} />
      </div>

      <section className="card">
        <h2>Publier la version {numero}</h2>
        <ul className="checklist">
          <li className={enAnomalie.length ? 'ko' : 'ok'}>
            {enAnomalie.length ? (
              <>
                {enAnomalie.length} séance(s) violent une contrainte dure : {enAnomalie.map((a) => decrireSeance(db, a.seance)).join(' ; ')}.{' '}
                <Link to="/planification">Corriger dans la grille</Link>
              </>
            ) : (
              'Aucune séance ne viole les contraintes dures.'
            )}
          </li>
          <li className={nonValides.length ? 'ko' : 'ok'}>
            {nonValides.length ? (
              <>
                Validation manquante :{' '}
                {nonValides.map((d) => {
                  const v = db.validations.find((x) => x.departementId === d.id && x.semestreId === semestre.id);
                  return (
                    <span key={d.id} className={`badge ${STATUT_VALIDATION[v?.statut ?? 'en_attente'].badge}`}>
                      {d.code} · {STATUT_VALIDATION[v?.statut ?? 'en_attente'].label}
                    </span>
                  );
                })}{' '}
                <Link to="/validation">Suivre les validations</Link>
              </>
            ) : (
              'Tous les départements ont validé.'
            )}
          </li>
          <li className={ecarts.length ? 'ok' : 'ko'}>{ecarts.length ? `${ecarts.length} changement(s) depuis la version en ligne.` : 'Rien de nouveau à publier.'}</li>
        </ul>

        <div className="form">
          <div className="field">
            <label htmlFor="pub-commentaire">Note de version</label>
            <input id="pub-commentaire" className="input" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} placeholder="Ex. : ajout des TD de L1" />
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={notifier} onChange={(e) => setNotifier(e.target.checked)} />
            Prévenir par e-mail et notification les {destinataires.length} personne(s) concernée(s) (BF-20)
          </label>
          {nonValides.length > 0 && (
            <label className="checkbox">
              <input type="checkbox" checked={forcer} onChange={(e) => setForcer(e.target.checked)} />
              Publier sans attendre la validation de {nonValides.map((d) => d.code).join(', ')}
            </label>
          )}
          {notifier && modele && premier && (
            <details className="email-preview">
              <summary>Aperçu de l’e-mail envoyé à {premier.nom}</summary>
              <p>
                <strong>{remplir(modele.sujet, { semestre: libelleSemestre(db, semestre), version: numero })}</strong>
              </p>
              <pre>
                {remplir(modele.corps, {
                  nom: premier.nom,
                  semestre: libelleSemestre(db, semestre),
                  version: numero,
                  changements: touchees.filter((s) => s.enseignantId === premier.enseignantId || s.groupeId === premier.groupeId).length,
                })}
              </pre>
            </details>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" onClick={publier} disabled={bloque}>
              Publier la version {numero}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Changements depuis {actuelle ? `la version ${actuelle.numero}` : 'le début'}</h2>
        <TableEcarts db={db} ecarts={ecarts} />
      </section>

      <section className="card">
        <h2>Historique des versions</h2>
        {versions.length === 0 ? (
          <EmptyState>Aucune version publiée.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Publiée le</th>
                  <th>Par</th>
                  <th className="num">Séances</th>
                  <th>Note</th>
                  <th>État</th>
                  <th className="actions-col">Comparer</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <tr key={v.id}>
                    <td>v{v.numero}</td>
                    <td>{formatDateTime(v.date)}</td>
                    <td>{db.utilisateurs.find((u) => u.id === v.auteurId)?.nom}</td>
                    <td className="num">{v.seances.length}</td>
                    <td className="muted">{v.commentaire || '—'}</td>
                    <td>{v.statut === 'publiee' ? <span className="badge badge-ok">En ligne</span> : <span className="badge">Archivée</span>}</td>
                    <td className="actions-col">
                      {versions[i + 1] && (
                        <button className="btn btn-small" onClick={() => setComparaison([versions[i + 1].id, v.id])}>
                          avec v{versions[i + 1].numero}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {versions.length > 1 && <Comparateur versions={versions} valeur={comparaison} onChange={setComparaison} />}
      </section>
    </>
  );
}

function Comparateur({
  versions,
  valeur,
  onChange,
}: {
  versions: Db['versions'];
  valeur: [number, number] | null;
  onChange: (v: [number, number]) => void;
}) {
  const { db } = useData();
  const [a, b] = valeur ?? [versions[1].id, versions[0].id];
  const va = versions.find((v) => v.id === a)!;
  const vb = versions.find((v) => v.id === b)!;
  const choix = (id: number, set: (id: number) => void, label: string) => (
    <select className="input" aria-label={label} value={id} onChange={(e) => set(Number(e.target.value))}>
      {versions.map((v) => (
        <option key={v.id} value={v.id}>
          v{v.numero}
        </option>
      ))}
    </select>
  );
  return (
    <div className="compare">
      <div className="toolbar">
        <span>Comparer</span>
        {choix(a, (id) => onChange([id, b]), 'Version de départ')}
        <span>avec</span>
        {choix(b, (id) => onChange([a, id]), 'Version d’arrivée')}
      </div>
      <TableEcarts db={db} ecarts={comparer(va.seances, vb.seances)} />
    </div>
  );
}

function TableEcarts({ db, ecarts }: { db: Db; ecarts: Ecart[] }) {
  const index = indexer(db);
  if (ecarts.length === 0) return <EmptyState>Aucune différence.</EmptyState>;
  const champ = (s: Seance, k: keyof Seance) => {
    if (k === 'creneauId') {
      const c = index.creneaux.get(s.creneauId);
      return `${c?.jour} ${c?.debut}`;
    }
    if (k === 'salleId') return index.salles.get(s.salleId)?.code;
    if (k === 'enseignantId') return nomEnseignant(db, s.enseignantId);
    if (k === 'groupeId') return index.groupes.get(s.groupeId)?.code;
    return String(s[k]);
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Changement</th>
            <th>Séance</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {ecarts.map((e, i) => (
            <tr key={i}>
              <td>
                {!e.avant ? (
                  <span className="badge badge-ok">Ajoutée</span>
                ) : !e.apres ? (
                  <span className="badge badge-danger">Supprimée</span>
                ) : (
                  <span className="badge badge-warn">Modifiée</span>
                )}
              </td>
              <td>{decrireSeance(db, (e.apres ?? e.avant)!)}</td>
              <td className="muted">{e.avant && e.apres ? e.champs.map((k) => `${champ(e.avant!, k)} → ${champ(e.apres!, k)}`).join(' ; ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
