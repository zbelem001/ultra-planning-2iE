-- =====================================================================
--  Système de planification des cours et de génération automatique
--  des emplois du temps
--  Script de création de la base de données — PostgreSQL / Supabase
--  VERSION 2
--
--  Utilisation : Supabase > SQL Editor > New query > coller > Run
--  Source      : fichier.md (section 7 : modèle de données / MLD)
--
--  Changements de la version 2
--   1. GROUPE relié à COURS (cours.id_groupe, nullable = classe entière) ;
--      CD-03 et CD-04 raisonnent au niveau du groupe.
--   2. Durées de séance 2 h à 4 h : grille de créneaux fine (1 h),
--      SEANCE porte heure_debut / heure_fin, détection de chevauchement
--      réelle (EXCLUDE + btree_gist), table COURS_SEANCE_MODELE
--      (découpage d'un cours), table PAUSE (pause déjeuner).
--   3. INDISPONIBILITE remplacée par DISPONIBILITE (3 niveaux).
--   4. Jeu de données de test fictif (section 9).
--   5. Table JOUR_FERIE, prise en compte dans CD-09.
--
--  Hypothèses :
--   * volume_horaire (COURS) et durées sont exprimés en HEURES.
--   * La grille de base est de 1 h (modifiable : voir section 9).
--   * La pause déjeuner (12h-14h) est À CONFIRMER avec la scolarité.
--   * Les données de la section 9 sont FICTIVES : capacités, noms et
--     volumes sont à remplacer par les valeurs réelles.
-- =====================================================================

-- Nettoyage (permet de relancer le script à zéro) ---------------------
DROP TABLE IF EXISTS
    seance, prompt, contrainte, indisponibilite, disponibilite,
    cours_seance_modele, cours, groupe, classe, filiere, emploi_du_temps,
    utilisateur, semestre, salle, type_salle, creneau, pause, jour_ferie,
    matiere, enseignant
CASCADE;
DROP FUNCTION IF EXISTS verifier_seance() CASCADE;

-- Extension nécessaire aux contraintes d'exclusion (chevauchements)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- =====================================================================
--  1. TABLES DE RÉFÉRENCE
-- =====================================================================

CREATE TABLE filiere (
    id_filiere    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_filiere  TEXT NOT NULL UNIQUE,
    libelle       TEXT NOT NULL
);

CREATE TABLE classe (
    id_classe    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_classe  TEXT NOT NULL UNIQUE,
    libelle      TEXT NOT NULL,
    niveau       TEXT NOT NULL
                 CHECK (niveau IN ('L1','L2','L3','M1','M2')),
    effectif     INTEGER NOT NULL DEFAULT 0 CHECK (effectif >= 0),
    id_filiere   BIGINT NOT NULL REFERENCES filiere(id_filiere)
                 ON UPDATE CASCADE ON DELETE RESTRICT       -- APPARTENIR
);

-- Subdivision d'une classe (groupes de TD / TP)                 -- DIVISER
CREATE TABLE groupe (
    id_groupe    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_groupe  TEXT NOT NULL,
    type_groupe  TEXT NOT NULL
                 CHECK (type_groupe IN ('CM','TD','TP')),
    effectif     INTEGER NOT NULL DEFAULT 0 CHECK (effectif >= 0),
    id_classe    BIGINT NOT NULL REFERENCES classe(id_classe)
                 ON UPDATE CASCADE ON DELETE CASCADE,
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
    nb_heures_max_semaine  INTEGER CHECK (nb_heures_max_semaine > 0)
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

CREATE TABLE type_salle (
    id_type_salle  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    libelle        TEXT NOT NULL UNIQUE      -- amphithéâtre, laboratoire...
);

CREATE TABLE salle (
    id_salle        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_salle      TEXT NOT NULL UNIQUE,
    nom_salle       TEXT NOT NULL,
    capacite        INTEGER NOT NULL CHECK (capacite > 0),
    batiment        TEXT,
    est_disponible  BOOLEAN NOT NULL DEFAULT TRUE,
    id_type_salle   BIGINT NOT NULL REFERENCES type_salle(id_type_salle)
                    ON UPDATE CASCADE ON DELETE RESTRICT   -- ETRE_DE_TYPE
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
    login           TEXT NOT NULL UNIQUE,
    -- Nullable : l'authentification passe par le SSO / CAS (BNF-06).
    -- Si renseigné, il doit contenir un HASH, jamais un mot de passe en clair.
    mot_de_passe    TEXT,
    email           TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL DEFAULT 'etudiant'
                    CHECK (role IN ('administrateur','planificateur',
                                    'chef_departement','enseignant',
                                    'etudiant'))
);

-- =====================================================================
--  2. COURS, DÉCOUPAGE, DISPONIBILITÉS
-- =====================================================================

CREATE TABLE cours (
    id_cours            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_cours          TEXT NOT NULL CHECK (type_cours IN ('CM','TD','TP')),
    volume_horaire      NUMERIC(6,2) NOT NULL CHECK (volume_horaire > 0),  -- heures, total
    -- durée « par défaut » d'une séance, utilisée si le cours n'a pas de découpage
    duree_seance        NUMERIC(4,2) NOT NULL
                        CHECK (duree_seance BETWEEN 2 AND 4),              -- heures
    nb_seances_semaine  INTEGER NOT NULL DEFAULT 1 CHECK (nb_seances_semaine > 0),
    priorite            INTEGER NOT NULL DEFAULT 0,
    id_matiere          BIGINT NOT NULL REFERENCES matiere(id_matiere)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- PORTER_SUR
    id_classe           BIGINT NOT NULL REFERENCES classe(id_classe)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- CONCERNER
    -- NULL = classe entière (ex. CM) ; sinon le groupe doit appartenir
    -- à la classe du cours (clé étrangère composite ci-dessous).   -- CIBLER
    id_groupe           BIGINT,
    id_enseignant       BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- ASSURER
    id_type_salle       BIGINT REFERENCES type_salle(id_type_salle)
                        ON UPDATE CASCADE ON DELETE SET NULL,   -- NECESSITER (0,1)
    id_semestre         BIGINT NOT NULL REFERENCES semestre(id_semestre)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- PROGRAMMER
    FOREIGN KEY (id_groupe, id_classe) REFERENCES groupe(id_groupe, id_classe)
                        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Découpage hebdomadaire d'un cours en séances (ex. rang 1 : 2 h, rang 2 : 3 h).
-- Le moteur lit ce découpage pour savoir combien de séances placer et de quelle
-- durée. Sans ligne ici, le cours est placé en une séance de duree_seance.
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
    est_active       BOOLEAN NOT NULL DEFAULT TRUE,
    id_edt           BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                     ON UPDATE CASCADE ON DELETE CASCADE        -- PARAMETRER
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
                    ON UPDATE CASCADE ON DELETE CASCADE         -- MODIFIER
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
    id_salle         BIGINT NOT NULL REFERENCES salle(id_salle)
                     ON UPDATE CASCADE ON DELETE RESTRICT,  -- SE_DEROULER
    id_creneau       BIGINT NOT NULL REFERENCES creneau(id_creneau)
                     ON UPDATE CASCADE ON DELETE RESTRICT,  -- OCCUPER
    id_edt           BIGINT NOT NULL REFERENCES emploi_du_temps(id_edt)
                     ON UPDATE CASCADE ON DELETE CASCADE,   -- COMPOSER

    -- CD-10 : une séance dure de 2 h à 4 h
    CHECK (heure_fin > heure_debut),
    CHECK (heure_fin - heure_debut BETWEEN INTERVAL '2 hours' AND INTERVAL '4 hours'),

    -- Plage horaire datée, calculée automatiquement (ne pas l'insérer)
    plage            TSRANGE GENERATED ALWAYS AS
                     (tsrange(date_seance + heure_debut, date_seance + heure_fin)) STORED,

    -- CD-01 : une salle ne peut pas avoir deux séances qui se chevauchent
    -- (dans un même emploi du temps ; les séances annulées sont ignorées).
    CONSTRAINT ex_seance_salle
        EXCLUDE USING gist (id_edt WITH =, id_salle WITH =, plage WITH &&)
        WHERE (statut <> 'annulee')
);

-- =====================================================================
--  5. INDEX SUR LES CLÉS ÉTRANGÈRES
-- =====================================================================

CREATE INDEX ix_classe_filiere     ON classe(id_filiere);
CREATE INDEX ix_groupe_classe      ON groupe(id_classe);
CREATE INDEX ix_salle_type         ON salle(id_type_salle);
CREATE INDEX ix_cours_matiere      ON cours(id_matiere);
CREATE INDEX ix_cours_classe       ON cours(id_classe);
CREATE INDEX ix_cours_groupe       ON cours(id_groupe);
CREATE INDEX ix_cours_enseignant   ON cours(id_enseignant);
CREATE INDEX ix_cours_type_salle   ON cours(id_type_salle);
CREATE INDEX ix_cours_semestre     ON cours(id_semestre);
CREATE INDEX ix_dispo_creneau      ON disponibilite(id_creneau);
CREATE INDEX ix_edt_semestre       ON emploi_du_temps(id_semestre);
CREATE INDEX ix_edt_utilisateur    ON emploi_du_temps(id_utilisateur);
CREATE INDEX ix_contrainte_edt     ON contrainte(id_edt);
CREATE INDEX ix_prompt_edt         ON prompt(id_edt);
CREATE INDEX ix_prompt_utilisateur ON prompt(id_utilisateur);
CREATE INDEX ix_seance_cours       ON seance(id_cours);
CREATE INDEX ix_seance_creneau     ON seance(id_creneau);
CREATE INDEX ix_seance_edt_date    ON seance(id_edt, date_seance);

-- =====================================================================
--  6. CONTRÔLE DES CONTRAINTES DURES (déclencheur sur SEANCE)
--     CD-02, CD-03, CD-04, CD-05, CD-06, CD-08, CD-09, CD-10, CD-11
--     (CD-01 est garanti par la contrainte EXCLUDE ex_seance_salle ;
--      la durée 2-4 h est garantie par un CHECK sur SEANCE)
-- =====================================================================

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
BEGIN
    -- Une séance annulée n'est soumise à aucun contrôle.
    IF NEW.statut = 'annulee' THEN
        RETURN NEW;
    END IF;

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

    -- CD-02 : un enseignant ne peut pas animer deux séances qui se chevauchent
    IF EXISTS (
        SELECT 1
        FROM seance s
        JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt  = NEW.id_edt
          AND s.statut <> 'annulee'
          AND c.id_enseignant = v_cours.id_enseignant
          AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) THEN
        RAISE EXCEPTION 'CD-02 : l''enseignant a déjà une séance qui chevauche cette plage horaire'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-03 : une classe / un groupe ne peut pas suivre deux séances qui se
    -- chevauchent. Un cours de classe entière (id_groupe NULL) est en conflit
    -- avec tous les groupes de la classe ; un cours de groupe n'est en conflit
    -- qu'avec le même groupe et avec les cours de classe entière.
    IF EXISTS (
        SELECT 1
        FROM seance s
        JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt  = NEW.id_edt
          AND s.statut <> 'annulee'
          AND c.id_classe = v_cours.id_classe
          AND (v_cours.id_groupe IS NULL
               OR c.id_groupe IS NULL
               OR c.id_groupe = v_cours.id_groupe)
          AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) THEN
        RAISE EXCEPTION 'CD-03 : la classe/le groupe a déjà une séance qui chevauche cette plage horaire'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-04 : capacité de la salle >= effectif du groupe (si le cours cible
    -- un groupe) ou de la classe entière (sinon)
    IF v_cours.id_groupe IS NOT NULL THEN
        SELECT g.effectif INTO v_effectif FROM groupe g WHERE g.id_groupe = v_cours.id_groupe;
    ELSE
        v_effectif := v_classe.effectif;
    END IF;

    IF v_salle.capacite < v_effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif à accueillir (%)',
            v_salle.capacite, v_effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle conforme au type exigé par le cours
    IF v_cours.id_type_salle IS NOT NULL
       AND v_salle.id_type_salle <> v_cours.id_type_salle THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-06 : aucun créneau de la séance ne doit être déclaré « indisponible »
    -- par l'enseignant (la partie « habilitation » nécessite une table
    -- HABILITATION, absente du MLD actuel).
    IF EXISTS (
        SELECT 1
        FROM disponibilite d
        JOIN creneau c ON c.id_creneau = d.id_creneau
        WHERE d.id_enseignant = v_cours.id_enseignant
          AND d.niveau        = 'indisponible'
          AND c.jour          = v_creneau.jour
          AND c.heure_debut   < NEW.heure_fin
          AND c.heure_fin     > NEW.heure_debut
    ) THEN
        RAISE EXCEPTION 'CD-06 : l''enseignant est indisponible sur au moins un créneau de cette séance'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-08 : le cumul des durées des séances ne dépasse pas le volume horaire
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)
    INTO v_deja
    FROM seance s
    WHERE s.id_cours = NEW.id_cours
      AND s.id_edt   = NEW.id_edt
      AND s.statut  <> 'annulee'
      AND s.id_seance IS DISTINCT FROM NEW.id_seance;

    IF v_deja + v_duree > v_cours.volume_horaire THEN
        RAISE EXCEPTION 'CD-08 : le volume horaire prévu (% h) serait dépassé (% h déjà planifiées + % h)',
            v_cours.volume_horaire, v_deja, v_duree
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_verifier_seance
    BEFORE INSERT OR UPDATE ON seance
    FOR EACH ROW
    EXECUTE FUNCTION verifier_seance();

-- =====================================================================
--  7. SÉCURITÉ SUPABASE (Row Level Security)
--     Les tables du schéma public sont exposées par l'API Supabase :
--     on active RLS sur toutes. Sans politique, seul le rôle service
--     (backend / moteur, clé secrète) y accède. On autorise la LECTURE
--     aux utilisateurs authentifiés, sauf pour UTILISATEUR, ENSEIGNANT,
--     DISPONIBILITE et PROMPT (données personnelles ou sensibles).
--     Adapter les politiques d'écriture selon les rôles (BNF-07).
-- =====================================================================

ALTER TABLE filiere              ENABLE ROW LEVEL SECURITY;
ALTER TABLE classe               ENABLE ROW LEVEL SECURITY;
ALTER TABLE groupe               ENABLE ROW LEVEL SECURITY;
ALTER TABLE matiere              ENABLE ROW LEVEL SECURITY;
ALTER TABLE enseignant           ENABLE ROW LEVEL SECURITY;
ALTER TABLE creneau              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pause                ENABLE ROW LEVEL SECURITY;
ALTER TABLE jour_ferie           ENABLE ROW LEVEL SECURITY;
ALTER TABLE type_salle           ENABLE ROW LEVEL SECURITY;
ALTER TABLE salle                ENABLE ROW LEVEL SECURITY;
ALTER TABLE semestre             ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilisateur          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cours                ENABLE ROW LEVEL SECURITY;
ALTER TABLE cours_seance_modele  ENABLE ROW LEVEL SECURITY;
ALTER TABLE disponibilite        ENABLE ROW LEVEL SECURITY;
ALTER TABLE emploi_du_temps      ENABLE ROW LEVEL SECURITY;
ALTER TABLE contrainte           ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt               ENABLE ROW LEVEL SECURITY;
ALTER TABLE seance               ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'filiere','classe','groupe','matiere','creneau','pause','jour_ferie',
        'type_salle','salle','semestre','cours','cours_seance_modele',
        'emploi_du_temps','contrainte','seance'
    ] LOOP
        EXECUTE format(
            'CREATE POLICY "lecture authentifies" ON %I
             FOR SELECT TO authenticated USING (true)', t);
    END LOOP;
END $$;

-- =====================================================================
--  8. DONNÉES DE BASE
-- =====================================================================

INSERT INTO type_salle (libelle) VALUES
    ('Amphithéâtre'), ('Salle standard'), ('Laboratoire'), ('Salle informatique');

-- Grille de créneaux de base + pause déjeuner.
-- Pour une grille de 30 minutes : remplacer v_pas par INTERVAL '30 minutes'.
DO $$
DECLARE
    v_pas          INTERVAL := INTERVAL '1 hour';
    v_matin_debut  TIME := '08:00';
    v_matin_fin    TIME := '12:00';
    v_apm_debut    TIME := '14:00';
    v_apm_fin      TIME := '18:00';
    v_jour         TEXT;
    v_t            TIME;
BEGIN
    FOREACH v_jour IN ARRAY ARRAY['Lundi','Mardi','Mercredi','Jeudi','Vendredi'] LOOP
        v_t := v_matin_debut;
        WHILE v_t + v_pas <= v_matin_fin LOOP
            INSERT INTO creneau (jour, heure_debut, heure_fin) VALUES (v_jour, v_t, v_t + v_pas);
            v_t := v_t + v_pas;
        END LOOP;

        v_t := v_apm_debut;
        WHILE v_t + v_pas <= v_apm_fin LOOP
            INSERT INTO creneau (jour, heure_debut, heure_fin) VALUES (v_jour, v_t, v_t + v_pas);
            v_t := v_t + v_pas;
        END LOOP;
    END LOOP;

    -- À CONFIRMER avec la scolarité
    INSERT INTO pause (libelle, heure_debut, heure_fin)
    VALUES ('Pause déjeuner', v_matin_fin, v_apm_debut);
END $$;

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

-- Utilisateur planificateur (pas de mot de passe : authentification SSO)
INSERT INTO utilisateur (login, email, role)
VALUES ('planificateur', 'scolarite@univ.example', 'planificateur');

-- Salles : sites de Kamboinsé et de Ouaga (capacités FICTIVES)
INSERT INTO salle (code_salle, nom_salle, capacite, batiment, id_type_salle)
SELECT v.code, v.nom, v.cap, v.bat, t.id_type_salle
FROM (VALUES
    ('K-AMPHI1', 'Amphi 200',             200, 'Kamboinsé - Bloc A',          'Amphithéâtre'),
    ('K-AMPHI2', 'Amphi 120',             120, 'Kamboinsé - Bloc A',          'Amphithéâtre'),
    ('K-A101',   'Salle A101',             60, 'Kamboinsé - Bloc A',          'Salle standard'),
    ('K-A102',   'Salle A102',             50, 'Kamboinsé - Bloc A',          'Salle standard'),
    ('K-B201',   'Salle B201',             40, 'Kamboinsé - Bloc B',          'Salle standard'),
    ('K-LAB1',   'Laboratoire 1',          30, 'Kamboinsé - Bloc B',          'Laboratoire'),
    ('K-LAB2',   'Laboratoire 2',          25, 'Kamboinsé - Bloc B',          'Laboratoire'),
    ('K-INFO1',  'Salle informatique 1',   40, 'Kamboinsé - Bloc B',          'Salle informatique'),
    ('O-AMPHI1', 'Amphi 250',             250, 'Ouaga - Bâtiment principal',  'Amphithéâtre'),
    ('O-B101',   'Salle 101',              80, 'Ouaga - Bâtiment principal',  'Salle standard'),
    ('O-B102',   'Salle 102',              45, 'Ouaga - Bâtiment principal',  'Salle standard'),
    ('O-INFO1',  'Salle informatique',     35, 'Ouaga - Annexe',              'Salle informatique'),
    ('O-LAB1',   'Laboratoire',            30, 'Ouaga - Annexe',              'Laboratoire')
) AS v(code, nom, cap, bat, type_libelle)
JOIN type_salle t ON t.libelle = v.type_libelle;

-- Filières
INSERT INTO filiere (code_filiere, libelle) VALUES
    ('INFO', 'Informatique'),
    ('IA',   'Intelligence artificielle');

-- Classes
INSERT INTO classe (code_classe, libelle, niveau, effectif, id_filiere)
SELECT v.code, v.libelle, v.niveau, v.effectif, f.id_filiere
FROM (VALUES
    ('L1INFO', 'Licence 1 Informatique', 'L1', 120, 'INFO'),
    ('L2INFO', 'Licence 2 Informatique', 'L2',  80, 'INFO'),
    ('L3INFO', 'Licence 3 Informatique', 'L3',  60, 'INFO'),
    ('M1IA',   'Master 1 IA',            'M1',  30, 'IA'),
    ('M2IA',   'Master 2 IA',            'M2',  24, 'IA')
) AS v(code, libelle, niveau, effectif, code_filiere)
JOIN filiere f ON f.code_filiere = v.code_filiere;

-- Groupes (la somme des effectifs de groupes d'un même type = effectif de la classe)
INSERT INTO groupe (code_groupe, type_groupe, effectif, id_classe)
SELECT v.code, v.type, v.effectif, c.id_classe
FROM (VALUES
    ('TD-A',  'TD', 60, 'L1INFO'),
    ('TD-B',  'TD', 60, 'L1INFO'),
    ('TD-A',  'TD', 40, 'L2INFO'),
    ('TD-B',  'TD', 40, 'L2INFO'),
    ('TP-G1', 'TP', 25, 'L2INFO'),
    ('TP-G2', 'TP', 25, 'L2INFO'),
    ('TP-G3', 'TP', 30, 'L2INFO'),
    ('TP-G1', 'TP', 15, 'M1IA'),
    ('TP-G2', 'TP', 15, 'M1IA')
) AS v(code, type, effectif, code_classe)
JOIN classe c ON c.code_classe = v.code_classe;

-- Enseignants (noms fictifs)
INSERT INTO enseignant (matricule, nom, prenom, email, grade, nb_heures_max_semaine) VALUES
    ('ENS-001', 'Ouédraogo',    'Adama',    'a.ouedraogo@univ.example',    'Professeur',            16),
    ('ENS-002', 'Sawadogo',     'Mariam',   'm.sawadogo@univ.example',     'Maître de conférences', 16),
    ('ENS-003', 'Kaboré',       'Issouf',   'i.kabore@univ.example',       'Maître-assistant',      18),
    ('ENS-004', 'Compaoré',     'Aïssata',  'a.compaore@univ.example',     'Maître de conférences', 16),
    ('ENS-005', 'Zongo',        'Boureima', 'b.zongo@univ.example',        'Professeur',            14),
    ('ENS-006', 'Traoré',       'Fatoumata','f.traore@univ.example',       'Maître de conférences', 16),
    ('ENS-007', 'Nikièma',      'Paul',     'p.nikiema@univ.example',      'Assistant',             20),
    ('ENS-008', 'Bationo',      'Salif',    's.bationo@univ.example',      'Maître-assistant',      18);

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

-- Cours (id_groupe renseigné = cours de groupe ; NULL = classe entière)
INSERT INTO cours (type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite,
                   id_matiere, id_classe, id_groupe, id_enseignant, id_type_salle, id_semestre)
SELECT v.type, v.volume, v.duree, v.nb, v.prio,
       m.id_matiere, c.id_classe, g.id_groupe, e.id_enseignant, ts.id_type_salle, s.id_semestre
FROM (VALUES
    -- matière, type, volume, durée, nb/sem, prio, classe,  groupe,  enseignant, type de salle
    ('ALGO',  'CM', 24, 2, 1, 2, 'L2INFO', NULL,    'ENS-001', 'Amphithéâtre'),
    ('ALGO',  'TD', 24, 2, 1, 1, 'L2INFO', 'TD-A',  'ENS-002', 'Salle standard'),
    ('ALGO',  'TD', 24, 2, 1, 1, 'L2INFO', 'TD-B',  'ENS-002', 'Salle standard'),
    ('RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G1', 'ENS-003', 'Laboratoire'),
    ('RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G2', 'ENS-007', 'Laboratoire'),
    ('RES',   'TP', 36, 3, 1, 1, 'L2INFO', 'TP-G3', 'ENS-008', 'Laboratoire'),
    ('BD',    'CM', 60, 2, 2, 2, 'L2INFO', NULL,    'ENS-004', 'Amphithéâtre'),
    ('WEB',   'CM', 36, 2, 2, 1, 'L3INFO', NULL,    'ENS-005', 'Salle standard'),
    ('SE',    'CM', 36, 3, 1, 1, 'L3INFO', NULL,    'ENS-001', 'Salle standard'),
    ('ML',    'CM', 30, 3, 1, 2, 'M1IA',   NULL,    'ENS-006', 'Salle standard'),
    ('ML',    'TP', 24, 2, 1, 1, 'M1IA',   'TP-G1', 'ENS-006', 'Salle informatique'),
    ('ANG',   'CM', 24, 2, 1, 0, 'L1INFO', NULL,    'ENS-007', 'Amphithéâtre'),
    ('PROBA', 'TD', 24, 2, 1, 1, 'L1INFO', 'TD-A',  'ENS-008', 'Salle standard')
) AS v(code_matiere, type, volume, duree, nb, prio, code_classe, code_groupe, matricule, type_salle)
JOIN matiere    m  ON m.code_matiere = v.code_matiere
JOIN classe     c  ON c.code_classe  = v.code_classe
LEFT JOIN groupe g ON g.id_classe = c.id_classe AND g.code_groupe = v.code_groupe
JOIN enseignant e  ON e.matricule    = v.matricule
JOIN type_salle ts ON ts.libelle     = v.type_salle
CROSS JOIN semestre s WHERE s.libelle = 'Semestre 1' AND s.annee_academique = '2026-2027';

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
    ('ENS-002', 'Mercredi', '14:00'::time, '18:00'::time, 'indisponible', 'Recherche'),
    ('ENS-004', 'Mardi',    '08:00'::time, '12:00'::time, 'preference',   NULL),
    ('ENS-005', 'Vendredi', '14:00'::time, '18:00'::time, 'indisponible', 'Réunion de département'),
    ('ENS-006', 'Jeudi',    '08:00'::time, '12:00'::time, 'preference',   NULL)
) AS v(matricule, jour, de, a, niveau, motif)
JOIN enseignant e ON e.matricule = v.matricule
JOIN creneau    c ON c.jour = v.jour AND c.heure_debut >= v.de AND c.heure_fin <= v.a;

-- Emploi du temps de travail
INSERT INTO emploi_du_temps (libelle, version, mode_generation, statut, id_semestre, id_utilisateur)
SELECT 'EDT Semestre 1 2026-2027', 1, 'manuel', 'brouillon', s.id_semestre, u.id_utilisateur
FROM semestre s, utilisateur u
WHERE s.libelle = 'Semestre 1' AND s.annee_academique = '2026-2027'
  AND u.login = 'planificateur';
