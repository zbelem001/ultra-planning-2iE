"""Les tests du backend tournent sur une base PostgreSQL chargée avec
schema_supabase.sql (DATABASE_URL). ATTENTION : ils vident et régénèrent les
séances, propositions et discussions ; ne jamais les lancer en production."""

import os
from datetime import date, timedelta

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


@pytest.fixture(autouse=True)
def aujourdhui_fixe(monkeypatch):
    """Les dates des tests sont fixes : « aujourd'hui » aussi, sinon leur résultat dépend du jour où ils tournent
    (l'assistant ne programme jamais dans le passé)."""
    class Jour(date):
        @classmethod
        def today(cls):
            return date(2026, 11, 1)
    monkeypatch.setattr("app.outils.date", Jour)


@pytest.fixture(autouse=True)
def pas_d_envoi_reel(monkeypatch):
    """Aucun test n'envoie de vrai e-mail, même si backend/.env configure un serveur SMTP."""
    from app import publication
    monkeypatch.setattr(publication, "planifier", lambda messages: None)


_COLONNES_SEANCE = ("id_seance, date_seance, heure_debut, heure_fin, statut, est_verrouillee, id_cours, id_enseignant, "
                    "id_salle, id_creneau, id_edt, id_ecole")


@pytest.fixture
def edt_a_remettre(base_generee):
    """Pour un test qui écrit par l'API : remet ensuite l'emploi du temps 1 comme avant (ses séances, son
    statut), sans version publiée ni publication."""
    with psycopg.connect(DSN) as c:
        seances = c.execute(f"SELECT {_COLONNES_SEANCE} FROM seance WHERE id_edt = 1").fetchall()
    yield
    with psycopg.connect(DSN) as c:
        c.execute("DELETE FROM publication_edt; DELETE FROM proposition; DELETE FROM seance WHERE id_edt <> 1; "
                  "DELETE FROM contrainte WHERE id_edt <> 1")
        c.execute("DELETE FROM emploi_du_temps WHERE id_edt <> 1")
        c.execute("UPDATE emploi_du_temps SET statut = 'brouillon', date_publication = NULL WHERE id_edt = 1")
        c.execute("ALTER TABLE seance DISABLE TRIGGER trg_verifier_seance")
        c.execute("DELETE FROM seance WHERE id_edt = 1")
        with c.cursor() as cur:
            cur.executemany(f"INSERT INTO seance ({_COLONNES_SEANCE}) OVERRIDING SYSTEM VALUE "
                            f"VALUES ({', '.join(['%s'] * 12)})", seances)
        c.execute("ALTER TABLE seance ENABLE TRIGGER trg_verifier_seance")


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
