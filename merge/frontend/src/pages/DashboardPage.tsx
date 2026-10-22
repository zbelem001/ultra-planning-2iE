import { Link } from 'react-router-dom';
import { useCurrentUser } from '../auth/AuthContext';
import { campagne } from '../mocks/data';
import { byId, useData } from '../store/DataContext';
import {
  alertesReferentiel,
  formatDate,
  joursRestants,
  jourDuJour,
  retardatairesDisponibilites,
  seancesDuJour,
} from '../lib/helpers';
import { EmptyState, PageHeader, StatCard } from '../components/ui';
import { ROLE_LABELS, type Db, type Utilisateur } from '../types';

// Page 2 — Tableau d'accueil, différent selon le rôle.

export default function DashboardPage() {
  const user = useCurrentUser();
  const { db } = useData();
  // Les comptes de service (scolarité, admin) n'ont pas de prénom
  const salutation = user.role === 'planificateur' || user.role === 'administrateur' ? user.nom : user.nom.split(' ')[0];

  return (
    <>
      <PageHeader title={`Bonjour, ${salutation}`} description={`${ROLE_LABELS[user.role]} · ${campagne.semestre}`} />
      {(user.role === 'enseignant' || user.role === 'etudiant' || user.enseignantId) && (
        <TodaySessions db={db} user={user} />
      )}
      {user.role === 'enseignant' && <TeacherPanel db={db} user={user} />}
      {(user.role === 'planificateur' || user.role === 'administrateur') && <PlannerPanel db={db} />}
      {user.role === 'chef_departement' && <HeadPanel db={db} user={user} />}
    </>
  );
}

function TodaySessions({ db, user }: { db: Db; user: Utilisateur }) {
  const jour = jourDuJour();
  const seances = seancesDuJour(db, user, jour);
  const cours = byId(db.cours);
  const salles = byId(db.salles);
  const creneaux = byId(db.creneaux);
  const types = byId(db.typesSeance);
  const groupes = byId(db.groupes);

  return (
    <section className="card">
      <h2>Mes séances du jour {jour && <span className="muted">({jour})</span>}</h2>
      {seances.length === 0 ? (
        <EmptyState>Aucune séance aujourd’hui.</EmptyState>
      ) : (
        <ul className="session-list">
          {seances.map((s) => {
            const c = creneaux.get(s.creneauId);
            return (
              <li key={s.id} className="session">
                <span className="session-time">
                  {c?.debut} – {c?.fin}
                </span>
                <span>
                  <span className="badge">{types.get(s.typeSeanceId)?.code}</span>{' '}
                  <strong>{cours.get(s.coursId)?.intitule}</strong>
                  <br />
                  <span className="muted small">
                    {salles.get(s.salleId)?.nom} · {groupes.get(s.groupeId)?.code}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small">Données de la semaine type, en attendant l’emploi du temps publié.</p>
    </section>
  );
}

function TeacherPanel({ db, user }: { db: Db; user: Utilisateur }) {
  const dispos = db.disponibilites.filter((d) => d.enseignantId === user.enseignantId);
  const restants = joursRestants(campagne.dateLimite);
  const habilitations = db.habilitations.filter((h) => h.enseignantId === user.enseignantId).length;

  return (
    <div className="grid-3">
      <StatCard
        label="Saisie des disponibilités"
        value={dispos.length > 0 ? 'Commencée' : 'À faire'}
        hint={`Date limite : ${formatDate(campagne.dateLimite)}${restants >= 0 ? ` (J-${restants})` : ' (dépassée)'}`}
      />
      <StatCard label="Créneaux renseignés" value={dispos.length} hint="Les autres sont considérés disponibles" />
      <StatCard label="Cours habilités" value={habilitations} />
      <div className="card span-3 cta">
        <p>Déclarez vos préférences et indisponibilités pour le prochain semestre.</p>
        <Link className="btn btn-primary" to="/disponibilites">
          Saisir mes disponibilités
        </Link>
      </div>
    </div>
  );
}

function PlannerPanel({ db }: { db: Db }) {
  const retard = retardatairesDisponibilites(db);
  const actifs = db.enseignants.filter((e) => !e.archived).length;
  const alertes = alertesReferentiel(db);

  return (
    <>
      <div className="grid-4">
        <StatCard label="Cours actifs" value={db.cours.filter((c) => !c.archived).length} />
        <StatCard label="Groupes" value={db.groupes.filter((g) => !g.archived).length} />
        <StatCard label="Salles" value={db.salles.filter((s) => !s.archived).length} />
        <StatCard
          label="Disponibilités saisies"
          value={`${actifs - retard.length} / ${actifs}`}
          hint={`${retard.length} enseignant(s) en retard`}
        />
      </div>
      <AlertList alertes={alertes} />
      <section className="card">
        <h2>Raccourcis</h2>
        <div className="shortcuts">
          <Link className="btn" to="/referentiel/import">Importer un fichier CSV</Link>
          <Link className="btn" to="/referentiel/cours">Cours et volumes</Link>
          <Link className="btn" to="/referentiel/salles">Salles</Link>
          <Link className="btn" to="/disponibilites">Disponibilités des enseignants</Link>
        </div>
      </section>
    </>
  );
}

function HeadPanel({ db, user }: { db: Db; user: Utilisateur }) {
  const dep = db.departements.find((d) => d.id === user.departementId);
  const cours = db.cours.filter((c) => !c.archived && c.departementId === user.departementId);
  const enseignants = db.enseignants.filter((e) => !e.archived && e.departementId === user.departementId);

  return (
    <>
      <div className="grid-3">
        <StatCard label="Département" value={dep?.code ?? '—'} hint={dep?.libelle} />
        <StatCard label="Cours du département" value={cours.length} />
        <StatCard label="Enseignants" value={enseignants.length} />
      </div>
      <AlertList alertes={alertesReferentiel(db, user.departementId)} />
    </>
  );
}

function AlertList({ alertes }: { alertes: ReturnType<typeof alertesReferentiel> }) {
  return (
    <section className="card">
      <h2>Points à corriger avant la planification</h2>
      {alertes.length === 0 ? (
        <EmptyState>Le référentiel est cohérent.</EmptyState>
      ) : (
        <ul className="alert-list">
          {alertes.map((a, i) => (
            <li key={i} className={`alert alert-${a.niveau}`}>
              <span>{a.texte}</span>
              <Link to={a.lien}>Corriger</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
