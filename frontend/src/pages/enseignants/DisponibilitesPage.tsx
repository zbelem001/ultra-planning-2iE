import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCurrentUser } from '../../auth/AuthContext';
import { campagne } from '../../mocks/data';
import { useData } from '../../store/DataContext';
import { formatDate, joursRestants } from '../../lib/helpers';
import { EmptyState, PageHeader } from '../../components/ui';
import { JOURS, type NiveauDispo } from '../../types';

// Page 14 — Saisie des disponibilités par créneau (BF-09) : disponible,
// préférence (CS-01) ou indisponible (CD-06). Un clic fait tourner l'état.
// L'enseignant édite sa propre grille ; la scolarité peut consulter celle de chacun.

const CYCLE: NiveauDispo[] = ['disponible', 'preference', 'indisponible'];
const LABELS: Record<NiveauDispo, string> = {
  disponible: 'Disponible',
  preference: 'Préférence',
  indisponible: 'Indisponible',
};

export default function DisponibilitesPage() {
  const user = useCurrentUser();
  const { db, save, remove } = useData();
  const [params, setParams] = useSearchParams();

  const scolarite = user.role === 'planificateur' || user.role === 'administrateur';
  const peutChoisir = scolarite || user.role === 'chef_departement';
  // Le chef de département ne consulte que les enseignants de son département.
  const choix = db.enseignants.filter(
    (e) => !e.archived && (scolarite || e.departementId === user.departementId || e.id === user.enseignantId),
  );
  const demande = Number(params.get('enseignant'));
  const enseignantId = peutChoisir
    ? (choix.find((e) => e.id === demande) ?? choix.find((e) => e.id === user.enseignantId) ?? choix[0])?.id
    : user.enseignantId;
  const enseignant = db.enseignants.find((e) => e.id === enseignantId);
  // L'enseignant modifie sa grille ; la scolarité peut aussi corriger pendant la campagne.
  const editable = enseignant !== undefined && (enseignant.id === user.enseignantId || scolarite);

  const enregistre = (creneauId: number): NiveauDispo =>
    db.disponibilites.find((d) => d.enseignantId === enseignantId && d.creneauId === creneauId)?.niveau ?? 'disponible';

  const [draft, setDraft] = useState<Record<number, NiveauDispo>>({});
  const [message, setMessage] = useState<string | null>(null);
  const niveau = (creneauId: number) => draft[creneauId] ?? enregistre(creneauId);
  const modifie = Object.entries(draft).some(([id, n]) => enregistre(Number(id)) !== n);

  if (!enseignant) {
    return (
      <>
        <PageHeader title="Disponibilités" refs="BF-09" />
        <EmptyState>Aucune fiche enseignant n’est associée à votre compte.</EmptyState>
      </>
    );
  }

  const creneaux = [...db.creneaux].sort((a, b) => a.debut.localeCompare(b.debut));
  const plages = Array.from(new Set(creneaux.map((c) => `${c.debut}-${c.fin}`))).sort();
  const restants = joursRestants(campagne.dateLimite);
  const totaux = CYCLE.map((n) => creneaux.filter((c) => niveau(c.id) === n).length);

  function cycle(creneauId: number) {
    if (!editable) return;
    setMessage(null);
    const next = CYCLE[(CYCLE.indexOf(niveau(creneauId)) + 1) % CYCLE.length];
    setDraft((d) => ({ ...d, [creneauId]: next }));
  }

  function setJour(jour: string, n: NiveauDispo) {
    setMessage(null);
    const ids = creneaux.filter((c) => c.jour === jour).map((c) => c.id);
    setDraft((d) => ({ ...d, ...Object.fromEntries(ids.map((id) => [id, n])) }));
  }

  function enregistrer() {
    for (const [key, n] of Object.entries(draft)) {
      const creneauId = Number(key);
      const existing = db.disponibilites.find((d) => d.enseignantId === enseignantId && d.creneauId === creneauId);
      // « disponible » est la valeur par défaut : inutile de la stocker
      if (n === 'disponible') {
        if (existing) remove('disponibilites', existing.id);
      } else if (existing) {
        save('disponibilites', { ...existing, niveau: n });
      } else {
        save('disponibilites', { id: 0, enseignantId: enseignant!.id, creneauId, niveau: n });
      }
    }
    setDraft({});
    setMessage('Disponibilités enregistrées.');
  }

  return (
    <>
      <PageHeader
        title={enseignant.id === user.enseignantId ? 'Mes disponibilités' : 'Disponibilités'}
        description={`${campagne.semestre} · date limite ${formatDate(campagne.dateLimite)}${restants >= 0 ? ` (encore ${restants} jour(s))` : ' (dépassée)'}`}
        refs="BF-09, CS-01, CD-06"
      />

      {peutChoisir && (
        <div className="toolbar">
          <label htmlFor="choix-enseignant">Enseignant</label>
          <select
            id="choix-enseignant"
            className="input"
            value={enseignantId}
            onChange={(e) => {
              setDraft({});
              setMessage(null);
              setParams({ enseignant: e.target.value });
            }}
          >
            {choix.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nom.toUpperCase()} {e.prenom}
              </option>
            ))}
          </select>
        </div>
      )}

      <section className="card">
        <div className="section-head">
          <h2>
            {enseignant.prenom} {enseignant.nom}
          </h2>
          <div className="legend" aria-label="Légende">
            {CYCLE.map((n, i) => (
              <span key={n} className={`legend-item dispo-${n}`}>
                {LABELS[n]} ({totaux[i]})
              </span>
            ))}
          </div>
        </div>
        {editable ? (
          <p className="muted small">
            Cliquez sur un créneau pour passer de « disponible » à « préférence » puis « indisponible ». Les créneaux
            non modifiés restent disponibles.
          </p>
        ) : (
          <p className="notice">Consultation seule.</p>
        )}

        <div className="table-wrap">
          <table className="table grid-table dispo-grid">
            <thead>
              <tr>
                <th>Plage</th>
                {JOURS.map((j) => (
                  <th key={j}>
                    {j}
                    {editable && (
                      <span className="day-actions">
                        <button className="link-btn" onClick={() => setJour(j, 'disponible')} aria-label={`Tout ${j} disponible`}>
                          dispo
                        </button>
                        <button className="link-btn" onClick={() => setJour(j, 'indisponible')} aria-label={`Tout ${j} indisponible`}>
                          indispo
                        </button>
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plages.map((plage) => (
                <tr key={plage}>
                  <th scope="row">{plage.replace('-', ' – ')}</th>
                  {JOURS.map((jour) => {
                    const c = creneaux.find((x) => x.jour === jour && `${x.debut}-${x.fin}` === plage);
                    if (!c) return <td key={jour} className="slot slot-empty" />;
                    const n = niveau(c.id);
                    const changed = draft[c.id] !== undefined && draft[c.id] !== enregistre(c.id);
                    return (
                      <td key={jour} className="slot">
                        <button
                          className={`dispo-btn dispo-${n} ${changed ? 'changed' : ''}`}
                          onClick={() => cycle(c.id)}
                          disabled={!editable}
                          aria-label={`${jour} ${c.debut}–${c.fin} : ${LABELS[n]}`}
                        >
                          {LABELS[n]}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editable && (
          <div className="form-actions">
            {message && (
              <span className="text-success" role="status">
                {message}
              </span>
            )}
            <button className="btn btn-ghost" onClick={() => setDraft({})} disabled={!modifie}>
              Annuler les changements
            </button>
            <button className="btn btn-primary" onClick={enregistrer} disabled={!modifie}>
              Enregistrer
            </button>
          </div>
        )}
      </section>
    </>
  );
}
