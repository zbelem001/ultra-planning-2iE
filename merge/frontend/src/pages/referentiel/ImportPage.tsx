import { useState, type ChangeEvent } from 'react';
import { PageHeader } from '../../components/ui';
import { downloadText, parseCsv, toCsv } from '../../lib/csv';
import { useData } from '../../store/DataContext';
import { IMPORT_TARGETS, type ImportTarget, type Row } from './importTargets';

// Page 12 — Import CSV/Excel avec rapport d'erreurs (BF-07).
// Étapes : choisir le gabarit → déposer le fichier → contrôler → charger les lignes valides.

interface Analysed {
  ligne: number;
  row: Row;
  item?: Record<string, unknown>;
  erreurs: string[];
}

function analyse(target: ImportTarget, rows: string[][], db: ReturnType<typeof useData>['db']) {
  const [header, ...data] = rows;
  const cols = header.map((h) => h.trim().toLowerCase());
  const manquantes = target.headers.filter((h) => !cols.includes(h));
  const existants = target.existingKeys(db);
  const vus = new Set<string>();

  const lignes: Analysed[] = data.map((cells, i) => {
    const row: Row = Object.fromEntries(target.headers.map((h) => [h, cells[cols.indexOf(h)] ?? '']));
    const { item, erreurs } = target.convert(row, db);
    const key = target.key(row);
    if (key && existants.has(key)) erreurs.push('existe déjà dans le référentiel');
    else if (key && vus.has(key)) erreurs.push('doublon dans le fichier');
    vus.add(key);
    return { ligne: i + 2, row, item, erreurs };
  });
  return { manquantes, lignes };
}

export default function ImportPage() {
  const { db, insertMany } = useData();
  const [targetId, setTargetId] = useState(IMPORT_TARGETS[0].id);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ReturnType<typeof analyse> | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const target = IMPORT_TARGETS.find((t) => t.id === targetId)!;

  function changeTarget(id: string) {
    setTargetId(id);
    setResult(null);
    setFileName('');
    setDone(null);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setDone(null);
    setFileName(file.name);
    const rows = parseCsv(await file.text());
    setResult(rows.length === 0 ? { manquantes: target.headers, lignes: [] } : analyse(target, rows, db));
  }

  const valides = result?.lignes.filter((l) => l.erreurs.length === 0) ?? [];
  const rejetees = result?.lignes.filter((l) => l.erreurs.length > 0) ?? [];
  const affichees = onlyErrors ? rejetees : (result?.lignes ?? []);

  function charger() {
    insertMany(target.collection, valides.map((l) => l.item!) as never[]);
    setDone(`${valides.length} ligne(s) chargée(s) dans « ${target.label} », ${rejetees.length} rejetée(s).`);
    setResult(null);
    setFileName('');
  }

  function exportRapport() {
    const rows = [['ligne', ...target.headers, 'erreurs'], ...rejetees.map((l) => [String(l.ligne), ...target.headers.map((h) => l.row[h]), l.erreurs.join(' | ')])];
    downloadText(`rapport-import-${target.id}.csv`, toCsv(rows));
  }

  return (
    <>
      <PageHeader
        title="Import CSV"
        description="Reprise des tableurs existants. Aucune ligne n’est chargée avant votre validation."
        refs="BF-07"
      />

      <ol className="steps">
        <li className="card">
          <h2>1. Choisir le gabarit</h2>
          <div className="radio-row" role="radiogroup" aria-label="Type de données">
            {IMPORT_TARGETS.map((t) => (
              <label key={t.id} className={`radio-card ${t.id === targetId ? 'active' : ''}`}>
                <input type="radio" name="cible" value={t.id} checked={t.id === targetId} onChange={() => changeTarget(t.id)} />
                {t.label}
              </label>
            ))}
          </div>
          <p className="muted small">
            Colonnes attendues : <code>{target.headers.join(';')}</code>
          </p>
          <button className="btn" onClick={() => downloadText(`gabarit-${target.id}.csv`, toCsv([target.headers, ...target.example]))}>
            Télécharger le gabarit
          </button>
        </li>

        <li className="card">
          <h2>2. Déposer le fichier</h2>
          <label className="dropzone">
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
            <span>{fileName || 'Choisir un fichier .csv (séparateur ; ou ,)'}</span>
          </label>
          <p className="muted small">Depuis Excel : Fichier › Enregistrer sous › CSV UTF-8.</p>
        </li>
      </ol>

      {done && (
        <p className="notice notice-success" role="status">
          {done}
        </p>
      )}

      {result && (
        <section className="card">
          <h2>3. Contrôle avant chargement</h2>
          {result.manquantes.length > 0 ? (
            <p className="error" role="alert">
              Colonnes manquantes : {result.manquantes.join(', ')}. Utilisez le gabarit fourni.
            </p>
          ) : (
            <>
              <div className="grid-3">
                <div className="stat-inline">
                  <strong>{result.lignes.length}</strong> lignes lues
                </div>
                <div className="stat-inline text-success">
                  <strong>{valides.length}</strong> valides
                </div>
                <div className="stat-inline text-danger">
                  <strong>{rejetees.length}</strong> en erreur
                </div>
              </div>
              <div className="toolbar">
                <label className="checkbox">
                  <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
                  N’afficher que les erreurs
                </label>
                {rejetees.length > 0 && (
                  <button className="btn btn-small" onClick={exportRapport}>
                    Télécharger le rapport d’erreurs
                  </button>
                )}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Ligne</th>
                      {target.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                      <th>Résultat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {affichees.map((l) => (
                      <tr key={l.ligne} className={l.erreurs.length ? 'row-error' : undefined}>
                        <td>{l.ligne}</td>
                        {target.headers.map((h) => (
                          <td key={h}>{l.row[h]}</td>
                        ))}
                        <td>{l.erreurs.length ? <span className="text-danger">{l.erreurs.join(' ; ')}</span> : <span className="text-success">OK</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => setResult(null)}>
                  Annuler
                </button>
                <button className="btn btn-primary" disabled={valides.length === 0} onClick={charger}>
                  Charger les {valides.length} ligne(s) valide(s)
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
