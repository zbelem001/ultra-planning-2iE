# Moteur v2 — séances de 2 à 4 h, deux sites, grande échelle

## Lancer (Colab)

```python
!pip install ortools
# glisser moteur_v2.zip dans le panneau de gauche, puis :
!unzip -o moteur_v2.zip
!python tests/test_v2.py                                  # 27 tests, 0 ignoré attendu
!python moteur_v2/charge.py --classes 3 10 --temps 60     # petit test de charge
!python moteur_v2/charge.py --classes 30 --groupes-min 3 --groupes-max 4 --temps 300
!python moteur_v2/charge.py --classes 30 --groupes-min 6 --groupes-max 7 --temps 900   # échelle du cahier des charges
```

## Règles modélisées (d'après le planificateur)

| Règle | Traitement |
|---|---|
| Séances de 2 à 4 h, cours découpé en 2+2, 2+3, etc. | `cours.decoupage = [2, 3]` (liste des durées) |
| Pause 12h-13h | Dure : aucune séance ne la chevauche |
| Lundi-samedi, jamais le samedi après-midi | Dure |
| Journée 7h-**18h** | Dure — **18h est une hypothèse** |
| Max 8 h de cours par jour | Dure, pour chaque groupe **et** chaque enseignant — *à confirmer* |
| 6 h par jour de préférence | Souple (cs06) |
| Débuts à 7h ou 13h de préférence | Souple (cs08) |
| 1 h de route Kamboinsé ↔ Ouaga, navette 12h-13h | Dure : même site pendant toute une demi-journée. Changement à midi autorisé mais pénalisé (cs03) |
| Site principal d'une promotion | Souple (cs09), champ optionnel `classes[].site_principal` |

Toujours en place : pas de chevauchement salle/enseignant/groupe, capacité, type de salle, indisponibilités, préférences (cs01), séances d'un même cours sur des jours différents (cs04), verrouillage, explication des séances non placées.
**Pas encore** : CS-02 (trous dans la journée), CS-05 (CM avant TD/TP).

## Utilisation depuis l'API (tâche 1)

```python
from moteur_v2 import generer, placement_rapide, valider

resultat = placement_rapide(donnees)   # glouton seul : < 1 s, ne nécessite pas ortools
resultat = generer(donnees)            # glouton + OR-Tools (pip install -r requirements.txt)
violations = valider(donnees, resultat)   # [] attendu
```
`donnees` et `resultat` sont les JSON décrits ci-dessous. Le moteur ne lit pas la base : l'API construit
`donnees` à partir de Supabase et enregistre `resultat["seances"]` (semaine type : la duplication sur les
dates du semestre et les jours fériés sont à faire côté API, BF-14). Pour un calcul long, appeler `generer`
dans une tâche de fond (Celery) avec `parametres.time_limit_s`.

## Contrat d'entrée (changements par rapport à la v1)

- `calendrier` (optionnel) : jours, heure_ouverture, heure_fermeture, pause, samedi_apres_midi, duree_min, duree_max.
- `salles[].site` remplace `batiment`.
- `cours[].decoupage` remplace `nb_seances_semaine` (qui reste accepté avec `duree_seance`).
- `indisponibilites` et `preferences` : `{id_enseignant, jour, heure_debut, heure_fin}` (heures entières).
- `seances_verrouillees` : `{id_cours, index, jour, heure_debut, id_salle}`.
- `parametres` : `max_heures_jour`, `max_heures_jour_souple`, `heures_debut_preferees`, `poids`, `time_limit_s`, `num_workers`, `gap_relatif`.

## Sortie

```json
{"statut": "OPTIMAL|FEASIBLE|...", "taux_placement": 0.98,
 "seances": [{"id_cours":1,"index":0,"jour":"Lundi","heure_debut":7,"heure_fin":10,"duree":3,"id_salle":4,"id_enseignant":2}],
 "non_placees": [{"id_cours":9,"index":0,"motif":"aucune salle compatible (3× capacité insuffisante)"}],
 "taille_modele": {"variables": 0, "contraintes": 0}, "avertissements": [], "temps_s": 0.0}
```

