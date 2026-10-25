"""Console du super administrateur : écoles clientes et comptes de gestion.

Le super admin crée une école, puis invite ses administrateurs par e-mail
(Supabase Auth). Il peut suspendre une école (plus aucun de ses comptes ne se
connecte) ou désactiver un compte. Il n'accède pas aux emplois du temps.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field, field_validator

from . import comptes
from .auth import Utilisateur, compte_courant, superadmin_courant
from .db import connexion

routeur = APIRouter()


@routeur.get("/api/moi")
def moi(u: Utilisateur = Depends(compte_courant), conn: psycopg.Connection = Depends(connexion)) -> dict:
    """Compte connecté et son école (les deux consoles l'appellent après la connexion)."""
    row = conn.execute(
        "SELECT u.email, e.id_ecole, e.code_ecole, e.nom FROM utilisateur u LEFT JOIN ecole e USING (id_ecole) "
        "WHERE u.id_utilisateur = %s", (u.id_utilisateur,),
    ).fetchone()
    return {
        "id_utilisateur": u.id_utilisateur, "login": u.login, "role": u.role, "email": row[0],
        "ecole": {"id_ecole": row[1], "code_ecole": row[2], "nom": row[3]} if row[1] else None,
    }


# --- écoles -------------------------------------------------------------------------

class EcoleSaisie(BaseModel):
    code_ecole: str = Field(min_length=2, max_length=12)
    nom: str = Field(min_length=2, max_length=200)
    ville: str | None = None
    pays: str | None = None
    email_contact: EmailStr | None = None

    @field_validator("code_ecole")
    @classmethod
    def _code(cls, v: str) -> str:
        v = v.strip().upper()
        if not v.replace("-", "").isalnum():
            raise ValueError("lettres, chiffres et tirets seulement")
        return v


class EcoleModification(BaseModel):
    nom: str | None = Field(default=None, min_length=2, max_length=200)
    ville: str | None = None
    pays: str | None = None
    email_contact: EmailStr | None = None
    statut: Literal["active", "suspendue"] | None = None


COLONNES_ECOLE = "id_ecole, code_ecole, nom, ville, pays, email_contact, statut, date_creation"


def _ecole(row) -> dict:
    cles = COLONNES_ECOLE.split(", ")
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in zip(cles, row)}


@routeur.get("/api/superadmin/ecoles")
def lister_ecoles(conn: psycopg.Connection = Depends(connexion), _: Utilisateur = Depends(superadmin_courant)) -> list[dict]:
    rows = conn.execute(
        f"SELECT {', '.join('e.' + c for c in COLONNES_ECOLE.split(', '))}, "
        "count(u.id_utilisateur), count(u.id_utilisateur) FILTER (WHERE u.est_actif), "
        "count(u.id_utilisateur) FILTER (WHERE u.role = 'administrateur' AND u.est_actif) "
        "FROM ecole e LEFT JOIN utilisateur u USING (id_ecole) GROUP BY e.id_ecole ORDER BY e.nom"
    ).fetchall()
    return [_ecole(r[:8]) | {"nb_comptes": r[8], "nb_comptes_actifs": r[9], "nb_administrateurs": r[10]} for r in rows]


@routeur.post("/api/superadmin/ecoles", status_code=201)
def creer_ecole(e: EcoleSaisie, conn: psycopg.Connection = Depends(connexion),
                _: Utilisateur = Depends(superadmin_courant)) -> dict:
    try:
        row = conn.execute(
            f"INSERT INTO ecole (code_ecole, nom, ville, pays, email_contact) VALUES (%s, %s, %s, %s, %s) "
            f"RETURNING {COLONNES_ECOLE}",
            (e.code_ecole, e.nom.strip(), e.ville, e.pays, e.email_contact),
        ).fetchone()
        # Grille, pause et types de salle de départ (modifiables ensuite par l'école)
        conn.execute("SELECT initialiser_ecole(%s)", (row[0],))
    except psycopg.errors.UniqueViolation as err:
        raise HTTPException(409, f"Le code {e.code_ecole} est déjà utilisé") from err
    return _ecole(row)


@routeur.patch("/api/superadmin/ecoles/{id_ecole}")
def modifier_ecole(id_ecole: int, m: EcoleModification, conn: psycopg.Connection = Depends(connexion),
                   _: Utilisateur = Depends(superadmin_courant)) -> dict:
    champs = m.model_dump(exclude_unset=True)
    if not champs:
        raise HTTPException(422, "Rien à modifier")
    ensemble = ", ".join(f"{k} = %s" for k in champs)  # noms contrôlés par le modèle pydantic
    row = conn.execute(
        f"UPDATE ecole SET {ensemble} WHERE id_ecole = %s RETURNING {COLONNES_ECOLE}", (*champs.values(), id_ecole)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "École introuvable")
    return _ecole(row)


# --- comptes des écoles (règles communes : app/comptes.py) ---------------------------------

@routeur.get("/api/superadmin/ecoles/{id_ecole}/comptes")
def lister_comptes(id_ecole: int, conn: psycopg.Connection = Depends(connexion),
                   _: Utilisateur = Depends(superadmin_courant)) -> list[dict]:
    return comptes.lister(conn, id_ecole)


