-- =====================================================================
--  PROPOSITION (non appliquée) — Migration 8 -> 9 : données du moteur v3
--  À discuter avec le responsable de la base et Zakaria avant toute exécution.
--  Suit les conventions des migrations 006 à 008 : une transaction, relançable,
--  id_ecole sur chaque table, clés étrangères composites (x, id_ecole), RLS par école.
--
--  Ce qu'elle ajoute (besoins confirmés par le planificateur, novembre 2026) :
--   1. site de chaque promotion (certaines n'ont cours qu'à Kamboinsé ou qu'à Ouaga) ;
--      niveaux CPGE, bachelors techno et mise à niveau ;
--   2. options et sous-groupes : type OPTION et groupe parent ;
--   3. cours mutualisés : publics supplémentaires d'un cours ;
--   4. types de salle acceptés par un cours (amphi OU grande salle) ;
--   5. salles réservées à certaines formations (EMIH, EREE, EMEL, CPGE…) ;
--   6. temps de trajet entre sites ;
--   7. paramètres et période de validité des règles du planificateur.
--
--  Sans cette migration, le moteur v3 tourne quand même (valeurs déduites et
--  avertissements, voir moteur/base.py).
--
--  À FAIRE EN PLUS DANS LES DÉCLENCHEURS (propriétaire : Zakaria), sinon la base
--  refusera des séances valides pour le moteur v3 :
--   - CD-03 : deux groupes d'une classe sont compatibles s'ils sont frères du même
--     type OU dans des branches disjointes de l'arbre (ex. TD2 et le demi-groupe
--     TP de TD1) ; tenir compte des publics de cours_public ;
--   - CD-04 : effectif = somme des publics (cours_public compris) ;
--   - CD-05 : type de salle dans cours_type_salle, en plus de cours.id_type_salle ;
--   - nouvelle vérification : salle_reservation (salle réservée à d'autres classes) ;
--   - nouvelle vérification : la salle est sur le site de la classe (classe.id_site).
-- =====================================================================

BEGIN;

-- 1. Site de la promotion et niveaux supplémentaires ------------------------
ALTER TABLE classe ADD COLUMN IF NOT EXISTS id_site BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classe_site_fkey') THEN
        ALTER TABLE classe ADD CONSTRAINT classe_site_fkey FOREIGN KEY (id_site, id_ecole)
            REFERENCES site (id_site, id_ecole) ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;
COMMENT ON COLUMN classe.id_site IS 'Site où la promotion a tous ses cours (NULL = non fixé)';

ALTER TABLE classe DROP CONSTRAINT IF EXISTS classe_niveau_check;
ALTER TABLE classe ADD CONSTRAINT classe_niveau_check
    CHECK (niveau IN ('L1','L2','L3','M1','M2','CPGE1','CPGE2','BT','MAN','AUTRE'));

-- 2. Options et sous-groupes ---------------------------------------------------
ALTER TABLE groupe DROP CONSTRAINT IF EXISTS groupe_type_groupe_check;
ALTER TABLE groupe ADD CONSTRAINT groupe_type_groupe_check CHECK (type_groupe IN ('TD','TP','OPTION'));
ALTER TABLE groupe ADD COLUMN IF NOT EXISTS id_groupe_parent BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groupe_parent_fkey') THEN
        ALTER TABLE groupe ADD CONSTRAINT groupe_parent_fkey FOREIGN KEY (id_groupe_parent, id_ecole)
            REFERENCES groupe (id_groupe, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE;
        ALTER TABLE groupe ADD CONSTRAINT groupe_parent_distinct CHECK (id_groupe_parent <> id_groupe);
    END IF;
END $$;
COMMENT ON COLUMN groupe.id_groupe_parent IS
    'Groupe contenant (ex. demi-groupe de TP dans un TD, sous-option dans une option) ; NULL = directement dans la classe';

-- le parent appartient à la même classe
CREATE OR REPLACE FUNCTION groupe_parent_meme_classe() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id_groupe_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM groupe p WHERE p.id_groupe = NEW.id_groupe_parent
          AND p.id_classe = NEW.id_classe AND p.id_ecole = NEW.id_ecole) THEN
        RAISE EXCEPTION 'Le groupe parent doit appartenir à la même classe';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tg_groupe_parent ON groupe;
CREATE TRIGGER tg_groupe_parent BEFORE INSERT OR UPDATE OF id_groupe_parent, id_classe ON groupe
    FOR EACH ROW EXECUTE FUNCTION groupe_parent_meme_classe();

-- 3. Cours mutualisés : publics en plus de cours.id_classe / cours.id_groupe -------
CREATE TABLE IF NOT EXISTS cours_public (
    id_cours_public  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_cours         BIGINT NOT NULL,
    id_classe        BIGINT NOT NULL,
    id_groupe        BIGINT,                         -- NULL = classe entière
    id_ecole         BIGINT NOT NULL DEFAULT app_ecole() REFERENCES ecole(id_ecole)
                     ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (id_cours, id_ecole)  REFERENCES cours  (id_cours, id_ecole)  ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_classe, id_ecole) REFERENCES classe (id_classe, id_ecole) ON UPDATE CASCADE ON DELETE RESTRICT,
    FOREIGN KEY (id_groupe, id_ecole) REFERENCES groupe (id_groupe, id_ecole) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cours_public
    ON cours_public (id_ecole, id_cours, id_classe, coalesce(id_groupe, 0));
COMMENT ON TABLE cours_public IS
    'Publics supplémentaires d''un cours mutualisé (le public principal reste cours.id_classe / id_groupe)';

-- 4. Types de salle acceptés -----------------------------------------------------
CREATE TABLE IF NOT EXISTS cours_type_salle (
    id_cours       BIGINT NOT NULL,
    id_type_salle  BIGINT NOT NULL,
    id_ecole       BIGINT NOT NULL DEFAULT app_ecole() REFERENCES ecole(id_ecole)
                   ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (id_ecole, id_cours, id_type_salle),
    FOREIGN KEY (id_cours, id_ecole)      REFERENCES cours (id_cours, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_type_salle, id_ecole) REFERENCES type_salle (id_type_salle, id_ecole) ON UPDATE CASCADE ON DELETE RESTRICT
);
COMMENT ON TABLE cours_type_salle IS 'Types de salle acceptés en plus de cours.id_type_salle (ex. CM en amphi ou en grande salle)';

-- 5. Salles réservées --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salle_reservation (
    id_salle   BIGINT NOT NULL,
    id_classe  BIGINT NOT NULL,
    id_ecole   BIGINT NOT NULL DEFAULT app_ecole() REFERENCES ecole(id_ecole)
               ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (id_ecole, id_salle, id_classe),
    FOREIGN KEY (id_salle, id_ecole)  REFERENCES salle  (id_salle, id_ecole)  ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_classe, id_ecole) REFERENCES classe (id_classe, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE salle_reservation IS 'Une salle listée ici ne reçoit que les classes listées (aucune ligne = salle libre)';

-- 6. Temps de trajet entre sites -----------------------------------------------------
CREATE TABLE IF NOT EXISTS site_trajet (
    id_site_a  BIGINT NOT NULL,
    id_site_b  BIGINT NOT NULL,
    minutes    INTEGER NOT NULL CHECK (minutes >= 0),
    id_ecole   BIGINT NOT NULL DEFAULT app_ecole() REFERENCES ecole(id_ecole)
               ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (id_ecole, id_site_a, id_site_b),
    CHECK (id_site_a < id_site_b),
    FOREIGN KEY (id_site_a, id_ecole) REFERENCES site (id_site, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_site_b, id_ecole) REFERENCES site (id_site, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE site_trajet IS 'Écart minimal entre deux séances d''un enseignant sur ces deux sites le même jour';

-- 7. Règles du planificateur : paramètres et période ----------------------------------
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS parametres JSONB;
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS date_debut DATE;
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS date_fin DATE;
ALTER TABLE contrainte DROP CONSTRAINT IF EXISTS contrainte_periode_check;
ALTER TABLE contrainte ADD CONSTRAINT contrainte_periode_check
    CHECK (date_fin IS NULL OR date_debut IS NULL OR date_fin >= date_debut);
COMMENT ON COLUMN contrainte.parametres IS
    'Paramètres d''une règle du moteur v3, ex. {"cible": {"id_classe": 3}, "jours": ["Jeudi"], "demi": 1} '
    'pour type_contrainte = ''interdire'' ; {"matiere_avant": 12, "matiere_apres": 15} pour ''precede'' ; '
    '{"heures": 6} pour ''plafond_jour''';

-- RLS et droits sur les nouvelles tables (même règle que la migration 007)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cours_public','cours_type_salle','salle_reservation','site_trajet'] LOOP
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (id_ecole)', 'ix_' || t || '_ecole', t);
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS "ecole du compte" ON %I', t);
        EXECUTE format('CREATE POLICY "ecole du compte" ON %I TO ultraplanning_app '
                       'USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ultraplanning_app', t);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON %I FROM anon', t);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
        END IF;
    END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE cours_public_id_cours_public_seq TO ultraplanning_app;

COMMIT;
