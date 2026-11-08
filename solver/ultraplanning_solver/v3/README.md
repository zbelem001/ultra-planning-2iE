# Moteur v3 : séances datées sur le semestre

Moteur de **Soraya Pitroipa** (branche `Soraya`, dossier `moteur/`), intégré au solveur d'UltraPlanning. C'est le moteur par défaut de `generer()` depuis le schéma version 11 ; l'ancien moteur CP-SAT à deux étages reste disponible (`Demande(moteur="cpsat")`, `--moteur cpsat`) pour comparer. Son fonctionnement est décrit dans [`../../fichier.md`](../../fichier.md).

Le moteur garde son format d'entrée JSON autonome (ci-dessous). L'API, l'assistant et la ligne de commande ne l'appellent pas directement : ils passent par `ultraplanning_solver.generer(donnees, demande)`, et l'adaptateur [`../v3_adaptateur.py`](../v3_adaptateur.py) traduit nos `Donnees` et notre `Demande` dans ce format, puis reconstruit notre `Resultat`.

## Chaîne de traitement

1. **Préparation** (`instance.py`) : jours ouverts du semestre (fériés et congés retirés), arbre des groupes, salles possibles de chaque cours (campus mère de la promotion, sinon de sa filière ; cours mutualisé entre deux campus : celui de la classe du cours ; types acceptés, capacité, réservation). Une promotion n'a cours que sur un campus par jour (`Etat.classe_site`, et une contrainte du modèle CP-SAT), présence des enseignants.
2. **Placement chronologique** (`planif.py`), semaine après semaine. Chaque cours demande « reste ÷ semaines encore utilisables par son enseignant », au moins `concentration` × son rythme maximal. Les externes de passage sont servis d'abord. Une séance non placée reste due la semaine suivante. Une passe de rattrapage finale remet les heures restantes là où il reste de la place. Plusieurs essais tournent en parallèle et on garde le meilleur.
3. **Amélioration CP-SAT** (`ameliore.py`). Pour chaque promotion incomplète, une semaine à la fois, ses séances sont libérées puis replacées par CP-SAT avec les heures manquantes en plus. Les heures d'un cours sont **redécoupées librement** en séances de 2 à 4 h (2 h + 2 h peuvent devenir 2 h + 3 h) ; les heures libérées doivent être retrouvées, donc le résultat ne régresse jamais.
4. **Validation indépendante** (`valide.py`) : elle recompte toutes les règles dures à partir des données brutes, sans réutiliser le code du placement.
5. **Qualité** (`qualite.py`) : trous, enseignant sur deux sites, préférences, samedi, étalement.

**Replanification** (`replanif.py`) : chaque séance du périmètre est revérifiée à sa place avec les données du jour ; si elle est encore valide, elle reste ; si seule sa salle ne va plus, on change de salle ; sinon elle est replacée, la même semaine d'abord. Dans UltraPlanning, les heures qu'aucune place n'accueille telles quelles passent ensuite par l'amélioration CP-SAT (plafonnée à ces heures, avec un bonus aux séances qui ne bougent pas).

## Ajouts d'UltraPlanning au moteur de Soraya

