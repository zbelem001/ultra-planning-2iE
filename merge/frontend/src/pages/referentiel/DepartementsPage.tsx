import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { useData } from '../../store/DataContext';
import type { Departement } from '../../types';

// Page 5 — Départements (BF-01).

export default function DepartementsPage() {
  const { db } = useData();
  const count = (depId: number, list: { departementId: number; archived?: boolean }[]) =>
    list.filter((x) => x.departementId === depId && !x.archived).length;

  return (
    <CrudPage<'departements', Departement>
      collection="departements"
      title="Départements"
      singular="département"
      description="Les départements portent les filières, les cours et les enseignants."
      refs="BF-01"
      rows={db.departements}
      searchText={(d) => `${d.code} ${d.libelle}`}
      columns={[
        { label: 'Code', render: (d) => <strong>{d.code}</strong> },
        { label: 'Libellé', render: (d) => d.libelle },
        { label: 'Filières', render: (d) => count(d.id, db.filieres), align: 'right' },
        { label: 'Cours', render: (d) => count(d.id, db.cours), align: 'right' },
        { label: 'Enseignants', render: (d) => count(d.id, db.enseignants), align: 'right' },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true, placeholder: 'ex. GEI' },
        { key: 'libelle', label: 'Libellé', required: true },
      ]}
      blank={() => ({ id: 0, code: '', libelle: '' })}
      validate={(d) => uniqueCode(db.departements, d)}
    />
  );
}
