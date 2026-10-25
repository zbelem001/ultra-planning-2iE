"""Publication d'une version et e-mails aux enseignants concernés (BF-20)."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, publication
from app.main import app

ADMIN = {"X-Utilisateur": "2"}


@pytest.fixture
def client(base_generee, monkeypatch):
    envois: list = []
    monkeypatch.setattr(publication, "planifier", envois.extend)
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.exemple.org")
    monkeypatch.setattr(config, "SMTP_FROM", "scolarite@exemple.org")
    t = TestClient(app)
    t.envois = envois
    yield t
    with psycopg.connect(config.DATABASE_URL) as c:  # retour à l'état des autres tests
        c.execute("DELETE FROM seance WHERE id_edt <> 1")
        c.execute("DELETE FROM contrainte WHERE id_edt <> 1")
        c.execute("DELETE FROM emploi_du_temps WHERE id_edt <> 1")
        c.execute("UPDATE emploi_du_temps SET statut = 'brouillon', date_publication = NULL WHERE id_edt = 1")


def test_premiere_publication_puis_changements(client):
    r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN, json={"notifier": True}).json()
    assert r["notification"]["statut"] == "en_cours" and r["archive"] is None
    premiers = {m.destinataire: m for m in client.envois}
    assert premiers and all("Vos séances" in m.texte and "+ Ajoutée" in m.texte for m in premiers.values())
    assert all("?ecole=2IE&r=enseignant&id=" in m.texte for m in premiers.values())
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN, json={}).status_code == 409

    # Version 2 : copie de la 1, une séance retirée ; seul son enseignant est prévenu
    with psycopg.connect(config.DATABASE_URL) as c:
        v2 = c.execute("INSERT INTO emploi_du_temps (libelle, version, id_semestre, id_utilisateur, id_ecole) "
                       "SELECT libelle, 2, id_semestre, id_utilisateur, id_ecole FROM emploi_du_temps WHERE id_edt = 1 "
                       "RETURNING id_edt").fetchone()[0]
        c.execute("INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                  "SELECT date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, %s, id_ecole FROM seance WHERE id_edt = 1", (v2,))
        retiree = c.execute("DELETE FROM seance WHERE id_seance = (SELECT min(id_seance) FROM seance WHERE id_edt = %s) "
                            "RETURNING id_cours", (v2,)).fetchone()[0]
        email = c.execute("SELECT e.email FROM cours JOIN enseignant e USING (id_enseignant) WHERE id_cours = %s", (retiree,)).fetchone()[0]
    client.envois.clear()
    r = client.post(f"/api/emplois-du-temps/{v2}/publier", headers=ADMIN, json={"notifier": True}).json()
    assert r["archive"] == 1 and [m.destinataire for m in client.envois] == [email]
    assert "- Retirée" in client.envois[0].texte and "Changements" in client.envois[0].texte
    with psycopg.connect(config.DATABASE_URL) as c:
        assert dict(c.execute("SELECT id_edt, statut FROM emploi_du_temps WHERE id_edt IN (1, %s)", (v2,)).fetchall()) == {1: "archive", v2: "publie"}


def test_sans_smtp_la_publication_passe_et_le_dit(client, monkeypatch):
    monkeypatch.setattr(config, "SMTP_HOST", "")
    r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN, json={"notifier": True}).json()
    assert r["notification"]["statut"] == "smtp_non_configure" and r["notification"]["destinataires"] > 0
    assert client.envois == []


def test_envoi_smtp(monkeypatch):
    """Une seule connexion, STARTTLS sur 587, une adresse refusée n'arrête pas les autres."""
    journal = []

    class SMTP:
        def __init__(self, hote, port, timeout):
            journal.append(("connexion", hote, port))

        def __enter__(self):
            return self

        def __exit__(self, *a):
            journal.append(("fin",))

        def starttls(self, context):
            journal.append(("starttls",))

        def login(self, u, p):
            journal.append(("login", u))

        def send_message(self, e):
            if e["To"] == "refuse@exemple.org":
                raise publication.smtplib.SMTPRecipientsRefused({})
            journal.append(("envoi", e["To"], e["Subject"]))

    monkeypatch.setattr(publication.smtplib, "SMTP", SMTP)
    for k, v in {"SMTP_HOST": "smtp.exemple.org", "SMTP_PORT": 587, "SMTP_USER": "u", "SMTP_PASSWORD": "p", "SMTP_FROM": "u@exemple.org"}.items():
        monkeypatch.setattr(config, k, v)
    envoyes, echecs = publication.envoyer([publication.Message("a@exemple.org", "S", "T"),
                                           publication.Message("refuse@exemple.org", "S", "T")])
    assert (envoyes, echecs) == (1, ["refuse@exemple.org"])
    assert [j[0] for j in journal] == ["connexion", "starttls", "login", "envoi", "fin"]
