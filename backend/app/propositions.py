"""Propositions de l'assistant IA : enregistrement, application, rejet.

Une proposition n'est appliquée que par un planificateur (jamais par l'agent).
L'application passe par les déclencheurs de la base, qui revalident chaque
séance ; si l'emploi du temps a changé depuis, la proposition est refusée.

Opérations (PROPOSITION.modifications) :
- {"action": "supprimer", "id_seance", "avant"} et {"action": "creer", "apres"} (solveur, ajouts) ;
- {"action": "modifier", "id_seance", "avant", "apres"} : déplacement, annulation,
  rétablissement ou changement d'enseignant d'une séance existante (date, heures, salle,
  statut, id_enseignant).
Une séance créée sans id_enseignant reçoit l'enseignant prévu de son cours.

Proposition de nature « referentiel » : lignes du référentiel, du calendrier ou des enseignants
à ajouter, modifier ou supprimer (referentiel_changements.py), puis éventuellement une génération
ou une replanification à lancer (PROPOSITION.suite).

Une proposition de séances s'applique à la version à jour, seule modifiable : les invités
la voient une fois cette version publiée.
"""

from __future__ import annotations

import json
from datetime import date, time

import psycopg
from psycopg.types.json import Jsonb

from ultraplanning_solver.donnees import jour_de


class PropositionRefusee(Exception):
    pass


def creer(conn: psycopg.Connection, id_prompt: int, id_edt: int, description: str, modifications: list[dict],
          impact: dict | None = None, nature: str = "seances", suite: dict | None = None) -> int:
    row = conn.execute(
        "INSERT INTO proposition (description, modifications, impact, nature, suite, id_prompt, id_edt, id_ecole) "
        "SELECT %s, %s, %s, %s, %s, %s, id_edt, id_ecole FROM emploi_du_temps WHERE id_edt = %s RETURNING id_proposition",
        (description, Jsonb(modifications), Jsonb(impact or {}), nature, Jsonb(suite) if suite else None, id_prompt, id_edt),
    ).fetchone()
    if row is None:
        raise ValueError(f"Emploi du temps {id_edt} introuvable")
    return row[0]


def remplacer(conn: psycopg.Connection, ids: list[int]) -> list[int]:
    """Écarte des propositions encore en attente, remplacées par une nouvelle
    tentative de l'assistant dans le même message."""
    if not ids:
        return []
    rows = conn.execute(
        "UPDATE proposition SET statut = 'rejetee', date_decision = now() "
        "WHERE id_proposition = ANY(%s) AND statut = 'en_attente' RETURNING id_proposition",
        (ids,),
    ).fetchall()
    return [r[0] for r in rows]


def _creneau(conn: psycopg.Connection, ecole: int, s: dict) -> tuple[date, time, time, int]:
    d = date.fromisoformat(s["date_seance"])
    debut, fin = time.fromisoformat(s["heure_debut"]), time.fromisoformat(s["heure_fin"])
    cr = conn.execute(
        "SELECT id_creneau FROM creneau WHERE id_ecole = %s AND jour = %s AND heure_debut = %s",
        (ecole, jour_de(d), debut),
    ).fetchone()
    if cr is None:
        raise PropositionRefusee(f"Aucun créneau ne commence le {d} à {debut:%H:%M}")
    return d, debut, fin, cr[0]


