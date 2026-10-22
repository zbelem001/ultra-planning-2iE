import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { EmptyState, PageHeader, ReadOnlyNotice } from '../../components/ui';
import { canEditReferentiel, useCurrentUser } from '../../auth/AuthContext';
import { byId, useData } from '../../store/DataContext';
import { NIVEAUX, type Filiere } from '../../types';
import { departementOptions, departementScope } from './scope';

// Page 6 — Filières (BF-01) et programme de chaque filière (BF-06, CD-07).

export default function FilieresPage() {
  const { db } = useData();
  const user = useCurrentUser();
  const scope = departementScope(user);
  const deps = byId(db.departements);

  return (
    <CrudPage<'filieres', Filiere>
      collection="filieres"
      title="Filières et programmes"
      singular="filière"
      description="Chaque filière a un niveau (L1 à M2) et un programme de cours."
      refs="BF-01, BF-06"
      rows={db.filieres.filter((f) => !scope || f.departementId === scope)}
      searchText={(f) => `${f.code} ${f.libelle} ${f.niveau}`}
      rowLink={(f) => `/referentiel/filieres/${f.id}`}
      columns={[
        { label: 'Code', render: (f) => <strong>{f.code}</strong> },
        { label: 'Libellé', render: (f) => f.libelle },
        { label: 'Niveau', render: (f) => <span className="badge">{f.niveau}</span> },
        { label: 'Département', render: (f) => deps.get(f.departementId)?.code },
        { label: 'Groupes', render: (f) => db.groupes.filter((g) => g.filiereId === f.id && !g.archived).length, align: 'right' },
        { label: 'Cours au programme', render: (f) => db.programmes.filter((p) => p.filiereId === f.id).length, align: 'right' },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true },
        { key: 'libelle', label: 'Libellé', required: true },
        { key: 'niveau', label: 'Niveau', type: 'select', required: true, options: NIVEAUX.map((n) => ({ value: n, label: n })) },
        { key: 'departementId', label: 'Département', type: 'select', required: true, options: departementOptions(db) },
      ]}
      blank={() => ({ id: 0, code: '', libelle: '', niveau: 'L1', departementId: scope ?? 0 })}
      validate={(f) => uniqueCode(db.filieres, f)}
    />
  );
}

export function FiliereDetailPage() {
  const { id } = useParams();
  const { db, save, remove } = useData();
  const user = useCurrentUser();
  const editable = canEditReferentiel(user.role);
  const [coursId, setCoursId] = useState(0);
  const filiere = db.filieres.find((f) => f.id === Number(id));

  if (!filiere) return <Navigate to="/introuvable" replace />;
  const scope = departementScope(user);
  if (scope && filiere.departementId !== scope) return <Navigate to="/acces-refuse" replace />;

  const cours = byId(db.cours);
  const programme = db.programmes.filter((p) => p.filiereId === filiere.id);
  const dejaAuProgramme = new Set(programme.map((p) => p.coursId));
  const ajoutables = db.cours.filter((c) => !c.archived && !dejaAuProgramme.has(c.id));
  const groupes = db.groupes.filter((g) => g.filiereId === filiere.id && !g.archived);
  const ects = programme.reduce((sum, p) => sum + (cours.get(p.coursId)?.ects ?? 0), 0);

  function add() {
    if (!coursId) return;
    save('programmes', { id: 0, filiereId: filiere!.id, coursId });
    setCoursId(0);
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/referentiel/filieres">Filières</Link> / {filiere.code}
      </p>
      <PageHeader
        title={filiere.libelle}
        description={`${filiere.code} · niveau ${filiere.niveau} · ${groupes.length} groupe(s)`}
        refs="BF-06, CD-07"
      />
      {!editable && <ReadOnlyNotice />}
      <section className="card">
        <div className="section-head">
          <h2>Programme</h2>
          <span className="muted">
            {programme.length} cours · {ects} ECTS
          </span>
        </div>
        {programme.length === 0 ? (
          <EmptyState>Aucun cours au programme.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Intitulé</th>
                  <th>Semestre</th>
                  <th className="num">ECTS</th>
                  {editable && <th className="actions-col">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {programme.map((p) => {
                  const c = cours.get(p.coursId);
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/referentiel/cours/${p.coursId}`}>{c?.code}</Link>
                      </td>
                      <td>{c?.intitule}</td>
                      <td>{c?.semestre}</td>
                      <td className="num">{c?.ects}</td>
                      {editable && (
                        <td className="actions-col">
                          <button className="btn btn-small btn-ghost" onClick={() => remove('programmes', p.id)}>
                            Retirer
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {editable && (
          <div className="inline-form">
            <label htmlFor="ajout-cours">Ajouter un cours</label>
            <select id="ajout-cours" className="input" value={coursId || ''} onChange={(e) => setCoursId(Number(e.target.value))}>
              <option value="" disabled>
                Choisir un cours…
              </option>
              {ajoutables.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.intitule}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={add} disabled={!coursId}>
              Ajouter au programme
            </button>
          </div>
        )}
      </section>
    </>
  );
}