## Promotions non divisées

Une promotion sans groupe (`groupes` vide pour sa classe) est gérée : ses cours ont `id_groupe = null`
et concernent toute la promotion. Le générateur accepte `--non-divisees 0.4` (40 % des promotions sans
groupes) ; `charge.py` l'applique par défaut (0.4). **À remplacer par les vrais chiffres** (combien de
promotions sont divisées, et en combien de groupes).

## Placement glouton + solveur (`greedy.py`)

Le modèle CP-SAT complet est trop gros pour Colab dès 10 promotions (67 % placé à 10 promotions,
aucune solution à 30 en 120 s). Le moteur calcule donc d'abord un placement **glouton** (Python pur,
moins d'une seconde même à 196 groupes, 0 violation au validateur), puis :
  1. le donne en indication de départ (`AddHint`) au solveur, qui ne peut que l'améliorer ;
  2. s'il n'a rien trouvé, ou fait moins bien, **le résultat glouton est renvoyé** (`statut` = `GLOUTON (...)`).
`parametres.utiliser_glouton = false` désactive ce mode.

**Multi-essais** : le glouton est relancé `essais_glouton` fois (12 par défaut, `budget_glouton_s` = 20 s max)
avec des ordres de placement légèrement différents ; on garde le meilleur (moins de séances non placées, puis
meilleur score). Mesuré : à 954 séances, de 3 séances non placées à 0 ; le score dépasse celui qu'OR-Tools avait
atteint en 180 s à 30 promotions.

**Garde-fou** : au-delà de `max_variables_solveur` (40 000 par défaut), OR-Tools n'est pas lancé et le glouton
est renvoyé (`statut` = `GLOUTON (trop grand pour le solveur : N variables)`). Mesuré sur Colab (2 processeurs) :
8 555 variables → solution trouvée ; 27 273 → solution trouvée, gain ≈ 0 % ; 65 089 → aucune solution en ~8 min.

*Reproductibilité* : les nombres de groupes/séances d'une graine donnée ont changé quand `ratio_non_divisees`
a été ajouté au générateur ; les anciens résultats « 106 / 196 groupes » ne sont plus reproductibles à l'identique.

Mesuré (données fictives, graine 1) : 3 promotions 98,5 % · 10 promotions 100 % · 30 promotions (106 groupes) 100 % · 30 promotions (196 groupes) 99,9 %.
La qualité sur les contraintes souples du glouton n'est pas encore mesurée.

## Indicateurs de qualité (`qualite.py`)

`evaluer(data, result)` calcule : `score` (même formule que l'objectif du solveur, plus bas = mieux,
**estimation** non vérifiée à l'identique), heures de trous par groupe (CS-02, mesurée mais pas optimisée),
% de séances touchant une préférence, changements de site à midi, séances hors site principal, jours de groupe > 6 h.
`charge.py` compare glouton et résultat final avec ces indicateurs.

Mesuré sur le glouton (graine 1) : trous ≈ 0,1 à 0,2 h par groupe et par semaine, 84 à 89 % des séances sur une préférence.
Le solveur (180 s, 2 processeurs) gagne ≈ 4 % de score à 10 promotions et ≈ 0 % à 30 promotions.

## Limites connues

- **Le solveur v2 n'a jamais terminé un gros calcul avec le vrai OR-Tools** : les tests de petite taille passent (27 tests), mais à 10 et 30 promotions il n'a pas tenu le temps imparti. Le glouton + hint est la réponse, à valider par `charge.py`.
- Le validateur (`validate.py`) est indépendant du solveur et testé : il compte les violations sans l'aide d'OR-Tools.
- Pas de jours fériés, pas de semaines spéciales, une seule semaine type.
- Les données de test sont fictives (distributions inventées).
