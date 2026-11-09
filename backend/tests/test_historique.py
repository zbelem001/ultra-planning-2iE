"""Historique de la version à jour : versions, séances d'une version, restauration."""

from datetime import date, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

ADMIN = {"X-Utilisateur": "2"}
CHAMPS = ("date_seance", "heure_debut", "heure_fin", "statut", "id_cours", "id_enseignant", "id_salle")


@pytest.fixture
def client(edt_a_remettre):
    return TestClient(app)


def seances(client) -> list[dict]:
    return [s for s in client.get("/api/base", headers=ADMIN).json()["seance"] if s["id_edt"] == 1]


def etat(lignes) -> dict:
    return {s["id_seance"]: tuple(s[k] for k in CHAMPS) for s in lignes}


def synchroniser(client, upsert=(), supprimer=()):
    return client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": list(upsert), "supprimer": list(supprimer)}}})


def deplacer(client, s: dict) -> dict:
    for k in range(1, 15):
        n = {**s, "date_seance": (date.fromisoformat(s["date_seance"]) + timedelta(weeks=k)).isoformat()}
        if synchroniser(client, [n]).status_code == 200:
            return n
    raise AssertionError("aucune semaine libre")


def versions(client) -> dict:
    r = client.get("/api/emplois-du-temps/1/versions", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def restaurer(client, numero, appliquer=False, edt=1):
    return client.post(f"/api/emplois-du-temps/{edt}/versions/{numero}/restaurer", headers=ADMIN, json={"appliquer": appliquer})


def test_liste_des_versions(client):
    a, b = seances(client)[:2]
    avant = versions(client)["total"]
    deplacer(client, a)
    assert synchroniser(client, [{**b, "statut": "annulee"}]).status_code == 200
    v = versions(client)
    assert v["total"] == avant + 2
    assert [x["numero"] for x in v["versions"][:2]] == [avant + 2, avant + 1]
    assert v["versions"][0]["titre"].startswith("Annulation : ") and v["versions"][1]["titre"].startswith("Déplacement : ")
    assert "→" in v["versions"][1]["titre"]
    assert v["versions"][0]["auteur"] == "admin" and v["versions"][0]["origine_libelle"] == "Modification manuelle"
    assert v["versions"][0]["modifiees"] == 1
    # Une génération ou un import : un seul résumé, avec les nombres
    premiere = v["versions"][-1]
    assert premiere["ajoutees"] + premiere["retirees"] + premiere["modifiees"] > 0
    # Suite de la liste
    suite = client.get("/api/emplois-du-temps/1/versions", headers=ADMIN, params={"avant": avant + 1, "limite": 1}).json()
    assert [x["numero"] for x in suite["versions"]] == [avant]


def test_l_historique_ne_garde_que_les_10_dernieres_versions(client):
    a = seances(client)[0]
    n = deplacer(client, a)
    for i in range(11):   # aller-retour entre deux semaines : une version à chaque fois, plus de 10 en tout
        assert synchroniser(client, [a if i % 2 == 0 else n]).status_code == 200
    v = versions(client)
    assert v["total"] > 10 and len(v["versions"]) == 10 and v["gardees"] == 10
    assert [x["numero"] for x in v["versions"]] == list(range(v["total"], v["total"] - 10, -1))
    ancienne = v["total"] - 10
    assert client.get(f"/api/emplois-du-temps/1/versions/{ancienne}", headers=ADMIN).status_code == 410
    assert restaurer(client, ancienne).status_code == 410
    assert client.get(f"/api/emplois-du-temps/1/versions/{ancienne + 1}", headers=ADMIN).status_code == 200


def test_seances_d_une_version_et_restauration(client):
    depart = seances(client)
    a, b, c = depart[:3]
    numero = versions(client)["total"]
    deplacer(client, a)
    assert synchroniser(client, [{**b, "statut": "annulee"}]).status_code == 200
    assert synchroniser(client, supprimer=[{"id_seance": c["id_seance"]}]).status_code == 200
    modifie = etat(seances(client))
    assert modifie != etat(depart)

    # Les séances de cette version, telles qu'elles étaient
    r = client.get(f"/api/emplois-du-temps/1/versions/{numero}", headers=ADMIN).json()
    assert etat(r["seances"]) == etat(depart) and r["hors_referentiel"] == 0

    # Aperçu : rien n'est écrit, pas de nouvelle version
    total = versions(client)["total"]
    p = restaurer(client, numero).json()
    assert (p["ajoutees"], p["modifiees"], p["retirees"], p["refusees"], p["appliquee"]) == (1, 2, 0, 0, False)
    assert etat(seances(client)) == modifie and versions(client)["total"] == total

    # Restauration : retour à cet état, mêmes identifiants, nouvelle version en tête d'historique
    r = restaurer(client, numero, appliquer=True).json()
    assert r["appliquee"] is True and r["refusees"] == 0
    assert etat(seances(client)) == etat(depart)
    v = versions(client)
    assert v["total"] == total + 1
    assert v["versions"][0]["titre"] == f"Restauration de la version {numero}" and v["versions"][0]["origine"] == "restauration"
    assert (v["versions"][0]["ajoutees"], v["versions"][0]["modifiees"]) == (1, 2)  # supprimée puis remise : une modification

    # Rien n'est perdu : on peut revenir à l'état d'avant la restauration
    assert restaurer(client, total, appliquer=True).json()["refusees"] == 0
    assert etat(seances(client)) == modifie


def test_une_seance_ajoutee_depuis_est_retiree(client):
    s = seances(client)[0]
    assert synchroniser(client, supprimer=[{"id_seance": s["id_seance"]}]).status_code == 200
    numero = versions(client)["total"]
    nouvelle = {**s, "id_seance": max(x["id_seance"] for x in seances(client)) + 1000}
    assert synchroniser(client, [nouvelle]).status_code == 200
    r = restaurer(client, numero, appliquer=True).json()
    assert (r["retirees"], r["ajoutees"], r["modifiees"]) == (1, 0, 0)
    assert nouvelle["id_seance"] not in etat(seances(client))


def test_restauration_sans_toucher_les_invites(client):
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).status_code == 200
    v = versions(client)
    assert v["versions"][0]["en_ligne"] is True and v["versions"][0]["publiee_le"]
    numero = v["total"]
    depart = seances(client)
    s = next(x for x in depart if x["id_enseignant"])
    deplacer(client, s)
    v = versions(client)
    assert v["versions"][0]["en_ligne"] is False and v["versions"][1]["en_ligne"] is True
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).status_code == 200
    publiee = client.get("/api/base/public?ecole=2IE")

    assert restaurer(client, numero, appliquer=True).json()["modifiees"] == 1
    # Les invités gardent la dernière publication tant qu'on ne publie pas
    assert client.get("/api/base/public?ecole=2IE").headers["ETag"] == publiee.headers["ETag"]
    r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).json()
    assert r["modifiees"] == 1
    dates = {x["date_seance"] for x in client.get("/api/base/public?ecole=2IE").json()["seance"] if x["id_cours"] == s["id_cours"]}
    assert s["date_seance"] in dates


