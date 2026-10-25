"""L'administrateur d'une école invite et gère lui-même les comptes de son école."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

from .test_superadmin_api import supa  # noqa: F401  (faux Supabase Auth)

ADMIN, PLANIF = {"X-Utilisateur": "2"}, {"X-Utilisateur": "1"}


@pytest.fixture
def client(base_generee):
    yield TestClient(app)
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("DELETE FROM utilisateur WHERE email LIKE '%@test-comptes.org'")


def test_l_administrateur_invite_un_planificateur(client, supa):  # noqa: F811
    r = client.post("/api/ecole/comptes", headers=ADMIN, json={"email": "Nouveau@test-comptes.org", "login": "scolarite2", "role": "planificateur"})
    assert r.status_code == 201 and r.json()["invitation"] == "en_attente"
    assert supa.invitations[-1] == ("nouveau@test-comptes.org", config.URL_CONSOLE)
    id_nouveau = r.json()["id_utilisateur"]
    with psycopg.connect(config.DATABASE_URL) as c:
        assert c.execute("SELECT id_ecole, auth_id IS NOT NULL FROM utilisateur WHERE id_utilisateur = %s", (id_nouveau,)).fetchone() == (1, True)
    # Liste (visible de tous les gestionnaires), renvoi, modification, désactivation
    assert any(c["id_utilisateur"] == id_nouveau for c in client.get("/api/ecole/comptes", headers=PLANIF).json())
    assert client.post(f"/api/ecole/comptes/{id_nouveau}/inviter", headers=ADMIN).json() == {"envoi": "invitation"}
    r = client.patch(f"/api/ecole/comptes/{id_nouveau}", headers=ADMIN, json={"email": "autre@test-comptes.org"})
    assert r.status_code == 200 and r.json()["envoi"] == "invitation"
    assert client.patch(f"/api/ecole/comptes/{id_nouveau}", headers=ADMIN, json={"est_actif": False}).json()["est_actif"] is False
    # Doublon d'e-mail refusé
    assert client.post("/api/ecole/comptes", headers=ADMIN, json={"email": "autre@test-comptes.org", "login": "zz"}).status_code == 409


def test_seul_l_administrateur_gere_les_comptes(client, supa):  # noqa: F811
    assert client.post("/api/ecole/comptes", headers=PLANIF, json={"email": "p@test-comptes.org", "login": "pp"}).status_code == 403
    assert client.patch("/api/ecole/comptes/1", headers=PLANIF, json={"login": "x"}).status_code == 403
    # L'administrateur ne se retire pas lui-même l'accès
    assert client.patch("/api/ecole/comptes/2", headers=ADMIN, json={"est_actif": False}).status_code == 409
    assert client.patch("/api/ecole/comptes/2", headers=ADMIN, json={"role": "planificateur"}).status_code == 409
