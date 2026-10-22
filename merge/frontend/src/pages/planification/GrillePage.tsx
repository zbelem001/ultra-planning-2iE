import { useMemo, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { notification } from '../../auth/droits';
import { indexer, SeanceCard, WeekGrid } from '../../components/planning';
import { EmptyState, PageHeader } from '../../components/ui';
import { anomalies, sallesCompatibles, verifierSeance, type SeanceCandidate, type Violation } from '../../lib/contraintes';
import { formatDateTime } from '../../lib/helpers';
import { decrireSeance, demandes, groupesLies, libelleSemestre, semestreActif } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import type { Db, Seance } from '../../types';

// Page 16 — Grille de planification (BF-11, BF-12, BF-13, BF-17).
// Chaque dépôt est contrôlé contre CD-01…CD-09 avant d'être enregistré ;
// un refus affiche tous ses motifs. Le glisser-déposer a un équivalent au
// clic (« Déplacer ici ») pour le clavier et les écrans tactiles.

type Vue = 'groupe' | 'enseignant' | 'salle';

type Objet = { genre: 'seance'; id: number } | { genre: 'demande'; coursId: number; typeSeanceId: number; groupeId: number };

interface Placement {
  seance?: SeanceCandidate;
  violations: Violation[];
  salleChangee?: boolean;
}

/** Meilleur placement d'une séance sur un créneau : salle actuelle si possible, sinon la plus ajustée. */
function placer(db: Db, base: SeanceCandidate, creneauId: number, enseignants: number[]): Placement {
  let premier: Violation[] | null = null;
  for (const enseignantId of enseignants) {
    const cand = { ...base, enseignantId, creneauId };
    const v = verifierSeance(db, cand);
    if (v.length === 0) return { seance: cand, violations: [] };
    const salle = sallesCompatibles(db, cand)[0];
    if (salle) return { seance: { ...cand, salleId: salle.id }, violations: [], salleChangee: true };
    premier ??= v;
  }
  return { violations: premier ?? [{ code: 'CD-06', message: 'Aucun enseignant habilité pour ce cours.' }] };
}

function enseignantsHabilites(db: Db, coursId: number) {
  return db.habilitations.filter((h) => h.coursId === coursId).map((h) => h.enseignantId);
}

/** Salle par défaut d'une nouvelle séance : bon type et capacité suffisante si possible. */
function salleParDefaut(db: Db, typeSeanceId: number, groupeId: number): number {
  const type = db.typesSeance.find((t) => t.id === typeSeanceId);
  const effectif = db.groupes.find((g) => g.id === groupeId)?.effectif ?? 0;
  const duType = db.salles.filter((s) => !s.archived && s.typeSalleId === type?.typeSalleId).sort((a, b) => a.capacite - b.capacite);
  return (duType.find((s) => s.capacite >= effectif) ?? duType[duType.length - 1] ?? db.salles[0]).id;
}

export default function GrillePage() {
  const { db, save, remove, insertMany } = useData();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const index = indexer(db);
  const semestre = semestreActif(db);
  const ferme = semestre?.statut === 'cloturee';

  const vue = (params.get('vue') as Vue) || 'groupe';
  const listes = {
    groupe: db.groupes.filter((g) => !g.archived).map((g) => ({ id: g.id, label: `${g.code} (${g.effectif})` })),
    enseignant: db.enseignants.filter((e) => !e.archived).map((e) => ({ id: e.id, label: `${e.nom.toUpperCase()} ${e.prenom}` })),
    salle: db.salles.filter((s) => !s.archived).map((s) => ({ id: s.id, label: `${s.code} (${s.capacite} pl.)` })),
  };
  const choixId = Number(params.get('id')) || listes[vue][0]?.id;

  const [selection, setSelection] = useState<Objet | null>(null);
  const [glisse, setGlisse] = useState<Objet | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; texte: string; violations?: Violation[]; annulee?: Seance } | null>(null);
  const [dureeControle, setDureeControle] = useState<number | null>(null);

  const visibles = db.seances.filter((s) => {
    if (vue === 'groupe') return groupesLies(db, choixId).includes(s.groupeId);
    if (vue === 'enseignant') return s.enseignantId === choixId;
    return s.salleId === choixId;
  });

  // Séances du programme encore à placer pour le groupe affiché
  const aPlacer =
    vue === 'groupe'
      ? demandes(db)
          .filter((d) => d.groupeId === choixId)
          .flatMap((d) => {
            const deja = db.seances.filter((s) => s.coursId === d.coursId && s.typeSeanceId === d.typeSeanceId && s.groupeId === d.groupeId).length;
            return Array.from({ length: Math.max(0, d.parSemaine - deja) }, () => d);
          })
      : [];

  const candidatDe = (o: Objet): { base: SeanceCandidate; enseignants: number[] } | null => {
    if (o.genre === 'seance') {
      const s = db.seances.find((x) => x.id === o.id);
      return s ? { base: s, enseignants: [s.enseignantId] } : null;
    }
    const enseignants = enseignantsHabilites(db, o.coursId);
    const base: SeanceCandidate = {
      id: 0,
      coursId: o.coursId,
      typeSeanceId: o.typeSeanceId,
      groupeId: o.groupeId,
      enseignantId: enseignants[0] ?? 0,
      salleId: salleParDefaut(db, o.typeSeanceId, o.groupeId),
      creneauId: db.creneaux[0].id,
    };
    return { base, enseignants: enseignants.length ? enseignants : [0] };
  };

  // Créneaux compatibles avec l'objet glissé ou sélectionné (BF-13)
  const actif = glisse ?? selection;
  const propositions = useMemo(() => {
    const res = new Map<number, Placement>();
    if (!actif) return res;
    const c = candidatDe(actif);
    if (!c) return res;
    for (const cr of db.creneaux.filter((x) => !x.archived)) res.set(cr.id, placer(db, c.base, cr.id, c.enseignants));
    return res;
  }, [actif, db]);

  function deposer(o: Objet, creneauId: number) {
    setGlisse(null);
    if (ferme) return;
    const c = candidatDe(o);
    if (!c) return;
    if (o.genre === 'seance' && c.base.verrouillee) {
      setMessage({ ok: false, texte: 'Séance verrouillée : déverrouillez-la avant de la déplacer.' });
      return;
    }
    const t0 = performance.now();
    const p = placer(db, c.base, creneauId, c.enseignants);
    setDureeControle(performance.now() - t0);
    const cr = index.creneaux.get(creneauId);
    if (!p.seance) {
      setMessage({ ok: false, texte: `Placement refusé le ${cr?.jour} ${cr?.debut} :`, violations: p.violations });
      return;
    }
    save('seances', p.seance);
    setSelection(null);
    const salle = index.salles.get(p.seance.salleId)?.code;
    setMessage({
      ok: true,
      texte: `${o.genre === 'seance' ? 'Séance déplacée' : 'Séance créée'} le ${cr?.jour} ${cr?.debut}${p.salleChangee ? `, en salle ${salle} (salle compatible proposée)` : ''}.`,
    });
  }

  function annuler(id: number) {
    const s = db.seances.find((x) => x.id === id);
    if (!s || ferme) return;
    if (s.verrouillee) {
      setMessage({ ok: false, texte: 'Séance verrouillée : déverrouillez-la avant de l’annuler.' });
      return;
    }
    remove('seances', id);
    setSelection(null);
    setMessage({ ok: true, texte: `Séance annulée : ${decrireSeance(db, s)}.`, annulee: s });
  }

  const lire = (e: DragEvent): Objet | null => {
    try {
      return JSON.parse(e.dataTransfer.getData('application/json')) as Objet;
    } catch {
      return glisse;
    }
  };
  const commencer = (o: Objet) => (e: DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify(o));
    e.dataTransfer.effectAllowed = 'move';
    setGlisse(o);
    setMessage(null);
  };

  const seanceSelectionnee = selection?.genre === 'seance' ? db.seances.find((s) => s.id === selection.id) : undefined;
  const enAnomalie = anomalies(db);
  const signalements = db.signalements.filter((s) => s.statut === 'ouvert');

  return (
    <>
      <PageHeader
        title="Grille de planification"
        description={`Semaine type · ${libelleSemestre(db, semestre)}${ferme ? ' · semestre clôturé (lecture seule)' : ''}`}
        refs="BF-11, BF-12, BF-13, BF-17 · CD-01 à CD-09"
        actions={
          <Link className="btn" to="/planification/duplication">
            Dupliquer sur le semestre
          </Link>
        }
      />

      <div className="toolbar">
        <div className="radio-row" role="radiogroup" aria-label="Afficher la grille par">
          {(['groupe', 'enseignant', 'salle'] as Vue[]).map((v) => (
            <label key={v} className={`radio-card ${vue === v ? 'active' : ''}`}>
              <input type="radio" name="vue" checked={vue === v} onChange={() => setParams({ vue: v })} />
              {v === 'groupe' ? 'Groupe' : v === 'enseignant' ? 'Enseignant' : 'Salle'}
            </label>
          ))}
        </div>
        <select
          className="input"
          aria-label="Élément affiché"
          value={choixId}
          onChange={(e) => {
            setSelection(null);
            setParams({ vue, id: e.target.value });
          }}
        >
          {listes[vue].map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        {dureeControle !== null && (
          <span className="muted small toolbar-count">
            Dernier contrôle : {dureeControle.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ms (cible &lt; 500 ms, BNF-02)
          </span>
        )}
      </div>

      {message && (
        <div className={message.ok ? 'notice notice-success' : 'error refus'} role={message.ok ? 'status' : 'alert'}>
          <strong>{message.texte}</strong>
          {message.violations && (
            <ul className="motifs">
              {message.violations.map((v, i) => (
                <li key={i}>
                  <span className="badge badge-danger">{v.code}</span> {v.message}
                </li>
              ))}
            </ul>
          )}
          {message.annulee && (
            <button
              className="btn btn-small"
              onClick={() => {
                save('seances', message.annulee!);
                setMessage({ ok: true, texte: 'Séance rétablie.' });
              }}
            >
              Rétablir
            </button>
          )}
        </div>
      )}

      <div className="planning-layout">
        <div className="planning-main">
          {actif && (
            <p className="notice small">
              Cases vertes : placement possible (une salle compatible est choisie si besoin). Cases rouges : survolez-les pour lire le motif.
            </p>
          )}
          <WeekGrid
            db={db}
            label="Semaine type"
            cellProps={(c) => {
              const p = propositions.get(c.id);
              return {
                className: p ? (p.seance ? 'cell-ok' : 'cell-ko') : '',
                title: p && !p.seance ? p.violations.map((v) => `${v.code} : ${v.message}`).join('\n') : undefined,
                onDragOver: (e) => e.preventDefault(),
                onDrop: (e) => {
                  e.preventDefault();
                  const o = lire(e);
                  if (o) deposer(o, c.id);
                },
              };
            }}
            renderCell={(c) => (
              <div className="cell-stack">
                {visibles
                  .filter((s) => s.creneauId === c.id)
                  .map((s) => (
                    <SeanceCard
                      key={s.id}
                      seance={s}
                      index={index}
                      montrer={vue === 'groupe' ? ['salle', 'enseignant'] : vue === 'salle' ? ['groupe', 'enseignant'] : ['groupe', 'salle']}
                      className={`${selection?.genre === 'seance' && selection.id === s.id ? 'selected' : ''} ${s.groupeId !== choixId && vue === 'groupe' ? 'linked' : ''} ${enAnomalie.some((a) => a.seance.id === s.id) ? 'anomalie' : ''}`}
                      draggable={!ferme && !s.verrouillee}
                      onDragStart={commencer({ genre: 'seance', id: s.id })}
                      onDragEnd={() => setGlisse(null)}
                    >
                      <button className="link-btn" onClick={() => setSelection({ genre: 'seance', id: s.id })} aria-label={`Sélectionner ${decrireSeance(db, s)}`}>
                        Détail
                      </button>
                    </SeanceCard>
                  ))}
                {selection && !ferme && (
                  <button className={`btn btn-small move-here ${propositions.get(c.id)?.seance ? '' : 'ko'}`} onClick={() => deposer(selection, c.id)}>
                    Déplacer ici
                  </button>
                )}
              </div>
            )}
          />
          {!ferme && (
            <div
              className="drop-delete"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const o = lire(e);
                if (o?.genre === 'seance') annuler(o.id);
                setGlisse(null);
              }}
            >
              Déposez une séance ici pour l’annuler
            </div>
          )}
        </div>

        <aside className="planning-side">
          {vue === 'groupe' && (
            <section className="card">
              <h2>À placer ({aPlacer.length})</h2>
              {aPlacer.length === 0 ? (
                <EmptyState>Toutes les séances du programme de ce groupe sont placées.</EmptyState>
              ) : (
                <ul className="palette">
                  {aPlacer.map((d, i) => {
                    const o: Objet = { genre: 'demande', coursId: d.coursId, typeSeanceId: d.typeSeanceId, groupeId: d.groupeId };
                    const choisi = selection?.genre === 'demande' && selection.coursId === d.coursId && selection.typeSeanceId === d.typeSeanceId;
                    return (
                      <li key={i}>
                        <button
                          className={`palette-item ${choisi ? 'selected' : ''}`}
                          draggable={!ferme}
                          onDragStart={commencer(o)}
                          onDragEnd={() => setGlisse(null)}
                          onClick={() => setSelection(choisi ? null : o)}
                        >
                          <span className="badge">{index.types.get(d.typeSeanceId)?.code}</span> {index.cours.get(d.coursId)?.code}
                          <span className="muted small"> {index.cours.get(d.coursId)?.intitule}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="muted small">Glissez une séance sur la grille, ou cliquez dessus puis sur « Déplacer ici ».</p>
            </section>
          )}

          {seanceSelectionnee && (
            <DetailSeance
              key={seanceSelectionnee.id}
              seance={seanceSelectionnee}
              ferme={ferme}
              onFermer={() => setSelection(null)}
              onAnnuler={() => annuler(seanceSelectionnee.id)}
              onDeplacer={(creneauId) => deposer({ genre: 'seance', id: seanceSelectionnee.id }, creneauId)}
              propositions={propositions}
              onMessage={setMessage}
            />
          )}
          {selection?.genre === 'demande' && (
            <section className="card">
              <h2>Créneaux compatibles</h2>
              <ChipsCreneaux propositions={propositions} onChoisir={(id) => deposer(selection, id)} />
              <button className="btn btn-ghost btn-small" onClick={() => setSelection(null)}>
                Annuler la sélection
              </button>
            </section>
          )}

          <section className="card">
            <h2>Contrôles ({enAnomalie.length})</h2>
            {enAnomalie.length === 0 ? (
              <EmptyState>Aucune séance ne viole une contrainte dure.</EmptyState>
            ) : (
              <ul className="alert-list">
                {enAnomalie.map(({ seance, violations }) => (
                  <li key={seance.id} className="alert alert-erreur">
                    <span>
                      <strong>{decrireSeance(db, seance)}</strong>
                      <br />
                      {violations.map((v) => `${v.code} : ${v.message}`).join(' ')}
                    </span>
                    <button
                      className="link-btn"
                      onClick={() => {
                        setParams({ vue: 'groupe', id: String(seance.groupeId) });
                        setSelection({ genre: 'seance', id: seance.id });
                      }}
                    >
                      Voir
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Signalements ({signalements.length})</h2>
            {signalements.length === 0 ? (
              <EmptyState>Aucun signalement ouvert.</EmptyState>
            ) : (
              <ul className="notif-list">
                {signalements.map((sg) => {
                  const s = db.seances.find((x) => x.id === sg.seanceId);
                  const auteur = db.utilisateurs.find((u) => u.id === sg.utilisateurId);
                  return (
                    <li key={sg.id} className="notif">
                      <div>
                        <strong>{sg.motif}</strong>
                        <p>{sg.texte}</p>
                        <span className="muted small">
                          {s ? decrireSeance(db, s) : 'Séance supprimée'} · {auteur?.nom} · {formatDateTime(sg.date)}
                        </span>
                      </div>
                      <button
                        className="btn btn-small"
                        onClick={() => {
                          save('signalements', { ...sg, statut: 'traite' });
                          if (user) insertMany('notifications', [notification(sg.utilisateurId, 'Signalement traité', `Votre signalement « ${sg.motif} » a été traité par ${user.nom}.`)]);
                        }}
                      >
                        Traité
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function ChipsCreneaux({ propositions, onChoisir }: { propositions: Map<number, Placement>; onChoisir: (creneauId: number) => void }) {
  const { db } = useData();
  const ok = [...propositions.values()].filter((p) => p.seance);
  if (ok.length === 0) return <EmptyState>Aucun créneau compatible.</EmptyState>;
  return (
    <ul className="chips">
      {ok.map((p) => {
        const c = db.creneaux.find((x) => x.id === p.seance!.creneauId);
        const salle = db.salles.find((x) => x.id === p.seance!.salleId);
        return (
          <li key={c?.id}>
            <button className="chip chip-btn" onClick={() => onChoisir(c!.id)}>
              {c?.jour.slice(0, 3)} {c?.debut} · {salle?.code}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DetailSeance({
  seance,
  ferme,
  onFermer,
  onAnnuler,
  onDeplacer,
  propositions,
  onMessage,
}: {
  seance: Seance;
  ferme: boolean;
  onFermer: () => void;
  onAnnuler: () => void;
  onDeplacer: (creneauId: number) => void;
  propositions: Map<number, Placement>;
  onMessage: (m: { ok: boolean; texte: string; violations?: Violation[] }) => void;
}) {
  const { db, save } = useData();
  const [enseignantId, setEnseignantId] = useState(seance.enseignantId);
  const [salleId, setSalleId] = useState(seance.salleId);
  const brouillon = { ...seance, enseignantId, salleId };
  const violations = verifierSeance(db, brouillon);
  const compatibles = new Set(sallesCompatibles(db, { ...brouillon }).map((s) => s.id));
  const type = db.typesSeance.find((t) => t.id === seance.typeSeanceId);
  const cours = db.cours.find((c) => c.id === seance.coursId);
  const modifie = enseignantId !== seance.enseignantId || salleId !== seance.salleId;

  function appliquer() {
    if (violations.length) {
      onMessage({ ok: false, texte: 'Modification refusée :', violations });
      return;
    }
    save('seances', brouillon);
    onMessage({ ok: true, texte: 'Séance modifiée.' });
  }

  return (
    <section className="card">
      <div className="section-head">
        <h2>
          {cours?.code} {type?.code}
        </h2>
        <button className="btn btn-ghost btn-small" onClick={onFermer} aria-label="Fermer le détail">
          ✕
        </button>
      </div>
      <p className="muted small">{decrireSeance(db, seance)}</p>
      <div className="form">
        <div className="field">
          <label htmlFor="det-ens">Enseignant (habilités)</label>
          <select id="det-ens" className="input" value={enseignantId} disabled={ferme} onChange={(e) => setEnseignantId(Number(e.target.value))}>
            {enseignantsHabilites(db, seance.coursId).map((id) => {
              const e = db.enseignants.find((x) => x.id === id);
              const ok = verifierSeance(db, { ...brouillon, enseignantId: id }).every((v) => v.code !== 'CD-02' && v.code !== 'CD-06');
              return (
                <option key={id} value={id}>
                  {e?.prenom} {e?.nom} {ok ? '' : '— indisponible'}
                </option>
              );
            })}
          </select>
        </div>
        <div className="field">
          <label htmlFor="det-salle">Salle</label>
          <select id="det-salle" className="input" value={salleId} disabled={ferme} onChange={(e) => setSalleId(Number(e.target.value))}>
            {db.salles
              .filter((s) => !s.archived)
              .sort((a, b) => Number(compatibles.has(b.id)) - Number(compatibles.has(a.id)) || a.capacite - b.capacite)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {compatibles.has(s.id) ? '✓' : '✗'} {s.code} · {s.capacite} pl.
                </option>
              ))}
          </select>
        </div>
        {violations.length > 0 && (
          <ul className="motifs error">
            {violations.map((v, i) => (
              <li key={i}>
                <span className="badge badge-danger">{v.code}</span> {v.message}
              </li>
            ))}
          </ul>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!seance.verrouillee}
            disabled={ferme}
            onChange={(e) => save('seances', { ...seance, verrouillee: e.target.checked })}
          />
          Verrouiller (la génération ne la déplacera pas)
        </label>
        <div>
          <h3>Autres créneaux compatibles</h3>
          <ChipsCreneaux propositions={new Map([...propositions].filter(([id]) => id !== seance.creneauId))} onChoisir={onDeplacer} />
        </div>
        {!ferme && (
          <div className="form-actions">
            <button className="btn btn-danger push-left" onClick={onAnnuler}>
              Annuler la séance
            </button>
            <button className="btn btn-primary" onClick={appliquer} disabled={!modifie}>
              Appliquer
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
