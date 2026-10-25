"""Isolation entre écoles : chaque compte ne voit et ne modifie que son école,
par l'API comme directement dans la base (RLS du rôle ultraplanning_app)."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

from .conftest import supprimer_ecoles

ADMIN_2IE = {"X-Utilisateur": "2"}


@pytest.fixture
def ecole_b(base_generee):
    """Une deuxième école, avec un administrateur et quelques données, créée en propriétaire."""
    supprimer_ecoles("T-B")
    with psycopg.connect(config.DATABASE_URL) as c:
        b = c.execute("INSERT INTO ecole (code_ecole, nom) VALUES ('T-B', 'École B') RETURNING id_ecole").fetchone()[0]
        c.execute("SELECT initialiser_ecole(%s)", (b,))
        admin = c.execute("INSERT INTO utilisateur (login, email, role, id_ecole) VALUES "
                          "('admin', 'admin@ecole-b.org', 'administrateur', %s) RETURNING id_utilisateur", (b,)).fetchone()[0]
        # Même code de site et même matricule que 2iE : uniques dans l'école seulement
        c.execute("INSERT INTO site (code_site, nom_site, id_ecole) VALUES ('KAMB', 'Campus B', %s)", (b,))
        c.execute("INSERT INTO enseignant (matricule, nom, prenom, email, telephone, id_ecole) VALUES "
                  "('ENS-001', 'Secret', 'B', 'prof@ecole-b.org', '+226 00 00 00 00', %s)", (b,))
    yield {"id": b, "entetes": {"X-Utilisateur": str(admin)}}
    supprimer_ecoles("T-B")


@pytest.fixture
def client():
    return TestClient(app)


def test_chaque_ecole_ne_voit_que_ses_donnees(client, ecole_b):
    base_2ie = client.get("/api/base", headers=ADMIN_2IE).json()
    base_b = client.get("/api/base", headers=ecole_b["entetes"]).json()
    for t, lignes in base_2ie.items():
        assert all(x.get("id_ecole") == 1 for x in lignes), t
    for t, lignes in base_b.items():
        assert all(x.get("id_ecole") == ecole_b["id"] for x in lignes), t
    assert [s["nom_site"] for s in base_b["site"]] == ["Campus B"]
    assert "Secret" not in {e["nom"] for e in base_2ie["enseignant"]}
    assert len(base_b["creneau"]) == 45 and base_b["cours"] == [] and base_b["emploi_du_temps"] == []
    # Les ressources de 2iE n'existent pas pour l'école B
    assert client.post("/api/generations", headers=ecole_b["entetes"], json={"id_edt": 1}).status_code == 404
    assert client.post("/api/assistant/messages", headers=ecole_b["entetes"], json={"id_edt": 1, "texte": "Bonjour"}).status_code == 404
    assert client.post("/api/propositions/1/appliquer", headers=ecole_b["entetes"]).status_code in (404, 409)


def test_identifiants_deja_pris_par_une_autre_ecole(client, ecole_b):
    """La console numérote ses nouvelles lignes d'après ce qu'elle voit : l'école B propose
    le site 1 (qui est celui de 2iE) et une salle sur ce site, dans le même envoi."""
    b = client.get("/api/base", headers=ecole_b["entetes"]).json()
    type_salle = b["type_salle"][0]["id_type_salle"]
    r = client.post("/api/base/sync", headers=ecole_b["entetes"], json={"tables": {
        "site": {"upsert": [{"id_site": 1, "code_site": "ANNEXE-B", "nom_site": "Annexe B", "type_site": "annexe"}]},
        "salle": {"upsert": [{"id_salle": 1, "code_salle": "B-101", "nom_salle": "Salle B", "capacite": 30,
                              "est_disponible": True, "id_type_salle": type_salle, "id_site": 1}]},
    }})
    assert r.status_code == 200, r.text
    nouveaux = r.json()["identifiants"]
    assert set(nouveaux) == {"site", "salle"}
    b = client.get("/api/base", headers=ecole_b["entetes"]).json()
    salle = next(s for s in b["salle"] if s["code_salle"] == "B-101")
    assert salle["id_site"] == nouveaux["site"]["1"]  # la salle suit la renumérotation de son site
    # Le site 1 de 2iE n'a pas bougé
    site_1 = next(s for s in client.get("/api/base", headers=ADMIN_2IE).json()["site"] if s["id_site"] == 1)
    assert site_1["code_site"] == "KAMB" and site_1["id_ecole"] == 1


def test_une_ecole_ne_peut_ni_designer_ni_modifier_les_donnees_d_une_autre(ecole_b):
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', %s, false)", (str(ecole_b["id"]),))
        c.execute("SET ROLE ultraplanning_app")
        type_salle = c.execute("SELECT min(id_type_salle) FROM type_salle").fetchone()[0]
        with pytest.raises(psycopg.errors.ForeignKeyViolation), c.transaction():
            c.execute("INSERT INTO salle (code_salle, nom_salle, capacite, id_type_salle, id_site) "
                      "VALUES ('X', 'x', 10, %s, 1)", (type_salle,))  # site 1 = 2iE
        with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
            c.execute("INSERT INTO matiere (code_matiere, libelle, id_ecole) VALUES ('X', 'x', 1)")
        assert c.execute("UPDATE cours SET priorite = 99 WHERE id_cours = 1").rowcount == 0
        assert c.execute("DELETE FROM seance").rowcount == 0  # aucune séance de B
        c.rollback()


def test_demarrage_d_une_nouvelle_ecole(client, ecole_b):
    r = client.post("/api/demarrage", headers=ecole_b["entetes"], json={
        "libelle": "Semestre 1", "annee_academique": "2026-2027", "date_debut": "2026-10-05", "date_fin": "2027-02-12"})
    assert r.status_code == 201, r.text
    b = client.get("/api/base", headers=ecole_b["entetes"]).json()
    assert len(b["semestre"]) == 1 and len(b["emploi_du_temps"]) == 1 and len(b["contrainte"]) == 21
    assert b["emploi_du_temps"][0]["statut"] == "brouillon"
    assert client.post("/api/demarrage", headers=ecole_b["entetes"], json={
        "annee_academique": "2027", "date_debut": "2027-01-01", "date_fin": "2027-06-01"}).status_code == 409


def test_espace_invites_par_ecole(client, ecole_b):
    assert client.get("/api/base/public").status_code == 422  # deux écoles actives : il faut choisir
    assert {"2IE", "T-B"} <= {e["code_ecole"] for e in client.get("/api/ecoles").json()}
    assert client.get("/api/base/public?ecole=INCONNUE").status_code == 404
    p = client.get("/api/base/public?ecole=T-B").json()
    assert [s["nom_site"] for s in p["site"]] == ["Campus B"]
    assert all(e["email"] is None and e["telephone"] is None for e in p["enseignant"])


def test_aucun_acces_direct_pour_les_roles_de_supabase(base_generee):
    with psycopg.connect(config.DATABASE_URL) as c:
        roles = {r[0] for r in c.execute("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")}
        for role in roles:
            c.execute(f"SET ROLE {role}")
            with pytest.raises(psycopg.errors.InsufficientPrivilege), c.transaction():
                c.execute("SELECT email, telephone FROM enseignant")
            c.execute("RESET ROLE")
        assert not c.execute("SELECT 1 FROM pg_policies WHERE schemaname = 'public' "
                             "AND roles && ARRAY['anon', 'authenticated']::name[]").fetchone()
