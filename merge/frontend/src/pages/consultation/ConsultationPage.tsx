import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCurrentUser } from '../../auth/AuthContext';
import { gabarit, notification, remplir } from '../../auth/droits';
import { indexer, joursOuvres, SeanceCard, WeekGrid, type Index } from '../../components/planning';
import { EmptyState, Modal, PageHeader } from '../../components/ui';
import { formatDateTime } from '../../lib/helpers';
import {
  ajouterJours,
  dateDuJour,
  decrireSeance,
  formatDateCourte,
  formatJourCourt,
  groupesLies,
  libelleSemestre,
  lundiDe,
  nomEnseignant,
  occurrences,
  semainesDuSemestre,
  semainesDeCours,
  semestreActif,
  versionPubliee,
  type Occurrence,
} from '../../lib/planning';
import { departementScope } from '../referentiel/scope';
import { useData } from '../../store/DataContext';
import type { Db, Seance, Utilisateur } from '../../types';
import ExportsPanel from './ExportsPanel';

// Page 22 — Consultation de l'emploi du temps (BF-21, BNF-11) par groupe,
// enseignant, salle ou filière, en vue jour, semaine ou semestre.
// L'étudiant voit son groupe et l'enseignant son propre planning : c'est leur
// page d'accueil. L'enseignant peut signaler un problème sur une de ses séances.

type Cible = 'groupe' | 'enseignant' | 'salle' | 'filiere';
type Vue = 'jour' | 'semaine' | 'semestre';

const CIBLES: { id: Cible; label: string }[] = [
  { id: 'groupe', label: 'Groupe' },
  { id: 'enseignant', label: 'Enseignant' },
  { id: 'salle', label: 'Salle' },
  { id: 'filiere', label: 'Filière' },
];

const MOTIFS = ['Salle inadaptée', 'Conflit avec une autre obligation', 'Erreur de cours ou de groupe', 'Matériel manquant', 'Autre'];

function choixPossibles(db: Db, user: Utilisateur, cible: Cible) {
  const dep = departementScope(user);
  const filieres = db.filieres.filter((f) => !f.archived && (!dep || f.departementId === dep));
  switch (cible) {
    case 'groupe':
      return db.groupes.filter((g) => !g.archived && filieres.some((f) => f.id === g.filiereId)).map((g) => ({ id: g.id, label: g.code }));
    case 'enseignant':
      return db.enseignants.filter((e) => !e.archived && (!dep || e.departementId === dep)).map((e) => ({ id: e.id, label: `${e.nom.toUpperCase()} ${e.prenom}` }));
    case 'salle':
      return db.salles.filter((s) => !s.archived).map((s) => ({ id: s.id, label: `${s.code} — ${s.nom}` }));
    case 'filiere':
      return filieres.map((f) => ({ id: f.id, label: `${f.code} — ${f.libelle}` }));
  }
}

function filtre(db: Db, cible: Cible, id: number): (s: Seance) => boolean {
  switch (cible) {
    case 'groupe': {
      const lies = groupesLies(db, id);
      return (s) => lies.includes(s.groupeId);
    }
    case 'enseignant':
      return (s) => s.enseignantId === id;
    case 'salle':
      return (s) => s.salleId === id;
    case 'filiere': {
      const groupes = db.groupes.filter((g) => g.filiereId === id).map((g) => g.id);
      return (s) => groupes.includes(s.groupeId);
    }
  }
}

