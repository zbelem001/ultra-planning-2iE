"""Image de la base pour le frontend, et synchronisation de ses modifications.

Le frontend manipule la base comme un objet { table: lignes[] } (types/db.ts).
- GET /api/base : tout, pour la console (gestionnaires connectés) ;
- GET /api/base/public?ecole=CODE : ce que voit un invité de cette école ;
- POST /api/base/sync : ajouts, modifications et suppressions faits dans
  l'interface, appliqués dans une transaction. Les déclencheurs de la base
  revalident chaque ligne (CD-01 à CD-14, programme, habilitations...) : une
  modification refusée renvoie 409 avec le motif, et rien n'est écrit.

Les noms de tables et de colonnes sont contrôlés à partir du catalogue de la
base (jamais pris tels quels de la requête).

Chaque requête ne voit que l'école du compte (ou, pour un invité, l'école
demandée) : la RLS du rôle ultraplanning_app filtre toutes les lectures et
refuse toute écriture dans une autre école.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from psycopg import sql
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from . import config
from .auth import ROLES_GESTION, Utilisateur, utilisateur_courant
from .db import connexion, entrer_ecole

routeur = APIRouter()

# Ordre compatible avec les clés étrangères (on supprime dans l'ordre inverse)
TABLES = [
    "site", "type_salle", "filiere", "classe", "groupe", "matiere", "enseignant", "habilitation",
    "absence_enseignant", "sejour_enseignant", "creneau", "pause", "jour_ferie", "conge", "salle",
    "semestre", "utilisateur", "programme", "cours", "cours_seance_modele", "disponibilite",
    "emploi_du_temps", "contrainte", "conversation", "prompt", "proposition", "seance",
]
CLES = {
    "jour_ferie": ["id_ecole", "date_ferie"],
    "cours_seance_modele": ["id_cours", "rang"],
    "disponibilite": ["id_enseignant", "id_creneau"],
    "absence_enseignant": ["id_absence"],
    "sejour_enseignant": ["id_sejour"],
    "type_salle": ["id_type_salle"],
    "emploi_du_temps": ["id_edt"],
}
PUBLIQUES = {"site", "type_salle", "filiere", "classe", "groupe", "matiere", "creneau", "pause", "jour_ferie",
             "conge", "salle", "semestre", "programme", "cours", "cours_seance_modele"}


def cle(table: str) -> list[str]:
    return CLES.get(table, [f"id_{table}"])


def _json(v: Any) -> Any:
    if isinstance(v, time):
        return v.strftime("%H:%M")
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return int(v) if v == int(v) else float(v)
    return v


def _colonnes(conn: psycopg.Connection) -> dict[str, list[str]]:
    """Colonnes modifiables de chaque table (hors colonnes calculées)."""
    rows = conn.execute(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND is_generated = 'NEVER' ORDER BY table_name, ordinal_position"
    ).fetchall()
    out: dict[str, list[str]] = {}
    for t, c in rows:
        out.setdefault(t, []).append(c)
    return out


def _lire(conn: psycopg.Connection, table: str, colonnes: list[str], ou: sql.Composable | None = None, params=()) -> list[dict]:
    requete = sql.SQL("SELECT {} FROM {}").format(sql.SQL(", ").join(map(sql.Identifier, colonnes)), sql.Identifier(table))
    if ou is not None:
        requete += sql.SQL(" WHERE ") + ou
    requete += sql.SQL(" ORDER BY ") + sql.SQL(", ").join(map(sql.Identifier, cle(table)))
    cur = conn.execute(requete, params)
    return [dict(zip(colonnes, map(_json, r))) for r in cur.fetchall()]


@routeur.get("/api/base")
def base_complete(conn: psycopg.Connection = Depends(connexion), u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    cols = _colonnes(conn)
    out = {t: _lire(conn, t, cols[t]) for t in TABLES if t != "utilisateur"}
    # Seulement les comptes de l'école, sans mot de passe ni lien d'authentification
    out["utilisateur"] = [
        {**x, "mot_de_passe": None, "auth_id": None}
        for x in _lire(conn, "utilisateur", cols["utilisateur"], sql.SQL("id_ecole = %s"), (u.id_ecole,))
    ]
    return {t: out[t] for t in TABLES} | {"ecole": _ecole_courante(conn)}


def _ecole_publique(conn: psycopg.Connection, code: str | None) -> int:
    """École consultée par un invité : celle du code, ou la seule école active."""
    rows = conn.execute(
        "SELECT id_ecole FROM ecole WHERE statut = 'active' AND (%s::text IS NULL OR code_ecole = upper(%s))",
        (code, code),
    ).fetchall()
    if code is not None and not rows:
        raise HTTPException(404, f"École {code} inconnue")
    if len(rows) != 1:
        raise HTTPException(422, "Précisez l'école consultée (paramètre ecole, par exemple ?ecole=2IE)")
    return rows[0][0]


@routeur.get("/api/ecoles")
def ecoles_publiques(conn: psycopg.Connection = Depends(connexion)) -> list[dict]:
    """Écoles actives, pour que l'espace invités propose de choisir la sienne."""
    rows = conn.execute("SELECT code_ecole, nom, ville FROM ecole WHERE statut = 'active' ORDER BY nom").fetchall()
    return [{"code_ecole": r[0], "nom": r[1], "ville": r[2]} for r in rows]


