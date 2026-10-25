# Système de planification des cours et de génération automatique des emplois du temps

## Sommaire

1. [Présentation du projet](#1-présentation-du-projet)
2. [Acteurs et parties prenantes](#2-acteurs-et-parties-prenantes)
3. [Besoins fonctionnels](#3-besoins-fonctionnels)
4. [Règles métier et contraintes de planification](#4-règles-métier-et-contraintes-de-planification)
5. [Besoins non fonctionnels](#5-besoins-non-fonctionnels)
6. [Architecture technique](#6-architecture-technique)
7. [Modèle de données (MLD)](#7-modèle-de-données-mld)
8. [Planning, lots et livrables](#8-planning-lots-et-livrables)
9. [Organisation, charge et risques](#9-organisation-charge-et-risques)
10. [Recette, acceptation et maintenance](#10-recette-acceptation-et-maintenance)
11. [Points d'attention : écarts entre le MLD et le cahier des charges](#11-points-dattention--écarts-entre-le-mld-et-le-cahier-des-charges)
12. [Décisions](#12-décisions)

---

## 1. Présentation du projet

### 1.1 Contexte

Les emplois du temps de l'université sont aujourd'hui construits **à la main dans des tableurs**. Cela entraîne plusieurs problèmes :

- les conflits de salle ou d'enseignant sont découverts tardivement ;
- les salles sont mal adaptées aux effectifs ;
- le suivi du volume horaire de chaque cours est approximatif.

Le projet s'appuie sur un dossier de conception Merise déjà produit : MCD, normalisation en 3FN, MLD et script SQL.

### 1.2 Objectifs

1. **Centraliser** dans une seule base le référentiel pédagogique et logistique : cours, volumes horaires, salles, créneaux, enseignants et leurs disponibilités.
2. **Produire** des emplois du temps sans conflit de salle, d'enseignant ni de groupe.
3. **Affecter** chaque séance à une salle du bon type et de capacité suffisante.
4. **Générer automatiquement** une proposition d'emploi du temps, ajustable à la main.
5. **Suivre en continu** les heures planifiées face aux heures prévues.

### 1.3 Périmètre

| Dans le périmètre | Hors périmètre (version 1) |
|---|---|
| Référentiel : sites (campus et annexes), filières, classes, groupes, matières, cours, enseignants et habilitations, salles, créneaux, congés et jours fériés | Inscriptions pédagogiques individuelles des étudiants |
| Saisie des disponibilités (semaine type) et des absences datées des enseignants, par la scolarité | Planification des examens et surveillances |
| Planification manuelle, génération automatique et assistant IA en langage naturel | Paie et calcul des heures complémentaires |
| Consultation publique des emplois du temps publiés (web, mobile, export), sans compte | Gestion des notes |
| Tableaux de bord : occupation des salles, volumes horaires | Réservation de salles par des acteurs externes ; journal d'audit (super-administrateur) |

Les éléments hors périmètre pourront faire l'objet d'une version 2.

---

## 2. Acteurs et parties prenantes

Seuls les gestionnaires de l'emploi du temps ont un compte. Les enseignants et les étudiants consultent librement, sans connexion.

| Acteur | Accès | Droits principaux |
|---|---|---|
| **Administrateur** | Compte (invitation par e-mail) | Comptes, paramétrage, référentiel complet, planification, publication |
| **Planificateur (service de la scolarité)** | Compte (invitation par e-mail) | Référentiel, disponibilités et absences des enseignants, planification, génération, publication |
| **Enseignant** | Espace invités, sans compte | Consultation de tous les emplois du temps publiés (par classe, enseignant, salle, matière) |
| **Étudiant / délégué** | Espace invités, sans compte | Consultation de tous les emplois du temps publiés, quelle que soit la classe |
| **Super administrateur** (plateforme) | Compte, console dédiée | Crée les écoles clientes, invite leurs administrateurs, suspend une école ou désactive un compte ; consulte le journal d'audit des séances de toutes les écoles ; n'accède pas aux emplois du temps |

Les disponibilités des enseignants sont recueillies par la scolarité, qui les saisit dans l'application.

**Parties prenantes du projet** :

- la **direction des études** (maîtrise d'ouvrage) ;
- le **service informatique** de l'université (hébergement, exploitation) ;
- l'**équipe de réalisation** (maîtrise d'œuvre).

---

## 3. Besoins fonctionnels

Priorités : **M** = indispensable, **S** = souhaité, **C** = confort.

### 3.1 Module Référentiel

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-01 | Créer, modifier, archiver les filières, les classes (avec niveau L1…M2 et effectif) et les groupes de TD et de TP (avec effectif) | M |
| BF-02 | Gérer les matières (code, intitulé, coefficient) et les cours : matière, type (CM, TD, TP), classe ou groupe, enseignant, semestre | M |
| BF-03 | Saisir le volume horaire de chaque cours, son rythme hebdomadaire (heures minimales et maximales par semaine) et les durées de séance préférées (2 h à 4 h) | M |
| BF-04 | Gérer les salles (capacité, bâtiment, type, disponibilité) et les types de salle ; associer à chaque cours le type de salle exigé | M |
| BF-05 | Définir la grille des créneaux hebdomadaires (jour, heure de début, heure de fin) et les pauses | M |
| BF-06 | Saisir le **programme** (maquette pédagogique) de chaque classe : matières et volumes CM / TD / TP prévus par semestre ; signaler les heures non couvertes par des cours | M |
| BF-07 | Importer le référentiel depuis des fichiers CSV, avec rapport d'erreurs | S |
| BF-27 | Gérer les **sites** de l'école (campus et annexes) et y rattacher les salles (obligatoire), les filières et les enseignants (facultatif) | M |
| BF-28 | Gérer les **jours fériés** et les **congés** (vacances, examens, stage) pour tout l'établissement ou pour une seule classe | M |

### 3.2 Module Enseignants

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-08 | Gérer les enseignants (grade, coordonnées, site de rattachement, plafond horaire, **statut** : permanent, vacataire local ou externe) et leurs **habilitations** par matière et type de cours | M |
| BF-09 | Saisir les disponibilités de chaque enseignant sur la semaine type : disponible, préférence, indisponible | M |
| BF-10 | Saisir les **absences datées** d'un enseignant (mission, congé, maladie) et les **séjours prévus** des intervenants externes ; signaler les séances déjà planifiées qui ne les respectent pas | M |

### 3.3 Module Planification

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-11 | Créer, déplacer, annuler une séance par glisser-déposer sur une grille hebdomadaire | M |
| BF-12 | Contrôler en temps réel chaque séance et afficher le motif de tout refus (conflit, capacité, type de salle, indisponibilité, absence, congé) | M |
| BF-13 | Proposer les salles et créneaux compatibles pour une séance donnée | S |
| BF-14 | Dupliquer une semaine type sur toute la période du semestre, en sautant jours fériés et congés | M |

### 3.4 Module Génération automatique

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-15 | Générer un emploi du temps qui respecte toutes les contraintes dures et optimise les contraintes souples, selon l'**enseignement par modules** (voir §4.3) | M |
| BF-16 | Pondérer les contraintes souples (préférences, journées compactes, déplacements entre bâtiments et sites) | S |
| BF-17 | Verrouiller des séances avant génération et ne recalculer que le reste | S |
| BF-18 | Expliquer les séances non placées (contrainte bloquante identifiée) | S |
| BF-30 | Programmer un **périmètre** (tout l'établissement, une ou plusieurs filières ou classes) sur une **période** choisie, les séances des autres périmètres restant figées | M |
| BF-29 | Modifier ou interroger un emploi du temps en langage naturel (assistant IA), avec un **historique des discussions**. L'assistant interroge le solveur (voir §6) et ses propositions ne sont appliquées qu'après validation | S |
| BF-31 | Faire **proposer par l'assistant IA les priorités** des cours (prérequis, intervenants externes…), avec une justification ; la scolarité les accepte ou non | S |

### 3.5 Module Publication

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-19 | Valider puis publier un emploi du temps ; garder l'historique des versions | M |
| BF-20 | Notifier par e-mail les enseignants concernés par un changement publié (séances ajoutées, retirées, modifiées, avec le lien vers leur emploi du temps). Les étudiants n'ayant pas de compte ni d'adresse dans la base consultent l'espace invités | S |

### 3.6 Module Consultation (espace invités)

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-21 | Afficher, **sans connexion**, l'emploi du temps publié de n'importe quelle classe, groupe, enseignant, salle ou matière, en vue jour, semaine, liste ou semestre, avec des filtres par site, filière, groupe et type de séance | M |
| BF-22 | Exporter en PDF (impression) et iCalendar ; partager un lien vers une vue | S |

### 3.7 Tableaux de bord et administration

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-23 | Suivre les heures planifiées / prévues par cours, type et groupe | M |
| BF-24 | Suivre le taux d'occupation des salles et la charge des enseignants | C |
| BF-25 | Gérer les comptes administrateurs et planificateurs (invitation par e-mail : par le super admin, ou par l'administrateur de l'école pour son école) | M |
| BF-26 | Ouvrir et clôturer une année universitaire et ses semestres | M |

---

## 4. Règles métier et contraintes de planification

Une séance n'est enregistrée que si **toutes les contraintes dures sont respectées**. Les contraintes souples servent à **classer les solutions valides**.

### 4.1 Contraintes dures (jamais violées)

| Réf. | Contrainte |
|---|---|
| CD-01 | Une salle accueille au plus une séance à la fois. |
| CD-02 | Un enseignant anime au plus une séance à la fois. |
| CD-03 | Une classe ne suit pas deux séances en même temps. **Seule exception** : deux groupes différents du même type (TP-G1 et TP-G2, ou TD-A et TD-B) peuvent être en parallèle, chacun dans sa salle et avec son enseignant. Un CM bloque toute la classe ; un TD et un TP ne sont jamais en parallèle. |
| CD-04 | La capacité de la salle est supérieure ou égale à l'effectif accueilli (groupe ou classe entière). |
| CD-05 | Le type de la salle correspond au type exigé par le cours (CM en amphithéâtre, TP en laboratoire, etc.). |
| CD-06 | L'enseignant est **habilité** pour la matière et le type de cours, n'est **pas absent** à cette date, est **présent sur le campus** s'il est externe (séjour prévu) et n'est pas déclaré indisponible sur le créneau. |
| CD-07 | La matière d'un cours figure au **programme** de sa classe pour ce semestre et ce type (CM, TD, TP), et le volume du cours ne dépasse pas le volume prévu. |
| CD-08 | Le cumul des séances d'un cours ne dépasse pas son volume horaire. |
| CD-09 | La séance tombe le jour de la semaine du créneau, dans les dates du semestre, hors jour férié et hors **congé** ; le cours appartient au semestre de l'emploi du temps. |
| CD-10 | La séance est alignée sur la grille de créneaux. |
| CD-11 | La séance ne chevauche pas une pause (pause déjeuner). |
| CD-12 | La salle n'est pas marquée indisponible. |
| CD-13 | Une classe étudie **au plus 3 matières différentes par semaine** (valeur paramétrable ; le CM, le TD et le TP d'une même matière comptent pour une ; examens non concernés). |
| CD-14 | Un cours ne dépasse pas son **rythme hebdomadaire maximal** (`heures_semaine_max`). |

### 4.2 Contraintes souples (optimisées)

| Réf. | Contrainte | Poids par défaut |
|---|---|---|
| CS-01 | Placer les séances sur les créneaux marqués « préférence » par l'enseignant | Élevé |
| CS-02 | Éviter les trous dans la journée d'une classe | Moyen |
| CS-03 | Limiter les changements de bâtiment, et surtout de site, entre deux séances consécutives | Moyen |
| CS-04 | Selon le statut de l'enseignant : **ramasser** les cours d'un externe sur le moins de semaines possible, **enchaîner** sans interruption ceux d'un permanent ; un vacataire local suit ses disponibilités | Moyen |
| CS-05 | Placer le CM d'un cours avant ses TD et TP dans la semaine | Faible |
| CS-06 | Ne pas dépasser un nombre maximal d'heures par jour pour un enseignant (6 h par défaut, paramétrable) | Faible |
| CS-07 | Commencer tôt les cours prioritaires (priorité saisie, éventuellement suggérée par l'assistant IA) | Moyen |

Les poids sont **paramétrables par le planificateur avant chaque génération** (BF-16). Dans le MLD, ils sont portés par la table `CONTRAINTE` (attributs `nature`, `poids`, `valeur`, `est_active`) ; `valeur` porte le paramètre d'une contrainte (3 pour CD-13, 6 h pour CS-06).

### 4.3 Précisions de conception

Ces règles sont contrôlées par la base (voir §7.3).

**Enseignement par modules**

À 2iE, une classe ne suit pas toutes ses matières en parallèle sur le semestre : chaque semaine, elle étudie **au plus 3 matières** (CD-13). Un cours commence, se poursuit de semaine en semaine jusqu'à épuisement de son volume, puis laisse la place à un autre. Le rythme dépend de l'enseignant (CS-04) :

- un **intervenant externe** vient pour des séjours datés (`SEJOUR_ENSEIGNANT`) : son cours est ramassé sur le moins de semaines possible ;
- un **permanent** disponible à temps plein : son cours s'enchaîne sans interruption ;
- un **vacataire local** : son cours suit ses disponibilités et peut s'étaler.

Chaque semaine, le nombre d'heures d'un cours est choisi par le solveur entre `heures_semaine_min` et `heures_semaine_max`. L'ordre des cours suit leurs priorités (CS-07), qui restent des préférences ; plusieurs cours peuvent se dérouler en même temps, dans la limite de CD-13.

**Grille horaire et durée des séances**

- Créneaux de base de **1 h** : de 7 h à 12 h et de 13 h à 16 h du lundi au vendredi, de 7 h à 12 h le samedi. **Pause déjeuner de 12 h à 13 h.**
- Une séance dure **entre 2 h et 4 h**. Les séances de 4 h ne tiennent que le matin ; l'après-midi compte 3 h.
- `COURS_SEANCE_MODELE` indique les durées de séance préférées d'un cours (par exemple 2 h + 3 h) ; le nombre de séances d'une semaine découle du rythme choisi par le solveur.
- Une séance couvre plusieurs créneaux consécutifs : `id_creneau` désigne son créneau de début, `heure_debut` et `heure_fin` portent sa durée réelle.

**Précisions sur les contraintes dures**

| Réf. | Précision |
|---|---|
| CD-01, CD-02, CD-03 | Le conflit se détecte sur les **plages horaires qui se chevauchent**. Deux séances qui se suivent (fin = début) ne sont pas en conflit. |
| CD-03 | Les TP ne sont pas des subdivisions des TD : CM, TD et TP sont des séances distinctes, chacune avec son créneau. Le parallélisme n'est admis qu'entre groupes différents du même type. |
| CD-04 | La capacité est comparée à l'effectif du **groupe** si le cours cible un groupe, sinon à l'effectif de la **classe**. |
| CD-06 | Quatre contrôles : habilitation (`HABILITATION`, vérifiée dès l'enregistrement du cours), absences datées (`ABSENCE_ENSEIGNANT`), séjours d'un externe (`SEJOUR_ENSEIGNANT` ; sans séjour, aucune séance possible) et semaine type (`DISPONIBILITE`, niveau `indisponible`). Les niveaux `disponible` (par défaut) et `preference` ne bloquent pas. |
| CD-13, CD-14 | Comptés sur la semaine ISO (du lundi au dimanche). Si la contrainte CD-13 est désactivée pour un emploi du temps, la limite ne s'applique pas. |
| CD-07 | Pour un TD ou un TP fait par groupes, le volume du programme vaut **pour chaque groupe** (24 h de TD = 24 h pour TD-A et 24 h pour TD-B). On ne peut ni retirer du programme ni réduire sous le volume des cours existants une matière déjà enseignée. |
| CD-08 | La **somme des durées** des séances d'un cours (hors séances annulées) ne dépasse pas son `volume_horaire`. |
| CD-09 | Un congé sans classe (`id_classe` vide) vaut pour tout l'établissement ; sinon il ne concerne que la classe indiquée. |

---

## 5. Besoins non fonctionnels

| Réf. | Domaine | Exigence | Cible |
|---|---|---|---|
| BNF-01 | Performance | Temps de réponse d'un écran de consultation | < 2 s pour 95 % des requêtes |
| BNF-02 | Performance | Contrôle d'une séance lors d'un déplacement manuel | < 500 ms |
| BNF-03 | Performance | Génération d'un semestre (≈ 200 groupes, 400 enseignants, 150 salles) | < 15 min |
| BNF-04 | Montée en charge | Consultations simultanées, notamment le jour de publication | 1 000 |
| BNF-05 | Disponibilité | Disponibilité du service en période de cours | 99,5 % |
| BNF-06 | Sécurité | Authentification par **Supabase Auth** pour les **administrateurs, planificateurs et le super administrateur** : comptes créés sur invitation par e-mail, mot de passe choisi par la personne (le SSO / CAS d'une école pourra s'y brancher) ; consultation publique sans compte | Obligatoire |
| BNF-07 | Sécurité | Contrôle d'accès par rôle ; lecture publique limitée aux emplois du temps **publiés** et aux données non personnelles ; HTTPS partout | Obligatoire |
| BNF-08 | Traçabilité | Journal d'audit de toute création, modification ou suppression de séance (compte, origine, état avant / après), consultable par le super administrateur ; écrit par un déclencheur de la base, que les écoles ne peuvent ni lire ni modifier | Obligatoire |
| BNF-09 | Données personnelles | Conformité à la réglementation nationale ; e-mail et téléphone des enseignants jamais exposés publiquement | Obligatoire |
| BNF-10 | Sauvegarde | Sauvegarde quotidienne, restauration testée chaque trimestre | Perte max. 24 h |
| BNF-11 | Ergonomie | Interface en français, adaptée au mobile pour la consultation | Obligatoire |
| BNF-12 | Accessibilité | Respect des règles WCAG 2.1 niveau AA | Niveau AA |
| BNF-13 | Maintenabilité | Code versionné, tests automatisés, couverture des règles métier | ≥ 80 % |
| BNF-14 | Interopérabilité | API REST documentée (OpenAPI) pour l'échange avec le système de scolarité | Obligatoire |

> Les volumes de BNF-03 sont des hypothèses à confirmer avec la scolarité.

---

## 6. Architecture technique

L'application web est découpée en couches autour d'**une API REST unique**. Le calcul de l'emploi du temps tourne en **tâche de fond** pour ne pas bloquer les utilisateurs.

```
 ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
 │  Interface web   │  │ Consultation     │  │ Agendas externes │
 │  planificateurs, │  │ mobile           │  │ abonnement       │
 │  administrateurs │  │ enseignants,     │  │ iCalendar        │
 │                  │  │ étudiants        │  │                  │
 └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
          └──────────────┬──────┴─────────────────────┘
                         ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  API REST sécurisée                                         │
 │  HTTPS · authentification unique SSO / CAS · accès par rôle │
 └──────────────────────────────┬──────────────────────────────┘
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Serveur d'application (Python, FastAPI)                    │
 │  ┌───────────┐ ┌────────────┐ ┌───────────┐ ┌─────────────┐ │
 │  │Référentiel│ │Planification│ │Moteur IA  │ │Notifications│ │
 │  │cours,     │ │grille      │ │OR-Tools   │ │e-mails,     │ │
 │  │salles,... │ │manuelle,   │ │CP-SAT,    │ │exports PDF, │ │
 │  │           │ │contrôles   │ │tâches     │ │Excel, iCal  │ │
 │  │           │ │temps réel  │ │asynchrones│ │             │ │
 │  └───────────┘ └────────────┘ └───────────┘ └─────────────┘ │
 └───────┬──────────────────────┬──────────────────────┬───────┘
         ▼                      ▼                      ▼
 ┌───────────────┐   ┌───────────────────┐   ┌──────────────────┐
 │ PostgreSQL    │   │ Redis             │   │ Annuaire de      │
 │ MLD en 3FN,   │   │ file de tâches du │   │ l'université     │
 │ déclencheurs  │   │ moteur            │   │ LDAP / CAS       │
 └───────────────┘   └───────────────────┘   └──────────────────┘
```

Tous les clients passent par l'API. Seul le moteur IA utilise la file de tâches. **Toutes les règles dures sont vérifiées une seconde fois par la base** (contraintes d'unicité et déclencheurs).

**Assistant IA et solveur.** Le module IA associe deux composants :

- le **solveur CP-SAT** calcule les emplois du temps. Il sait générer un périmètre (BF-30) et **replanifier au minimum** : recalculer une classe ou une filière sur une période en gardant le reste figé et en changeant le moins de séances possible ;
- un **agent LLM** (modèle `openai/gpt-oss-120b` servi par Groq, côté serveur) comprend les demandes en langage naturel. Il ne modifie jamais l'emploi du temps lui-même : il utilise des outils (lire l'emploi du temps ou le référentiel, vérifier une modification, demander une replanification au solveur, proposer des priorités) et présente le résultat. Chaque modification calculée est enregistrée comme `PROPOSITION` et n'est appliquée au brouillon qu'après validation d'un planificateur.

### Choix technologiques

| Couche | Choix proposé | Justification |
|---|---|---|
| Interface | React + TypeScript, interface responsive | Grille interactive par glisser-déposer, une seule base de code pour ordinateur et mobile |
| Serveur | Python 3.12 + FastAPI | Même langage que le moteur d'optimisation, documentation OpenAPI automatique |
| Moteur de génération | Google OR-Tools (solveur CP-SAT) | Solveur libre et performant pour les problèmes d'emploi du temps à contraintes |
| Tâches de fond | Celery + Redis | Générations longues exécutées hors requête, suivi de l'avancement |
| Base de données | PostgreSQL (hébergé sur Supabase) | Contraintes, déclencheurs et contraintes d'exclusion (extension `btree_gist`) prévus dans le MLD |
| Authentification | Supabase Auth (invitation par e-mail), jetons JWT vérifiés par l'API avec les clés publiques du projet | Comptes créés par invitation seulement ; SSO / CAS d'une école branchable ensuite |
| Déploiement | Docker, Nginx, intégration continue GitLab CI | Environnements identiques en test et en production |
| Supervision | Prometheus + Grafana, journaux centralisés | Suivi de la disponibilité (BNF-05) et des temps de réponse |

Trois environnements sont prévus : **développement, recette et production**.

### Accès à la base (Supabase)

- **Aucun accès direct depuis un navigateur.** Les rôles `anon` et `authenticated` de Supabase n'ont aucun droit sur les tables. Les deux consoles et l'espace invités passent tous par l'API ; Supabase Auth ne sert qu'à la connexion. Les e-mails et téléphones des enseignants ne sortent jamais de l'API (BNF-09).
- **L'API** se connecte en propriétaire des tables (chaîne de connexion du *Session pooler*, lue dans une variable d'environnement, jamais versionnée). La **clé secrète** du projet (`SUPABASE_SECRET_KEY`) ne sert qu'aux invitations de Supabase Auth, côté serveur.
- **Isolation entre écoles (RLS).** Chaque table métier porte `id_ecole`. Pour chaque requête d'un compte d'école, l'API fixe l'école du compte (`app.id_ecole`) et prend le rôle **`ultraplanning_app`**. La RLS de chaque table ne lui montre et ne lui laisse écrire que les lignes de cette école. Toutes les lectures et écritures sont ainsi filtrées par la base elle-même : API, solveur, assistant IA, déclencheurs.
- **Clés étrangères composites** `(colonne, id_ecole)` : une ligne ne peut pas désigner une ligne d'une autre école. Les codes (classe, salle, matricule, site…) sont uniques **dans une école**.
- **Invités** : l'espace invités choisit son école (`?ecole=CODE` dans l'adresse) et ne reçoit que le référentiel et la version publiée de cette école.
- **Super admin** : ses routes (`/api/superadmin/*`) gardent le rôle propriétaire, puisqu'il gère toutes les écoles ; il n'accède pas aux emplois du temps.

**Plateforme multi-écoles.** UltraPlanning sert plusieurs écoles clientes. Une **console super admin**, séparée de la console des écoles, crée les écoles et invite leurs administrateurs (API `/api/superadmin/*`). Un compte appartient à une école (`UTILISATEUR.id_ecole`) ; une école suspendue ou un compte désactivé ne peut plus se connecter.

---

## 7. Modèle de données (MLD)

Convention : <u>souligné</u> = clé primaire, `#` = clé étrangère. Le script de référence est `migrations/schema_supabase.sql` (version 8) ; les bases existantes se mettent à jour avec `migrations/`.

Le MLD couvre deux grands domaines : la **planification pédagogique** (séances, cours, salles, sites, enseignants, classes) et la **génération automatique** (emplois du temps, contraintes, assistant IA, utilisateurs).

### 7.1 Tables du MLD

#### Cœur de la planification

| Table | Attributs | Rôle |
|---|---|---|
| **SEANCE** | <u>id_seance</u>, date_seance, heure_debut, heure_fin, statut, est_verrouillee, #id_cours, #id_salle, #id_creneau, #id_edt | Table centrale : une occurrence datée d'un cours (2 h à 4 h), dans une salle, rattachée à un emploi du temps. `id_creneau` est le créneau de début ; `heure_debut` et `heure_fin` portent la durée. `est_verrouillee` supporte BF-17. |
| **COURS** | <u>id_cours</u>, type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite, priorite_suggeree, justification_priorite, heures_semaine_min, heures_semaine_max, #id_matiere, #id_classe, #id_groupe, #id_enseignant, #id_type_salle, #id_semestre | Enseignement d'une matière (CM, TD ou TP), pour une classe ou un groupe de même type (`id_groupe` vide = classe entière), par un enseignant habilité, avec un type de salle exigé, sur un semestre. Rythme hebdomadaire borné (CD-14) ; priorité (CS-07) et priorité suggérée par l'assistant IA. |
| **PROGRAMME** | <u>id_programme</u>, #id_classe, #id_matiere, #id_semestre, volume_cm, volume_td, volume_tp | Maquette pédagogique : matières qu'une classe suit sur un semestre et volumes prévus par type (CD-07). Unique par (classe, matière, semestre). |
| **COURS_SEANCE_MODELE** | <u>#id_cours</u>, <u>rang</u>, duree_heures | Découpage hebdomadaire d'un cours en séances (par exemple rang 1 : 2 h, rang 2 : 3 h). Lu par le moteur. |
| **MATIERE** | <u>id_matiere</u>, code_matiere, libelle, coefficient | Référentiel des matières. |
| **ENSEIGNANT** | <u>id_enseignant</u>, matricule, nom, prenom, email, telephone, grade, nb_heures_max_semaine, statut, #id_site | Enseignants, plafond horaire hebdomadaire, statut (`permanent`, `vacataire_local`, `externe`, CS-04) et site de rattachement (facultatif). |
| **SEJOUR_ENSEIGNANT** | <u>id_sejour</u>, #id_enseignant, date_debut, date_fin, commentaire | Séjours prévus d'un intervenant externe sur le campus (CD-06). |
| **HABILITATION** | <u>id_habilitation</u>, #id_enseignant, #id_matiere, type_cours | Matières et types de cours qu'un enseignant peut assurer (CD-06). Unique par (enseignant, matière, type). |
| **ABSENCE_ENSEIGNANT** | <u>id_absence</u>, #id_enseignant, date_debut, date_fin, motif | Absences datées : mission, congé, maladie (CD-06). |
| **DISPONIBILITE** | <u>#id_enseignant</u>, <u>#id_creneau</u>, niveau, motif | Semaine type de l'enseignant : `disponible`, `preference` ou `indisponible` (BF-09, CS-01, CD-06). Sans ligne : disponible. |
| **CRENEAU** | <u>id_creneau</u>, jour, heure_debut, heure_fin | Grille hebdomadaire de base (BF-05), en créneaux de 1 h. |
| **PAUSE** | <u>id_pause</u>, libelle, heure_debut, heure_fin | Plage sans séance (pause déjeuner, CD-11). |
| **JOUR_FERIE** | <u>date_ferie</u>, libelle | Jours fériés (CD-09). |
| **CONGE** | <u>id_conge</u>, libelle, type_conge, date_debut, date_fin, #id_classe | Périodes sans cours : vacances, examens, stage (CD-09). `id_classe` vide = tout l'établissement. |

#### Structure des publics et des locaux

| Table | Attributs | Rôle |
|---|---|---|
| **ECOLE** | <u>id_ecole</u>, code_ecole, nom, ville, pays, email_contact, statut, date_creation | École cliente de la plateforme (`statut` : `active` ou `suspendue`), gérée par le super administrateur. |
| **SITE** | <u>id_site</u>, code_site, nom_site, type_site, adresse | Campus ou annexe de l'école (`type_site` : `campus` ou `annexe`). |
| **FILIERE** | <u>id_filiere</u>, code_filiere, libelle, #id_site | Filière de formation et son site principal (facultatif). |
| **CLASSE** | <u>id_classe</u>, code_classe, libelle, niveau, effectif, #id_filiere | Classe appartenant à une filière. |
| **GROUPE** | <u>id_groupe</u>, code_groupe, type_groupe, effectif, #id_classe | Groupe de TD ou de TP d'une classe (`type_groupe` : `TD` ou `TP`). Un cours de même type peut le cibler (association CIBLER). |
| **SALLE** | <u>id_salle</u>, code_salle, nom_salle, capacite, batiment, est_disponible, #id_type_salle, #id_site | Salle d'un site, avec sa capacité (CD-04), son type (CD-05), son bâtiment et sa disponibilité (CD-12). |
| **TYPE_SALLE** | <u>id_type_salle</u>, libelle | Amphithéâtre, laboratoire, salle standard, etc. |
| **SEMESTRE** | <u>id_semestre</u>, libelle, annee_academique, date_debut, date_fin | Période de validité des séances (CD-09, BF-26). |

#### Génération automatique et pilotage

| Table | Attributs | Rôle |
|---|---|---|
| **EMPLOI_DU_TEMPS** | <u>id_edt</u>, libelle, version, mode_generation, statut, date_creation, date_publication, #id_semestre, #id_utilisateur | Une version d'emploi du temps (manuelle ou automatique), avec son statut de publication (BF-19). Seule la version `publie` est visible des invités. |
| **CONTRAINTE** | <u>id_contrainte</u>, libelle, type_contrainte, nature, poids, valeur, est_active, #id_edt | Contraintes (dures ou souples) paramétrées pour un emploi du temps (BF-16) ; `valeur` porte leur paramètre (CD-13, CS-06). |
| **CONVERSATION** | <u>id_conversation</u>, titre, date_creation, #id_utilisateur, #id_edt | Fil de discussion avec l'assistant IA (historique, BF-29). |
| **PROMPT** | <u>id_prompt</u>, texte, reponse, statut, date_prompt, #id_utilisateur, #id_edt, #id_conversation | Demande en langage naturel soumise à l'IA et sa réponse, au sein d'une discussion. |
| **PROPOSITION** | <u>id_proposition</u>, description, modifications, impact, statut, date_creation, date_decision, #id_prompt, #id_edt, #id_utilisateur_decision | Modification calculée par le solveur à la demande de l'assistant IA (`modifications` : liste JSON d'opérations ; `impact` : conséquences — heures perdues, enseignants à prévenir, cours qui finissent plus tard, journées chargées, changements de site), `en_attente`, `appliquee` ou `rejetee` par un planificateur. |
| **UTILISATEUR** | <u>id_utilisateur</u>, login, mot_de_passe, email, role, auth_id, est_actif, date_creation, #id_ecole | Comptes : `administrateur` ou `planificateur` d'une école (BF-25), ou `superadmin` de la plateforme (sans école). `auth_id` relie le compte à Supabase Auth ; `mot_de_passe` reste vide. Login unique dans une école, e-mail unique sur la plateforme. |

Toutes les tables métier portent aussi **`#id_ecole`** (école cliente), qui fait partie de chaque clé étrangère ; les codes sont uniques dans une école. L'espace invités reçoit les enseignants **sans leurs coordonnées** : c'est l'API qui retire l'e-mail et le téléphone.

### 7.2 Associations et cardinalités

La notation `a,b` se lit du côté de l'entité nommée en premier.

| Association | Entité A | Entité B | Signification |
|---|---|---|---|
| PLANIFIER | SEANCE (1,1) | COURS (0,n) | Une séance planifie un seul cours ; un cours a de 0 à n séances. |
| SE_DEROULER | SEANCE (1,1) | SALLE (0,n) | Une séance se déroule dans une seule salle. |
| OCCUPER | SEANCE (1,1) | CRENEAU (0,n) | Une séance commence sur un seul créneau. |
| COMPOSER | SEANCE (1,1) | EMPLOI_DU_TEMPS (0,n) | Une séance appartient à un seul emploi du temps. |
| ASSURER | COURS (1,1) | ENSEIGNANT (0,n) | Un cours est assuré par un seul enseignant. |
| HABILITER | ENSEIGNANT (0,n) | MATIERE (0,n) | Association n-n, par type de cours (table `HABILITATION`). |
| S_ABSENTER | ABSENCE_ENSEIGNANT (1,1) | ENSEIGNANT (0,n) | Une absence concerne un seul enseignant. |
| SEJOURNER | SEJOUR_ENSEIGNANT (1,1) | ENSEIGNANT (0,n) | Un séjour concerne un seul enseignant (externe). |
| PORTER_SUR | COURS (1,1) | MATIERE (0,n) | Un cours porte sur une seule matière. |
| CONCERNER | COURS (1,1) | CLASSE (0,n) | Un cours concerne une seule classe. |
| PREVOIR | PROGRAMME (1,1) | CLASSE (0,n) | Une ligne de programme concerne une classe, une matière (0,n) et un semestre (0,n). |
| CIBLER | COURS (0,1) | GROUPE (0,n) | Un cours cible au plus un groupe ; vide = classe entière. Le groupe appartient à la classe du cours. |
| NECESSITER | COURS (0,1) | TYPE_SALLE (0,n) | Un cours peut exiger un type de salle. |
| PROGRAMMER | COURS (1,1) | SEMESTRE (0,n) | Un cours est programmé sur un seul semestre. |
| DECOUPER | COURS (0,n) | COURS_SEANCE_MODELE (1,1) | Un cours est découpé en 0 à n séances types. |
| ETRE_DE_TYPE | SALLE (1,1) | TYPE_SALLE (0,n) | Une salle a un seul type. |
| SE_SITUER | SALLE (1,1) | SITE (0,n) | Une salle se trouve sur un seul site. |
| ETRE_RATTACHEE | FILIERE (0,1) | SITE (0,n) | Une filière peut avoir un site principal. |
| ETRE_AFFECTE | ENSEIGNANT (0,1) | SITE (0,n) | Un enseignant peut être rattaché à un site. |
| DECLARER | ENSEIGNANT (0,n) | CRENEAU (0,n) | Association n-n avec `niveau` et `motif` (table `DISPONIBILITE`). |
| APPARTENIR | CLASSE (1,1) | FILIERE (0,n) | Une classe appartient à une filière. |
| DIVISER | GROUPE (1,1) | CLASSE (0,n) | Un groupe dépend d'une seule classe. |
| SUSPENDRE | CONGE (0,1) | CLASSE (0,n) | Un congé vaut pour une classe, ou pour tout l'établissement si vide. |
| PARAMETRER | CONTRAINTE (1,1) | EMPLOI_DU_TEMPS (0,n) | Une contrainte paramètre un emploi du temps. |
| OUVRIR | CONVERSATION (1,1) | UTILISATEUR (0,n) | Une discussion est ouverte par un utilisateur. |
| APPARTENIR_A | PROMPT (1,1) | CONVERSATION (0,n) | Un prompt appartient à une discussion. |
| MODIFIER | PROMPT (1,1) | EMPLOI_DU_TEMPS (0,n) | Un prompt porte sur un emploi du temps. |
| SOUMETTRE | PROMPT (1,1) | UTILISATEUR (0,n) | Un prompt est soumis par un utilisateur. |
| PRODUIRE | PROPOSITION (1,1) | PROMPT (0,n) | Une proposition est produite en réponse à un prompt. |
| DECIDER | PROPOSITION (0,1) | UTILISATEUR (0,n) | Une proposition est acceptée ou rejetée par un planificateur. |
| COUVRIR | EMPLOI_DU_TEMPS (1,1) | SEMESTRE (0,n) | Un emploi du temps couvre un semestre. |
| CREER | EMPLOI_DU_TEMPS (1,1) | UTILISATEUR (0,n) | Un emploi du temps est créé par un utilisateur. |
| TRAVAILLER_POUR | UTILISATEUR (0,1) | ECOLE (0,n) | Un compte de gestion appartient à une école ; le super administrateur à aucune. |

### 7.3 Règles garanties par la base

Les contrôles applicatifs sont doublés par des contraintes en base :

- **CD-01 (salle)** : contrainte d'exclusion (`EXCLUDE`, extension `btree_gist`) sur `SEANCE` : deux séances d'une même salle ne se chevauchent pas dans un même emploi du temps (séances annulées ignorées).
- **Durée 2 h à 4 h** : contraintes `CHECK` sur `SEANCE`, `duree_seance` et `duree_heures`.
- **Clé étrangère composite** `(id_groupe, id_classe)` sur `COURS` : le groupe ciblé appartient à la classe du cours.
- **Déclencheur sur `COURS`** : un CM ne cible aucun groupe, un cours de TD ou de TP ne cible qu'un groupe du même type ; CD-07, la matière est au programme de la classe et le volume ne dépasse pas celui prévu ; CD-06, l'enseignant est habilité pour la matière et le type du cours.
- **Déclencheur sur `PROGRAMME`** : CD-07 dans l'autre sens, une ligne utilisée par des cours ne peut être ni supprimée ni réduite sous leur volume.
- **Déclencheur sur `SEANCE`** : CD-02, CD-03, CD-04, CD-05, CD-06 (habilitation, absences, séjours, semaine type), CD-08, CD-09 (semestre, jour, jours fériés, congés), CD-10, CD-11, CD-12, CD-13 et CD-14.
- **Contrainte `CHECK` sur `PROPOSITION`** : une proposition décidée (appliquée ou rejetée) a une date de décision, une proposition en attente n'en a pas.
- **Concurrence** : le déclencheur pose un verrou par emploi du temps (`pg_advisory_xact_lock`) ; deux enregistrements simultanés sont traités l'un après l'autre et ne peuvent pas contourner CD-02 ou CD-03.
- **Sécurité par ligne** : voir §6, « Accès à la base ».

### 7.4 Volumétrie estimée

- quelques milliers de lignes pour le référentiel ;
- environ **30 000 à 60 000 séances par an** (ordres de grandeur à confirmer).

### 7.5 Reprise des données

Import des tableurs existants (salles, cours, enseignants, groupes) par des **gabarits CSV** fournis, avec contrôle de qualité et rapport d'anomalies avant chargement. La scolarité valide les données reprises avant la première planification.

### 7.6 Jeu de données de test

Le script SQL contient un jeu de données **fictif** à remplacer par les données réelles. Ses identifiants sont fixes (insertions ordonnées) et identiques à ceux du jeu de démonstration de l'interface :

- 3 sites : **campus de Kamboinsé** (8 salles), **campus de Ouagadougou** (3 salles) et **annexe de Ouagadougou** (2 salles), de 25 à 250 places ;
- 2 filières, 5 classes (de 24 à 120 étudiants), 9 groupes de TD et de TP ;
- 9 enseignants (6 permanents, 2 vacataires locaux, 1 externe attendu du 9 au 28 novembre), 18 habilitations, 8 matières, 9 lignes de programme, 13 cours (de classe entière ou de groupe), avec leur découpage hebdomadaire (par exemple BD : 2 h + 3 h). Trois écarts au programme sont laissés volontairement pour la démonstration : le TD-B de L1INFO (Probabilités), le TP-G2 de M1IA (Apprentissage automatique) et le M2IA, sans cours ;
- la grille de créneaux de 1 h (7 h – 12 h et 13 h – 16 h, samedi matin), la pause déjeuner (12 h – 13 h), 5 jours fériés fixes, 2 congés (vacances de fin d'année, examens), des disponibilités et une absence datée ;
- un semestre (2026-2027), deux comptes (`planificateur`, `admin`), un emploi du temps vide en brouillon et ses 21 contraintes (CD-01 à CD-14, CS-01 à CS-07).

### 7.7 Génération des séances datées

La base enregistre des **séances datées** (`date_seance`). Le solveur travaille en deux étages :

1. **plan des semaines** : pour chaque classe du périmètre, choisir les cours actifs chaque semaine (au plus 3 matières, CD-13) et leur nombre d'heures (rythme borné, CD-14), jusqu'à épuisement des volumes, en tenant compte des congés, absences, séjours et priorités ;
2. **placement de chaque semaine** : affecter créneaux et salles en respectant CD-01 à CD-12.

La duplication d'une semaine type (BF-14) reste disponible pour la planification manuelle.

---

## 8. Planning, lots et livrables

Le projet dure environ **7 mois et demi, de novembre 2026 à juin 2027**, afin que la rentrée de septembre 2027 soit planifiée avec le nouvel outil.

| Lot | Période | Livrables | Validation par |
|---|---|---|---|
| **L0 — Cadrage** | 2 nov. → 27 nov. 2026 | Spécifications détaillées, maquettes des écrans, prototype du moteur sur un département | Comité de pilotage |
| **L1 — Socle et référentiel** | 30 nov. 2026 → 22 janv. 2027 | Socle technique déployé en recette, authentification, écrans du référentiel, imports CSV | Scolarité |
| **L2 — Planification manuelle** | 11 janv. → 5 mars 2027 | Saisie des disponibilités et absences, grille de planification manuelle, contrôles CD-01 à CD-12 | Scolarité |
| **L3 — Moteur IA** | 4 janv. → 2 avr. 2027 | Moteur de génération, paramétrage des poids, rapport des séances non placées | Scolarité |
| **L4 — Consultation, exports** | 1 mars → 16 avr. 2027 | Vues de consultation, exports PDF / Excel / iCalendar, notifications, tableaux de bord | Scolarité, délégués étudiants |
| **L5 — Recette, déploiement** | 12 avr. → 4 juin 2027 | Données reprises, procès-verbal de recette, manuels, formation, mise en production | Comité de pilotage |

**Jalons** : spécifications validées le **27 novembre 2026** ; mise en production le **14 juin 2027**.

Le moteur IA démarre en parallèle de L1 et L2, car c'est le lot le plus risqué. Les dates sont une proposition à ajuster avec la direction des études.

---

## 9. Organisation, charge et risques

### 9.1 Équipe projet

| Rôle | Effectif (ETP) | Responsabilités |
|---|---|---|
| Chef de projet | 0,5 | Pilotage, planning, comités, relation avec la maîtrise d'ouvrage |
| Développeurs full-stack | 2 | API, interface web, base de données, intégrations |
| Ingénieur IA / optimisation | 1 | Modélisation des contraintes, moteur de génération, tests de performance |
| Testeur / recette | 0,5 | Plans de test, recette fonctionnelle, non-régression |
| Référent métier (scolarité) | 0,3 | Expression des besoins, validation des données et de la recette |

Un **comité de pilotage** se réunit une fois par mois. L'équipe fait une **démonstration toutes les deux semaines** (méthode agile Scrum).

### 9.2 Charge estimée

| Lot | Contenu | Charge (jours-homme) |
|---|---|---|
| L0 | Cadrage, spécifications détaillées, maquettes | 15 |
| L1 | Socle technique, authentification, référentiel, imports | 30 |
| L2 | Disponibilités, planification manuelle, contrôles en temps réel | 35 |
| L3 | Moteur de génération automatique | 40 |
| L4 | Consultation, exports, notifications, tableaux de bord | 25 |
| L5 | Reprise des données, recette, formation, mise en production | 25 |
| **Total** | | **170** |

Le coût financier dépend du taux journalier retenu (équipe interne, stagiaires ou prestataire) et reste à fixer avec la direction. L'hébergement s'appuie sur les serveurs de l'université et des logiciels libres, **sans licence payante**.

### 9.3 Risques

| Risque | Probabilité | Impact | Parade |
|---|---|---|---|
| Données de départ incomplètes ou incohérentes (salles, effectifs) | Élevée | Élevé | Gabarits d'import, contrôles automatiques, validation par la scolarité en L1 |
| Disponibilités des enseignants non communiquées à la scolarité | Élevée | Moyen | Date limite, relances, disponibilité par défaut |
| Problème sans solution (trop de contraintes, pas assez de salles) | Moyenne | Élevé | Diagnostic des contraintes bloquantes (BF-18), assouplissement guidé |
| Temps de génération trop long | Moyenne | Moyen | Prototype du moteur dès L0, découpage par département |
| Résistance au changement des planificateurs | Moyenne | Moyen | Ateliers dès le cadrage, formation, planification manuelle conservée |
| Départ d'un membre clé de l'équipe | Faible | Élevé | Documentation, revues de code, binômage |

---

## 10. Recette, acceptation et maintenance

Le système est réceptionné quand **un semestre réel est planifié de bout en bout sans aucune violation de contrainte dure**.

### 10.1 Critères d'acceptation

- 100 % des exigences de priorité M (BF et BNF) sont vérifiées par un cas de test passé.
- Aucune séance enregistrée ne viole les contraintes CD-01 à CD-12, hors CD-07 (contrôle automatique sur toute la base).
- La génération automatique place **au moins 95 %** des séances du semestre test, et explique chaque séance non placée.
- Les objectifs de performance BNF-01 à BNF-03 sont atteints lors d'un test de charge.
- Un test d'intrusion ne révèle aucune faille critique ou majeure.
- Les planificateurs ont été formés et valident l'outil sur un semestre pilote.

### 10.2 Déroulement de la recette

1. Tests unitaires et d'intégration, exécutés automatiquement à chaque modification du code.
2. Recette fonctionnelle par le testeur sur un jeu de données de référence.
3. Recette métier par la scolarité sur les données réelles d'un département pilote.
4. Période pilote d'un semestre, puis généralisation à toute l'université.

### 10.3 Garantie et maintenance

- **Garantie de 3 mois** après la mise en production : correction sans frais des anomalies.
- **Délais de correction** : anomalie bloquante sous 1 jour ouvré, majeure sous 5 jours, mineure à la version suivante.
- **Maintenance évolutive** planifiée par versions semestrielles, hors périodes de rentrée.

### 10.4 Livrables documentaires

Dossier de conception (MCD, MLD, SQL), spécifications détaillées, code source, documentation de l'API, manuel utilisateur par profil, guide d'exploitation, cahier et procès-verbal de recette.

---

## 11. Points d'attention : écarts entre le MLD et le cahier des charges

**Écarts résolus** (schéma version 4) :

- `GROUPE` est relié à `COURS` (CIBLER) ; la règle de parallélisme des groupes est fixée (CD-03).
- `INDISPONIBILITE` est remplacée par `DISPONIBILITE` à trois niveaux, complétée par `ABSENCE_ENSEIGNANT` pour les absences datées.
- Les habilitations existent (`HABILITATION`) et sont contrôlées (CD-06).
- Les sites et bâtiments sont modélisés (`SITE`, `salle.batiment`) ; les filières et les enseignants peuvent y être rattachés.
- Les jours fériés et les congés sont pris en compte (`JOUR_FERIE`, `CONGE`).
- Durée et découpage des séances, pause déjeuner, verrou de concurrence.
- L'authentification passe par le SSO : `mot_de_passe` est facultatif, et seuls les gestionnaires ont un compte.
- Le rôle de la table `PROMPT` est précisé : assistant IA avec historique des discussions (`CONVERSATION`).
- Le programme existe (`PROGRAMME`) et CD-07 est contrôlé dans les deux sens ; l'interface signale les heures non couvertes.
- `GROUPE.type_groupe` n'accepte que `TD` ou `TP` ; un CM vise toujours la classe entière, et un cours de TD ou de TP ne cible qu'un groupe du même type (contrôlé à l'enregistrement du cours).

**Écarts restants**

| # | Constat | Décision |
|---|---|---|
| 1 | **`DEPARTEMENT`** n'existe pas dans le MLD. | Abandonné : sans connexion des chefs de département, il n'est pas nécessaire. Les filières sont regroupées par site. |
| 2 | **Journal d'audit** (BNF-08). | Réalisé : table `JOURNAL_SEANCE` (schéma version 8), page Journal de la console super admin. |
| 3 | **Volumes horaires par type** : un cours porte un seul `type_cours` et un seul `volume_horaire`. | Suffisant : un cours par type (CM, TD, TP). |
| 4 | `seance.id_creneau` se déduit de `date_seance` et `heure_debut` ; `prompt.id_edt` double `conversation.id_edt`. | Redondances assumées, cohérence assurée par CD-10 ; `prompt.id_edt` pourra être supprimé. |

---

## 12. Décisions

| # | Sujet | Choix retenu | Statut |
|---|---|---|---|
| 1 | **Grille de créneaux** | Créneaux de 1 h : 7 h – 12 h et 13 h – 16 h du lundi au vendredi, 7 h – 12 h le samedi. | Décidé |
| 2 | **Pause déjeuner** | 12 h – 13 h, aucune séance ne l'enjambe (modifiable dans `PAUSE`). | Décidé |
| 3 | **Accès** | Seuls les administrateurs et planificateurs ont un compte ; enseignants et étudiants consultent sans connexion tous les emplois du temps publiés. | Décidé |
| 4 | **Groupes en parallèle** | Autorisé seulement entre deux groupes différents du même type, dans des salles différentes et avec des enseignants différents. | Décidé |
| 5 | **Sites** | Campus et annexes gérés dans le référentiel ; chaque salle a un site ; filières et enseignants peuvent en avoir un. | Décidé |
| 6 | **Congés** | Table `CONGE` distincte de `JOUR_FERIE`, pour tout l'établissement ou une classe. | Décidé |
| 7 | **Séances datées** | La base stocke des séances datées. Le solveur les calcule directement semaine par semaine (jours fériés, congés, séjours des externes, rythme variable), sans semaine type à dérouler. | Décidé |
| 8 | **Jours fériés mobiles** (fêtes religieuses, Pâques, Ascension, Pentecôte) | Saisis chaque année par l'école dans la console (Référentiel > Jours fériés), qui peut aussi les modifier ou en ajouter ; le jeu de test ne fournit que les jours fixes. Un jour non saisi n'est pas connu du solveur. | Décidé |
| 9 | **Volume horaire** | En heures, pour tout le semestre ; pour un TD ou un TP fait par groupes, le volume vaut pour chaque groupe. Le découpage (`COURS_SEANCE_MODELE`) donne les durées de séance préférées. | Décidé |
| 10 | **Capacités, effectifs, habilitations** | Valeurs fictives dans le jeu de test. | À remplacer par les données réelles |
| 11 | **Hébergement** | Le cahier des charges prévoit les serveurs de l'université ; le schéma est déployé sur Supabase. | À confirmer avec le service informatique |
| 12 | **Journal d'audit** | Séances seulement (création, modification, suppression), avec le compte, l'origine (console, génération, assistant, système) et l'état avant / après ; consultable par le super admin. Les changements du référentiel ne sont pas journalisés. | Décidé et réalisé |
| 13 | **Programme** | Maquette par classe, matière et semestre, avec volumes CM / TD / TP ; un volume de TD ou de TP vaut pour chaque groupe. | Décidé |
| 14 | **Enseignement par modules** | Au plus 3 matières par classe et par semaine (CM, TD, TP d'une matière = 1 ; examens exclus) ; un cours se poursuit jusqu'à épuisement de son volume. | Décidé |
| 15 | **Statut des enseignants** | Externe : séjours datés connus à l'avance, cours ramassés ; permanent : cours enchaînés ; vacataire local : selon ses disponibilités. | Décidé |
| 16 | **Rythme hebdomadaire** | Libre entre un minimum et un maximum par cours (2 h et 15 h par défaut). | Décidé |
| 17 | **Priorités** | Proposées par l'assistant IA avec justification, validées par la scolarité ; préférences (CS-07), jamais des contraintes dures. | Décidé |
| 18 | **Assistant IA** | Agent LLM avec outils ; il passe toujours par le solveur et ses propositions sont validées par un planificateur avant application. | Décidé |
| 19 | **Multi-écoles** | Une seule base ; table `ECOLE` et colonne `id_ecole` sur chaque table métier, avec clés étrangères composites. RLS par école pour le rôle `ultraplanning_app` de l'API ; aucun accès direct pour `anon` et `authenticated`. Une nouvelle école reçoit sa grille et ses types de salle à sa création, puis crée son premier semestre dans la console. | Décidé et réalisé (schéma version 7) |
| 20 | **Authentification** | Supabase Auth : le super admin invite par e-mail, la personne choisit son mot de passe ; l'API vérifie le jeton (JWKS). En-tête `X-Utilisateur` réservé au développement (`ULTRAPLANNING_AUTH_DEV=1`). | Décidé |
| 21 | **Console super admin** | Application séparée (`superadmin/`), même conception graphique que la console des écoles. | Décidé |