@routeur.post("/api/superadmin/ecoles/{id_ecole}/comptes", status_code=201)
def creer_compte(id_ecole: int, c: comptes.CompteSaisie, conn: psycopg.Connection = Depends(connexion),
                 _: Utilisateur = Depends(superadmin_courant)) -> dict:
    return comptes.inviter(conn, id_ecole, c)


@routeur.post("/api/superadmin/comptes/{id_utilisateur}/inviter")
def renvoyer_invitation(id_utilisateur: int, conn: psycopg.Connection = Depends(connexion),
                        _: Utilisateur = Depends(superadmin_courant)) -> dict:
    return comptes.renvoyer(conn, id_utilisateur)


@routeur.patch("/api/superadmin/comptes/{id_utilisateur}")
def modifier_compte(id_utilisateur: int, m: comptes.CompteModification, conn: psycopg.Connection = Depends(connexion),
                    _: Utilisateur = Depends(superadmin_courant)) -> dict:
    return comptes.modifier(conn, id_utilisateur, m)


# --- journal d'audit des séances (BNF-08) ---------------------------------------------

def _heure(v):
    """« 07:00:00 » devient « 07:00 » ; les autres valeurs ne changent pas."""
    return v[:5] if isinstance(v, str) and len(v) == 8 and v[2] == ":" else v


CHAMPS_SUIVIS = {"date_seance": "date", "heure_debut": "début", "heure_fin": "fin", "id_salle": "salle",
                 "statut": "statut", "est_verrouillee": "verrouillage", "id_cours": "cours"}


@routeur.get("/api/superadmin/journal")
def journal(id_ecole: int | None = None, du: date | None = None, au: date | None = None,
            action: Literal["creation", "modification", "suppression"] | None = None,
            origine: str | None = None, avant: int | None = None, limite: int = Query(100, ge=1, le=500),
            conn: psycopg.Connection = Depends(connexion), _: Utilisateur = Depends(superadmin_courant)) -> dict:
    """Changements de séances, du plus récent au plus ancien ; `avant` : page suivante (id_journal)."""
    rows = conn.execute(
        """SELECT j.id_journal, j.date_action, j.action, j.origine, j.id_seance, j.id_edt, e.version,
                  ec.code_ecole, u.login, j.avant, j.apres,
                  m.libelle, c.type_cours, cl.code_classe, g.code_groupe, sa.nom_salle, sb.nom_salle
           FROM journal_seance j
           JOIN ecole ec USING (id_ecole)
           LEFT JOIN emploi_du_temps e ON e.id_edt = j.id_edt
           LEFT JOIN utilisateur u ON u.id_utilisateur = j.id_utilisateur
           LEFT JOIN cours c ON c.id_cours = (coalesce(j.apres, j.avant) ->> 'id_cours')::bigint
           LEFT JOIN matiere m ON m.id_matiere = c.id_matiere
           LEFT JOIN classe cl ON cl.id_classe = c.id_classe
           LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
           LEFT JOIN salle sa ON sa.id_salle = (j.avant ->> 'id_salle')::bigint
           LEFT JOIN salle sb ON sb.id_salle = (j.apres ->> 'id_salle')::bigint
           WHERE (%(ecole)s::bigint IS NULL OR j.id_ecole = %(ecole)s)
             AND (%(du)s::date IS NULL OR j.date_action >= %(du)s)
             AND (%(au)s::date IS NULL OR j.date_action < %(au)s::date + 1)
             AND (%(action)s::text IS NULL OR j.action = %(action)s)
             AND (%(origine)s::text IS NULL OR j.origine = %(origine)s)
             AND (%(avant)s::bigint IS NULL OR j.id_journal < %(avant)s)
           ORDER BY j.id_journal DESC LIMIT %(limite)s""",
        {"ecole": id_ecole, "du": du, "au": au, "action": action, "origine": origine, "avant": avant, "limite": limite + 1},
    ).fetchall()
    lignes = []
    for r in rows[:limite]:
        a, b = r[9] or {}, r[10] or {}
        s = b or a
        changements = [
            {"champ": libelle,
             "avant": r[15] if k == "id_salle" else _heure(a.get(k)),
             "apres": r[16] if k == "id_salle" else _heure(b.get(k))}
            for k, libelle in CHAMPS_SUIVIS.items() if r[2] == "modification" and a.get(k) != b.get(k)
        ]
        lignes.append({
            "id_journal": r[0], "date_action": r[1].isoformat(), "action": r[2], "origine": r[3],
            "id_seance": r[4], "id_edt": r[5], "version": r[6], "ecole": r[7], "utilisateur": r[8],
            "cours": f"{r[11]} ({r[12]})" if r[11] else f"cours {s.get('id_cours')}",
            "classe": f"{r[13]}{' · ' + r[14] if r[14] else ''}" if r[13] else None,
            "seance": {"date": s.get("date_seance"), "debut": (s.get("heure_debut") or "")[:5],
                       "fin": (s.get("heure_fin") or "")[:5], "salle": r[16] or r[15]},
            "changements": changements,
        })
    return {"lignes": lignes, "suivant": rows[limite - 1][0] if len(rows) > limite else None}
