import { Navigate, Route, Routes } from 'react-router-dom';
import { DISPO_ROLES, REFERENTIEL_READ, REFERENTIEL_WRITE } from './auth/AuthContext';
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

// Les 14 premières pages de la cartographie (lots L1 et début de L2).

const ref = (el: JSX.Element) => <RequireRole roles={REFERENTIEL_READ}>{el}</RequireRole>;

export default function App() {
  return (
    <Routes>
      {/* 1 — Connexion SSO */}
      <Route path="/connexion" element={<LoginPage />} />
      {/* 4 — Maintenance (affichée hors session) */}
      <Route path="/maintenance" element={<ErrorPage code={503} />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          {/* 2 — Accueil */}
          <Route index element={<DashboardPage />} />
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

          {/* 4 — Pages d'erreur */}
          <Route path="acces-refuse" element={<ErrorPage code={403} />} />
          <Route path="*" element={<ErrorPage code={404} />} />
        </Route>
      </Route>
    </Routes>
  );
}
