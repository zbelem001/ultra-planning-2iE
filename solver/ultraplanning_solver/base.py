"""Lecture et écriture dans PostgreSQL / Supabase.

Le solveur lit tout ce dont il a besoin pour un emploi du temps, puis écrit
son résultat en passant par les déclencheurs de la base : chaque séance est
revalidée (CD-01 à CD-14), ce qui double la garantie du solveur.

Plusieurs écoles partagent la base : toutes les lectures et écritures portent
explicitement sur l'école de l'emploi du temps. (Sous l'API, la RLS filtre en
plus ; en ligne de commande ou dans les tests, ce filtre suffit.)
"""

from __future__ import annotations

import math
from collections import defaultdict

import psycopg
from psycopg.rows import dict_row

from .demande import Resultat
from .donnees import (
    Classe, Conge, Cours, Creneau, Donnees, Enseignant, Groupe, Periode, Salle, Seance, jour_de,
)


def charger(conn: psycopg.Connection, id_edt: int) -> Donnees:
    cur = conn.cursor(row_factory=dict_row)
    cur.execute(
        "SELECT e.id_edt, e.id_ecole, s.id_semestre, s.date_debut, s.date_fin "
        "FROM emploi_du_temps e JOIN semestre s USING (id_semestre, id_ecole) WHERE e.id_edt = %s",
        (id_edt,),
    )
    edt = cur.fetchone()
    if edt is None:
        raise ValueError(f"Emploi du temps {id_edt} introuvable")
    ecole = edt["id_ecole"]

    def tout(table: str, suite: str = "", *params):
        """Lignes d'une table pour l'école de l'emploi du temps."""
        cur.execute(f"SELECT * FROM {table} WHERE id_ecole = %s {suite}", (ecole, *params))
        return cur.fetchall()

    classes = {r["id_classe"]: Classe(r["id_classe"], r["code_classe"], r["effectif"], r["id_filiere"]) for r in tout("classe")}
    groupes = {
        r["id_groupe"]: Groupe(r["id_groupe"], r["code_groupe"], r["type_groupe"], r["effectif"], r["id_classe"])
        for r in tout("groupe")
    }
    enseignants = {
        r["id_enseignant"]: Enseignant(r["id_enseignant"], f"{r['prenom']} {r['nom']}", r["statut"], r["nb_heures_max_semaine"])
        for r in tout("enseignant")
    }
    salles = {
        r["id_salle"]: Salle(r["id_salle"], r["nom_salle"], r["capacite"], r["id_type_salle"], r["id_site"], r["batiment"], r["est_disponible"])
        for r in tout("salle")
    }
    creneaux = [Creneau(r["id_creneau"], r["jour"], r["heure_debut"], r["heure_fin"]) for r in tout("creneau")]
    pauses = [(r["heure_debut"], r["heure_fin"]) for r in tout("pause")]
    feries = {r["date_ferie"] for r in tout("jour_ferie")}
    conges = [Conge(r["date_debut"], r["date_fin"], r["id_classe"]) for r in tout("conge")]

    modeles: dict[int, list[int]] = defaultdict(list)
    for r in tout("cours_seance_modele", "ORDER BY id_cours, rang"):
        modeles[r["id_cours"]].append(_heures_entieres(r["duree_heures"], "durée de séance"))
    cours = {}
    for r in tout("cours", "AND id_semestre = %s", edt["id_semestre"]):
        k = r["id_cours"]
        cours[k] = Cours(
            k, r["type_cours"], math.ceil(r["volume_horaire"]), r["id_matiere"], r["id_classe"], r["id_groupe"],
            r["id_enseignant"], r["id_type_salle"], r["priorite"],
            math.floor(r["heures_semaine_min"]), math.floor(r["heures_semaine_max"]),
            tuple(modeles.get(k) or [_heures_entieres(r["duree_seance"], "duree_seance")]),
        )

    disponibilites = {}
    cur.execute("SELECT d.id_enseignant, d.niveau, c.jour, c.heure_debut "
                "FROM disponibilite d JOIN creneau c USING (id_creneau, id_ecole) WHERE d.id_ecole = %s", (ecole,))
    for r in cur.fetchall():
        if r["niveau"] != "disponible":
            disponibilites[r["id_enseignant"], r["jour"], r["heure_debut"]] = r["niveau"]
    absences: dict[int, list[Periode]] = defaultdict(list)
    for r in tout("absence_enseignant"):
        absences[r["id_enseignant"]].append(Periode(r["date_debut"], r["date_fin"]))
    sejours: dict[int, list[Periode]] = defaultdict(list)
    for r in tout("sejour_enseignant"):
        sejours[r["id_enseignant"]].append(Periode(r["date_debut"], r["date_fin"]))

    seances = [
        Seance(r["id_cours"], r["date_seance"], r["heure_debut"], r["heure_fin"], r["id_salle"], r["id_seance"], r["est_verrouillee"])
        for r in tout("seance", "AND id_edt = %s AND statut <> 'annulee'", id_edt)
    ]

    poids, max_mat, plafond_jour = {}, 3, 6
    contraintes = tout("contrainte", "AND id_edt = %s", id_edt)
    for r in contraintes:
        if r["nature"] == "souple" and r["est_active"]:
            poids[r["type_contrainte"]] = r["poids"]
        if r["type_contrainte"] == "CD-13":
            max_mat = int(r["valeur"] or 3) if r["est_active"] else None
        if r["type_contrainte"] == "CS-06" and r["valeur"] is not None:
            plafond_jour = int(r["valeur"])
    if not contraintes:  # emploi du temps sans contraintes saisies : poids par défaut
        poids = {"CS-01": 8, "CS-02": 5, "CS-03": 5, "CS-04": 5, "CS-05": 2, "CS-06": 2, "CS-07": 5}

    return Donnees(
        id_edt=id_edt,
        id_ecole=ecole,
        semestre_debut=edt["date_debut"],
        semestre_fin=edt["date_fin"],
        classes=classes, groupes=groupes, enseignants=enseignants, salles=salles,
        creneaux=creneaux, pauses=pauses, jours_feries=feries, conges=conges, cours=cours,
        disponibilites=disponibilites, absences=dict(absences), sejours=dict(sejours), seances=seances,
        poids=poids, max_matieres_semaine=max_mat, plafond_heures_jour=plafond_jour,
    )


