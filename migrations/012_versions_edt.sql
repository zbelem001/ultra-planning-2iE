-- =====================================================================
--  Migration 11 -> 12 : versions de l'emploi du temps.
--  À exécuter une fois sur une base en version 11 (Supabase > SQL Editor),
--  après migrations/011_regles_2ie.sql. Sans danger si on la relance.
--
--   * une version à jour par semestre, seule modifiable, et sa copie publiée,
--     qui ne change que par une publication (déclencheur) ;
--   * PUBLICATION_EDT : chaque publication ;
--   * historique lu dans le journal des séances (fonctions versions_edt et
--     seances_version, limitées à l'école de la requête) ;
--   * données : « validé » redevient « brouillon » ; un semestre sans version
--     à jour en reçoit une, copie de sa dernière version ; les discussions de
--     l'assistant passent sur la version à jour, et ses propositions de
--     séances encore en attente sur une version publiée sont rejetées.
--
--  La version publiée reste telle quelle jusqu'à la prochaine publication.
-- =====================================================================

BEGIN;

-- 1. Journal : motif du changement, et lecture rapide par emploi du temps
ALTER TABLE journal_seance ADD COLUMN IF NOT EXISTS note TEXT;
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

-- 2. La version publiée ne change que par une publication
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

-- 3. Publications
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

-- 4. Historique, lu dans le journal, limité à l'école de la requête
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

-- 5. Données : une version à jour par semestre
UPDATE emploi_du_temps SET statut = 'brouillon' WHERE statut = 'valide';

-- Plusieurs versions de travail sur un semestre : seule la plus récente reste à jour
UPDATE emploi_du_temps e SET statut = 'archive'
WHERE e.statut = 'brouillon'
  AND EXISTS (SELECT 1 FROM emploi_du_temps x WHERE x.id_semestre = e.id_semestre AND x.statut = 'brouillon' AND x.version > e.version);

-- Semestre sans version à jour : copie de sa dernière version (les séances sont recopiées telles
-- quelles, sans repasser par les contrôles : elles sont déjà publiées)
DO $$
DECLARE
    r      RECORD;
    v_id   BIGINT;
BEGIN
    ALTER TABLE seance DISABLE TRIGGER trg_verifier_seance;
    FOR r IN
        SELECT DISTINCT ON (e.id_semestre) e.*
        FROM emploi_du_temps e
        WHERE NOT EXISTS (SELECT 1 FROM emploi_du_temps x WHERE x.id_semestre = e.id_semestre AND x.statut = 'brouillon')
        ORDER BY e.id_semestre, (e.statut = 'publie') DESC, e.version DESC
    LOOP
        INSERT INTO emploi_du_temps (libelle, version, mode_generation, statut, id_semestre, id_utilisateur, id_ecole)
        SELECT r.libelle, max(x.version) + 1, r.mode_generation, 'brouillon', r.id_semestre, r.id_utilisateur, r.id_ecole
        FROM emploi_du_temps x WHERE x.id_semestre = r.id_semestre
        RETURNING id_edt INTO v_id;
        INSERT INTO contrainte (libelle, type_contrainte, nature, poids, valeur, est_active, parametres, date_debut, date_fin, id_edt, id_ecole)
        SELECT libelle, type_contrainte, nature, poids, valeur, est_active, parametres, date_debut, date_fin, v_id, id_ecole
        FROM contrainte WHERE id_edt = r.id_edt ORDER BY id_contrainte;
        INSERT INTO seance (date_seance, heure_debut, heure_fin, statut, est_verrouillee, id_cours, id_enseignant, id_salle, id_creneau, id_edt, id_ecole)
        SELECT date_seance, heure_debut, heure_fin, statut, est_verrouillee, id_cours, id_enseignant, id_salle, id_creneau, v_id, id_ecole
        FROM seance WHERE id_edt = r.id_edt ORDER BY date_seance, heure_debut;
    END LOOP;
    ALTER TABLE seance ENABLE TRIGGER trg_verifier_seance;
END $$;

-- L'assistant ne travaille plus que sur la version à jour
UPDATE proposition p SET statut = 'rejetee', date_decision = now()
FROM emploi_du_temps e
WHERE e.id_edt = p.id_edt AND e.statut IN ('publie', 'archive') AND p.statut = 'en_attente' AND p.nature = 'seances';

UPDATE conversation c SET id_edt = t.id_edt
FROM emploi_du_temps e JOIN emploi_du_temps t ON t.id_semestre = e.id_semestre AND t.statut = 'brouillon'
WHERE e.id_edt = c.id_edt AND e.statut IN ('publie', 'archive');

UPDATE prompt c SET id_edt = t.id_edt
FROM emploi_du_temps e JOIN emploi_du_temps t ON t.id_semestre = e.id_semestre AND t.statut = 'brouillon'
WHERE e.id_edt = c.id_edt AND e.statut IN ('publie', 'archive');

UPDATE proposition c SET id_edt = t.id_edt
FROM emploi_du_temps e JOIN emploi_du_temps t ON t.id_semestre = e.id_semestre AND t.statut = 'brouillon'
WHERE e.id_edt = c.id_edt AND e.statut IN ('publie', 'archive');

COMMIT;
