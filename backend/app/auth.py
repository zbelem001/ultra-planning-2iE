"""Identification du compte connecté.

Production : jeton JWT de Supabase Auth (en-tête Authorization: Bearer …),
vérifié avec les clés publiques du projet (JWKS) ; le compte est retrouvé par
utilisateur.auth_id. Développement (ULTRAPLANNING_AUTH_DEV=1) : l'en-tête
X-Utilisateur donne directement l'identifiant du compte.

Un compte désactivé, ou d'une école suspendue, est refusé. Pour un compte
d'école, la suite de la requête est cantonnée à son école (db.entrer_ecole).
"""

from dataclasses import dataclass
from functools import lru_cache

import jwt
import psycopg
from fastapi import Depends, Header, HTTPException

from . import config
from .db import connexion, entrer_ecole

ROLES_GESTION = {"administrateur", "planificateur"}


@dataclass(frozen=True)
class Utilisateur:
    id_utilisateur: int
    login: str
    role: str
    id_ecole: int | None = None


@lru_cache(maxsize=1)
def _jwks() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(config.SUPABASE_JWKS_URL, cache_keys=True, lifespan=3600)


def verifier_jeton(jeton: str) -> str:
    """Vérifie un jeton de Supabase Auth et renvoie l'identifiant du compte (claim sub)."""
    if not config.SUPABASE_JWKS_URL:
        raise HTTPException(503, "Supabase Auth n'est pas configuré (SUPABASE_URL)")
    try:
        cle = _jwks().get_signing_key_from_jwt(jeton)
        claims = jwt.decode(
            jeton, cle.key, algorithms=["ES256", "RS256"], audience="authenticated",
            issuer=f"{config.SUPABASE_URL}/auth/v1",
        )
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(401, "Session expirée : reconnectez-vous") from e
    except (jwt.PyJWTError, jwt.PyJWKClientError) as e:
        raise HTTPException(401, "Jeton invalide") from e
    return claims["sub"]


def compte_courant(
    authorization: str | None = Header(default=None),
    x_utilisateur: int | None = Header(default=None),
    conn: psycopg.Connection = Depends(connexion),
) -> Utilisateur:
    """Compte connecté, quel que soit son rôle."""
    colonnes = ("SELECT u.id_utilisateur, u.login, u.role, u.id_ecole, u.est_actif, e.statut "
                "FROM utilisateur u LEFT JOIN ecole e USING (id_ecole) WHERE ")
    if authorization and authorization.lower().startswith("bearer "):
        row = conn.execute(colonnes + "u.auth_id = %s", (verifier_jeton(authorization[7:].strip()),)).fetchone()
    elif config.AUTH_DEV and x_utilisateur is not None:
        row = conn.execute(colonnes + "u.id_utilisateur = %s", (x_utilisateur,)).fetchone()
    else:
        raise HTTPException(401, "Authentification requise")
    if row is None:
        raise HTTPException(401, "Aucun compte UltraPlanning n'est associé à cette connexion")
    if not row[4]:
        raise HTTPException(403, "Compte désactivé")
    if row[5] == "suspendue":
        raise HTTPException(403, "L'accès de votre école est suspendu")
    return Utilisateur(*row[:4])


def utilisateur_courant(u: Utilisateur = Depends(compte_courant),
                        conn: psycopg.Connection = Depends(connexion)) -> Utilisateur:
    """Gestionnaire d'une école (administrateur ou planificateur). La connexion de la
    requête (la même que celle de la route) ne voit plus que son école."""
    if u.role not in ROLES_GESTION:
        raise HTTPException(403, "Accès réservé aux administrateurs et planificateurs")
    entrer_ecole(conn, u.id_ecole, u.id_utilisateur)
    return u


def superadmin_courant(u: Utilisateur = Depends(compte_courant)) -> Utilisateur:
    if u.role != "superadmin":
        raise HTTPException(403, "Accès réservé au super administrateur")
    return u
