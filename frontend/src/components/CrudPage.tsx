import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { canEditReferentiel, useCurrentUser } from '../auth/AuthContext';
import { useData } from '../store/DataContext';
import type { Collection, Db, Entity } from '../types';
import { EmptyState, Modal, PageHeader, ReadOnlyNotice } from './ui';

// Liste + recherche + formulaire en modale + archivage.
// Toutes les pages du référentiel (BF-01 à BF-05, BF-08) reposent dessus.

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
  align?: 'right';
}

export interface Field<T> {
  key: keyof T & string;
  label: string;
  type?: 'text' | 'number' | 'email' | 'tel' | 'time' | 'select';
  options?: { value: string | number; label: string }[];
  required?: boolean;
  min?: number;
  placeholder?: string;
}

type ItemOf<C extends Collection> = Db[C][number];

interface CrudPageProps<C extends Collection, T extends ItemOf<C> & Entity> {
  collection: C;
  title: string;
  description?: string;
  refs?: string;
  singular: string;
  rows: T[];
  columns: Column<T>[];
  fields: Field<T>[];
  blank: () => T;
  searchText: (row: T) => string;
  /** Renvoie un message d'erreur, ou null si l'élément est valide. */
  validate?: (item: T) => string | null;
  rowLink?: (row: T) => string;
  toolbar?: ReactNode;
  embedded?: boolean;
}

export default function CrudPage<C extends Collection, T extends ItemOf<C> & Entity>(
  props: CrudPageProps<C, T>,
) {
  const { collection, rows, columns, fields, singular } = props;
  const user = useCurrentUser();
  const { save } = useData();
  const editable = canEditReferentiel(user.role);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);

  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) => (showArchived || !r.archived) && (!q || props.searchText(r).toLowerCase().includes(q)),
  );

  const archivedCount = rows.filter((r) => r.archived).length;

  function toggleArchive(row: T) {
    save(collection, { ...row, archived: !row.archived });
  }

  const content = (
    <>
      {!editable && <ReadOnlyNotice />}
      <div className="toolbar">
        <input
          type="search"
          className="input search"
          placeholder="Rechercher…"
          aria-label={`Rechercher dans ${props.title.toLowerCase()}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.toolbar}
        {archivedCount > 0 && (
          <label className="checkbox">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Afficher les archivés ({archivedCount})
          </label>
        )}
        <span className="muted small toolbar-count">
          {visible.length} {visible.length > 1 ? 'éléments' : 'élément'}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState>Aucun résultat.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label} className={c.align === 'right' ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
                {(editable || props.rowLink) && <th className="actions-col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className={row.archived ? 'archived' : undefined}>
                  {columns.map((c) => (
                    <td key={c.label} className={c.align === 'right' ? 'num' : undefined}>
                      {c.render(row)}
                    </td>
                  ))}
                  {(editable || props.rowLink) && (
                    <td className="actions-col">
                      {props.rowLink && (
                        <Link className="btn btn-small" to={props.rowLink(row)}>
                          Détail
                        </Link>
                      )}
                      {editable && (
                        <>
                          <button className="btn btn-small" onClick={() => setEditing(row)}>
                            Modifier
                          </button>
                          <button className="btn btn-small btn-ghost" onClick={() => toggleArchive(row)}>
                            {row.archived ? 'Restaurer' : 'Archiver'}
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EntityForm
          title={editing.id ? `Modifier ${singular}` : `Nouveau : ${singular}`}
          item={editing}
          fields={fields}
          validate={props.validate}
          onCancel={() => setEditing(null)}
          onSubmit={(item) => {
            save(collection, item);
            setEditing(null);
          }}
        />
      )}
    </>
  );

  const addButton = editable && (
    <button className="btn btn-primary" onClick={() => setEditing(props.blank())}>
      Ajouter
    </button>
  );

  if (props.embedded) {
    return (
      <section>
        <div className="section-head">
          <h2>{props.title}</h2>
          {addButton}
        </div>
        {content}
      </section>
    );
  }

  return (
    <>
      <PageHeader title={props.title} description={props.description} refs={props.refs} actions={addButton} />
      {content}
    </>
  );
}

export function EntityForm<T extends Entity>({
  title,
  item,
  fields,
  validate,
  onCancel,
  onSubmit,
  extraActions,
}: {
  title: string;
  item: T;
  fields: Field<T>[];
  validate?: (item: T) => string | null;
  onCancel: () => void;
  onSubmit: (item: T) => void;
  extraActions?: ReactNode;
}) {
  const [draft, setDraft] = useState<T>(item);
  const [error, setError] = useState<string | null>(null);

  function update(field: Field<T>, raw: string) {
    const numeric = field.type === 'number' || (field.type === 'select' && typeof item[field.key] === 'number');
    setDraft((d) => ({ ...d, [field.key]: numeric ? Number(raw) : raw }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const message = validate?.(draft) ?? null;
    setError(message);
    if (!message) onSubmit(draft);
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <form className="form" onSubmit={handleSubmit}>
        {fields.map((f) => {
          const id = `champ-${f.key}`;
          const raw = draft[f.key];
          // 0 = clé étrangère pas encore choisie : on affiche « Choisir… »
          const value = f.type === 'select' && raw === 0 ? '' : String(raw ?? '');
          return (
            <div className="field" key={f.key}>
              <label htmlFor={id}>
                {f.label}
                {f.required && <span aria-hidden="true"> *</span>}
              </label>
              {f.type === 'select' ? (
                <select id={id} className="input" value={value} required={f.required} onChange={(e) => update(f, e.target.value)}>
                  <option value="" disabled>
                    Choisir…
                  </option>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  className="input"
                  type={f.type ?? 'text'}
                  value={value}
                  min={f.min}
                  required={f.required}
                  placeholder={f.placeholder}
                  onChange={(e) => update(f, e.target.value)}
                />
              )}
            </div>
          );
        })}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          {extraActions}
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary">
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Vérifie qu'aucun autre élément ne porte déjà ce code. */
export function uniqueCode<T extends Entity & { code: string }>(list: T[], item: T, label = 'code'): string | null {
  const code = item.code.trim().toLowerCase();
  if (!code) return `Le ${label} est obligatoire.`;
  return list.some((x) => x.id !== item.id && x.code.trim().toLowerCase() === code)
    ? `Le ${label} « ${item.code} » est déjà utilisé.`
    : null;
}
