// Premiers pas d'une nouvelle école : sa grille de créneaux existe déjà (créée avec l'école),
// il lui manque un semestre et un emploi du temps de travail pour ouvrir la console.

import { CalendarPlus, Loader2, LogOut } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button, Card, Field, Input, Logo } from '@/components/ui'
import { demarrer } from '@/lib/api'
import { logout } from '@/lib/auth'
import { ecoleCourante, useStore } from '@/lib/store'

function anneeEnCours(): string {
  const d = new Date()
  const debut = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1 // l'année commence à la rentrée
  return `${debut}-${debut + 1}`
}

export default function Demarrage() {
  const { db, recharger } = useStore()
  const [f, setF] = useState({ libelle: 'Semestre 1', annee_academique: anneeEnCours(), date_debut: '', date_fin: '' })
  const [envoi, setEnvoi] = useState(false)
  const [erreur, setErreur] = useState('')

  const creer = async (e: FormEvent) => {
    e.preventDefault()
    if (f.date_fin <= f.date_debut) return setErreur('La fin du semestre doit suivre son début.')
    setEnvoi(true)
    setErreur('')
    try {
      await demarrer(f)
      toast.success('Semestre créé', { description: "L'emploi du temps de travail et ses contraintes sont prêts." })
      await recharger()
    } catch (err) {
      setErreur((err as Error).message)
      setEnvoi(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <Card className="p-7 sm:p-9">
          <div className="flex items-center justify-between gap-3">
            <Logo suffix="Console" ecole={ecoleCourante(db)} />
            <Button variant="ghost" size="icon-sm" onClick={logout} title="Se déconnecter" aria-label="Se déconnecter"><LogOut /></Button>
          </div>
          <h1 className="mt-8 text-4xl font-light tracking-tight">Bienvenue</h1>
          <p className="mt-2 text-sm text-ink-2">
            Votre école est prête : sa grille de créneaux (7h–12h et 13h–16h, samedi matin) et ses types de salle sont créés,
            et vous pourrez les modifier dans le Référentiel. Pour commencer, indiquez votre premier semestre.
          </p>
          <form onSubmit={creer} className="mt-8 grid gap-4 sm:grid-cols-2">
            <Field label="Semestre"><Input required value={f.libelle} onChange={(e) => setF({ ...f, libelle: e.target.value })} /></Field>
            <Field label="Année universitaire"><Input required placeholder="2026-2027" value={f.annee_academique} onChange={(e) => setF({ ...f, annee_academique: e.target.value })} /></Field>
            <Field label="Début des cours"><Input type="date" required value={f.date_debut} onChange={(e) => setF({ ...f, date_debut: e.target.value })} /></Field>
            <Field label="Fin du semestre"><Input type="date" required value={f.date_fin} onChange={(e) => setF({ ...f, date_fin: e.target.value })} /></Field>
            {erreur && <p role="alert" className="rounded-3xl bg-[#FEE2E2] px-4 py-3 text-sm text-[#991B1B] sm:col-span-2">{erreur}</p>}
            <Button type="submit" size="lg" className="sm:col-span-2" disabled={envoi}>
              {envoi ? <Loader2 className="animate-spin" /> : <CalendarPlus />}Créer le semestre
            </Button>
          </form>
          <p className="mt-6 text-xs text-ink-2">
            Ensuite : sites, salles, filières, classes, enseignants et programme dans le Référentiel, puis la génération.
          </p>
        </Card>
      </div>
    </div>
  )
}
