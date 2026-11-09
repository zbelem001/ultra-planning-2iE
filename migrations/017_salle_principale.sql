-- =====================================================================
--  Migration 16 -> 17 : salle principale d'une classe.
--  À exécuter une fois sur une base en version 16 (Supabase > SQL Editor),
--  après migrations/016_un_campus_par_demi_journee.sql. Sans danger si on la relance.
--
--   * CLASSE.id_salle_principale : la salle de cours habituelle de la classe
--     (NULL : aucune). Elle peut changer en cours d'année ;
--   * ce n'est pas une règle : la base ne l'impose à aucune séance. La génération
--     la préfère quand elle convient (type, capacité, libre), sinon prend une autre
--     salle ; la console la propose en premier ;
--   * une salle supprimée vide la salle principale des classes qui l'avaient.
-- =====================================================================

BEGIN;
SET LOCAL search_path = public, extensions;

ALTER TABLE classe ADD COLUMN IF NOT EXISTS id_salle_principale BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classe_id_salle_principale_fkey') THEN
        ALTER TABLE classe ADD CONSTRAINT classe_id_salle_principale_fkey
            FOREIGN KEY (id_salle_principale, id_ecole) REFERENCES salle (id_salle, id_ecole)
            ON UPDATE CASCADE ON DELETE SET NULL (id_salle_principale);
    END IF;
END $$;

COMMIT;
