-- =====================================================================
--  Migration 9 -> 10 : enseignant par séance, habilitations supprimées.
--  À exécuter une fois sur une base en version 9 (Supabase > SQL Editor),
--  après migrations/009_pieces_jointes.sql.
--
--  * seance.id_enseignant (vide possible) : chaque séance a son enseignant,
--    repris de son cours pour les séances existantes ;
--  * cours.id_enseignant devient l'enseignant prévu, facultatif ;
--  * table HABILITATION supprimée, et ses contrôles (CD-06) avec elle ;
--  * un enseignant renseigné reste contrôlé : CD-02, absences, séjours des
--    externes, disponibilités.
-- =====================================================================

BEGIN;

-- Enseignant prévu du cours : facultatif ; supprimer l'enseignant vide le champ
ALTER TABLE cours ALTER COLUMN id_enseignant DROP NOT NULL;
ALTER TABLE cours DROP CONSTRAINT IF EXISTS cours_id_enseignant_fkey;
ALTER TABLE cours ADD CONSTRAINT cours_id_enseignant_fkey
    FOREIGN KEY (id_enseignant, id_ecole) REFERENCES enseignant(id_enseignant, id_ecole)
    ON UPDATE CASCADE ON DELETE SET NULL (id_enseignant);

-- Enseignant de chaque séance
ALTER TABLE seance ADD COLUMN IF NOT EXISTS id_enseignant BIGINT;
ALTER TABLE seance DROP CONSTRAINT IF EXISTS seance_id_enseignant_fkey;
ALTER TABLE seance ADD CONSTRAINT seance_id_enseignant_fkey
    FOREIGN KEY (id_enseignant, id_ecole) REFERENCES enseignant(id_enseignant, id_ecole)
    ON UPDATE CASCADE ON DELETE SET NULL (id_enseignant);
CREATE INDEX IF NOT EXISTS ix_seance_enseignant ON seance(id_enseignant);

-- Séances existantes : l'enseignant de leur cours. Sans revalidation ni
-- journal (rien ne change pour elles) : déclencheurs suspendus le temps de la copie.
ALTER TABLE seance DISABLE TRIGGER trg_verifier_seance;
ALTER TABLE seance DISABLE TRIGGER trg_journal_seance;
UPDATE seance s SET id_enseignant = c.id_enseignant
FROM cours c WHERE c.id_cours = s.id_cours AND s.id_enseignant IS NULL;
ALTER TABLE seance ENABLE TRIGGER trg_verifier_seance;
ALTER TABLE seance ENABLE TRIGGER trg_journal_seance;

-- Plus d'habilitations
DROP TABLE IF EXISTS habilitation CASCADE;

