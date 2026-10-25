import pytest
from fastapi.testclient import TestClient

from app.main import app

ADMIN = {"X-Utilisateur": "1"}


@pytest.fixture
def client(base_generee):
    return TestClient(app)


def test_image_complete(client):
    b = client.get("/api/base", headers=ADMIN).json()
    assert {"site", "cours", "seance", "proposition", "sejour_enseignant"} <= set(b)
    s = b["seance"][0]
    assert len(s["heure_debut"]) == 5 and len(s["date_seance"]) == 10 and "plage" not in s
    assert all(u["mot_de_passe"] is None for u in b["utilisateur"])
    assert isinstance(b["cours"][0]["volume_horaire"], int)
    assert client.get("/api/base").status_code == 401


def test_image_publique(client):
    edt = client.get("/api/base", headers=ADMIN).json()["emploi_du_temps"][0]
    p = client.get("/api/base/public?ecole=2IE").json()
    assert p["utilisateur"] == [] and p["disponibilite"] == [] and p["conversation"] == []
    assert all(e["email"] is None and e["telephone"] is None for e in p["enseignant"])
    if edt["statut"] != "publie":
        assert p["seance"] == [] and p["emploi_du_temps"] == []
    # Publication par synchronisation : les séances deviennent visibles
    publie = {**edt, "statut": "publie", "date_publication": "2026-10-24T08:00:00+00:00"}
    assert client.post("/api/base/sync", headers=ADMIN, json={"tables": {"emploi_du_temps": {"upsert": [publie]}}}).status_code == 200
    try:
        assert client.get("/api/base/public?ecole=2ie").json()["seance"]
    finally:
        client.post("/api/base/sync", headers=ADMIN, json={"tables": {"emploi_du_temps": {"upsert": [edt]}}})
    assert client.get("/api/comptes").json()[0]["login"]


def test_synchronisation_et_sequences(client):
    base = client.get("/api/base", headers=ADMIN).json()
    id_salle = max(s["id_salle"] for s in base["salle"]) + 1
    salle = {"id_salle": id_salle, "code_salle": "T-TEST", "nom_salle": "Salle de test", "capacite": 20,
             "batiment": None, "est_disponible": True, "id_type_salle": 2, "id_site": 1}
    r = client.post("/api/base/sync", headers=ADMIN, json={"tables": {"salle": {"upsert": [salle]}}})
    assert r.status_code == 200 and r.json()["upsert"] == 1
    salle["capacite"] = 25
    client.post("/api/base/sync", headers=ADMIN, json={"tables": {"salle": {"upsert": [salle]}}})
    relue = next(s for s in client.get("/api/base", headers=ADMIN).json()["salle"] if s["id_salle"] == id_salle)
    assert relue["capacite"] == 25
    # La séquence IDENTITY a été recalée : une insertion côté serveur ne réutilise pas l'identifiant
    import psycopg
    from app import config
    with psycopg.connect(config.DATABASE_URL) as conn:
        nouveau = conn.execute(
            "INSERT INTO salle (code_salle, nom_salle, capacite, id_type_salle, id_site, id_ecole) VALUES ('T-SRV', 'x', 10, 2, 1, 1) RETURNING id_salle"
        ).fetchone()[0]
        conn.execute("DELETE FROM salle WHERE id_salle = %s", (nouveau,))
    assert nouveau > id_salle
    r = client.post("/api/base/sync", headers=ADMIN, json={"tables": {"salle": {"supprimer": [{"id_salle": id_salle}]}}})
    assert r.status_code == 200


def test_synchronisation_refusee_par_la_base(client):
    base = client.get("/api/base", headers=ADMIN).json()
    s = base["seance"][0]
    creneau_11h = next(c["id_creneau"] for c in base["creneau"] if c["jour"] == "Lundi" and c["heure_debut"] == "11:00")
    deplacee = {**s, "date_seance": "2026-10-12", "heure_debut": "11:00", "heure_fin": "13:00", "id_creneau": creneau_11h}
    r = client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": [deplacee]}}})
    assert r.status_code == 409 and r.json()["detail"].startswith("CD-1")
    inchangee = next(x for x in client.get("/api/base", headers=ADMIN).json()["seance"] if x["id_seance"] == s["id_seance"])
    assert inchangee == s
    assert client.post("/api/base/sync", headers=ADMIN, json={"tables": {"pg_user": {"upsert": [{}]}}}).status_code == 422


def test_l_image_porte_l_ecole(client):
    """Les consoles affichent l'école du compte (ou de l'invité) dans leur logo."""
    assert [e["code_ecole"] for e in client.get("/api/base", headers=ADMIN).json()["ecole"]] == ["2IE"]
    assert [e["code_ecole"] for e in client.get("/api/base/public?ecole=2IE").json()["ecole"]] == ["2IE"]


def test_jours_feries_de_l_annee(client):
    """Décision 8 : l'école saisit chaque année ses jours fériés mobiles, et peut les corriger."""
    sync = lambda ch: client.post("/api/base/sync", headers=ADMIN, json={"tables": {"jour_ferie": ch}})  # noqa: E731
    feries = lambda: {f["date_ferie"]: f["libelle"] for f in client.get("/api/base", headers=ADMIN).json()["jour_ferie"]}  # noqa: E731
    assert sync({"upsert": [{"date_ferie": "2027-04-10", "libelle": "Aïd el-Fitr (à confirmer)"}]}).status_code == 200
    assert sync({"upsert": [{"date_ferie": "2027-04-10", "libelle": "Aïd el-Fitr"}]}).status_code == 200
    assert feries()["2027-04-10"] == "Aïd el-Fitr"
    assert sync({"supprimer": [{"date_ferie": "2027-04-10"}]}).status_code == 200
    assert "2027-04-10" not in feries()
