-- =====================================================================
--  Système de planification des cours et de génération automatique
--  des emplois du temps
--  Script de création de la base de données — PostgreSQL / Supabase
--  VERSION 13
--
--  Utilisation : Supabase > SQL Editor > New query > coller > Run
--  Source      : fichier.md (section 7 : modèle de données / MLD)
--
--  Changements de la version 2
--   1. GROUPE relié à COURS (cours.id_groupe, nullable = classe entière) ;
--      CD-04 raisonne au niveau du groupe.
--   2. Durées de séance 2 h à 4 h : grille de créneaux fine (1 h),
--      SEANCE porte heure_debut / heure_fin, détection de chevauchement
--      réelle (EXCLUDE + btree_gist), table COURS_SEANCE_MODELE
--      (découpage d'un cours), table PAUSE (pause déjeuner).
--   3. INDISPONIBILITE remplacée par DISPONIBILITE (3 niveaux).
--   4. Jeu de données de test fictif (section 9).
--   5. Table JOUR_FERIE, prise en compte dans CD-09.
--
--  Changements de la version 3
--   6. Table CONGE (vacances, examens, stage) : périodes sans cours, pour
--      tout l'établissement ou une seule classe ; contrôlée par CD-09.
--   7. CD-03 : une classe ne suit pas deux séances en même temps, sauf deux
--      groupes DIFFÉRENTS du MÊME type (ex. TP-G1 et TP-G2), qui peuvent être
--      en parallèle dans des salles et avec des enseignants différents
--      (garantis par CD-01 et CD-02). Un CM bloque toute la classe ; un TD
--      et un TP ne sont jamais en parallèle.
--   8. Seuls les administrateurs et planificateurs ont un compte ; les
--      enseignants et étudiants consultent sans connexion (espace invités,
--      lecture publique des emplois du temps publiés).
--   9. Tables CONVERSATION / PROMPT : historique de l'assistant IA.
--
--  Changements de la version 4
--  10. Table SITE (campus et annexes de l'école) : chaque salle appartient à
--      un site ; filières et enseignants peuvent y être rattachés.
--  11. (Table HABILITATION, supprimée en version 10.)
--  12. Table ABSENCE_ENSEIGNANT (absences datées : mission, congé...), CD-06.
--  13. CD-12 : une salle marquée indisponible ne reçoit aucune séance.
--      CD-09 : le cours doit appartenir au semestre de l'emploi du temps.
--  14. Verrou par emploi du temps dans le déclencheur : deux enregistrements
--      simultanés ne peuvent plus contourner CD-02 / CD-03.
--  15. GROUPE : type TD ou TP seulement. COURS : un CM vise la classe entière ;
--      un cours de TD ou de TP ne cible qu'un groupe du même type.
--  16. Table PROGRAMME (maquette pédagogique : volumes CM / TD / TP prévus
--      par classe, matière et semestre) ; CD-07 contrôlé à l'enregistrement
--      d'un cours.
--
--  Changements de la version 5 (enseignement par modules)
--  17. ENSEIGNANT.statut (permanent, vacataire_local, externe) et table
--      SEJOUR_ENSEIGNANT : un intervenant externe n'enseigne que pendant
--      ses séjours prévus (CD-06).
--  18. COURS : rythme hebdomadaire borné (heures_semaine_min / max, CD-14)
--      et priorité suggérée par l'assistant IA (priorite_suggeree).
--  19. CD-13 : au plus N matières différentes par classe et par semaine
--      (N = 3, porté par CONTRAINTE.valeur ; examens non concernés).
--  20. Table PROPOSITION : modifications proposées par l'assistant IA, avec
--      leur analyse d'impact, appliquées seulement après validation d'un
--      planificateur.
--  21. Les contraintes de l'emploi du temps de travail sont insérées.
--
--  Changements de la version 6 (plateforme multi-écoles)
--  22. Table ECOLE (établissements clients) et rôle superadmin : le super
--      admin crée les écoles et leurs comptes administrateurs.
--      UTILISATEUR : id_ecole (aucune pour le super admin), auth_id (compte
--      Supabase Auth, connexion par e-mail), est_actif ; login unique par
--      école. Le rattachement des données métier à une école (id_ecole sur
--      chaque table) est l'étape suivante.
--      Base existante en version 5 : migrations/006_ecoles.sql.
--
--  Changements de la version 7 (isolation entre écoles, sécurité)
--  23. id_ecole sur chaque table métier ; clés étrangères composites
--      (colonnes, id_ecole) : une ligne ne désigne jamais une ligne d'une
--      autre école ; codes uniques dans l'école.
--  24. RLS par école pour le rôle ultraplanning_app, que l'API prend pour
--      chaque compte d'école (section 7) ; plus aucun droit pour anon et
--      authenticated : tout passe par l'API. Vue enseignant_public retirée.
--  25. initialiser_ecole() (grille et types de salle d'une nouvelle école)
--      et contraintes_par_defaut() (contraintes d'un nouvel emploi du temps).
--      Base existante en version 6 : migrations/007_isolation_ecoles.sql.
--
--  Changements de la version 8
--  26. Table JOURNAL_SEANCE (BNF-08) : journal d'audit des séances, écrit
--      par un déclencheur, consultable par le super admin seulement.
--      Base existante en version 7 : migrations/008_journal_audit.sql.
--
--  Changements de la version 9
--  27. Table PIECE_JOINTE : fichiers joints aux messages de l'assistant IA.
--      PROPOSITION.nature ('seances' ou 'referentiel') et PROPOSITION.suite :
--      l'assistant propose aussi des ajouts au référentiel, puis une génération.
--      Base existante en version 8 : migrations/009_pieces_jointes.sql.
--
--  Changements de la version 10
--  28. L'enseignant est porté par chaque SEANCE (seance.id_enseignant, vide
--      possible) ; COURS.id_enseignant devient l'enseignant prévu, facultatif,
--      repris par défaut à la génération. Table HABILITATION supprimée : plus
--      de contrôle d'habilitation. Un enseignant renseigné reste contrôlé
--      (CD-02, absences, séjours, disponibilités).
--      Base existante en version 9 : migrations/010_enseignant_par_seance.sql.
--
--  Changements de la version 11 (moteur v3 de Soraya Pitroipa, règles 2iE)
--  29. CLASSE.id_site (site où la promotion a tous ses cours) et niveaux
--      CPGE1, CPGE2, BT, MAN, AUTRE ; GROUPE de type OPTION et groupe parent
--      (demi-groupe de TP dans un TD, sous-option) ; COURS_PUBLIC (cours
--      mutualisés) ; COURS_TYPE_SALLE (types de salle acceptés) ;
--      SALLE_RESERVATION (salles réservées à certaines formations) ;
--      SITE_TRAJET (temps de trajet entre sites) ; CONTRAINTE.parametres,
--      date_debut, date_fin (règles du planificateur saisies comme données).
--      Contrôles des séances : CD-03 avec l'arbre des groupes et les publics
--      mutualisés, CD-04 sur l'effectif de tous les publics, CD-05 avec les
--      types acceptés, site de la promotion, salle réservée (CD-12), CD-13
--      pour chaque promotion du cours.
--      Base existante en version 10 : migrations/011_regles_2ie.sql.
--
--  Changements de la version 12 (versions de l'emploi du temps)
--  30. Une version à jour par semestre, seule modifiable, et sa copie publiée,
--      celle que voient les invités, qui ne change que par une publication
--      (déclencheur proteger_seance_publiee). PUBLICATION_EDT garde chaque
--      publication. L'historique se lit dans le journal des séances, une
--      version par transaction (fonctions versions_edt et seances_version,
--      limitées à l'école de la requête). JOURNAL_SEANCE.note : motif du
--      changement (proposition de l'assistant, restauration).
--      Base existante en version 11 : migrations/012_versions_edt.sql.
--
--  Changements de la version 13 (examens et rattrapages)
--  31. SEANCE.nature : cours, examen ou rattrapage. Une épreuve dure de 2 h à
--      3 h, sans enseignant, et ne compte ni dans le volume ni dans le rythme
--      du cours ni dans les matières de la semaine (CD-08, CD-13, CD-14). Elle
--      concerne toute la classe, peut avoir lieu pendant un congé de type
--      « examens », et plusieurs épreuves peuvent partager une salle assez
--      grande (jamais une épreuve et un cours). Dans un module, le rattrapage
--      vient toujours après l'examen.
--      Base existante en version 12 : migrations/013_examens.sql.
--
--  Hypothèses :
--   * volume_horaire (COURS) et durées sont exprimés en HEURES.
--   * La grille de base est de 1 h (modifiable : voir section 9).
--   * Grille : 7h-12h et 13h-16h du lundi au vendredi, 7h-12h le samedi ;
--     pause déjeuner 12h-13h (À CONFIRMER avec la scolarité).
--   * Les données de la section 9 sont FICTIVES : capacités, noms et
--     volumes sont à remplacer par les valeurs réelles.
-- =====================================================================

-- Nettoyage (permet de relancer le script à zéro) ---------------------
DROP TABLE IF EXISTS
    publication_edt, journal_seance, seance, piece_jointe, prompt, conversation, cours_public, cours_type_salle,
    salle_reservation, site_trajet, contrainte, conge, indisponibilite, disponibilite,
    proposition, sejour_enseignant, absence_enseignant, habilitation, cours_seance_modele, cours, programme, groupe, classe,
    filiere, emploi_du_temps, utilisateur, semestre, salle, type_salle, creneau,
    pause, jour_ferie, matiere, enseignant, site, ecole
CASCADE;
DROP FUNCTION IF EXISTS verifier_seance() CASCADE;
DROP FUNCTION IF EXISTS verifier_cours() CASCADE;
DROP FUNCTION IF EXISTS verifier_programme() CASCADE;
DROP FUNCTION IF EXISTS initialiser_ecole(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS contraintes_par_defaut(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS identifiant_pris(TEXT, BIGINT) CASCADE;
DROP FUNCTION IF EXISTS journaliser_seance() CASCADE;
DROP FUNCTION IF EXISTS proteger_seance_publiee() CASCADE;
DROP FUNCTION IF EXISTS publics_seance(BIGINT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS garder_examen(BIGINT, BIGINT, BIGINT) CASCADE;
DROP FUNCTION IF EXISTS examen_avec_rattrapage() CASCADE;
DROP FUNCTION IF EXISTS versions_edt(BIGINT) CASCADE;
DROP FUNCTION IF EXISTS seances_version(BIGINT, TIMESTAMPTZ) CASCADE;
DROP FUNCTION IF EXISTS app_ecole() CASCADE;

-- Extension nécessaire aux contraintes d'exclusion (chevauchements)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- =====================================================================
--  1. TABLES DE RÉFÉRENCE
-- =====================================================================

-- Établissements clients de la plateforme. Gérés par le super admin ; chaque
-- compte de gestion appartient à une école.
CREATE TABLE ecole (
    id_ecole       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_ecole     TEXT NOT NULL UNIQUE,
    nom            TEXT NOT NULL,
    ville          TEXT,
    pays           TEXT,
    email_contact  TEXT,
    -- une école suspendue ne peut plus se connecter
    statut         TEXT NOT NULL DEFAULT 'active'
                   CHECK (statut IN ('active','suspendue')),
    date_creation  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campus et annexes de l'école. Les salles y sont rattachées ; filières et
-- enseignants peuvent l'être aussi (aide à la programmation, CS-03).
CREATE TABLE site (
    id_site    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_site  TEXT NOT NULL UNIQUE,
    nom_site   TEXT NOT NULL,
    type_site  TEXT NOT NULL DEFAULT 'campus'
               CHECK (type_site IN ('campus','annexe')),
    adresse    TEXT
);

CREATE TABLE filiere (
    id_filiere    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_filiere  TEXT NOT NULL UNIQUE,
    libelle       TEXT NOT NULL,
    -- site principal de la filière (facultatif)                 -- ETRE_RATTACHEE
    id_site       BIGINT REFERENCES site(id_site)
                  ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE classe (
    id_classe    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_classe  TEXT NOT NULL UNIQUE,
    libelle      TEXT NOT NULL,
    niveau       TEXT NOT NULL
                 CHECK (niveau IN ('L1','L2','L3','M1','M2','CPGE1','CPGE2','BT','MAN','AUTRE')),
    effectif     INTEGER NOT NULL DEFAULT 0 CHECK (effectif >= 0),
    id_filiere   BIGINT NOT NULL REFERENCES filiere(id_filiere)
                 ON UPDATE CASCADE ON DELETE RESTRICT,      -- APPARTENIR
    -- site où la promotion a tous ses cours (NULL : non fixé)
    id_site      BIGINT REFERENCES site(id_site)
                 ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Subdivision d'une classe (groupes de TD / TP, options)         -- DIVISER
-- Chaque classe est un arbre : groupes de TD ou options, puis demi-groupes de
-- TP ou sous-options (id_groupe_parent). Deux frères du même type (TD1 et TD2,
-- deux options) peuvent avoir cours en même temps ; voir publics_en_conflit().
CREATE TABLE groupe (
    id_groupe    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_groupe  TEXT NOT NULL,
    type_groupe  TEXT NOT NULL
                 CHECK (type_groupe IN ('TD','TP','OPTION')),   -- un CM réunit la classe entière ou une option
    effectif     INTEGER NOT NULL DEFAULT 0 CHECK (effectif >= 0),
    id_classe    BIGINT NOT NULL REFERENCES classe(id_classe)
                 ON UPDATE CASCADE ON DELETE CASCADE,
    id_groupe_parent BIGINT REFERENCES groupe(id_groupe)
                 ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT groupe_parent_distinct CHECK (id_groupe_parent <> id_groupe),
    UNIQUE (id_classe, code_groupe),
    -- cible de la clé étrangère composite de COURS (groupe ∈ classe du cours)
    UNIQUE (id_groupe, id_classe)
);

CREATE TABLE matiere (
    id_matiere    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_matiere  TEXT NOT NULL UNIQUE,
    libelle       TEXT NOT NULL,
    coefficient   NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (coefficient >= 0)
);

CREATE TABLE enseignant (
    id_enseignant          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    matricule              TEXT NOT NULL UNIQUE,
    nom                    TEXT NOT NULL,
    prenom                 TEXT NOT NULL,
    email                  TEXT UNIQUE,
    telephone              TEXT,
    grade                  TEXT,
    nb_heures_max_semaine  INTEGER CHECK (nb_heures_max_semaine > 0),
    -- permanent : cours enchaînés sans interruption ; vacataire_local : selon
    -- ses disponibilités, peut s'étaler ; externe : vient pour des séjours
    -- datés et doit terminer au plus tôt (CS-04, CD-06)
    statut                 TEXT NOT NULL DEFAULT 'permanent'
                           CHECK (statut IN ('permanent','vacataire_local','externe')),
    -- site de rattachement (facultatif)                          -- ETRE_AFFECTE
    id_site                BIGINT REFERENCES site(id_site)
                           ON UPDATE CASCADE ON DELETE SET NULL
);

-- Absences datées d'un enseignant (mission, congé, maladie...), CD-06.
-- Complète DISPONIBILITE, qui décrit une semaine type.
CREATE TABLE absence_enseignant (
    id_absence     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_enseignant  BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    date_debut     DATE NOT NULL,
    date_fin       DATE NOT NULL,
    motif          TEXT,
    CHECK (date_fin >= date_debut)
);

-- Séjours prévus d'un intervenant externe sur le campus (CD-06) : ses séances
-- doivent tomber dans l'un d'eux.
CREATE TABLE sejour_enseignant (                                 -- SEJOURNER
    id_sejour      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_enseignant  BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    date_debut     DATE NOT NULL,
    date_fin       DATE NOT NULL,
    commentaire    TEXT,
    CHECK (date_fin >= date_debut)
);

-- Grille hebdomadaire de BASE (créneaux de 1 h par défaut, BF-05).
-- Une séance (2 h à 4 h) couvre plusieurs créneaux consécutifs.
CREATE TABLE creneau (
    id_creneau   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    jour         TEXT NOT NULL
                 CHECK (jour IN ('Lundi','Mardi','Mercredi','Jeudi',
                                 'Vendredi','Samedi')),
    heure_debut  TIME NOT NULL,
    heure_fin    TIME NOT NULL,
    CHECK (heure_fin > heure_debut),
    UNIQUE (jour, heure_debut, heure_fin)
);

-- Pause(s) pendant laquelle aucune séance ne peut avoir lieu
-- (pause déjeuner : À CONFIRMER avec la scolarité).
CREATE TABLE pause (
    id_pause     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle      TEXT NOT NULL,
    heure_debut  TIME NOT NULL,
    heure_fin    TIME NOT NULL,
    CHECK (heure_fin > heure_debut)
);

-- Jours fériés / non travaillés (aucune séance ces jours-là, CD-09)
CREATE TABLE jour_ferie (
    date_ferie  DATE PRIMARY KEY,
    libelle     TEXT NOT NULL
);

-- Périodes sans cours (vacances, examens, stage...), CD-09.
-- id_classe vide = tout l'établissement ; sinon la seule classe concernée.
CREATE TABLE conge (
    id_conge    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle     TEXT NOT NULL,
    type_conge  TEXT NOT NULL DEFAULT 'vacances'
                CHECK (type_conge IN ('vacances','examens','stage','autre')),
    date_debut  DATE NOT NULL,
    date_fin    DATE NOT NULL,
    id_classe   BIGINT REFERENCES classe(id_classe)
                ON UPDATE CASCADE ON DELETE CASCADE,
    CHECK (date_fin >= date_debut)
);

CREATE TABLE type_salle (
    id_type_salle  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle        TEXT NOT NULL UNIQUE      -- amphithéâtre, laboratoire...
);

CREATE TABLE salle (
    id_salle        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_salle      TEXT NOT NULL UNIQUE,
    nom_salle       TEXT NOT NULL,
    capacite        INTEGER NOT NULL CHECK (capacite > 0),
    batiment        TEXT,                                  -- bâtiment dans le site
    est_disponible  BOOLEAN NOT NULL DEFAULT TRUE,         -- CD-12
    id_type_salle   BIGINT NOT NULL REFERENCES type_salle(id_type_salle)
                    ON UPDATE CASCADE ON DELETE RESTRICT,  -- ETRE_DE_TYPE
    id_site         BIGINT NOT NULL REFERENCES site(id_site)
                    ON UPDATE CASCADE ON DELETE RESTRICT   -- SE_SITUER
);

-- Salle réservée à certaines formations (EMIH, EREE, CPGE...) : une salle
-- listée ici ne reçoit que les classes listées ; aucune ligne = salle libre.
CREATE TABLE salle_reservation (                                -- RESERVER
    id_salle_reservation BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_salle   BIGINT NOT NULL REFERENCES salle(id_salle)
               ON UPDATE CASCADE ON DELETE CASCADE,
    id_classe  BIGINT NOT NULL REFERENCES classe(id_classe)
               ON UPDATE CASCADE ON DELETE CASCADE,
    UNIQUE (id_salle, id_classe)
);

-- Temps de trajet entre deux sites : écart minimal entre deux séances d'un
-- enseignant sur ces deux sites le même jour (respecté par le moteur).
CREATE TABLE site_trajet (
    id_site_trajet BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_site_a  BIGINT NOT NULL REFERENCES site(id_site)
               ON UPDATE CASCADE ON DELETE CASCADE,
    id_site_b  BIGINT NOT NULL REFERENCES site(id_site)
               ON UPDATE CASCADE ON DELETE CASCADE,
    minutes    INTEGER NOT NULL CHECK (minutes >= 0),
    UNIQUE (id_site_a, id_site_b),
    CHECK (id_site_a < id_site_b)
);

CREATE TABLE semestre (
    id_semestre       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle           TEXT NOT NULL,
    annee_academique  TEXT NOT NULL,                 -- ex. '2026-2027'
    date_debut        DATE NOT NULL,
    date_fin          DATE NOT NULL,
    CHECK (date_fin > date_debut),
    UNIQUE (annee_academique, libelle)
);

CREATE TABLE utilisateur (
    id_utilisateur  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login           TEXT NOT NULL,
    -- Nullable : l'authentification passe par Supabase Auth (BNF-06).
    -- Si renseigné, il doit contenir un HASH, jamais un mot de passe en clair.
    mot_de_passe    TEXT,
    email           TEXT NOT NULL UNIQUE,
    -- Seuls les gestionnaires ont un compte : enseignants et étudiants
    -- consultent sans connexion (espace invités). Le super admin gère les
    -- écoles et leurs comptes.
    role            TEXT NOT NULL DEFAULT 'planificateur',
    -- compte Supabase Auth (auth.users.id), renseigné à l'invitation
    auth_id         UUID UNIQUE,
    est_actif       BOOLEAN NOT NULL DEFAULT TRUE,
    date_creation   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- école du compte ; le super admin n'appartient à aucune école -- TRAVAILLER_POUR
    id_ecole        BIGINT REFERENCES ecole(id_ecole)
                    ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT utilisateur_role_check
        CHECK (role IN ('superadmin','administrateur','planificateur')),
    CONSTRAINT utilisateur_ecole_check
        CHECK ((role = 'superadmin') = (id_ecole IS NULL)),
    CONSTRAINT utilisateur_login_key UNIQUE (id_ecole, login)
);

-- =====================================================================
--  2. COURS, DÉCOUPAGE, DISPONIBILITÉS
-- =====================================================================

-- Programme (maquette pédagogique) : matières qu'une classe doit suivre sur
-- un semestre, avec les volumes prévus par type de cours (CD-07, BF-06).
-- Pour un TD ou un TP fait par groupes, le volume vaut pour CHAQUE groupe.
CREATE TABLE programme (                                         -- PREVOIR
    id_programme  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_classe     BIGINT NOT NULL REFERENCES classe(id_classe)
                  ON UPDATE CASCADE ON DELETE CASCADE,
    id_matiere    BIGINT NOT NULL REFERENCES matiere(id_matiere)
                  ON UPDATE CASCADE ON DELETE RESTRICT,
    id_semestre   BIGINT NOT NULL REFERENCES semestre(id_semestre)
                  ON UPDATE CASCADE ON DELETE RESTRICT,
    volume_cm     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (volume_cm >= 0),  -- heures
    volume_td     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (volume_td >= 0),
    volume_tp     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (volume_tp >= 0),
    CHECK (volume_cm + volume_td + volume_tp > 0),
    UNIQUE (id_classe, id_matiere, id_semestre)
);

CREATE TABLE cours (
    id_cours            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_cours          TEXT NOT NULL CHECK (type_cours IN ('CM','TD','TP')),
    volume_horaire      NUMERIC(6,2) NOT NULL CHECK (volume_horaire > 0),  -- heures, total
    -- durée « par défaut » d'une séance, utilisée si le cours n'a pas de découpage
    duree_seance        NUMERIC(4,2) NOT NULL
                        CHECK (duree_seance BETWEEN 2 AND 4),              -- heures
    nb_seances_semaine  INTEGER NOT NULL DEFAULT 1 CHECK (nb_seances_semaine > 0),
    priorite            INTEGER NOT NULL DEFAULT 0,          -- plus haut = plus tôt (CS-07)
    -- proposée par l'assistant IA, que la scolarité accepte ou non
    priorite_suggeree       INTEGER,
    justification_priorite  TEXT,
    -- rythme hebdomadaire : le solveur choisit chaque semaine un nombre
    -- d'heures entre ces bornes (CD-14 pour le maximum)
    heures_semaine_min  NUMERIC(5,2) NOT NULL DEFAULT 2  CHECK (heures_semaine_min >= 0),
    heures_semaine_max  NUMERIC(5,2) NOT NULL DEFAULT 15 CHECK (heures_semaine_max >= 2),
    CHECK (heures_semaine_max >= heures_semaine_min),
    id_matiere          BIGINT NOT NULL REFERENCES matiere(id_matiere)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- PORTER_SUR
    id_classe           BIGINT NOT NULL REFERENCES classe(id_classe)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- CONCERNER
    -- NULL = classe entière (ex. CM) ; sinon le groupe doit appartenir
    -- à la classe du cours (clé étrangère composite ci-dessous).   -- CIBLER
    id_groupe           BIGINT,
    -- enseignant prévu (facultatif) : repris par défaut sur les séances générées
    id_enseignant       BIGINT REFERENCES enseignant(id_enseignant)
                        ON UPDATE CASCADE ON DELETE SET NULL,   -- ASSURER
    id_type_salle       BIGINT REFERENCES type_salle(id_type_salle)
                        ON UPDATE CASCADE ON DELETE SET NULL,   -- NECESSITER (0,1)
    id_semestre         BIGINT NOT NULL REFERENCES semestre(id_semestre)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- PROGRAMMER
    FOREIGN KEY (id_groupe, id_classe) REFERENCES groupe(id_groupe, id_classe)
                        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Découpage hebdomadaire indicatif d'un cours en séances (ex. rang 1 : 2 h,
-- Cours mutualisé : publics suivis en plus du public principal du cours
-- (cours.id_classe / id_groupe), en même temps, dans la même salle.
CREATE TABLE cours_public (                                     -- MUTUALISER
    id_cours_public  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_cours         BIGINT NOT NULL REFERENCES cours(id_cours)
                     ON UPDATE CASCADE ON DELETE CASCADE,
    id_classe        BIGINT NOT NULL REFERENCES classe(id_classe)
                     ON UPDATE CASCADE ON DELETE CASCADE,
    id_groupe        BIGINT,                                    -- NULL = classe entière
    FOREIGN KEY (id_groupe, id_classe) REFERENCES groupe(id_groupe, id_classe)
                     ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_cours_public ON cours_public (id_cours, id_classe, coalesce(id_groupe, 0));

-- Types de salle acceptés en plus de cours.id_type_salle (un CM en
-- amphithéâtre OU dans une grande salle standard).
CREATE TABLE cours_type_salle (
    id_cours_type_salle BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_cours       BIGINT NOT NULL REFERENCES cours(id_cours)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    id_type_salle  BIGINT NOT NULL REFERENCES type_salle(id_type_salle)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    UNIQUE (id_cours, id_type_salle)
);

-- rang 2 : 3 h) : durées de séance préférées. Le rythme réel est choisi par le
-- solveur entre heures_semaine_min et heures_semaine_max. Sans ligne ici, les
-- séances durent duree_seance.
CREATE TABLE cours_seance_modele (                              -- DECOUPER
    id_cours      BIGINT NOT NULL REFERENCES cours(id_cours)
                  ON UPDATE CASCADE ON DELETE CASCADE,
    rang          INTEGER NOT NULL CHECK (rang > 0),
    duree_heures  NUMERIC(4,2) NOT NULL
                  CHECK (duree_heures BETWEEN 2 AND 4),
    PRIMARY KEY (id_cours, rang)
);

-- Disponibilités des enseignants, par créneau de la grille de base
-- (remplace INDISPONIBILITE) :                                   -- DECLARER
--   * pas de ligne = 'disponible' par défaut ;
--   * 'preference'   : créneau préféré, utilisé par le moteur (CS-01) ;
--   * 'indisponible' : bloque toute séance qui le recouvre (CD-06).
CREATE TABLE disponibilite (
    id_enseignant  BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    id_creneau     BIGINT NOT NULL REFERENCES creneau(id_creneau)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    niveau         TEXT NOT NULL
                   CHECK (niveau IN ('disponible','preference','indisponible')),
    motif          TEXT,
    PRIMARY KEY (id_enseignant, id_creneau)
);

-- =====================================================================
--  3. EMPLOI DU TEMPS, CONTRAINTES, PROMPTS
-- =====================================================================

CREATE TABLE emploi_du_temps (
    id_edt            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle           TEXT NOT NULL,
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    mode_generation   TEXT NOT NULL DEFAULT 'manuel'
                      CHECK (mode_generation IN ('manuel','automatique')),
    statut            TEXT NOT NULL DEFAULT 'brouillon'
                      CHECK (statut IN ('brouillon','valide','publie','archive')),
    date_creation     TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_publication  TIMESTAMPTZ,
    id_semestre       BIGINT NOT NULL REFERENCES semestre(id_semestre)
                      ON UPDATE CASCADE ON DELETE RESTRICT,     -- COUVRIR
    id_utilisateur    BIGINT NOT NULL REFERENCES utilisateur(id_utilisateur)
                      ON UPDATE CASCADE ON DELETE RESTRICT,     -- CREER
    UNIQUE (id_semestre, libelle, version)
);

CREATE TABLE contrainte (
    id_contrainte    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle          TEXT NOT NULL,
    type_contrainte  TEXT NOT NULL,                 -- ex. 'CS-01', 'salle'...
    nature           TEXT NOT NULL CHECK (nature IN ('dure','souple')),
    poids            INTEGER NOT NULL DEFAULT 0 CHECK (poids >= 0),
    -- paramètre de la contrainte, ex. 3 matières par semaine (CD-13),
    -- 6 h par jour (CS-06)
    valeur           NUMERIC(6,2),
    est_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Règle du planificateur, saisie comme donnée et appliquée par le moteur
    -- (type_contrainte 'interdire', 'precede', 'plafond_jour'...), ex.
    -- {"cible": {"id_classe": 3}, "jours": ["Jeudi"], "demi": 1} ; période de validité
    parametres       JSONB,
    date_debut       DATE,
    date_fin         DATE,
    CONSTRAINT contrainte_periode_check CHECK (date_fin IS NULL OR date_debut IS NULL OR date_fin >= date_debut),
    id_edt           BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                     ON UPDATE CASCADE ON DELETE CASCADE        -- PARAMETRER
);

-- Fil de discussion avec l'assistant IA : regroupe les prompts successifs
-- d'un utilisateur sur un emploi du temps (historique de l'assistant).
CREATE TABLE conversation (
    id_conversation  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre            TEXT NOT NULL,
    date_creation    TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_utilisateur   BIGINT NOT NULL REFERENCES utilisateur(id_utilisateur)
                     ON UPDATE CASCADE ON DELETE RESTRICT,      -- OUVRIR
    id_edt           BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                     ON UPDATE CASCADE ON DELETE CASCADE        -- PORTER_SUR_EDT
);

CREATE TABLE prompt (
    id_prompt       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    texte           TEXT NOT NULL,
    reponse         TEXT,
    statut          TEXT NOT NULL DEFAULT 'en_attente'
                    CHECK (statut IN ('en_attente','traite','erreur')),
    date_prompt     TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_utilisateur  BIGINT NOT NULL REFERENCES utilisateur(id_utilisateur)
                    ON UPDATE CASCADE ON DELETE RESTRICT,       -- SOUMETTRE
    id_edt          BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                    ON UPDATE CASCADE ON DELETE CASCADE,        -- MODIFIER
    id_conversation BIGINT NOT NULL REFERENCES conversation(id_conversation)
                    ON UPDATE CASCADE ON DELETE CASCADE         -- APPARTENIR_A
);

-- Modifications proposées par l'assistant IA (calculées par le solveur),
-- en attente de validation. modifications : liste JSON d'opérations, ex.
-- [{"action":"deplacer","id_seance":12,"avant":{...},"apres":{...}}].
CREATE TABLE proposition (
    id_proposition  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    description     TEXT NOT NULL,
    modifications   JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- conséquences calculées (heures perdues, enseignants à prévenir, cours
    -- qui finissent plus tard...), montrées au planificateur avant décision
    impact          JSONB NOT NULL DEFAULT '{}'::jsonb,
    statut          TEXT NOT NULL DEFAULT 'en_attente'
                    CHECK (statut IN ('en_attente','appliquee','rejetee')),
    date_creation   TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_decision   TIMESTAMPTZ,
    id_prompt       BIGINT NOT NULL REFERENCES prompt(id_prompt)
                    ON UPDATE CASCADE ON DELETE CASCADE,        -- PRODUIRE
    id_edt          BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                    ON UPDATE CASCADE ON DELETE CASCADE,
    id_utilisateur_decision BIGINT REFERENCES utilisateur(id_utilisateur)
                    ON UPDATE CASCADE ON DELETE RESTRICT,       -- DECIDER
    -- seances : opérations sur des séances ; referentiel : lignes à ajouter
    -- au référentiel (matières, programme, cours...), qui ne s'ajoutent qu'après
    -- validation, puis suite (génération à lancer ensuite), facultative
    nature          TEXT NOT NULL DEFAULT 'seances'
                    CHECK (nature IN ('seances','referentiel')),
    suite           JSONB,
    CHECK ((statut = 'en_attente') = (date_decision IS NULL))
);

-- Fichier joint à un message de l'assistant (CSV, Excel, PDF, image), lu par
-- l'assistant à la demande. 5 Mo au plus.
CREATE TABLE piece_jointe (
    id_piece    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom         TEXT NOT NULL,
    type_mime   TEXT NOT NULL,
    taille      INTEGER NOT NULL CHECK (taille BETWEEN 1 AND 5242880),
    contenu     BYTEA NOT NULL,
    date_ajout  TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_prompt   BIGINT NOT NULL REFERENCES prompt(id_prompt)
                ON UPDATE CASCADE ON DELETE CASCADE         -- JOINDRE
);

-- =====================================================================
--  4. SÉANCE (table centrale)
--     id_creneau = créneau de DÉBUT de la séance (donne le jour de la
--     semaine) ; heure_debut / heure_fin portent la durée réelle.
-- =====================================================================

CREATE TABLE seance (
    id_seance        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_seance      DATE NOT NULL,
    heure_debut      TIME NOT NULL,
    heure_fin        TIME NOT NULL,
    statut           TEXT NOT NULL DEFAULT 'planifiee'
                     CHECK (statut IN ('planifiee','validee','annulee')),
    est_verrouillee  BOOLEAN NOT NULL DEFAULT FALSE,        -- BF-17
    id_cours         BIGINT NOT NULL REFERENCES cours(id_cours)
                     ON UPDATE CASCADE ON DELETE RESTRICT,  -- PLANIFIER
    -- enseignant de la séance (vide : à désigner) ; par défaut celui du cours
    id_enseignant    BIGINT REFERENCES enseignant(id_enseignant)
                     ON UPDATE CASCADE ON DELETE SET NULL,  -- ANIMER
    id_salle         BIGINT NOT NULL REFERENCES salle(id_salle)
                     ON UPDATE CASCADE ON DELETE RESTRICT,  -- SE_DEROULER
    id_creneau       BIGINT NOT NULL REFERENCES creneau(id_creneau)
                     ON UPDATE CASCADE ON DELETE RESTRICT,  -- OCCUPER
    id_edt           BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                     ON UPDATE CASCADE ON DELETE CASCADE,   -- COMPOSER
    -- un cours, ou une épreuve : examen, puis rattrapage du même module
    nature           TEXT NOT NULL DEFAULT 'cours'
                     CHECK (nature IN ('cours','examen','rattrapage')),

    -- CD-10 : une séance dure de 2 h à 4 h
    CHECK (heure_fin > heure_debut),
    CHECK (heure_fin - heure_debut BETWEEN INTERVAL '2 hours' AND INTERVAL '4 hours'),
    -- Une épreuve dure de 2 h à 3 h et n'a pas d'enseignant
    CONSTRAINT ck_seance_epreuve_duree
        CHECK (nature = 'cours' OR heure_fin - heure_debut <= INTERVAL '3 hours'),
    CONSTRAINT ck_seance_epreuve_sans_enseignant
        CHECK (nature = 'cours' OR id_enseignant IS NULL),

    -- Plage horaire datée, calculée automatiquement (ne pas l'insérer)
    plage            TSRANGE GENERATED ALWAYS AS
                     (tsrange(date_seance + heure_debut, date_seance + heure_fin)) STORED,

    -- CD-01 : une salle ne peut pas avoir deux cours qui se chevauchent
    -- (dans un même emploi du temps ; les séances annulées sont ignorées).
    CONSTRAINT ex_seance_salle
        EXCLUDE USING gist (id_edt WITH =, id_salle WITH =, plage WITH &&)
        WHERE (statut <> 'annulee' AND nature = 'cours'),
    -- ...ni un cours et une épreuve ; des épreuves peuvent la partager (CD-04 : capacité)
    CONSTRAINT ex_seance_salle_epreuve
        EXCLUDE USING gist (id_edt WITH =, id_salle WITH =, plage WITH &&,
                            (CASE WHEN nature = 'cours' THEN 1 ELSE 0 END) WITH <>)
        WHERE (statut <> 'annulee')
);

-- =====================================================================
--  5. INDEX SUR LES CLÉS ÉTRANGÈRES
-- =====================================================================

CREATE INDEX ix_utilisateur_ecole  ON utilisateur(id_ecole);
CREATE INDEX ix_classe_filiere     ON classe(id_filiere);
CREATE INDEX ix_groupe_classe      ON groupe(id_classe);
CREATE INDEX ix_salle_type         ON salle(id_type_salle);
CREATE INDEX ix_salle_site         ON salle(id_site);
CREATE INDEX ix_filiere_site       ON filiere(id_site);
CREATE INDEX ix_enseignant_site    ON enseignant(id_site);
CREATE INDEX ix_absence_enseignant ON absence_enseignant(id_enseignant, date_debut);
CREATE INDEX ix_sejour_enseignant  ON sejour_enseignant(id_enseignant, date_debut);
CREATE INDEX ix_proposition_prompt ON proposition(id_prompt);
CREATE INDEX ix_proposition_edt    ON proposition(id_edt, statut);
CREATE INDEX ix_piece_jointe_prompt ON piece_jointe(id_prompt);
CREATE INDEX ix_cours_matiere      ON cours(id_matiere);
CREATE INDEX ix_cours_classe       ON cours(id_classe);
CREATE INDEX ix_cours_groupe       ON cours(id_groupe);
CREATE INDEX ix_cours_enseignant   ON cours(id_enseignant);
CREATE INDEX ix_seance_enseignant  ON seance(id_enseignant);
CREATE INDEX ix_classe_site        ON classe(id_site);
CREATE INDEX ix_groupe_parent      ON groupe(id_groupe_parent);
CREATE INDEX ix_cours_public_classe ON cours_public(id_classe);
CREATE INDEX ix_salle_reservation_classe ON salle_reservation(id_classe);
CREATE INDEX ix_cours_type_salle   ON cours(id_type_salle);
CREATE INDEX ix_cours_semestre     ON cours(id_semestre);
CREATE INDEX ix_programme_matiere  ON programme(id_matiere);
CREATE INDEX ix_dispo_creneau      ON disponibilite(id_creneau);
CREATE INDEX ix_edt_semestre       ON emploi_du_temps(id_semestre);
CREATE INDEX ix_edt_utilisateur    ON emploi_du_temps(id_utilisateur);
CREATE INDEX ix_contrainte_edt     ON contrainte(id_edt);
CREATE INDEX ix_prompt_edt         ON prompt(id_edt);
CREATE INDEX ix_prompt_utilisateur ON prompt(id_utilisateur);
CREATE INDEX ix_prompt_conversation ON prompt(id_conversation);
CREATE INDEX ix_conversation_utilisateur ON conversation(id_utilisateur);
CREATE INDEX ix_seance_cours       ON seance(id_cours);
CREATE INDEX ix_seance_creneau     ON seance(id_creneau);
CREATE INDEX ix_seance_edt_date    ON seance(id_edt, date_seance);

-- =====================================================================
--  6. CONTRÔLE DES CONTRAINTES DURES (déclencheurs sur SEANCE et COURS)
--     CD-02 à CD-14 (CD-01 par la contrainte d'exclusion)
--     (CD-01 est garanti par la contrainte EXCLUDE ex_seance_salle ;
--      la durée 2-4 h est garantie par un CHECK sur SEANCE)
-- =====================================================================

-- Publics d'un cours : son public principal et ceux d'un cours mutualisé
CREATE OR REPLACE FUNCTION publics_du_cours(p_id_cours BIGINT)
RETURNS TABLE (id_classe BIGINT, id_groupe BIGINT)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT c.id_classe, c.id_groupe FROM cours c WHERE c.id_cours = p_id_cours
    UNION ALL
    SELECT p.id_classe, p.id_groupe FROM cours_public p WHERE p.id_cours = p_id_cours
$$;

-- Publics d'une séance : ceux de son cours ; une épreuve concerne toute la classe,
-- même si elle est rattachée au cours d'un groupe.
CREATE OR REPLACE FUNCTION publics_seance(p_id_cours BIGINT, p_nature TEXT)
RETURNS TABLE (id_classe BIGINT, id_groupe BIGINT)
LANGUAGE sql STABLE
SET search_path = public
AS $$
    SELECT DISTINCT p.id_classe, CASE WHEN p_nature = 'cours' THEN p.id_groupe END
    FROM publics_du_cours(p_id_cours) p
$$;

-- Retirer ou annuler un examen ne doit pas laisser un rattrapage sans examen. Une
-- publication ou une restauration remet tout en place dans la même transaction.
CREATE OR REPLACE FUNCTION garder_examen(p_id_edt BIGINT, p_id_seance BIGINT, p_id_cours BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user <> 'ultraplanning_app'
       OR coalesce(current_setting('app.origine', true), '') IN ('publication', 'restauration') THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM seance r JOIN cours cr ON cr.id_cours = r.id_cours JOIN cours c ON c.id_cours = p_id_cours
               WHERE r.id_edt = p_id_edt AND r.nature = 'rattrapage' AND r.statut <> 'annulee'
                 AND cr.id_matiere = c.id_matiere AND cr.id_classe = c.id_classe)
       AND NOT EXISTS (SELECT 1 FROM seance x JOIN cours cx ON cx.id_cours = x.id_cours JOIN cours c ON c.id_cours = p_id_cours
                       WHERE x.id_edt = p_id_edt AND x.nature = 'examen' AND x.statut <> 'annulee' AND x.id_seance <> p_id_seance
                         AND cx.id_matiere = c.id_matiere AND cx.id_classe = c.id_classe) THEN
        RAISE EXCEPTION 'Ce module a un rattrapage : retirez-le avant son examen'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

-- Deux publics ont-ils des étudiants communs ? Oui s'ils sont de la même classe
-- et que l'un contient l'autre (classe entière, groupe parent), ou que leurs
-- branches de l'arbre des groupes se séparent sur deux frères de types
-- différents (découpages croisés, ex. TD et TP sans parent). Deux frères du
-- même type (TD1 et TD2, deux options) sont disjoints.
CREATE OR REPLACE FUNCTION publics_en_conflit(p_classe1 BIGINT, p_groupe1 BIGINT,
                                              p_classe2 BIGINT, p_groupe2 BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
    a  BIGINT[];
    b  BIGINT[];
    i  INTEGER := 1;
BEGIN
    IF p_classe1 <> p_classe2 THEN
        RETURN FALSE;
    END IF;
    IF p_groupe1 IS NULL OR p_groupe2 IS NULL OR p_groupe1 = p_groupe2 THEN
        RETURN TRUE;
    END IF;
    -- ancêtres de chaque groupe, depuis la racine de l'arbre
    WITH RECURSIVE x(g, n) AS (
        SELECT p_groupe1, 0
        UNION ALL
        SELECT gr.id_groupe_parent, x.n + 1 FROM groupe gr JOIN x ON gr.id_groupe = x.g
        WHERE gr.id_groupe_parent IS NOT NULL
    ) SELECT array_agg(g ORDER BY n DESC) INTO a FROM x;
    WITH RECURSIVE x(g, n) AS (
        SELECT p_groupe2, 0
        UNION ALL
        SELECT gr.id_groupe_parent, x.n + 1 FROM groupe gr JOIN x ON gr.id_groupe = x.g
        WHERE gr.id_groupe_parent IS NOT NULL
    ) SELECT array_agg(g ORDER BY n DESC) INTO b FROM x;
    WHILE i <= least(cardinality(a), cardinality(b)) AND a[i] = b[i] LOOP
        i := i + 1;
    END LOOP;
    IF i > cardinality(a) OR i > cardinality(b) THEN
        RETURN TRUE;   -- l'un contient l'autre
    END IF;
    RETURN (SELECT type_groupe FROM groupe WHERE id_groupe = a[i])
        <> (SELECT type_groupe FROM groupe WHERE id_groupe = b[i]);
END;
$$;

-- Le groupe parent appartient à la même classe
CREATE OR REPLACE FUNCTION groupe_parent_meme_classe()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF NEW.id_groupe_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM groupe p WHERE p.id_groupe = NEW.id_groupe_parent AND p.id_classe = NEW.id_classe) THEN
        RAISE EXCEPTION 'Le groupe parent doit appartenir à la même classe'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_groupe_parent
    BEFORE INSERT OR UPDATE OF id_groupe_parent, id_classe ON groupe
    FOR EACH ROW
    EXECUTE FUNCTION groupe_parent_meme_classe();

CREATE OR REPLACE FUNCTION verifier_seance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_cours     cours%ROWTYPE;
    v_classe    classe%ROWTYPE;
    v_salle     salle%ROWTYPE;
    v_creneau   creneau%ROWTYPE;
    v_semestre  semestre%ROWTYPE;
    v_effectif  INTEGER;
    v_deja      NUMERIC;
    v_duree     NUMERIC;
    v_plage     TSRANGE;
    v_classe_pub BIGINT;
    v_max_mat   NUMERIC;
    v_nb_mat    INTEGER;
    v_semaine   NUMERIC;
BEGIN
    -- Une séance annulée n'est soumise à aucun contrôle.
    IF NEW.statut = 'annulee' THEN
        IF TG_OP = 'UPDATE' AND OLD.nature = 'examen' AND OLD.statut <> 'annulee' THEN
            PERFORM garder_examen(OLD.id_edt, OLD.id_seance, OLD.id_cours);
        END IF;
        RETURN NEW;
    END IF;

    -- Un seul enregistrement à la fois par emploi du temps : sans ce verrou,
    -- deux transactions simultanées ne verraient pas leurs séances
    -- respectives et pourraient contourner CD-02 / CD-03.
    PERFORM pg_advisory_xact_lock(NEW.id_edt);

    SELECT * INTO v_cours    FROM cours    WHERE id_cours    = NEW.id_cours;
    SELECT * INTO v_classe   FROM classe   WHERE id_classe   = v_cours.id_classe;
    SELECT * INTO v_salle    FROM salle    WHERE id_salle    = NEW.id_salle;
    SELECT * INTO v_creneau  FROM creneau  WHERE id_creneau  = NEW.id_creneau;
    SELECT * INTO v_semestre FROM semestre WHERE id_semestre = v_cours.id_semestre;

    v_duree := EXTRACT(EPOCH FROM (NEW.heure_fin - NEW.heure_debut)) / 3600;
    v_plage := tsrange(NEW.date_seance + NEW.heure_debut,
                       NEW.date_seance + NEW.heure_fin);

    -- CD-10 : la séance est alignée sur la grille de créneaux
    IF NEW.heure_debut <> v_creneau.heure_debut THEN
        RAISE EXCEPTION 'CD-10 : l''heure de début (%) ne correspond pas au créneau de début choisi (%)',
            NEW.heure_debut, v_creneau.heure_debut
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM creneau c
                   WHERE c.jour = v_creneau.jour AND c.heure_fin = NEW.heure_fin) THEN
        RAISE EXCEPTION 'CD-10 : l''heure de fin (%) ne correspond à aucun créneau de la grille', NEW.heure_fin
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-11 : une séance ne peut pas chevaucher une pause (déjeuner)
    IF EXISTS (SELECT 1 FROM pause p
               WHERE NEW.heure_debut < p.heure_fin
                 AND NEW.heure_fin   > p.heure_debut) THEN
        RAISE EXCEPTION 'CD-11 : la séance chevauche la pause (%)',
            (SELECT p.libelle FROM pause p
             WHERE NEW.heure_debut < p.heure_fin AND NEW.heure_fin > p.heure_debut
             LIMIT 1)
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-12 : la salle n'est pas marquée indisponible
    IF NOT v_salle.est_disponible THEN
        RAISE EXCEPTION 'CD-12 : la salle % est marquée indisponible', v_salle.nom_salle
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-09 : le cours appartient au semestre de l'emploi du temps
    IF v_cours.id_semestre <> (SELECT e.id_semestre FROM emploi_du_temps e WHERE e.id_edt = NEW.id_edt) THEN
        RAISE EXCEPTION 'CD-09 : le cours n''appartient pas au semestre de cet emploi du temps'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-09 : date dans le semestre, bon jour de la semaine, jour non férié
    IF NEW.date_seance NOT BETWEEN v_semestre.date_debut AND v_semestre.date_fin THEN
        RAISE EXCEPTION 'CD-09 : la date est en dehors des dates du semestre'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_creneau.jour <> (ARRAY['Lundi','Mardi','Mercredi','Jeudi',
                                'Vendredi','Samedi','Dimanche'])
                         [EXTRACT(ISODOW FROM NEW.date_seance)::INT] THEN
        RAISE EXCEPTION 'CD-09 : la date ne correspond pas au jour du créneau (%)', v_creneau.jour
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM jour_ferie f WHERE f.date_ferie = NEW.date_seance) THEN
        RAISE EXCEPTION 'CD-09 : le % est un jour férié (%)', NEW.date_seance,
            (SELECT f.libelle FROM jour_ferie f WHERE f.date_ferie = NEW.date_seance)
            USING ERRCODE = 'check_violation';
    END IF;

    -- Une période d'examens est fermée aux cours, pas aux épreuves
    IF EXISTS (SELECT 1 FROM conge g
               WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
                 AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)
                 AND NOT (NEW.nature <> 'cours' AND g.type_conge = 'examens')) THEN
        RAISE EXCEPTION 'CD-09 : le % tombe pendant un congé (%)', NEW.date_seance,
            (SELECT g.libelle FROM conge g
             WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
               AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)
               AND NOT (NEW.nature <> 'cours' AND g.type_conge = 'examens')
             LIMIT 1)
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-02 : un enseignant ne peut pas animer deux séances qui se chevauchent
    -- (séance sans enseignant : aucun contrôle d'enseignant, ici et pour CD-06)
    IF NEW.id_enseignant IS NOT NULL AND EXISTS (
        SELECT 1
        FROM seance s
        WHERE s.id_edt  = NEW.id_edt
          AND s.statut <> 'annulee'
          AND s.id_enseignant = NEW.id_enseignant
          AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) THEN
        RAISE EXCEPTION 'CD-02 : l''enseignant a déjà une séance qui chevauche cette plage horaire'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-03 : pas deux séances en même temps pour des étudiants communs. Les
    -- publics d'un cours sont son public principal et ceux d'un cours mutualisé
    -- (COURS_PUBLIC) ; deux publics d'une classe ne sont compatibles que s'ils se
    -- séparent sur deux groupes frères du même type (voir publics_en_conflit).
    -- Salle et enseignant différents sont déjà imposés par CD-01 et CD-02.
    IF EXISTS (
        SELECT 1
        FROM seance s
        CROSS JOIN LATERAL publics_seance(s.id_cours, s.nature) ps
        JOIN publics_seance(NEW.id_cours, NEW.nature) pn ON pn.id_classe = ps.id_classe
        WHERE s.id_edt  = NEW.id_edt
          AND s.statut <> 'annulee'
          AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
          AND publics_en_conflit(pn.id_classe, pn.id_groupe, ps.id_classe, ps.id_groupe)
    ) THEN
        RAISE EXCEPTION 'CD-03 : la classe a déjà une séance qui chevauche cette plage horaire (seuls deux groupes différents du même type peuvent être en parallèle)'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-04 : capacité de la salle >= effectif de tous les publics (groupe ciblé,
    -- sinon classe entière ; cours mutualisé : la somme). Épreuves dans la même salle :
    -- la somme de toutes celles qui se chevauchent.
    SELECT coalesce(sum(x.effectif), 0)
    INTO v_effectif
    FROM (
        SELECT coalesce(g.effectif, cl.effectif) AS effectif
        FROM publics_seance(NEW.id_cours, NEW.nature) p
        JOIN classe cl ON cl.id_classe = p.id_classe
        LEFT JOIN groupe g ON g.id_groupe = p.id_groupe
        UNION ALL
        SELECT cl.effectif
        FROM seance s
        CROSS JOIN LATERAL publics_seance(s.id_cours, s.nature) p
        JOIN classe cl ON cl.id_classe = p.id_classe
        WHERE NEW.nature <> 'cours' AND s.nature <> 'cours' AND s.id_edt = NEW.id_edt
          AND s.id_salle = NEW.id_salle AND s.statut <> 'annulee' AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) x;

    IF v_salle.capacite < v_effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif à accueillir (%)',
            v_salle.capacite, v_effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle exigé par le cours, ou l'un des types acceptés (COURS_TYPE_SALLE)
    IF NEW.nature = 'cours'
       AND (v_cours.id_type_salle IS NOT NULL
            OR EXISTS (SELECT 1 FROM cours_type_salle t WHERE t.id_cours = NEW.id_cours))
       AND v_salle.id_type_salle IS DISTINCT FROM v_cours.id_type_salle
       AND NOT EXISTS (SELECT 1 FROM cours_type_salle t
                       WHERE t.id_cours = NEW.id_cours AND t.id_type_salle = v_salle.id_type_salle) THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Site : la salle est sur le site de chaque promotion du cours (classe.id_site, s'il est fixé).
    -- Le campus d'une épreuve se choisit à sa programmation.
    IF NEW.nature = 'cours'
       AND EXISTS (SELECT 1 FROM publics_du_cours(NEW.id_cours) p JOIN classe cl ON cl.id_classe = p.id_classe
                   WHERE cl.id_site IS NOT NULL AND cl.id_site <> v_salle.id_site) THEN
        RAISE EXCEPTION 'SITE : la salle % n''est pas sur le site de la promotion', v_salle.nom_salle
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-12 : salle réservée à certaines formations (SALLE_RESERVATION)
    IF EXISTS (SELECT 1 FROM salle_reservation r WHERE r.id_salle = NEW.id_salle)
       AND NOT EXISTS (SELECT 1 FROM salle_reservation r JOIN publics_du_cours(NEW.id_cours) p
                       ON p.id_classe = r.id_classe WHERE r.id_salle = NEW.id_salle) THEN
        RAISE EXCEPTION 'CD-12 : la salle % est réservée à d''autres formations', v_salle.nom_salle
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-06 : enseignant absent à cette date (mission, congé...)
    IF NEW.id_enseignant IS NOT NULL AND EXISTS (SELECT 1 FROM absence_enseignant a
               WHERE a.id_enseignant = NEW.id_enseignant
                 AND NEW.date_seance BETWEEN a.date_debut AND a.date_fin) THEN
        RAISE EXCEPTION 'CD-06 : l''enseignant est absent le % (%)', NEW.date_seance,
            (SELECT a.motif FROM absence_enseignant a
             WHERE a.id_enseignant = NEW.id_enseignant
               AND NEW.date_seance BETWEEN a.date_debut AND a.date_fin LIMIT 1)
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-06 : un intervenant externe n'enseigne que pendant ses séjours prévus
    IF (SELECT e.statut FROM enseignant e WHERE e.id_enseignant = NEW.id_enseignant) = 'externe'
       AND NOT EXISTS (SELECT 1 FROM sejour_enseignant j
                       WHERE j.id_enseignant = NEW.id_enseignant
                         AND NEW.date_seance BETWEEN j.date_debut AND j.date_fin) THEN
        RAISE EXCEPTION 'CD-06 : intervenant externe, le % est en dehors de ses séjours prévus', NEW.date_seance
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-06 : aucun créneau de la séance ne doit être déclaré « indisponible »
    -- dans la semaine type de l'enseignant
    IF NEW.id_enseignant IS NOT NULL AND EXISTS (
        SELECT 1
        FROM disponibilite d
        JOIN creneau c ON c.id_creneau = d.id_creneau
        WHERE d.id_enseignant = NEW.id_enseignant
          AND d.niveau        = 'indisponible'
          AND c.jour          = v_creneau.jour
          AND c.heure_debut   < NEW.heure_fin
          AND c.heure_fin     > NEW.heure_debut
    ) THEN
        RAISE EXCEPTION 'CD-06 : l''enseignant est indisponible sur au moins un créneau de cette séance'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Une épreuve ne compte ni dans le volume, ni dans le rythme, ni dans les matières de la semaine
    IF NEW.nature = 'cours' THEN
        -- CD-08 : le cumul des durées des séances ne dépasse pas le volume horaire
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)
        INTO v_deja
        FROM seance s
        WHERE s.id_cours = NEW.id_cours
          AND s.id_edt   = NEW.id_edt
          AND s.statut  <> 'annulee'
          AND s.nature   = 'cours'
          AND s.id_seance IS DISTINCT FROM NEW.id_seance;

        IF v_deja + v_duree > v_cours.volume_horaire THEN
            RAISE EXCEPTION 'CD-08 : le volume horaire prévu (% h) serait dépassé (% h déjà planifiées + % h)',
                v_cours.volume_horaire, v_deja, v_duree
                USING ERRCODE = 'check_violation';
        END IF;

        -- CD-14 : rythme hebdomadaire maximal du cours (semaine ISO)
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)
        INTO v_semaine
        FROM seance s
        WHERE s.id_cours = NEW.id_cours
          AND s.id_edt   = NEW.id_edt
          AND s.statut  <> 'annulee'
          AND s.nature   = 'cours'
          AND date_trunc('week', s.date_seance::timestamp) = date_trunc('week', NEW.date_seance::timestamp)
          AND s.id_seance IS DISTINCT FROM NEW.id_seance;

        IF v_semaine + v_duree > v_cours.heures_semaine_max THEN
            RAISE EXCEPTION 'CD-14 : le cours dépasserait % h dans la semaine (maximum % h)',
                round(v_semaine + v_duree, 1), round(v_cours.heures_semaine_max, 1)
                USING ERRCODE = 'check_violation';
        END IF;

        -- CD-13 : au plus N matières différentes par classe et par semaine, pour
        -- chaque promotion du cours (N = valeur de la contrainte CD-13 de l'emploi
        -- du temps, 3 par défaut)
        SELECT CASE WHEN COUNT(*) = 0 THEN 3
                    WHEN BOOL_OR(k.est_active) THEN MAX(k.valeur) END
        INTO v_max_mat
        FROM contrainte k
        WHERE k.id_edt = NEW.id_edt AND k.type_contrainte = 'CD-13';

        IF v_max_mat IS NOT NULL THEN
            FOR v_classe_pub IN SELECT DISTINCT p.id_classe FROM publics_du_cours(NEW.id_cours) p LOOP
                SELECT COUNT(DISTINCT m.id_matiere) INTO v_nb_mat
                FROM (
                    SELECT c.id_matiere
                    FROM seance s JOIN cours c ON c.id_cours = s.id_cours
                    WHERE s.id_edt  = NEW.id_edt
                      AND s.statut <> 'annulee'
                      AND s.nature  = 'cours'
                      AND date_trunc('week', s.date_seance::timestamp) = date_trunc('week', NEW.date_seance::timestamp)
                      AND s.id_seance IS DISTINCT FROM NEW.id_seance
                      AND EXISTS (SELECT 1 FROM publics_du_cours(s.id_cours) p WHERE p.id_classe = v_classe_pub)
                    UNION ALL
                    SELECT v_cours.id_matiere
                ) m;

                IF v_nb_mat > v_max_mat THEN
                    RAISE EXCEPTION 'CD-13 : la classe % aurait % matières différentes cette semaine (maximum %)',
                        (SELECT code_classe FROM classe WHERE id_classe = v_classe_pub), v_nb_mat, trunc(v_max_mat)::int
                        USING ERRCODE = 'check_violation';
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- Dans un module (matière d'une classe), le rattrapage vient après l'examen
    IF NEW.nature = 'rattrapage' AND NOT EXISTS (
        SELECT 1 FROM seance s JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt = NEW.id_edt AND s.nature = 'examen' AND s.statut <> 'annulee'
          AND c.id_matiere = v_cours.id_matiere AND c.id_classe = v_cours.id_classe
          AND s.date_seance + s.heure_fin <= NEW.date_seance + NEW.heure_debut
    ) THEN
        RAISE EXCEPTION 'EXAMEN : un rattrapage vient après l''examen de son module : programmez d''abord l''examen, à une date antérieure'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.nature = 'examen' AND EXISTS (
        SELECT 1 FROM seance s JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt = NEW.id_edt AND s.nature = 'rattrapage' AND s.statut <> 'annulee'
          AND c.id_matiere = v_cours.id_matiere AND c.id_classe = v_cours.id_classe
          AND s.date_seance + s.heure_debut < NEW.date_seance + NEW.heure_fin
    ) THEN
        RAISE EXCEPTION 'EXAMEN : l''examen d''un module vient avant son rattrapage'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_verifier_seance
    BEFORE INSERT OR UPDATE ON seance
    FOR EACH ROW
    EXECUTE FUNCTION verifier_seance();

-- Contrôles à l'enregistrement d'un cours :
--   * cohérence du type de cours et du groupe ciblé (CIBLER) ;
--   * CD-07 : matière et volume conformes au programme de la classe.
CREATE OR REPLACE FUNCTION verifier_cours()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_prevu  NUMERIC;
BEGIN
    -- Groupe ciblé : une option reçoit tout type de cours ; un groupe de TD ou de
    -- TP, seulement des cours de son type (un CM réunit la classe ou une option)
    IF NEW.id_groupe IS NOT NULL AND
       (SELECT g.type_groupe FROM groupe g WHERE g.id_groupe = NEW.id_groupe) NOT IN (NEW.type_cours, 'OPTION') THEN
        RAISE EXCEPTION '%', CASE WHEN NEW.type_cours = 'CM'
            THEN 'Un CM s''adresse à la classe entière ou à une option : il ne peut pas cibler un groupe de TD ou de TP'
            ELSE format('Un cours de %s ne peut cibler qu''un groupe de %s ou une option', NEW.type_cours, NEW.type_cours) END
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-07 : la matière figure au programme de la classe pour ce semestre et
    -- ce type de cours, et le volume du cours ne dépasse pas le volume prévu
    SELECT CASE NEW.type_cours WHEN 'CM' THEN p.volume_cm
                               WHEN 'TD' THEN p.volume_td
                               ELSE p.volume_tp END
    INTO v_prevu
    FROM programme p
    WHERE p.id_classe   = NEW.id_classe
      AND p.id_matiere  = NEW.id_matiere
      AND p.id_semestre = NEW.id_semestre;

    IF COALESCE(v_prevu, 0) = 0 THEN
        RAISE EXCEPTION 'CD-07 : la matière % n''est pas au programme de la classe % en % pour ce semestre',
            (SELECT m.code_matiere FROM matiere m WHERE m.id_matiere = NEW.id_matiere),
            (SELECT c.code_classe FROM classe c WHERE c.id_classe = NEW.id_classe),
            NEW.type_cours
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.volume_horaire > v_prevu THEN
        RAISE EXCEPTION 'CD-07 : volume du cours (% h) supérieur au volume prévu au programme (% h)',
            NEW.volume_horaire, v_prevu
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_verifier_cours
    BEFORE INSERT OR UPDATE OF id_matiere, type_cours, id_groupe,
                               id_classe, id_semestre, volume_horaire ON cours
    FOR EACH ROW
    EXECUTE FUNCTION verifier_cours();

-- CD-07 (sens inverse) : on ne retire pas du programme, et on ne réduit pas
-- sous le volume des cours existants, une matière déjà enseignée
CREATE OR REPLACE FUNCTION verifier_programme()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_type  TEXT;
    v_max   NUMERIC;
    v_prevu NUMERIC;
BEGIN
    FOREACH v_type IN ARRAY ARRAY['CM','TD','TP'] LOOP
        SELECT MAX(c.volume_horaire) INTO v_max
        FROM cours c
        WHERE c.id_classe = OLD.id_classe AND c.id_matiere = OLD.id_matiere
          AND c.id_semestre = OLD.id_semestre AND c.type_cours = v_type;

        CONTINUE WHEN v_max IS NULL;

        v_prevu := CASE WHEN TG_OP = 'DELETE' THEN 0
                        WHEN v_type = 'CM' THEN NEW.volume_cm
                        WHEN v_type = 'TD' THEN NEW.volume_td
                        ELSE NEW.volume_tp END;

        IF TG_OP = 'UPDATE' AND (NEW.id_classe, NEW.id_matiere, NEW.id_semestre)
                             IS DISTINCT FROM (OLD.id_classe, OLD.id_matiere, OLD.id_semestre) THEN
            v_prevu := 0;
        END IF;

        IF v_prevu < v_max THEN
            RAISE EXCEPTION 'CD-07 : des cours de % utilisent cette ligne du programme (jusqu''à % h) : modifiez-les d''abord', v_type, v_max
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_verifier_programme
    BEFORE UPDATE OR DELETE ON programme
    FOR EACH ROW
    EXECUTE FUNCTION verifier_programme();

-- =====================================================================
--  7. ISOLATION PAR ÉCOLE ET SÉCURITÉ
--
--  Chaque table métier porte id_ecole. L'API sert chaque compte d'école
--  sous le rôle ultraplanning_app, après avoir fixé l'école du compte
--  (paramètre app.id_ecole) ; la RLS de chaque table ne lui montre et ne
--  lui laisse écrire que les lignes de cette école. Toutes les requêtes
--  (API, solveur, assistant, déclencheurs) sont ainsi filtrées.
--  Les clés étrangères incluent id_ecole : une ligne ne peut pas désigner
--  une ligne d'une autre école. Les codes (classe, salle, matricule...)
--  sont uniques dans une école.
--
--  Les rôles anon et authenticated de Supabase n'ont aucun droit : les
--  navigateurs ne lisent rien directement dans la base, tout passe par
--  l'API (Supabase Auth ne sert qu'à la connexion).
-- =====================================================================

-- École de la requête en cours (NULL hors contexte : une insertion sans
-- école échoue sur NOT NULL au lieu de tomber dans une école au hasard)
CREATE OR REPLACE FUNCTION app_ecole()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.id_ecole', true), '')::bigint $$;

DO $$
DECLARE
    v_tables TEXT[] := ARRAY[
        'site','type_salle','filiere','classe','groupe','matiere','enseignant',
        'absence_enseignant','sejour_enseignant','creneau','pause','jour_ferie','conge','salle',
        'semestre','programme','cours','cours_seance_modele','disponibilite','emploi_du_temps',
        'contrainte','conversation','prompt','proposition','seance','piece_jointe',
        'cours_public','cours_type_salle','salle_reservation','site_trajet'];
    t       TEXT;
    r       RECORD;
    v_nom   TEXT;
    v_upd   TEXT;
    v_del   TEXT;
    v_pk    TEXT[];
BEGIN
    -- 1. Colonne id_ecole (les lignes existantes vont à la première école)
    FOREACH t IN ARRAY v_tables LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS id_ecole BIGINT', t);
        EXECUTE format('UPDATE %I SET id_ecole = (SELECT min(id_ecole) FROM ecole) WHERE id_ecole IS NULL', t);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN id_ecole SET DEFAULT app_ecole(), ALTER COLUMN id_ecole SET NOT NULL', t);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_id_ecole_fkey') THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (id_ecole) REFERENCES ecole(id_ecole) '
                           'ON UPDATE CASCADE ON DELETE RESTRICT', t, t || '_id_ecole_fkey');
        END IF;
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (id_ecole)', 'ix_' || t || '_ecole', t);
    END LOOP;

    -- 2. Codes et clés métier uniques dans l'école (et non plus sur toute la plateforme)
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS tbl, c.contype,
               array_agg(a.attname::text ORDER BY k.ord) AS cols
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
        WHERE c.contype IN ('u', 'p') AND c.connamespace = 'public'::regnamespace
          AND c.conrelid::regclass::text = ANY (v_tables)
        GROUP BY c.oid, c.conname, c.conrelid, c.contype
    LOOP
        CONTINUE WHEN 'id_ecole' = ANY (r.cols);
        SELECT array_agg(a.attname::text) INTO v_pk
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = r.tbl::regclass AND c.contype = 'p';
        IF r.contype = 'p' THEN
            -- seul jour_ferie a une clé primaire « métier » (la date)
            CONTINUE WHEN r.tbl <> 'jour_ferie';
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (id_ecole, %s)', r.tbl, r.conname,
                           (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.cols) x));
        ELSE
            -- une contrainte qui contient l'identifiant est déjà unique sur la plateforme
            CONTINUE WHEN r.cols && v_pk;
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (id_ecole, %s)', r.tbl, r.conname,
                           (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.cols) x));
        END IF;
    END LOOP;

    -- 3. Clés étrangères composites (colonnes, id_ecole) : même école des deux côtés
    FOR r IN
        SELECT c.conname, c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
               c.confupdtype, c.confdeltype,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS cols,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num) AS refcols
        FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
          AND c.conrelid::regclass::text = ANY (v_tables)
          AND c.confrelid::regclass::text = ANY (v_tables || ARRAY['utilisateur'])
    LOOP
        CONTINUE WHEN 'id_ecole' = ANY (r.cols);
        v_nom := left(r.ref || '_' || array_to_string(r.refcols, '_') || '_ecole_key', 63);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_nom) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (%s, id_ecole)', r.ref, v_nom,
                           (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.refcols) x));
        END IF;
        v_upd := CASE r.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END;
        -- SET NULL ne vide que la colonne de la clé, jamais id_ecole (PostgreSQL 15+)
        v_del := CASE r.confdeltype
                     WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT'
                     WHEN 'n' THEN 'SET NULL (' || (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.cols) x) || ')'
                     ELSE 'NO ACTION' END;
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.tbl, r.conname);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s, id_ecole) REFERENCES %I (%s, id_ecole) '
                       'ON UPDATE %s ON DELETE %s',
                       r.tbl, r.conname,
                       (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.cols) x), r.ref,
                       (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.refcols) x), v_upd, v_del);
    END LOOP;
