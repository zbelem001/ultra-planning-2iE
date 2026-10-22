import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useData } from '../store/DataContext';
import { ROLE_LABELS } from '../types';

// Page 1 — Connexion SSO (BNF-06).
// Aucun mot de passe n'est saisi ici : en production, le bouton redirige vers
// le CAS de l'université. En démonstration, l'écran CAS est simulé par le
// choix d'un compte de test.

export default function LoginPage() {
  const { user, login } = useAuth();
  const { db } = useData();
  const navigate = useNavigate();
  const location = useLocation();
  const [casOpen, setCasOpen] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={from} replace />;

  function connect(id: number) {
    login(id);
    navigate(from, { replace: true });
  }

  return (
    <div className="login">
      <div className="login-card card">
        <p className="brand brand-large">
          Ultra Planning <span>2iE</span>
        </p>
        <h1>Planification des cours</h1>
        <p className="muted">
          Connectez-vous avec votre compte de l’université. Aucun nouveau mot de passe n’est nécessaire.
        </p>

        {!casOpen ? (
          <button className="btn btn-primary btn-block" onClick={() => setCasOpen(true)}>
            Se connecter avec le compte 2iE (CAS)
          </button>
        ) : (
          <div className="cas-mock">
            <p className="notice">
              Mode démonstration : le serveur CAS est simulé. Choisissez un profil de test.
            </p>
            <ul className="account-list">
              {db.utilisateurs.map((u) => (
                <li key={u.id}>
                  <button className="account" onClick={() => connect(u.id)}>
                    <strong>{u.nom}</strong>
                    <span className="muted small">
                      {ROLE_LABELS[u.role]} · {u.login}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn btn-ghost" onClick={() => setCasOpen(false)}>
              Retour
            </button>
          </div>
        )}
        <p className="muted small">Connexion sécurisée (HTTPS) · Service informatique 2iE</p>
      </div>
    </div>
  );
}
