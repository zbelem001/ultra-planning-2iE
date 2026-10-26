# UltraPlanning 2iE · frontend

Interface web de planification des cours (voir `../fichier.md`). Deux modes :
- **simulé** (par défaut) : données fictives fidèles au schéma `../migrations/schema_supabase.sql`, gardées dans le navigateur ;
- **connecté** : si `VITE_API_URL` désigne l'API (`../backend`), les données viennent de la base et chaque modification y est enregistrée.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

## Deux interfaces

| Route | Public | Contenu |
|---|---|---|
| `/` | Enseignants, étudiants (invités) | Consultation façon HyperPlanning : onglets Classes / Enseignants / Salles / Matières, filtre filière et groupe, types CM/TD/TP, vues Semaine, Jour, Liste, Semestre, export iCalendar, impression, lien partageable |
| `/admin` | Scolarité, administrateurs | Tableau de bord, planification par glisser-déposer, disponibilités, génération, assistant IA, publication, référentiel |

La connexion admin est simulée (le SSO / CAS remplacera l'écran `/admin/connexion`).

## Organisation

```
src/
  types/db.ts          Types TS : une interface par table SQL, noms de colonnes identiques
  data/mock.ts         Jeu de test du script SQL (sections 8 et 9) + séances datées générées
  lib/rules.ts         Contrôle CD-01 à CD-11 (copie du déclencheur verifier_seance)
  lib/generator.ts     Générateur glouton de démonstration (remplacé plus tard par OR-Tools CP-SAT)
  lib/store.tsx        Base partagée : simulée (localStorage) ou image de l'API
  lib/api.ts           Client de l'API (mode connecté)
  lib/queries.ts       Jointures utilisées par les vues
  components/          Kit d'interface (DESIGN.md) et composants d'emploi du temps
  pages/               Consultation (invité) et pages admin
```

## Mode connecté

```bash
cp .env.example .env.local     # VITE_API_URL=http://localhost:8000
npm run dev
```

L'API doit autoriser l'origine du frontend (`ULTRAPLANNING_ORIGINES`).

**École consultée par les invités** : `?ecole=CODE` dans l'adresse (par exemple `/?ecole=2IE`, à mettre en favori), sinon `VITE_ECOLE`, sinon la seule école active. Si plusieurs écoles utilisent la plateforme et qu'aucune n'est précisée, l'espace invités propose de choisir.

**Nouvelle école** : sa grille de créneaux et ses types de salle sont créés avec elle. À la première connexion, la console demande le premier semestre (`Demarrage.tsx`), puis s'ouvre.

**Comptes** : la page Référentiel > Utilisateurs liste les comptes de l'école. L'administrateur y invite ses planificateurs (e-mail avec un lien pour choisir le mot de passe), renvoie une invitation, modifie ou désactive un compte. En mode connecté, aucun compte ne se crée autrement.

**Publication** : la publication passe par l'API, qui prévient par e-mail les enseignants dont les séances changent.

**Import CSV** (Référentiel, bouton Importer ; gabarit par table avec le bouton Gabarit CSV) :
- les colonnes sont reconnues par leur libellé (« Code », « Effectif ») ou leur nom technique (`code_classe`), sans tenir compte des majuscules ni des accents ; une référence s'écrit par son code (« L2INFO » pour la classe) ; une colonne inconnue est ignorée et signalée ;
- une ligne déjà présente (même code, ou même clé : classe + groupe, classe + matière + semestre…, `cle` dans `config.tsx`) est **mise à jour** avec les cellules remplies ; les autres sont créées ;
- chaque ligne passe par les mêmes contrôles que la saisie ; le rapport donne les lignes créées, mises à jour et rejetées (avec le motif).

**Génération** (mode connecté) : à partir d'une semaine, pour tout l'établissement, une filière ou des classes choisies, jusqu'à la fin du semestre, pour une ou deux semaines, ou jusqu'à une date. Deux modes : recalculer les séances non verrouillées de la période, ou **compléter seulement** (les séances existantes restent, seules les heures manquantes sont ajoutées). Si la version courante est publiée, un bandeau propose de créer une version de travail.

**Espace invités léger** (connexions lentes, forfaits limités) :
- la console d'administration et le client Supabase ne sont téléchargés qu'à l'ouverture de `/admin` ; le jeu de test, qu'en mode simulé ; la bibliothèque Excel, qu'au clic sur l'export. Première visite : ≈ 170 Ko au total ;
- l'API compresse ses réponses et étiquette l'emploi du temps public (ETag) : tant que rien n'est publié ou modifié, une visite ne coûte qu'une réponse « 304 » vide ;
- un service worker (`public/sw.js`, en production) garde les fichiers du site et le dernier emploi du temps sur l'appareil : visites suivantes quasi gratuites, consultation possible sans connexion (bandeau « Hors ligne ») ;
- pas de police monospace à télécharger (police système).

**Exports** (espace invités) : iCalendar, impression / PDF, et Excel (feuille des séances du semestre et récapitulatif des heures par matière ; bibliothèque `exceljs`, chargée seulement au moment de l'export).

**Connexion** : avec `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY`, la console se connecte par e-mail et mot de passe (Supabase Auth). Les comptes sont créés par invitation depuis la console super admin (`../superadmin`) ; le lien de l'invitation mène à `/admin/connexion`, où la personne choisit son mot de passe. Sans ces variables, la connexion de développement (liste des comptes) demande une API lancée avec `ULTRAPLANNING_AUTH_DEV=1`.

Le front ne lit et n'écrit qu'à travers `useStore()` (`lib/store.tsx`) :
- **Lecture** : l'invité reçoit l'image publique (version publiée seulement), un gestionnaire connecté l'image complète.
- **Écriture** : chaque `mutate()` calcule la différence avec l'état précédent (par clé primaire) et l'envoie à `POST /api/base/sync`. Si la base la refuse, le motif s'affiche et l'état réel est rechargé. Les contrôles de `lib/rules.ts` expliquent un refus avant l'écriture ; la base reste l'arbitre final.
- **Génération** : le moteur CP-SAT tourne sur le serveur, sur une filière ou tout l'établissement, de la semaine choisie à la fin du semestre. On voit les heures placées, les heures non placées et leur motif, et un aperçu semaine par semaine avant d'appliquer.
- **Assistant IA** : messages envoyés à l'API ; chaque proposition affiche ses conséquences et se valide ou se rejette sur place, et aussi depuis la page Publication.

En mode simulé, le générateur glouton (`lib/generator.ts`) tourne dans le navigateur, l'assistant répond par des règles simples, et le bouton « Réinitialiser » recharge le jeu de test.
