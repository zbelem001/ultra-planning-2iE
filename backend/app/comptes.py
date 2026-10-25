"""Comptes de gestion d'une école : invitation (Supabase Auth), renvoi, modification.

Les mêmes règles servent au super admin (n'importe quelle école) et à
l'administrateur d'une école (la sienne seulement : ses requêtes passent par la
RLS, qui ne lui montre que les comptes de son école).

Un compte n'existe que par invitation : il reçoit un e-mail, suit le lien et
choisit son mot de passe. La page Utilisateurs de la console ne crée donc plus de
compte par synchronisation (base_api refuse la table utilisateur).
"""

from __future__ import annotations

from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from . import config, supabase_admin
from .auth import Utilisateur, utilisateur_courant
from .db import connexion

routeur = APIRouter()


class CompteSaisie(BaseModel):
    email: EmailStr
    login: str = Field(min_length=2, max_length=60)
    role: Literal["administrateur", "planificateur"] = "administrateur"


class CompteModification(BaseModel):
    est_actif: bool | None = None
    email: EmailStr | None = None
    login: str | None = Field(default=None, min_length=2, max_length=60)
    role: Literal["administrateur", "planificateur"] | None = None


COLONNES = "id_utilisateur, login, email, role, est_actif, date_creation, auth_id"


def _compte(row, invitation: str) -> dict:
    return {"id_utilisateur": row[0], "login": row[1], "email": row[2], "role": row[3], "est_actif": row[4],
            "date_creation": row[5].isoformat(), "invitation": invitation}


def _invitation(auth_id) -> str:
    if auth_id is None:
        return "non_envoyee"
    try:
        return supabase_admin.etat(str(auth_id))
    except supabase_admin.ErreurSupabase:
        return "inconnue"


def _doublon(e: psycopg.errors.UniqueViolation) -> HTTPException:
    quoi = "cette adresse e-mail" if "email" in (e.diag.constraint_name or "") else "ce login dans l'école"
    return HTTPException(409, f"Un compte existe déjà avec {quoi}")


def lister(conn: psycopg.Connection, id_ecole: int) -> list[dict]:
    rows = conn.execute(
        f"SELECT {COLONNES} FROM utilisateur WHERE id_ecole = %s ORDER BY role, login", (id_ecole,)
    ).fetchall()
    return [_compte(r, _invitation(r[6])) for r in rows]


def inviter(conn: psycopg.Connection, id_ecole: int, c: CompteSaisie) -> dict:
    ecole = conn.execute("SELECT code_ecole, statut FROM ecole WHERE id_ecole = %s", (id_ecole,)).fetchone()
    if ecole is None:
        raise HTTPException(404, "École introuvable")
    if ecole[1] == "suspendue":
        raise HTTPException(409, "École suspendue : réactivez-la avant d'inviter des comptes")
    try:
        with conn.transaction():
            row = conn.execute(
                f"INSERT INTO utilisateur (login, email, role, id_ecole) VALUES (%s, %s, %s, %s) RETURNING {COLONNES}",
                (c.login.strip(), str(c.email).lower(), c.role, id_ecole),
            ).fetchone()
            # Invitation envoyée seulement si le compte a pu être créé ; si elle échoue, rien n'est gardé
            auth_id = supabase_admin.inviter(str(c.email).lower(), config.URL_CONSOLE,
                                             {"ecole": ecole[0], "role": c.role, "login": c.login})
            conn.execute("UPDATE utilisateur SET auth_id = %s WHERE id_utilisateur = %s", (auth_id, row[0]))
    except psycopg.errors.UniqueViolation as e:
        raise _doublon(e) from e
    except supabase_admin.ErreurSupabase as e:
        raise HTTPException(502, f"Invitation non envoyée : {e}") from e
    return _compte(row, "en_attente")


def _compte_d_ecole(conn: psycopg.Connection, id_utilisateur: int):
    row = conn.execute("SELECT email, auth_id, role FROM utilisateur WHERE id_utilisateur = %s",
                       (id_utilisateur,)).fetchone()
    if row is None or row[2] == "superadmin":
        raise HTTPException(404, "Compte introuvable")
    return row


def renvoyer(conn: psycopg.Connection, id_utilisateur: int) -> dict:
    """Renvoie l'invitation ; si le compte est déjà activé, envoie un lien de nouveau mot de passe."""
    email, auth_id, _role = _compte_d_ecole(conn, id_utilisateur)
    try:
        if auth_id is not None and supabase_admin.etat(str(auth_id)) == "acceptee":
            supabase_admin.reinitialiser(email, config.URL_CONSOLE)
            return {"envoi": "reinitialisation"}
        nouvel_id = supabase_admin.inviter(email, config.URL_CONSOLE)
    except supabase_admin.ErreurSupabase as e:
        raise HTTPException(502, f"E-mail non envoyé : {e}") from e
    conn.execute("UPDATE utilisateur SET auth_id = %s WHERE id_utilisateur = %s", (nouvel_id, id_utilisateur))
    return {"envoi": "invitation"}


