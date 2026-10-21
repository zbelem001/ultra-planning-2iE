import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { PageHeader, ReadOnlyNotice } from '../../components/ui';
import { canEditReferentiel, useCurrentUser } from '../../auth/AuthContext';
import { byId, useData } from '../../store/DataContext';
import type { Cours } from '../../types';
import { departementOptions, departementScope } from './scope';

// Page 8 — Cours (BF-02) et volumes horaires par type de séance (BF-03).

const SEMESTRES = Array.from({ length: 10 }, (_, i) => `S${i + 1}`);

export default function CoursPage() {
  const { db } = useData();
  const user = useCurrentUser();
  const scope = departementScope(user);
  const deps = byId(db.departements);

  function heures(coursId: number, code: string) {
    const type = db.typesSeance.find((t) => t.code === code);
    return db.volumes.find((v) => v.coursId === coursId && v.typeSeanceId === type?.id)?.heures ?? 0;
  }

  return (
    <CrudPage<'cours', Cours>
      collection="cours"
      title="Cours et volumes horaires"
      singular="cours"
      description="Volume prévu par type de séance ; c’est la référence du suivi heures planifiées / prévues."
      refs="BF-02, BF-03"
      rows={db.cours.filter((c) => !scope || c.departementId === scope)}
      searchText={(c) => `${c.code} ${c.intitule} ${c.semestre}`}
      rowLink={(c) => `/referentiel/cours/${c.id}`}
      columns={[
        { label: 'Code', render: (c) => <strong>{c.code}</strong> },
        { label: 'Intitulé', render: (c) => c.intitule },
        { label: 'Sem.', render: (c) => c.semestre },
        { label: 'Dép.', render: (c) => deps.get(c.departementId)?.code },
        { label: 'ECTS', render: (c) => c.ects, align: 'right' },
        { label: 'CM', render: (c) => heures(c.id, 'CM') || '—', align: 'right' },
        { label: 'TD', render: (c) => heures(c.id, 'TD') || '—', align: 'right' },
        { label: 'TP', render: (c) => heures(c.id, 'TP') || '—', align: 'right' },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true },
        { key: 'intitule', label: 'Intitulé', required: true },
        { key: 'ects', label: 'Crédits ECTS', type: 'number', min: 0, required: true },
        { key: 'semestre', label: 'Semestre', type: 'select', required: true, options: SEMESTRES.map((s) => ({ value: s, label: s })) },
        { key: 'departementId', label: 'Département', type: 'select', required: true, options: departementOptions(db) },
      ]}
      blank={() => ({ id: 0, code: '', intitule: '', ects: 3, semestre: 'S1', departementId: scope ?? 0 })}
      validate={(c) => uniqueCode(db.cours, c)}
    />
  );
}

export function CoursDetailPage() {
  const { id } = useParams();
  const { db, save, remove } = useData();
  const user = useCurrentUser();
  const editable = canEditReferentiel(user.role);
  const cours = db.cours.find((c) => c.id === Number(id));
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saved, setSaved] = useState(false);

  if (!cours) return <Navigate to="/introuvable" replace />;
  const scope = departementScope(user);
  if (scope && cours.departementId !== scope) return <Navigate to="/acces-refuse" replace />;

  const typesSalle = byId(db.typesSalle);
  const filieres = byId(db.filieres);
  const enseignants = byId(db.enseignants);
  const volumes = db.volumes.filter((v) => v.coursId === cours.id);
  const valeur = (typeId: number) =>
    drafts[typeId] ?? String(volumes.find((v) => v.typeSeanceId === typeId)?.heures ?? 0);
  const total = db.typesSeance.reduce((sum, t) => sum + (Number(valeur(t.id)) || 0), 0);
  const invalid = db.typesSeance.some((t) => Number(valeur(t.id)) < 0 || Number.isNaN(Number(valeur(t.id))));

  function saveVolumes() {
    for (const t of db.typesSeance) {
      const heures = Number(valeur(t.id));
      const existing = volumes.find((v) => v.typeSeanceId === t.id);
      if (existing && heures === 0) remove('volumes', existing.id);
      else if (existing) save('volumes', { ...existing, heures });
      else if (heures > 0) save('volumes', { id: 0, coursId: cours!.id, typeSeanceId: t.id, heures });
    }
    setDrafts({});
    setSaved(true);
  }

  return (
    <>
      <p className="breadcrumb">
        <Link to="/referentiel/cours">Cours</Link> / {cours.code}
      </p>
      <PageHeader title={cours.intitule} description={`${cours.code} · ${cours.semestre} · ${cours.ects} ECTS`} refs="BF-03, CD-08" />
      {!editable && <ReadOnlyNotice />}
      <div className="grid-2">
        <section className="card">
          <h2>Volume horaire prévu</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Type de séance</th>
                  <th>Salle exigée</th>
                  <th className="num">Heures prévues</th>
                </tr>
              </thead>
              <tbody>
                {db.typesSeance.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className="badge">{t.code}</span> {t.libelle}
                    </td>
                    <td>{typesSalle.get(t.typeSalleId)?.libelle}</td>
                    <td className="num">
                      {editable ? (
                        <input
                          className="input input-num"
                          type="number"
                          min={0}
                          aria-label={`Heures de ${t.code}`}
                          value={valeur(t.id)}
                          onChange={(e) => {
                            setSaved(false);
                            setDrafts((d) => ({ ...d, [t.id]: e.target.value }));
                          }}
                        />
                      ) : (
                        valeur(t.id)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>Total</th>
                  <th className="num">{total} h</th>
                </tr>
              </tfoot>
            </table>
          </div>
          {editable && (
            <div className="form-actions">
              {saved && <span className="text-success" role="status">Volumes enregistrés.</span>}
              <button className="btn btn-primary" onClick={saveVolumes} disabled={invalid || Object.keys(drafts).length === 0}>
                Enregistrer les volumes
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Rattachements</h2>
          <h3>Filières (programme)</h3>
          <ul className="chips">
            {db.programmes
              .filter((p) => p.coursId === cours.id)
              .map((p) => (
                <li key={p.id}>
                  <Link className="chip" to={`/referentiel/filieres/${p.filiereId}`}>
                    {filieres.get(p.filiereId)?.code}
                  </Link>
                </li>
              ))}
          </ul>
          <h3>Enseignants habilités</h3>
          <ul className="chips">
            {db.habilitations
              .filter((h) => h.coursId === cours.id)
              .map((h) => {
                const e = enseignants.get(h.enseignantId);
                return (
                  <li key={h.id}>
                    <Link className="chip" to={`/enseignants/${h.enseignantId}`}>
                      {e?.prenom} {e?.nom}
                    </Link>
                  </li>
                );
              })}
          </ul>
          <p className="muted small">Les habilitations se gèrent depuis la fiche de l’enseignant.</p>
        </section>
      </div>
    </>
  );
}
