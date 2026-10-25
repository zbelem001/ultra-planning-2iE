-- =====================================================================
--  Migration 7 -> 8 : journal d'audit des séances (BNF-08)
--  À exécuter une fois sur une base en version 7 (Supabase > SQL Editor),
--  après migrations/007_isolation_ecoles.sql. Relançable. Le journal commence
--  vide : les séances déjà présentes n'ont pas d'historique.
-- =====================================================================

BEGIN;

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
    apres           JSONB
);
CREATE INDEX IF NOT EXISTS ix_journal_ecole_date ON journal_seance (id_ecole, date_action DESC);
CREATE INDEX IF NOT EXISTS ix_journal_seance ON journal_seance (id_seance);

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
    INSERT INTO journal_seance (action, origine, id_seance, id_edt, id_utilisateur, id_ecole, avant, apres)
    VALUES (
        CASE TG_OP WHEN 'INSERT' THEN 'creation' WHEN 'UPDATE' THEN 'modification' ELSE 'suppression' END,
        coalesce(nullif(current_setting('app.origine', true), ''), 'systeme'),
        coalesce(NEW.id_seance, OLD.id_seance),
        coalesce(NEW.id_edt, OLD.id_edt),
        nullif(current_setting('app.id_utilisateur', true), '')::bigint,
        coalesce(NEW.id_ecole, OLD.id_ecole),
        v_avant, v_apres);
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

COMMIT;
