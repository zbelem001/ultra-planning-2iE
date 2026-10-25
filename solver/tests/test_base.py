"""Tests d'intégration sur une base PostgreSQL chargée avec schema_supabase.sql.

Lancés seulement si DATABASE_URL est défini. ATTENTION : ils vident la table
seance de cette base ; ne jamais les lancer sur une base de production.
"""

import os
from datetime import date, time

import psycopg
import pytest

from ultraplanning_solver import Demande, Perimetre, generer
from ultraplanning_solver.base import charger, enregistrer, verifier
from ultraplanning_solver.donnees import Seance

from .jeu import violations

DSN = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL non défini")


@pytest.fixture
def conn():
    with psycopg.connect(DSN) as c:
        c.execute("DELETE FROM seance")
        c.commit()
        yield c


def test_generation_du_semestre_acceptee_par_la_base(conn):
    d = charger(conn, 1)
    r = generer(d, Demande(temps_max_placement=5))
    assert violations(d, r.seances) == []
    assert r.heures_placees == r.statistiques["heures_demandees"]
    # Le déclencheur de la base revalide chaque séance (CD-01 à CD-14)
    assert enregistrer(conn, 1, r) == len(r.seances)
    n = conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0]
    assert n == len(r.seances)


def test_perimetre_une_filiere(conn):
    d = charger(conn, 1)
    ia = conn.execute("SELECT id_filiere FROM filiere WHERE code_filiere = 'IA'").fetchone()[0]
    r = generer(d, Demande(perimetre=Perimetre(id_filieres=frozenset({ia})), temps_max_placement=5))
    assert r.seances and all(d.classes[d.cours[s.id_cours].id_classe].id_filiere == ia for s in r.seances)
    enregistrer(conn, 1, r)


def test_verifier_renvoie_le_motif_de_la_base(conn):
    d = charger(conn, 1)
    # L'Algorithmique de L2 confiée à Ouédraogo, lundi 8 h : il est indisponible (CD-06)
    s = Seance(1, date(2026, 10, 19), time(8), time(10), 1)
    assert "CD-06" in verifier(conn, 1, s)
    # Le même cours le mardi à 8 h est accepté, et rien n'est écrit
    assert verifier(conn, 1, Seance(1, date(2026, 10, 20), time(8), time(10), 1)) is None
    assert conn.execute("SELECT count(*) FROM seance").fetchone()[0] == 0
    assert d.cours[1].type_cours == "CM"
