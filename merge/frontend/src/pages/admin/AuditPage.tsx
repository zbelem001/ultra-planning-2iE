import { useState } from 'react';
import { EmptyState, PageHeader } from '../../components/ui';
import { downloadText, toCsv } from '../../lib/csv';
import { formatDateTime } from '../../lib/helpers';
import { useData } from '../../store/DataContext';
import type { ActionAudit, Collection } from '../../types';

// Page 26 — Journal d'audit (BF-25, BNF-08). Chaque création, modification ou
// suppression est inscrite par store/journal.tsx ; la base la conservera 3 ans.

const ACTIONS: Record<ActionAudit, { label: string; badge: string }> = {
  creation: { label: 'Création', badge: 'badge-ok' },
  modification: { label: 'Modification', badge: 'badge-warn' },
  suppression: { label: 'Suppression', badge: 'badge-danger' },
};

const ENTITES: Partial<Record<Collection, string>> = {
  seances: 'Séance',
  departements: 'Département',
  filieres: 'Filière',
  groupes: 'Groupe',
  cours: 'Cours',
  volumes: 'Volume horaire',
  typesSalle: 'Type de salle',
  typesSeance: 'Type de séance',
  batiments: 'Bâtiment',
  salles: 'Salle',
  creneaux: 'Créneau',
  programmes: 'Programme',
  enseignants: 'Enseignant',
  habilitations: 'Habilitation',
  disponibilites: 'Disponibilité',
  utilisateurs: 'Compte',
  annees: 'Année universitaire',
  semestres: 'Semestre',
  campagnes: 'Campagne',
  relances: 'Relance',
  duplications: 'Duplication',
  validations: 'Validation',
  versions: 'Version publiée',
  signalements: 'Signalement',
  parametres: 'Paramètres',
  gabarits: 'Gabarit d’e-mail',
};

const PAR_PAGE = 25;

export default function AuditPage() {
  const { db } = useData();
  const [utilisateur, setUtilisateur] = useState(0);
  const [entite, setEntite] = useState('');
  const [action, setAction] = useState('');
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [recherche, setRecherche] = useState('');
  const [page, setPage] = useState(0);

  const q = recherche.trim().toLowerCase();
  const lignes = [...db.audit]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .filter((l) => !utilisateur || l.utilisateurId === utilisateur)
    .filter((l) => !entite || l.entite === entite)
    .filter((l) => !action || l.action === action)
    .filter((l) => !du || l.date.slice(0, 10) >= du)
    .filter((l) => !au || l.date.slice(0, 10) <= au)
    .filter((l) => !q || l.resume.toLowerCase().includes(q));
  const pages = Math.max(1, Math.ceil(lignes.length / PAR_PAGE));
  const courante = Math.min(page, pages - 1);
  const visibles = lignes.slice(courante * PAR_PAGE, (courante + 1) * PAR_PAGE);
  const nom = (id: number) => db.utilisateurs.find((u) => u.id === id)?.nom ?? `#${id}`;
  const filtrer = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(0);
  };

  function exporter() {
    downloadText(
      'journal-audit.csv',
      toCsv([
        ['Date', 'Utilisateur', 'Action', 'Entité', 'Identifiant', 'Détail'],
        ...lignes.map((l) => [l.date, nom(l.utilisateurId), ACTIONS[l.action].label, ENTITES[l.entite] ?? l.entite, String(l.entiteId), l.resume]),
      ]),
    );
  }

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        description="Toute création, modification ou suppression, avec son auteur. Conservation : 3 ans."
        refs="BF-25, BNF-08"
        actions={
          <button className="btn" onClick={exporter} disabled={lignes.length === 0}>
            Exporter (CSV)
          </button>
        }
      />

      <div className="toolbar filters">
        <input type="search" className="input search" placeholder="Rechercher dans le détail…" aria-label="Rechercher dans le détail" value={recherche} onChange={(e) => filtrer(setRecherche)(e.target.value)} />
        <select className="input" aria-label="Utilisateur" value={utilisateur} onChange={(e) => filtrer(setUtilisateur)(Number(e.target.value))}>
          <option value={0}>Tous les utilisateurs</option>
          {db.utilisateurs.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nom}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Entité" value={entite} onChange={(e) => filtrer(setEntite)(e.target.value)}>
          <option value="">Toutes les entités</option>
          {Object.entries(ENTITES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Action" value={action} onChange={(e) => filtrer(setAction)(e.target.value)}>
          <option value="">Toutes les actions</option>
          {Object.entries(ACTIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <label className="checkbox">
          Du <input type="date" className="input" value={du} onChange={(e) => filtrer(setDu)(e.target.value)} />
        </label>
        <label className="checkbox">
          au <input type="date" className="input" value={au} onChange={(e) => filtrer(setAu)(e.target.value)} />
        </label>
        <span className="muted small toolbar-count">{lignes.length} entrée(s)</span>
      </div>

      {visibles.length === 0 ? (
        <EmptyState>Aucune entrée ne correspond aux filtres.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Utilisateur</th>
                <th>Action</th>
                <th>Entité</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{formatDateTime(l.date)}</td>
                  <td>{nom(l.utilisateurId)}</td>
                  <td>
                    <span className={`badge ${ACTIONS[l.action].badge}`}>{ACTIONS[l.action].label}</span>
                  </td>
                  <td>{ENTITES[l.entite] ?? l.entite}</td>
                  <td>{l.resume}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="toolbar pager">
          <button className="btn btn-small" disabled={courante === 0} onClick={() => setPage(courante - 1)}>
            Précédent
          </button>
          <span className="muted small">
            Page {courante + 1} / {pages}
          </span>
          <button className="btn btn-small" disabled={courante >= pages - 1} onClick={() => setPage(courante + 1)}>
            Suivant
          </button>
        </div>
      )}
    </>
  );
}
