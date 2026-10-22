import { Link } from 'react-router-dom';

// Page 4 — Pages d'erreur : accès refusé (BNF-07), page introuvable, maintenance.

const MESSAGES = {
  403: {
    title: 'Accès refusé',
    text: 'Votre rôle ne donne pas accès à cette page. Si vous pensez que c’est une erreur, contactez la scolarité.',
  },
  404: {
    title: 'Page introuvable',
    text: 'L’adresse demandée n’existe pas ou a été déplacée.',
  },
  503: {
    title: 'Maintenance en cours',
    text: 'Le service est momentanément indisponible. Merci de réessayer dans quelques minutes.',
  },
} as const;

export default function ErrorPage({ code }: { code: keyof typeof MESSAGES }) {
  const { title, text } = MESSAGES[code];
  return (
    <div className="error-page">
      <p className="error-code">{code}</p>
      <h1>{title}</h1>
      <p className="muted">{text}</p>
      {code !== 503 && (
        <Link className="btn btn-primary" to="/">
          Retour à l’accueil
        </Link>
      )}
    </div>
  );
}
