# Ultra Planning 2iE — interface web

Interface React + TypeScript (Vite) du système de planification des cours.
Elle couvre les **28 pages** de la cartographie des écrans : les pages 1 à 14 (lot L1 et début
du lot L2, branche `Daniel`) et les pages 15 à 28 (lots L2 à L4, branche `Imaane`).
Les données sont **mockées** : aucun back-end n'est nécessaire.

## Lancer en local

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vérification TypeScript + build de production
```

Sur l'écran de connexion, « Se connecter avec le compte 2iE (CAS) » ouvre un faux écran CAS
qui propose un compte de test par rôle : administrateur, scolarité, chef de département,
enseignante et étudiant. S'y ajoutent une cheffe de département GCH, un enseignant et une
déléguée de L1. L'étudiant et l'enseignant arrivent directement sur leur emploi du temps.

## Pages livrées — 1 à 14

| # | Page | Route | Rôles | Exigences |
|---|------|-------|-------|-----------|
| 1 | Connexion SSO (CAS simulé) | `/connexion` | tous | BNF-06 |
| 2 | Accueil selon le rôle (séances du jour, alertes de cohérence) | `/` | tous | — |
| 3 | Profil, notifications, lien iCal | `/profil` | tous | BF-20, BF-22 |
| 4 | Pages d'erreur 403 / 404 / maintenance | `/acces-refuse`, `*`, `/maintenance` | tous | BNF-07 |
| 5 | Départements | `/referentiel/departements` | admin, scolarité, chef (lecture) | BF-01 |
| 6 | Filières et programme | `/referentiel/filieres[/:id]` | idem | BF-01, BF-06 |
| 7 | Groupes et effectifs | `/referentiel/groupes` | idem | BF-01 |
| 8 | Cours et volumes CM/TD/TP | `/referentiel/cours[/:id]` | idem | BF-02, BF-03 |
| 9 | Bâtiments et salles | `/referentiel/salles` | idem | BF-04 |
| 10 | Types de salle et de séance | `/referentiel/types` | idem | BF-04, CD-05 |
| 11 | Grille des créneaux | `/referentiel/creneaux` | idem | BF-05 |
| 12 | Import CSV avec rapport d'erreurs | `/referentiel/import` | admin, scolarité | BF-07 |
| 13 | Enseignants et habilitations | `/enseignants[/:id]` | admin, scolarité, chef (lecture) | BF-08 |
| 14 | Saisie des disponibilités | `/disponibilites` | enseignant, chef, scolarité, admin | BF-09 |

Un chef de département ne voit que les cours, filières et enseignants de son département.

## Pages livrées — 15 à 28

| # | Page | Route | Rôles | Exigences |
|---|------|-------|-------|-----------|
| 15 | Campagne de saisie : date limite, taux par département, relances | `/campagne` | admin, scolarité | BF-10 |
| 16 | Grille de planification : glisser-déposer, contrôle temps réel, propositions, verrouillage, signalements reçus | `/planification` | admin, scolarité | BF-11 à BF-13, BF-17 |
| 17 | Duplication de la semaine type sur le semestre | `/planification/duplication` | admin, scolarité | BF-14 |
| 18 | Lancer une génération : périmètre, poids CS-01 à CS-06 | `/generation` | admin, scolarité | BF-15, BF-16 |
| 19 | Suivi (tâche Celery simulée) et résultat : taux, non placées, accepter / rejeter | `/generation/:id` | admin, scolarité | BF-18 |
| 20 | Validation du département : volumes, habilitations, EDT proposé | `/validation` | chef (son département), admin, scolarité (suivi) | §2 |
| 21 | Publication, historique et comparaison des versions, notifications | `/publication` | admin, scolarité | BF-19, BF-20 |
| 22 | Consultation par groupe, enseignant, salle ou filière ; vues jour, semaine, semestre ; signalement par l'enseignant | `/emploi-du-temps` | tous (étudiant : son groupe ; enseignant : son planning) | BF-21, BNF-11 |
| 23 | Exports PDF (impression), Excel (.xlsx), iCalendar et lien d'abonnement, depuis la page 22 | `/emploi-du-temps` | tous | BF-22 |
| 24 | Tableaux de bord : heures planifiées / prévues, occupation des salles, charge des enseignants | `/tableaux-de-bord` | admin, scolarité, chef (son département) | BF-23, BF-24 |
| 25 | Comptes et rôles, périmètre par département, matrice des droits | `/admin/utilisateurs` | admin, scolarité | BF-25, BNF-07 |
| 26 | Journal d'audit filtrable et exportable | `/admin/audit` | admin, scolarité | BF-25, BNF-08 |
| 27 | Années universitaires et semestres : ouverture, clôture | `/admin/annees` | admin, scolarité | BF-26 |
| 28 | Paramètres : semestre actif, heures max / jour (CS-06), poids par défaut, gabarits d'e-mail | `/admin/parametres` | admin, scolarité | CS-06, BF-16 |

Points de fonctionnement à connaître :

- **Contraintes dures.** `lib/contraintes.ts` contrôle CD-01 à CD-09 pour chaque séance. La grille,
  les propositions de créneaux et de salles, le moteur et la publication utilisent tous ce même
  contrôle. Un dépôt refusé affiche tous ses motifs.
- **Promotion et sous-groupes.** Le MLD ne relie pas les groupes entre eux. On suppose que le plus
  grand groupe d'une filière est la promotion entière : L1-ING-A ne peut pas avoir cours en même
  temps que L1-ING-TD1 (CD-03).
- **Semaine type et semestre.** Les séances forment une semaine type. La duplication (page 17) la
  répète sur les semaines de cours et arrête chaque série dès que son volume prévu est atteint
  (CD-08). Les vues semestre, les exports et les tableaux de bord partent de ces séances datées.
- **Moteur simulé.** `lib/moteur.ts` est une heuristique déterministe qui tient la place du modèle
  OR-Tools CP-SAT. Il garde les séances verrouillées et celles hors périmètre, pondère les
  contraintes souples et nomme la contrainte bloquante de chaque séance non placée.
- **Journal d'audit.** `store/journal.tsx` compare le store avant et après chaque changement et
  inscrit qui a créé, modifié ou supprimé quoi. Les pages du référentiel sont donc couvertes sans
  avoir été modifiées.
- **Anomalies volontaires des mocks.** IA503 n'a pas de volume horaire, et L1-ING-A (180
  étudiants) ne tient dans aucun amphithéâtre. La grille signale les deux séances concernées, et
  la publication reste bloquée tant qu'elles ne sont pas corrigées.

## Organisation du code

```
src/
  types.ts              modèle de données côté interface
  mocks/data.ts         jeu de données fictif (départements 2iE, salles, enseignants…)
  store/DataContext.tsx store en mémoire qui imite l'API (persisté dans localStorage)
  auth/AuthContext.tsx  session simulée et droits par rôle
  store/journal.tsx     journal d'audit automatique (BNF-08)
  auth/droits.ts        droits des pages 15 à 28, notifications
  components/           mise en page, gardes de route, CrudPage générique, UI,
                        grille hebdomadaire et cartes de séance (planning.tsx)
  lib/                  CSV, dates, contrôles de cohérence du référentiel ;
                        contraintes.ts (CD-01…CD-09), planning.ts (semestre, versions),
                        moteur.ts (génération simulée), exports.ts (.xlsx, .ics)
  pages/                une page par écran (planification/, generation/,
                        consultation/, pilotage/, admin/ pour les pages 15 à 28)
```

Pour brancher l'API FastAPI, il suffira de remplacer `DataContext` par des appels REST :
les pages ne passent que par `useData()`.

## Modèle de données

Le modèle suit la liste des relations du cahier des charges (§7) : département, habilitation,
programme, disponibilité à trois niveaux, volume horaire par type de séance.
Il diffère donc de `schema_supabase.sql` sur les points listés dans `fichier.md` §11,
qui restent à arbitrer avant de brancher la base.

Les pages 15 à 28 ont besoin de tables qui **ne figurent pas dans le MLD actuel**. Le cahier des
charges (§7) les cite seulement comme évolutions prévues. Elles sont mockées en attendant :

- `UTILISATEUR` / `ROLE` (page 25), avec le rattachement à un département, une fiche enseignant ou un groupe ;
- `ANNEE_UNIVERSITAIRE` / `SEMESTRE` (page 27, BF-26) ;
- la table d'audit (page 26, BNF-08).

Le reste n'est pas non plus dans le MLD : campagnes et relances, duplications, générations,
validations de département, versions publiées (instantanés de la semaine type), signalements,
paramètres et gabarits d'e-mail. Tous ces éléments sont à modéliser avec le back-end.
