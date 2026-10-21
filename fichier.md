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
| Référentiel : départements, filières, groupes, cours, salles, bâtiments, créneaux | Inscriptions pédagogiques individuelles des étudiants |
| Saisie des disponibilités par les enseignants | Planification des examens et surveillances |
| Planification manuelle et génération automatique | Paie et calcul des heures complémentaires |
| Consultation des emplois du temps (web, mobile, export) | Gestion des notes |
| Tableaux de bord : occupation des salles, volumes horaires | Réservation de salles par des acteurs externes |

Les éléments hors périmètre pourront faire l'objet d'une version 2.

---

## 2. Acteurs et parties prenantes

Cinq profils utilisent le système, chacun avec des droits limités à son rôle.

| Acteur | Rôle dans le système | Droits principaux |
|---|---|---|
| **Administrateur** | Gère les comptes, les rôles et le paramétrage | Tous les droits techniques |
| **Service de la scolarité (planificateur)** | Construit et publie les emplois du temps | Référentiel complet, planification, publication |
| **Chef de département** | Valide les cours, volumes horaires et habilitations de son département | Lecture et validation sur son département |
| **Enseignant** | Déclare ses disponibilités, consulte son emploi du temps | Ses disponibilités, son planning, signalements |
| **Étudiant / délégué** | Consulte l'emploi du temps de son groupe | Lecture seule |

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
| BF-01 | Créer, modifier, archiver les départements, filières (avec niveau L1…M2) et groupes (avec effectif) | M |
| BF-02 | Gérer les cours : code, intitulé, crédits ECTS, semestre, département | M |
| BF-03 | Saisir le volume horaire de chaque cours par type de séance (CM, TD, TP) | M |
| BF-04 | Gérer les bâtiments, salles (capacité, étage) et types de salle ; associer à chaque type de séance le type de salle exigé | M |
| BF-05 | Définir la grille des créneaux hebdomadaires (jour, heure de début, heure de fin) | M |
| BF-06 | Rattacher les cours au programme des filières | M |
| BF-07 | Importer le référentiel depuis des fichiers Excel/CSV, avec rapport d'erreurs | S |

### 3.2 Module Enseignants

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-08 | Gérer les enseignants (grade, département, coordonnées) et leurs habilitations par cours | M |
| BF-09 | Permettre à chaque enseignant de saisir ses disponibilités par créneau : disponible, préférence, indisponible | M |
| BF-10 | Fixer une date limite de saisie et relancer automatiquement les retardataires | S |

### 3.3 Module Planification

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-11 | Créer, déplacer, annuler une séance par glisser-déposer sur une grille hebdomadaire | M |
| BF-12 | Contrôler en temps réel chaque séance et afficher le motif de tout refus (conflit, capacité, type de salle, indisponibilité) | M |
| BF-13 | Proposer les salles et créneaux compatibles pour une séance donnée | S |
| BF-14 | Dupliquer une semaine type sur toute la période du semestre | M |

### 3.4 Module Génération automatique

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-15 | Générer un emploi du temps complet qui respecte toutes les contraintes dures et optimise les contraintes souples | M |
| BF-16 | Pondérer les contraintes souples (préférences, journées compactes, déplacements entre bâtiments) | S |
| BF-17 | Verrouiller des séances avant génération et ne recalculer que le reste | S |
| BF-18 | Expliquer les séances non placées (contrainte bloquante identifiée) | S |

### 3.5 Module Publication

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-19 | Valider puis publier un emploi du temps ; garder l'historique des versions | M |
| BF-20 | Notifier par e-mail les enseignants et groupes concernés par un changement publié | S |

### 3.6 Module Consultation

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-21 | Afficher l'emploi du temps par groupe, enseignant, salle ou filière, en vue jour, semaine ou semestre | M |
| BF-22 | Exporter en PDF, Excel et iCalendar (abonnement agenda) | S |

### 3.7 Tableaux de bord et administration

| Réf. | Exigence | Priorité |
|---|---|---|
| BF-23 | Suivre les heures planifiées / prévues par cours, type et groupe | M |
| BF-24 | Suivre le taux d'occupation des salles et la charge des enseignants | C |
| BF-25 | Gérer les comptes, rôles et le journal d'audit des modifications | M |
| BF-26 | Ouvrir et clôturer une année universitaire et ses semestres | M |

