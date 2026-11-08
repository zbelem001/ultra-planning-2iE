import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from fastapi import HTTPException
from psycopg.pq import TransactionStatus

from . import config

journal = logging.getLogger("ultraplanning.db")

# Base injoignable (réseau coupé, port 5432 filtré...) : chaque essai de connexion attend
# l'expiration du délai, pour chaque adresse du serveur. Après un échec, les requêtes suivantes
# reçoivent le 503 tout de suite pendant ce délai, au lieu d'occuper chacune un fil de l'API.
PAUSE_APRES_ECHEC = 15.0
_injoignable_jusqua: dict[str, float] = {}

# Ouvrir une connexion coûte plus d'une seconde sur un réseau lent : celles qui viennent de servir
# sont gardées un moment. Chacune repart de zéro à chaque emprunt (rôle, école, origine).
RESERVE_MAX = 4
INACTIVITE_MAX = 120.0
_reserve: list[tuple[str, float, psycopg.Connection]] = []
_verrou = threading.Lock()
_REMISE_A_ZERO = ("SELECT set_config('app.id_ecole', '', false), set_config('app.id_utilisateur', '', false), "
                  "set_config('app.origine', '', false), set_config('app.note', '', false)")


def _fermer(conn: psycopg.Connection) -> None:
    try:
        conn.close()
    except psycopg.Error:
        pass


def _prendre(url: str) -> psycopg.Connection | None:
    """La connexion la plus récente de la réserve ; celles restées trop longtemps sans servir sont fermées."""
    perimees, trouvee = [], None
    with _verrou:
        for entree in list(_reserve):
            if time.monotonic() - entree[1] > INACTIVITE_MAX:
                _reserve.remove(entree)
                perimees.append(entree[2])
        for entree in reversed(_reserve):
            if entree[0] == url:
                _reserve.remove(entree)
                trouvee = entree[2]
                break
    for c in perimees:
        _fermer(c)
    return trouvee


def _rendre(url: str, conn: psycopg.Connection) -> None:
    if not (conn.closed or conn.broken) and conn.info.transaction_status == TransactionStatus.IDLE:
        with _verrou:
            if len(_reserve) < RESERVE_MAX:
                _reserve.append((url, time.monotonic(), conn))
                return
    _fermer(conn)


def _remettre_a_zero(conn: psycopg.Connection) -> None:
    with conn.pipeline():  # tout part ensemble, début de transaction compris : un seul aller-retour
        conn.execute("RESET ROLE")
        conn.execute(_REMISE_A_ZERO)


def _emprunter(url: str) -> psycopg.Connection:
    message = ("Base de données injoignable : vérifiez la connexion internet du serveur (un réseau qui filtre "
               "le port 5432 bloque aussi Supabase), puis réessayez dans un instant.")
    if time.monotonic() < _injoignable_jusqua.get(url, 0):
        raise HTTPException(503, message)
    while (conn := _prendre(url)) is not None:
        try:
            _remettre_a_zero(conn)
            return conn
        except psycopg.OperationalError:  # liaison coupée pendant qu'elle attendait
            _fermer(conn)
    try:
        # tcp_user_timeout : une liaison coupée échoue en quelques secondes au lieu de bloquer le fil
        conn = psycopg.connect(url, connect_timeout=5, tcp_user_timeout=8000, prepare_threshold=None)
    except psycopg.OperationalError as e:
        # Réseau coupé, nom du serveur introuvable (DNS), base arrêtée... : message clair, pas une erreur 500
        journal.warning("base injoignable : %s", e)
        _injoignable_jusqua[url] = time.monotonic() + PAUSE_APRES_ECHEC
        raise HTTPException(503, message) from e
    _injoignable_jusqua.pop(url, None)
    _remettre_a_zero(conn)
    return conn


@contextmanager
def ouvrir() -> Iterator[psycopg.Connection]:
    """Une connexion validée à la fin, annulée en cas d'erreur.

    Elle part toujours du rôle propriétaire et sans école : le rôle et l'école d'un usage précédent
    ne peuvent pas passer au suivant."""
    if not config.DATABASE_URL:
        raise RuntimeError("DATABASE_URL n'est pas défini")
    url = config.DATABASE_URL
    conn = _emprunter(url)
    try:
        yield conn
        conn.commit()
    except BaseException:
        try:
            conn.rollback()
        except psycopg.Error:
            _fermer(conn)
        raise
    finally:
        _rendre(url, conn)


def connexion() -> Iterator[psycopg.Connection]:
    """Dépendance FastAPI : une connexion par requête, validée en fin de requête."""
    with ouvrir() as conn:
        yield conn


def entrer_ecole(conn: psycopg.Connection, id_ecole: int, id_utilisateur: int | None = None) -> None:
    """La suite de la requête ne voit et n'écrit que les données de cette école :
    rôle ultraplanning_app, soumis à la RLS par école (schéma, section 7).
    Réglage de session (et non de transaction) : il survit au commit de l'assistant."""
    conn.execute("SELECT set_config('app.id_ecole', %s, false), set_config('app.id_utilisateur', %s, false), "
                 "set_config('app.origine', 'console', false), set_config('role', 'ultraplanning_app', false)",
                 (str(id_ecole), str(id_utilisateur or "")))


def mutualisations_publiees(conn: psycopg.Connection) -> bool:
    """Base en version 15 ou plus : les mutualisations ont leur copie publiée (COURS_PUBLIC_PUBLIE). Avant, les
    invités lisent COURS_PUBLIC directement."""
    return conn.execute("SELECT to_regclass('public.cours_public_publie') IS NOT NULL").fetchone()[0]


def origine(conn: psycopg.Connection, nom: str) -> None:
    """Origine des changements de séances inscrite au journal d'audit : console, generation, assistant."""
    conn.execute("SELECT set_config('app.origine', %s, false)", (nom,))
