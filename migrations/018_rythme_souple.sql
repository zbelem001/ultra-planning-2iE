-- =====================================================================
--  Migration 17 -> 18 : le rythme hebdomadaire d'un cours devient souple.
--  À exécuter une fois sur une base en version 17 (Supabase > SQL Editor),
--  après migrations/017_salle_principale.sql. Sans danger si on la relance.
--
--   * CD-14 (rythme hebdomadaire maximal, COURS.heures_semaine_max) n'est plus
--     une règle dure : verifier_seance() ne le contrôle plus ;
--   * il devient la bonne pratique CS-08 (souple, poids 5), dans chaque emploi du
--     temps et pour les nouveaux : la génération étale les cours à ce rythme, la
--     replanification ne le dépasse qu'en dernier recours ; on peut la désactiver
--     dans la page Génération ;
--   * la seule limite dure d'une semaine reste sa grille de créneaux.
-- =====================================================================

BEGIN;
SET LOCAL search_path = public, extensions;

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
BEGIN
    -- Une séance annulée n'est soumise à aucun contrôle.
    IF NEW.statut = 'annulee' THEN
        IF TG_OP = 'UPDATE' AND OLD.nature = 'examen' AND OLD.statut <> 'annulee' THEN
            PERFORM garder_examen(OLD.id_edt, OLD.id_seance, OLD.id_cours);
        END IF;
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

    -- Une période d'examens est fermée aux cours, pas aux épreuves
    IF EXISTS (SELECT 1 FROM conge g
               WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
                 AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)
                 AND NOT (NEW.nature <> 'cours' AND g.type_conge = 'examens')) THEN
        RAISE EXCEPTION 'CD-09 : le % tombe pendant un congé (%)', NEW.date_seance,
            (SELECT g.libelle FROM conge g
             WHERE NEW.date_seance BETWEEN g.date_debut AND g.date_fin
               AND (g.id_classe IS NULL OR g.id_classe = v_cours.id_classe)
               AND NOT (NEW.nature <> 'cours' AND g.type_conge = 'examens')
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
        CROSS JOIN LATERAL publics_seance(s.id_cours, s.nature) ps
        JOIN publics_seance(NEW.id_cours, NEW.nature) pn ON pn.id_classe = ps.id_classe
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
    -- sinon classe entière ; cours mutualisé : la somme). Épreuves dans la même salle :
    -- la somme de toutes celles qui se chevauchent.
    SELECT coalesce(sum(x.effectif), 0)
    INTO v_effectif
    FROM (
        SELECT coalesce(g.effectif, cl.effectif) AS effectif
        FROM publics_seance(NEW.id_cours, NEW.nature) p
        JOIN classe cl ON cl.id_classe = p.id_classe
        LEFT JOIN groupe g ON g.id_groupe = p.id_groupe
        UNION ALL
        SELECT cl.effectif
        FROM seance s
        CROSS JOIN LATERAL publics_seance(s.id_cours, s.nature) p
        JOIN classe cl ON cl.id_classe = p.id_classe
        WHERE NEW.nature <> 'cours' AND s.nature <> 'cours' AND s.id_edt = NEW.id_edt
          AND s.id_salle = NEW.id_salle AND s.statut <> 'annulee' AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
    ) x;

    IF v_salle.capacite < v_effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif à accueillir (%)',
            v_salle.capacite, v_effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle exigé par le cours, ou l'un des types acceptés (COURS_TYPE_SALLE)
    IF NEW.nature = 'cours'
       AND (v_cours.id_type_salle IS NOT NULL
            OR EXISTS (SELECT 1 FROM cours_type_salle t WHERE t.id_cours = NEW.id_cours))
       AND v_salle.id_type_salle IS DISTINCT FROM v_cours.id_type_salle
       AND NOT EXISTS (SELECT 1 FROM cours_type_salle t
                       WHERE t.id_cours = NEW.id_cours AND t.id_type_salle = v_salle.id_type_salle) THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Site : les mêmes étudiants n'ont cours que sur un campus par demi-journée. Ils changent de
    -- campus à la pause de midi (le matin sur l'un, l'après-midi sur l'autre) ; deux groupes
    -- différents peuvent être sur deux campus en même temps (publics_en_conflit, comme CD-03).
    -- Le campus de la promotion (classe.id_site) guide la génération ; la base ne l'impose pas.
    DECLARE
        v_autre_site TEXT;
        v_midi       TIME := (SELECT min(p.heure_debut) FROM pause p);
    BEGIN
        SELECT cl.code_classe || coalesce(' · ' || g.code_groupe, '') || ' a déjà cours sur le ' || si.nom_site
        INTO v_autre_site
        FROM seance s
        CROSS JOIN LATERAL publics_seance(s.id_cours, s.nature) ps
        JOIN publics_seance(NEW.id_cours, NEW.nature) pn ON pn.id_classe = ps.id_classe
        JOIN salle sa ON sa.id_salle = s.id_salle
        JOIN site si ON si.id_site = sa.id_site
        JOIN classe cl ON cl.id_classe = ps.id_classe
        LEFT JOIN groupe g ON g.id_groupe = ps.id_groupe
        WHERE s.id_edt = NEW.id_edt
          AND s.statut <> 'annulee'
          AND s.date_seance = NEW.date_seance
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
          AND sa.id_site <> v_salle.id_site
          -- même demi-journée : du même côté de la pause de midi
          AND (v_midi IS NULL OR (s.heure_fin <= v_midi) = (NEW.heure_fin <= v_midi))
          AND publics_en_conflit(pn.id_classe, pn.id_groupe, ps.id_classe, ps.id_groupe)
        LIMIT 1;
        IF v_autre_site IS NOT NULL THEN
            RAISE EXCEPTION 'SITE : % cette demi-journée (les mêmes étudiants ne changent de campus qu''à la pause de midi)', v_autre_site
                USING ERRCODE = 'check_violation';
        END IF;
    END;

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

    -- Une épreuve ne compte ni dans le volume, ni dans le rythme, ni dans les matières de la semaine
    IF NEW.nature = 'cours' THEN
        -- CD-08 : le cumul des durées des séances ne dépasse pas le volume horaire
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600), 0)
        INTO v_deja
        FROM seance s
        WHERE s.id_cours = NEW.id_cours
          AND s.id_edt   = NEW.id_edt
          AND s.statut  <> 'annulee'
          AND s.nature   = 'cours'
          AND s.id_seance IS DISTINCT FROM NEW.id_seance;

        IF v_deja + v_duree > v_cours.volume_horaire THEN
            RAISE EXCEPTION 'CD-08 : le volume horaire prévu (% h) serait dépassé (% h déjà planifiées + % h)',
                v_cours.volume_horaire, v_deja, v_duree
                USING ERRCODE = 'check_violation';
        END IF;

        -- Le rythme hebdomadaire du cours (heures_semaine_max) n'est plus contrôlé ici : c'est une
        -- bonne pratique (CS-08, version 18), suivie par la génération et signalée par la console.

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
                      AND s.nature  = 'cours'
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
    END IF;

    -- Dans un module (matière d'une classe), le rattrapage vient après l'examen
    IF NEW.nature = 'rattrapage' AND NOT EXISTS (
        SELECT 1 FROM seance s JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt = NEW.id_edt AND s.nature = 'examen' AND s.statut <> 'annulee'
          AND c.id_matiere = v_cours.id_matiere AND c.id_classe = v_cours.id_classe
          AND s.date_seance + s.heure_fin <= NEW.date_seance + NEW.heure_debut
    ) THEN
        RAISE EXCEPTION 'EXAMEN : un rattrapage vient après l''examen de son module : programmez d''abord l''examen, à une date antérieure'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.nature = 'examen' AND EXISTS (
        SELECT 1 FROM seance s JOIN cours c ON c.id_cours = s.id_cours
        WHERE s.id_edt = NEW.id_edt AND s.nature = 'rattrapage' AND s.statut <> 'annulee'
          AND c.id_matiere = v_cours.id_matiere AND c.id_classe = v_cours.id_classe
          AND s.date_seance + s.heure_debut < NEW.date_seance + NEW.heure_fin
    ) THEN
        RAISE EXCEPTION 'EXAMEN : l''examen d''un module vient avant son rattrapage'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

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
    ( 6, 'CD-06', 'dure',   0, NULL, 'Enseignant présent et disponible'),
    ( 7, 'CD-07', 'dure',   0, NULL, 'Cours conforme au programme de la classe'),
    ( 8, 'CD-08', 'dure',   0, NULL, 'Volume horaire du cours non dépassé'),
    ( 9, 'CD-09', 'dure',   0, NULL, 'Date dans le semestre, hors jours fériés et congés'),
    (10, 'CD-10', 'dure',   0, NULL, 'Séance alignée sur la grille de créneaux'),
    (11, 'CD-11', 'dure',   0, NULL, 'Aucune séance pendant la pause déjeuner'),
    (12, 'CD-12', 'dure',   0, NULL, 'Aucune séance dans une salle indisponible'),
    (13, 'CD-13', 'dure',   0, 3,    'Au plus N matières différentes par classe et par semaine'),
    (15, 'CS-01', 'souple', 8, NULL, 'Respecter les créneaux préférés des enseignants'),
    (16, 'CS-02', 'souple', 5, NULL, 'Éviter les trous dans la journée d''une classe'),
    (17, 'CS-03', 'souple', 5, NULL, 'Limiter les changements de bâtiment et de site'),
    (18, 'CS-04', 'souple', 5, NULL, 'Ramasser les cours des externes, enchaîner ceux des permanents'),
    (19, 'CS-05', 'souple', 2, NULL, 'Placer le CM avant les TD et TP de la semaine'),
    (20, 'CS-06', 'souple', 2, 6,    'Plafonner les heures par jour d''un enseignant'),
    (21, 'CS-07', 'souple', 5, NULL, 'Commencer tôt les cours prioritaires'),
    (22, 'CS-08', 'souple', 5, NULL, 'Respecter le rythme hebdomadaire souhaité de chaque cours (dépassable si nécessaire)')
) AS v(ord, code, nature, poids, valeur, libelle)
CROSS JOIN emploi_du_temps e
WHERE e.id_edt = p_id_edt
ORDER BY v.ord;
$$;

-- La règle CD-14 de chaque emploi du temps devient la bonne pratique CS-08 (son état actif est gardé)
UPDATE contrainte
SET type_contrainte = 'CS-08', nature = 'souple', poids = 5,
    libelle = 'Respecter le rythme hebdomadaire souhaité de chaque cours (dépassable si nécessaire)'
WHERE type_contrainte = 'CD-14';

COMMIT;
