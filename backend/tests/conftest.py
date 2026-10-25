"""Les tests du backend tournent sur une base PostgreSQL chargée avec
schema_supabase.sql (DATABASE_URL). ATTENTION : ils vident et régénèrent les
séances, propositions et discussions ; ne jamais les lancer en production."""

import os
from datetime import timedelta

import psycopg
import pytest

from ultraplanning_solver import Demande, Perimetre, generer
from ultraplanning_solver.base import charger, enregistrer

DSN = os.environ.get("DATABASE_URL")
# Les tests s'identifient par l'en-tête X-Utilisateur (connexion de développement)
os.environ.setdefault("ULTRAPLANNING_AUTH_DEV", "1")
if DSN and "supabase" in DSN:
    raise pytest.UsageError("Les tests vident la base : refus de les lancer sur Supabase (DATABASE_URL).")


def pytest_collection_modifyitems(config, items):
    if not DSN:
        saut = pytest.mark.skip(reason="DATABASE_URL non défini")
        for item in items:
            item.add_marker(saut)


@pytest.fixture(scope="session")
def base_generee():
    """Remplit l'emploi du temps 1 (brouillon) avec le solveur, une seule fois."""
    with psycopg.connect(DSN) as conn:
        conn.execute("DELETE FROM proposition; DELETE FROM prompt; DELETE FROM conversation; DELETE FROM seance")
        conn.execute("UPDATE emploi_du_temps SET statut = 'brouillon' WHERE id_edt = 1")
        d = charger(conn, 1)
        # Un mois suffit aux tests et reste rapide
        r = generer(d, Demande(du=d.semestre_debut, au=d.semestre_debut + timedelta(days=26),
                               temps_max_placement=3))
        enregistrer(conn, 1, r)
    return True


@pytest.fixture
def conn(base_generee):
    """Connexion comme celle de l'API pour un compte de 2iE : rôle ultraplanning_app,
    école 1 (la RLS filtre tout). Rien n'est gardé : annulée en fin de test."""
    with psycopg.connect(DSN) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("SET ROLE ultraplanning_app")
        yield c
        c.rollback()


def supprimer_ecoles(motif: str) -> None:
    """Efface les écoles de test (code LIKE motif) et toutes leurs données."""
    from app.base_api import TABLES
    with psycopg.connect(DSN) as c:
        ids = [r[0] for r in c.execute("SELECT id_ecole FROM ecole WHERE code_ecole LIKE %s", (motif,))]
        if not ids:
            return
        for t in reversed(TABLES):
            c.execute(f"DELETE FROM {t} WHERE id_ecole = ANY(%s)", (ids,))
        c.execute("DELETE FROM ecole WHERE id_ecole = ANY(%s)", (ids,))