---

## 4. Règles métier et contraintes de planification

Une séance n'est enregistrée que si **toutes les contraintes dures sont respectées**. Les contraintes souples servent à **classer les solutions valides**.

### 4.1 Contraintes dures (jamais violées)

| Réf. | Contrainte |
|---|---|
| CD-01 | Une salle accueille au plus une séance par date et par créneau. |
| CD-02 | Un enseignant anime au plus une séance par date et par créneau. |
| CD-03 | Un groupe suit au plus une séance par date et par créneau. |
| CD-04 | La capacité de la salle est supérieure ou égale à l'effectif du groupe. |
| CD-05 | Le type de la salle correspond au type exigé par la séance (CM en amphithéâtre, TP en laboratoire, etc.). |
| CD-06 | L'enseignant est habilité pour le cours et n'est pas déclaré indisponible sur le créneau. |
| CD-07 | Le cours figure au programme de la filière du groupe. |
| CD-08 | Le cumul des séances d'un cours et d'un type pour un groupe ne dépasse pas le volume horaire prévu. |
| CD-09 | La date de la séance tombe le jour de la semaine du créneau et dans les dates du semestre. |

### 4.2 Contraintes souples (optimisées)

| Réf. | Contrainte | Poids par défaut |
|---|---|---|
| CS-01 | Placer les séances sur les créneaux marqués « préférence » par l'enseignant | Élevé |
| CS-02 | Éviter les trous dans la journée d'un groupe | Moyen |
| CS-03 | Limiter les changements de bâtiment entre deux séances consécutives | Moyen |
| CS-04 | Répartir les heures d'un cours de manière régulière sur le semestre | Moyen |
| CS-05 | Placer le CM d'un cours avant ses TD et TP dans la semaine | Faible |
| CS-06 | Ne pas dépasser un nombre maximal d'heures par jour pour un enseignant (paramétrable) | Faible |

Les poids sont **paramétrables par le planificateur avant chaque génération** (BF-16). Dans le MLD, ils sont portés par la table `CONTRAINTE` (attributs `nature`, `poids`, `est_active`).

---

## 5. Besoins non fonctionnels

| Réf. | Domaine | Exigence | Cible |
|---|---|---|---|
| BNF-01 | Performance | Temps de réponse d'un écran de consultation | < 2 s pour 95 % des requêtes |
| BNF-02 | Performance | Contrôle d'une séance lors d'un déplacement manuel | < 500 ms |
| BNF-03 | Performance | Génération d'un semestre (≈ 200 groupes, 400 enseignants, 150 salles) | < 15 min |
| BNF-04 | Montée en charge | Utilisateurs simultanés, notamment le jour de publication | 1 000 |
| BNF-05 | Disponibilité | Disponibilité du service en période de cours | 99,5 % |
| BNF-06 | Sécurité | Authentification unique via l'annuaire de l'université (LDAP / CAS / SSO) | Obligatoire |
| BNF-07 | Sécurité | Contrôle d'accès par rôle et par département ; HTTPS partout ; mots de passe hachés | Obligatoire |
| BNF-08 | Traçabilité | Journal d'audit de toute création, modification ou suppression de séance | Conservation 3 ans |
| BNF-09 | Données personnelles | Conformité à la réglementation nationale sur la protection des données ; minimisation des données enseignants | Obligatoire |
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

### Choix technologiques

| Couche | Choix proposé | Justification |
|---|---|---|
| Interface | React + TypeScript, interface responsive | Grille interactive par glisser-déposer, une seule base de code pour ordinateur et mobile |
| Serveur | Python 3.12 + FastAPI | Même langage que le moteur d'optimisation, documentation OpenAPI automatique |
| Moteur de génération | Google OR-Tools (solveur CP-SAT) | Solveur libre et performant pour les problèmes d'emploi du temps à contraintes |
| Tâches de fond | Celery + Redis | Générations longues exécutées hors requête, suivi de l'avancement |
| Base de données | PostgreSQL 16 | Contraintes, déclencheurs et contraintes d'exclusion déjà prévus dans le MLD |
| Authentification | CAS / LDAP de l'université, jetons JWT | Pas de nouveaux mots de passe pour les utilisateurs |
| Déploiement | Docker, Nginx, intégration continue GitLab CI | Environnements identiques en test et en production |
| Supervision | Prometheus + Grafana, journaux centralisés | Suivi de la disponibilité (BNF-05) et des temps de réponse |

