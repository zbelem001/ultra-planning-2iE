-- =====================================================================
--  Système de planification des cours et de génération automatique
--  des emplois du temps
--  Script de création de la base de données — PostgreSQL / Supabase
--
--  Utilisation : Supabase > SQL Editor > New query > coller > Run
--  Source      : fichier.md (section 7 : modèle de données / MLD)
--
--  Hypothèses :
--   * volume_horaire (COURS) et duree_seance sont exprimés en HEURES.
--   * Les contraintes dures CD-01 à CD-09 sont contrôlées en base
--     (index d'unicité + déclencheur), en doublon des contrôles de
--     l'application (cf. cahier des charges, section 6).
-- =====================================================================

-- Nettoyage (permet de relancer le script à zéro) ---------------------
DROP TABLE IF EXISTS
    seance, prompt, contrainte, indisponibilite, cours, groupe, classe,
    filiere, emploi_du_temps, utilisateur, semestre, salle, type_salle,
    creneau, matiere, enseignant
CASCADE;
DROP FUNCTION IF EXISTS verifier_seance() CASCADE;

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
    UNIQUE (id_classe, code_groupe)
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

-- Grille hebdomadaire des créneaux (BF-05)
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
--  2. COURS
-- =====================================================================

CREATE TABLE cours (
    id_cours            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_cours          TEXT NOT NULL CHECK (type_cours IN ('CM','TD','TP')),
    volume_horaire      NUMERIC(6,2) NOT NULL CHECK (volume_horaire > 0),  -- heures
    duree_seance        NUMERIC(4,2) NOT NULL CHECK (duree_seance > 0),    -- heures
    nb_seances_semaine  INTEGER NOT NULL DEFAULT 1 CHECK (nb_seances_semaine > 0),
    priorite            INTEGER NOT NULL DEFAULT 0,
    id_matiere          BIGINT NOT NULL REFERENCES matiere(id_matiere)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- PORTER_SUR
    id_classe           BIGINT NOT NULL REFERENCES classe(id_classe)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- CONCERNER
    id_enseignant       BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                        ON UPDATE CASCADE ON DELETE RESTRICT,   -- ASSURER
    id_type_salle       BIGINT REFERENCES type_salle(id_type_salle)
                        ON UPDATE CASCADE ON DELETE SET NULL,   -- NECESSITER (0,1)
    id_semestre         BIGINT NOT NULL REFERENCES semestre(id_semestre)
                        ON UPDATE CASCADE ON DELETE RESTRICT    -- PROGRAMMER
);

-- Indisponibilités des enseignants                       -- ETRE_INDISPONIBLE
CREATE TABLE indisponibilite (
    id_enseignant  BIGINT NOT NULL REFERENCES enseignant(id_enseignant)
                   ON UPDATE CASCADE ON DELETE CASCADE,
    id_creneau     BIGINT NOT NULL REFERENCES creneau(id_creneau)
                   ON UPDATE CASCADE ON DELETE CASCADE,
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
-- =====================================================================

CREATE TABLE seance (
    id_seance        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date_seance      DATE NOT NULL,
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
                     ON UPDATE CASCADE ON DELETE CASCADE    -- COMPOSER
);

-- CD-01 : une salle accueille au plus une séance par date et par créneau
-- (dans un même emploi du temps ; les séances annulées sont ignorées).
CREATE UNIQUE INDEX uq_seance_salle
    ON seance (id_edt, id_salle, date_seance, id_creneau)
    WHERE statut <> 'annulee';

-- =====================================================================
--  5. INDEX SUR LES CLÉS ÉTRANGÈRES
-- =====================================================================

CREATE INDEX ix_classe_filiere     ON classe(id_filiere);
CREATE INDEX ix_groupe_classe      ON groupe(id_classe);
CREATE INDEX ix_salle_type         ON salle(id_type_salle);
CREATE INDEX ix_cours_matiere      ON cours(id_matiere);
CREATE INDEX ix_cours_classe       ON cours(id_classe);
CREATE INDEX ix_cours_enseignant   ON cours(id_enseignant);
CREATE INDEX ix_cours_type_salle   ON cours(id_type_salle);
CREATE INDEX ix_cours_semestre     ON cours(id_semestre);
CREATE INDEX ix_indispo_creneau    ON indisponibilite(id_creneau);
CREATE INDEX ix_edt_semestre       ON emploi_du_temps(id_semestre);
CREATE INDEX ix_edt_utilisateur    ON emploi_du_temps(id_utilisateur);
CREATE INDEX ix_contrainte_edt     ON contrainte(id_edt);
CREATE INDEX ix_prompt_edt         ON prompt(id_edt);
CREATE INDEX ix_prompt_utilisateur ON prompt(id_utilisateur);
CREATE INDEX ix_seance_cours       ON seance(id_cours);
CREATE INDEX ix_seance_creneau     ON seance(id_creneau);
CREATE INDEX ix_seance_edt         ON seance(id_edt);
CREATE INDEX ix_seance_date        ON seance(date_seance);

-- =====================================================================
--  6. CONTRÔLE DES CONTRAINTES DURES (déclencheur sur SEANCE)
--     CD-02, CD-03, CD-04, CD-05, CD-06, CD-08, CD-09
--     (CD-01 est garanti par l'index uq_seance_salle ci-dessus)
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
    v_deja      NUMERIC;
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

    -- CD-02 : un enseignant anime au plus une séance par date et créneau
    IF EXISTS (
        SELECT 1
        FROM seance s
        JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt       = NEW.id_edt
          AND s.date_seance  = NEW.date_seance
          AND s.id_creneau   = NEW.id_creneau
          AND s.statut      <> 'annulee'
          AND c.id_enseignant = v_cours.id_enseignant
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) THEN
        RAISE EXCEPTION 'CD-02 : l''enseignant a déjà une séance à cette date et sur ce créneau'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-03 : une classe suit au plus une séance par date et créneau
    -- (le MLD ne relie pas encore SEANCE à GROUPE : le contrôle porte
    --  sur la classe du cours).
    IF EXISTS (
        SELECT 1
        FROM seance s
        JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt      = NEW.id_edt
          AND s.date_seance = NEW.date_seance
          AND s.id_creneau  = NEW.id_creneau
          AND s.statut     <> 'annulee'
          AND c.id_classe   = v_cours.id_classe
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) THEN
        RAISE EXCEPTION 'CD-03 : la classe a déjà une séance à cette date et sur ce créneau'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-04 : capacité de la salle >= effectif de la classe
    IF v_salle.capacite < v_classe.effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif de la classe (%)',
            v_salle.capacite, v_classe.effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle conforme au type exigé par le cours
    IF v_cours.id_type_salle IS NOT NULL
       AND v_salle.id_type_salle <> v_cours.id_type_salle THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-06 : enseignant non déclaré indisponible sur le créneau
    -- (la partie « habilitation » nécessite une table HABILITATION,
    --  absente du MLD actuel).
    IF EXISTS (
        SELECT 1 FROM indisponibilite i
        WHERE i.id_enseignant = v_cours.id_enseignant
          AND i.id_creneau    = NEW.id_creneau
    ) THEN
        RAISE EXCEPTION 'CD-06 : l''enseignant est indisponible sur ce créneau'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-08 : le cumul des séances ne dépasse pas le volume horaire prévu
    SELECT COALESCE(COUNT(*) * v_cours.duree_seance, 0) INTO v_deja
    FROM seance s
    WHERE s.id_cours = NEW.id_cours
      AND s.id_edt   = NEW.id_edt
      AND s.statut  <> 'annulee'
      AND s.id_seance IS DISTINCT FROM NEW.id_seance;

    IF v_deja + v_cours.duree_seance > v_cours.volume_horaire THEN
        RAISE EXCEPTION 'CD-08 : le volume horaire prévu (% h) serait dépassé', v_cours.volume_horaire
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-09 : la date tombe le bon jour de la semaine et dans le semestre
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
--     (backend FastAPI) y accède. On autorise la LECTURE aux
--     utilisateurs authentifiés, sauf pour UTILISATEUR et PROMPT.
--     Adapter les politiques d'écriture selon les rôles (BNF-07).
-- =====================================================================

ALTER TABLE filiere          ENABLE ROW LEVEL SECURITY;
ALTER TABLE classe           ENABLE ROW LEVEL SECURITY;
ALTER TABLE groupe           ENABLE ROW LEVEL SECURITY;
ALTER TABLE matiere          ENABLE ROW LEVEL SECURITY;
ALTER TABLE enseignant       ENABLE ROW LEVEL SECURITY;
ALTER TABLE creneau          ENABLE ROW LEVEL SECURITY;
ALTER TABLE type_salle       ENABLE ROW LEVEL SECURITY;
ALTER TABLE salle            ENABLE ROW LEVEL SECURITY;
ALTER TABLE semestre         ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilisateur      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cours            ENABLE ROW LEVEL SECURITY;
ALTER TABLE indisponibilite  ENABLE ROW LEVEL SECURITY;
ALTER TABLE emploi_du_temps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contrainte       ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt           ENABLE ROW LEVEL SECURITY;
ALTER TABLE seance           ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'filiere','classe','groupe','matiere','creneau','type_salle',
        'salle','semestre','cours','emploi_du_temps','contrainte','seance'
    ] LOOP
        EXECUTE format(
            'CREATE POLICY "lecture authentifies" ON %I
             FOR SELECT TO authenticated USING (true)', t);
    END LOOP;
END $$;

-- =====================================================================
--  8. DONNÉES DE BASE (optionnel)
-- =====================================================================

INSERT INTO type_salle (libelle) VALUES
    ('Amphithéâtre'), ('Salle standard'), ('Laboratoire'), ('Salle informatique');

INSERT INTO creneau (jour, heure_debut, heure_fin)
SELECT j, d, f
FROM unnest(ARRAY['Lundi','Mardi','Mercredi','Jeudi','Vendredi']) AS j,
     (VALUES ('08:00'::time,'10:00'::time),
             ('10:15'::time,'12:15'::time),
             ('14:00'::time,'16:00'::time),
             ('16:15'::time,'18:15'::time)) AS c(d, f);