def _heures_entieres(v, quoi: str) -> int:
    if v != int(v):
        raise ValueError(f"Le solveur travaille en heures entières ({quoi} = {v})")
    return int(v)


def ecole_de(conn: psycopg.Connection, id_edt: int) -> int:
    row = conn.execute("SELECT id_ecole FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise ValueError(f"Emploi du temps {id_edt} introuvable")
    return row[0]


def _id_creneau(conn: psycopg.Connection, ecole: int, s: Seance) -> int:
    row = conn.execute(
        "SELECT id_creneau FROM creneau WHERE id_ecole = %s AND jour = %s AND heure_debut = %s",
        (ecole, jour_de(s.date_seance), s.heure_debut),
    ).fetchone()
    if row is None:
        raise ValueError(f"Aucun créneau ne commence le {jour_de(s.date_seance)} à {s.heure_debut}")
    return row[0]


def enregistrer(conn: psycopg.Connection, id_edt: int, resultat: Resultat) -> int:
    """Remplace les séances du périmètre par celles du résultat, dans une
    transaction. Si le déclencheur refuse une séance, rien n'est écrit et
    l'erreur de la base remonte (avec son code CD-xx)."""
    ecole = ecole_de(conn, id_edt)
    with conn.transaction():
        ids = [s.id_seance for s in resultat.remplacees if s.id_seance is not None]
        if ids:
            conn.execute("DELETE FROM seance WHERE id_seance = ANY(%s) AND id_ecole = %s", (ids, ecole))
        for s in resultat.seances:
            conn.execute(
                "INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (s.date_seance, s.heure_debut, s.heure_fin, s.id_cours, s.id_salle, _id_creneau(conn, ecole, s), id_edt, ecole),
            )
        conn.execute("UPDATE emploi_du_temps SET mode_generation = 'automatique' WHERE id_edt = %s", (id_edt,))
    return len(resultat.seances)


def verifier(conn: psycopg.Connection, id_edt: int, s: Seance) -> str | None:
    """Teste une séance contre toutes les règles de la base sans rien
    enregistrer (outil verifier_modification de l'assistant). Renvoie le
    message de refus, ou None si la séance est acceptée."""
    ecole = ecole_de(conn, id_edt)
    try:
        with conn.transaction():
            if s.id_seance is not None:
                n = conn.execute(
                    "UPDATE seance SET date_seance = %s, heure_debut = %s, heure_fin = %s, id_salle = %s, id_creneau = %s "
                    "WHERE id_seance = %s AND id_ecole = %s",
                    (s.date_seance, s.heure_debut, s.heure_fin, s.id_salle, _id_creneau(conn, ecole, s), s.id_seance, ecole),
                ).rowcount
                if n != 1:
                    return f"Séance {s.id_seance} introuvable"
            else:
                conn.execute(
                    "INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                    (s.date_seance, s.heure_debut, s.heure_fin, s.id_cours, s.id_salle, _id_creneau(conn, ecole, s), id_edt, ecole),
                )
            raise _Annuler
    except _Annuler:
        return None
    except psycopg.errors.CheckViolation as e:
        return e.diag.message_primary
    except psycopg.errors.ExclusionViolation:
        return "CD-01 : la salle est déjà occupée sur cette plage horaire"
    except psycopg.errors.ForeignKeyViolation:
        return "Cours ou salle introuvable dans cette école"


class _Annuler(Exception):
    """Sert à annuler la transaction de vérification."""
