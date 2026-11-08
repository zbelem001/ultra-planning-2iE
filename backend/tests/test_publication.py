"""Publication de la version à jour et e-mails aux seuls enseignants concernés (BF-19, BF-20)."""

import json
from datetime import date, timedelta

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, publication
from app.main import app

ADMIN = {"X-Utilisateur": "2"}


@pytest.fixture
def client(edt_a_remettre, monkeypatch):
    envois: list = []
    monkeypatch.setattr(publication, "planifier", envois.extend)
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.exemple.org")
    monkeypatch.setattr(config, "SMTP_FROM", "scolarite@exemple.org")
    t = TestClient(app)
    t.envois = envois
    return t


def seances(client) -> list[dict]:
    return [s for s in client.get("/api/base", headers=ADMIN).json()["seance"] if s["id_edt"] == 1]


def synchroniser(client, upsert=(), supprimer=()):
    return client.post("/api/base/sync", headers=ADMIN, json={"tables": {"seance": {"upsert": list(upsert), "supprimer": list(supprimer)}}})


def deplacer(client, s: dict) -> dict:
    """Décale la séance à la première semaine où la base l'accepte."""
    for k in range(1, 15):
        n = {**s, "date_seance": (date.fromisoformat(s["date_seance"]) + timedelta(weeks=k)).isoformat()}
        if synchroniser(client, [n]).status_code == 200:
            return n
    raise AssertionError("aucune semaine libre")


def email_de(id_enseignant: int) -> str:
    with psycopg.connect(config.DATABASE_URL) as c:
        return c.execute("SELECT email FROM enseignant WHERE id_enseignant = %s", (id_enseignant,)).fetchone()[0]


def publier(client) -> dict:
    r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def test_premiere_publication(client):
    n = len(seances(client))
    r = publier(client)
    assert (r["ajoutees"], r["retirees"], r["modifiees"]) == (n, 0, 0) and r["notification"]["statut"] == "en_cours"
    assert client.envois and all("Vos séances" in m.texte and "+ Ajoutée" in m.texte for m in client.envois)
    assert all("?ecole=2IE&r=enseignant&id=" in m.texte for m in client.envois)
    # Les invités lisent la copie publiée ; la version à jour reste modifiable
    p = client.get("/api/base/public?ecole=2IE").json()
    assert [e["id_edt"] for e in p["emploi_du_temps"]] == [r["id_publie"]] and r["id_publie"] != 1
    assert len(p["seance"]) == n and {s["id_edt"] for s in p["seance"]} == {r["id_publie"]}
    with psycopg.connect(config.DATABASE_URL) as c:
        assert c.execute("SELECT statut FROM emploi_du_temps WHERE id_edt = 1").fetchone()[0] == "brouillon"
        compte = lambda e: c.execute("SELECT count(*) FROM contrainte WHERE id_edt = %s", (e,)).fetchone()[0]  # noqa: E731
        assert compte(r["id_publie"]) == compte(1) > 0
    # Rien de nouveau : rien à publier, personne n'est prévenu
    client.envois.clear()
    r2 = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN)
    assert r2.status_code == 409 and "Rien à publier" in r2.json()["detail"] and client.envois == []


def test_seuls_les_enseignants_concernes_sont_prevenus(client):
    publier(client)
    client.envois.clear()
    # Trois séances de trois enseignants et de trois cours différents
    choisies: list[dict] = []
    for s in seances(client):
        if s["id_enseignant"] and all(s["id_enseignant"] != x["id_enseignant"] and s["id_cours"] != x["id_cours"] for x in choisies):
            choisies.append(s)
    deplacee, annulee, retiree = choisies[:3]
    p_avant = client.get("/api/base/public?ecole=2IE").json()["seance"]
    deplacer(client, deplacee)
    assert synchroniser(client, [{**annulee, "statut": "annulee"}]).status_code == 200
    assert synchroniser(client, supprimer=[{"id_seance": retiree["id_seance"]}]).status_code == 200
    # Avant la publication, les invités ne voient rien
    assert client.get("/api/base/public?ecole=2IE").json()["seance"] == p_avant and client.envois == []

    r = publier(client)
    assert (r["ajoutees"], r["retirees"], r["modifiees"]) == (0, 1, 2)
    assert r["notification"] == {"statut": "en_cours", "destinataires": 3, "sans_adresse": 0}
    mails = {m.destinataire: m.texte for m in client.envois}
    assert set(mails) == {email_de(s["id_enseignant"]) for s in (deplacee, annulee, retiree)}
    assert "→ Modifiée" in mails[email_de(deplacee["id_enseignant"])] and "devient" in mails[email_de(deplacee["id_enseignant"])]
    assert "× Annulée" in mails[email_de(annulee["id_enseignant"])]
    assert "- Retirée" in mails[email_de(retiree["id_enseignant"])]
    assert all("Changements dans vos séances" in t for t in mails.values())
    p = client.get("/api/base/public?ecole=2IE").json()["seance"]
    assert len(p) == len(p_avant) - 1 and sum(s["statut"] == "annulee" for s in p) == 1

    # La séance revient : séance ajoutée, seul son enseignant est prévenu
    client.envois.clear()
    assert synchroniser(client, [retiree]).status_code == 200
    r = publier(client)
    assert (r["ajoutees"], r["retirees"], r["modifiees"]) == (1, 0, 0)
    assert [m.destinataire for m in client.envois] == [email_de(retiree["id_enseignant"])]
    assert "+ Ajoutée" in client.envois[0].texte


