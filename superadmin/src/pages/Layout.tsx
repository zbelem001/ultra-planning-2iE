import { Building2, History, LogOut } from 'lucide-react'
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Button, cn, Logo } from '@/components/ui'
import { useSession } from '@/lib/session'

export default function Layout() {
  const { compte, chargement, deconnecter } = useSession()
  const { pathname } = useLocation()
  if (chargement) return <div className="grid min-h-dvh place-items-center text-sm text-ink-2">Chargement…</div>
  if (!compte) return <Navigate to="/connexion" replace />

  return (
    <div className="flex min-h-dvh w-full flex-col px-4 sm:px-8">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-navy focus:px-4 focus:py-2 focus:text-white">
        Aller au contenu
      </a>
      <header className="flex flex-wrap items-center gap-3 py-5">
        <Link to="/" className="rounded-full bg-navy py-1.5 pr-4 pl-1.5" aria-label="Accueil de la console super admin">
          <Logo dark suffix="Super admin" />
        </Link>
        <nav aria-label="Navigation principale" className="order-last w-full sm:order-none sm:w-auto">
          <ul className="flex w-fit gap-1 rounded-full bg-white/70 p-1 ring-1 ring-white">
            {[
              { to: '/', label: 'Écoles', icon: <Building2 />, actif: pathname === '/' || pathname.startsWith('/ecoles') },
              { to: '/journal', label: 'Journal', icon: <History />, actif: pathname.startsWith('/journal') },
            ].map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  aria-current={n.actif ? 'page' : undefined}
                  className={cn('press flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium [&_svg]:size-4',
                    n.actif ? 'bg-navy text-white shadow-sm' : 'text-ink-2 hover:bg-muted hover:text-ink')}
                >
                  {n.icon}{n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-right text-xs leading-tight sm:block">
            <span className="block font-medium text-ink">{compte.login}</span>
            <span className="text-ink-2">{compte.email}</span>
          </span>
          <Button variant="outline" size="icon" title="Se déconnecter" aria-label="Se déconnecter" onClick={() => void deconnecter()}>
            <LogOut />
          </Button>
        </div>
      </header>
      <main id="contenu" className="flex-1 pb-12">
        <Outlet />
      </main>
    </div>
  )
}
