import { Navigate, Route, Routes } from 'react-router-dom';
import { DISPO_ROLES, REFERENTIEL_READ, REFERENTIEL_WRITE, useCurrentUser } from './auth/AuthContext';
import { ACCUEIL_EDT, CONSULTATION_ROLES, PLANIFICATION_ROLES, TABLEAUX_ROLES, VALIDATION_ROLES } from './auth/droits';
import Layout from './components/Layout';
import { RequireAuth, RequireRole } from './components/guards';
import DashboardPage from './pages/DashboardPage';
import ErrorPage from './pages/ErrorPage';
import LoginPage from './pages/LoginPage';
import ProfilePage from './pages/ProfilePage';
import DisponibilitesPage from './pages/enseignants/DisponibilitesPage';
import EnseignantsPage, { EnseignantDetailPage } from './pages/enseignants/EnseignantsPage';
import CoursPage, { CoursDetailPage } from './pages/referentiel/CoursPage';
import CreneauxPage from './pages/referentiel/CreneauxPage';
import DepartementsPage from './pages/referentiel/DepartementsPage';
import FilieresPage, { FiliereDetailPage } from './pages/referentiel/FilieresPage';
import GroupesPage from './pages/referentiel/GroupesPage';
import ImportPage from './pages/referentiel/ImportPage';
import SallesPage from './pages/referentiel/SallesPage';
import TypesPage from './pages/referentiel/TypesPage';
import AnneesPage from './pages/admin/AnneesPage';
import AuditPage from './pages/admin/AuditPage';
import ParametresPage from './pages/admin/ParametresPage';
import UtilisateursPage from './pages/admin/UtilisateursPage';
import ConsultationPage from './pages/consultation/ConsultationPage';
import CampagnePage from './pages/enseignants/CampagnePage';
import LancerGenerationPage from './pages/generation/LancerGenerationPage';
import SuiviGenerationPage from './pages/generation/SuiviGenerationPage';
import TableauxDeBordPage from './pages/pilotage/TableauxDeBordPage';
import DuplicationPage from './pages/planification/DuplicationPage';
import GrillePage from './pages/planification/GrillePage';
import PublicationPage from './pages/planification/PublicationPage';
import ValidationPage from './pages/planification/ValidationPage';
import { AuditWatcher } from './store/journal';

// Les 28 pages de la cartographie : 1 à 14 (lots L1 et début de L2), 15 à 28 (L2 à L4).

const ref = (el: JSX.Element) => <RequireRole roles={REFERENTIEL_READ}>{el}</RequireRole>;
const planif = (el: JSX.Element) => <RequireRole roles={PLANIFICATION_ROLES}>{el}</RequireRole>;

/** L'étudiant et l'enseignant arrivent directement sur leur emploi du temps (page 22). */
function Accueil() {
  const user = useCurrentUser();
  return ACCUEIL_EDT.includes(user.role) ? <Navigate to="/emploi-du-temps" replace /> : <DashboardPage />;
}

export default function App() {
  return (
    <Routes>
      {/* 1 — Connexion SSO */}
      <Route path="/connexion" element={<LoginPage />} />
      {/* 4 — Maintenance (affichée hors session) */}
      <Route path="/maintenance" element={<ErrorPage code={503} />} />

      <Route element={<RequireAuth />}>
        <Route
          element={
            <>
              <AuditWatcher />
              <Layout />
            </>
          }
        >
          {/* 2 — Accueil (page 22 pour l'étudiant et l'enseignant, qui gardent le résumé du jour) */}
          <Route index element={<Accueil />} />
          <Route path="accueil" element={<DashboardPage />} />
          {/* 3 — Profil et notifications */}
          <Route path="profil" element={<ProfilePage />} />

          <Route path="referentiel">
            <Route index element={<Navigate to="departements" replace />} />
            {/* 5 à 11 — Référentiel */}
            <Route path="departements" element={ref(<DepartementsPage />)} />
            <Route path="filieres" element={ref(<FilieresPage />)} />
            <Route path="filieres/:id" element={ref(<FiliereDetailPage />)} />
            <Route path="groupes" element={ref(<GroupesPage />)} />
            <Route path="cours" element={ref(<CoursPage />)} />
            <Route path="cours/:id" element={ref(<CoursDetailPage />)} />
            <Route path="salles" element={ref(<SallesPage />)} />
            <Route path="types" element={ref(<TypesPage />)} />
            <Route path="creneaux" element={ref(<CreneauxPage />)} />
            {/* 12 — Import CSV */}
            <Route
              path="import"
              element={
                <RequireRole roles={REFERENTIEL_WRITE}>
                  <ImportPage />
                </RequireRole>
              }
            />
          </Route>

          {/* 13 — Enseignants et habilitations */}
          <Route path="enseignants" element={ref(<EnseignantsPage />)} />
          <Route path="enseignants/:id" element={ref(<EnseignantDetailPage />)} />
          {/* 14 — Disponibilités */}
          <Route
            path="disponibilites"
            element={
              <RequireRole roles={DISPO_ROLES}>
                <DisponibilitesPage />
              </RequireRole>
            }
          />

          {/* 15 — Campagne de saisie */}
          <Route path="campagne" element={planif(<CampagnePage />)} />

          {/* 16, 17 — Planification manuelle */}
          <Route path="planification" element={planif(<GrillePage />)} />
          <Route path="planification/duplication" element={planif(<DuplicationPage />)} />
          {/* 18, 19 — Génération automatique */}
          <Route path="generation" element={planif(<LancerGenerationPage />)} />
          <Route path="generation/:id" element={planif(<SuiviGenerationPage />)} />
          {/* 20 — Validation du département */}
          <Route
            path="validation"
            element={
              <RequireRole roles={VALIDATION_ROLES}>
                <ValidationPage />
              </RequireRole>
            }
          />
          {/* 21 — Publication et versions */}
          <Route path="publication" element={planif(<PublicationPage />)} />

          {/* 22, 23 — Consultation et exports */}
          <Route
            path="emploi-du-temps"
            element={
              <RequireRole roles={CONSULTATION_ROLES}>
                <ConsultationPage />
              </RequireRole>
            }
          />
          {/* 24 — Tableaux de bord */}
          <Route
            path="tableaux-de-bord"
            element={
              <RequireRole roles={TABLEAUX_ROLES}>
                <TableauxDeBordPage />
              </RequireRole>
            }
          />

          {/* 25 à 28 — Administration */}
          <Route path="admin">
            <Route index element={<Navigate to="utilisateurs" replace />} />
            <Route path="utilisateurs" element={planif(<UtilisateursPage />)} />
            <Route path="audit" element={planif(<AuditPage />)} />
            <Route path="annees" element={planif(<AnneesPage />)} />
            <Route path="parametres" element={planif(<ParametresPage />)} />
          </Route>

          {/* 4 — Pages d'erreur */}
          <Route path="acces-refuse" element={<ErrorPage code={403} />} />
          <Route path="*" element={<ErrorPage code={404} />} />
        </Route>
      </Route>
    </Routes>
  );
}
