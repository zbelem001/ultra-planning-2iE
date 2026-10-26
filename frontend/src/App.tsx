import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { StoreProvider } from '@/lib/store'
import Consultation from '@/pages/Consultation'

// La console d'administration n'est téléchargée qu'à l'ouverture de /admin : l'espace invités
// reste léger (connexions lentes ou forfaits limités)
const page = (charger: () => Promise<{ default: React.ComponentType }>) => () => charger().then((m) => ({ Component: m.default }))

const router = createBrowserRouter([
  { path: '/', element: <Consultation /> },
  { path: '/admin/connexion', lazy: page(() => import('@/pages/admin/Login')) },
  {
    path: '/admin',
    lazy: page(() => import('@/pages/admin/AdminLayout')),
    children: [
      { index: true, lazy: page(() => import('@/pages/admin/Dashboard')) },
      { path: 'planification', lazy: page(() => import('@/pages/admin/Planification')) },
      { path: 'disponibilites', lazy: page(() => import('@/pages/admin/Disponibilites')) },
      { path: 'generation', lazy: page(() => import('@/pages/admin/Generation')) },
      { path: 'assistant', lazy: page(() => import('@/pages/admin/Assistant')) },
      { path: 'publication', lazy: page(() => import('@/pages/admin/Publication')) },
      { path: 'referentiel', element: <Navigate to="/admin/referentiel/classes" replace /> },
      { path: 'referentiel/:table', lazy: page(() => import('@/pages/admin/referentiel/Referentiel')) },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default function App() {
  return (
    <StoreProvider>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)', borderRadius: '1.25rem', whiteSpace: 'pre-line' } }} />
    </StoreProvider>
  )
}