def executer_operations(conn: psycopg.Connection, ops: list[dict], id_edt: int, ecole: int) -> dict:
    """Exécute les opérations (dans la transaction de l'appelant) ; lève PropositionRefusee avec
    le motif de la base si l'une d'elles est refusée ou si l'emploi du temps a changé depuis."""
    compte = {"seances_supprimees": 0, "seances_creees": 0, "seances_modifiees": 0}
    try:
        a_supprimer = [op["id_seance"] for op in ops if op["action"] == "supprimer"]
        if a_supprimer:
            # Verrouillée depuis la proposition : une séance verrouillée ne se supprime pas
            verrouillees = conn.execute("SELECT count(*) FROM seance WHERE id_seance = ANY(%s) AND id_edt = %s AND est_verrouillee",
                                        (a_supprimer, id_edt)).fetchone()[0]
            if verrouillees:
                raise PropositionRefusee(f"{verrouillees} séance(s) à supprimer ont été verrouillées depuis la proposition : une séance "
                                         "verrouillée ne se supprime pas. Déverrouillez-la d'abord dans la page Planification.")
        if a_supprimer:  # en une fois : une suppression peut toucher des centaines de séances
            n = conn.execute("DELETE FROM seance WHERE id_seance = ANY(%s) AND id_edt = %s", (a_supprimer, id_edt)).rowcount
            if n != len(a_supprimer):
                raise PropositionRefusee("Proposition périmée : l'emploi du temps a changé depuis son calcul")
            compte["seances_supprimees"] = n
        for op in ops:
            if op["action"] == "modifier":
                a, s = op["avant"], op["apres"]
                actuelle = conn.execute(
                    "SELECT date_seance, to_char(heure_debut, 'HH24:MI'), to_char(heure_fin, 'HH24:MI'), id_salle, statut, "
                    "id_enseignant FROM seance WHERE id_seance = %s AND id_edt = %s", (op["id_seance"], id_edt),
                ).fetchone()
                # propositions antérieures à l'enseignant par séance : pas d'id_enseignant, non comparé
                if actuelle is None or (actuelle[0].isoformat(), *actuelle[1:5]) != (
                        a["date_seance"], a["heure_debut"], a["heure_fin"], a["id_salle"], a["statut"]) \
                        or ("id_enseignant" in a and actuelle[5] != a["id_enseignant"]):
                    raise PropositionRefusee(f"Proposition périmée : la séance {op['id_seance']} a changé depuis son calcul")
                d, debut, fin, id_creneau = _creneau(conn, ecole, s)
                conn.execute(
                    "UPDATE seance SET date_seance = %s, heure_debut = %s, heure_fin = %s, id_salle = %s, "
                    "id_creneau = %s, statut = %s, id_enseignant = %s WHERE id_seance = %s",
                    (d, debut, fin, s["id_salle"], id_creneau, s["statut"], s.get("id_enseignant", actuelle[5]), op["id_seance"]),
                )
                compte["seances_modifiees"] += 1
        for op in ops:
            if op["action"] == "creer":
                s = op["apres"]
                d, debut, fin, id_creneau = _creneau(conn, ecole, s)
                conn.execute(
                    "INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_enseignant, id_salle, id_creneau, nature, id_edt, id_ecole) "
                    "SELECT %s, %s, %s, %s, CASE WHEN %s THEN %s ELSE c.id_enseignant END, %s, %s, %s, %s, %s "
                    "FROM cours c WHERE c.id_cours = %s",
                    (d, debut, fin, s["id_cours"], "id_enseignant" in s, s.get("id_enseignant"), s["id_salle"], id_creneau,
                     s.get("nature", "cours"), id_edt, ecole, s["id_cours"]),
                )
                compte["seances_creees"] += 1
    except (psycopg.errors.CheckViolation, psycopg.errors.ExclusionViolation) as e:
        motif = e.diag.message_primary or str(e)
        if isinstance(e, psycopg.errors.ExclusionViolation):
            motif = "CD-01 : la salle est déjà occupée sur cette plage horaire"
        raise PropositionRefusee(f"Refusée par la base : {motif}") from e
    return compte


def appliquer(conn: psycopg.Connection, id_proposition: int, id_utilisateur: int) -> dict:
    with conn.transaction():
        row = conn.execute(
            "SELECT p.statut, p.modifications, p.id_edt, e.statut, p.id_ecole, p.nature, p.suite, p.id_prompt, p.description "
            "FROM proposition p "
            "JOIN emploi_du_temps e USING (id_edt, id_ecole) WHERE p.id_proposition = %s FOR UPDATE OF p",
            (id_proposition,),
        ).fetchone()
        if row is None:
            raise PropositionRefusee("Proposition introuvable")
        statut, ops, id_edt, statut_edt, ecole, nature, suite, id_prompt, description = row
        if statut != "en_attente":
            raise PropositionRefusee(f"Proposition déjà {'appliquée' if statut == 'appliquee' else 'rejetée'}")
        if statut_edt in ("publie", "archive") and nature == "seances":
            raise PropositionRefusee("La version publiée ne se modifie pas : seule la version à jour accepte une proposition")
        if isinstance(ops, str):
            ops = json.loads(ops)
        if nature == "referentiel":
            from . import referentiel_changements

            compte = referentiel_changements.executer(conn, ops, id_edt)
        else:
            # Le motif accompagne le changement dans l'historique
            conn.execute("SELECT set_config('app.note', %s, true)", (f"Assistant IA : {description}",))
            compte = executer_operations(conn, ops, id_edt, ecole)
        conn.execute(
            "UPDATE proposition SET statut = 'appliquee', date_decision = now(), id_utilisateur_decision = %s "
            "WHERE id_proposition = %s",
            (id_utilisateur, id_proposition),
        )
    return {"id_proposition": id_proposition, "nature": nature, **compte, "id_edt": id_edt, "id_prompt": id_prompt,
            "suite": suite}


def rejeter(conn: psycopg.Connection, id_proposition: int, id_utilisateur: int) -> None:
    n = conn.execute(
        "UPDATE proposition SET statut = 'rejetee', date_decision = now(), id_utilisateur_decision = %s "
        "WHERE id_proposition = %s AND statut = 'en_attente'",
        (id_utilisateur, id_proposition),
    ).rowcount
    if n != 1:
        raise PropositionRefusee("Proposition introuvable ou déjà décidée")