def test_changement_d_enseignant_previent_les_deux(client):
    publier(client)
    client.envois.clear()
    s = next(x for x in seances(client) if x["id_enseignant"])
    with psycopg.connect(config.DATABASE_URL) as c:
        autres = [r[0] for r in c.execute("SELECT id_enseignant FROM enseignant WHERE id_enseignant <> %s ORDER BY 1", (s["id_enseignant"],)).fetchall()]
    nouveau = next(e for e in autres if synchroniser(client, [{**s, "id_enseignant": e}]).status_code == 200)
    r = publier(client)
    assert r["modifiees"] == 1
    mails = {m.destinataire: m.texte for m in client.envois}
    assert set(mails) == {email_de(s["id_enseignant"]), email_de(nouveau)}
    assert "- Retirée" in mails[email_de(s["id_enseignant"])] and "+ Ajoutée" in mails[email_de(nouveau)]


def test_le_verrouillage_n_est_pas_a_publier(client):
    publier(client)
    s = seances(client)[0]
    assert synchroniser(client, [{**s, "est_verrouillee": not s["est_verrouillee"]}]).status_code == 200
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).status_code == 409


def test_l_assistant_lit_et_ecrit_la_version_a_jour(client):
    from ultraplanning_solver.base import charger

    from app.agent import executer_outil
    from app.outils import Contexte, construire_outils, lire_emploi_du_temps

    id_publie = publier(client)["id_publie"]
    s = seances(client)[0]
    n = deplacer(client, s)  # la version à jour ne ressemble plus à la version publiée
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("SET ROLE ultraplanning_app")
        conv = c.execute("INSERT INTO conversation (titre, id_utilisateur, id_edt) VALUES ('t', 1, 1) RETURNING id_conversation").fetchone()[0]
        prompt = c.execute("INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES ('t', 1, 1, %s) RETURNING id_prompt", (conv,)).fetchone()[0]
        ctx = Contexte(c, 1, prompt, [])
        # Le solveur et la lecture de l'assistant voient la séance où la grille la montre
        assert {x.date_seance.isoformat() for x in charger(c, 1).seances if x.id_seance == s["id_seance"]} == {n["date_seance"]}
        assert f"{s['id_seance']}" in lire_emploi_du_temps(ctx, n["date_seance"], n["date_seance"])
        texte = executer_outil(ctx, {o.nom: o for o in construire_outils(ctx)}, "proposer_modifications",
                               json.dumps({"description": "Annuler", "operations": [{"action": "annuler", "id_seance": s["id_seance"]}]}))
        assert texte.startswith("Appliquée à la version à jour"), texte
        c.commit()
    # Écrit tout de suite dans la version à jour ; les invités ne voient rien avant la publication manuelle
    assert next(x for x in seances(client) if x["id_seance"] == s["id_seance"])["statut"] == "annulee"
    publie = lambda: client.get("/api/base/public?ecole=2IE").json()["seance"]  # noqa: E731
    assert {x["id_edt"] for x in publie()} == {id_publie} and not any(x["statut"] == "annulee" for x in publie())
    assert publier(client)["id_publie"] == id_publie
    assert sum(x["statut"] == "annulee" for x in publie()) == 1
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("DELETE FROM proposition WHERE id_prompt = %s", (prompt,))
        c.execute("DELETE FROM prompt WHERE id_prompt = %s", (prompt,))
        c.execute("DELETE FROM conversation WHERE id_conversation = %s", (conv,))


def test_la_version_publiee_ne_se_modifie_pas(client):
    id_publie = publier(client)["id_publie"]
    base = client.get("/api/base", headers=ADMIN).json()
    s = next(x for x in base["seance"] if x["id_edt"] == id_publie)
    r = synchroniser(client, [{**s, "statut": "annulee"}])
    assert r.status_code == 409 and "ne se modifie pas" in r.json()["detail"]
    r = synchroniser(client, supprimer=[{"id_seance": s["id_seance"]}])
    assert r.status_code == 409
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("SET ROLE ultraplanning_app")
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("DELETE FROM seance WHERE id_seance = %s", (s["id_seance"],))
    assert client.post("/api/generations", headers=ADMIN, json={"id_edt": id_publie, "classes": ["L3INFO"]}).status_code == 409
    assert client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": id_publie, "texte": "x"}).status_code == 409
    r = client.post(f"/api/emplois-du-temps/{id_publie}/publier", headers=ADMIN)
    assert r.status_code == 409 and "version à jour" in r.json()["detail"]