END $$;

-- Grille et types de salle de départ d'une nouvelle école (appelée par la
-- console super admin à la création de l'école). Grille : 7h-12h et 13h-16h
-- du lundi au vendredi, 7h-12h le samedi, pause 12h-13h (modifiable ensuite).
CREATE OR REPLACE FUNCTION initialiser_ecole(p_id_ecole BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_pas          INTERVAL := INTERVAL '1 hour';
    v_matin_debut  TIME := '07:00';
    v_matin_fin    TIME := '12:00';
    v_apm_debut    TIME := '13:00';
    v_apm_fin      TIME := '16:00';
    v_jour         TEXT;
    v_t            TIME;
BEGIN
    INSERT INTO type_salle (libelle, id_ecole) VALUES
        ('Amphithéâtre', p_id_ecole), ('Salle standard', p_id_ecole),
        ('Laboratoire', p_id_ecole), ('Salle informatique', p_id_ecole);

    FOREACH v_jour IN ARRAY ARRAY['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'] LOOP
        v_t := v_matin_debut;
        WHILE v_t + v_pas <= v_matin_fin LOOP
            INSERT INTO creneau (jour, heure_debut, heure_fin, id_ecole) VALUES (v_jour, v_t, v_t + v_pas, p_id_ecole);
            v_t := v_t + v_pas;
        END LOOP;
        CONTINUE WHEN v_jour = 'Samedi';
        v_t := v_apm_debut;
        WHILE v_t + v_pas <= v_apm_fin LOOP
            INSERT INTO creneau (jour, heure_debut, heure_fin, id_ecole) VALUES (v_jour, v_t, v_t + v_pas, p_id_ecole);
            v_t := v_t + v_pas;
        END LOOP;
    END LOOP;

    INSERT INTO pause (libelle, heure_debut, heure_fin, id_ecole)
    VALUES ('Pause déjeuner', v_matin_fin, v_apm_debut, p_id_ecole);
END;
$$;

-- Contraintes CD / CS d'un nouvel emploi du temps (poids : élevé 8, moyen 5,
-- faible 2 ; valeur = paramètre de la contrainte)
CREATE OR REPLACE FUNCTION contraintes_par_defaut(p_id_edt BIGINT)
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
INSERT INTO contrainte (libelle, type_contrainte, nature, poids, valeur, id_edt, id_ecole)
SELECT v.libelle, v.code, v.nature, v.poids, v.valeur, e.id_edt, e.id_ecole
FROM (VALUES
    ( 1, 'CD-01', 'dure',   0, NULL::numeric, 'Une salle accueille une seule séance à la fois'),
    ( 2, 'CD-02', 'dure',   0, NULL, 'Un enseignant anime une seule séance à la fois'),
    ( 3, 'CD-03', 'dure',   0, NULL, 'Une classe suit une seule séance à la fois (sauf groupes du même type)'),
    ( 4, 'CD-04', 'dure',   0, NULL, 'Capacité de la salle ≥ effectif'),
    ( 5, 'CD-05', 'dure',   0, NULL, 'Type de salle conforme au type exigé'),
    ( 6, 'CD-06', 'dure',   0, NULL, 'Enseignant présent et disponible'),
    ( 7, 'CD-07', 'dure',   0, NULL, 'Cours conforme au programme de la classe'),
    ( 8, 'CD-08', 'dure',   0, NULL, 'Volume horaire du cours non dépassé'),
    ( 9, 'CD-09', 'dure',   0, NULL, 'Date dans le semestre, hors jours fériés et congés'),
    (10, 'CD-10', 'dure',   0, NULL, 'Séance alignée sur la grille de créneaux'),
    (11, 'CD-11', 'dure',   0, NULL, 'Aucune séance pendant la pause déjeuner'),
    (12, 'CD-12', 'dure',   0, NULL, 'Aucune séance dans une salle indisponible'),
    (13, 'CD-13', 'dure',   0, 3,    'Au plus N matières différentes par classe et par semaine'),
    (14, 'CD-14', 'dure',   0, NULL, 'Rythme hebdomadaire maximal de chaque cours'),
    (15, 'CS-01', 'souple', 8, NULL, 'Respecter les créneaux préférés des enseignants'),
    (16, 'CS-02', 'souple', 5, NULL, 'Éviter les trous dans la journée d''une classe'),
    (17, 'CS-03', 'souple', 5, NULL, 'Limiter les changements de bâtiment et de site'),
    (18, 'CS-04', 'souple', 5, NULL, 'Ramasser les cours des externes, enchaîner ceux des permanents'),
    (19, 'CS-05', 'souple', 2, NULL, 'Placer le CM avant les TD et TP de la semaine'),
    (20, 'CS-06', 'souple', 2, 6,    'Plafonner les heures par jour d''un enseignant'),
    (21, 'CS-07', 'souple', 5, NULL, 'Commencer tôt les cours prioritaires')
) AS v(ord, code, nature, poids, valeur, libelle)
CROSS JOIN emploi_du_temps e
WHERE e.id_edt = p_id_edt
ORDER BY v.ord;
$$;

