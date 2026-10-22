import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import type { Role } from '../types';

/** Redirige vers la connexion SSO si personne n'est connecté. */
export function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Affiche la page 403 si le rôle n'est pas autorisé (BNF-07). */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return <Navigate to="/acces-refuse" replace />;
  return <>{children}</>;
}
