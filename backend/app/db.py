from collections.abc import Iterator

import psycopg

from . import config


def connexion() -> Iterator[psycopg.Connection]:
    """Dépendance FastAPI : une connexion par requête, validée en fin de requête.

    La connexion part toujours du rôle propriétaire et sans école : le rôle et
    l'école d'une requête précédente ne peuvent pas passer à la suivante, même
    si le pooler de Supabase réutilise la connexion serveur."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL n'est pas défini")
    with psycopg.connect(config.DATABASE_URL) as conn:
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
