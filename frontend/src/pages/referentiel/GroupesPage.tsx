import { useState } from 'react';
import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { useCurrentUser } from '../../auth/AuthContext';
import { byId, useData } from '../../store/DataContext';
import type { Groupe } from '../../types';
import { departementScope } from './scope';

// Page 7 — Groupes et effectifs (BF-01). L'effectif conditionne CD-04.

export default function GroupesPage() {
  const { db } = useData();
  const user = useCurrentUser();
  const scope = departementScope(user);
  const [filiereId, setFiliereId] = useState(0);
  const filieres = byId(db.filieres);
  const maxCapacite = Math.max(0, ...db.salles.filter((s) => !s.archived).map((s) => s.capacite));
  const filieresVisibles = db.filieres.filter((f) => !f.archived && (!scope || f.departementId === scope));
  const visibles = new Set(filieresVisibles.map((f) => f.id));

  return (
    <CrudPage<'groupes', Groupe>
      collection="groupes"
      title="Groupes"
      singular="groupe"
      description={`Effectif de chaque groupe ; la plus grande salle active compte ${maxCapacite} places.`}
      refs="BF-01, CD-04"
      rows={db.groupes.filter((g) => visibles.has(g.filiereId) && (!filiereId || g.filiereId === filiereId))}
      searchText={(g) => `${g.code} ${filieres.get(g.filiereId)?.code ?? ''}`}
      toolbar={
        <select
          className="input"
          aria-label="Filtrer par filière"
          value={filiereId}
          onChange={(e) => setFiliereId(Number(e.target.value))}
        >
          <option value={0}>Toutes les filières</option>
          {filieresVisibles.map((f) => (
            <option key={f.id} value={f.id}>
              {f.code}
            </option>
          ))}
        </select>
      }
      columns={[
        { label: 'Code', render: (g) => <strong>{g.code}</strong> },
        { label: 'Filière', render: (g) => filieres.get(g.filiereId)?.libelle },
        { label: 'Niveau', render: (g) => <span className="badge">{filieres.get(g.filiereId)?.niveau}</span> },
        {
          label: 'Effectif',
          align: 'right',
          render: (g) =>
            g.effectif > maxCapacite ? (
              <span className="text-danger" title="Aucune salle assez grande (CD-04)">
                {g.effectif} ⚠
              </span>
            ) : (
              g.effectif
            ),
        },
      ]}
      fields={[
        { key: 'code', label: 'Code', required: true },
        { key: 'effectif', label: 'Effectif', type: 'number', min: 1, required: true },
        {
          key: 'filiereId',
          label: 'Filière',
          type: 'select',
          required: true,
          options: filieresVisibles.map((f) => ({ value: f.id, label: `${f.code} — ${f.libelle}` })),
        },
      ]}
      blank={() => ({ id: 0, code: '', effectif: 30, filiereId: filiereId })}
      validate={(g) => uniqueCode(db.groupes, g) ?? (g.effectif < 1 ? 'L’effectif doit être positif.' : null)}
    />
  );
}
