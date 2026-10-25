# UltraPlanning · console super admin

Console de la plateforme : le super administrateur crée les **écoles clientes**, invite leurs **administrateurs** par e-mail, suspend une école ou désactive un compte. Elle n'accède pas aux emplois du temps : chaque école les gère dans sa propre console (`../frontend`).

Même pile et même conception graphique que la console des écoles (React, TypeScript, Vite, Tailwind, DESIGN.md).

```bash
npm install
cp .env.example .env.local   # adresse de l'API et projet Supabase
npm run dev                  # http://localhost:5174
npm run build
```

## Configuration (`.env.local`)

| Variable | Rôle |
|---|---|
| `VITE_API_URL` | Adresse de l'API (`../backend`) |
| `VITE_SUPABASE_URL` | Projet Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clé publique du projet (`sb_publishable_…`), faite pour le navigateur |

Sans les deux variables Supabase, la console propose une **connexion de développement** (choix d'un compte super admin). L'API doit alors tourner avec `ULTRAPLANNING_AUTH_DEV=1`.

## Parcours

1. Le premier super admin est créé côté serveur : `python -m app.creer_superadmin --email …` (voir `../backend/README.md`). Il reçoit un e-mail, suit le lien vers `/connexion` et choisit son mot de passe.
2. **Écoles** : liste avec recherche, filtre par statut et nombre de comptes ; *Nouvelle école* crée l'école et peut inviter tout de suite son premier administrateur.
3. **Fiche d'une école** :
   - modifier ses informations ;
   - la suspendre ou la réactiver ; suspendue, aucun de ses comptes ne se connecte ;
   - inviter un administrateur ou un planificateur ;
   - suivre l'état de chaque invitation (en attente, acceptée) et la renvoyer ; si elle est acceptée, c'est un lien de nouveau mot de passe qui part ;
   - modifier un compte : e-mail, identifiant, rôle. Si l'invitation est acceptée, la personne se connecte ensuite avec la nouvelle adresse et le même mot de passe ; sinon une nouvelle invitation part à la nouvelle adresse ;
   - désactiver ou réactiver un compte.
4. **Journal** : chaque création, modification ou suppression de séance, dans toutes les écoles, avec le compte, l'origine (console, génération, assistant) et ce qui a changé ; filtres par école, action, origine et période.
5. L'administrateur invité arrive sur la console de son école (`/admin/connexion`), choisit son mot de passe et entre.

## Organisation

```
src/
  lib/supabase.ts       Client Supabase Auth ; lit le lien d'invitation avant que Supabase ne nettoie l'adresse
  lib/api.ts            Routes /api/superadmin/* (jeton Supabase, ou en-tête de développement)
  lib/session.tsx       Compte connecté (réservé au rôle superadmin)
  components/ui.tsx     Kit d'interface, copie de celui de la console des écoles
  pages/Connexion.tsx   E-mail et mot de passe, choix du mot de passe, mot de passe oublié
  pages/Ecoles.tsx      Liste et création des écoles
  pages/Ecole.tsx       Fiche, suspension, comptes et invitations
```
