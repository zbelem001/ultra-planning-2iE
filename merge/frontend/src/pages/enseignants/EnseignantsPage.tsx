import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import CrudPage from '../../components/CrudPage';
import { EmptyState, PageHeader, ReadOnlyNotice } from '../../components/ui';
import { canEditReferentiel, useCurrentUser } from '../../auth/AuthContext';
import { byId, useData } from '../../store/DataContext';
import type { Enseignant } from '../../types';
import { departementOptions, departementScope } from '../referentiel/scope';

// Page 13 — Enseignants (grade, département, coordonnées) et habilitations par cours (BF-08, CD-06).

const GRADES = ['Professeur', 'Maître de conférences', 'Maître assistant', 'Maître assistante', 'Assistant', 'Assistante', 'Vacataire'];

export default function EnseignantsPage() {
  const { db } = useData();
  const user = useCurrentUser();
  const scope = departementScope(user);
  const deps = byId(db.departements);
  const saisis = new Set(db.disponibilites.map((d) => d.enseignantId));

  return (
    <CrudPage<'enseignants', Enseignant>
      collection="enseignants"
      title="Enseignants et habilitations"
      singular="enseignant"
      description="Un enseignant ne peut être placé que sur les cours pour lesquels il est habilité."
      refs="BF-08, CD-06"
      rows={db.enseignants.filter((e) => !scope || e.departementId === scope)}
      searchText={(e) => `${e.matricule} ${e.nom} ${e.prenom} ${e.email} ${e.grade}`}
      rowLink={(e) => `/enseignants/${e.id}`}
      columns={[
        { label: 'Matricule', render: (e) => e.matricule },
        { label: 'Nom', render: (e) => <strong>{e.nom.toUpperCase()} {e.prenom}</strong> },
        { label: 'Grade', render: (e) => e.grade },
        { label: 'Dép.', render: (e) => deps.get(e.departementId)?.code },
        { label: 'Habilitations', render: (e) => db.habilitations.filter((h) => h.enseignantId === e.id).length, align: 'right' },
        {
          label: 'Disponibilités',
          render: (e) =>
            saisis.has(e.id) ? <span className="badge badge-ok">Saisies</span> : <span className="badge badge-warn">À saisir</span>,
        },
      ]}
      fields={[
        { key: 'matricule', label: 'Matricule', required: true },
        { key: 'nom', label: 'Nom', required: true },
        { key: 'prenom', label: 'Prénom', required: true },
        { key: 'grade', label: 'Grade', type: 'select', required: true, options: GRADES.map((g) => ({ value: g, label: g })) },
        { key: 'departementId', label: 'Département', type: 'select', required: true, options: departementOptions(db) },
        { key: 'email', label: 'E-mail', type: 'email', required: true },
        { key: 'telephone', label: 'Téléphone', type: 'tel' },
      ]}
      blank={() => ({ id: 0, matricule: '', nom: '', prenom: '', grade: '', email: '', telephone: '', departementId: scope ?? 0 })}
      validate={(e) =>
        db.enseignants.some((x) => x.id !== e.id && x.matricule.toLowerCase() === e.matricule.trim().toLowerCase())
          ? `Le matricule « ${e.matricule} » est déjà utilisé.`
          : null
      }
    />
  );
}

export function EnseignantDetailPage() {
  const { id } = useParams();
  const { db, save, remove } = useData();
  const user = useCurrentUser();
  const editable = canEditReferentiel(user.role);
  const [coursId, setCoursId] = useState(0);
  const enseignant = db.enseignants.find((e) => e.id === Number(id));

  if (!enseignant) return <Navigate to="/introuvable" replace />;
  const scope = departementScope(user);
  if (scope && enseignant.departementId !== scope) return <Navigate to="/acces-refuse" replace />;

  const cours = byId(db.cours);
  const departement = db.departements.find((d) => d.id === enseignant.departementId);
  const habilitations = db.habilitations.filter((h) => h.enseignantId === enseignant.id);
  const dejaHabilite = new Set(habilitations.map((h) => h.coursId));
  const ajoutables = db.cours.filter((c) => !c.archived && !dejaHabilite.has(c.id));
  const dispos = db.disponibilites.filter((d) => d.enseignantId === enseignant.id);
  const compte = (niveau: string) => dispos.filter((d) => d.niveau === niveau).length;

  function add() {
    if (!coursId) return;
    save('habilitations', { id: 0, enseignantId: enseignant!.id, coursId });
    setCoursId(0);
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/enseignants">Enseignants</Link> / {enseignant.matricule}
      </p>
      <PageHeader
        title={`${enseignant.prenom} ${enseignant.nom}`}
        description={`${enseignant.grade} · ${departement?.libelle ?? ''}`}
        refs="BF-08, CD-06"
      />
      {!editable && <ReadOnlyNotice />}
      <div className="grid-2">
        <section className="card">
          <h2>Coordonnées</h2>
          <dl className="details">
            <dt>Matricule</dt>
            <dd>{enseignant.matricule}</dd>
            <dt>E-mail</dt>
            <dd>
              <a href={`mailto:${enseignant.email}`}>{enseignant.email}</a>
            </dd>
            <dt>Téléphone</dt>
            <dd>{enseignant.telephone || '—'}</dd>
          </dl>
        </section>
        <section className="card">
          <h2>Disponibilités déclarées</h2>
          {dispos.length === 0 ? (
            <EmptyState>Rien de saisi : tous les créneaux sont considérés disponibles.</EmptyState>
          ) : (
            <p>
              <span className="badge badge-ok">{compte('preference')} préférence(s)</span>{' '}
              <span className="badge badge-danger">{compte('indisponible')} indisponibilité(s)</span>
            </p>
          )}
          <Link className="btn btn-small" to={`/disponibilites?enseignant=${enseignant.id}`}>
            Voir la grille
          </Link>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h2>Habilitations</h2>
          <span className="muted">{habilitations.length} cours</span>
        </div>
        {habilitations.length === 0 ? (
          <EmptyState>Aucune habilitation : cet enseignant ne peut être placé sur aucun cours.</EmptyState>
        ) : (
          <ul className="chips">
            {habilitations.map((h) => {
              const c = cours.get(h.coursId);
              return (
                <li key={h.id} className="chip">
                  <Link to={`/referentiel/cours/${h.coursId}`}>
                    {c?.code} — {c?.intitule}
                  </Link>
                  {editable && (
                    <button className="chip-remove" aria-label={`Retirer l’habilitation ${c?.code}`} onClick={() => remove('habilitations', h.id)}>
                      ✕
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editable && (
          <div className="inline-form">
            <label htmlFor="ajout-habilitation">Habiliter pour</label>
            <select id="ajout-habilitation" className="input" value={coursId || ''} onChange={(e) => setCoursId(Number(e.target.value))}>
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
              Ajouter
            </button>
          </div>
        )}
      </section>
    </>
  );
}
