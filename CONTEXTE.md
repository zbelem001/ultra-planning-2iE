# CONTEXTE du projet : moteur de planification des cours (2iE)

Ce fichier résume le travail fait jusqu'ici, les choix retenus et ce qui reste à faire. À lire en premier, puis `moteur_v2/README.md`.

Instruction pour l'assistant : ne pas modifier de règle sans que le propriétaire du projet l'ait demandé, distinguer toujours le « confirmé » du « supposé », et ne jamais écrire une clé ou un mot de passe dans un fichier du dépôt.

## 1. But

Une équipe d'étudiants (Master IA, 2iE, sites de Kamboinsé et d'Ouagadougou) remplace HYPERPlanning et Pronote par un système sur mesure. Cahier des charges v1 de Daniel ILBOUDO. Technologies : base Merise (MCD, MLD) sur Supabase/PostgreSQL, API FastAPI, interface React, moteur OR-Tools.

Cinq tâches, ordre de priorité 5, 1, 2, 3, 4 :
1. API (backend)
2. Moteur OR-Tools aligné sur la structure de la base (**tâche du propriétaire de ce dépôt**)
3. Frontend avec données fictives
4. Intégration
5. Conception finale de la base sur Supabase et mise à disposition des clés

## 2. Ce que fait le moteur

Module Python autonome : JSON en entrée, JSON en sortie. Il ne lit pas la base. L'API construit le JSON depuis Supabase, appelle le moteur et enregistre les séances.

Il place les séances d'une **semaine type** (jour, heure, salle). Il ne choisit pas l'enseignant : chaque cours en a déjà un. La duplication sur les dates du semestre et les jours fériés relève de l'API.

Chaîne de traitement :
1. Préparation (`instance.py`) : horaires et salles possibles pour chaque séance.
2. Placement glouton multi-essais (`greedy.py`) : moteur principal, 12 essais, moins de 13 s même à 1 445 séances.
3. Solveur OR-Tools CP-SAT (`solver.py`) : amélioration optionnelle, part du résultat glouton (AddHint). Lancé seulement sous 40 000 variables.
4. Choix du meilleur : si le solveur ne trouve rien ou place moins de séances, on garde le glouton.
5. Validateur indépendant (`validate.py`) : recompte les règles dures sans solveur.

Fichiers : `instance.py`, `greedy.py`, `solver.py`, `validate.py`, `qualite.py` (indicateurs), `generate_data.py` (données fictives), `charge.py` (test de charge), `__init__.py` (`generer`, `placement_rapide`, `valider`). Tests : `tests/test_v2.py` (28), `tests/test_greedy.py` (10). Les 6 tests du solveur exigent `ortools`.

## 3. Règles

### Confirmées par le planificateur
- 8 h de cours par jour au maximum, 6 h de préférence.
- Programmation typique : 3 h de 7h à 10h et 3 h de 13h à 16h. Les cours commencent le plus souvent à 7h (à confirmer).
- Pause de 12h à 13h.
- Lundi au samedi, jamais de cours le samedi après-midi.
- 1 h de route entre Kamboinsé et Ouaga. Une navette circule dans les deux sens entre 12h et 13h.
- Une trentaine de promotions, toutes ne sont pas divisées en groupes.
- Séances de 2 h minimum à 4 h maximum, découpables (2+3, 2+2).

### Règles dures implémentées
- Pas de chevauchement de salle, d'enseignant, de groupe (CD-01 à 03). Un cours de promotion occupe tous ses groupes.
- Capacité de la salle au moins égale à l'effectif, type de salle exigé (CD-04, 05).
- Enseignant disponible (CD-06, sans la partie habilitation).
- Séances conformes au découpage du cours (CD-08), 2 à 4 h.
- Ouverture 7h à 18h, pause, pas de samedi après-midi.
- 8 h par jour au plus, pour chaque groupe et chaque enseignant.
- Un seul site par demi-journée (changement possible seulement à midi).
- Séances verrouillées respectées (BF-17).

### Règles souples (poids par défaut, réglables dans `parametres.poids`)
cs01 créneau préféré +10 par heure · cs08 début à 7h ou 13h +1 · cs03 changement de site à midi −8 · cs04 séances d'un même cours le même jour −5 par excès · cs06 plus de 6 h par jour −4 (groupe) et −2 (enseignant) · cs09 hors du site principal −3 · séance non placée −100 000. Ces poids sont ceux de l'équipe, pas du planificateur.