-- Contrôles des séances : l'enseignant de la séance, s'il y en a un
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
    v_type_grp  TEXT;
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
    -- respectives et pourraient contourner CD-02 / CD-03.a
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

    -- CD-03 : une classe ne peut pas suivre deux séances qui se chevauchent.
    -- Seule exception : deux groupes différents du même type (TP-G1 / TP-G2,
    -- TD-A / TD-B) peuvent être en parallèle ; salle et enseignant différents
    -- sont déjà imposés par CD-01 et CD-02.
    SELECT g.type_groupe INTO v_type_grp FROM groupe g WHERE g.id_groupe = v_cours.id_groupe;

    IF EXISTS (
        SELECT 1
        FROM seance s
        JOIN cours c ON c.id_cours = s.id_cours
        LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
        WHERE s.id_edt  = NEW.id_edt
          AND s.statut <> 'annulee'
          AND c.id_classe = v_cours.id_classe
          AND s.plage && v_plage
          AND s.id_seance IS DISTINCT FROM NEW.id_seance
          AND NOT (v_cours.id_groupe IS NOT NULL
                   AND c.id_groupe IS NOT NULL
                   AND c.id_groupe <> v_cours.id_groupe
                   AND g.type_groupe = v_type_grp)
    ) THEN
        RAISE EXCEPTION 'CD-03 : la classe a déjà une séance qui chevauche cette plage horaire (seuls deux groupes différents du même type peuvent être en parallèle)'
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-04 : capacité de la salle >= effectif du groupe (si le cours cible
    -- un groupe) ou de la classe entière (sinon)
    IF v_cours.id_groupe IS NOT NULL THEN
        SELECT g.effectif INTO v_effectif FROM groupe g WHERE g.id_groupe = v_cours.id_groupe;
    ELSE
        v_effectif := v_classe.effectif;
    END IF;

    IF v_salle.capacite < v_effectif THEN
        RAISE EXCEPTION 'CD-04 : capacité de la salle (%) inférieure à l''effectif à accueillir (%)',
            v_salle.capacite, v_effectif
            USING ERRCODE = 'check_violation';
    END IF;

    -- CD-05 : type de salle conforme au type exigé par le cours
    IF v_cours.id_type_salle IS NOT NULL
       AND v_salle.id_type_salle <> v_cours.id_type_salle THEN
        RAISE EXCEPTION 'CD-05 : le type de la salle ne correspond pas au type exigé par le cours'
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

    -- CD-13 : au plus N matières différentes par classe et par semaine
    -- (N = valeur de la contrainte CD-13 de l'emploi du temps, 3 par défaut)
    SELECT CASE WHEN COUNT(*) = 0 THEN 3
                WHEN BOOL_OR(k.est_active) THEN MAX(k.valeur) END
    INTO v_max_mat
    FROM contrainte k
    WHERE k.id_edt = NEW.id_edt AND k.type_contrainte = 'CD-13';

    IF v_max_mat IS NOT NULL THEN
        SELECT COUNT(DISTINCT m.id_matiere) INTO v_nb_mat
        FROM (
            SELECT c.id_matiere
            FROM seance s JOIN cours c ON c.id_cours = s.id_cours
            WHERE s.id_edt  = NEW.id_edt
              AND s.statut <> 'annulee'
              AND c.id_classe = v_cours.id_classe
              AND date_trunc('week', s.date_seance::timestamp) = date_trunc('week', NEW.date_seance::timestamp)
              AND s.id_seance IS DISTINCT FROM NEW.id_seance
            UNION ALL
            SELECT v_cours.id_matiere
        ) m;

        IF v_nb_mat > v_max_mat THEN
            RAISE EXCEPTION 'CD-13 : la classe aurait % matières différentes cette semaine (maximum %)', v_nb_mat, trunc(v_max_mat)::int
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Contrôles des cours : sans habilitation
CREATE OR REPLACE FUNCTION verifier_cours()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_prevu  NUMERIC;
BEGIN
    IF NEW.type_cours = 'CM' AND NEW.id_groupe IS NOT NULL THEN
        RAISE EXCEPTION 'Un CM s''adresse à la classe entière : il ne peut pas cibler un groupe'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.id_groupe IS NOT NULL AND NEW.type_cours <>
       (SELECT g.type_groupe FROM groupe g WHERE g.id_groupe = NEW.id_groupe) THEN
        RAISE EXCEPTION 'Un cours de % ne peut cibler qu''un groupe de %', NEW.type_cours, NEW.type_cours
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

DROP TRIGGER IF EXISTS trg_verifier_cours ON cours;
CREATE TRIGGER trg_verifier_cours
    BEFORE INSERT OR UPDATE OF id_matiere, type_cours, id_groupe,
                               id_classe, id_semestre, volume_horaire ON cours
    FOR EACH ROW
    EXECUTE FUNCTION verifier_cours();

-- Libellé de CD-06 (contraintes existantes et nouveaux emplois du temps)
UPDATE contrainte SET libelle = 'Enseignant présent et disponible'
WHERE type_contrainte = 'CD-06' AND libelle = 'Enseignant habilité, présent et disponible';
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
    (14, 'CD-14', 'dure',   0, NULL, 'Rythme hebdomadaire maximal de chaque cours'),
    (15, 'CS-01', 'souple', 8, NULL, 'Respecter les créneaux préférés des enseignants'),
    (16, 'CS-02', 'souple', 5, NULL, 'Éviter les trous dans la journée d''une classe'),
    (17, 'CS-03', 'souple', 5, NULL, 'Limiter les changements de bâtiment et de site'),
    (18, 'CS-04', 'souple', 5, NULL, 'Ramasser les cours des externes, enchaîner ceux des permanents'),
    (19, 'CS-05', 'souple', 2, NULL, 'Placer le CM avant les TD et TP de la semaine'),
    (20, 'CS-06', 'souple', 2, 6,    'Plafonner les heures par jour d''un enseignant'),
    (21, 'CS-07', 'souple', 5, NULL, 'Commencer tôt les cours prioritaires')
) AS v(ord, code, nature, poids, valeur, libelle)
CROSS JOIN emploi_du_temps e
WHERE e.id_edt = p_id_edt
ORDER BY v.ord;
$$;

COMMIT;