| Ajout | Où |
|---|---|
| **CD-13** : au plus N matières par promotion et par semaine (`parametres.max_matieres_semaine`), dans le choix des cours de la semaine, le placement, l'amélioration CP-SAT et le validateur. Avec CD-13, la concentration par défaut passe à 1 (enseignement par modules). | `instance.py`, `planif.py`, `ameliore.py`, `valide.py` |
| **Enseignant par séance** : un cours peut n'avoir aucun enseignant prévu (`id_enseignant` null : aucune contrainte d'enseignant) ; une séance figée compte pour son propre enseignant (remplaçant) ; chaque séance produite porte `id_enseignant`. | `planif.py` (`Etat.poser(ens=…)`), `replanif.py`, `valide.py` |
| **Séances de 2 à 4 h** (CD-10 de la base) : jamais de séance d'1 h ; une heure isolée allonge une séance, sinon elle reste due. | `instance.py` (`heures_par_semaine`, `sans_heure_isolee`) |
| **Site de promotion facultatif** : sans site fixé, le site est celui de la salle choisie (trajet et « deux sites » calculés salle par salle). | `instance.py`, `planif.py`, `ameliore.py` |
| **Règles horaires** « interdire » et « imposer » (fenêtre de jours, d'heures et de dates) : nos contraintes ajoutées (assistant, replanification). | `instance.py` (`hors_regles`) |
| **Séances figées, période et horizon** : génération d'une partie du semestre sans toucher au reste ; période courte avec report. | `planif.py` (`essais_paralleles`), `ameliore.py` (`semaines`, `cours_ok`) |
| **Priorité des cours** (CS-07). | `instance.py`, `planif.py` |
| **Examens et rattrapages** : hors volumes et jamais déplacés ; leurs classes sont prises (règles « interdire ») et leurs salles aussi (`salles_bloquees`). L'ancien moteur CP-SAT ne les connaît pas. | `v3_adaptateur.py`, `instance.py`, `planif.py`, `valide.py` |
| **Essais en parallèle sûrs dans l'API** (plusieurs fils) : processus lancés par `forkserver`, essais en série si les processus sont impossibles. | `planif.py` |

## Correspondance avec la demande d'UltraPlanning (`v3_adaptateur.py`)

| `Demande` | Moteur v3 |
|---|---|
| périmètre, période (`du`, `au`) | cours à programmer ; dates où placer (`placer_du`, `placer_au`) |
| séances hors périmètre, hors période, verrouillées ; `completer` | séances figées, posées d'abord |
| `horizon` au-delà de la période (génération courte) | reste réparti jusqu'à l'horizon, sans rattrapage ; ce qui tient dans les semaines suivantes au rythme maximal est **reporté**, le reste est signalé |
| `minimiser_changements` | replanification (revérifier, puis replacer l'impossible) |
| `ramener_depuis` | avec `minimiser_changements` : les séances à partir de cette date, hors de la période, y sont ramenées ; sans place, elles restent où elles sont |
| `contraintes` (imposer, interdire) | règles horaires |
| CS-01, CS-02, CS-03, CS-05, CS-06, CS-07 | poids et règles du moteur (une CS désactivée met son poids à zéro) |
| `essais`, `processus`, `temps_amelioration`, `concentration` | réglages du moteur |

## Données propres au moteur v3 (schéma version 11)

Lues par `ultraplanning_solver.base.charger` quand elles existent :

| Donnée | Table ou colonne |
|---|---|
| Site où une promotion a tous ses cours | `classe.id_site` |
| Options et sous-groupes (arbre de groupes) | `groupe.type_groupe = 'OPTION'`, `groupe.id_groupe_parent` |
| Cours mutualisés (plusieurs publics) | `cours_public` |
| Types de salle acceptés en plus du type exigé | `cours_type_salle` |
| Salles réservées à certaines formations | `salle_reservation` |
| Temps de trajet entre sites | `site_trajet` |
| Règles du planificateur | `contrainte.parametres`, `date_debut`, `date_fin` |

**Groupes.** Chaque promotion est un arbre : promotion, groupes de TD ou options, demi-groupes de TP ou sous-options. Deux publics de la même promotion sont en conflit si l'un contient l'autre, ou s'ils sont dans deux branches de types différents. Deux frères du même type (TD1 et TD2, deux options) peuvent avoir cours en même temps. La base applique la même règle (`publics_en_conflit`).

## Règles du planificateur

Une règle est une ligne de données (`contrainte` avec `parametres`, page Génération > Règles du planificateur). En ajouter une ne demande aucun changement de code.

| `type` | Paramètres | Effet |
|---|---|---|
| `interdire` | `cible` (`id_classe`, `id_enseignant` ou `id_cours`), `jours`, `demi` (0 matin, 1 après-midi), période `du`–`au` | aucune séance de la cible dans cette fenêtre |
| `interdire`, `imposer` | en plus : `heure_min`, `heure_max` (minutes) | fenêtre à l'heure près (contraintes ajoutées par l'assistant) |
| `precede` | `matiere_avant`, `matiere_apres` | la seconde matière ne commence qu'après la fin de la première |
| `plafond_jour` | `heures` ; `dure` | dure : plafond strict ; souple : pénalité au-delà |
| `cm_avant_td` | `poids` | le CM d'une matière commence avant ses TD (souple) |
| `enseignant_site_unique_jour` | `dure` | interdit (au lieu de pénaliser) un enseignant sur deux sites le même jour |

Un type inconnu est ignoré et signalé dans `statistiques.avertissements`.

## Format d'entrée v3 (JSON autonome)

| Clé | Contenu |
|---|---|
| `calendrier` | `debut`, `fin`, `jours_feries`, `conges` (`[[du, au]]`), `plages` par jour (`{"Lundi": [[7,12],[13,16]], "Samedi": [[7,12]]}`) |
| `sites`, `trajet_min` | sites et durée du trajet entre eux (`{"1-2": 60}`) |
| `salles` | `id_salle`, `id_site`, `id_type_salle`, `capacite`, `est_disponible`, `reservee_a` |
| `classes` | promotions : `id_classe`, `id_site` (ou null), `effectif` |
| `groupes` | `id_groupe`, `id_classe`, `parent`, `type_groupe` (TD, TP, OPTION), `effectif` |
| `cours` | `publics` (`[{id_classe, id_groupe}]`, plusieurs = cours mutualisé), `id_enseignant` (ou null), `types_salle`, `volume`, `durees`, `h_sem_min`, `h_sem_max`, `priorite` |
| `enseignants` | `statut`, `nb_heures_max_semaine`, `sejours`, `absences`, `indisponibilites` et `preferences` (`{jour, demi}` ou `{jour, heure_debut, heure_fin}`) |
| `seances_existantes` | replanification : `id_cours`, `date`, `heure_debut`, `heure_fin`, `id_salle`, `est_verrouillee`, `id_enseignant` |
| `regles` | règles du planificateur |
| `parametres` | `essais`, `plafond_jour_dur`, `poids`, `max_matieres_semaine`, `placer_du`, `placer_au` |

```bash
python -m ultraplanning_solver.v3.generateur --out instance_2ie.json      # données fictives calées sur 2iE
python -m ultraplanning_solver.v3 instance_2ie.json --amelioration 0       # glouton seul
```

## Mesures

Instance fictive calée sur 2iE (`generateur.py`, chiffres agrégés de `profil_2ie.py`), PC à 8 processeurs, validateur v3 : 0 violation partout.

| Cas | Ancien moteur CP-SAT | Moteur v3 |
|---|---|---|
| Tout 2iE : 31 promotions, 614 cours, 19 008 h (moteur de Soraya seul, sans CD-13) | non tenté | 98,1 % en 2,7 s |
| S1 à S4 : 154 cours, 5 200 h, sans CD-13 | 59 % en 20 min | 100 % en 35 s |
| S1 à S4, avec CD-13 (3 matières par semaine) | 65 % en 20 min | 82 % en 36 s |
| 3 promotions IA d'Ouaga, 923 h, avec CD-13 | 99 % en 26 s | 98,6 % en 7,5 s |
| Jeu de test de la base, classe M1IA (ligne de commande) | ≈ 25 s | 100 % en 1,8 s |

Avec CD-13, le manque restant vient de la règle elle-même sur ces données fictives : certaines promotions ont trop de matières pour les finir dans le semestre à 3 par semaine.

## Limites connues

- Données de calibrage fictives : effectifs, découpage en matières et enseignants inventés (`generateur.py`) ; seuls les chiffres de `profil_2ie.py` sont réels.
- L'arbre des groupes suppose qu'une promotion n'a pas à la fois des groupes de TD et des options indépendants.
- CD-07 (programme) ne porte que sur le public principal d'un cours mutualisé.
- Le temps de trajet entre sites est respecté par le moteur, pas vérifié par la base.
