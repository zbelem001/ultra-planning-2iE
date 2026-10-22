import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCurrentUser } from '../../auth/AuthContext';
import { notification } from '../../auth/droits';
import { indexer } from '../../components/planning';
import { EmptyState, PageHeader, Tabs } from '../../components/ui';
import { verifierSeance } from '../../lib/contraintes';
import { formatDateTime } from '../../lib/helpers';
import { demandes, departementDuGroupe, dureeHeures, heuresPrevues, libelleSemestre, nomEnseignant, occurrences, semestreActif } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import type { StatutValidation } from '../../types';

// Page 20 — Validation par le chef de département (§2) : cours et volumes
// horaires, habilitations, puis emploi du temps proposé pour son département.
// La scolarité suit l'état des validations avant de publier (page 21).

export const STATUT_VALIDATION: Record<StatutValidation, { label: string; badge: string }> = {
  en_attente: { label: 'En attente', badge: 'badge-warn' },
  validee: { label: 'Validé', badge: 'badge-ok' },
  corrections: { label: 'Corrections demandées', badge: 'badge-danger' },
};

type Onglet = 'volumes' | 'habilitations' | 'edt';

export default function ValidationPage() {
  const user = useCurrentUser();
  const { db, save, insertMany } = useData();
  const [params, setParams] = useSearchParams();
  const [onglet, setOnglet] = useState<Onglet>('volumes');
  const index = indexer(db);
  const semestre = semestreActif(db);
  const chef = user.role === 'chef_departement';
  const departementId = chef ? user.departementId : Number(params.get('departement')) || db.departements[0]?.id;
  const departement = db.departements.find((d) => d.id === departementId);
  const peutValider = (chef && user.departementId === departementId) || user.role === 'administrateur';

  if (!departement || !semestre) {
    return (
      <>
        <PageHeader title="Validation du département" />
        <EmptyState>Aucun département rattaché à votre compte.</EmptyState>
      </>
    );
  }

  const validation = db.validations.find((v) => v.departementId === departement.id && v.semestreId === semestre.id);
  const cours = db.cours.filter((c) => !c.archived && c.departementId === departement.id);
  const seances = db.seances.filter((s) => departementDuGroupe(db, s.groupeId) === departement.id || cours.some((c) => c.id === s.coursId));
  const occ = occurrences(db, seances, semestre);
  const planifie = (coursId: number, typeSeanceId: number) =>
    occ.filter((o) => o.seance.coursId === coursId && o.seance.typeSeanceId === typeSeanceId).reduce((t, o) => t + dureeHeures(index.creneaux.get(o.seance.creneauId)!), 0);
  // Un volume est dû à chaque groupe qui suit la séance (le CM à la promotion, les TD/TP aux sous-groupes)
  const besoins = demandes(db);
  const groupesConcernes = (coursId: number, typeSeanceId: number) =>
    Math.max(1, besoins.filter((d) => d.coursId === coursId && d.typeSeanceId === typeSeanceId).length);

  const sansHabilitation = cours.filter((c) => !db.habilitations.some((h) => h.coursId === c.id));
  const controles = seances.map((s) => ({ s, v: verifierSeance(db, s) }));
  const enErreur = controles.filter((x) => x.v.length > 0).length;

  return (
    <>
      <PageHeader
        title="Validation du département"
        description={`${departement.code} — ${departement.libelle} · ${libelleSemestre(db, semestre)}`}
        refs="§2 (chef de département) · BF-03, BF-08, BF-19"
        actions={
          validation && <span className={`badge ${STATUT_VALIDATION[validation.statut].badge}`}>{STATUT_VALIDATION[validation.statut].label}</span>
        }
      />

      {!chef && (
        <section className="card">
          <h2>État des validations</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Département</th>
                  <th>État</th>
                  <th>Date</th>
                  <th>Commentaire</th>
                  <th className="actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {db.departements
                  .filter((d) => !d.archived)
                  .map((d) => {
                    const v = db.validations.find((x) => x.departementId === d.id && x.semestreId === semestre.id);
                    const statut = v?.statut ?? 'en_attente';
                    return (
                      <tr key={d.id} className={d.id === departement.id ? 'row-selected' : undefined}>
                        <td>{d.code}</td>
                        <td>
                          <span className={`badge ${STATUT_VALIDATION[statut].badge}`}>{STATUT_VALIDATION[statut].label}</span>
                        </td>
                        <td>{v?.date ? formatDateTime(v.date) : '—'}</td>
                        <td className="muted">{v?.commentaire || '—'}</td>
                        <td className="actions-col">
                          <button className="btn btn-small" onClick={() => setParams({ departement: String(d.id) })}>
                            Examiner
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Tabs<Onglet>
        tabs={[
          { id: 'volumes', label: `Cours et volumes (${cours.length})` },
          { id: 'habilitations', label: `Habilitations${sansHabilitation.length ? ` (${sansHabilitation.length} à revoir)` : ''}` },
          { id: 'edt', label: `Emploi du temps proposé${enErreur ? ` (${enErreur} en erreur)` : ''}` },
        ]}
        active={onglet}
        onChange={setOnglet}
      />

      {onglet === 'volumes' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cours</th>
                <th>Semestre</th>
                {db.typesSeance.map((t) => (
                  <th key={t.id} className="num">
                    {t.code} planifié / prévu
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cours.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/referentiel/cours/${c.id}`}>{c.code}</Link> {c.intitule}
                  </td>
                  <td>{c.semestre}</td>
                  {db.typesSeance.map((t) => {
                    const prevu = heuresPrevues(db, c.id, t.id);
                    const plan = planifie(c.id, t.id);
                    const attendu = prevu * groupesConcernes(c.id, t.id);
                    return (
                      <td key={t.id} className="num">
                        {prevu === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <span className={plan < attendu ? 'text-danger' : 'text-success'} title="Heures datées sur le semestre, tous groupes confondus">
                            {plan} / {attendu} h
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {onglet === 'habilitations' && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Cours</th>
                <th>Enseignants habilités</th>
              </tr>
            </thead>
            <tbody>
              {cours.map((c) => {
                const ens = db.habilitations.filter((h) => h.coursId === c.id);
                return (
                  <tr key={c.id} className={ens.length === 0 ? 'row-error' : undefined}>
                    <td>
                      {c.code} {c.intitule}
                    </td>
                    <td>
                      {ens.length === 0 ? (
                        <span className="text-danger">Aucun enseignant habilité (CD-06)</span>
                      ) : (
                        ens.map((h) => (
                          <Link key={h.id} className="chip" to={`/enseignants/${h.enseignantId}`}>
                            {nomEnseignant(db, h.enseignantId)}
                          </Link>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {onglet === 'edt' &&
        (controles.length === 0 ? (
          <EmptyState>Aucune séance planifiée pour ce département.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Créneau</th>
                  <th>Cours</th>
                  <th>Groupe</th>
                  <th>Salle</th>
                  <th>Enseignant</th>
                  <th>Contrôle</th>
                </tr>
              </thead>
              <tbody>
                {[...controles]
                  .sort((a, b) => a.s.creneauId - b.s.creneauId)
                  .map(({ s, v }) => {
                    const c = index.creneaux.get(s.creneauId);
                    return (
                      <tr key={s.id} className={v.length ? 'row-error' : undefined}>
                        <td>
                          {c?.jour} {c?.debut}
                        </td>
                        <td>
                          {index.cours.get(s.coursId)?.code} <span className="badge">{index.types.get(s.typeSeanceId)?.code}</span>
                        </td>
                        <td>{index.groupes.get(s.groupeId)?.code}</td>
                        <td>{index.salles.get(s.salleId)?.code}</td>
                        <td>{nomEnseignant(db, s.enseignantId)}</td>
                        <td>{v.length === 0 ? <span className="badge badge-ok">Conforme</span> : v.map((x) => `${x.code} : ${x.message}`).join(' ')}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ))}

      {peutValider ? (
        <DecisionForm
          key={departement.id}
          initial={validation?.statut === 'corrections' ? 'corrections' : 'validee'}
          commentaire={validation?.commentaire ?? ''}
          alertes={sansHabilitation.length + enErreur}
          onSubmit={(statut, commentaire) => {
            save('validations', {
              id: validation?.id ?? 0,
              departementId: departement.id,
              semestreId: semestre.id,
              statut,
              commentaire,
              date: new Date().toISOString(),
              utilisateurId: user.id,
            });
            const scolarite = db.utilisateurs.filter((u) => u.role === 'planificateur' && !u.archived);
            insertMany(
              'notifications',
              scolarite.map((u) =>
                notification(u.id, `${departement.code} : ${STATUT_VALIDATION[statut].label.toLowerCase()}`, commentaire || `${user.nom} a validé l’emploi du temps du département.`),
              ),
            );
          }}
        />
      ) : (
        <p className="notice">La validation appartient au chef du département {departement.code}.</p>
      )}
    </>
  );
}

function DecisionForm({
  initial,
  commentaire: initialCommentaire,
  alertes,
  onSubmit,
}: {
  initial: StatutValidation;
  commentaire: string;
  alertes: number;
  onSubmit: (statut: StatutValidation, commentaire: string) => void;
}) {
  const [statut, setStatut] = useState<StatutValidation>(initial);
  const [commentaire, setCommentaire] = useState(initialCommentaire);
  const [envoye, setEnvoye] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  function envoyer(e: FormEvent) {
    e.preventDefault();
    if (statut === 'corrections' && !commentaire.trim()) {
      setErreur('Précisez les corrections attendues.');
      return;
    }
    setErreur(null);
    onSubmit(statut, commentaire.trim());
    setEnvoye(true);
  }

  return (
    <form className="card form" onSubmit={envoyer}>
      <h2>Ma décision</h2>
      {alertes > 0 && <p className="notice">{alertes} point(s) à revoir dans les onglets ci-dessus.</p>}
      <div className="radio-row" role="radiogroup" aria-label="Décision">
        <label className={`radio-card ${statut === 'validee' ? 'active' : ''}`}>
          <input type="radio" name="decision" checked={statut === 'validee'} onChange={() => setStatut('validee')} />
          Valider
        </label>
        <label className={`radio-card ${statut === 'corrections' ? 'active' : ''}`}>
          <input type="radio" name="decision" checked={statut === 'corrections'} onChange={() => setStatut('corrections')} />
          Demander des corrections
        </label>
      </div>
      <div className="field">
        <label htmlFor="val-commentaire">Commentaire pour la scolarité</label>
        <textarea id="val-commentaire" className="input" rows={3} value={commentaire} onChange={(e) => setCommentaire(e.target.value)} />
      </div>
      {erreur && (
        <p className="error" role="alert">
          {erreur}
        </p>
      )}
      <div className="form-actions">
        {envoye && (
          <span className="text-success" role="status">
            Décision transmise à la scolarité.
          </span>
        )}
        <button type="submit" className="btn btn-primary">
          Envoyer ma décision
        </button>
      </div>
    </form>
  );
}
