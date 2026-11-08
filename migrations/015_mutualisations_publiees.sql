-- =====================================================================
--  Migration 14 -> 15 : les mutualisations se publient avec l'emploi du temps.
--  À exécuter une fois sur une base en version 14 (Supabase > SQL Editor),
--  après migrations/014_seance_5h.sql. Sans danger si on la relance.
--
--   * COURS_PUBLIC reste la table de travail (Planification, Référentiel) ;
--   * COURS_PUBLIC_PUBLIE en est la copie publiée, par version publiée
--     (id_edt) : c'est elle que lisent les invités. Une mutualisation ajoutée
--     ou retirée n'apparaît pour eux qu'à la publication suivante ;
--   * au passage en version 15, la copie reprend les mutualisations
--     actuelles : les invités voient exactement ce qu'ils voyaient avant.
-- =====================================================================

BEGIN;
SET LOCAL search_path = public, extensions;

CREATE TABLE IF NOT EXISTS cours_public_publie (
    id_cours_public_publie BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id_edt     BIGINT NOT NULL,                 -- la version publiée (copie)
    id_cours   BIGINT NOT NULL,
    id_classe  BIGINT NOT NULL,
    id_groupe  BIGINT,                          -- NULL = classe entière
    id_ecole   BIGINT NOT NULL DEFAULT app_ecole()
               REFERENCES ecole(id_ecole) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_edt, id_ecole) REFERENCES emploi_du_temps (id_edt, id_ecole)
               ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_cours, id_ecole) REFERENCES cours (id_cours, id_ecole)
               ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_classe, id_ecole) REFERENCES classe (id_classe, id_ecole)
               ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (id_groupe, id_classe, id_ecole) REFERENCES groupe (id_groupe, id_classe, id_ecole)
               ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_cours_public_publie_edt ON cours_public_publie (id_edt);

ALTER TABLE cours_public_publie ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ecole du compte" ON cours_public_publie;
CREATE POLICY "ecole du compte" ON cours_public_publie TO ultraplanning_app
    USING (id_ecole = app_ecole()) WITH CHECK (id_ecole = app_ecole());
-- Seule la publication l'écrit (app/publication.py) : ni mise à jour ni synchronisation
REVOKE ALL ON cours_public_publie FROM ultraplanning_app;
GRANT SELECT, INSERT, DELETE ON cours_public_publie TO ultraplanning_app;
GRANT USAGE, SELECT ON SEQUENCE cours_public_publie_id_cours_public_publie_seq TO ultraplanning_app;
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
        EXECUTE format('REVOKE ALL ON cours_public_publie FROM %I', r);
    END LOOP;
END $$;

-- Copie de départ, au premier passage seulement (table encore vide) : les mutualisations
-- actuelles, pour chaque version publiée
INSERT INTO cours_public_publie (id_edt, id_cours, id_classe, id_groupe, id_ecole)
SELECT e.id_edt, p.id_cours, p.id_classe, p.id_groupe, p.id_ecole
FROM emploi_du_temps e
JOIN cours c ON c.id_semestre = e.id_semestre AND c.id_ecole = e.id_ecole
JOIN cours_public p ON p.id_cours = c.id_cours
WHERE e.statut IN ('publie', 'archive')
  AND NOT EXISTS (SELECT 1 FROM cours_public_publie)
ORDER BY e.id_edt, p.id_cours_public;

COMMIT;
