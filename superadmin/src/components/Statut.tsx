import { Badge } from '@/components/ui'
import type { CompteEcole, Ecole } from '@/lib/api'

export function StatutEcole({ statut }: { statut: Ecole['statut'] }) {
  return statut === 'active' ? <Badge tone="success" dot>Active</Badge> : <Badge tone="danger" dot>Suspendue</Badge>
}

const INVITATIONS: Record<CompteEcole['invitation'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  acceptee: { label: 'Invitation acceptée', tone: 'success' },
  en_attente: { label: 'Invitation en attente', tone: 'warning' },
  non_envoyee: { label: 'Pas encore invité', tone: 'neutral' },
  inconnue: { label: 'État inconnu', tone: 'neutral' },
}

export function StatutInvitation({ invitation }: { invitation: CompteEcole['invitation'] }) {
  const s = INVITATIONS[invitation]
  return <Badge tone={s.tone} dot>{s.label}</Badge>
}
