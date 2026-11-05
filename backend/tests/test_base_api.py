import psycopg
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


def test_image_publique(client, edt_a_remettre):
    edt = client.get("/api/base", headers=ADMIN).json()["emploi_du_temps"][0]
    p = client.get("/api/base/public?ecole=2IE").json()
    assert p["utilisateur"] == [] and p["disponibilite"] == [] and p["conversation"] == []
    assert all(e["email"] is None and e["telephone"] is None for e in p["enseignant"])
    if edt["statut"] != "publie":
        assert p["seance"] == [] and p["emploi_du_temps"] == []
    # Une synchronisation ne publie pas ; seule une publication rend les séances visibles
    publie = {**edt, "statut": "publie", "date_publication": "2026-10-24T08:00:00+00:00"}
    assert client.post("/api/base/sync", headers=ADMIN, json={"tables": {"emploi_du_temps": {"upsert": [publie]}}}).status_code == 200
    assert client.get("/api/base/public?ecole=2ie").json()["seance"] == []
    assert client.post(f"/api/emplois-du-temps/{edt['id_edt']}/publier", headers=ADMIN).status_code == 200
    assert client.get("/api/base/public?ecole=2ie").json()["seance"]
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


def test_espace_invites_econome_en_donnees(client):
    """Réponse compressée, et 304 sans contenu quand rien n'a changé depuis la dernière visite."""
    r = client.get("/api/base/public?ecole=2IE", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip" and r.headers["etag"]
    assert r.json()["ecole"][0]["code_ecole"] == "2IE"
    r2 = client.get("/api/base/public?ecole=2IE", headers={"If-None-Match": r.headers["etag"]})
    assert r2.status_code == 304 and r2.content == b""


def test_base_injoignable(monkeypatch):
    """Réseau coupé ou DNS en panne : 503 avec un message clair, pas une erreur 500."""
    from app import config
    monkeypatch.setattr(config, "DATABASE_URL", "postgresql://u:p@hote-inexistant.invalid:5432/x")
    r = TestClient(app).get("/api/base/public?ecole=2IE")
    assert r.status_code == 503 and "injoignable" in r.json()["detail"]
    # Les requêtes suivantes échouent tout de suite, sans attendre un nouveau délai de connexion
    import time
    debut = time.monotonic()
    assert TestClient(app).get("/api/sante").status_code == 503 and time.monotonic() - debut < 1


def test_donnees_2ie_par_la_console(client):
    """Cours mutualisé, salle réservée, type de salle accepté, trajet entre sites : écrits et relus
    par la console (version 11), refusés par la base s'ils sont incohérents."""
    b = client.get("/api/base", headers=ADMIN).json()
    cours = b["cours"][0]
    autre = next(c for c in b["classe"] if c["id_classe"] != cours["id_classe"])
    salle, ts = b["salle"][0], b["type_salle"][-1]
    sites = sorted(s["id_site"] for s in b["site"])[:2]
    lignes = {
        "cours_public": {"upsert": [{"id_cours_public": 900001, "id_cours": cours["id_cours"], "id_classe": autre["id_classe"],
                                     "id_groupe": None}], "supprimer": []},
        "salle_reservation": {"upsert": [{"id_salle_reservation": 900001, "id_salle": salle["id_salle"],
                                          "id_classe": autre["id_classe"]}], "supprimer": []},
        "cours_type_salle": {"upsert": [{"id_cours_type_salle": 900001, "id_cours": cours["id_cours"],
                                         "id_type_salle": ts["id_type_salle"]}], "supprimer": []},
        "site_trajet": {"upsert": [{"id_site_trajet": 900001, "id_site_a": sites[0], "id_site_b": sites[1], "minutes": 75}],
                        "supprimer": []},
    }
    assert client.post("/api/base/sync", headers=ADMIN, json={"tables": lignes}).status_code == 200
    b = client.get("/api/base", headers=ADMIN).json()
    assert [(p["id_cours"], p["id_classe"]) for p in b["cours_public"]] == [(cours["id_cours"], autre["id_classe"])]
    assert b["salle_reservation"] and b["cours_type_salle"] and b["site_trajet"][0]["minutes"] == 75
    # Les invités voient les publics des cours mutualisés, pas les réservations
    p = client.get("/api/base/public?ecole=2IE").json()
    assert p["cours_public"] and p["salle_reservation"] == []
    # Trajet dans le mauvais sens : refusé par la base (id_site_a < id_site_b)
    r = client.post("/api/base/sync", headers=ADMIN, json={"tables": {"site_trajet": {"upsert": [
        {"id_site_trajet": 900002, "id_site_a": sites[1], "id_site_b": sites[0], "minutes": 10}], "supprimer": []}}})
    assert r.status_code == 409
    suppr = {t: {"upsert": [], "supprimer": [{k: v for k, v in l["upsert"][0].items() if k in cles}]}
             for t, l, cles in [("cours_public", lignes["cours_public"], ["id_cours_public"]),
                                ("salle_reservation", lignes["salle_reservation"], ["id_salle_reservation"]),
                                ("cours_type_salle", lignes["cours_type_salle"], ["id_cours_type_salle"]),
                                ("site_trajet", lignes["site_trajet"], ["id_site_trajet"])]}
    assert client.post("/api/base/sync", headers=ADMIN, json={"tables": suppr}).status_code == 200
    assert client.get("/api/base", headers=ADMIN).json()["cours_public"] == []


def test_une_connexion_reutilisee_repart_de_zero(client):
    """La connexion gardée en réserve ne garde ni le rôle ni l'école de la requête précédente."""
    from app import db

    with db.ouvrir() as c:
        db.entrer_ecole(c, 1, 2)
        assert c.execute("SELECT current_user, current_setting('app.id_ecole')").fetchone() == ("ultraplanning_app", "1")
        premiere = c
    with db.ouvrir() as c:
        assert c is premiere
        utilisateur, ecole, origine = c.execute("SELECT current_user, current_setting('app.id_ecole'), current_setting('app.origine')").fetchone()
        assert utilisateur != "ultraplanning_app" and ecole == "" and origine == ""
        # Une erreur annule la transaction : la connexion reste utilisable, sans état
    with pytest.raises(psycopg.errors.UndefinedTable):
        with db.ouvrir() as c:
            db.entrer_ecole(c, 1, 2)
            c.execute("SELECT * FROM table_inconnue")
    with db.ouvrir() as c:
        assert c.execute("SELECT current_setting('app.id_ecole')").fetchone()[0] == ""
    # Une connexion coupée en réserve est remplacée sans que la requête s'en aperçoive
    with db.ouvrir() as c:
        cassee = c
    cassee.close()
    with db.ouvrir() as c:
        assert c is not cassee and c.execute("SELECT 1").fetchone()[0] == 1
