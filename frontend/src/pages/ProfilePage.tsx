import { useState } from 'react';
import { useCurrentUser } from '../auth/AuthContext';
import { useData } from '../store/DataContext';
import { formatDateTime } from '../lib/helpers';
import { EmptyState, PageHeader } from '../components/ui';
import { ROLE_LABELS } from '../types';

// Page 3 — Profil et notifications (BF-20, BF-22).

export default function ProfilePage() {
  const user = useCurrentUser();
  const { db, save, reset } = useData();
  const [copied, setCopied] = useState(false);
  const enseignant = db.enseignants.find((e) => e.id === user.enseignantId);
  const groupe = db.groupes.find((g) => g.id === user.groupeId);
  const departement = db.departements.find((d) => d.id === (user.departementId ?? enseignant?.departementId));
  const notifications = db.notifications
    .filter((n) => n.utilisateurId === user.id)
    .sort((a, b) => b.date.localeCompare(a.date));

  // Lien d'abonnement fictif ; le jeton sera délivré par l'API.
  const icalUrl = `https://planning.2ie-edu.org/ical/${user.login}-${user.id.toString(16)}a91f.ics`;

  async function copyIcal() {
    try {
      await navigator.clipboard.writeText(icalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function markAllRead() {
    notifications.filter((n) => !n.lue).forEach((n) => save('notifications', { ...n, lue: true }));
  }

  return (
    <>
      <PageHeader title="Profil et notifications" refs="BF-20, BF-22" />
      <div className="grid-2">
        <section className="card">
          <h2>Mon profil</h2>
          <dl className="details">
            <dt>Nom</dt>
            <dd>{user.nom}</dd>
            <dt>Identifiant</dt>
            <dd>{user.login}</dd>
            <dt>E-mail</dt>
            <dd>{user.email}</dd>
            <dt>Rôle</dt>
            <dd>{ROLE_LABELS[user.role]}</dd>
            {departement && (
              <>
                <dt>Département</dt>
                <dd>{departement.libelle}</dd>
              </>
            )}
            {enseignant && (
              <>
                <dt>Grade</dt>
                <dd>{enseignant.grade}</dd>
                <dt>Téléphone</dt>
                <dd>{enseignant.telephone}</dd>
              </>
            )}
            {groupe && (
              <>
                <dt>Groupe</dt>
                <dd>{groupe.code}</dd>
              </>
            )}
          </dl>
          <p className="muted small">
            Ces informations viennent de l’annuaire de l’université ; elles se modifient auprès du service informatique.
          </p>
        </section>

        <section className="card">
          <h2>Abonnement agenda</h2>
          <p className="muted">
            Ajoutez ce lien à Google Agenda, Outlook ou à votre téléphone pour recevoir automatiquement votre emploi du
            temps publié.
          </p>
          <div className="copy-row">
            <input className="input" readOnly value={icalUrl} aria-label="Lien iCalendar" />
            <button className="btn" onClick={copyIcal}>
              {copied ? 'Copié' : 'Copier'}
            </button>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h2>Notifications</h2>
          {notifications.some((n) => !n.lue) && (
            <button className="btn btn-small" onClick={markAllRead}>
              Tout marquer comme lu
            </button>
          )}
        </div>
        {notifications.length === 0 ? (
          <EmptyState>Aucune notification.</EmptyState>
        ) : (
          <ul className="notif-list">
            {notifications.map((n) => (
              <li key={n.id} className={n.lue ? 'notif' : 'notif unread'}>
                <div>
                  <strong>{n.titre}</strong>
                  <p>{n.texte}</p>
                  <span className="muted small">{formatDateTime(n.date)}</span>
                </div>
                {!n.lue && (
                  <button className="btn btn-small btn-ghost" onClick={() => save('notifications', { ...n, lue: true })}>
                    Marquer comme lu
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Démonstration</h2>
        <p className="muted">Les données sont fictives et conservées dans ce navigateur.</p>
        <button className="btn btn-ghost" onClick={reset}>
          Réinitialiser les données de démonstration
        </button>
      </section>
    </>
  );
}
