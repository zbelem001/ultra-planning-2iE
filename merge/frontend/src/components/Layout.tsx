import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { DISPO_ROLES, REFERENTIEL_READ, useAuth, useCurrentUser } from '../auth/AuthContext';
import { ACCUEIL_EDT, PLANIFICATION_ROLES, TABLEAUX_ROLES, VALIDATION_ROLES } from '../auth/droits';
import { useData } from '../store/DataContext';
import { ROLE_LABELS, type Role } from '../types';

interface NavItem {
  to: string;
  label: string;
  roles?: Role[];
}

interface NavSection {
  title: string;
  items: NavItem[];
}

// Menu filtré selon le rôle : un étudiant ne voit que son emploi du temps, l'accueil et son profil.
const NAV: NavSection[] = [
  {
    title: 'Général',
    items: [
      { to: '/', label: 'Accueil', roles: ['administrateur', 'planificateur', 'chef_departement'] },
      { to: '/emploi-du-temps', label: 'Mon emploi du temps', roles: ACCUEIL_EDT },
      { to: '/accueil', label: 'Résumé du jour', roles: ACCUEIL_EDT },
      { to: '/profil', label: 'Profil et notifications' },
    ],
  },
  {
    title: 'Référentiel',
    items: [
      { to: '/referentiel/departements', label: 'Départements', roles: REFERENTIEL_READ },
      { to: '/referentiel/filieres', label: 'Filières et programmes', roles: REFERENTIEL_READ },
      { to: '/referentiel/groupes', label: 'Groupes', roles: REFERENTIEL_READ },
      { to: '/referentiel/cours', label: 'Cours et volumes', roles: REFERENTIEL_READ },
      { to: '/referentiel/salles', label: 'Bâtiments et salles', roles: REFERENTIEL_READ },
      { to: '/referentiel/types', label: 'Types de salle et de séance', roles: REFERENTIEL_READ },
      { to: '/referentiel/creneaux', label: 'Grille des créneaux', roles: REFERENTIEL_READ },
      { to: '/referentiel/import', label: 'Import CSV', roles: ['administrateur', 'planificateur'] },
    ],
  },
  {
    title: 'Enseignants',
    items: [
      { to: '/enseignants', label: 'Enseignants et habilitations', roles: REFERENTIEL_READ },
      { to: '/disponibilites', label: 'Disponibilités', roles: DISPO_ROLES },
      { to: '/campagne', label: 'Campagne de saisie', roles: PLANIFICATION_ROLES },
    ],
  },
  {
    title: 'Planification',
    items: [
      { to: '/planification', label: 'Grille de planification', roles: PLANIFICATION_ROLES },
      { to: '/planification/duplication', label: 'Duplication sur le semestre', roles: PLANIFICATION_ROLES },
      { to: '/generation', label: 'Génération automatique', roles: PLANIFICATION_ROLES },
      { to: '/validation', label: 'Validation du département', roles: VALIDATION_ROLES },
      { to: '/publication', label: 'Publication et versions', roles: PLANIFICATION_ROLES },
    ],
  },
  {
    title: 'Consultation',
    items: [
      { to: '/emploi-du-temps', label: 'Emplois du temps', roles: ['administrateur', 'planificateur', 'chef_departement'] },
      { to: '/tableaux-de-bord', label: 'Tableaux de bord', roles: TABLEAUX_ROLES },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/admin/utilisateurs', label: 'Comptes et rôles', roles: PLANIFICATION_ROLES },
      { to: '/admin/audit', label: 'Journal d’audit', roles: PLANIFICATION_ROLES },
      { to: '/admin/annees', label: 'Années et semestres', roles: PLANIFICATION_ROLES },
      { to: '/admin/parametres', label: 'Paramètres', roles: PLANIFICATION_ROLES },
    ],
  },
];

export default function Layout() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const { db } = useData();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Sans redirection explicite, RequireAuth retiendrait la page courante comme
  // « page d'origine » : le compte suivant y serait renvoyé, même sans droit d'accès.
  function deconnecter() {
    logout();
    navigate('/connexion', { replace: true });
  }
  const unread = db.notifications.filter((n) => n.utilisateurId === user.id && !n.lue).length;

  return (
    <div className="shell">
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className="topbar">
        <button
          className="btn btn-ghost menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="menu-principal"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Menu
        </button>
        <NavLink to="/" className="brand">
          Ultra Planning <span>2iE</span>
        </NavLink>
        <div className="topbar-user">
          <NavLink to="/profil" className="notif-link" aria-label={`${unread} notification(s) non lue(s)`}>
            Notifications {unread > 0 && <span className="badge badge-accent">{unread}</span>}
          </NavLink>
          <span className="user-chip" title={user.email}>
            <strong>{user.nom}</strong>
            <small>{ROLE_LABELS[user.role]}</small>
          </span>
          <button className="btn btn-ghost" onClick={deconnecter}>
            Déconnexion
          </button>
        </div>
      </header>
      <div className="body">
        <nav
          id="menu-principal"
          className={`sidebar ${menuOpen ? 'open' : ''}`}
          aria-label="Menu principal"
          onClick={() => setMenuOpen(false)}
        >
          {NAV.map((section) => {
            const items = section.items.filter((i) => !i.roles || i.roles.includes(user.role));
            if (items.length === 0) return null;
            return (
              <div key={section.title} className="nav-section">
                <p className="nav-title">{section.title}</p>
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'} className="nav-link">
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <main id="contenu" className="content" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