### Hypothèses non confirmées (à valider avec le planificateur)
- ~~La journée finit à 18h.~~ **Infirmée** par le livret de l'étudiant (§ 9.1) : cours de 7h à 12h et de 13h à 16h. Voir plus bas.
- Le plafond de 8 h vaut pour les groupes et les enseignants.
- Une séance commence à toute heure entière et reste entière dans une demi-journée.
- Aucune séance à cheval sur la pause.
- Le site ne change qu'à midi, grâce à la navette.
- Une promotion peut avoir un site principal (champ optionnel `classes[].site_principal`).
- Promotion non divisée : TD et TP en promotion entière.
- Le découpage (2+3, 2+2) est fourni par cours, jamais calculé.
- Une semaine type, sans jours fériés, examens, équipements de salle ni temps de pause imposé entre séances.
- Le plafond hebdomadaire d'un enseignant (`nb_heures_max_semaine`) ne donne qu'un avertissement.

### Nouveaux renseignements reçus depuis (novembre 2026)

Sources : réponses du planificateur au questionnaire (`rep_quest_pronote`), livret de l'étudiant, fichiers `Renseignements planifications.xlsx` et `Renseignements planifications1.xlsx` (promotions, groupes, salles, enseignants, occupation des salles), propriétaire du projet. **Les fichiers Excel contiennent des noms d'enseignants : ils ne vont ni dans le dépôt ni dans un chat.** Seuls des chiffres agrégés sont repris ici.

#### Confirmé
- **Horaires** (livret § 9.1) : cours de 7h à 12h et de 13h à 16h, pas de cours le samedi après-midi. Les colles de CPGE ont lieu de 16h à 19h. L'heure de fermeture de 18h de `instance.py` est donc fausse.
- **Sites** : Kamboinsé et Ouaga sont à **au moins 1 h de route** (propriétaire), 3 h aller-retour pour un étudiant selon le planificateur. La navette ne sert qu'aux étudiants résidents ; l'école n'est pas tenue de transporter les non-résidents.
- **Site de la promotion** : certaines promotions n'ont cours qu'à Kamboinsé (L1 à L3 = S1 à S5 D, EMIH-EREE S1). À Ouaga : les promotions IA (S5D IAA, S7 IAA, S9 IAA), les CPGE, certains masters (dont MSP WASH), EMEL, et d'autres. Le site des autres promotions n'est pas renseigné dans l'Excel.
- **Enseignant sur deux sites le même jour** : à éviter, avec des exceptions possibles.
- **Salles réservées** à certaines formations hors LMD : EMIH, EREE, EMEL, WASH, ANC, CPGE, SIG, CENTRALE-2iE.
- **Cours mutualisés** : un même cours peut être suivi par plusieurs filières ou promotions en même temps.
- **Groupes** : TD de 30 étudiants au plus, TP de 15 à 20 (limité par la capacité des laboratoires). Jusqu'à 7 groupes de TD par promotion. Certaines promotions ont des **options** (S9 : GC-BTP, GEAAH, GEE, avec sous-options) qui suivent une partie des cours ensemble et une partie séparément.
- **Trois types d'enseignants** : permanents, externes résidents, externes non résidents (ces derniers viennent pour une période donnée). Changer la période d'un vacataire est la tâche la plus pénible pour le planificateur.
- **Programmation à partir des cursus** (maquettes) : le planificateur part des volumes de chaque matière.
- **Règles ajoutées souvent** par le planificateur, par exemple l'ordre de passage des cours ou un nombre d'heures. Elles doivent pouvoir être saisies **sans modifier le code**.
- **Mises à jour quotidiennes** de l'emploi du temps.
- Le planificateur veut voir les **cours non programmés** et des tableaux de bord. Sa principale crainte : un outil lent et des contraintes non gérées.
- **Rôles** : le chef de département et la DEAA valident ; seul le planificateur modifie.
- **Examen d'UE** à la fin de l'enseignement de chaque UE (livret).
- **Calendrier** : semestre 1 de septembre à janvier, semestre 2 de février à juin. Un semestre de bachelor compte environ 415 h.
- **Ordre de grandeur réel** (Excel) : 31 promotions ; une soixantaine de groupes de TD, options et sous-options ; 68 salles (amphis de 140 à 252 places, salles de 20 à 80, laboratoires de 15 à 30) ; 634 enseignants listés, dont 231 avec des heures (16 210 h au total, médiane 48 h).

