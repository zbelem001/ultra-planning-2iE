import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { gabarit, notification, remplir } from '../../auth/droits';
import { Jauge } from '../../components/planning';
import { EmptyState, PageHeader, StatCard } from '../../components/ui';
import { formatDate, formatDateTime, joursRestants, retardatairesDisponibilites } from '../../lib/helpers';
import { ajouterJours, libelleSemestre, semestreActif } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import type { CampagneSaisie } from '../../types';

// Page 15 — Campagne de saisie des disponibilités (BF-10) : date limite, taux de
// saisie par département, relance manuelle ou automatique des retardataires.
// Sans réponse à la date limite, l'enseignant est considéré disponible partout
// (parade du risque n°2, §9.3).

const JOURS_RELANCE = [14, 7, 3, 1];

export default function CampagnePage() {
  const { db, save, insertMany } = useData();
  const semestre = semestreActif(db);
  const campagne = db.campagnes.find((c) => c.semestreId === semestre?.id);
  const [selection, setSelection] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  if (!semestre || !campagne) {
    return (
      <>
        <PageHeader title="Campagne de saisie des disponibilités" refs="BF-10" />
        <EmptyState>Aucune campagne pour le semestre actif.</EmptyState>
      </>
    );
  }

  const actifs = db.enseignants.filter((e) => !e.archived);
  const retard = retardatairesDisponibilites(db);
  const taux = actifs.length ? Math.round(((actifs.length - retard.length) / actifs.length) * 100) : 100;
  const restants = joursRestants(campagne.dateLimite);
  const relances = db.relances.filter((r) => r.campagneId === campagne.id).sort((a, b) => b.date.localeCompare(a.date));
  const derniereRelance = (enseignantId: number) => relances.find((r) => r.enseignantIds.includes(enseignantId));
  const compte = (enseignantId: number) => db.utilisateurs.find((u) => !u.archived && u.enseignantId === enseignantId);
  const modele = gabarit(db, 'relance');
  const valeurs = (nom: string) => ({ nom, semestre: libelleSemestre(db, semestre), date_limite: formatDate(campagne.dateLimite) });

  function relancer(ids: number[]) {
    if (ids.length === 0) return;
    save('relances', { id: 0, campagneId: campagne!.id, date: new Date().toISOString(), auto: false, enseignantIds: ids });
    const notifs = ids
      .map((id) => compte(id))
      .filter((u) => u !== undefined)
      .map((u) => notification(u.id, 'Rappel : vos disponibilités', modele ? remplir(modele.sujet, valeurs(u.nom)) : `Merci de saisir vos disponibilités avant le ${formatDate(campagne!.dateLimite)}.`));
    if (notifs.length) insertMany('notifications', notifs);
    setSelection([]);
    setMessage(`${ids.length} enseignant(s) relancé(s) par e-mail, dont ${notifs.length} avec une notification dans l’application.`);
  }

  return (
    <>
      <PageHeader
        title="Campagne de saisie des disponibilités"
        description={libelleSemestre(db, semestre)}
        refs="BF-10"
        actions={
          <Link className="btn" to="/disponibilites">
            Voir les grilles des enseignants
          </Link>
        }
      />

      <div className="grid-4">
        <StatCard label="Taux de saisie" value={`${taux} %`} hint={`${actifs.length - retard.length} enseignant(s) sur ${actifs.length}`} />
        <StatCard label="Date limite" value={formatDate(campagne.dateLimite)} hint={restants >= 0 ? `Encore ${restants} jour(s)` : 'Dépassée : les non-réponses valent « disponible »'} />
        <StatCard label="Retardataires" value={retard.length} />
        <StatCard label="Dernière relance" value={relances[0] ? formatDate(relances[0].date) : '—'} hint={relances[0] ? (relances[0].auto ? 'Automatique' : 'Manuelle') : undefined} />
      </div>

      {message && (
        <p className="notice notice-success" role="status">
          {message}
        </p>
      )}

      <div className="grid-2">
        <ReglagesCampagne key={campagne.id} campagne={campagne} onSave={(c) => save('campagnes', c)} />

        <section className="card">
          <h2>Taux de saisie par département</h2>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {db.departements
                  .filter((d) => !d.archived)
                  .map((d) => {
                    const ens = actifs.filter((e) => e.departementId === d.id);
                    const ok = ens.filter((e) => !retard.includes(e)).length;
                    return (
                      <tr key={d.id}>
                        <td>{d.code}</td>
                        <td className="num">
                          {ok} / {ens.length}
                        </td>
                        <td>{ens.length ? <Jauge valeur={Math.round((ok / ens.length) * 100)} label={`${d.code} : ${ok} sur ${ens.length}`} /> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h2>Retardataires ({retard.length})</h2>
          <div className="shortcuts">
            <button className="btn" onClick={() => relancer(selection)} disabled={selection.length === 0}>
              Relancer la sélection ({selection.length})
            </button>
            <button className="btn btn-primary" onClick={() => relancer(retard.map((e) => e.id))} disabled={retard.length === 0}>
              Relancer tous les retardataires
            </button>
          </div>
        </div>
        {retard.length === 0 ? (
          <EmptyState>Tous les enseignants ont saisi leurs disponibilités.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Tout sélectionner"
                      checked={selection.length === retard.length}
                      onChange={(e) => setSelection(e.target.checked ? retard.map((x) => x.id) : [])}
                    />
                  </th>
                  <th>Enseignant</th>
                  <th>Département</th>
                  <th>E-mail</th>
                  <th>Dernière relance</th>
                </tr>
              </thead>
              <tbody>
                {retard.map((e) => {
                  const r = derniereRelance(e.id);
                  return (
                    <tr key={e.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Sélectionner ${e.prenom} ${e.nom}`}
                          checked={selection.includes(e.id)}
                          onChange={(x) => setSelection((s) => (x.target.checked ? [...s, e.id] : s.filter((id) => id !== e.id)))}
                        />
                      </td>
                      <td>
                        {e.prenom} {e.nom} {!compte(e.id) && <span className="badge" title="Pas encore de compte : relance par e-mail seulement">sans compte</span>}
                      </td>
                      <td>{db.departements.find((d) => d.id === e.departementId)?.code}</td>
                      <td>{e.email}</td>
                      <td>{r ? `${formatDateTime(r.date)} (${r.auto ? 'auto' : 'manuelle'})` : 'Jamais'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {modele && retard[0] && (
          <details className="email-preview">
            <summary>Aperçu de l’e-mail de relance</summary>
            <p>
              <strong>{remplir(modele.sujet, valeurs(`${retard[0].prenom} ${retard[0].nom}`))}</strong>
            </p>
            <pre>{remplir(modele.corps, valeurs(`${retard[0].prenom} ${retard[0].nom}`))}</pre>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Historique des relances</h2>
        {relances.length === 0 ? (
          <EmptyState>Aucune relance envoyée.</EmptyState>
        ) : (
          <ul className="notif-list">
            {relances.map((r) => (
              <li key={r.id} className="notif">
                <div>
                  <strong>
                    {r.auto ? 'Relance automatique' : 'Relance manuelle'} · {r.enseignantIds.length} enseignant(s)
                  </strong>
                  <p className="muted small">
                    {r.enseignantIds
                      .map((id) => db.enseignants.find((e) => e.id === id))
                      .map((e) => (e ? `${e.prenom} ${e.nom}` : '?'))
                      .join(', ')}
                  </p>
                </div>
                <span className="muted small">{formatDateTime(r.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ReglagesCampagne({ campagne, onSave }: { campagne: CampagneSaisie; onSave: (c: CampagneSaisie) => void }) {
  const [draft, setDraft] = useState(campagne);
  const [enregistre, setEnregistre] = useState(false);
  const modifier = (p: Partial<CampagneSaisie>) => {
    setEnregistre(false);
    setDraft((d) => ({ ...d, ...p }));
  };
  const prochaines = draft.relanceAuto ? [...draft.joursRelance].sort((a, b) => b - a).map((j) => ajouterJours(draft.dateLimite, -j)) : [];

  function envoyer(e: FormEvent) {
    e.preventDefault();
    onSave(draft);
    setEnregistre(true);
  }

  return (
    <form className="card form" onSubmit={envoyer}>
      <h2>Réglages</h2>
      <div className="field">
        <label htmlFor="camp-date">Date limite de saisie</label>
        <input id="camp-date" type="date" className="input" value={draft.dateLimite} required onChange={(e) => modifier({ dateLimite: e.target.value })} />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={draft.relanceAuto} onChange={(e) => modifier({ relanceAuto: e.target.checked })} />
        Relancer automatiquement les retardataires
      </label>
      {draft.relanceAuto && (
        <fieldset className="radio-row plain-fieldset">
          <legend className="small muted">Jours avant la date limite</legend>
          {JOURS_RELANCE.map((j) => (
            <label key={j} className={`radio-card ${draft.joursRelance.includes(j) ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={draft.joursRelance.includes(j)}
                onChange={(e) => modifier({ joursRelance: e.target.checked ? [...draft.joursRelance, j] : draft.joursRelance.filter((x) => x !== j) })}
              />
              J-{j}
            </label>
          ))}
        </fieldset>
      )}
      {prochaines.length > 0 && <p className="muted small">Relances prévues : {prochaines.map((d) => formatDate(d)).join(', ')}.</p>}
      <div className="form-actions">
        {enregistre && (
          <span className="text-success" role="status">
            Réglages enregistrés.
          </span>
        )}
        <button type="submit" className="btn btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}
