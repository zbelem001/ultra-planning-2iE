import { useState, type FormEvent } from 'react';
import { EmptyState, Modal, PageHeader } from '../../components/ui';
import { formatDateCourte, jourDeDate, parametres, versionPubliee } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import { STATUT_PERIODE_LABELS, type AnneeUniversitaire, type Semestre, type StatutPeriode } from '../../types';

// Page 27 — Années universitaires et semestres : ouverture et clôture (BF-26).
// ANNEE_UNIVERSITAIRE / SEMESTRE sont une évolution prévue du MLD (§7) : mockées.
// Règles : un semestre ne s'ouvre que dans une année ouverte ; une année ne se
// clôture qu'une fois tous ses semestres clôturés ; un semestre clôturé n'est
// plus modifiable (la grille passe en lecture seule, CD-09).

const BADGE: Record<StatutPeriode, string> = { a_venir: '', ouverte: 'badge-ok', cloturee: 'badge-warn' };

type Edition = { genre: 'annee'; item: AnneeUniversitaire } | { genre: 'semestre'; item: Semestre };
type Confirmation = { titre: string; texte: string; action: () => void };

export default function AnneesPage() {
  const { db, save } = useData();
  const [edition, setEdition] = useState<Edition | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const actif = parametres(db).semestreActifId;
  const annees = [...db.annees].sort((a, b) => b.debut.localeCompare(a.debut));

  function changerAnnee(a: AnneeUniversitaire, statut: StatutPeriode) {
    const semestres = db.semestres.filter((s) => s.anneeId === a.id);
    if (statut === 'cloturee' && semestres.some((s) => s.statut !== 'cloturee')) {
      setMessage(`Impossible de clôturer ${a.libelle} : clôturez d’abord tous ses semestres.`);
      return;
    }
    const appliquer = () => {
      save('annees', { ...a, statut });
      setMessage(`Année ${a.libelle} : ${STATUT_PERIODE_LABELS[statut].toLowerCase()}.`);
    };
    if (statut === 'cloturee') setConfirmation({ titre: `Clôturer ${a.libelle} ?`, texte: 'L’année et ses semestres passeront en lecture seule.', action: appliquer });
    else appliquer();
  }

  function changerSemestre(s: Semestre, statut: StatutPeriode) {
    const annee = db.annees.find((a) => a.id === s.anneeId)!;
    if (statut === 'ouverte' && annee.statut !== 'ouverte') {
      setMessage(`Ouvrez d’abord l’année ${annee.libelle}.`);
      return;
    }
    const appliquer = () => {
      save('semestres', { ...s, statut });
      setMessage(`${s.code} ${annee.libelle} : ${STATUT_PERIODE_LABELS[statut].toLowerCase()}.`);
    };
    if (statut === 'cloturee') {
      const publie = versionPubliee(db, s.id);
      setConfirmation({
        titre: `Clôturer ${s.code} ${annee.libelle} ?`,
        texte: `${publie ? `La version ${publie.numero} publiée restera consultable.` : 'Attention : aucun emploi du temps n’a été publié pour ce semestre.'} Plus aucune séance ne pourra être créée ni déplacée.`,
        action: appliquer,
      });
    } else appliquer();
  }

  return (
    <>
      <PageHeader
        title="Années universitaires et semestres"
        refs="BF-26"
        actions={
          <button
            className="btn btn-primary"
            onClick={() => {
              const derniere = annees[0];
              const an = derniere ? Number(derniere.libelle.slice(5)) : new Date().getFullYear();
              setEdition({ genre: 'annee', item: { id: 0, libelle: `${an}-${an + 1}`, debut: `${an}-09-01`, fin: `${an + 1}-07-31`, statut: 'a_venir' } });
            }}
          >
            Nouvelle année
          </button>
        }
      />
      <p className="notice">Ces tables ne figurent pas encore dans le MLD (évolution prévue au §7 du cahier des charges) : les données sont fictives.</p>
      {message && (
        <p className="notice notice-success" role="status">
          {message}
        </p>
      )}

      {annees.length === 0 && <EmptyState>Aucune année universitaire.</EmptyState>}
      {annees.map((a) => {
        const semestres = db.semestres.filter((s) => s.anneeId === a.id).sort((x, y) => x.debut.localeCompare(y.debut));
        return (
          <section key={a.id} className="card">
            <div className="section-head">
              <h2>
                {a.libelle} <span className={`badge ${BADGE[a.statut]}`}>{STATUT_PERIODE_LABELS[a.statut]}</span>
              </h2>
              <div className="shortcuts">
                {a.statut !== 'cloturee' && (
                  <button className="btn btn-small" onClick={() => setEdition({ genre: 'annee', item: a })}>
                    Modifier
                  </button>
                )}
                {a.statut === 'a_venir' && (
                  <button className="btn btn-small btn-primary" onClick={() => changerAnnee(a, 'ouverte')}>
                    Ouvrir
                  </button>
                )}
                {a.statut === 'ouverte' && (
                  <button className="btn btn-small btn-danger" onClick={() => changerAnnee(a, 'cloturee')}>
                    Clôturer
                  </button>
                )}
                {a.statut !== 'cloturee' && (
                  <button
                    className="btn btn-small"
                    onClick={() => {
                      const dernier = semestres[semestres.length - 1];
                      setEdition({
                        genre: 'semestre',
                        item: { id: 0, anneeId: a.id, code: `S${semestres.length + 1}`, debut: dernier ? dernier.fin : a.debut, fin: dernier ? dernier.fin : a.fin, statut: 'a_venir' },
                      });
                    }}
                  >
                    Ajouter un semestre
                  </button>
                )}
              </div>
            </div>
            <p className="muted small">
              Du {formatDateCourte(a.debut)} au {formatDateCourte(a.fin)}
            </p>
            {semestres.length === 0 ? (
              <EmptyState>Aucun semestre.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Semestre</th>
                      <th>Début</th>
                      <th>Fin</th>
                      <th>État</th>
                      <th>Version publiée</th>
                      <th className="actions-col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {semestres.map((s) => {
                      const v = versionPubliee(db, s.id);
                      return (
                        <tr key={s.id}>
                          <td>
                            <strong>{s.code}</strong> {s.id === actif && <span className="badge badge-accent">Actif</span>}
                          </td>
                          <td>{formatDateCourte(s.debut)}</td>
                          <td>{formatDateCourte(s.fin)}</td>
                          <td>
                            <span className={`badge ${BADGE[s.statut]}`}>{STATUT_PERIODE_LABELS[s.statut]}</span>
                          </td>
                          <td>{v ? `v${v.numero}` : '—'}</td>
                          <td className="actions-col">
                            {s.statut !== 'cloturee' && (
                              <button className="btn btn-small" onClick={() => setEdition({ genre: 'semestre', item: s })}>
                                Modifier
                              </button>
                            )}
                            {s.statut === 'a_venir' && (
                              <button className="btn btn-small btn-primary" onClick={() => changerSemestre(s, 'ouverte')}>
                                Ouvrir
                              </button>
                            )}
                            {s.statut === 'ouverte' && (
                              <button className="btn btn-small btn-danger" onClick={() => changerSemestre(s, 'cloturee')}>
                                Clôturer
                              </button>
                            )}
                            {s.statut !== 'cloturee' && s.id !== actif && (
                              <button className="btn btn-small btn-ghost" onClick={() => save('parametres', { ...parametres(db), semestreActifId: s.id })}>
                                Rendre actif
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {edition && (
        <FormulairePeriode
          edition={edition}
          onClose={() => setEdition(null)}
          onSave={(e) => {
            if (e.genre === 'annee') save('annees', e.item);
            else save('semestres', e.item);
            setEdition(null);
            setMessage('Enregistré.');
          }}
        />
      )}

      {confirmation && (
        <Modal title={confirmation.titre} onClose={() => setConfirmation(null)}>
          <p>{confirmation.texte}</p>
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmation(null)}>
              Annuler
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                confirmation.action();
                setConfirmation(null);
              }}
            >
              Confirmer
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function FormulairePeriode({ edition, onClose, onSave }: { edition: Edition; onClose: () => void; onSave: (e: Edition) => void }) {
  const { db } = useData();
  const [libelle, setLibelle] = useState(edition.genre === 'annee' ? edition.item.libelle : edition.item.code);
  const [debut, setDebut] = useState(edition.item.debut);
  const [fin, setFin] = useState(edition.item.fin);
  const [erreur, setErreur] = useState<string | null>(null);

  function valider(): string | null {
    if (!libelle.trim()) return 'Le libellé est obligatoire.';
    if (!debut || !fin || debut >= fin) return 'La date de fin doit suivre la date de début.';
    if (edition.genre === 'annee') {
      if (!/^\d{4}-\d{4}$/.test(libelle.trim())) return 'Le libellé suit le format 2028-2029.';
      if (db.annees.some((a) => a.id !== edition.item.id && a.libelle === libelle.trim())) return 'Cette année existe déjà.';
      return null;
    }
    const annee = db.annees.find((a) => a.id === edition.item.anneeId)!;
    if (debut < annee.debut || fin > annee.fin) return `Le semestre doit tenir dans l’année (${formatDateCourte(annee.debut)} → ${formatDateCourte(annee.fin)}).`;
    if (jourDeDate(debut) !== 'Lundi') return 'Un semestre commence un lundi.';
    const chevauche = db.semestres.find((s) => s.anneeId === annee.id && s.id !== edition.item.id && debut <= s.fin && fin >= s.debut);
    if (chevauche) return `Les dates chevauchent ${chevauche.code}.`;
    return null;
  }

  function envoyer(e: FormEvent) {
    e.preventDefault();
    const msg = valider();
    setErreur(msg);
    if (msg) return;
    if (edition.genre === 'annee') onSave({ genre: 'annee', item: { ...edition.item, libelle: libelle.trim(), debut, fin } });
    else onSave({ genre: 'semestre', item: { ...edition.item, code: libelle.trim(), debut, fin } });
  }

  const titre = edition.genre === 'annee' ? (edition.item.id ? 'Modifier l’année' : 'Nouvelle année universitaire') : edition.item.id ? 'Modifier le semestre' : 'Nouveau semestre';
  return (
    <Modal title={titre} onClose={onClose}>
      <form className="form" onSubmit={envoyer}>
        <div className="field">
          <label htmlFor="per-libelle">{edition.genre === 'annee' ? 'Libellé' : 'Code'}</label>
          <input id="per-libelle" className="input" value={libelle} onChange={(e) => setLibelle(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="per-debut">Début</label>
          <input id="per-debut" type="date" className="input" value={debut} onChange={(e) => setDebut(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="per-fin">Fin</label>
          <input id="per-fin" type="date" className="input" value={fin} onChange={(e) => setFin(e.target.value)} required />
        </div>
        {erreur && (
          <p className="error" role="alert">
            {erreur}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
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
