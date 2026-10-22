import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { PageHeader } from '../../components/ui';
import { byId, useData } from '../../store/DataContext';
import type { TypeSalle, TypeSeance } from '../../types';

// Page 10 — Types de salle et types de séance (BF-04, CD-05).
// Chaque type de séance exige un type de salle : CM en amphithéâtre, TP en laboratoire…

export default function TypesPage() {
  const { db } = useData();
  const typesSalle = byId(db.typesSalle);

  return (
    <>
      <PageHeader
        title="Types de salle et de séance"
        description="Le type de salle exigé par chaque type de séance est une contrainte dure du moteur."
        refs="BF-04, CD-05"
      />
      <div className="stack">
        <CrudPage<'typesSeance', TypeSeance>
          embedded
          collection="typesSeance"
          title="Types de séance"
          singular="type de séance"
          rows={db.typesSeance}
          searchText={(t) => `${t.code} ${t.libelle}`}
          columns={[
            { label: 'Code', render: (t) => <span className="badge">{t.code}</span> },
            { label: 'Libellé', render: (t) => t.libelle },
            { label: 'Salle exigée', render: (t) => typesSalle.get(t.typeSalleId)?.libelle ?? <span className="text-danger">Non définie</span> },
            {
              label: 'Salles compatibles',
              align: 'right',
              render: (t) => db.salles.filter((s) => !s.archived && s.typeSalleId === t.typeSalleId).length,
            },
          ]}
          fields={[
            { key: 'code', label: 'Code', required: true, placeholder: 'ex. CM' },
            { key: 'libelle', label: 'Libellé', required: true },
            {
              key: 'typeSalleId',
              label: 'Type de salle exigé',
              type: 'select',
              required: true,
              options: db.typesSalle.filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.libelle })),
            },
          ]}
          blank={() => ({ id: 0, code: '', libelle: '', typeSalleId: 0 })}
          validate={(t) => uniqueCode(db.typesSeance, t)}
        />

        <CrudPage<'typesSalle', TypeSalle>
          embedded
          collection="typesSalle"
          title="Types de salle"
          singular="type de salle"
          rows={db.typesSalle}
          searchText={(t) => t.libelle}
          columns={[
            { label: 'Libellé', render: (t) => <strong>{t.libelle}</strong> },
            { label: 'Salles', render: (t) => db.salles.filter((s) => !s.archived && s.typeSalleId === t.id).length, align: 'right' },
            {
              label: 'Exigé par',
              render: (t) =>
                db.typesSeance
                  .filter((s) => s.typeSalleId === t.id)
                  .map((s) => s.code)
                  .join(', ') || '—',
            },
          ]}
          fields={[{ key: 'libelle', label: 'Libellé', required: true }]}
          blank={() => ({ id: 0, libelle: '' })}
          validate={(t) =>
            !t.libelle.trim()
              ? 'Le libellé est obligatoire.'
              : db.typesSalle.some((x) => x.id !== t.id && x.libelle.toLowerCase() === t.libelle.trim().toLowerCase())
                ? 'Ce type de salle existe déjà.'
                : null
          }
        />
      </div>
    </>
  );
}
