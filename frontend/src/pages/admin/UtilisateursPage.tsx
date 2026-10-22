import { useData } from '../../store/DataContext';
import CrudPage from '../../components/CrudPage';
import { formatDateTime } from '../../lib/helpers';
import { ROLE_LABELS, type Role, type Utilisateur } from '../../types';

// Page 25 — Comptes et rôles (BF-25, BNF-07), avec le périmètre par département
// du chef. La table UTILISATEUR / ROLE n'existe pas encore dans le MLD (§7,
// évolutions prévues) : elle est mockée. Les comptes viennent de l'annuaire
// CAS / LDAP ; on n'y gère que le rôle et le périmètre, jamais de mot de passe.
// « Archiver » désactive le compte.

const ROLES = Object.keys(ROLE_LABELS) as Role[];

// Résumé des droits, aligné sur les gardes de routes (auth/AuthContext, auth/droits)
const DROITS: { page: string; roles: Role[] }[] = [
  { page: 'Accueil, profil, consultation et exports (1–4, 22, 23)', roles: ROLES },
  { page: 'Disponibilités (14)', roles: ['administrateur', 'planificateur', 'chef_departement', 'enseignant'] },
  { page: 'Référentiel et enseignants, en lecture (5–11, 13)', roles: ['administrateur', 'planificateur', 'chef_departement'] },
  { page: 'Validation du département et tableaux de bord (20, 24)', roles: ['administrateur', 'planificateur', 'chef_departement'] },
  { page: 'Import, campagne, planification, génération, publication (12, 15–19, 21)', roles: ['administrateur', 'planificateur'] },
  { page: 'Comptes, audit, années, paramètres (25–28)', roles: ['administrateur', 'planificateur'] },
];

export default function UtilisateursPage() {
  const { db } = useData();
  const departements = db.departements.filter((d) => !d.archived).map((d) => ({ value: d.id, label: `${d.code} — ${d.libelle}` }));
  const enseignants = db.enseignants.filter((e) => !e.archived).map((e) => ({ value: e.id, label: `${e.nom.toUpperCase()} ${e.prenom} (${e.matricule})` }));
  const groupes = db.groupes.filter((g) => !g.archived).map((g) => ({ value: g.id, label: g.code }));

  const perimetre = (u: Utilisateur) => {
    if (u.role === 'chef_departement') return `Département ${db.departements.find((d) => d.id === u.departementId)?.code ?? '?'}`;
    if (u.role === 'etudiant') return `Groupe ${db.groupes.find((g) => g.id === u.groupeId)?.code ?? '?'}`;
    if (u.role === 'enseignant') return db.enseignants.find((e) => e.id === u.enseignantId)?.matricule ?? '?';
    return 'Toute l’université';
  };

  return (
    <>
      <CrudPage<'utilisateurs', Utilisateur>
        collection="utilisateurs"
        title="Comptes et rôles"
        description="Les comptes proviennent de l’annuaire de l’université (CAS). Archiver un compte le désactive."
        refs="BF-25, BNF-07"
        singular="compte"
        // Les liens absents valent 0 pour que le formulaire générique les traite en nombres
        rows={db.utilisateurs.map((u) => ({ departementId: 0, enseignantId: 0, groupeId: 0, ...u }))}
        searchText={(u) => `${u.login} ${u.nom} ${u.email} ${ROLE_LABELS[u.role]}`}
        columns={[
          { label: 'Identifiant', render: (u) => <code>{u.login}</code> },
          { label: 'Nom', render: (u) => u.nom },
          { label: 'Rôle', render: (u) => <span className="badge">{ROLE_LABELS[u.role]}</span> },
          { label: 'Périmètre', render: perimetre },
          { label: 'Dernière connexion', render: (u) => (u.derniereConnexion ? formatDateTime(u.derniereConnexion) : '—') },
          { label: 'État', render: (u) => (u.archived ? <span className="badge">Désactivé</span> : <span className="badge badge-ok">Actif</span>) },
        ]}
        fields={[
          { key: 'login', label: 'Identifiant CAS', required: true },
          { key: 'nom', label: 'Nom affiché', required: true },
          { key: 'email', label: 'E-mail', type: 'email', required: true },
          { key: 'role', label: 'Rôle', type: 'select', required: true, options: ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })) },
          { key: 'departementId', label: 'Département (chef de département)', type: 'select', options: departements },
          { key: 'enseignantId', label: 'Fiche enseignant liée', type: 'select', options: enseignants },
          { key: 'groupeId', label: 'Groupe (étudiant)', type: 'select', options: groupes },
        ]}
        blank={() => ({ id: 0, login: '', nom: '', email: '', role: 'etudiant', departementId: 0, enseignantId: 0, groupeId: 0 })}
        validate={(u) => {
          const login = u.login.trim().toLowerCase();
          if (db.utilisateurs.some((x) => x.id !== u.id && x.login.toLowerCase() === login)) return `L’identifiant « ${u.login} » est déjà utilisé.`;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) return 'L’adresse e-mail n’est pas valide.';
          if (u.role === 'chef_departement' && !u.departementId) return 'Un chef de département doit être rattaché à son département (BNF-07).';
          if (u.role === 'enseignant' && !u.enseignantId) return 'Un compte enseignant doit être lié à sa fiche enseignant.';
          if (u.role === 'etudiant' && !u.groupeId) return 'Un compte étudiant doit être rattaché à un groupe.';
          return null;
        }}
      />

      <section className="card">
        <h2>Droits par rôle</h2>
        <div className="table-wrap">
          <table className="table rights-table">
            <thead>
              <tr>
                <th>Pages</th>
                {ROLES.map((r) => (
                  <th key={r}>{ROLE_LABELS[r]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DROITS.map((d) => (
                <tr key={d.page}>
                  <td>{d.page}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="center">
                      {d.roles.includes(r) ? <span aria-label="oui">✓</span> : <span className="muted" aria-label="non">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Le chef de département ne voit et ne valide que son département ; l’étudiant ne voit que son groupe, l’enseignant que son propre planning.
        </p>
      </section>
    </>
  );
}