-- Un identifiant est-il déjà pris, par n'importe quelle école ? L'API s'en sert
-- pour renuméroter les nouvelles lignes de la console (qui numérote d'après ce
-- qu'elle voit). Ne révèle que l'existence de l'identifiant.
CREATE OR REPLACE FUNCTION identifiant_pris(p_table TEXT, p_id BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pk    TEXT;
    v_pris  BOOLEAN;
BEGIN
    SELECT a.attname INTO v_pk
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = format('public.%I', p_table)::regclass AND i.indisprimary AND i.indnatts = 1;
    IF v_pk IS NULL THEN
        RETURN FALSE;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I = $1)', p_table, v_pk) INTO v_pris USING p_id;
    RETURN v_pris;
END;
$$;

-- Rôle de l'API pour les comptes d'école : soumis à la RLS (il n'est pas
-- propriétaire des tables). L'API se connecte en propriétaire puis prend
-- ce rôle (SET ROLE) le temps d'une requête.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ultraplanning_app') THEN
        CREATE ROLE ultraplanning_app NOLOGIN;
    END IF;
END $$;
GRANT ultraplanning_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public, extensions TO ultraplanning_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ultraplanning_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ultraplanning_app;
-- Les écoles et la création d'une école restent au super admin (propriétaire)
REVOKE INSERT, UPDATE, DELETE ON ecole FROM ultraplanning_app;
REVOKE EXECUTE ON FUNCTION initialiser_ecole(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION contraintes_par_defaut(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contraintes_par_defaut(BIGINT) TO ultraplanning_app;
REVOKE EXECUTE ON FUNCTION identifiant_pris(TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identifiant_pris(TEXT, BIGINT) TO ultraplanning_app;

-- RLS : chaque table ne montre que l'école de la requête
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'site','type_salle','filiere','classe','groupe','matiere','enseignant',
        'absence_enseignant','sejour_enseignant','creneau','pause','jour_ferie','conge','salle',
        'semestre','programme','cours','cours_seance_modele','disponibilite','emploi_du_temps',
        'contrainte','conversation','prompt','proposition','seance','piece_jointe',
        'cours_public','cours_type_salle','salle_reservation','site_trajet','utilisateur'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS "ecole du compte" ON %I', t);
        EXECUTE format('CREATE POLICY "ecole du compte" ON %I TO ultraplanning_app '
                       'USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole())', t);
    END LOOP;
END $$;
ALTER TABLE ecole ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ecole du compte" ON ecole;
CREATE POLICY "ecole du compte" ON ecole FOR SELECT TO ultraplanning_app USING (id_ecole = app_ecole());

-- Aucun accès direct pour les rôles de Supabase (API REST de Supabase)
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END LOOP;
END $$;

-- Journal d'audit des séances (BNF-08) : chaque création, modification ou
-- suppression de séance, avec le compte, l'origine (console, génération,
-- assistant ; « systeme » hors API) et l'état avant / après. Écrit par un
-- déclencheur, quelle que soit la façon dont la séance change. Ni l'API des
-- écoles ni les rôles de Supabase ne peuvent le lire ou le modifier : seul le
-- super admin le consulte (API, rôle propriétaire).
CREATE TABLE IF NOT EXISTS journal_seance (
    id_journal      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_action     TIMESTAMPTZ NOT NULL DEFAULT now(),
    action          TEXT NOT NULL CHECK (action IN ('creation','modification','suppression')),
    origine         TEXT NOT NULL DEFAULT 'systeme',
    id_seance       BIGINT NOT NULL,          -- sans clé étrangère : la ligne survit à la séance
    id_edt          BIGINT NOT NULL,
    id_utilisateur  BIGINT,                   -- NULL hors API (ligne de commande, scripts)
    id_ecole        BIGINT NOT NULL REFERENCES ecole(id_ecole) ON UPDATE CASCADE ON DELETE CASCADE,
    avant           JSONB,
    apres           JSONB,
    note            TEXT                      -- motif du changement (paramètre app.note), s'il y en a un
);
CREATE INDEX IF NOT EXISTS ix_journal_ecole_date ON journal_seance (id_ecole, date_action DESC);
CREATE INDEX IF NOT EXISTS ix_journal_seance ON journal_seance (id_seance);
CREATE INDEX IF NOT EXISTS ix_journal_edt_seance ON journal_seance (id_edt, id_seance, date_action DESC, id_journal DESC);

CREATE OR REPLACE FUNCTION journaliser_seance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER                -- écrit dans le journal, que l'API des écoles ne peut pas modifier
SET search_path = public
AS $$
DECLARE
    v_avant  JSONB;
    v_apres  JSONB;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        v_avant := to_jsonb(OLD) - 'plage';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        v_apres := to_jsonb(NEW) - 'plage';
    END IF;
    -- Mise à jour sans changement réel : rien à tracer
    IF TG_OP = 'UPDATE' AND v_avant = v_apres THEN
        RETURN NULL;
    END IF;
    INSERT INTO journal_seance (action, origine, id_seance, id_edt, id_utilisateur, id_ecole, avant, apres, note)
    VALUES (
        CASE TG_OP WHEN 'INSERT' THEN 'creation' WHEN 'UPDATE' THEN 'modification' ELSE 'suppression' END,
        coalesce(nullif(current_setting('app.origine', true), ''), 'systeme'),
        coalesce(NEW.id_seance, OLD.id_seance),
        coalesce(NEW.id_edt, OLD.id_edt),
        nullif(current_setting('app.id_utilisateur', true), '')::bigint,
        coalesce(NEW.id_ecole, OLD.id_ecole),
        v_avant, v_apres,
        nullif(current_setting('app.note', true), ''));
    RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION journaliser_seance() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_journal_seance ON seance;
CREATE TRIGGER trg_journal_seance
    AFTER INSERT OR UPDATE OR DELETE ON seance
    FOR EACH ROW EXECUTE FUNCTION journaliser_seance();

ALTER TABLE journal_seance ENABLE ROW LEVEL SECURITY;   -- aucune politique : invisible hors propriétaire
REVOKE ALL ON journal_seance FROM ultraplanning_app;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
        EXECUTE format('REVOKE ALL ON journal_seance FROM %I', r);
    END LOOP;
END $$;

-- Versions de l'emploi du temps. Une version à jour par semestre (statut
-- brouillon), seule modifiable, et sa copie publiée, celle que voient les
-- invités : seule une publication la change (paramètre app.origine). Le
-- propriétaire (scripts, super admin) n'est pas concerné.
CREATE OR REPLACE FUNCTION proteger_seance_publiee()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user = 'ultraplanning_app'
       AND coalesce(current_setting('app.origine', true), '') <> 'publication'
       AND EXISTS (SELECT 1 FROM emploi_du_temps e
                   WHERE e.id_edt = coalesce(NEW.id_edt, OLD.id_edt) AND e.statut IN ('publie', 'archive')) THEN
        RAISE EXCEPTION 'La version publiée ne se modifie pas : modifiez la version à jour, puis publiez-la'
            USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_seance_publiee ON seance;
CREATE TRIGGER trg_seance_publiee
    BEFORE INSERT OR UPDATE OR DELETE ON seance
    FOR EACH ROW EXECUTE FUNCTION proteger_seance_publiee();

-- Un examen ne se retire pas tant que son rattrapage existe
CREATE OR REPLACE FUNCTION examen_avec_rattrapage()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF OLD.statut <> 'annulee' THEN
        PERFORM garder_examen(OLD.id_edt, OLD.id_seance, OLD.id_cours);
    END IF;
    RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_examen_avec_rattrapage ON seance;
CREATE TRIGGER trg_examen_avec_rattrapage
    BEFORE DELETE ON seance
    FOR EACH ROW WHEN (OLD.nature = 'examen') EXECUTE FUNCTION examen_avec_rattrapage();

-- Chaque publication : la version à jour (id_edt), sa dernière version
-- d'historique à cet instant, et ce qui a changé pour les invités.
CREATE TABLE IF NOT EXISTS publication_edt (
    id_publication    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_edt            BIGINT NOT NULL,
    date_publication  TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_version      TIMESTAMPTZ,
    ajoutees          INTEGER NOT NULL DEFAULT 0,
    retirees          INTEGER NOT NULL DEFAULT 0,
    modifiees         INTEGER NOT NULL DEFAULT 0,
    id_utilisateur    BIGINT,                   -- sans clé étrangère, comme le journal
    id_ecole          BIGINT NOT NULL DEFAULT app_ecole()
                      REFERENCES ecole(id_ecole) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_edt, id_ecole) REFERENCES emploi_du_temps (id_edt, id_ecole)
                      ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_publication_edt ON publication_edt (id_edt, date_publication DESC);
ALTER TABLE publication_edt ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ecole du compte" ON publication_edt;
CREATE POLICY "ecole du compte" ON publication_edt TO ultraplanning_app
    USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole());