def test_une_seance_que_les_regles_refusent_reste_comme_elle_est(client):
    s = next(x for x in seances(client) if x["date_seance"])
    numero = versions(client)["total"]
    n = deplacer(client, s)
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("INSERT INTO jour_ferie (date_ferie, libelle) VALUES (%s, 'Férié de test')", (s["date_seance"],))
    try:
        p = restaurer(client, numero).json()
        assert p["refusees"] >= 1 and "férié" in p["exemples"][0]["motif"] and p["modifiees"] == 0
        r = restaurer(client, numero, appliquer=True).json()
        assert r["refusees"] >= 1
        apres = {x["id_seance"]: x for x in seances(client)}
        assert apres[s["id_seance"]]["date_seance"] == n["date_seance"]  # elle n'a pas bougé
    finally:
        with psycopg.connect(config.DATABASE_URL) as c:
            c.execute("DELETE FROM jour_ferie WHERE libelle = 'Férié de test'")


def test_une_seance_dont_le_cours_n_existe_plus(client):
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        m = c.execute("INSERT INTO matiere (code_matiere, libelle) VALUES ('TST-H', 'Test historique') RETURNING id_matiere").fetchone()[0]
        cl = c.execute("SELECT id_classe FROM classe WHERE code_classe = 'L3INFO'").fetchone()[0]
        c.execute("INSERT INTO programme (id_classe, id_matiere, id_semestre, volume_cm) VALUES (%s, %s, 1, 10)", (cl, m))
        k = c.execute("INSERT INTO cours (type_cours, volume_horaire, duree_seance, id_matiere, id_classe, id_semestre) "
                      "VALUES ('CM', 10, 2, %s, %s, 1) RETURNING id_cours", (m, cl)).fetchone()[0]
        cr = c.execute("SELECT id_creneau FROM creneau WHERE jour = 'Lundi' AND heure_debut = '07:00'").fetchone()[0]
        c.execute("INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt) "
                  "VALUES ('2026-12-07', '07:00', '09:00', %s, (SELECT min(id_salle) FROM salle WHERE capacite >= 60 AND id_type_salle = 1), %s, 1)", (k, cr))
    numero = versions(client)["total"]
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("DELETE FROM seance WHERE id_cours = %s", (k,))
        c.execute("DELETE FROM cours WHERE id_cours = %s", (k,))
        c.execute("DELETE FROM programme WHERE id_matiere = %s", (m,))
        c.execute("DELETE FROM matiere WHERE id_matiere = %s", (m,))
    r = client.get(f"/api/emplois-du-temps/1/versions/{numero}", headers=ADMIN).json()
    assert r["hors_referentiel"] == 1
    p = restaurer(client, numero).json()
    assert p["refusees"] == 1 and p["exemples"][0]["motif"] == "son cours n'existe plus"
    assert "cours supprimé" in p["exemples"][0]["seance"]
    assert "cours supprimé" in versions(client)["versions"][0]["titre"]


def test_seule_la_version_a_jour_se_restaure(client):
    id_publie = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).json()["id_publie"]
    assert restaurer(client, 1, appliquer=True, edt=id_publie).status_code == 409
    assert client.get("/api/emplois-du-temps/1/versions/999999", headers=ADMIN).status_code == 404
    assert restaurer(client, 999999).status_code == 404
    assert client.get("/api/emplois-du-temps/999999/versions", headers=ADMIN).status_code == 404


def test_l_historique_reste_dans_l_ecole(client):
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SET ROLE ultraplanning_app")
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        assert c.execute("SELECT count(*) FROM versions_edt(1)").fetchone()[0] > 0
        c.execute("SELECT set_config('app.id_ecole', '999', false)")
        assert c.execute("SELECT count(*) FROM versions_edt(1)").fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM seances_version(1, now())").fetchone()[0] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT count(*) FROM journal_seance")
