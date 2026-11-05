-- =====================================================================
--  Migration 10 -> 11 : règles 2iE du moteur v3 (Soraya Pitroipa).
--  À exécuter une fois sur une base en version 10 (Supabase > SQL Editor),
--  après migrations/010_enseignant_par_seance.sql. Reprend la proposition
--  009_moteur_v3.sql de la branche Soraya, alignée sur la version 10.
--
--   * site de chaque promotion (classe.id_site) et niveaux CPGE, BT, MAN ;
--   * options et sous-groupes : type OPTION et groupe parent ;
--   * cours mutualisés (COURS_PUBLIC) et types de salle acceptés (COURS_TYPE_SALLE) ;
--   * salles réservées (SALLE_RESERVATION) et temps de trajet (SITE_TRAJET) ;
--   * règles du planificateur comme données : contrainte.parametres et période ;
--   * contrôles des séances : CD-03 (arbre des groupes, publics mutualisés),
--     CD-04 (effectif de tous les publics), CD-05 (types acceptés), site de la
--     promotion, salle réservée (CD-12), CD-13 pour chaque promotion du cours.
-- =====================================================================

BEGIN;

-- 1. Site de la promotion et niveaux supplémentaires
ALTER TABLE classe ADD COLUMN IF NOT EXISTS id_site BIGINT;
ALTER TABLE classe DROP CONSTRAINT IF EXISTS classe_id_site_fkey;
ALTER TABLE classe ADD CONSTRAINT classe_id_site_fkey FOREIGN KEY (id_site, id_ecole)
    REFERENCES site (id_site, id_ecole) ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE classe DROP CONSTRAINT IF EXISTS classe_niveau_check;
ALTER TABLE classe ADD CONSTRAINT classe_niveau_check
    CHECK (niveau IN ('L1','L2','L3','M1','M2','CPGE1','CPGE2','BT','MAN','AUTRE'));
CREATE INDEX IF NOT EXISTS ix_classe_site ON classe(id_site);

-- 2. Options et sous-groupes
ALTER TABLE groupe DROP CONSTRAINT IF EXISTS groupe_type_groupe_check;
ALTER TABLE groupe ADD CONSTRAINT groupe_type_groupe_check CHECK (type_groupe IN ('TD','TP','OPTION'));
ALTER TABLE groupe ADD COLUMN IF NOT EXISTS id_groupe_parent BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groupe_id_groupe_ecole_key') THEN
        ALTER TABLE groupe ADD CONSTRAINT groupe_id_groupe_ecole_key UNIQUE (id_groupe, id_ecole);
    END IF;
END $$;
ALTER TABLE groupe DROP CONSTRAINT IF EXISTS groupe_id_groupe_parent_fkey;
ALTER TABLE groupe ADD CONSTRAINT groupe_id_groupe_parent_fkey FOREIGN KEY (id_groupe_parent, id_ecole)
    REFERENCES groupe (id_groupe, id_ecole) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE groupe DROP CONSTRAINT IF EXISTS groupe_parent_distinct;
ALTER TABLE groupe ADD CONSTRAINT groupe_parent_distinct CHECK (id_groupe_parent <> id_groupe);
CREATE INDEX IF NOT EXISTS ix_groupe_parent ON groupe(id_groupe_parent);

-- 3. Règles du planificateur comme données
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS parametres JSONB;
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS date_debut DATE;
ALTER TABLE contrainte ADD COLUMN IF NOT EXISTS date_fin DATE;
ALTER TABLE contrainte DROP CONSTRAINT IF EXISTS contrainte_periode_check;
ALTER TABLE contrainte ADD CONSTRAINT contrainte_periode_check
    CHECK (date_fin IS NULL OR date_debut IS NULL OR date_fin >= date_debut);

-- 4. Nouvelles tables (puis id_ecole et clés composites, comme la section 7 du schéma)
DROP TABLE IF EXISTS cours_public, cours_type_salle, salle_reservation, site_trajet CASCADE;
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
CREATE INDEX ix_cours_public_classe ON cours_public(id_classe);
CREATE INDEX ix_salle_reservation_classe ON salle_reservation(id_classe);

DO $$
DECLARE
    v_tables TEXT[] := ARRAY['cours_public','cours_type_salle','salle_reservation','site_trajet'];
    v_references TEXT[] := ARRAY['site','type_salle','classe','groupe','salle','cours'];
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
          AND c.confrelid::regclass::text = ANY (v_tables || v_references)
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

-- 5. Isolation par école et droits, comme les autres tables
DO $$
DECLARE t TEXT; r TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cours_public','cours_type_salle','salle_reservation','site_trajet'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS "ecole du compte" ON %I', t);
        EXECUTE format('CREATE POLICY "ecole du compte" ON %I TO ultraplanning_app '
                       'USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO ultraplanning_app', t);
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
            EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
        END LOOP;
    END LOOP;
END $$;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE cours_public_id_cours_public_seq, cours_type_salle_id_cours_type_salle_seq,
    salle_reservation_id_salle_reservation_seq, site_trajet_id_site_trajet_seq TO ultraplanning_app;

-- 6. Fonctions et contrôles
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

DROP TRIGGER IF EXISTS trg_groupe_parent ON groupe;
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

    IF EXISTS (SELECT 1 FROM conge g
               WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
                 AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)) THEN
        RAISE EXCEPTION 'CD-09 : le % tombe pendant un congé (%)', NEW.date_seance,
            (SELECT g.libelle FROM conge g
             WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
               AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)
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
        CROSS JOIN LATERAL publics_du_cours(s.id_cours) ps
        JOIN publics_du_cours(NEW.id_cours) pn ON pn.id_classe = ps.id_classe
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
    -- sinon classe entière ; cours mutualisé : la somme)
    SELECT coalesce(sum(coalesce(g.effectif, cl.effectif)), 0)
    INTO v_effectif
    FROM publics_du_cours(NEW.id_cours) p
    JOIN classe cl ON cl.id_classe = p.id_classe
    LEFT JOIN groupe g ON g.id_groupe = p.id_groupe;

    IF v_salle.capacite < v_effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif à accueillir (%)',
            v_salle.capacite, v_effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle exigé par le cours, ou l'un des types acceptés (COURS_TYPE_SALLE)
    IF (v_cours.id_type_salle IS NOT NULL
        OR EXISTS (SELECT 1 FROM cours_type_salle t WHERE t.id_cours = NEW.id_cours))
       AND v_salle.id_type_salle IS DISTINCT FROM v_cours.id_type_salle
       AND NOT EXISTS (SELECT 1 FROM cours_type_salle t
                       WHERE t.id_cours = NEW.id_cours AND t.id_type_salle = v_salle.id_type_salle) THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Site : la salle est sur le site de chaque promotion du cours (classe.id_site, s'il est fixé)
    IF EXISTS (SELECT 1 FROM publics_du_cours(NEW.id_cours) p JOIN classe cl ON cl.id_classe = p.id_classe
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

    -- CD-14 : rythme hebdomadaire maximal du cours (semaine ISO)
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)
    INTO v_semaine
    FROM seance s
    WHERE s.id_cours = NEW.id_cours
      AND s.id_edt   = NEW.id_edt
      AND s.statut  <> 'annulee'
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

    RETURN NEW;
END;
$$;

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

COMMIT;
