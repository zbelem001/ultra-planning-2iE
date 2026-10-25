-- =====================================================================
--  Migration 6 -> 7 : isolation entre écoles et fermeture de l'accès direct
--  À exécuter une fois sur une base en version 6 (Supabase > SQL Editor),
--  après migrations/006_ecoles.sql. Toutes les données existantes sont
--  rattachées à l'école 2IE. Tout ou rien (une seule transaction).
--
--  1. Retire les anciennes règles d'accès : tout compte connecté lisait
--     toutes les tables par l'API REST de Supabase (e-mails et téléphones
--     des enseignants compris), et un invité tout le référentiel.
--  2. Ajoute id_ecole à chaque table métier, des clés étrangères composites
--     et des codes uniques par école.
--  3. Crée le rôle ultraplanning_app et la RLS par école.
-- =====================================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ecole WHERE code_ecole = '2IE') THEN
        RAISE EXCEPTION 'École 2IE introuvable : exécutez d''abord migrations/006_ecoles.sql';
    END IF;
END $$;

-- 1. Anciennes règles d'accès
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
             WHERE schemaname = 'public' AND policyname IN (
                 'lecture administrateurs', 'lecture publique',
                 'lecture publique des versions publiees', 'lecture publique des seances publiees')
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    END LOOP;
END $$;
DROP VIEW IF EXISTS enseignant_public;

-- 2 et 3. Isolation par école (même bloc que la section 7 de schema_supabase.sql)
-- École de la requête en cours (NULL hors contexte : une insertion sans
-- école échoue sur NOT NULL au lieu de tomber dans une école au hasard)
CREATE OR REPLACE FUNCTION app_ecole()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.id_ecole', true), '')::bigint $$;

DO $$
DECLARE
    v_tables TEXT[] := ARRAY[
        'site','type_salle','filiere','classe','groupe','matiere','enseignant','habilitation',
        'absence_enseignant','sejour_enseignant','creneau','pause','jour_ferie','conge','salle',
        'semestre','programme','cours','cours_seance_modele','disponibilite','emploi_du_temps',
        'contrainte','conversation','prompt','proposition','seance'];
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
        EXECUTE format('UPDATE %I SET id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = %L) WHERE id_ecole IS NULL', t, '2IE');
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
    ( 6, 'CD-06', 'dure',   0, NULL, 'Enseignant habilité, présent et disponible'),
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
        'site','type_salle','filiere','classe','groupe','matiere','enseignant','habilitation',
        'absence_enseignant','sejour_enseignant','creneau','pause','jour_ferie','conge','salle',
        'semestre','programme','cours','cours_seance_modele','disponibilite','emploi_du_temps',
        'contrainte','conversation','prompt','proposition','seance','utilisateur'
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

COMMIT;
