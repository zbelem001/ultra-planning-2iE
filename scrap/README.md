# Extraction depuis HyperPlanning 2iE

Récupère l'emploi du temps d'une promotion sur l'espace invités HyperPlanning de 2iE
(https://svr-appweb.2ie-edu.org/hp/invite) et le convertit en CSV importables dans le
référentiel d'UltraPlanning.

```bash
npm install                 # puppeteer-core (pilote Google Chrome, sans fenêtre)
node extraire.mjs "IA S9"   # emploi du temps de la promotion, semaine par semaine -> brut/
node salles.mjs             # toutes les salles avec capacité et site -> brut/salles.json
python3 vers_csv.py         # brut/ -> csv/
```

Le texte de recherche doit désigner une seule promotion (« IA S9 » donne « CYCLE ING IIA S9 »).

## Fichiers produits (csv/)

À importer dans cet ordre (Référentiel > Importer un fichier) :

| Fichier | Contenu |
|---|---|
| `sites.csv` | Kamboinsé et Ouagadougou, avec les codes du référentiel (KAMB, OUAGA) |
| `salles.csv` | Toutes les salles de 2iE : capacité et site réels ; type déduit du nom |
| `classes.csv` | La promotion (IIA-S9, M2, filière IA) |
| `matieres.csv` | Les matières de la promotion, codes préfixés IIA- |
| `enseignants.csv` | Les enseignants (matricule HP-NOM) |
| `programme.csv` | Volumes CM / TD / TP par matière, rattachés au « Semestre 1 2026-2027 » |
| `cours.csv` | Un cours par matière et type, avec l'enseignant prévu |
| `seances.csv` | Les séances telles qu'HyperPlanning les publie (référence, pas un fichier du référentiel) |

## À savoir

- HyperPlanning ne donne que le **nom de famille** des enseignants : le prénom vaut « (à compléter) ».
- **Types** : Cours → CM, TD → TD, TP → TP, Projet → TP. Les examens sont gardés dans `seances.csv`, hors volume des cours. Correspondances modifiables en tête de `vers_csv.py`.
- **Effectif** de la classe inconnu : 0, à compléter.
- Le volume d'un cours est la somme des heures publiées ; une séance de 5 h compte 5 h, mais la durée par défaut du cours est ramenée entre 2 et 4 h.
- Les séances vont du 16 septembre au 1er décembre 2026, alors que le « Semestre 1 2026-2027 » du référentiel commence le 12 octobre.
