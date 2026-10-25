# UltraPlanning 2iE · API et assistant IA

API FastAPI autour du solveur (`../solver`) et de l'assistant IA (modèle servi par Groq).

Elle porte :
- l'image de la base pour le frontend, et l'enregistrement de ses modifications (revalidées par les déclencheurs) ;
- la génération ;
- la vérification d'une séance ;
- l'assistant ;
- l'application des propositions ;
- la console super admin : écoles clientes et comptes (`../superadmin`).

```bash
python3 -m venv .venv
.venv/bin/pip install -e ../solver -e ".[test]"

export DATABASE_URL="postgresql://…"       # base chargée avec « ../migrations/schema_supabase.sql »
.venv/bin/uvicorn app.main:app --reload     # documentation : http://localhost:8000/docs
```

Le fichier `backend/.env` (ignoré par git) est lu au démarrage ; les variables déjà définies dans l'environnement restent prioritaires :

| Variable | Rôle |
|---|---|
| `GROQ_API_KEY` | Clé de l'API Groq |
| `GROQ_API_URL` | Point d'accès (on en garde l'hôte ; défaut `https://api.groq.com`) |
| `MODEL` | Modèle Groq (défaut `openai/gpt-oss-120b`) |
| `DATABASE_URL` | Connexion PostgreSQL (peut aussi être placée ici) |
| `SUPABASE_POOLER_URL` | URI du « Session pooler » de Supabase, utilisée si `DATABASE_URL` est absente |
| `ULTRAPLANNING_EFFORT` | Niveau de raisonnement du modèle : `low`, `medium` (défaut), `high` |
| `ULTRAPLANNING_ITERATIONS_AGENT` | Étapes d'outils au plus par message (12) |
| `ULTRAPLANNING_ORIGINES` | Origines CORS des fronts (défaut : 5173 console, 5174 super admin) |
| `SUPABASE_URL` | Projet Supabase : vérification des jetons et invitations |
| `SUPABASE_SECRET_KEY` | Clé secrète (ou `SUPABASE_SERVICE_ROLE_KEY`) pour l'API d'administration de Supabase Auth |
| `SUPABASE_JWKS_URL` | Clés publiques des jetons (défaut : `SUPABASE_URL/auth/v1/.well-known/jwks.json`) |
| `ULTRAPLANNING_URL_CONSOLE` | Page où mène l'invitation d'un compte d'école (défaut `http://localhost:5173/admin/connexion`) |
| `ULTRAPLANNING_URL_SUPERADMIN` | Page où mène l'invitation du super admin (défaut `http://localhost:5174/connexion`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Envoi des e-mails de publication aux enseignants (587 : STARTTLS, 465 : SSL). Mêmes identifiants possibles que le SMTP configuré dans Supabase. Sans `SMTP_HOST`, la publication passe mais aucun e-mail ne part |
| `ULTRAPLANNING_URL_INVITES` | Adresse de l'espace invités, pour le lien des e-mails (défaut `http://localhost:5173/`) |
| `ULTRAPLANNING_AUTH_DEV` | `1` : accepte l'en-tête `X-Utilisateur` sans jeton. **Développement seulement** |

## Routes