def modifier(conn: psycopg.Connection, id_utilisateur: int, m: CompteModification) -> dict:
    """Active ou désactive un compte, change son e-mail, son login ou son rôle.

    Nouvelle adresse : si l'invitation est acceptée, l'adresse change aussi dans Supabase Auth
    (même mot de passe) ; sinon une nouvelle invitation part à la nouvelle adresse et l'ancien
    compte Auth, dont le lien visait l'ancienne adresse, est supprimé."""
    ancien_email, auth_id, _role = _compte_d_ecole(conn, id_utilisateur)
    champs = m.model_dump(exclude_none=True)
    if not champs:
        raise HTTPException(422, "Rien à modifier")
    if "email" in champs:
        champs["email"] = str(champs["email"]).lower()
        if champs["email"] == ancien_email:
            del champs["email"]
    if "login" in champs:
        champs["login"] = champs["login"].strip()

    envoi, auth_a_supprimer = None, None
    try:
        with conn.transaction():
            if champs:
                ensemble = ", ".join(f"{k} = %s" for k in champs)  # noms contrôlés par le modèle pydantic
                conn.execute(f"UPDATE utilisateur SET {ensemble} WHERE id_utilisateur = %s", (*champs.values(), id_utilisateur))
            row = conn.execute(f"SELECT {COLONNES} FROM utilisateur WHERE id_utilisateur = %s", (id_utilisateur,)).fetchone()
            if auth_id is not None and "email" in champs:
                if supabase_admin.etat(str(auth_id)) == "acceptee":
                    supabase_admin.changer_email(str(auth_id), champs["email"])
                else:
                    nouvel_id = supabase_admin.inviter(champs["email"], config.URL_CONSOLE,
                                                       {"role": row[3], "login": row[1]})
                    conn.execute("UPDATE utilisateur SET auth_id = %s WHERE id_utilisateur = %s", (nouvel_id, id_utilisateur))
                    auth_a_supprimer, auth_id, envoi = auth_id, nouvel_id, "invitation"
                    if not row[4]:
                        supabase_admin.bloquer(str(nouvel_id), True)
            if auth_id is not None and "est_actif" in champs:
                supabase_admin.bloquer(str(auth_id), not champs["est_actif"])
    except psycopg.errors.UniqueViolation as e:
        raise _doublon(e) from e
    except supabase_admin.ErreurSupabase as e:
        raise HTTPException(502, f"Supabase n'a pas pris en compte le changement : {e}") from e
    if auth_a_supprimer is not None:
        try:  # l'ancien compte Auth n'a jamais servi ; un échec ici ne bloque pas la modification
            supabase_admin.supprimer(str(auth_a_supprimer))
        except supabase_admin.ErreurSupabase:
            pass
    return _compte(row, _invitation(auth_id)) | {"envoi": envoi}


# --- routes de l'administrateur d'une école ------------------------------------------

def administrateur_courant(u: Utilisateur = Depends(utilisateur_courant)) -> Utilisateur:
    if u.role != "administrateur":
        raise HTTPException(403, "Seul un administrateur de l'école gère les comptes")
    return u


@routeur.get("/api/ecole/comptes")
def comptes_de_l_ecole(conn: psycopg.Connection = Depends(connexion),
                       u: Utilisateur = Depends(utilisateur_courant)) -> list[dict]:
    """Comptes de l'école et état de leur invitation (lecture pour tous les gestionnaires)."""
    return lister(conn, u.id_ecole)


@routeur.post("/api/ecole/comptes", status_code=201)
def inviter_dans_l_ecole(c: CompteSaisie, conn: psycopg.Connection = Depends(connexion),
                         u: Utilisateur = Depends(administrateur_courant)) -> dict:
    return inviter(conn, u.id_ecole, c)


@routeur.post("/api/ecole/comptes/{id_utilisateur}/inviter")
def renvoyer_dans_l_ecole(id_utilisateur: int, conn: psycopg.Connection = Depends(connexion),
                          _: Utilisateur = Depends(administrateur_courant)) -> dict:
    return renvoyer(conn, id_utilisateur)  # un compte d'une autre école est invisible (RLS) : 404


@routeur.patch("/api/ecole/comptes/{id_utilisateur}")
def modifier_dans_l_ecole(id_utilisateur: int, m: CompteModification, conn: psycopg.Connection = Depends(connexion),
                          u: Utilisateur = Depends(administrateur_courant)) -> dict:
    # Un administrateur ne se retire pas lui-même l'accès (l'école resterait sans administrateur)
    if id_utilisateur == u.id_utilisateur and (m.est_actif is False or m.role == "planificateur"):
        raise HTTPException(409, "Vous ne pouvez pas désactiver votre propre compte ni retirer votre rôle d'administrateur")
    return modifier(conn, id_utilisateur, m)
