# Jeu de test : classe IIA-S7 (cycle ingénieur IA, semestre 7)

Données **fictives** pour essayer l'import du référentiel, la génération et la planification
sur une nouvelle promotion. Les enseignants n'existent pas : matricules `TST-IA7xx`, adresses
en `@example.org` (domaine réservé, aucun e-mail n'y est délivré).

## Import

Page Référentiel, table indiquée, bouton **Importer**, dans cet ordre :

| Fichier | Table | Contenu |
|---|---|---|
| `1_classes.csv` | Classes | IIA-S7, M1, 40 étudiants, filière IA, site non fixé |
| `2_groupes.csv` | Groupes | TD1 et TD2 (20 chacun) ; TP1 dans TD1, TP2 dans TD2 |
| `3_matieres.csv` | Matières | 8 matières, codes `IA7-…` |
| `4_enseignants.csv` | Enseignants | 6 permanents, 2 vacataires |
| `5_programme.csv` | Programme | Volumes CM / TD / TP de chaque matière (TD et TP : par groupe) |
| `6_cours.csv` | Cours | 27 cours : CM en classe entière, TD et TP par groupe, TP en salle informatique |

Ce qui doit déjà exister : le semestre « Semestre 1 2026-2027 », la filière `IA` et le type de
salle « Salle informatique ». Réimporter un fichier met à jour les lignes déjà présentes.

Dans `2_groupes.csv`, le groupe parent s'écrit comme dans la liste de l'application :
`IIA-S7 · TD1 (TD)`.

## Vérifié sur la base locale

Les six fichiers s'importent sans rejet ; la génération de la classe place 336 h sur 336
(aucune heure non placée).

## Retirer le jeu de test

Supprimer dans l'ordre inverse : les cours, le programme, les groupes, la classe IIA-S7, les
matières `IA7-…`, puis les enseignants `TST-IA7…`. Une classe qui a des séances se libère d'abord
dans la planification.
