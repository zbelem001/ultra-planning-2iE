import { useState } from 'react';
import { EntityForm } from '../../components/CrudPage';
import { PageHeader, ReadOnlyNotice } from '../../components/ui';
import { canEditReferentiel, useCurrentUser } from '../../auth/AuthContext';
import { useData } from '../../store/DataContext';
import { JOURS, type Creneau } from '../../types';

// Page 11 — Grille des créneaux hebdomadaires (BF-05).
// Affichée en grille jour × plage horaire, comme la future grille de planification.

export default function CreneauxPage() {
  const { db, save, remove } = useData();
  const user = useCurrentUser();
  const editable = canEditReferentiel(user.role);
  const [editing, setEditing] = useState<Creneau | null>(null);

  const creneaux = [...db.creneaux].sort((a, b) => a.debut.localeCompare(b.debut));
  const plages = Array.from(new Set(creneaux.map((c) => `${c.debut}-${c.fin}`))).sort();
  const find = (jour: string, plage: string) => creneaux.find((c) => c.jour === jour && `${c.debut}-${c.fin}` === plage);
  const usedBySeance = new Set(db.seances.map((s) => s.creneauId));

  function validate(c: Creneau): string | null {
    if (c.fin <= c.debut) return 'L’heure de fin doit être après l’heure de début.';
    const chevauche = db.creneaux.find(
      (x) => x.id !== c.id && x.jour === c.jour && x.debut < c.fin && c.debut < x.fin,
    );
    return chevauche ? `Chevauche le créneau ${chevauche.jour} ${chevauche.debut}–${chevauche.fin}.` : null;
  }

  return (
    <>
      <PageHeader
        title="Grille des créneaux"
        description={`${db.creneaux.length} créneaux par semaine. Cliquez sur une case pour la modifier.`}
        refs="BF-05, CD-09"
        actions={
          editable && (
            <button className="btn btn-primary" onClick={() => setEditing({ id: 0, jour: 'Lundi', debut: '08:00', fin: '10:00' })}>
              Ajouter un créneau
            </button>
          )
        }
      />
      {!editable && <ReadOnlyNotice />}
      <div className="table-wrap">
        <table className="table grid-table">
          <thead>
            <tr>
              <th>Plage</th>
              {JOURS.map((j) => (
                <th key={j}>{j}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plages.map((plage) => (
              <tr key={plage}>
                <th scope="row">{plage.replace('-', ' – ')}</th>
                {JOURS.map((jour) => {
                  const c = find(jour, plage);
                  if (!c) return <td key={jour} className="slot slot-empty" />;
                  return (
                    <td key={jour} className="slot">
                      {editable ? (
                        <button className="slot-btn" onClick={() => setEditing(c)} aria-label={`Modifier ${jour} ${c.debut}–${c.fin}`}>
                          {c.debut} – {c.fin}
                        </button>
                      ) : (
                        <span>
                          {c.debut} – {c.fin}
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

      {editing && (
        <EntityForm<Creneau>
          title={editing.id ? 'Modifier le créneau' : 'Nouveau créneau'}
          item={editing}
          validate={validate}
          fields={[
            { key: 'jour', label: 'Jour', type: 'select', required: true, options: JOURS.map((j) => ({ value: j, label: j })) },
            { key: 'debut', label: 'Début', type: 'time', required: true },
            { key: 'fin', label: 'Fin', type: 'time', required: true },
          ]}
          onCancel={() => setEditing(null)}
          onSubmit={(c) => {
            save('creneaux', c);
            setEditing(null);
          }}
          extraActions={
            editing.id !== 0 && (
              <button
                type="button"
                className="btn btn-danger push-left"
                disabled={usedBySeance.has(editing.id)}
                title={usedBySeance.has(editing.id) ? 'Des séances utilisent ce créneau' : undefined}
                onClick={() => {
                  remove('creneaux', editing.id);
                  setEditing(null);
                }}
              >
                Supprimer
              </button>
            )
          }
        />
      )}
    </>
  );
}
