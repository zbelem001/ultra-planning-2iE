import { CalendarDays, Clock, Lock, Mail, MapPin, User, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui'
import { couleurMatiere, nomEnseignant, publicCours, type SeanceVue } from '@/lib/queries'
import { fmtHeure, fmtJourLong } from '@/lib/time'

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5">
      <span className="mt-0.5 text-ink-2 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-ink-2">{label}</p>
        <div className="text-sm text-ink">{children}</div>
      </div>
    </div>
  )
}

export function StatutSeanceBadge({ s }: { s: SeanceVue }) {
  if (s.statut === 'annulee') return <Badge tone="danger" dot>Annulée</Badge>
  if (s.statut === 'validee') return <Badge tone="success" dot>Effectuée</Badge>
  return <Badge tone="navy" dot>Planifiée</Badge>
}

/** `publique` : espace invités, sans les coordonnées des enseignants (vue enseignant_public) */
export function SeanceDetail({ s, publique }: { s: SeanceVue; publique?: boolean }) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 size-3 shrink-0 rounded-full" style={{ backgroundColor: couleurMatiere(s.matiere.id_matiere) }} />
        <div>
          <p className="text-xl font-light">{s.matiere.libelle}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge tone="navy">{s.cours.type_cours}</Badge>
            <StatutSeanceBadge s={s} />
            {s.est_verrouillee && <Badge tone="orange"><Lock className="size-3" />Verrouillée</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-3 divide-y divide-line/70">
        <Row icon={<CalendarDays />} label="Date"><span className="first-letter:uppercase">{fmtJourLong(s.date_seance)}</span></Row>
        <Row icon={<Clock />} label="Horaire">
          <span className="font-mono tabular-nums">{fmtHeure(s.heure_debut)} – {fmtHeure(s.heure_fin)}</span> · {s.duree} h
        </Row>
        <Row icon={<MapPin />} label="Salle">
          {s.salle.nom_salle} <span className="text-ink-2">· {s.type_salle?.libelle} · {s.salle.capacite} places</span>
          <p className="text-xs text-ink-2">{[s.site?.nom_site, s.salle.batiment].filter(Boolean).join(' · ')}</p>
        </Row>
        <Row icon={<User />} label="Enseignant">
          {nomEnseignant(s.enseignant)} {s.enseignant.grade && <span className="text-ink-2">· {s.enseignant.grade}</span>}
          {!publique && s.enseignant.email && (
            <a href={`mailto:${s.enseignant.email}`} className="mt-0.5 flex items-center gap-1 text-xs text-navy underline-offset-2 hover:underline">
              <Mail className="size-3" />{s.enseignant.email}
            </a>
          )}
        </Row>
        <Row icon={<Users />} label="Public">
          {publicCours(s.classe, s.groupe)} <span className="text-ink-2">· {s.classe.libelle} · {s.groupe ? s.groupe.effectif : s.classe.effectif} étudiants</span>
        </Row>
      </div>
    </div>
  )
}
