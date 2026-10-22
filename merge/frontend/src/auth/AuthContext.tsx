import { createContext, useContext, useState, type ReactNode } from 'react';
import { useData } from '../store/DataContext';
import type { Role, Utilisateur } from '../types';

// Authentification simulée. En production, le bouton de connexion redirige
// vers le CAS de l'université et l'API renvoie un jeton JWT (BNF-06).

const SESSION_KEY = 'ultra-planning-session';

interface AuthApi {
  user: Utilisateur | null;
  login: (utilisateurId: number) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthApi | null>(null);

function readSession(): number | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(id: number | null) {
  try {
    if (id === null) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, String(id));
  } catch {
    // session non persistée : l'utilisateur devra se reconnecter
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { db } = useData();
  const [userId, setUserId] = useState<number | null>(readSession);
  const user = db.utilisateurs.find((u) => u.id === userId) ?? null;

  const api: AuthApi = {
    user,
    login: (id) => {
      writeSession(id);
      setUserId(id);
    },
    logout: () => {
      writeSession(null);
      setUserId(null);
    },
  };

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>');
  return ctx;
}

/** Utilisateur connecté ; à n'appeler que sous une route protégée. */
export function useCurrentUser(): Utilisateur {
  const { user } = useAuth();
  if (!user) throw new Error('Aucun utilisateur connecté');
  return user;
}

// Droits par rôle (cahier des charges §2 et BNF-07).
export const REFERENTIEL_READ: Role[] = ['administrateur', 'planificateur', 'chef_departement'];
export const REFERENTIEL_WRITE: Role[] = ['administrateur', 'planificateur'];
export const DISPO_ROLES: Role[] = ['enseignant', 'chef_departement', 'planificateur', 'administrateur'];

export function canEditReferentiel(role: Role): boolean {
  return REFERENTIEL_WRITE.includes(role);
}
