"""Journal d'audit des séances (BNF-08)."""

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

ADMIN = {"X-Utilisateur": "2"}


@pytest.fixture
def client(base_generee):
    with psycopg.connect(config.DATABASE_URL) as c:
        id_sa = c.execute("INSERT INTO utilisateur (login, email, role, auth_id) VALUES ('sa-journal', 'sa-journal@exemple.org', "
                          "'superadmin', %s) RETURNING id_utilisateur", (str(uuid.uuid4()),)).fetchone()[0]
    t = TestClient(app)
    t.sa = {"X-Utilisateur": str(id_sa)}
    yield t
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("DELETE FROM utilisateur WHERE id_utilisateur = %s", (id_sa,))


def test_chaque_changement_de_seance_est_journalise(client):
    base = client.get("/api/base", headers=ADMIN).json()
    s = base["seance"][0]
    # Modification depuis la console : séance verrouillée
    r = client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": [{**s, "est_verrouillee": not s["est_verrouillee"]}]}}})
    assert r.status_code == 200
    m = client.get("/api/superadmin/journal", headers=client.sa, params={"id_ecole": 1, "limite": 5}).json()["lignes"][0]
    assert (m["action"], m["origine"], m["utilisateur"], m["id_seance"]) == ("modification", "console", "admin", s["id_seance"])
    assert m["changements"] == [{"champ": "verrouillage", "avant": s["est_verrouillee"], "apres": not s["est_verrouillee"]}]
    client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": [s]}}})
    # Suppression puis recréation (même identifiant)
    client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"supprimer": [{"id_seance": s["id_seance"]}]}}})
    client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": [s]}}})
    j = client.get("/api/superadmin/journal", headers=client.sa, params={"id_ecole": 1, "limite": 2}).json()
    assert [x["action"] for x in j["lignes"]] == ["creation", "suppression"]
    assert j["lignes"][1]["seance"]["debut"] == s["heure_debut"] and j["suivant"] is not None
    assert j["lignes"][0]["cours"].endswith(")") and j["lignes"][0]["classe"]
    # Filtres et pagination
    page2 = client.get("/api/superadmin/journal", headers=client.sa, params={"avant": j["suivant"], "limite": 2}).json()
    assert all(x["id_journal"] < j["lignes"][-1]["id_journal"] for x in page2["lignes"])
    assert all(x["action"] == "suppression" for x in client.get(
        "/api/superadmin/journal", headers=client.sa, params={"action": "suppression"}).json()["lignes"])


def test_le_journal_est_reserve_au_super_admin(client):
    assert client.get("/api/superadmin/journal", headers=ADMIN).status_code == 403
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("SET ROLE ultraplanning_app")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT count(*) FROM journal_seance")
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SET ROLE ultraplanning_app")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("DELETE FROM journal_seance")


def test_hors_api_l_origine_est_systeme(base_generee):
    with psycopg.connect(config.DATABASE_URL) as c:
        id_s = c.execute("SELECT max(id_seance) FROM seance").fetchone()[0]
        c.execute("UPDATE seance SET est_verrouillee = NOT est_verrouillee WHERE id_seance = %s", (id_s,))
        assert c.execute("SELECT action, origine, id_utilisateur FROM journal_seance ORDER BY id_journal DESC LIMIT 1").fetchone() \
            == ("modification", "systeme", None)
        c.execute("UPDATE seance SET est_verrouillee = NOT est_verrouillee WHERE id_seance = %s", (id_s,))
