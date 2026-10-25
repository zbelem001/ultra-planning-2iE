"""Propositions de l'assistant IA : enregistrement, application, rejet.

Une proposition n'est appliquée que par un planificateur (jamais par l'agent).
L'application passe par les déclencheurs de la base, qui revalident chaque
séance ; si l'emploi du temps a changé depuis, la proposition est refusée.
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
          impact: dict | None = None) -> int:
    row = conn.execute(
        "INSERT INTO proposition (description, modifications, impact, id_prompt, id_edt, id_ecole) "
        "SELECT %s, %s, %s, %s, id_edt, id_ecole FROM emploi_du_temps WHERE id_edt = %s RETURNING id_proposition",
        (description, Jsonb(modifications), Jsonb(impact or {}), id_prompt, id_edt),
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


def appliquer(conn: psycopg.Connection, id_proposition: int, id_utilisateur: int) -> dict:
    with conn.transaction():
        row = conn.execute(
            "SELECT p.statut, p.modifications, p.id_edt, e.statut, p.id_ecole FROM proposition p "
            "JOIN emploi_du_temps e USING (id_edt, id_ecole) WHERE p.id_proposition = %s FOR UPDATE OF p",
            (id_proposition,),
        ).fetchone()
        if row is None:
            raise PropositionRefusee("Proposition introuvable")
        statut, ops, id_edt, statut_edt, ecole = row
        if statut != "en_attente":
            raise PropositionRefusee(f"Proposition déjà {'appliquée' if statut == 'appliquee' else 'rejetée'}")
        if statut_edt in ("publie", "archive"):
            raise PropositionRefusee("L'emploi du temps est publié : créez une nouvelle version pour le modifier")
        if isinstance(ops, str):
            ops = json.loads(ops)

        supprimees = creees = 0
        for op in ops:
            if op["action"] == "supprimer":
                n = conn.execute(
                    "DELETE FROM seance WHERE id_seance = %s AND id_edt = %s", (op["id_seance"], id_edt)
                ).rowcount
                if n != 1:
                    raise PropositionRefusee("Proposition périmée : l'emploi du temps a changé depuis son calcul")
                supprimees += 1
        for op in ops:
            if op["action"] == "creer":
                s = op["apres"]
                d = date.fromisoformat(s["date_seance"])
                debut, fin = time.fromisoformat(s["heure_debut"]), time.fromisoformat(s["heure_fin"])
                cr = conn.execute(
                    "SELECT id_creneau FROM creneau WHERE id_ecole = %s AND jour = %s AND heure_debut = %s",
                    (ecole, jour_de(d), debut),
                ).fetchone()
                if cr is None:
                    raise PropositionRefusee(f"Aucun créneau ne commence le {d} à {debut}")
                try:
                    conn.execute(
                        "INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                        (d, debut, fin, s["id_cours"], s["id_salle"], cr[0], id_edt, ecole),
                    )
                except (psycopg.errors.CheckViolation, psycopg.errors.ExclusionViolation) as e:
                    raise PropositionRefusee(f"Refusée par la base : {e.diag.message_primary}") from e
                creees += 1
        conn.execute(
            "UPDATE proposition SET statut = 'appliquee', date_decision = now(), id_utilisateur_decision = %s "
            "WHERE id_proposition = %s",
            (id_utilisateur, id_proposition),
        )
    return {"id_proposition": id_proposition, "seances_supprimees": supprimees, "seances_creees": creees}


def rejeter(conn: psycopg.Connection, id_proposition: int, id_utilisateur: int) -> None:
    n = conn.execute(
        "UPDATE proposition SET statut = 'rejetee', date_decision = now(), id_utilisateur_decision = %s "
        "WHERE id_proposition = %s AND statut = 'en_attente'",
        (id_utilisateur, id_proposition),
    ).rowcount
    if n != 1:
        raise PropositionRefusee("Proposition introuvable ou déjà décidée")
