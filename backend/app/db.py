from collections.abc import Iterator

import logging

import psycopg
from fastapi import HTTPException

from . import config

journal = logging.getLogger("ultraplanning.db")


def connexion() -> Iterator[psycopg.Connection]:
    """Dépendance FastAPI : une connexion par requête, validée en fin de requête.

    La connexion part toujours du rôle propriétaire et sans école : le rôle et
    l'école d'une requête précédente ne peuvent pas passer à la suivante, même
    si le pooler de Supabase réutilise la connexion serveur."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL n'est pas défini")
    try:
        conn = psycopg.connect(config.DATABASE_URL, connect_timeout=10)
    except psycopg.OperationalError as e:
        # Réseau coupé, nom du serveur introuvable (DNS), base arrêtée... : message clair, pas une erreur 500
        journal.warning("base injoignable : %s", e)
        raise HTTPException(503, "Base de données injoignable : vérifiez la connexion internet du serveur, "
                                 "puis réessayez dans un instant.") from e
    with conn:
        conn.execute("RESET ROLE")
        conn.execute("SELECT set_config('app.id_ecole', '', false), set_config('app.id_utilisateur', '', false), "
                     "set_config('app.origine', '', false)")
        yield conn


def entrer_ecole(conn: psycopg.Connection, id_ecole: int, id_utilisateur: int | None = None) -> None:
    """La suite de la requête ne voit et n'écrit que les données de cette école :
    rôle ultraplanning_app, soumis à la RLS par école (schéma, section 7).
    Réglage de session (et non de transaction) : il survit au commit de l'assistant."""
    conn.execute("SELECT set_config('app.id_ecole', %s, false), set_config('app.id_utilisateur', %s, false)",
                 (str(id_ecole), str(id_utilisateur or "")))
    origine(conn, "console")
    conn.execute("SET ROLE ultraplanning_app")


def origine(conn: psycopg.Connection, nom: str) -> None:
    """Origine des changements de séances inscrite au journal d'audit : console, generation, assistant."""
    conn.execute("SELECT set_config('app.origine', %s, false)", (nom,))