Trois environnements sont prévus : **développement, recette et production**.

---

## 7. Modèle de données (MLD)

Convention : <u>souligné</u> = clé primaire, `#` = clé étrangère.

Le MLD couvre deux grands domaines : la **planification pédagogique** (séances, cours, salles, enseignants, classes) et la **génération automatique** (emplois du temps, contraintes, prompts, utilisateurs).

### 7.1 Tables du MLD

#### Cœur de la planification

| Table | Attributs | Rôle |
|---|---|---|
| **SEANCE** | <u>id_seance</u>, date_seance, statut, est_verrouillee, #id_cours, #id_salle, #id_creneau, #id_edt | Table centrale : une occurrence datée d'un cours, dans une salle, sur un créneau, rattachée à un emploi du temps. `est_verrouillee` supporte BF-17. |
| **COURS** | <u>id_cours</u>, type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite, #id_matiere, #id_classe, #id_enseignant, #id_type_salle, #id_semestre | Enseignement d'une matière, pour une classe, par un enseignant, avec un type de salle exigé, sur un semestre. |
| **MATIERE** | <u>id_matiere</u>, code_matiere, libelle, coefficient | Référentiel des matières. |
| **ENSEIGNANT** | <u>id_enseignant</u>, matricule, nom, prenom, email, telephone, grade, nb_heures_max_semaine | Enseignants et leur plafond horaire hebdomadaire (CS-06). |
| **CRENEAU** | <u>id_creneau</u>, jour, heure_debut, heure_fin | Grille hebdomadaire des créneaux (BF-05). |
| **INDISPONIBILITE** | <u>#id_enseignant</u>, <u>#id_creneau</u>, motif | Table associative : créneaux où un enseignant est indisponible (clé primaire composée). |

#### Structure des publics et des locaux

| Table | Attributs | Rôle |
|---|---|---|
| **FILIERE** | <u>id_filiere</u>, code_filiere, libelle | Filière de formation. |
| **CLASSE** | <u>id_classe</u>, code_classe, libelle, niveau, effectif, #id_filiere | Classe appartenant à une filière. |
| **GROUPE** | <u>id_groupe</u>, code_groupe, type_groupe, effectif, #id_classe | Subdivision d'une classe (par exemple groupes de TD/TP). *Table ajoutée.* |
| **SALLE** | <u>id_salle</u>, code_salle, nom_salle, capacite, batiment, est_disponible, #id_type_salle | Salle avec sa capacité (CD-04) et son type (CD-05). |
| **TYPE_SALLE** | <u>id_type_salle</u>, libelle | Amphithéâtre, laboratoire, salle standard, etc. |
| **SEMESTRE** | <u>id_semestre</u>, libelle, annee_academique, date_debut, date_fin | Période de validité des séances (CD-09, BF-26). |

#### Génération automatique et pilotage

| Table | Attributs | Rôle |
|---|---|---|
| **EMPLOI_DU_TEMPS** | <u>id_edt</u>, libelle, version, mode_generation, statut, date_creation, date_publication, #id_semestre, #id_utilisateur | Une version d'emploi du temps (manuelle ou automatique), avec son statut de publication (BF-19). |
| **CONTRAINTE** | <u>id_contrainte</u>, libelle, type_contrainte, nature, poids, est_active, #id_edt | Contraintes (dures ou souples) paramétrées pour un emploi du temps (BF-16). |
| **PROMPT** | <u>id_prompt</u>, texte, reponse, statut, date_prompt, #id_utilisateur, #id_edt | Demandes en langage naturel soumises à l'IA pour modifier un emploi du temps, et réponses associées. |
| **UTILISATEUR** | <u>id_utilisateur</u>, login, mot_de_passe, email, role | Comptes et rôles (BF-25). |

### 7.2 Associations et cardinalités