REVOKE ALL ON publication_edt FROM ultraplanning_app;
GRANT SELECT, INSERT ON publication_edt TO ultraplanning_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ultraplanning_app;

-- Historique d'un emploi du temps, lu dans le journal (que l'API ne peut pas lire
-- directement) et limité à l'école de la requête. Une version = une transaction ;
-- une séance supprimée puis recréée dans la même transaction compte une fois.
CREATE OR REPLACE FUNCTION versions_edt(p_id_edt BIGINT)
RETURNS TABLE (numero BIGINT, date_version TIMESTAMPTZ, origine TEXT, id_utilisateur BIGINT, note TEXT,
               ajoutees BIGINT, retirees BIGINT, modifiees BIGINT, detail JSONB)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH par_seance AS (
        SELECT j.date_action, j.id_seance,
               (array_agg(j.avant ORDER BY j.id_journal))[1] AS avant,
               (array_agg(j.apres ORDER BY j.id_journal DESC))[1] AS apres,
               min(j.origine) AS origine, max(j.id_utilisateur) AS id_utilisateur, max(j.note) AS note
        FROM journal_seance j
        WHERE j.id_edt = p_id_edt AND j.id_ecole = app_ecole()
        GROUP BY j.date_action, j.id_seance
    )
    SELECT row_number() OVER (ORDER BY p.date_action), p.date_action, min(p.origine), max(p.id_utilisateur), max(p.note),
           count(*) FILTER (WHERE p.avant IS NULL),
           count(*) FILTER (WHERE p.apres IS NULL),
           count(*) FILTER (WHERE p.avant IS NOT NULL AND p.apres IS NOT NULL),
           CASE WHEN count(*) = 1 THEN (array_agg(jsonb_build_object('avant', p.avant, 'apres', p.apres)))[1] END
    FROM par_seance p
    WHERE p.avant IS DISTINCT FROM p.apres
    GROUP BY p.date_action