| Route | Rôle |
|---|---|
| `GET /api/sante` | État du service |
| `GET /api/base` | Image complète de la base pour la console (mots de passe jamais renvoyés) |
| `GET /api/ecoles` | Écoles actives (choix de l'école dans l'espace invités) |
| `GET /api/base/public?ecole=CODE` | Ce que voit un invité de cette école : référentiel, version publiée, enseignants sans coordonnées (sans `ecole` : la seule école active) |
| `POST /api/demarrage` | Premier semestre et premier emploi du temps (avec ses 21 contraintes) d'une nouvelle école |
| `POST /api/emplois-du-temps/{id}/publier` | Publie une version (la précédente est archivée) ; `notifier` : e-mail à chaque enseignant dont les séances changent (ajoutées, retirées, modifiées), avec le lien vers son emploi du temps |
| `GET` · `POST /api/ecole/comptes` | Comptes de l'école (tous les gestionnaires) ; invitation d'un compte (administrateur de l'école) |
| `POST /api/ecole/comptes/{id}/inviter` · `PATCH /api/ecole/comptes/{id}` | Renvoi d'invitation, modification, désactivation (administrateur de l'école ; il ne peut ni se désactiver ni se retirer le rôle) |
| `POST /api/base/sync` | Ajouts, modifications, suppressions faits dans l'interface, en une transaction ; 409 avec le motif (CD-xx) si la base refuse |
| `GET /api/moi` | Compte connecté et son école |
| `GET /api/comptes?console=ecole\|superadmin` | Comptes pour l'écran de connexion de développement (`ULTRAPLANNING_AUTH_DEV=1`) |
| `POST /api/generations` | Lance une génération (périmètre, période) en tâche de fond |
| `GET /api/generations/{id}` | État et résultat (séances, heures non placées et leur motif) |
| `POST /api/generations/{id}/appliquer` | Enregistre le résultat ; la base revalide chaque séance |
| `POST /api/verifications` | Teste une séance contre les règles CD-01 à CD-14, sans rien écrire |
| `POST /api/assistant/messages` | Envoie un message à l'assistant (nouvelle discussion ou suite) |
| `GET /api/propositions?id_edt=…` | Propositions de l'assistant en attente, avec leurs conséquences |
| `POST /api/propositions/{id}/appliquer` · `/rejeter` | Décision du planificateur |
| `GET` · `POST /api/superadmin/ecoles` | Écoles clientes (nombre de comptes), création |
| `PATCH /api/superadmin/ecoles/{id}` | Modification, suspension (`statut`) |
| `GET` · `POST /api/superadmin/ecoles/{id}/comptes` | Comptes d'une école (état de l'invitation), invitation d'un compte |
| `POST /api/superadmin/comptes/{id}/inviter` | Renvoie l'invitation, ou un lien de nouveau mot de passe si elle est acceptée |
| `GET /api/superadmin/journal` | Journal d'audit des séances (filtres : `id_ecole`, `du`, `au`, `action`, `origine` ; page suivante : `avant`) |
| `PATCH /api/superadmin/comptes/{id}` | Active ou désactive un compte (bloqué aussi dans Supabase Auth) ; change son e-mail, son login ou son rôle. Nouvelle adresse : mise à jour dans Supabase Auth si l'invitation est acceptée (même mot de passe), sinon nouvelle invitation à la nouvelle adresse |

## Isolation entre écoles

Chaque table métier porte `id_ecole`. Pour une requête d'un compte d'école, `auth.utilisateur_courant` appelle `db.entrer_ecole()` :
- l'école du compte est fixée dans la session (`app.id_ecole`) ;
- la connexion prend le rôle `ultraplanning_app`.

La RLS de chaque table (schéma, section 7) ne montre et ne laisse écrire à ce rôle que l'école du compte. Rien d'autre à faire dans les routes : l'API, le solveur, l'assistant et les déclencheurs sont filtrés par la base.

- Chaque requête repart du rôle propriétaire, sans école (`db.connexion`). Un réglage ne passe donc jamais d'une requête à l'autre par le pooler de Supabase.
- Les routes du super admin gardent le rôle propriétaire.
- Le fil d'une génération en tâche de fond entre dans l'école du compte qui l'a lancée. Les tâches ne sont visibles que de cette école.
- **Synchronisation** : la console numérote ses nouvelles lignes d'après ce qu'elle voit, et ce numéro peut déjà appartenir à une autre école. Dans ce cas, `/api/base/sync` donne un nouveau numéro à la ligne, le reporte dans les lignes du même envoi qui la désignent, et le renvoie dans `identifiants`. La console se recharge alors.
- Le solveur, utilisable sans l'API (ligne de commande, tests), filtre lui-même toutes ses lectures sur l'école de l'emploi du temps (`solver/ultraplanning_solver/base.py`).

**Journal d'audit** : le déclencheur `journaliser_seance` inscrit chaque changement de séance dans `journal_seance`, avec le compte (`app.id_utilisateur`) et l'origine (`app.origine` : `console`, `generation`, `assistant`), que `db.entrer_ecole()` et les routes fixent. Hors API (ligne de commande du solveur), l'origine est `systeme`. Le rôle `ultraplanning_app` n'a aucun droit sur cette table.

**Base existante en version 6** : exécuter `../migrations/007_isolation_ecoles.sql` (SQL Editor de Supabase). Toutes les données existantes sont rattachées à 2IE ; la migration est faite en une seule transaction. Puis, pour le journal d'audit, `../migrations/008_journal_audit.sql`.

## Authentification

