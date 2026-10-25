import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { StoreProvider } from '@/lib/store'
import Consultation from '@/pages/Consultation'
import AdminLayout from '@/pages/admin/AdminLayout'
import Assistant from '@/pages/admin/Assistant'
import Dashboard from '@/pages/admin/Dashboard'
import Disponibilites from '@/pages/admin/Disponibilites'
import Generation from '@/pages/admin/Generation'
import Login from '@/pages/admin/Login'
import Planification from '@/pages/admin/Planification'
import Publication from '@/pages/admin/Publication'
import Referentiel from '@/pages/admin/referentiel/Referentiel'

const router = createBrowserRouter([
  { path: '/', element: <Consultation /> },
  { path: '/admin/connexion', element: <Login /> },
  {
    path: '/admin',
    element: <AdminLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'planification', element: <Planification /> },
      { path: 'disponibilites', element: <Disponibilites /> },
      { path: 'generation', element: <Generation /> },
      { path: 'assistant', element: <Assistant /> },
      { path: 'publication', element: <Publication /> },
      { path: 'referentiel', element: <Navigate to="/admin/referentiel/classes" replace /> },
      { path: 'referentiel/:table', element: <Referentiel /> },
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
