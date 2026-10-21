# Ultra Planning 2iE — interface web

Interface React + TypeScript (Vite) du système de planification des cours.
Cette première livraison couvre les **14 premières pages** de la cartographie des écrans
(lot L1 et début du lot L2). Les données sont **mockées** : aucun back-end n'est nécessaire.

## Lancer en local

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vérification TypeScript + build de production
```

Sur l'écran de connexion, « Se connecter avec le compte 2iE (CAS) » ouvre un faux écran CAS
qui propose un compte de test par rôle : administrateur, scolarité, chef de département,
enseignante et étudiant.

## Pages livrées

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

## Organisation du code

```
src/
  types.ts              modèle de données côté interface
  mocks/data.ts         jeu de données fictif (départements 2iE, salles, enseignants…)
  store/DataContext.tsx store en mémoire qui imite l'API (persisté dans localStorage)
  auth/AuthContext.tsx  session simulée et droits par rôle
  components/           mise en page, gardes de route, CrudPage générique, UI
  lib/                  CSV, dates, contrôles de cohérence du référentiel
  pages/                une page par écran
```

Pour brancher l'API FastAPI, il suffira de remplacer `DataContext` par des appels REST :
les pages ne passent que par `useData()`.

## Modèle de données

Le modèle suit la liste des relations du cahier des charges (§7) : département, habilitation,
programme, disponibilité à trois niveaux, volume horaire par type de séance.
Il diffère donc de `schema_supabase.sql` sur les points listés dans `fichier.md` §11,
qui restent à arbitrer avant de brancher la base.