#### Supposé (à confirmer)
- **Pas de changement de site dans la journée pour une promotion**, avec une durée de trajet réglable (60 min par défaut). Remplace la règle « changement possible à midi grâce à la navette ».
- La règle « 3 matières par semaine » du solveur de Zakaria n'est écrite nulle part. Le moteur v3 ne l'applique pas ; il concentre les cours par un paramètre `concentration` (0,5 par défaut, 0 = étalé, 1 = par modules).
- La seconde colonne d'heures des feuilles « Prom » et « Groupe » : sens inconnu (heures déjà faites ? heures hors maquette ?).
- Type de salle : déduit du nom (AMPHI, LABO, Salle). Certaines capacités manquent dans l'Excel.
- Une option est traitée comme un sous-groupe de la promotion.
- Un CM peut aller en amphi ou dans une grande salle standard (liste de types acceptés par cours).
- Effectifs (absents de l'Excel) : 24 à 30 par groupe de TD, demi-groupes de TP.

#### Constats sur le schéma de la base (branche zakaria, v8)
- `classe.niveau` n'accepte que L1 à M2 : les CPGE, bachelors techno et la mise à niveau ne peuvent pas être saisis.
- Pas de site par promotion, pas d'options ni de groupe parent, un seul public et un seul type de salle par cours, pas de salle réservée : voir la proposition 009.
- Le rythme maximal hebdomadaire (CD-14) est vérifié par un déclencheur : le moteur v3 le traite comme une règle dure et signale les externes dont le séjour est trop court pour leur volume.

#### Constats tirés des chiffres réels (à montrer au planificateur)
- Le semestre 1 (vacances et fériés supposés) compte 94 jours ouvrés, soit **707 h de grille** par étudiant.
- Avec les heures de l'Excel, S5 D, S6 D, S5 S et TOPO SIG S6 demandent **80 à 84 %** de cette grille ; TOPO SIG S6 (813 h) la dépasse. Ces heures comprennent-elles des examens, projets ou stages ?
- Avec des séances de 2 h seulement, une journée 7h-12h / 13h-16h n'offre que 6 h utilisables (34 h par semaine sur 45). Les séances de 3 h (7h-10h, 13h-16h) sont donc importantes pour la capacité.

#### Conséquences pour le moteur
- Le moteur doit produire des **séances datées sur le semestre**, pas une semaine type (même choix que Zakaria, tableau des décisions de `fichier.md`).
- Nouvelles règles dures : site imposé par promotion, pas de changement de site dans la journée, salles réservées, cours mutualisés, options, périodes des externes.
- Toutes les valeurs qui peuvent changer (horaires, trajet, plafonds, poids, ordre des cours) sont des **données** (table des contraintes ou des paramètres), pas du code.

#### Encore attendu
1. Un emploi du temps réel exporté de Pronote, même pour une promotion (référence de comparaison).
2. Les cursus : matières et volumes CM / TD / TP par promotion, avec l'enseignant.
3. Le calendrier du semestre : dates, vacances, jours fériés, examens.
4. La liste des règles du planificateur (ordre de passage, plafonds…).
5. Les périodes de présence des externes.
6. La liste des cours mutualisés.
7. Le site des promotions non renseignées.

## 4. Décisions d'architecture et leurs raisons

- **Glouton comme moteur principal, OR-Tools en option.** OR-Tools seul n'a pas passé à l'échelle sur nos mesures (Colab, 2 processeurs) : solution trouvée à 7 758 et 27 273 variables, aucune solution à 65 089 variables après environ 8 min, ni à 124 209 après 910 s. Avant le glouton, le modèle ne tenait pas à 10 promotions (66,67 % placées). Le gain du solveur sur le glouton est faible : environ 4 % de score à 10 promotions, presque nul à 30.
- **Garde-fou à 40 000 variables** (`max_variables_solveur`) : au-delà, le solveur n'est pas lancé, statut « GLOUTON (trop grand pour le solveur) ».
- **Validateur séparé** : détecte une erreur du glouton comme du solveur. Il vérifie notre lecture des règles, pas la réalité.
- **Semaine type** : les dates et fériés sont à la charge de l'API (BF-14).
- **La v1 (`engine/`) est abandonnée** (une séance = un créneau, un seul site). Ne pas la pousser.
- **Un cours est placé, jamais une matière.** `matiere` = la discipline, `cours` = une offre concrète (type CM/TD/TP, classe, enseignant, durée).

### Proposition de nouveau moteur (novembre 2026, à valider avec l'équipe)

Comparaison faite avec le solveur de Zakaria (branche `zakaria`, `solver/ultraplanning_solver`) : il lit PostgreSQL, produit des séances datées en deux étages (répartition des heures par semaine, puis placement de chaque semaine avec CP-SAT), gère la replanification minimale et les contraintes ajoutées (imposer, interdire). Il n'a été testé que sur 13 cours (414 h). Ni lui ni ce moteur ne gèrent le site imposé par promotion, les options, les cours mutualisés, les salles réservées ni l'ordre de passage des cours.

Proposition qui reprend le meilleur des deux :
1. Séances datées et répartition hebdomadaire (Zakaria).
2. Découpage par site : Kamboinsé et Ouaga résolus séparément, reliés par les enseignants communs.
3. Placement de chaque semaine par le glouton multi-essais (ce dépôt), puis CP-SAT sur de petits sous-problèmes (un jour, un département) en partant du glouton.
4. Règles stockées comme données : imposer, interdire, « A avant B », plafonds, site imposé, salle réservée.
5. Options, cours mutualisés, sous-groupes de TP.
6. Replanification qui déplace le moins de séances possible (Zakaria).
7. Validateur indépendant et raison de chaque cours non programmé (les deux).

Les changements de schéma qu'elle implique se décident avec le responsable de la base et Zakaria avant de toucher à son code.

### Structure du dépôt
Les fichiers ont été poussés à plat à la racine, alors que le code attend `moteur_v2/` et `tests/` (`from .solver import solve`, `sys.path` des tests). En l'état, le dépôt ne s'exécute pas. À corriger.

## 5. Résultats mesurés (données fictives)

### Moteur v3, novembre 2026 (PC local, 8 processeurs)
Instance calée sur 2iE : 31 promotions, 101 groupes, 614 cours (9 mutualisés), 276 enseignants, 68 salles, 16 semaines, 19 008 h.
- Glouton, 8 essais en parallèle : 98,0 % des heures en 11 s, 0 violation (machine libre).
- Avec amélioration CP-SAT (90 s) : jusqu'à 98,5 %, 0 violation, temps de trajet compris.
- Dernière mesure, avec rythme hebdomadaire (CD-14) en règle dure et groupes croisés : **98,1 %, 0 violation**. Qualité : 0,19 h de trou par étudiant et par semaine, 14 jours-enseignant sur deux sites. Temps non représentatif (machine saturée par d'autres applications) : environ 6,4 s de processeur par essai.
- Le non programmé restant se concentre sur les promotions chargées à plus de 80 % de la grille ; chaque cours incomplet a sa raison.

Comparaison sur les mêmes données (script de comparaison hors dépôt, qui convertit l'instance au format de Zakaria) :
- 3 promotions d'Ouaga (768 h, 5 cours mutualisés) : v3 100 % en 0,2 s, 0 violation ; Zakaria 96,5 % en 60 s, 0 violation pour son validateur, 64 pour les règles 2iE (surtout les cours mutualisés, que son modèle ne représente pas).
- S1 à S4 (5 200 h, sans mutualisation, groupes de TD et demi-groupes de TP) : v3 99,2 % en 1,9 s, 0 violation ; Zakaria 30,9 % en 879 s avec sa règle CD-13 (3 matières par semaine), 20,2 % en 904 s sans elle, 0 violation pour son validateur, 87 à 117 pour les règles 2iE (toutes des salles sur l'autre site : son modèle n'a pas de site par promotion). Cause probable du faible taux : à cette taille, le placement CP-SAT de chaque semaine n'aboutit pas dans ses 10 s, et la boucle de reprise réduit alors le plan. Non vérifié dans le détail.
- Réserve : la conversion vers son format interdit un demi-groupe de TP en même temps qu'un autre groupe de TD (plus strict que nécessaire), et ses matières sont mes matières fictives.
- Le validateur v3 a trouvé, dans un résultat v3 antérieur, 5 séances où un enseignant changeait de site sans temps de trajet. Règle ajoutée depuis : écart minimal `trajet_min` entre deux séances d'un enseignant sur deux sites le même jour (placement, CP-SAT, validateur).

### Moteur v2 (semaine type)
Relancé en local en novembre 2026 : 32 promotions fictives (78 groupes, 731 séances), 100 % en 7 s, 0 violation, solveur sauté (42 263 variables). Attention : ancienne grille 7h-18h et une semaine type seulement.


Glouton multi-essais, 0 violation au validateur : 10 promotions 214 séances 100 % en 0,4 s ; 30 promotions 564 séances 100 % en 2,3 s ; 954 séances (109 groupes) 100 % en 5,6 s ; 1 445 séances (196 groupes) 99,9 % (1 non placée) en 12,7 s. Qualité : 0,1 à 0,2 h de trou par groupe et par semaine, 84 à 89 % des séances sur une préférence. Le score est une estimation de la formule du solveur.

Les résultats du solveur viennent d'exécutions sur Colab, pas de l'environnement de développement.

## 6. Ce qui dépend des autres

Le responsable de la base (tâche 5) doit appliquer : `cours.id_groupe` (nullable) et correction du déclencheur capacité ; durées en heures et grille horaire plus fine avec contrainte d'exclusion ; `COURS_SEANCE_MODELE` (découpage) ; disponibilités à trois niveaux (indisponible, possible, préféré) ; table `JOUR_FERIE` ; données de test ; clé `service_role` uniquement par variable d'environnement.

L'API (tâche 1) doit : construire le JSON depuis Supabase, appeler `placement_rapide` ou `generer` (tâche de fond pour les calculs longs), enregistrer `seances`, dupliquer la semaine sur le semestre et les fériés.

## 7. Reste à faire

Plan de travail de novembre 2026, étape par étape :
- [x] Étape 1 : mettre à jour ce fichier avec les nouveaux renseignements.
- [x] Étape 2 : générateur calé sur le profil réel : `moteur/profil_2ie.py` (chiffres agrégés, aucun nom) et `moteur/generateur.py` (format v3). `moteur_v2/generate_data.py` est conservé tel quel.
- [x] Étape 3 : moteur v3 dans `moteur/` (voir `moteur/README.md`) : génération, amélioration CP-SAT, replanification minimale (`replanif.py` : séances verrouillées, périmètre, période, absences datées, règles avec période de validité). 20 tests dans `tests/test_moteur.py`. Fichiers déplacés dans `moteur_v2/` et `tests/` : les 38 tests de la v2 repassent, y compris les 6 du solveur (OR-Tools 9.15, en local).
- [x] Lien avec la base : `moteur/base.py` (réutilise le chargeur de Zakaria, n'écrit que les différences), testé sans base avec les données de ses tests et ses propres vérifications (`tests/test_base.py`). Proposition de migration `propositions/009_moteur_v3.sql` **non appliquée et non testée** (Docker non lancé), à valider avec le responsable de la base et Zakaria, ainsi que les changements de ses déclencheurs CD-03, CD-04 et CD-05 listés en tête du fichier.
- [ ] Étape 4 : test de charge à l'échelle réelle, comparaison avec ce moteur et celui de Zakaria (en cours, voir section 5).

Reste à faire (liste d'origine), par ordre d'utilité :
1. **Tester sur un vrai emploi du temps** fourni par le planificateur et comparer avec son résultat. C'est la preuve la plus importante.
2. Faire confirmer les hypothèses de la section 3.
3. Écrire le chargeur base vers JSON (`load_from_db.py`).
4. Relancer les 38 tests avec `ortools` installé (les 6 tests du solveur).
5. Brancher le moteur sur l'API.

## 8. Améliorations possibles

- Optimiser CS-02 (trous dans la journée), aujourd'hui seulement mesurée.
- Ajouter CS-05 (cours magistral avant TD et TP).
- Découper le problème (décomposition ou recherche locale) pour que OR-Tools reste utile à grande échelle.
- Réparer la dernière séance non placée à 196 groupes.
- Expliquer l'arrêt anticipé du solveur vers 497 s alors que la limite était de 600 s.
- Vérifier que le score de `qualite.py` coïncide exactement avec l'objectif du solveur.
- Gérer examens, semaines multiples, équipements de salle, priorité des cours.

## 9. Sécurité et git

- Ne jamais mettre dans le dépôt, dans un notebook partagé ou dans un chat : la clé Supabase `service_role`, les clés d'API, un fichier `.env`.
- Passer les clés au moteur par variable d'environnement.
- Ne pas commiter : `*.zip`, `data/*.json`, `charge_resultats.json`.
- Pousser sur la branche personnelle du propriétaire, pas sur `main`.
- Ne pas contourner un blocage réseau ; le dire clairement.

## 10. Commandes utiles

```
pip install -r requirements.txt
python tests/test_v2.py
python tests/test_greedy.py
python moteur_v2/charge.py --classes 3 10 --temps 60
python moteur_v2/charge.py --classes 30 --groupes-min 3 --groupes-max 4 --temps 300
```