La notation `a,b` se lit du côté de l'entité nommée en premier.

| Association | Entité A | Entité B | Signification |
|---|---|---|---|
| PLANIFIER | SEANCE (1,1) | COURS (0,n) | Une séance planifie un seul cours ; un cours a de 0 à n séances. |
| SE_DEROULER | SEANCE (1,1) | SALLE (0,n) | Une séance se déroule dans une seule salle. |
| OCCUPER | SEANCE (1,1) | CRENEAU (0,n) | Une séance occupe un seul créneau. |
| COMPOSER | SEANCE (1,1) | EMPLOI_DU_TEMPS (0,n) | Une séance appartient à un seul emploi du temps. |
| ASSURER | COURS (1,1) | ENSEIGNANT (0,n) | Un cours est assuré par un seul enseignant. |
| PORTER_SUR | COURS (1,1) | MATIERE (0,n) | Un cours porte sur une seule matière. |
| CONCERNER | COURS (1,1) | CLASSE (1,n) | Un cours concerne une seule classe. |
| NECESSITER | COURS (0,1) | TYPE_SALLE (0,n) | Un cours peut exiger un type de salle. |
| PROGRAMMER | COURS (1,1) | SEMESTRE (0,n) | Un cours est programmé sur un seul semestre. |
| ETRE_DE_TYPE | SALLE (1,1) | TYPE_SALLE (0,n) | Une salle a un seul type. |
| ETRE_INDISPONIBLE | ENSEIGNANT (0,n) | CRENEAU (0,n) | Association n-n avec l'attribut `motif`. |
| APPARTENIR | CLASSE (1,1) | FILIERE (1,n) | Une classe appartient à une filière. |
| **DIVISER** | CLASSE (0,n) | GROUPE (1,1) | Une classe se divise en 0 à n groupes ; un groupe dépend d'une seule classe. |
| PARAMETRER | CONTRAINTE (1,1) | EMPLOI_DU_TEMPS (0,n) | Une contrainte paramètre un emploi du temps. |
| MODIFIER | PROMPT (1,1) | EMPLOI_DU_TEMPS (0,n) | Un prompt modifie un emploi du temps. |
| SOUMETTRE | PROMPT (1,1) | UTILISATEUR (0,n) | Un prompt est soumis par un utilisateur. |
| COUVRIR | EMPLOI_DU_TEMPS (1,1) | SEMESTRE (0,n) | Un emploi du temps couvre un semestre. |
| CREER | EMPLOI_DU_TEMPS (1,1) | UTILISATEUR (0,n) | Un emploi du temps est créé par un utilisateur. |

### 7.3 Règles garanties par la base

Le cahier des charges prévoit de doubler les contrôles applicatifs par des contraintes en base :

- **trois contraintes d'unicité** sur `SEANCE` : salle, enseignant, groupe, par date et créneau (CD-01 à CD-03) ;
- **un déclencheur** contrôlant les règles CD-04 à CD-09 (capacité, type de salle, habilitation, programme, volume horaire, dates).

### 7.4 Volumétrie estimée

- quelques milliers de lignes pour le référentiel ;
- environ **30 000 à 60 000 séances par an** (ordres de grandeur à confirmer).

### 7.5 Reprise des données

Import des tableurs existants (salles, cours, enseignants, groupes) par des **gabarits CSV** fournis, avec contrôle de qualité et rapport d'anomalies avant chargement. La scolarité valide les données reprises avant la première planification.

---

## 8. Planning, lots et livrables

Le projet dure environ **7 mois et demi, de novembre 2026 à juin 2027**, afin que la rentrée de septembre 2027 soit planifiée avec le nouvel outil.