@routeur.get("/api/base/public")
def base_publique(request: Request, ecole: str | None = None, conn: psycopg.Connection = Depends(connexion)) -> Response:
    """Ce que voit un invité d'une école : référentiel, version publiée, enseignants sans coordonnées.

    Économe en données : JSON compact, compressé (GZipMiddleware), et étiquette ETag. Le navigateur
    la renvoie à la visite suivante ; tant que rien n'a été publié ou modifié, la réponse est un
    304 vide et il réutilise sa copie."""
    contenu = json.dumps(_image_publique(conn, ecole), ensure_ascii=False, separators=(",", ":")).encode()
    etiquette = '"' + hashlib.sha256(contenu).hexdigest()[:20] + '"'
    entetes = {"ETag": etiquette, "Cache-Control": "no-cache"}  # toujours revalider, jamais tout retélécharger
    if etiquette in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers=entetes)
    return Response(contenu, media_type="application/json", headers=entetes)


def _image_publique(conn: psycopg.Connection, ecole: str | None) -> dict:
    entrer_ecole(conn, _ecole_publique(conn, ecole))
    cols = _colonnes(conn)
    out: dict[str, list] = {t: (_lire(conn, t, cols[t]) if t in PUBLIQUES else []) for t in TABLES}
    out["enseignant"] = [
        {**e, "email": None, "telephone": None, "nb_heures_max_semaine": None}
        for e in _lire(conn, "enseignant", cols["enseignant"])
    ]
    out["emploi_du_temps"] = _lire(conn, "emploi_du_temps", cols["emploi_du_temps"], sql.SQL("statut = 'publie'"))
    out["seance"] = _lire(
        conn, "seance", cols["seance"],
        sql.SQL("id_edt IN (SELECT id_edt FROM emploi_du_temps WHERE statut = 'publie')"),
    )
    out["ecole"] = _ecole_courante(conn)
    return out


def _ecole_courante(conn: psycopg.Connection) -> list[dict]:
    """L'école de la requête (la RLS ne montre qu'elle), pour l'en-tête des consoles."""
    rows = conn.execute("SELECT id_ecole, code_ecole, nom, ville, pays FROM ecole").fetchall()
    return [dict(zip(("id_ecole", "code_ecole", "nom", "ville", "pays"), r)) for r in rows]


@routeur.get("/api/comptes")
def comptes(console: Literal["ecole", "superadmin"] = "ecole", conn: psycopg.Connection = Depends(connexion)) -> list[dict]:
    """Comptes actifs de la console demandée, pour l'écran de connexion de développement
    (ULTRAPLANNING_AUTH_DEV=1)."""
    if not config.AUTH_DEV:
        raise HTTPException(404, "Connexion de développement désactivée")
    roles = ["superadmin"] if console == "superadmin" else sorted(ROLES_GESTION)
    rows = conn.execute(
        "SELECT id_utilisateur, login, role FROM utilisateur WHERE role = ANY(%s) AND est_actif ORDER BY 1", (roles,)
    ).fetchall()
    return [{"id_utilisateur": r[0], "login": r[1], "role": r[2]} for r in rows]


