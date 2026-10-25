import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { SessionProvider } from '@/lib/session'
import Connexion from '@/pages/Connexion'
import Ecole from '@/pages/Ecole'
import Ecoles from '@/pages/Ecoles'
import Journal from '@/pages/Journal'
import Layout from '@/pages/Layout'

const router = createBrowserRouter([
  { path: '/connexion', element: <Connexion /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Ecoles /> },
      { path: 'ecoles/:id', element: <Ecole /> },
      { path: 'journal', element: <Journal /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])

export default function App() {
  return (
    <SessionProvider>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" richColors closeButton />
    </SessionProvider>
  )
}