| Lot | Période | Livrables | Validation par |
|---|---|---|---|
| **L0 — Cadrage** | 2 nov. → 27 nov. 2026 | Spécifications détaillées, maquettes des écrans, prototype du moteur sur un département | Comité de pilotage |
| **L1 — Socle et référentiel** | 30 nov. 2026 → 22 janv. 2027 | Socle technique déployé en recette, authentification, écrans du référentiel, imports CSV | Scolarité |
| **L2 — Planification manuelle** | 11 janv. → 5 mars 2027 | Saisie des disponibilités, grille de planification manuelle, contrôles CD-01 à CD-09 | Scolarité, enseignants pilotes |
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
| Enseignants qui ne saisissent pas leurs disponibilités | Élevée | Moyen | Date limite, relances automatiques, disponibilité par défaut |
| Problème sans solution (trop de contraintes, pas assez de salles) | Moyenne | Élevé | Diagnostic des contraintes bloquantes (BF-18), assouplissement guidé |
| Temps de génération trop long | Moyenne | Moyen | Prototype du moteur dès L0, découpage par département |
| Résistance au changement des planificateurs | Moyenne | Moyen | Ateliers dès le cadrage, formation, planification manuelle conservée |
| Départ d'un membre clé de l'équipe | Faible | Élevé | Documentation, revues de code, binômage |

---

## 10. Recette, acceptation et maintenance

Le système est réceptionné quand **un semestre réel est planifié de bout en bout sans aucune violation de contrainte dure**.

### 10.1 Critères d'acceptation

- 100 % des exigences de priorité M (BF et BNF) sont vérifiées par un cas de test passé.
- Aucune séance enregistrée ne viole les contraintes CD-01 à CD-09 (contrôle automatique sur toute la base).
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

En croisant les deux documents, plusieurs écarts apparaissent. Ils sont à arbitrer avant le développement.

| # | Constat | Piste |
|---|---|---|
| 1 | Le cahier des charges (§7) annonce **15 relations** : `DEPARTEMENT`, `TYPE_SEANCE`, `VOLUME_HORAIRE`, `BATIMENT`, `PROGRAMME`, `HABILITATION`, `DISPONIBILITE`, etc. Le MLD actuel est organisé différemment (par exemple, `batiment` est un simple attribut de `SALLE`). | Aligner le MLD sur la liste du cahier des charges, ou mettre à jour le cahier des charges. |
| 2 | **`DEPARTEMENT`** figure dans le MCD et dans le cahier des charges (BF-01, BF-02, BF-08), mais pas dans le MLD. | Ajouter la table et ses clés étrangères (filière, enseignant). |
| 3 | **Habilitations** enseignant–cours (CD-06, BF-08) et **programme** filière–cours (CD-07, BF-06) : aucune table correspondante dans le MLD. | Ajouter `HABILITATION` et `PROGRAMME`. |
| 4 | **Disponibilités à trois niveaux** (disponible / préférence / indisponible, BF-09, CS-01) : le MLD ne modélise que `INDISPONIBILITE` avec un `motif`. | Remplacer par `DISPONIBILITE` avec un attribut de niveau. |
| 5 | **`GROUPE` n'est lié ni à `COURS` ni à `SEANCE`**. Or CD-03 (un groupe, une séance par créneau) et CD-08 (volume horaire par groupe) portent sur le groupe. | Relier `SEANCE` (ou `COURS`) à `GROUPE`. |
| 6 | **Volumes horaires par type (CM/TD/TP)** : le MLD stocke un seul `volume_horaire` et un `type_cours` par cours (BF-03). | Introduire `TYPE_SEANCE` et `VOLUME_HORAIRE`. |
| 7 | **Authentification** : le cahier des charges impose le SSO (BNF-06, « pas de nouveaux mots de passe »), alors que `UTILISATEUR` contient `mot_de_passe`. | Retirer ou rendre optionnel `mot_de_passe`. |
| 8 | **Rôles, audit, année universitaire** : le cahier des charges prévoit des tables `ROLE` et d'audit (BNF-08, BF-25) ; `role` n'est qu'un attribut de `UTILISATEUR`. | Ajouter `ROLE` et une table d'audit. |
| 9 | **Table `PROMPT`** : l'usage d'un prompt en langage naturel n'apparaît pas dans les exigences du cahier des charges (le moteur décrit est OR-Tools CP-SAT). | Préciser son rôle (assistant de modification, journal des demandes) dans les spécifications détaillées. |
| 10 | `COURS` a une cardinalité `1,n` côté `CLASSE` pour l'association CONCERNER, ce qui laisse penser qu'un cours peut concerner plusieurs classes alors que `#id_classe` n'en porte qu'une. | Vérifier la cardinalité réelle du côté `COURS`. |
