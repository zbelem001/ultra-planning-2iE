# Fonctionnement détaillé du solveur

Ce document explique comment le solveur d'UltraPlanning construit un emploi du temps : ce qu'il reçoit, comment il découpe le problème, quels modèles CP-SAT il résout, comment il explique ce qu'il n'a pas pu placer, et où se trouvent ses limites. Pour l'installation et les commandes, voir `README.md`.

## Sommaire

1. [Rôle du solveur](#1-rôle-du-solveur)
2. [Vue d'ensemble](#2-vue-densemble)
3. [Pourquoi deux étages](#3-pourquoi-deux-étages)
4. [Les données d'entrée](#4-les-données-dentrée)
5. [La demande](#5-la-demande)
6. [Préparation : séances figées et besoins](#6-préparation--séances-figées-et-besoins)
7. [Étage 1 : le plan des semaines](#7-étage-1--le-plan-des-semaines)
8. [Étage 2 : le placement d'une semaine](#8-étage-2--le-placement-dune-semaine)
9. [La boucle entre les deux étages](#9-la-boucle-entre-les-deux-étages)
10. [Le résultat](#10-le-résultat)
11. [Lecture et écriture dans la base](#11-lecture-et-écriture-dans-la-base)
12. [Où chaque règle est appliquée](#12-où-chaque-règle-est-appliquée)
13. [Exemple réel : la L2INFO](#13-exemple-réel--la-l2info)
14. [Performances](#14-performances)
15. [Limites et approximations](#15-limites-et-approximations)
16. [Tests](#16-tests)

---

## 1. Rôle du solveur

Le solveur calcule des **séances datées** (cours, date, heure de début, heure de fin, salle) qui respectent toutes les règles dures de l'école (CD-01 à CD-14, `../fichier.md` §4.1). Il optimise aussi les bonnes pratiques (CS-01 à CS-07, §4.2).

Il sert trois usages :

| Usage | Qui l'appelle | Réglage de la demande |
|---|---|---|
| **Génération** d'un semestre, d'une filière, d'une classe | Page Génération (API `/api/generations`), ligne de commande | `minimiser_changements = False` |
| **Génération courte** (une ou deux semaines) | Assistant IA (`proposer_generation`), page Génération | période courte ; le reste du volume est **reporté** |
| **Replanification minimale** (« pas de cours le mardi 13 ») | Assistant IA (`proposer_replanification`) | `minimiser_changements = True`, contraintes ajoutées |

Le solveur ne parle pas à l'utilisateur et n'écrit rien de lui-même. Il renvoie un `Resultat`, et c'est l'appelant qui décide :
- la page Génération l'applique ;
- l'assistant en fait une proposition à valider ;
- la ligne de commande l'écrit seulement avec `--ecrire`.

Il travaille en **heures entières** : créneaux de 1 h, séances de 2 à 4 h.

---

## 2. Vue d'ensemble

```
            base PostgreSQL / Supabase
                       │  base.charger()
                       ▼
                 ┌───────────┐        ┌──────────────────────────────┐
                 │  Donnees  │        │ Demande                      │
                 │ référentiel│        │ périmètre, période, horizon, │
                 │ + séances  │        │ contraintes ajoutées, mode   │
                 └─────┬─────┘        └──────────────┬───────────────┘
                       └──────────────┬──────────────┘
                                      ▼  moteur.generer()
            ┌─────────────────────────────────────────────────────────┐
            │ Préparation : séances figées / à remplacer, besoins      │
            └───────────────────────────┬─────────────────────────────┘
                                        ▼
            ┌─────────────────────────────────────────────────────────┐
            │ ÉTAGE 1  semaines.planifier_semaines()     (CP-SAT)      │
            │ combien d'heures de chaque cours, chaque semaine ?       │
            │ volume, rythme, 3 matières / semaine, capacités agrégées │
            └───────────────────────────┬─────────────────────────────┘
                                        ▼   heures par (cours, semaine)
            ┌─────────────────────────────────────────────────────────┐
            │ ÉTAGE 2  placement.placer_semaine()   une fois par       │
            │ semaine (CP-SAT) : jour, créneau et salle de chaque      │
            │ séance ; salles, enseignants, classes sans conflit       │
            └───────────────────────────┬─────────────────────────────┘
                                        │
                 une semaine n'a pas tout placé ?
                    oui : plafond pour ce cours cette semaine,
                          retour à l'étage 1 (8 tours au plus)
                    non : ▼
                 ┌──────────────────────────────────────────┐
                 │ Resultat : séances, non placées (motif), │
                 │ reportées, statistiques, modifications   │
                 └──────────────────────────────────────────┘
                       │  base.enregistrer()  ou  proposition de l'assistant
                       ▼
            déclencheur verifier_seance : chaque séance est revérifiée
```

| Fichier | Contenu |
|---|---|
| `donnees.py` | Classes de données (une par table) et calculs dérivés : jour fermé, enseignant présent, débuts possibles |
| `demande.py` | `Perimetre`, `ContrainteAjoutee`, `Demande`, `NonPlace`, `Resultat` (et `modifications()`) |
| `moteur.py` | `generer()` : préparation, enchaînement des deux étages, boucle, bilan |
| `semaines.py` | Étage 1 (modèle CP-SAT du plan des semaines) |
| `placement.py` | Étage 2 (découpage en séances, candidats, modèle CP-SAT d'une semaine) |
| `base.py` | `charger()`, `enregistrer()`, `verifier()` (PostgreSQL) |
| `__main__.py` | Ligne de commande |

---

## 3. Pourquoi deux étages

Un modèle unique décrirait chaque séance possible, à chaque date du semestre, à chaque créneau et dans chaque salle compatible. Pour 13 cours, 19 semaines, 6 jours, une dizaine de débuts par jour et 5 salles, cela fait déjà des centaines de milliers de variables booléennes. Les règles qui portent sur la semaine (3 matières, rythme, plafond de l'enseignant) relieraient en plus toutes ces variables entre elles. Le temps de calcul exploserait dès que l'école grandit.

Le problème se décompose naturellement :

- **Étage 1 (macro)** : pour chaque cours et chaque semaine, *combien d'heures* ? Variables entières par (cours, semaine), quelques centaines au total. C'est ici que vivent les règles de l'**enseignement par modules** : volume, rythme, 3 matières par semaine, statut de l'enseignant.
- **Étage 2 (micro)** : pour une semaine dont les heures sont connues, *où et quand* ? Un petit modèle par semaine, résolu indépendamment des autres. C'est ici que vivent les conflits de salle, d'enseignant et de classe.

Le prix de la décomposition : l'étage 1 raisonne sur des **capacités agrégées** (heures ouvertes de l'enseignant, de la classe, des salles) et peut demander une semaine que l'étage 2 n'arrive pas à placer, par exemple parce que les séances de 3 h ne s'emboîtent pas entre les pauses. Deux mécanismes compensent :
- des **marges** : l'étage 1 ne remplit que 85 % des heures ouvertes d'une classe et 90 % de celles d'un enseignant ;
- une **boucle de rétroaction** (§9).

---

## 4. Les données d'entrée

`base.charger(conn, id_edt)` lit tout ce qui concerne l'emploi du temps et son semestre, et construit un objet `Donnees`. Les classes de `donnees.py` reprennent les tables de `../migrations/schema_supabase.sql` avec les mêmes noms de colonnes.

| Donnée | Source | Usage |
|---|---|---|
| Semestre (début, fin) | `semestre` | Bornes de la période (CD-09) |
| Classes, groupes | `classe`, `groupe` | Effectifs (CD-04), parallélisme des groupes (CD-03) |
| Enseignants | `enseignant` | Statut (CS-04), plafond hebdomadaire |
| Salles | `salle` | Capacité, type, site, disponibilité (CD-04, CD-05, CD-12, CS-03) |
| Grille | `creneau`, `pause` | Débuts et fins alignés (CD-10), pause (CD-11) |
| Jours fermés | `jour_ferie`, `conge` | CD-09 ; un congé peut viser une seule classe |
| Cours | `cours` du semestre | Volume, rythme min / max, priorité, type de salle |
| Durées préférées | `cours_seance_modele` | Découpage en séances ; sinon `duree_seance` |
| Disponibilités | `disponibilite` | `indisponible` (CD-06), `preference` (CS-01) |
| Absences, séjours | `absence_enseignant`, `sejour_enseignant` | CD-06 ; un externe n'enseigne que pendant ses séjours |
| Séances existantes | `seance` non annulées de l'emploi du temps | Séances figées ou à remplacer |
| Contraintes | `contrainte` de l'emploi du temps | Poids des CS actives, N de CD-13, plafond de CS-06 |

Conversions :
- Les volumes sont arrondis à l'heure supérieure, les rythmes à l'heure inférieure.
- Une durée de séance non entière (2,5 h) est refusée avec un message clair.
- Sans aucune contrainte saisie, les poids par défaut s'appliquent : CS-01 = 8, CS-02 = 5, CS-03 = 5, CS-04 = 5, CS-05 = 2, CS-06 = 2, CS-07 = 5.
- Si CD-13 est désactivée, `max_matieres_semaine = None`.

Trois calculs dérivés servent partout :

- `jour_ferme(date, classe)` : hors semestre, jour férié, ou congé de l'établissement ou de la classe.
- `enseignant_present(enseignant, date)` : pas d'absence ce jour-là et, pour un externe, dans un de ses séjours.
- `debuts_possibles(jour, durée)` : créneaux où une séance de *durée* heures peut commencer. Il faut une suite de créneaux contigus dont la fin tombe exactement sur une fin de créneau (CD-10), sans toucher une pause (CD-11). Avec la grille 7h–12h / 13h–16h, une séance de 3 h peut commencer à 7h, 8h, 9h ou 13h, mais pas à 10h (elle finirait à 13h en traversant la pause).

---

## 5. La demande

```python
Demande(
    perimetre=Perimetre(id_filieres=…, id_classes=…, id_cours=…),  # vide = tout l'établissement
    du=…, au=…,                    # période (défaut : le semestre)
    contraintes=[ContrainteAjoutee(…)],
    garder_verrouillees=True,      # BF-17 : les séances verrouillées ne bougent pas
    minimiser_changements=False,   # True = replanification minimale
    horizon=None,                  # génération courte : planifier le rythme jusqu'à cette date
    temps_max_semaines=20.0,       # secondes, étage 1
    temps_max_placement=10.0,      # secondes par semaine, étage 2
    iterations_max=8,
    marge_classe=0.85, marge_enseignant=0.9,
)
```

**Périmètre.** Un cours est dans le périmètre s'il figure dans `id_cours`, si sa classe figure dans `id_classes`, ou si sa filière figure dans `id_filieres`. Un périmètre vide prend tout l'établissement. Tout ce qui est hors périmètre reste **figé** et compte comme occupé : une classe peut être générée sans toucher les autres.

**Contraintes ajoutées.** Elles traduisent une demande ponctuelle (souvent formulée en langage naturel à l'assistant) :

- `imposer` : les séances des cours ciblés doivent tenir **entièrement** dans la fenêtre ;
- `interdire` : aucune séance ciblée ne doit **toucher** la fenêtre.

La cible combine un cours, une classe et un enseignant (chaque critère est facultatif). La fenêtre combine des jours, une plage horaire et une plage de dates. Exemple : `interdire` pour la classe L2INFO, `jours=("Mardi",)`, du 13 au 13 octobre, ce qui donne « pas de cours pour la L2INFO le mardi 13 ».

Ces contraintes sont **dures** : elles filtrent les placements possibles aux deux étages.

---

## 6. Préparation : séances figées et besoins

`moteur.generer()` commence par trier les séances existantes de l'emploi du temps :

- **à remplacer** : cours du périmètre, date dans la période, et pas verrouillée (si `garder_verrouillees`) ;
- **figées** : toutes les autres. Elles ne bougent pas et occupent salles, enseignants et classes.

Puis il calcule, pour chaque cours du périmètre :

```
déjà fait  = heures des séances figées du cours
restant    = volume_horaire − déjà fait
```

et le **besoin** que les étages devront couvrir :

| Mode | Besoin du cours | Sens |
|---|---|---|
| Génération | `restant` | Compléter le programme jusqu'à épuisement du volume |
| Replanification minimale | `min(restant, heures déjà prévues dans la période)` | Déplacer les heures existantes, sans en ajouter |

Sans cette distinction, replanifier un mardi ferait déborder tout le reste du volume sur la semaine. C'est un bug réel corrigé pendant le projet.

**Génération courte (horizon).** Si la période s'arrête avant la fin du semestre (une ou deux semaines), l'étage 1 planifie quand même **jusqu'à l'horizon** (fin du semestre par défaut). Chaque cours garde ainsi son rythme, ses priorités et le plafond de 3 matières sur tout le semestre. Seules les semaines de la période sont ensuite placées par l'étage 2 ; les heures que le plan met plus tard sont **reportées**, pas perdues. Sans cela, une semaine isolée recevrait tout le volume restant, jusqu'à 15 h par cours.

---

## 7. Étage 1 : le plan des semaines

`semaines.planifier_semaines()` construit et résout un modèle CP-SAT.

### 7.1 Variables

Pour chaque cours *k* du périmètre (de besoin positif) et chaque semaine *w* :

| Variable | Domaine | Sens |
|---|---|---|
| `h[k,w]` | entier, 0 … borne | Heures du cours *k* la semaine *w* |
| `a[k,w]` | booléen | Le cours a lieu la semaine *w* |
| `fin[k,w]` | booléen | Semaine « de fin », autorisée sous le minimum hebdomadaire |
| `manque[k]` | entier, 0 … besoin | Heures impossibles à programmer |

La borne de `h[k,w]` est le minimum de :
- `heures_semaine_max` du cours (CD-14) ;
- les **heures ouvertes du cours** cette semaine : créneaux des jours ouverts pour sa classe, où l'enseignant est présent, n'est pas indisponible, et que les contraintes ajoutées autorisent ;
- un éventuel **plafond** posé par la boucle (§9).

### 7.2 Contraintes

**Volume (CD-08).**
```
Σ_w h[k,w] + manque[k] = besoin[k]
```
Le manque est permis, mais coûte très cher (§7.3). Il est ensuite signalé comme heure non placée (BF-18). Le modèle reste ainsi toujours réalisable, et le solveur dit *pourquoi* il manque des heures au lieu de répondre « impossible ».

**Rythme (CD-14).**
```
a[k,w] = 0  ⇒  h[k,w] = 0
a[k,w] = 1  ⇒  h[k,w] ≥ 2                    (une séance dure au moins 2 h)
a[k,w] = 1 et fin[k,w] = 0  ⇒  h[k,w] ≥ min(heures_semaine_min, besoin)
Σ_w fin[k,w] ≤ 1                             (une seule semaine de reliquat)
```
Le reliquat permet de finir un cours de 24 h avec un rythme minimal de 5 h : 5 + 5 + 5 + 5 + 4.

**3 matières par semaine (CD-13).** Pour chaque classe et chaque semaine, une variable booléenne par matière *nouvelle* (absente des séances figées de la semaine) est forcée à 1 dès qu'un de ses cours est actif :
```
Σ matières nouvelles ≤ N − (matières déjà présentes dans les séances figées)
```
Le CM, le TD et le TP d'une même matière comptent pour une seule matière, puisque la variable est par matière et non par cours.

**Capacité de l'enseignant.**
```
Σ_k de l'enseignant  h[k,w]  ≤  ⌊0,9 × (heures ouvertes − heures figées dans la période)⌋
                             et  ≤  nb_heures_max_semaine − heures figées de toute la semaine
```

**Capacité de la classe.** Une classe ne peut pas suivre plus d'heures que sa grille ouverte. Mais deux groupes du même type peuvent être en parallèle (CD-03), il ne faut donc pas additionner naïvement leurs heures :
```
charge = Σ heures des cours de classe entière (CM, cours sans groupe)
       + y_TD + y_TP
y_t ≥ heures de chaque groupe de type t          (les groupes de TP tournent en parallèle)
y_t ≥ Σ heures des groupes de type t qui partagent un enseignant   (eux sont en série)
charge ≤ ⌊0,85 × créneaux ouverts de la classe⌋ − heures figées
```
Avant la dernière ligne sur les enseignants partagés, l'étage 1 surestimait le parallélisme quand deux groupes de TP avaient le même enseignant. L'étage 2 ne pouvait alors pas suivre.

**Capacité des salles, par type.**
```
Σ heures des cours qui exigent le type t ≤ ⌊0,9 × nb salles disponibles du type × créneaux ouverts⌋ − heures figées
```

### 7.3 Objectif (minimisé)

| Terme | Poids | Effet |
|---|---|---|
| Heures manquantes | 10 000 par heure | Programmer tout le volume passe avant tout le reste |
| CS-07 : commencer tôt | `w7 × (1 + priorité) × rang de la semaine` par semaine active | Les cours prioritaires démarrent en premier |
| CS-04, externe | `3 × w4` par semaine active | Le moins de semaines possible : cours ramassés pendant le séjour |
| CS-04, interruptions | `facteur × w4` par démarrage (semaine active après une semaine vide) | Permanents et externes : cours enchaînés (facteur 4) ; vacataires locaux : peu pénalisés (facteur 1), ils suivent leurs disponibilités |
| CS-05 : CM avant TD/TP | `20 × w5` par semaine où un TD/TP est actif avant que le CM de sa matière ait commencé | Les TD suivent le cours magistral |
| Replanification | `50 × |h − h actuel|` par (cours, semaine) | Rester proche du plan actuel |

`w4`, `w5`, `w7` sont les poids des contraintes souples de l'emploi du temps (table `contrainte`). Une contrainte désactivée a un poids nul et son terme disparaît.

Pour CS-05, une variable « le CM a commencé à la semaine *w* » vaut 1 à partir de la première semaine active du CM. L'écart absolu de la replanification s'écrit avec deux inégalités : `add_abs_equality` d'OR-Tools 9.12 rejette une expression de signe fixe.

### 7.4 Résolution

CP-SAT avec 8 fils de recherche, 20 s au plus et un écart relatif de 1 % accepté (`relative_gap_limit = 0.01`). Le résultat est le dictionnaire des `h[k,w] > 0` et les manques. Si le modèle n'a pas de solution (ce qui ne devrait pas arriver, puisque le manque absorbe tout), tout le besoin est déclaré manquant.

---

## 8. Étage 2 : le placement d'une semaine

`placement.placer_semaine()` reçoit les heures de chaque cours pour une semaine et les séances figées.

### 8.1 Découpage en séances

`decouper(heures, durées préférées)` transforme des heures en séances de 2 à 4 h. Il suit les durées de `cours_seance_modele` à tour de rôle, sans jamais laisser une heure isolée :

| Heures | Durées préférées | Séances |
|---|---|---|
| 5 | (2, 3) | 2 + 3 |
| 7 | (2,) | 2 + 2 + 3 |
| 14 | (3,) | 3 + 3 + 3 + 3 + 2 |
| 15 | (2, 3) | 2 + 3 + 2 + 3 + 2 + 3 |

Si le dernier morceau ferait 1 h, il est absorbé par une séance précédente de moins de 4 h, ou bien la découpe choisit une durée qui laisse au moins 2 h.

### 8.2 Placements candidats

Pour chaque séance, l'étage 2 énumère les **placements** (date, heure de début, salle) qui respectent déjà toutes les règles locales. Les contraintes suivantes sont donc appliquées par **filtrage**, avant le modèle :

| Filtre | Règle |
|---|---|
| Salles disponibles, assez grandes pour l'effectif (classe ou groupe), du type exigé | CD-12, CD-04, CD-05 |
| Jour ouvert pour la classe | CD-09 |
| Enseignant présent (absence, séjour) | CD-06 |
| Début dans `debuts_possibles` (grille, pause) | CD-10, CD-11 |
| Aucun créneau de la séance déclaré `indisponible` | CD-06 |
| Contraintes ajoutées | demande |
| Enseignant et classe libres vis-à-vis des séances **figées** | CD-02, CD-03 |
| Salle libre vis-à-vis des séances figées | CD-01 |

Seules les **5 salles libres les mieux ajustées** (capacité la plus proche de l'effectif) sont gardées par créneau : un groupe de 25 ne doit pas occuper l'amphi de 250, et le modèle reste petit.

Chaque filtre qui élimine des placements laisse un **motif**. Si une séance n'a plus aucun candidat, ce motif explique l'échec (« CD-06 : enseignant absent ou hors de ses séjours »). Si elle a des candidats mais reste non placée, c'est que les séances de la semaine se gênent entre elles (CD-01/02/03).

### 8.3 Variables

- `x[i,p]` booléen : la séance *i* prend le placement *p* ;
- `u[i]` booléen : la séance *i* n'est pas placée ;
- `Σ_p x[i,p] + u[i] = 1`.

### 8.4 Contraintes entre séances de la semaine

Chaque placement est découpé en **pas d'une heure** (`_slots`). Pour chaque (salle, date, heure) et chaque (enseignant, date, heure) :
```
Σ x qui occupent ce pas ≤ 1                         (CD-01, CD-02)
```

**CD-03, classe.** Pour chaque (classe, date, heure) :
```
x des séances de classe entière   +   b_TD   +   b_TP   ≤ 1
b_t ≥ Σ x des séances d'un même groupe de type t      (pour chaque groupe)
```
Une séance de classe entière (un CM) exclut tout le reste. Plusieurs groupes de TP peuvent être ensemble (ils partagent `b_TP`), mais jamais en même temps qu'un TD (`b_TD + b_TP ≤ 1`), et un groupe ne suit qu'une séance à la fois. Salles et enseignants différents sont garantis par CD-01 et CD-02.

**Brisure de symétrie.** Les séances identiques d'un même cours (par exemple trois séances de 3 h du TP-G1) sont interchangeables. Leur ordre est fixé (la *i*-ième commence avant la *i+1*-ième, et si la *i*-ième n'est pas placée, la suivante non plus). Le solveur n'explore ainsi pas des solutions équivalentes.

### 8.5 Objectif (minimisé)

| Terme | Poids | Effet |
|---|---|---|
| Séance non placée | 10 000 × durée | Tout placer d'abord |
| Préférence du matin | (heure de début − 7) par placement | Départage léger vers le matin |
| CS-01 : créneaux préférés | `− 3 × w1` par heure en créneau `preference` | Respecter les souhaits des enseignants |
| Ajustement de la salle | (capacité − effectif) / 50 | Ne pas gaspiller les grandes salles |
| CS-02 : journées compactes (approché) | `2 × w2` par jour utilisé par une classe | Regrouper les séances d'une classe sur moins de jours |
| CS-03 : sites | `3 × w3` par (classe, jour, site) utilisé | Éviter qu'une classe change de site dans la journée |
| CS-05 : CM avant TD/TP | `w5 × retard en jours` | Dans la semaine, le CM avant les TD et TP de sa matière |
| CS-06 : charge d'un enseignant | `3 × w6` par heure au-delà de 6 h dans la journée | Éviter les journées trop lourdes |
| Replanification | `− 200` même séance (jour, heure, salle) ; `− 120` même jour et même heure | Ne déplacer que le nécessaire |

### 8.6 Résolution

CP-SAT, 8 fils, `temps_max_placement` secondes par semaine (10 s par défaut ; l'API utilise 4 à 5 s), écart relatif de 1 %. Chaque séance non placée devient un `NonPlace` avec son code et son motif.

---

## 9. La boucle entre les deux étages

```
plafonds = {}
répéter (8 fois au plus) :
    plan = étage 1 (besoins, plafonds)
    pour chaque semaine :
        si ses heures n'ont pas changé depuis le tour précédent : garder son placement
        sinon : étage 2
        pour chaque cours qui n'a pas obtenu toutes ses heures :
            plafonds[cours, semaine] = heures obtenues
    si aucune semaine n'a manqué d'heures : arrêter
```

Quand une semaine ne peut pas tout placer, l'étage 1 apprend qu'elle ne peut pas recevoir plus d'heures de ce cours. Au tour suivant, il **reporte le manque sur d'autres semaines**. Les semaines inchangées ne sont pas recalculées. En pratique, le jeu de test converge en **un seul tour** : les marges de 85 % et 90 % suffisent.

---

## 10. Le résultat

```python
Resultat(
    seances=[…],       # séances du périmètre produites par le solveur
    conservees=[…],    # séances figées (hors périmètre, hors période, verrouillées)
    remplacees=[…],    # séances existantes que le résultat remplacerait
    non_places=[NonPlace(id_cours, heures, code, raison, semaine)],
    reportees={id_cours: heures},   # génération courte : heures prévues après la période
    statistiques={duree_s, iterations, statut_etage1, cours, semaines,
                  heures_demandees, heures_placees, heures_reportees},
)
```

- **Heures non placées (BF-18)** : chaque manque porte la règle qui bloque. Le code est celui du filtre ou du conflit de l'étage 2 (`CD-06`, `CD-04/CD-05`, `CD-01/CD-02/CD-03`…), ou `CAPACITE` quand l'étage 1 n'a trouvé aucune semaine pour ces heures (séjours, rythme maximal, CD-13, charge de la classe). C'est ce qui permet à l'assistant d'expliquer un refus et à la page Génération d'afficher les heures manquantes.
- **Heures reportées** : prévues par le plan après la période d'une génération courte ; elles seront placées par une génération ultérieure. Elles ne sont ni manquantes ni perdues.
- **`modifications()`** : différence entre les séances remplacées et les nouvelles, au format de `PROPOSITION.modifications` (`supprimer` / `creer`). Une séance est comparée en entier (cours, date, début, **fin**, salle) : la même heure de début avec une autre durée est un changement. Sans la fin dans la clé, l'application d'une proposition était refusée par la base (CD-03).

---

## 11. Lecture et écriture dans la base

- **Plusieurs écoles** partagent la base. `charger()` lit l'école de l'emploi du temps et filtre toutes ses lectures sur elle ; `enregistrer()` et `verifier()` écrivent les séances avec cette école. Sous l'API, la RLS de la base filtre en plus (`../backend/README.md`, *Isolation entre écoles*).
- `charger(conn, id_edt)` : §4.
- `enregistrer(conn, id_edt, resultat)` : dans **une transaction**, supprime les séances remplacées puis insère les nouvelles, et passe l'emploi du temps en mode `automatique`. Le créneau de début (`id_creneau`) est retrouvé à partir du jour et de l'heure.
- `verifier(conn, id_edt, séance)` : insère ou déplace une séance dans une transaction **toujours annulée**, pour obtenir le verdict du déclencheur sans rien écrire. C'est l'outil `verifier_seance` de l'assistant.

**Double garantie.** Chaque séance écrite passe par le déclencheur `verifier_seance`, qui revérifie CD-02 à CD-14, et par la contrainte d'exclusion de la table, qui garantit CD-01. Si le solveur avait un défaut, la base refuserait la séance avec son code CD-xx et **rien ne serait écrit**. Le solveur et la base appliquent les mêmes règles, écrites deux fois, indépendamment.

Côté backend (`../backend`) :
- `app/generations.py` lance `generer()` en tâche de fond (page Génération) ;
- `app/outils.py` l'appelle pour l'assistant : `proposer_replanification` en replanification minimale sur des semaines entières, `proposer_generation` pour un semestre ou une période courte. Le résultat devient une `PROPOSITION` avec son analyse d'impact (`app/impact.py`).

---

## 12. Où chaque règle est appliquée

| Règle | Étage 1 | Étage 2 | Base |
|---|---|---|---|
| CD-01 salle unique | capacité agrégée par type de salle | ≤ 1 par (salle, heure) ; filtre des séances figées | contrainte d'exclusion |
| CD-02 enseignant unique | capacité de l'enseignant | ≤ 1 par (enseignant, heure) ; filtre | déclencheur |
| CD-03 classe, groupes en parallèle | capacité de la classe (`y_TD`, `y_TP`) | variables `b_TD`, `b_TP` ; filtre | déclencheur |
| CD-04 capacité ≥ effectif | — | filtre des salles | déclencheur |
| CD-05 type de salle | capacité par type | filtre des salles | déclencheur |
| CD-06 présence, disponibilité (l'habilitation est garantie à l'enregistrement du cours) | heures ouvertes du cours et de l'enseignant | filtres | déclencheur, sur `cours` et sur `seance` |
| CD-07 programme | — (cours déjà conformes) | — | déclencheur sur `cours` |
| CD-08 volume | égalité de volume avec manque | — | déclencheur |
| CD-09 semestre, fériés, congés | heures ouvertes | filtre des jours | déclencheur |
| CD-10 grille | — | `debuts_possibles` | déclencheur |
| CD-11 pause | — | `debuts_possibles` | déclencheur |
| CD-12 salle disponible | capacité par type (salles disponibles) | filtre des salles | déclencheur |
| CD-13 3 matières / semaine | contrainte par classe et semaine | — (garanti par l'étage 1) | déclencheur |
| CD-14 rythme maximal | borne de `h[k,w]` | — | déclencheur |
| CS-01 créneaux préférés | — | objectif | — |
| CS-02 journées compactes | — | objectif (approché) | — |
| CS-03 sites | — | objectif | — |
| CS-04 externes / permanents | objectif | — | — |
| CS-05 CM avant TD/TP | objectif (entre semaines) | objectif (dans la semaine) | — |
| CS-06 heures par jour | — | objectif | — |
| CS-07 priorités | objectif | — | — |

---

## 13. Exemple réel : la L2INFO

Génération de la classe L2INFO seule, sur le jeu de test (`schema_supabase.sql`). Il y a 7 cours, 3 matières et 240 h ; le rythme va de 2 à 15 h par semaine.

| Semaine du | ALGO CM | ALGO TD-A | ALGO TD-B | RES TP-G1 | RES TP-G2 | RES TP-G3 | BD CM | Matières |
|---|---|---|---|---|---|---|---|---|
| 12 oct. | 9 | – | – | 14 | 14 | 14 | 15 | 3 |
| 19 oct. | 15 | – | – | 8 | 8 | 8 | 15 | 3 |
| 26 oct. | – | 9 | – | 14 | 14 | 14 | 15 | 3 |
| 2 nov. | – | 15 | – | – | – | – | 15 | 2 |
| 9 nov. | – | – | 15 | – | – | – | – | 1 |
| 16 nov. | – | – | 9 | – | – | – | – | 1 |

Résultat : 240 h placées sur 240, en 6 semaines, en un seul tour de boucle (25 s, avec 5 s par semaine à l'étage 2). Ce qu'on y lit :

- **Volume** : chaque cours atteint exactement son volume (ALGO CM : 9 + 15 = 24 h ; BD : 4 × 15 = 60 h).
- **CD-13** : jamais plus de 3 matières par semaine.
- **CS-05** : les TD d'algorithmique commencent la semaine du 26 octobre, après le CM des deux premières semaines.
- **Enseignant partagé** : TD-A et TD-B ont la même enseignante (Mariam Sawadogo). Ils ne sont pas en parallèle mais successifs, ce qui explique les deux semaines de TD-B à la fin.
- **CS-04, CS-07** : les cours démarrent tôt et s'enchaînent sans interruption (permanents). Les cours montent au rythme maximal de 15 h : c'est le comportement attendu pour un enseignement par modules qui doit « finir au plus tôt ». Pour étaler un cours, il faut baisser son `heures_semaine_max`.

Première semaine, placée par l'étage 2 (extrait) :

```
lun. 12  07–09  RES TP G1  Laboratoire 2      07–09  RES TP G3  Laboratoire 1   ← deux groupes de TP en parallèle
lun. 12  09–12  RES TP G1  Laboratoire 2      09–12  RES TP G3  Laboratoire 1
lun. 12  13–16  ALGO CM    Amphi 120
mar. 13  07–09  BD CM      Amphi 120
mar. 13  09–12  BD CM      Amphi 120
mer. 14  07–10  RES TP G2  Laboratoire 2      07–10  RES TP G3  Laboratoire 1
…
sam. 17  07–10  RES TP G1  Laboratoire (annexe)   G2 Laboratoire 2   G3 Laboratoire 1
sam. 17  10–12  ALGO CM    Amphi 120
```

On y voit :
- les groupes de TP **en parallèle** dans des laboratoires différents, avec des enseignants différents (CD-03) ;
- les séances découpées en 2 h et 3 h ;
- aucune séance ne traverse la pause ;
- le samedi après-midi est vide.

Le samedi, les trois TP ont lieu en même temps et il n'y a que deux laboratoires sur le campus. Le TP-G1 part donc au laboratoire de l'annexe, et la classe change de site dans la journée. C'est un **arbitrage** de CS-03 (souple) : un changement de site coûte moins cher que de laisser des heures non placées.

---

## 14. Performances

Mesures sur le jeu de test (13 cours, 13 salles, 9 enseignants, semestre de 19 semaines), machine de développement à 8 cœurs, ligne de commande (10 s par semaine à l'étage 2) :

| Demande | Heures | Résultat | Durée |
|---|---|---|---|
| Tout l'établissement, semestre | 414 h | 414 h placées (100 %) | ≈ 50 s |
| Filière INFO, semestre | 360 h | 360 h placées (100 %) | ≈ 41 s |
| Classe L2INFO, semestre (5 s par semaine) | 240 h | 240 h placées (100 %) | ≈ 25 s |
| Classe L2INFO, une semaine (génération courte) | 66 h | 66 h placées, le reste reporté | ≈ 11 s |

Le temps est surtout celui de l'étage 2, borné par `temps_max_placement` pour chaque semaine qui a des heures. Il croît donc à peu près linéairement avec le nombre de semaines actives, et non exponentiellement avec la taille de l'école. Par l'API (5 s par semaine), la filière INFO prend environ 16 s.

---

## 15. Limites et approximations

- **Optimalité non garantie.** Chaque résolution est bornée dans le temps et s'arrête à 1 % de l'optimum. Le solveur donne une très bonne solution, pas forcément la meilleure. La **validité** (règles dures), elle, est toujours garantie, et revérifiée par la base.
- **Décomposition.** L'étage 1 ne voit que des capacités agrégées. Les marges (85 %, 90 %) et la boucle corrigent l'essentiel, mais le plan des semaines peut être un peu prudent, ou demander une boucle de plus quand la grille est très chargée.
- **5 salles candidates** par créneau : on peut en théorie manquer une solution qui passerait par une salle moins bien ajustée. En pratique, cela se produit seulement si les 5 meilleures salles sont toutes occupées.
- **CS-02 approché** : on compte les jours utilisés par une classe, pas les trous dans une journée.
- **Heures entières** : pas de créneaux de 30 minutes. La grille peut passer à 30 min dans la base, mais pas le solveur actuel.
- **Examens** : ils ne sont pas modélisés comme des séances. Une période d'examens est déclarée comme congé (`type_conge = 'examens'`), ce qui ferme ces jours (CD-09).
- **Génération courte** : si l'étage 1 repousse des heures de la période vers plus tard (semaine trop chargée), elles apparaissent comme reportées et non comme manquantes. La page Génération et l'assistant affichent ce report.
- **Replanification** : elle travaille sur des semaines entières (l'assistant étend la période au lundi–samedi), pour que le solveur ait la place de reprogrammer.
- **Rythme élevé par défaut** : avec `heures_semaine_max = 15`, les cours sont intenses et finissent vite. C'est voulu pour les modules, mais c'est à régler cours par cours.

---

## 16. Tests

```bash
.venv/bin/python -m pytest                     # jeu synthétique (tests/jeu.py)
DATABASE_URL=… .venv/bin/python -m pytest      # + intégration avec la base (vide la table seance !)
```

`tests/jeu.py` construit de petits jeux de données et contient un **vérificateur indépendant** (`violations()`). Il recontrôle toutes les contraintes dures sur chaque résultat sans réutiliser le code du solveur. Un test ne se contente donc pas de « le solveur a répondu ».

| Test | Ce qu'il garantit |
|---|---|
| `test_decouper_respecte_les_durees` | Découpage en séances de 2 à 4 h, total exact, pour toutes les durées et préférences |
| `test_generation_complete_sans_violation` | Génération complète, tout placé, aucune violation |
| `test_groupes_du_meme_type_en_parallele` | Deux groupes de TP en parallèle quand la grille l'exige |
| `test_cd13_trois_matieres_par_semaine` | Jamais plus de 3 matières par classe et par semaine |
| `test_externe_enseigne_pendant_son_sejour_et_ramasse` | Un externe n'enseigne que pendant son séjour, en peu de semaines |
| `test_externe_sans_sejour_signale_non_place` | Sans séjour, ses heures sont signalées avec le motif CD-06 |
| `test_perimetre_garde_les_autres_classes` | Générer une classe ne touche pas les autres |
| `test_replanification_avec_contrainte_imposee` | Une fenêtre imposée est respectée, avec peu de changements |
| `test_interdire_une_fenetre` | Une fenêtre interdite n'est jamais touchée |
| `test_indisponibilite_respectee` | Les créneaux indisponibles d'un enseignant restent vides |
| `test_manque_signale_quand_la_fenetre_est_trop_etroite` | Les heures impossibles sont comptées exactement et expliquées |
| `test_modifications_distinguent_les_durees` | Même début mais autre durée = changement |
| `test_replanification_ne_complete_pas_le_programme` | Replanifier déplace les heures existantes, sans en ajouter |
| `test_periode_partielle_de_semaine` | Replanifier du lundi au mercredi seulement |
| `test_generation_d_une_seule_semaine_garde_le_rythme` | Une semaine reçoit sa part du volume ; le reste est reporté, pas perdu |
| `test_base.py` (3 tests) | Le semestre généré est accepté par le déclencheur ; périmètre d'une filière ; `verifier()` renvoie le motif de la base |