class Changements(BaseModel):
    upsert: list[dict] = []
    supprimer: list[dict] = []


class Synchronisation(BaseModel):
    tables: dict[str, Changements]


def _valeur(v: Any) -> Any:
    return Jsonb(v) if isinstance(v, (dict, list)) else v


@routeur.post("/api/base/sync")
def synchroniser(s: Synchronisation, conn: psycopg.Connection = Depends(connexion),
                 u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    inconnues = set(s.tables) - set(TABLES)
    if inconnues:
        raise HTTPException(422, f"Tables inconnues : {', '.join(sorted(inconnues))}")
    if "utilisateur" in s.tables:
        # Un compte ne se crée que par invitation (app/comptes.py, page Utilisateurs)
        raise HTTPException(403, "Les comptes se gèrent par invitation, dans la page Utilisateurs")
    cols = _colonnes(conn)
    references = _references(conn)
    identites = {
        t for (t,) in conn.execute(
            "SELECT DISTINCT table_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND is_identity = 'YES'"
        ).fetchall()
    }
    compte = {"upsert": 0, "supprimer": 0}
    # Identifiants pris par une autre école : la ligne reçoit un nouvel identifiant,
    # reporté dans les lignes suivantes qui la désignent (ancien -> nouveau)
    renumerotes: dict[str, dict] = defaultdict(dict)
    try:
        with conn.transaction():
            for t in reversed(TABLES):
                for k in s.tables.get(t, Changements()).supprimer:
                    pk = [c for c in cle(t) if c != "id_ecole"]  # l'école est celle du compte (RLS)
                    conn.execute(
                        sql.SQL("DELETE FROM {} WHERE ").format(sql.Identifier(t))
                        + sql.SQL(" AND ").join(sql.SQL("{} = %s").format(sql.Identifier(c)) for c in pk),
                        [k[c] for c in pk],
                    )
                    compte["supprimer"] += 1
            for t in TABLES:
                for ligne in s.tables.get(t, Changements()).upsert:
                    for col, ref in references.get(t, []):
                        if ligne.get(col) in renumerotes[ref]:
                            ligne[col] = renumerotes[ref][ligne[col]]
                    ligne["id_ecole"] = u.id_ecole
                    champs = [c for c in cols[t] if c in ligne]
                    pk = cle(t)
                    if t in identites and _identifiant_d_une_autre_ecole(conn, t, pk[0], ligne.get(pk[0])):
                        sans_id = [c for c in champs if c != pk[0]]
                        nouveau = conn.execute(
                            sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING {}").format(
                                sql.Identifier(t), sql.SQL(", ").join(map(sql.Identifier, sans_id)),
                                sql.SQL(", ").join(sql.Placeholder() for _ in sans_id), sql.Identifier(pk[0])),
                            [_valeur(ligne[c]) for c in sans_id],
                        ).fetchone()[0]
                        renumerotes[t][ligne[pk[0]]] = nouveau
                        compte["upsert"] += 1
                        continue
                    maj = [c for c in champs if c not in pk]
                    requete = sql.SQL("INSERT INTO {} ({}) {} VALUES ({}) ON CONFLICT ({}) ").format(
                        sql.Identifier(t),
                        sql.SQL(", ").join(map(sql.Identifier, champs)),
                        sql.SQL("OVERRIDING SYSTEM VALUE") if t in identites else sql.SQL(""),
                        sql.SQL(", ").join(sql.Placeholder() for _ in champs),
                        sql.SQL(", ").join(map(sql.Identifier, pk)),
                    )
                    requete += (
                        sql.SQL("DO UPDATE SET ") + sql.SQL(", ").join(
                            sql.SQL("{0} = EXCLUDED.{0}").format(sql.Identifier(c)) for c in maj)
                        if maj else sql.SQL("DO NOTHING")
                    )
                    conn.execute(requete, [_valeur(ligne[c]) for c in champs])
                    compte["upsert"] += 1
            # Les identifiants viennent du frontend : on avance les séquences IDENTITY au-delà
            # (sans jamais les faire reculer : max() ne voit que l'école du compte)
            for t in identites & set(s.tables):
                pk = cle(t)[0]
                conn.execute(
                    sql.SQL("SELECT setval(seq, GREATEST(nextval(seq), (SELECT coalesce(max({}), 1) FROM {}))) "
                            "FROM pg_get_serial_sequence({}, {}) AS seq").format(
                        sql.Identifier(pk), sql.Identifier(t), sql.Literal(t), sql.Literal(pk))
                )
    except (psycopg.errors.CheckViolation, psycopg.errors.ExclusionViolation, psycopg.errors.UniqueViolation,
            psycopg.errors.ForeignKeyViolation, psycopg.errors.NotNullViolation) as e:
        raise HTTPException(409, e.diag.message_primary or str(e)) from e
    except psycopg.errors.InsufficientPrivilege as e:
        raise HTTPException(403, "Modification refusée : ces données n'appartiennent pas à votre école") from e
    except (psycopg.errors.DataError, psycopg.errors.InvalidTextRepresentation) as e:
        raise HTTPException(422, e.diag.message_primary or str(e)) from e
    return compte | {"identifiants": {t: {str(a): n for a, n in m.items()} for t, m in renumerotes.items() if m}}