export default function ConsultationPage() {
  const user = useCurrentUser();
  const { db } = useData();
  const [params, setParams] = useSearchParams();
  const index = indexer(db);
  const semestre = semestreActif(db);
  const [ouverte, setOuverte] = useState<Occurrence | null>(null);

  // Étudiant et enseignant : leur propre emploi du temps, sans choix possible
  const verrou: { cible: Cible; id: number } | null =
    user.role === 'etudiant' && user.groupeId
      ? { cible: 'groupe', id: user.groupeId }
      : user.role === 'enseignant' && user.enseignantId
        ? { cible: 'enseignant', id: user.enseignantId }
        : null;
  const peutVoirTravail = user.role === 'planificateur' || user.role === 'administrateur' || user.role === 'chef_departement';

  const cible = verrou?.cible ?? ((params.get('cible') as Cible) || (user.enseignantId ? 'enseignant' : 'groupe'));
  const choix = choixPossibles(db, user, cible);
  const demande = Number(params.get('id'));
  const id = verrou?.id ?? (choix.find((c) => c.id === demande) ?? choix.find((c) => cible === 'enseignant' && c.id === user.enseignantId) ?? choix[0])?.id ?? 0;
  const vue = (params.get('vue') as Vue) || 'semaine';
  const source = peutVoirTravail && params.get('source') === 'travail' ? 'travail' : 'publiee';

  if (!semestre) return <EmptyState>Aucun semestre actif.</EmptyState>;

  const version = versionPubliee(db, semestre.id);
  const seances = (source === 'travail' ? db.seances : (version?.seances ?? [])).filter(filtre(db, cible, id));
  const occ = occurrences(db, seances, semestre);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const parDefaut = aujourdhui >= semestre.debut && aujourdhui <= semestre.fin ? aujourdhui : semestre.debut;
  const date = params.get('date') || parDefaut;
  const lundi = lundiDe(date);

  const maj = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) next.set(k, v);
    setParams(next, { replace: true });
  };
  const decaler = (jours: number) => maj({ date: ajouterJours(date, jours) });

  const libelleCible = verrou ? (cible === 'groupe' ? index.groupes.get(id)?.code : nomEnseignant(db, id)) : choix.find((c) => c.id === id)?.label;
  const code = (cible === 'groupe' ? index.groupes.get(id)?.code : cible === 'salle' ? index.salles.get(id)?.code : cible === 'filiere' ? db.filieres.find((f) => f.id === id)?.code : db.enseignants.find((e) => e.id === id)?.matricule) ?? 'edt';
  const suffixe = libelleSemestre(db, semestre).replace(/\s+/g, '-');

  return (
    <>
      <PageHeader
        title={verrou ? 'Mon emploi du temps' : 'Emplois du temps'}
        description={`${libelleCible ?? ''} · ${libelleSemestre(db, semestre)} · ${
          source === 'travail' ? 'version de travail (non publiée)' : version ? `version ${version.numero} publiée le ${formatDateTime(version.date)}` : 'aucune version publiée'
        }`}
        refs="BF-21, BNF-11"
      />

      <div className="toolbar no-print">
        {!verrou && (
          <>
            <select className="input" aria-label="Afficher par" value={cible} onChange={(e) => maj({ cible: e.target.value, id: '' })}>
              {CIBLES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select className="input" aria-label={`Choisir : ${cible}`} value={id} onChange={(e) => maj({ id: e.target.value })}>
              {choix.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        )}
        {peutVoirTravail && (
          <select className="input" aria-label="Version" value={source} onChange={(e) => maj({ source: e.target.value })}>
            <option value="publiee">Version publiée</option>
            <option value="travail">Version de travail</option>
          </select>
        )}
        <div className="segmented" role="group" aria-label="Vue">
          {(['jour', 'semaine', 'semestre'] as Vue[]).map((v) => (
            <button key={v} className={`btn btn-small ${vue === v ? 'btn-primary' : ''}`} aria-pressed={vue === v} onClick={() => maj({ vue: v })}>
              {v === 'jour' ? 'Jour' : v === 'semaine' ? 'Semaine' : 'Semestre'}
            </button>
          ))}
        </div>
      </div>

      {source === 'publiee' && !version ? (
        <EmptyState>L’emploi du temps de ce semestre n’est pas encore publié.</EmptyState>
      ) : (
        <>
          {vue !== 'semestre' && (
            <div className="toolbar period-nav no-print">
              <button className="btn btn-small" onClick={() => decaler(vue === 'jour' ? -1 : -7)} aria-label="Période précédente">
                ←
              </button>
              <input type="date" className="input" aria-label="Date" value={date} min={semestre.debut} max={semestre.fin} onChange={(e) => e.target.value && maj({ date: e.target.value })} />
              <button className="btn btn-small" onClick={() => decaler(vue === 'jour' ? 1 : 7)} aria-label="Période suivante">
                →
              </button>
              <strong>{vue === 'jour' ? formatJourCourt(date) : `Semaine du ${formatDateCourte(lundi)}`}</strong>
            </div>
          )}

          {vue === 'jour' && <VueJour occ={occ.filter((o) => o.date === date)} index={index} onOuvrir={setOuverte} />}
          {vue === 'semaine' && <VueSemaine db={db} occ={occ} lundi={lundi} index={index} cible={cible} onOuvrir={setOuverte} />}
          {vue === 'semestre' && <VueSemestre db={db} occ={occ} onSemaine={(l) => maj({ vue: 'semaine', date: l })} />}

          <ExportsPanel
            titre={`EDT ${libelleCible ?? ''} — ${libelleSemestre(db, semestre)}`}
            fichier={`edt-${code}-${suffixe}`}
            abonnement={`https://planning.2ie-edu.org/ical/${cible}/${encodeURIComponent(code)}.ics?jeton=${user.login}-${id.toString(16)}`}
            occurrences={occ}
            index={index}
          />
        </>
      )}

      {user.role === 'enseignant' && <MesSignalements user={user} />}

      {ouverte && <DetailOccurrence occurrence={ouverte} index={index} onFermer={() => setOuverte(null)} />}
    </>
  );
}

function ligneOccurrence(o: Occurrence, index: Index) {
  const s = o.seance;
  const salle = index.salles.get(s.salleId);
  return `${salle?.code} · ${index.groupes.get(s.groupeId)?.code}`;
}

function VueJour({ occ, index, onOuvrir }: { occ: Occurrence[]; index: Index; onOuvrir: (o: Occurrence) => void }) {
  if (occ.length === 0) return <EmptyState>Aucune séance ce jour-là.</EmptyState>;
  return (
    <section className="card">
      <ul className="session-list">
        {occ.map((o) => (
          <li key={`${o.seance.id}-${o.date}`} className="session">
            <span className="session-time">
              {o.debut} – {o.fin}
            </span>
            <button className="session-btn" onClick={() => onOuvrir(o)}>
              <span className="badge">{index.types.get(o.seance.typeSeanceId)?.code}</span> <strong>{index.cours.get(o.seance.coursId)?.intitule}</strong>
              <br />
              <span className="muted small">
                {ligneOccurrence(o, index)} · {(() => {
                  const e = index.enseignants.get(o.seance.enseignantId);
                  return e ? `${e.prenom} ${e.nom}` : '';
                })()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VueSemaine({
  db,
  occ,
  lundi,
  index,
  cible,
  onOuvrir,
}: {
  db: Db;
  occ: Occurrence[];
  lundi: string;
  index: Index;
  cible: Cible;
  onOuvrir: (o: Occurrence) => void;
}) {
  const fin = ajouterJours(lundi, 6);
  const semaine = occ.filter((o) => o.date >= lundi && o.date <= fin);
  const montrer: ('groupe' | 'salle' | 'enseignant')[] = cible === 'groupe' ? ['salle', 'enseignant'] : cible === 'enseignant' ? ['groupe', 'salle'] : ['groupe', 'enseignant'];
  return (
    <>
      <div className="desktop-only">
        <WeekGrid
          db={db}
          lundi={lundi}
          label="Emploi du temps de la semaine"
          renderCell={(c) => (
            <div className="cell-stack">
              {semaine
                .filter((o) => o.seance.creneauId === c.id && o.date === dateDuJour(lundi, c.jour))
                .map((o) => (
                  <SeanceCard key={o.seance.id} seance={o.seance} index={index} montrer={montrer} className="clickable">
                    <button className="link-btn" onClick={() => onOuvrir(o)} aria-label={`Détail de ${decrireSeance(db, o.seance)}`}>
                      Détail
                    </button>
                  </SeanceCard>
                ))}
            </div>
          )}
        />
      </div>
      <div className="mobile-only">
        {semaine.length === 0 ? (
          <EmptyState>Aucune séance cette semaine.</EmptyState>
        ) : (
          joursOuvres(db).map((jour) => {
            const date = dateDuJour(lundi, jour);
            const duJour = semaine.filter((o) => o.date === date);
            if (duJour.length === 0) return null;
            return (
              <section key={jour} className="card day-card">
                <h2>{formatJourCourt(date)}</h2>
                <VueJourListe occ={duJour} index={index} onOuvrir={onOuvrir} />
              </section>
            );
          })
        )}
      </div>
      {semaine.length === 0 && <p className="muted small desktop-only">Aucune séance cette semaine (vacances, examens ou volume atteint).</p>}
    </>
  );
}

function VueJourListe({ occ, index, onOuvrir }: { occ: Occurrence[]; index: Index; onOuvrir: (o: Occurrence) => void }) {
  return (
    <ul className="session-list">
      {occ.map((o) => (
        <li key={o.seance.id} className="session">
          <span className="session-time">{o.debut}</span>
          <button className="session-btn" onClick={() => onOuvrir(o)}>
            <span className="badge">{index.types.get(o.seance.typeSeanceId)?.code}</span> <strong>{index.cours.get(o.seance.coursId)?.code}</strong>{' '}
            {index.cours.get(o.seance.coursId)?.intitule}
            <br />
            <span className="muted small">{ligneOccurrence(o, index)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function VueSemestre({ db, occ, onSemaine }: { db: Db; occ: Occurrence[]; onSemaine: (lundi: string) => void }) {
  const semestre = semestreActif(db)!;
  const jours = joursOuvres(db);
  const cours = new Set(semainesDeCours(db, semestre));
  const heures = (o: Occurrence) => (Number(o.fin.slice(0, 2)) * 60 + Number(o.fin.slice(3)) - Number(o.debut.slice(0, 2)) * 60 - Number(o.debut.slice(3))) / 60;
  return (
    <div className="table-wrap">
      <table className="table grid-table semestre-table" aria-label="Vue semestre : nombre de séances par jour">
        <thead>
          <tr>
            <th>Semaine</th>
            {jours.map((j) => (
              <th key={j}>{j.slice(0, 3)}</th>
            ))}
            <th className="num">Heures</th>
          </tr>
        </thead>
        <tbody>
          {semainesDuSemestre(semestre).map((lundi, i) => {
            const semaine = occ.filter((o) => lundiDe(o.date) === lundi);
            return (
              <tr key={lundi} className={cours.has(lundi) ? undefined : 'archived'}>
                <th scope="row">
                  <button className="link-btn" onClick={() => onSemaine(lundi)}>
                    S{i + 1} · {formatDateCourte(lundi)}
                  </button>
                </th>
                {jours.map((j) => {
                  const n = semaine.filter((o) => o.date === dateDuJour(lundi, j)).length;
                  return (
                    <td key={j} className={n ? `heat heat-${Math.min(n, 4)}` : ''}>
                      {cours.has(lundi) ? n || '' : j === jours[0] ? 'sans cours' : ''}
                    </td>
                  );
                })}
                <td className="num">{semaine.reduce((t, o) => t + heures(o), 0)} h</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetailOccurrence({ occurrence, index, onFermer }: { occurrence: Occurrence; index: Index; onFermer: () => void }) {
  const user = useCurrentUser();
  const { db } = useData();
  const s = occurrence.seance;
  const salle = index.salles.get(s.salleId);
  const cours = index.cours.get(s.coursId);
  const peutSignaler = user.enseignantId !== undefined && user.enseignantId === s.enseignantId;
  const [signaler, setSignaler] = useState(false);

  return (
    <Modal title={`${cours?.code} ${index.types.get(s.typeSeanceId)?.code} — ${cours?.intitule}`} onClose={onFermer}>
      {signaler ? (
        <SignalementForm seance={s} onFin={onFermer} onAnnuler={() => setSignaler(false)} />
      ) : (
        <>
          <dl className="details">
            <dt>Date</dt>
            <dd>
              {formatJourCourt(occurrence.date)} · {occurrence.debut} – {occurrence.fin}
            </dd>
            <dt>Groupe</dt>
            <dd>{index.groupes.get(s.groupeId)?.code}</dd>
            <dt>Salle</dt>
            <dd>
              {salle?.code} — {salle?.nom} ({index.batiments.get(salle?.batimentId ?? 0)?.nom}, étage {salle?.etage})
            </dd>
            <dt>Enseignant</dt>
            <dd>{nomEnseignant(db, s.enseignantId)}</dd>
          </dl>
          <div className="form-actions">
            {peutSignaler && (
              <button className="btn push-left" onClick={() => setSignaler(true)}>
                Signaler un problème
              </button>
            )}
            <button className="btn btn-primary" onClick={onFermer}>
              Fermer
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function SignalementForm({ seance, onFin, onAnnuler }: { seance: Seance; onFin: () => void; onAnnuler: () => void }) {
  const user = useCurrentUser();
  const { db, save, insertMany } = useData();
  const [motif, setMotif] = useState(MOTIFS[0]);
  const [texte, setTexte] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoye, setEnvoye] = useState(false);

  function envoyer(e: FormEvent) {
    e.preventDefault();
    if (texte.trim().length < 10) {
      setErreur('Décrivez le problème en quelques mots (10 caractères au moins).');
      return;
    }
    save('signalements', { id: 0, seanceId: seance.id, utilisateurId: user.id, date: new Date().toISOString(), motif, texte: texte.trim(), statut: 'ouvert' });
    const scolarite = db.utilisateurs.filter((u) => u.role === 'planificateur' && !u.archived);
    const modele = gabarit(db, 'signalement');
    insertMany('notifications', [
      ...scolarite.map((u) => notification(u.id, `Signalement : ${motif}`, `${user.nom} — ${decrireSeance(db, seance)} : ${texte.trim()}`)),
      notification(user.id, 'Signalement envoyé', modele ? remplir(modele.sujet, { seance: decrireSeance(db, seance) }) : decrireSeance(db, seance)),
    ]);
    setEnvoye(true);
  }

  if (envoye) {
    return (
      <>
        <p className="notice notice-success" role="status">
          Signalement transmis à la scolarité. Vous serez prévenu(e) quand il sera traité.
        </p>
        <div className="form-actions">
          <button className="btn btn-primary" onClick={onFin}>
            Fermer
          </button>
        </div>
      </>
    );
  }

  return (
    <form className="form" onSubmit={envoyer}>
      <p className="muted small">{decrireSeance(db, seance)}</p>
      <div className="field">
        <label htmlFor="sig-motif">Motif</label>
        <select id="sig-motif" className="input" value={motif} onChange={(e) => setMotif(e.target.value)}>
          {MOTIFS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="sig-texte">Description</label>
        <textarea id="sig-texte" className="input" rows={4} value={texte} onChange={(e) => setTexte(e.target.value)} />
      </div>
      {erreur && (
        <p className="error" role="alert">
          {erreur}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onAnnuler}>
          Retour
        </button>
        <button type="submit" className="btn btn-primary">
          Envoyer le signalement
        </button>
      </div>
    </form>
  );
}

function MesSignalements({ user }: { user: Utilisateur }) {
  const { db } = useData();
  const liste = db.signalements.filter((s) => s.utilisateurId === user.id).sort((a, b) => b.date.localeCompare(a.date));
  if (liste.length === 0) return null;
  return (
    <section className="card no-print">
      <h2>Mes signalements</h2>
      <ul className="notif-list">
        {liste.map((sg) => {
          const s = db.seances.find((x) => x.id === sg.seanceId);
          return (
            <li key={sg.id} className="notif">
              <div>
                <strong>{sg.motif}</strong>
                <p>{sg.texte}</p>
                <span className="muted small">
                  {s ? decrireSeance(db, s) : 'Séance supprimée'} · {formatDateTime(sg.date)}
                </span>
              </div>
              <span className={`badge ${sg.statut === 'traite' ? 'badge-ok' : 'badge-warn'}`}>{sg.statut === 'traite' ? 'Traité' : 'En cours'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
