-- =====================================================================
--  Migration 8 -> 9 : pièces jointes de l'assistant IA et propositions
--  d'ajouts au référentiel.
--  À exécuter une fois sur une base en version 8 (Supabase > SQL Editor),
--  après migrations/008_journal_audit.sql. Relançable.
-- =====================================================================

BEGIN;

-- Propositions d'ajouts au référentiel (matières, programme, cours...),
-- avec la génération à lancer une fois les ajouts validés
ALTER TABLE proposition
    ADD COLUMN IF NOT EXISTS nature TEXT NOT NULL DEFAULT 'seances',
    ADD COLUMN IF NOT EXISTS suite  JSONB;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proposition_nature_check') THEN
        ALTER TABLE proposition ADD CONSTRAINT proposition_nature_check CHECK (nature IN ('seances','referentiel'));
    END IF;
END $$;

-- Fichier joint à un message de l'assistant (CSV, Excel, PDF, image), 5 Mo au plus
CREATE TABLE IF NOT EXISTS piece_jointe (
    id_piece    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom         TEXT NOT NULL,
    type_mime   TEXT NOT NULL,
    taille      INTEGER NOT NULL CHECK (taille BETWEEN 1 AND 5242880),
    contenu     BYTEA NOT NULL,
    date_ajout  TIMESTAMPTZ NOT NULL DEFAULT now(),
    id_prompt   BIGINT NOT NULL,
    id_ecole    BIGINT NOT NULL DEFAULT app_ecole(),
    CONSTRAINT piece_jointe_id_ecole_fkey FOREIGN KEY (id_ecole) REFERENCES ecole(id_ecole)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    -- même école que le message
    CONSTRAINT piece_jointe_id_prompt_fkey FOREIGN KEY (id_prompt, id_ecole) REFERENCES prompt(id_prompt, id_ecole)
        ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_piece_jointe_prompt ON piece_jointe(id_prompt);
CREATE INDEX IF NOT EXISTS ix_piece_jointe_ecole ON piece_jointe(id_ecole);

ALTER TABLE piece_jointe ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ecole du compte" ON piece_jointe;
CREATE POLICY "ecole du compte" ON piece_jointe TO ultraplanning_app
    USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole());
GRANT SELECT, INSERT, UPDATE, DELETE ON piece_jointe TO ultraplanning_app;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE piece_jointe_id_piece_seq TO ultraplanning_app;

-- Aucun accès direct pour les rôles de Supabase
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
        EXECUTE format('REVOKE ALL ON piece_jointe FROM %I', r);
    END LOOP;
END $$;

COMMIT;