$$;

-- Séances d'un emploi du temps à une version : le dernier état connu de chacune
CREATE OR REPLACE FUNCTION seances_version(p_id_edt BIGINT, p_date TIMESTAMPTZ)
RETURNS SETOF JSONB
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT x.apres
    FROM (SELECT DISTINCT ON (j.id_seance) j.apres
          FROM journal_seance j
          WHERE j.id_edt = p_id_edt AND j.id_ecole = app_ecole() AND j.date_action <= p_date
          ORDER BY j.id_seance, j.date_action DESC, j.id_journal DESC) x
    WHERE x.apres IS NOT NULL
$$;
REVOKE EXECUTE ON FUNCTION versions_edt(BIGINT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION seances_version(BIGINT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION versions_edt(BIGINT) TO ultraplanning_app;
GRANT EXECUTE ON FUNCTION seances_version(BIGINT, TIMESTAMPTZ) TO ultraplanning_app;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
        EXECUTE format('REVOKE ALL ON publication_edt FROM %I', r);
        EXECUTE format('REVOKE ALL ON FUNCTION versions_edt(BIGINT) FROM %I', r);
        EXECUTE format('REVOKE ALL ON FUNCTION seances_version(BIGINT, TIMESTAMPTZ) FROM %I', r);
    END LOOP;
END $$;

-- =====================================================================
--  8. DONNÉES DE BASE
--     L'école cliente, puis sa grille : les insertions suivantes reçoivent
--     son id_ecole par défaut (paramètre app.id_ecole de la session).
-- =====================================================================

-- École cliente (le super admin, lui, se crée avec l'API : python -m app.creer_superadmin)
INSERT INTO ecole (code_ecole, nom, ville, pays, email_contact) VALUES
    ('2IE', 'Institut International d''Ingénierie de l''Eau et de l''Environnement',
     'Ouagadougou', 'Burkina Faso', 'scolarite@univ.example');

SELECT set_config('app.id_ecole', id_ecole::text, false) FROM ecole WHERE code_ecole = '2IE';

-- Types de salle, grille de créneaux (1 h) et pause déjeuner (À CONFIRMER avec la scolarité)
SELECT initialiser_ecole(app_ecole());

-- =====================================================================
--  9. JEU DE DONNÉES DE TEST — FICTIF
--     À remplacer par les données réelles (capacités des salles, noms,
--     effectifs, volumes horaires...). Supprimer cette section pour
--     une base vierge.
-- =====================================================================

-- Semestre de test
INSERT INTO semestre (libelle, annee_academique, date_debut, date_fin)
VALUES ('Semestre 1', '2026-2027', '2026-10-12', '2027-02-19');

-- Jours fériés fixes (exemples à vérifier). Les fêtes mobiles (Aïd, Pâques,
-- Ascension, Pentecôte...) sont à ajouter chaque année une fois annoncées.
INSERT INTO jour_ferie (date_ferie, libelle) VALUES
    ('2026-11-01', 'Toussaint'),
    ('2026-12-11', 'Fête nationale (proclamation de l''indépendance)'),
    ('2026-12-25', 'Noël'),
    ('2027-01-01', 'Jour de l''An'),
    ('2027-01-03', 'Anniversaire du soulèvement populaire de 1966');

-- Congés (périodes sans cours ; id_classe vide = tout l'établissement)
INSERT INTO conge (libelle, type_conge, date_debut, date_fin) VALUES
    ('Vacances de fin d''année', 'vacances', '2026-12-21', '2027-01-03'),
    ('Examens du semestre 1',    'examens',  '2027-02-15', '2027-02-19');

-- Comptes de gestion de l'école (pas de mot de passe : Supabase Auth)
INSERT INTO utilisateur (login, email, role, id_ecole)
SELECT v.login, v.email, v.role, e.id_ecole
FROM (VALUES
    (1, 'planificateur', 'scolarite@univ.example', 'planificateur'),
    (2, 'admin',         'dsi@univ.example',       'administrateur')
) AS v(ord, login, email, role)
CROSS JOIN ecole e WHERE e.code_ecole = '2IE'
ORDER BY v.ord;

-- Les colonnes « ord » fixent l'ordre d'insertion, donc les identifiants
-- (un INSERT ... SELECT ... JOIN ne garantit pas d'ordre sans ORDER BY).

-- Sites : campus et annexe de l'école
INSERT INTO site (code_site, nom_site, type_site, adresse) VALUES
    ('KAMB',  'Campus de Kamboinsé',   'campus', 'Kamboinsé, Ouagadougou'),
    ('OUAGA', 'Campus de Ouagadougou', 'campus', 'Ouagadougou'),
    ('ANNEXE','Annexe de Ouagadougou', 'annexe', 'Ouagadougou');

-- Salles (capacités FICTIVES)
INSERT INTO salle (code_salle, nom_salle, capacite, batiment, id_type_salle, id_site)
SELECT v.code, v.nom, v.cap, v.bat, t.id_type_salle, si.id_site
FROM (VALUES
    ( 1, 'K-AMPHI1', 'Amphi 200',             200, 'Bloc A',             'Amphithéâtre',       'KAMB'),
    ( 2, 'K-AMPHI2', 'Amphi 120',             120, 'Bloc A',             'Amphithéâtre',       'KAMB'),
    ( 3, 'K-A101',   'Salle A101',             60, 'Bloc A',             'Salle standard',     'KAMB'),
    ( 4, 'K-A102',   'Salle A102',             50, 'Bloc A',             'Salle standard',     'KAMB'),
    ( 5, 'K-B201',   'Salle B201',             40, 'Bloc B',             'Salle standard',     'KAMB'),
    ( 6, 'K-LAB1',   'Laboratoire 1',          30, 'Bloc B',             'Laboratoire',        'KAMB'),
    ( 7, 'K-LAB2',   'Laboratoire 2',          25, 'Bloc B',             'Laboratoire',        'KAMB'),
    ( 8, 'K-INFO1',  'Salle informatique 1',   40, 'Bloc B',             'Salle informatique', 'KAMB'),
    ( 9, 'O-AMPHI1', 'Amphi 250',             250, 'Bâtiment principal', 'Amphithéâtre',       'OUAGA'),
    (10, 'O-B101',   'Salle 101',              80, 'Bâtiment principal', 'Salle standard',     'OUAGA'),
    (11, 'O-B102',   'Salle 102',              45, 'Bâtiment principal', 'Salle standard',     'OUAGA'),
    (12, 'O-INFO1',  'Salle informatique',     35, NULL,                 'Salle informatique', 'ANNEXE'),
    (13, 'O-LAB1',   'Laboratoire',            30, NULL,                 'Laboratoire',        'ANNEXE')
) AS v(ord, code, nom, cap, bat, type_libelle, code_site)
JOIN type_salle t ON t.libelle = v.type_libelle
JOIN site      si ON si.code_site = v.code_site
ORDER BY v.ord;

-- Filières (site principal)
INSERT INTO filiere (code_filiere, libelle, id_site) VALUES
    ('INFO', 'Informatique',              (SELECT id_site FROM site WHERE code_site = 'KAMB')),
    ('IA',   'Intelligence artificielle', (SELECT id_site FROM site WHERE code_site = 'KAMB'));

-- Classes
INSERT INTO classe (code_classe, libelle, niveau, effectif, id_filiere)
SELECT v.code, v.libelle, v.niveau, v.effectif, f.id_filiere
FROM (VALUES
    ( 1, 'L1INFO', 'Licence 1 Informatique', 'L1', 120, 'INFO'),
    ( 2, 'L2INFO', 'Licence 2 Informatique', 'L2',  80, 'INFO'),
    ( 3, 'L3INFO', 'Licence 3 Informatique', 'L3',  60, 'INFO'),
    ( 4, 'M1IA',   'Master 1 IA',            'M1',  30, 'IA'),
    ( 5, 'M2IA',   'Master 2 IA',            'M2',  24, 'IA')
) AS v(ord, code, libelle, niveau, effectif, code_filiere)
JOIN filiere f ON f.code_filiere = v.code_filiere
ORDER BY v.ord;

-- Groupes (la somme des effectifs de groupes d'un même type = effectif de la classe)
INSERT INTO groupe (code_groupe, type_groupe, effectif, id_classe)
SELECT v.code, v.type, v.effectif, c.id_classe
FROM (VALUES
    ( 1, 'TD-A',  'TD', 60, 'L1INFO'),
    ( 2, 'TD-B',  'TD', 60, 'L1INFO'),
    ( 3, 'TD-A',  'TD', 40, 'L2INFO'),
    ( 4, 'TD-B',  'TD', 40, 'L2INFO'),
    ( 5, 'TP-G1', 'TP', 25, 'L2INFO'),
    ( 6, 'TP-G2', 'TP', 25, 'L2INFO'),
    ( 7, 'TP-G3', 'TP', 30, 'L2INFO'),
    ( 8, 'TP-G1', 'TP', 15, 'M1IA'),
    ( 9, 'TP-G2', 'TP', 15, 'M1IA')
) AS v(ord, code, type, effectif, code_classe)
JOIN classe c ON c.code_classe = v.code_classe
ORDER BY v.ord;

-- Enseignants (noms fictifs)
INSERT INTO enseignant (matricule, nom, prenom, email, grade, nb_heures_max_semaine) VALUES
    ('ENS-001', 'Ouédraogo',    'Adama',    'a.ouedraogo@univ.example',    'Professeur',            16),
    ('ENS-002', 'Sawadogo',     'Mariam',   'm.sawadogo@univ.example',     'Maître de conférences', 16),
    ('ENS-003', 'Kaboré',       'Issouf',   'i.kabore@univ.example',       'Maître-assistant',      18),
    ('ENS-004', 'Compaoré',     'Aïssata',  'a.compaore@univ.example',     'Maître de conférences', 16),
    ('ENS-005', 'Zongo',        'Boureima', 'b.zongo@univ.example',        'Professeur',            14),
    ('ENS-006', 'Traoré',       'Fatoumata','f.traore@univ.example',       'Maître de conférences', 16),
    ('ENS-007', 'Nikièma',      'Paul',     'p.nikiema@univ.example',      'Assistant',             20),
    ('ENS-008', 'Bationo',      'Salif',    's.bationo@univ.example',      'Maître-assistant',      18),
    ('ENS-009', 'Diallo',       'Moussa',   'm.diallo@univ.example',       'Professeur invité',     24);

-- Statuts : Zongo et Bationo sont vacataires locaux ; Diallo est un
-- intervenant externe, attendu en novembre pour le cours de M2IA
UPDATE enseignant SET statut = 'vacataire_local' WHERE matricule IN ('ENS-005', 'ENS-008');
UPDATE enseignant SET statut = 'externe'         WHERE matricule = 'ENS-009';

-- Site de rattachement des enseignants
UPDATE enseignant SET id_site = (SELECT id_site FROM site WHERE code_site = 'KAMB');
UPDATE enseignant SET id_site = (SELECT id_site FROM site WHERE code_site = 'OUAGA')
WHERE matricule = 'ENS-008';

-- Matières
INSERT INTO matiere (code_matiere, libelle, coefficient) VALUES
    ('ALGO',  'Algorithmique',                 3),
    ('BD',    'Bases de données',              3),
    ('RES',   'Réseaux informatiques',         2),
    ('WEB',   'Programmation Web',             2),
    ('SE',    'Systèmes d''exploitation',      2),
    ('PROBA', 'Probabilités et statistiques',  3),
    ('ML',    'Apprentissage automatique',     4),
    ('ANG',   'Anglais technique',             1);

-- Programme (maquettes) : à saisir AVANT les cours (CD-07). Volumes en heures ;
-- un TD ou un TP vaut pour chaque groupe. Écarts visibles dans la couverture :
-- le TD-B de L1INFO n'a pas de cours de Probabilités, le TP-G2 de M1IA n'a
-- pas de TP d'Apprentissage automatique, et le M2IA n'a encore aucun cours.
INSERT INTO programme (id_classe, id_matiere, id_semestre, volume_cm, volume_td, volume_tp)
SELECT c.id_classe, m.id_matiere, s.id_semestre, v.cm, v.td, v.tp
FROM (VALUES
    ( 1, 'L1INFO', 'ANG',   24,  0,  0),
    ( 2, 'L1INFO', 'PROBA',  0, 24,  0),
    ( 3, 'L2INFO', 'ALGO',  24, 24,  0),
    ( 4, 'L2INFO', 'BD',    60,  0,  0),
    ( 5, 'L2INFO', 'RES',    0,  0, 36),
    ( 6, 'L3INFO', 'WEB',   36,  0,  0),
    ( 7, 'L3INFO', 'SE',    36,  0,  0),
    ( 8, 'M1IA',   'ML',    30,  0, 24),
    ( 9, 'M2IA',   'ML',    24,  0, 24)
) AS v(ord, code_classe, code_matiere, cm, td, tp)
JOIN classe  c ON c.code_classe  = v.code_classe
JOIN matiere m ON m.code_matiere = v.code_matiere
CROSS JOIN semestre s WHERE s.libelle = 'Semestre 1' AND s.annee_academique = '2026-2027'
ORDER BY v.ord;

-- Cours (id_groupe renseigné = cours de groupe ; NULL = classe entière)
INSERT INTO cours (type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite,
                   id_matiere, id_classe, id_groupe, id_enseignant, id_type_salle, id_semestre)
SELECT v.type, v.volume, v.duree, v.nb, v.prio,
       m.id_matiere, c.id_classe, g.id_groupe, e.id_enseignant, ts.id_type_salle, s.id_semestre
FROM (VALUES
    -- matière, type, volume, durée, nb/sem, prio, classe,  groupe,  enseignant, type de salle
    ( 1, 'ALGO',  'CM', 24, 2, 1, 2, 'L2INFO', NULL,    'ENS-001', 'Amphithéâtre'),
    ( 2, 'ALGO',  'TD', 24, 2, 1, 1, 'L2INFO', 'TD-A',  'ENS-002', 'Salle standard'),
    ( 3, 'ALGO',  'TD', 24, 2, 1, 1, 'L2INFO', 'TD-B',  'ENS-002', 'Salle standard'),
    ( 4, 'RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G1', 'ENS-003', 'Laboratoire'),
    ( 5, 'RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G2', 'ENS-007', 'Laboratoire'),
    ( 6, 'RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G3', 'ENS-008', 'Laboratoire'),
    ( 7, 'BD',    'CM', 60, 2, 2, 2, 'L2INFO', NULL,    'ENS-004', 'Amphithéâtre'),
    ( 8, 'WEB',   'CM', 36, 2, 2, 1, 'L3INFO', NULL,    'ENS-005', 'Salle standard'),
    ( 9, 'SE',    'CM', 36, 3, 1, 1, 'L3INFO', NULL,    'ENS-001', 'Salle standard'),
    (10, 'ML',    'CM', 30, 3, 1, 2, 'M1IA',   NULL,    'ENS-006', 'Salle standard'),
    (11, 'ML',    'TP', 24, 2, 1, 1, 'M1IA',   'TP-G1', 'ENS-006', 'Salle informatique'),
    (12, 'ANG',   'CM', 24, 2, 1, 0, 'L1INFO', NULL,    'ENS-007', 'Amphithéâtre'),
    (13, 'PROBA', 'TD', 24, 2, 1, 1, 'L1INFO', 'TD-A',  'ENS-008', 'Salle standard')
) AS v(ord, code_matiere, type, volume, duree, nb, prio, code_classe, code_groupe, matricule, type_salle)
JOIN matiere    m  ON m.code_matiere = v.code_matiere
JOIN classe     c  ON c.code_classe  = v.code_classe
LEFT JOIN groupe g ON g.id_classe = c.id_classe AND g.code_groupe = v.code_groupe
JOIN enseignant e  ON e.matricule    = v.matricule
JOIN type_salle ts ON ts.libelle     = v.type_salle
CROSS JOIN semestre s WHERE s.libelle = 'Semestre 1' AND s.annee_academique = '2026-2027'
ORDER BY v.ord;

-- Découpage hebdomadaire des cours en séances (rang, durée en heures)
INSERT INTO cours_seance_modele (id_cours, rang, duree_heures)
SELECT co.id_cours, v.rang, v.duree
FROM (VALUES
    ('ALGO','CM','L2INFO',NULL,   1, 2),
    ('ALGO','TD','L2INFO','TD-A', 1, 2),
    ('ALGO','TD','L2INFO','TD-B', 1, 2),
    ('RES', 'TP','L2INFO','TP-G1',1, 3),
    ('RES', 'TP','L2INFO','TP-G2',1, 3),
    ('RES', 'TP','L2INFO','TP-G3',1, 3),
    ('BD',  'CM','L2INFO',NULL,   1, 2),     -- BD : 2 h + 3 h par semaine
    ('BD',  'CM','L2INFO',NULL,   2, 3),
    ('WEB', 'CM','L3INFO',NULL,   1, 2),     -- Web : 2 h + 2 h par semaine
    ('WEB', 'CM','L3INFO',NULL,   2, 2),
    ('SE',  'CM','L3INFO',NULL,   1, 3),
    ('ML',  'CM','M1IA',  NULL,   1, 3),
    ('ML',  'TP','M1IA',  'TP-G1',1, 2),
    ('ANG', 'CM','L1INFO',NULL,   1, 2),
    ('PROBA','TD','L1INFO','TD-A',1, 2)
) AS v(code_matiere, type, code_classe, code_groupe, rang, duree)
JOIN matiere m ON m.code_matiere = v.code_matiere
JOIN classe  c ON c.code_classe  = v.code_classe
LEFT JOIN groupe g ON g.id_classe = c.id_classe AND g.code_groupe = v.code_groupe
JOIN cours  co ON co.id_matiere = m.id_matiere
              AND co.id_classe  = c.id_classe
              AND co.type_cours = v.type
              AND co.id_groupe IS NOT DISTINCT FROM g.id_groupe;

-- Disponibilités des enseignants (par plage horaire, indépendant de la grille)
INSERT INTO disponibilite (id_enseignant, id_creneau, niveau, motif)
SELECT e.id_enseignant, c.id_creneau, v.niveau, v.motif
FROM (VALUES
    ('ENS-001', 'Lundi',    '08:00'::time, '10:00'::time, 'indisponible', 'Mission à l''extérieur'),
    ('ENS-002', 'Mercredi', '13:00'::time, '16:00'::time, 'indisponible', 'Recherche'),
    ('ENS-004', 'Mardi',    '08:00'::time, '12:00'::time, 'preference',   NULL),
    ('ENS-005', 'Vendredi', '13:00'::time, '16:00'::time, 'indisponible', 'Réunion de département'),
    ('ENS-006', 'Jeudi',    '08:00'::time, '12:00'::time, 'preference',   NULL)
) AS v(matricule, jour, de, a, niveau, motif)
JOIN enseignant e ON e.matricule = v.matricule
JOIN creneau    c ON c.jour = v.jour AND c.heure_debut >= v.de AND c.heure_fin <= v.a;

-- Absences datées (CD-06)
INSERT INTO absence_enseignant (id_enseignant, date_debut, date_fin, motif)
SELECT e.id_enseignant, v.de, v.a, v.motif
FROM (VALUES
    ('ENS-005', '2026-11-16'::date, '2026-11-20'::date, 'Mission d''enseignement à Bobo-Dioulasso')
) AS v(matricule, de, a, motif)
JOIN enseignant e ON e.matricule = v.matricule;

-- Séjours des intervenants externes (CD-06)
INSERT INTO sejour_enseignant (id_enseignant, date_debut, date_fin, commentaire)
SELECT e.id_enseignant, v.de, v.a, v.commentaire
FROM (VALUES
    ('ENS-009', '2026-11-09'::date, '2026-11-28'::date, 'Mission d''enseignement, M2IA')
) AS v(matricule, de, a, commentaire)
JOIN enseignant e ON e.matricule = v.matricule;

-- Emploi du temps de travail
INSERT INTO emploi_du_temps (libelle, version, mode_generation, statut, id_semestre, id_utilisateur)
SELECT 'EDT Semestre 1 2026-2027', 1, 'manuel', 'brouillon', s.id_semestre, u.id_utilisateur
FROM semestre s, utilisateur u
WHERE s.libelle = 'Semestre 1' AND s.annee_academique = '2026-2027'
  AND u.login = 'planificateur';

-- Contraintes de l'emploi du temps de travail
SELECT contraintes_par_defaut(id_edt) FROM emploi_du_temps
WHERE libelle = 'EDT Semestre 1 2026-2027' AND version = 1;

-- Fin du script : la session sort du contexte de l'école
SELECT set_config('app.id_ecole', '', false);