def test_un_refus_ne_change_rien_pour_les_invites(client):
    publier(client)
    client.envois.clear()
    s = next(x for x in seances(client) if x["id_enseignant"])
    n = deplacer(client, s)
    avant = client.get("/api/base/public?ecole=2IE").json()["seance"]
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("SELECT set_config('app.id_ecole', '1', false)")
        c.execute("INSERT INTO jour_ferie (date_ferie, libelle) VALUES (%s, 'Férié de test')", (n["date_seance"],))
    try:
        r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN)
        assert r.status_code == 409 and "jour férié" in r.json()["detail"] and "Publication refusée" in r.json()["detail"]
        assert client.get("/api/base/public?ecole=2IE").json()["seance"] == avant and client.envois == []
        with psycopg.connect(config.DATABASE_URL) as c:
            assert c.execute("SELECT count(*) FROM publication_edt").fetchone()[0] == 1
    finally:
        with psycopg.connect(config.DATABASE_URL) as c:
            c.execute("DELETE FROM jour_ferie WHERE libelle = 'Férié de test'")


def test_sans_smtp_la_publication_passe_et_le_dit(client, monkeypatch):
    monkeypatch.setattr(config, "SMTP_HOST", "")
    r = publier(client)
    assert r["notification"]["statut"] == "smtp_non_configure" and r["notification"]["destinataires"] > 0
    assert client.envois == []


def test_enseignant_sans_adresse(client):
    publier(client)
    client.envois.clear()
    s = next(x for x in seances(client) if x["id_enseignant"])
    with psycopg.connect(config.DATABASE_URL) as c:
        email = c.execute("SELECT email FROM enseignant WHERE id_enseignant = %s", (s["id_enseignant"],)).fetchone()[0]
        c.execute("UPDATE enseignant SET email = NULL WHERE id_enseignant = %s", (s["id_enseignant"],))
    try:
        assert synchroniser(client, [{**s, "statut": "annulee"}]).status_code == 200
        r = publier(client)
        assert r["notification"] == {"statut": "personne", "destinataires": 0, "sans_adresse": 1} and client.envois == []
    finally:
        with psycopg.connect(config.DATABASE_URL) as c:
            c.execute("UPDATE enseignant SET email = %s WHERE id_enseignant = %s", (email, s["id_enseignant"]))


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


def test_base_complete_avec_etiquette(client):
    r = client.get("/api/base", headers=ADMIN)
    assert r.status_code == 200 and r.headers["ETag"] and "private" in r.headers["Cache-Control"]
    assert client.get("/api/base", headers={**ADMIN, "If-None-Match": r.headers["ETag"]}).status_code == 304


def test_une_mutualisation_n_apparait_aux_invites_qu_une_fois_publiee(client):
    publier(client)
    base = client.get("/api/base", headers=ADMIN).json()
    s = seances(client)[0]
    cours = next(c for c in base["cours"] if c["id_cours"] == s["id_cours"])
    autre = next(c["id_classe"] for c in base["classe"] if c["id_classe"] != cours["id_classe"])
    ligne = {"id_cours_public": max([p["id_cours_public"] for p in base["cours_public"]] + [0]) + 1,
             "id_cours": cours["id_cours"], "id_classe": autre, "id_groupe": None}
    mutualisation = (cours["id_cours"], autre)
    invites = lambda: [(p["id_cours"], p["id_classe"]) for p in client.get("/api/base/public?ecole=2IE").json()["cours_public"]]  # noqa: E731
    sync = lambda upsert=(), supprimer=(): client.post(  # noqa: E731
        "/api/base/sync", headers=ADMIN, json={"tables": {"cours_public": {"upsert": list(upsert), "supprimer": list(supprimer)}}})

    # Ajoutée dans la console (Planification ou Référentiel) : pas encore pour les invités
    assert sync([ligne]).status_code == 200
    console = client.get("/api/base", headers=ADMIN).json()
    assert mutualisation in [(p["id_cours"], p["id_classe"]) for p in console["cours_public"]]
    assert mutualisation not in [(p["id_cours"], p["id_classe"]) for p in console["cours_public_publie"]]
    assert mutualisation not in invites()
    # Publiée seule, sans séance changée : les invités la voient
    r = publier(client)
    assert (r["ajoutees"], r["retirees"], r["modifiees"], r["mutualisations"]) == (0, 0, 0, 1)
    assert mutualisation in invites()

    # Retirée : les invités la voient encore jusqu'à la publication suivante
    id_ligne = next(p["id_cours_public"] for p in client.get("/api/base", headers=ADMIN).json()["cours_public"]
                    if (p["id_cours"], p["id_classe"]) == mutualisation)
    assert sync(supprimer=[{"id_cours_public": id_ligne}]).status_code == 200
    assert mutualisation in invites()
    assert publier(client)["mutualisations"] == 1
    assert mutualisation not in invites()
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).status_code == 409
