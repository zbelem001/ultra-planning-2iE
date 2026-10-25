import {
  CalendarCog, CalendarRange, Database, Eye, LayoutDashboard, LogOut, MessageSquareText, RotateCcw, Send, Sparkles, UserRoundCheck,
} from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, cn, Dialog, Logo } from '@/components/ui'
import { logout, useSession } from '@/lib/auth'
import { ecoleCourante, edtTravail, useStore } from '@/lib/store'
import Demarrage from './Demarrage'

const NAV = [
  { to: '/admin', label: 'Tableau de bord', icon: <LayoutDashboard />, end: true },
  { to: '/admin/planification', label: 'Planification', icon: <CalendarRange /> },
  { to: '/admin/disponibilites', label: 'Disponibilités', icon: <UserRoundCheck /> },
  { to: '/admin/generation', label: 'Génération', icon: <Sparkles /> },
  { to: '/admin/assistant', label: 'Assistant IA', icon: <MessageSquareText /> },
  { to: '/admin/publication', label: 'Publication', icon: <Send /> },
  { to: '/admin/referentiel', label: 'Référentiel', icon: <Database /> },
]

export const STATUT_EDT: Record<string, { label: string; tone: 'neutral' | 'navy' | 'success' | 'warning' }> = {
  brouillon: { label: 'Brouillon', tone: 'warning' },
  valide: { label: 'Validé', tone: 'navy' },
  publie: { label: 'Publié', tone: 'success' },
  archive: { label: 'Archivé', tone: 'neutral' },
}

export default function AdminLayout() {
  const session = useSession()
  const loc = useLocation()
  const { db, reset, recharger, connecte } = useStore()
  const [confirmReset, setConfirmReset] = useState(false)

  if (session === null) return <Navigate to="/admin/connexion" replace state={{ from: loc.pathname }} />
  const user = db.utilisateur.find((u) => u.id_utilisateur === session)
  const edt = edtTravail(db)
  // Nouvelle école : ni semestre ni emploi du temps encore
  if (!edt) return <Demarrage />
  const st = STATUT_EDT[edt.statut]

  return (
    <div className="flex min-h-dvh w-full flex-col px-4 sm:px-8">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-navy focus:px-4 focus:py-2 focus:text-white">
        Aller au contenu
      </a>
      <header className="no-print flex flex-wrap items-center gap-3 py-5 2xl:flex-nowrap">
        <Link to="/admin" className="rounded-full bg-navy py-1.5 pr-4 pl-1.5" aria-label="Console Ultraplanning">
          <Logo dark suffix="Console" ecole={ecoleCourante(db)} />
        </Link>
        <nav aria-label="Navigation principale" className="order-last w-full 2xl:order-none 2xl:w-auto 2xl:flex-1">
          <ul className="flex gap-1 overflow-x-auto rounded-full bg-white/70 p-1 ring-1 ring-white scroll-thin 2xl:w-fit">
            {NAV.map((n) => (
              <li key={n.to} className="shrink-0">
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    cn('press flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium [&_svg]:size-4', isActive ? 'bg-navy text-white shadow-sm' : 'text-ink-2 hover:bg-muted hover:text-ink')
                  }
                >
                  {n.icon}
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link to="/admin/publication" className="hidden items-center gap-2 rounded-full bg-white/70 py-1 pr-1 pl-3 text-xs ring-1 ring-white sm:flex" title="Emploi du temps de travail">
            <CalendarCog className="size-4 text-navy" />
            <span className="font-medium">v{edt.version}</span>
            <Badge tone={st.tone} dot>{st.label}</Badge>
          </Link>
          <Link to="/" className="press grid size-10 place-items-center rounded-full bg-white/80 ring-1 ring-line hover:bg-white" title="Voir l'espace invités" aria-label="Voir l'espace invités">
            <Eye className="size-4" />
          </Link>
          {connecte ? (
            <Button variant="outline" size="icon" title="Recharger depuis la base" aria-label="Recharger les données depuis la base"
              onClick={() => { void recharger().then(() => toast.success('Données rechargées depuis la base')) }}>
              <RotateCcw />
            </Button>
          ) : (
            <Button variant="outline" size="icon" title="Réinitialiser les données" aria-label="Réinitialiser les données de démonstration" onClick={() => setConfirmReset(true)}>
              <RotateCcw />
            </Button>
          )}
          <Button variant="outline" size="icon" title={`Se déconnecter (${user?.login})`} aria-label="Se déconnecter" onClick={logout}>
            <LogOut />
          </Button>
        </div>
      </header>

      <main id="contenu" className="flex-1 pb-12">
        <Outlet />
      </main>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Réinitialiser les données ?"
        description="Toutes vos modifications (séances, référentiel, versions) seront remplacées par le jeu de test du script SQL."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>Annuler</Button>
            <Button variant="destructive" onClick={() => { reset(); setConfirmReset(false); toast.success('Données de démonstration rechargées') }}>Réinitialiser</Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">Cette action ne concerne que ce navigateur.</p>
      </Dialog>
    </div>
  )
}
