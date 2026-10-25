-- =====================================================================
--  Migration 5 -> 6 : plateforme multi-écoles (table ECOLE, rôle superadmin)
--  À exécuter une fois sur une base en version 5 (Supabase > SQL Editor).
--  Additive : aucune donnée existante n'est supprimée ; relançable.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ecole (
    id_ecole       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code_ecole     TEXT NOT NULL UNIQUE,
    nom            TEXT NOT NULL,
    ville          TEXT,
    pays           TEXT,
    email_contact  TEXT,
    statut         TEXT NOT NULL DEFAULT 'active'
                   CHECK (statut IN ('active','suspendue')),
    date_creation  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Aucune politique : seule l'API (clé secrète) lit les écoles
ALTER TABLE ecole ENABLE ROW LEVEL SECURITY;

INSERT INTO ecole (code_ecole, nom, ville, pays, email_contact) VALUES
    ('2IE', 'Institut International d''Ingénierie de l''Eau et de l''Environnement',
     'Ouagadougou', 'Burkina Faso', 'scolarite@univ.example')
ON CONFLICT (code_ecole) DO NOTHING;

ALTER TABLE utilisateur
    ADD COLUMN IF NOT EXISTS auth_id       UUID UNIQUE,
    ADD COLUMN IF NOT EXISTS est_actif     BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS date_creation TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS id_ecole      BIGINT REFERENCES ecole(id_ecole)
                                           ON UPDATE CASCADE ON DELETE RESTRICT;

-- Les comptes existants appartiennent à 2iE
UPDATE utilisateur SET id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE')
WHERE id_ecole IS NULL;

ALTER TABLE utilisateur DROP CONSTRAINT IF EXISTS utilisateur_role_check;
ALTER TABLE utilisateur ADD CONSTRAINT utilisateur_role_check
    CHECK (role IN ('superadmin','administrateur','planificateur'));
ALTER TABLE utilisateur DROP CONSTRAINT IF EXISTS utilisateur_ecole_check;
ALTER TABLE utilisateur ADD CONSTRAINT utilisateur_ecole_check
    CHECK ((role = 'superadmin') = (id_ecole IS NULL));
-- Login unique par école (l'e-mail reste unique sur toute la plateforme)
ALTER TABLE utilisateur DROP CONSTRAINT IF EXISTS utilisateur_login_key;
ALTER TABLE utilisateur ADD CONSTRAINT utilisateur_login_key UNIQUE (id_ecole, login);

CREATE INDEX IF NOT EXISTS ix_utilisateur_ecole ON utilisateur(id_ecole);

COMMIT;
