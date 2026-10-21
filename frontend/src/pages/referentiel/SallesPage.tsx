import { useState } from 'react';
import CrudPage, { uniqueCode } from '../../components/CrudPage';
import { PageHeader, Tabs } from '../../components/ui';
import { byId, useData } from '../../store/DataContext';
import type { Batiment, Salle } from '../../types';

// Page 9 — Bâtiments et salles : capacité, étage, type (BF-04).

type Onglet = 'salles' | 'batiments';

export default function SallesPage() {
  const { db } = useData();
  const [onglet, setOnglet] = useState<Onglet>('salles');
  const [typeId, setTypeId] = useState(0);
  const batiments = byId(db.batiments);
  const types = byId(db.typesSalle);
  const salles = db.salles.filter((s) => !s.archived);
  const places = salles.reduce((sum, s) => sum + s.capacite, 0);

  return (
    <>
      <PageHeader
        title="Bâtiments et salles"
        description={`${salles.length} salles actives · ${places} places au total`}
        refs="BF-04, CD-04, CD-05"
      />
      <Tabs<Onglet>
        tabs={[
          { id: 'salles', label: 'Salles' },
          { id: 'batiments', label: 'Bâtiments' },
        ]}
        active={onglet}
        onChange={setOnglet}
      />
      {onglet === 'salles' ? (
        <CrudPage<'salles', Salle>
          embedded
          collection="salles"
          title="Salles"
          singular="salle"
          rows={db.salles.filter((s) => !typeId || s.typeSalleId === typeId)}
          searchText={(s) => `${s.code} ${s.nom} ${batiments.get(s.batimentId)?.code ?? ''}`}
          toolbar={
            <select className="input" aria-label="Filtrer par type de salle" value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
              <option value={0}>Tous les types</option>
              {db.typesSalle.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.libelle}
                </option>
              ))}
            </select>
          }
          columns={[
            { label: 'Code', render: (s) => <strong>{s.code}</strong> },
            { label: 'Nom', render: (s) => s.nom },
            { label: 'Type', render: (s) => <span className="badge">{types.get(s.typeSalleId)?.libelle}</span> },
            { label: 'Bâtiment', render: (s) => batiments.get(s.batimentId)?.code },
            { label: 'Étage', render: (s) => (s.etage === 0 ? 'RDC' : s.etage), align: 'right' },
            { label: 'Capacité', render: (s) => s.capacite, align: 'right' },
          ]}
          fields={[
            { key: 'code', label: 'Code', required: true },
            { key: 'nom', label: 'Nom', required: true },
            { key: 'capacite', label: 'Capacité (places)', type: 'number', min: 1, required: true },
            { key: 'etage', label: 'Étage (0 = rez-de-chaussée)', type: 'number', min: 0, required: true },
            {
              key: 'batimentId',
              label: 'Bâtiment',
              type: 'select',
              required: true,
              options: db.batiments.filter((b) => !b.archived).map((b) => ({ value: b.id, label: b.nom })),
            },
            {
              key: 'typeSalleId',
              label: 'Type de salle',
              type: 'select',
              required: true,
              options: db.typesSalle.map((t) => ({ value: t.id, label: t.libelle })),
            },
          ]}
          blank={() => ({ id: 0, code: '', nom: '', capacite: 30, etage: 0, batimentId: 0, typeSalleId: typeId })}
          validate={(s) => uniqueCode(db.salles, s) ?? (s.capacite < 1 ? 'La capacité doit être positive.' : null)}
        />
      ) : (
        <CrudPage<'batiments', Batiment>
          embedded
          collection="batiments"
          title="Bâtiments"
          singular="bâtiment"
          rows={db.batiments}
          searchText={(b) => `${b.code} ${b.nom}`}
          columns={[
            { label: 'Code', render: (b) => <strong>{b.code}</strong> },
            { label: 'Nom', render: (b) => b.nom },
            { label: 'Salles', render: (b) => db.salles.filter((s) => s.batimentId === b.id && !s.archived).length, align: 'right' },
            {
              label: 'Places',
              align: 'right',
              render: (b) =>
                db.salles.filter((s) => s.batimentId === b.id && !s.archived).reduce((sum, s) => sum + s.capacite, 0),
            },
          ]}
          fields={[
            { key: 'code', label: 'Code', required: true },
            { key: 'nom', label: 'Nom', required: true },
          ]}
          blank={() => ({ id: 0, code: '', nom: '' })}
          validate={(b) => uniqueCode(db.batiments, b)}
        />
      )}
    </>
  );
}
