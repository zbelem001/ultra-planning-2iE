-- =====================================================================
--  Migration 13 -> 14 : une séance de cours peut durer 5 h.
--  À exécuter une fois sur une base en version 13 (Supabase > SQL Editor),
--  après migrations/013_examens.sql. Sans danger si on la relance.
--
--   * une séance de cours dure de 2 h à 5 h (une matinée entière, 7h-12h) ;
--     une épreuve dure toujours de 2 h à 3 h (ck_seance_epreuve_duree) ;
--   * les séances de 5 h se posent à la main, dans Planification : la
--     génération découpe toujours les cours en séances de 2 à 4 h, et les
--     durées préférées d'un cours (COURS.duree_seance, COURS_SEANCE_MODELE)
--     restent de 2 à 4 h.
-- =====================================================================

BEGIN;
SET LOCAL search_path = public, extensions;

-- La contrainte des 2 à 4 h n'a pas de nom choisi (seance_check1 en général) :
-- on la retrouve par sa définition. L'épreuve garde la sienne.
DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.seance'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%heure_fin - heure_debut%'
          AND conname <> 'ck_seance_epreuve_duree'
    LOOP
        EXECUTE format('ALTER TABLE seance DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

-- CD-10 : une séance dure de 2 h à 5 h
ALTER TABLE seance ADD CONSTRAINT ck_seance_duree
    CHECK (heure_fin - heure_debut BETWEEN INTERVAL '2 hours' AND INTERVAL '5 hours');

COMMIT;