- **Jeton Supabase Auth** : les fronts envoient `Authorization: Bearer <jeton>`. L'API le vérifie avec les clés publiques du projet (JWKS, ES256), puis retrouve le compte par `utilisateur.auth_id`. Un compte désactivé, ou d'une école suspendue, est refusé (403).
- **Rôles** : les routes des emplois du temps sont réservées aux administrateurs et planificateurs, `/api/superadmin/*` au super admin. Un compte d'école ne voit et ne modifie que les comptes de son école (`/api/base`, `/api/base/sync`).
- **Invitations** : le super admin invite par e-mail (API d'administration de Supabase Auth, clé secrète) ; la personne suit le lien et choisit son mot de passe.
- **Développement** : avec `ULTRAPLANNING_AUTH_DEV=1`, l'en-tête `X-Utilisateur: <id_utilisateur>` suffit, et les fronts sans configuration Supabase proposent une liste de comptes. Jamais en production.

**Premier super admin** (une fois, sur une base en version 6) :

```bash
.venv/bin/python -m app.creer_superadmin --email vous@exemple.org --login superadmin
```

**Réglages du projet Supabase** (Authentication) :
- *URL Configuration* : ajouter les pages d'arrivée des liens dans *Redirect URLs* (`http://localhost:5173/admin/connexion`, `http://localhost:5174/connexion`, puis les adresses de production) ;
- *SMTP Settings* : configurer un serveur d'envoi. Le service par défaut de Supabase n'envoie qu'aux membres de l'équipe du projet, avec un débit très faible.

**Base existante en version 5** : exécuter `../migrations/006_ecoles.sql` (SQL Editor de Supabase). La migration est additive et peut être relancée.

## Assistant IA

L'agent (`app/agent.py`) dialogue avec le modèle par l'API « chat completions » de Groq, avec appels d'outils : le modèle demande un outil, l'agent l'exécute et lui renvoie le résultat, jusqu'à la réponse finale (12 étapes au plus). Les six outils sont dans `app/outils.py` ; leur schéma JSON est déduit de la signature et de la docstring (`app/schema_outil.py`), et leurs arguments sont validés avant l'appel.

| Outil | Rôle |
|---|---|
| `lire_emploi_du_temps` | Séances d'une classe, d'un enseignant ou d'une salle sur une période |
| `lire_referentiel` | Cours, classes, enseignants, salles, programme, calendrier |
| `verifier_seance` | Test d'une séance dans la base, sans écriture |
| `proposer_replanification` | Appel du solveur en replanification minimale (semaines entières), avec contraintes « imposer / interdire » ; le résultat devient une `PROPOSITION` en attente |
| `proposer_generation` | Génération complète d'une classe ou d'une filière (par défaut de la semaine prochaine à la fin du semestre) ; le résultat devient une `PROPOSITION` en attente |
| `proposer_priorites` | Priorités suggérées pour les cours, avec justification |

### Argumenter

Le modèle joue le rôle d'un conseiller, pas d'un exécutant (consigne `SYSTEME` de `app/agent.py`) :
- **Demande impossible** : il la refuse en citant la règle (CD-xx) et les chiffres réels (séances existantes, plafond, horaires), ne crée pas de proposition et donne une ou deux alternatives réalistes.
- **Conséquences** : `proposer_replanification` calcule l'impact (`app/impact.py`) et le joint à la proposition (`proposition.impact`) : séances déplacées, retirées, créées ; heures qui ne seraient plus programmées ; enseignants à prévenir ; fins de cours décalées ; journées chargées ; changements de site. Le modèle les présente, déconseille une proposition qui perd des heures et propose de l'élargir.
- **Ambiguïté** : il pose une question plutôt que de deviner.

Le frontend affiche ces conséquences sur chaque proposition (Assistant IA et Publication), à côté des boutons Appliquer et Rejeter.

L'agent ne modifie jamais les séances. Une seule proposition est gardée par message : une nouvelle tentative remplace la précédente. Seul un planificateur applique une proposition (`/api/propositions/{id}/appliquer`) ; l'application passe par les déclencheurs de la base, et une proposition périmée (emploi du temps modifié depuis) est refusée.

Essais réels sur le jeu de test (`openai/gpt-oss-120b`) : une question sur l'emploi du temps répond juste en 2 s ; « aucun cours pour la L2INFO le mardi 13 octobre » produit une proposition en 5 s, puis « élargis à la semaine suivante » une proposition qui replace toutes les heures.

## Tests

```bash
DATABASE_URL=… .venv/bin/python -m pytest
```

Les tests vident puis régénèrent les séances, propositions et discussions de la base : **jamais sur une base de production**. Ils refusent de se lancer si `DATABASE_URL` désigne Supabase. Ils s'identifient par l'en-tête de développement, et un faux Supabase Auth remplace les invitations (aucun e-mail envoyé).

Ils n'appellent pas Groq : un client factice imite l'API (un tour avec appel d'outil, puis la réponse) et l'agent exécute les vrais outils. Un test vérifie aussi le message renvoyé quand aucune clé n'est configurée.

**Limite** : les générations en cours sont gardées en mémoire (un seul processus). Le cahier des charges prévoit Celery + Redis ; seul `app/generations.py` changera.
