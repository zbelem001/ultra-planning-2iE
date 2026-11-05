-- =====================================================================
--  Nettoyage du jeu de démonstration de l'école 2IE (à exécuter une fois,
--  dans Supabase > SQL Editor). Facultatif : ce n'est pas une migration.
--
--  schema_supabase.sql remplit l'école 2IE avec des données fictives pour les
--  essais (section 9) ; exemples/salles_a_importer.csv ajoute des salles de test.
--  Ce script les retire et garde le reste : données importées (HyperPlanning…),
--  école, sites utilisés, types de salle, créneaux, pause, jours fériés, congés,
--  semestres, emplois du temps et leurs contraintes, comptes, discussions.
--
--  Supprimé (seulement ces codes, dans l'école 2IE) :
--   * classes L1INFO, L2INFO, L3INFO, M1IA, M2IA, avec leurs groupes, congés
--     propres, publics mutualisés et réservations de salles ;
--   * matières ALGO, BD, RES, WEB, SE, PROBA, ML, ANG et leur programme ;
--   * enseignants ENS-001 à ENS-009, avec disponibilités, absences et séjours
--     (une séance ou un cours d'une autre classe qu'ils assuraient garde sa
--     place, son enseignant devient « à désigner ») ;
--   * salles de démonstration (K-AMPHI1… O-LAB1) et de test (K-AMPHI3… A-S01) ;
--   * les cours de ces classes ou de ces matières, et toutes les séances de ces
--     cours ou dans ces salles (dans toutes les versions) ;
--   * la filière INFO et le site ANNEXE, s'ils ne servent plus.
--
--  MODE APERÇU PAR DÉFAUT : le script fait tout, affiche le bilan dans un
--  message d'erreur (« APERÇU… ») puis annule : rien n'est supprimé. Pour
--  supprimer pour de bon, remplacer v_appliquer := FALSE par TRUE et relancer.
-- =====================================================================

DO $$
DECLARE
    v_appliquer CONSTANT BOOLEAN := FALSE;   -- FALSE : aperçu, TRUE : suppression

    v_ecole     BIGINT;
    v_classes   CONSTANT TEXT[] := ARRAY['L1INFO','L2INFO','L3INFO','M1IA','M2IA'];
    v_matieres  CONSTANT TEXT[] := ARRAY['ALGO','BD','RES','WEB','SE','PROBA','ML','ANG'];
    v_ens       CONSTANT TEXT[] := ARRAY['ENS-001','ENS-002','ENS-003','ENS-004','ENS-005','ENS-006',
                                         'ENS-007','ENS-008','ENS-009'];
    v_salles    CONSTANT TEXT[] := ARRAY['K-AMPHI1','K-AMPHI2','K-A101','K-A102','K-B201','K-LAB1','K-LAB2',
                                         'K-INFO1','O-AMPHI1','O-B101','O-B102','O-INFO1','O-LAB1',
                                         -- exemples/salles_a_importer.csv
                                         'K-AMPHI3','K-C101','K-C102','K-INFO2','K-LAB3','O-B103','O-INFO2','A-S01'];
    v_cours     BIGINT[];
    v_autres    INTEGER;
    n           INTEGER;
    bilan       TEXT := '';
BEGIN
    SELECT id_ecole INTO v_ecole FROM ecole WHERE code_ecole = '2IE';
    IF v_ecole IS NULL THEN
        RAISE EXCEPTION 'École 2IE introuvable';
    END IF;

    -- Cours de démonstration : ceux des classes ou des matières de démonstration
    SELECT array_agg(c.id_cours) INTO v_cours
    FROM cours c
    LEFT JOIN classe cl ON cl.id_classe = c.id_classe
    LEFT JOIN matiere m ON m.id_matiere = c.id_matiere
    WHERE c.id_ecole = v_ecole AND (cl.code_classe = ANY (v_classes) OR m.code_matiere = ANY (v_matieres));
    v_cours := coalesce(v_cours, ARRAY[]::BIGINT[]);
    -- À signaler : un cours d'une autre classe qui utilise une matière de démonstration
    SELECT count(*) INTO v_autres
    FROM cours c JOIN classe cl ON cl.id_classe = c.id_classe
    WHERE c.id_cours = ANY (v_cours) AND NOT cl.code_classe = ANY (v_classes);

    DELETE FROM seance s
    WHERE s.id_ecole = v_ecole
      AND (s.id_cours = ANY (v_cours)
           OR s.id_salle IN (SELECT id_salle FROM salle WHERE id_ecole = v_ecole AND code_salle = ANY (v_salles)));
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('séances : %s ; ', n);

    DELETE FROM cours WHERE id_cours = ANY (v_cours);   -- découpage et publics mutualisés : en cascade
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('cours : %s (dont %s d''autres classes, sur une matière de démonstration) ; ', n, v_autres);

    DELETE FROM programme p
    USING classe cl, matiere m
    WHERE p.id_ecole = v_ecole AND cl.id_classe = p.id_classe AND m.id_matiere = p.id_matiere
      AND (cl.code_classe = ANY (v_classes) OR m.code_matiere = ANY (v_matieres));
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('lignes de programme : %s ; ', n);

    DELETE FROM enseignant WHERE id_ecole = v_ecole AND matricule = ANY (v_ens);   -- disponibilités… en cascade
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('enseignants : %s ; ', n);

    DELETE FROM matiere WHERE id_ecole = v_ecole AND code_matiere = ANY (v_matieres);
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('matières : %s ; ', n);

    DELETE FROM classe WHERE id_ecole = v_ecole AND code_classe = ANY (v_classes);   -- groupes, congés propres… en cascade
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('classes : %s ; ', n);

    DELETE FROM salle WHERE id_ecole = v_ecole AND code_salle = ANY (v_salles);
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('salles : %s ; ', n);

    DELETE FROM filiere f
    WHERE f.id_ecole = v_ecole AND f.code_filiere = 'INFO'
      AND NOT EXISTS (SELECT 1 FROM classe c WHERE c.id_filiere = f.id_filiere);
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('filière INFO : %s ; ', n);

    DELETE FROM site s
    WHERE s.id_ecole = v_ecole AND s.code_site = 'ANNEXE'
      AND NOT EXISTS (SELECT 1 FROM salle x WHERE x.id_site = s.id_site)
      AND NOT EXISTS (SELECT 1 FROM filiere x WHERE x.id_site = s.id_site);
    GET DIAGNOSTICS n = ROW_COUNT;
    bilan := bilan || format('site ANNEXE : %s', n);

    IF NOT v_appliquer THEN
        RAISE EXCEPTION 'APERÇU, rien n''a été supprimé. Seraient supprimés : %. Pour supprimer, mettre v_appliquer à TRUE et relancer.', bilan;
    END IF;
    RAISE NOTICE 'Supprimés : %', bilan;
END $$;

-- Ce qui reste dans l'école 2IE (affiché seulement après une vraie suppression)
SELECT 'classes' AS donnees, string_agg(code_classe, ', ' ORDER BY code_classe) AS codes, count(*) AS nombre
FROM classe WHERE id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE')
UNION ALL
SELECT 'matières', string_agg(code_matiere, ', ' ORDER BY code_matiere), count(*)
FROM matiere WHERE id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE')
UNION ALL
SELECT 'enseignants', string_agg(matricule, ', ' ORDER BY matricule), count(*)
FROM enseignant WHERE id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE')
UNION ALL
SELECT 'salles', NULL, count(*)
FROM salle WHERE id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE')
UNION ALL
SELECT 'cours', NULL, count(*)
FROM cours WHERE id_ecole = (SELECT id_ecole FROM ecole WHERE code_ecole = '2IE');