def _references(conn: psycopg.Connection) -> dict[str, list[tuple[str, str]]]:
    """Pour chaque table, ses colonnes qui désignent l'identifiant d'une autre table."""
    rows = conn.execute(
        """SELECT c.conrelid::regclass::text, a.attname, c.confrelid::regclass::text, ra.attname
           FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(num, refnum)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
           JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refnum
           WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND a.attname <> 'id_ecole'"""
    ).fetchall()
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for t, col, ref, refcol in rows:
        if ref in TABLES and cle(ref) == [refcol]:
            out[t].append((col, ref))
    return out


def _identifiant_d_une_autre_ecole(conn: psycopg.Connection, table: str, pk: str, valeur: Any) -> bool:
    """Le frontend numérote ses nouvelles lignes d'après ce qu'il voit : l'identifiant
    peut déjà appartenir à une autre école (ligne invisible pour ce compte)."""
    if valeur is None:
        return False
    visible = conn.execute(
        sql.SQL("SELECT 1 FROM {} WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(pk)), (valeur,)
    ).fetchone()
    if visible:
        return False
    return conn.execute("SELECT identifiant_pris(%s, %s)", (table, valeur)).fetchone()[0]


# --- démarrage d'une nouvelle école ------------------------------------------------

class Demarrage(BaseModel):
    libelle: str = Field("Semestre 1", min_length=1, max_length=60)
    annee_academique: str = Field(min_length=4, max_length=20)
    date_debut: date
    date_fin: date


@routeur.post("/api/demarrage", status_code=201)
def demarrer(d: Demarrage, conn: psycopg.Connection = Depends(connexion),
             u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    """Premier semestre et premier emploi du temps (avec ses contraintes) d'une école
    qui n'en a pas encore : la console en a besoin pour s'ouvrir."""
    if conn.execute("SELECT 1 FROM emploi_du_temps LIMIT 1").fetchone():
        raise HTTPException(409, "Cette école a déjà un emploi du temps")
    if d.date_fin <= d.date_debut:
        raise HTTPException(422, "La fin du semestre doit suivre son début")
    id_semestre = conn.execute(
        "INSERT INTO semestre (libelle, annee_academique, date_debut, date_fin) VALUES (%s, %s, %s, %s) "
        "RETURNING id_semestre", (d.libelle.strip(), d.annee_academique.strip(), d.date_debut, d.date_fin),
    ).fetchone()[0]
    id_edt = conn.execute(
        "INSERT INTO emploi_du_temps (libelle, id_semestre, id_utilisateur) VALUES (%s, %s, %s) RETURNING id_edt",
        (f"EDT {d.libelle.strip()} {d.annee_academique.strip()}", id_semestre, u.id_utilisateur),
    ).fetchone()[0]
    conn.execute("SELECT contraintes_par_defaut(%s)", (id_edt,))
    return {"id_semestre": id_semestre, "id_edt": id_edt}
