import copy
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import agent, config
from app.main import app

ADMIN = {"X-Utilisateur": "1"}


@pytest.fixture
def client(base_generee):
    return TestClient(app)


def test_sante_et_authentification(client):
    assert client.get("/api/sante").json()["statut"] == "ok"
    assert client.post("/api/verifications", json={}).status_code == 401
    assert client.get("/api/propositions?id_edt=1", headers={"X-Utilisateur": "999"}).status_code == 401


def test_generation_d_une_classe(client):
    r = client.post("/api/generations", headers=ADMIN, json={
        "id_edt": 1, "classes": ["M1IA"], "du": "2026-11-02", "au": "2026-11-28",
    })
    assert r.status_code == 202
    id_tache = r.json()["id"]
    for _ in range(360):  # jusqu’à 3 min si la machine est chargée
        etat = client.get(f"/api/generations/{id_tache}", headers=ADMIN).json()
        if etat["statut"] in ("terminee", "erreur"):
            break
        time.sleep(0.5)
    assert etat["statut"] == "terminee", etat
    assert etat["statistiques"]["cours"] == 2
    applique = client.post(f"/api/generations/{id_tache}/appliquer", headers=ADMIN)
    assert applique.status_code == 200, applique.json()
    # Une génération ne s'applique qu'une fois
    assert client.post(f"/api/generations/{id_tache}/appliquer", headers=ADMIN).status_code == 409

    # Compléter seulement : rien de ce qui vient d'être placé n'est remplacé
    r = client.post("/api/generations", headers=ADMIN, json={
        "id_edt": 1, "classes": ["M1IA"], "du": "2026-11-02", "au": "2026-11-28", "completer": True,
    })
    id_tache = r.json()["id"]
    for _ in range(360):
        etat = client.get(f"/api/generations/{id_tache}", headers=ADMIN).json()
        if etat["statut"] in ("terminee", "erreur"):
            break
        time.sleep(0.5)
    assert etat["statut"] == "terminee" and etat["seances_remplacees"] == 0


def test_codes_inconnus_refuses(client):
    r = client.post("/api/generations", headers=ADMIN, json={"id_edt": 1, "classes": ["NEXISTEPAS"]})
    assert r.status_code == 422


def test_verification(client):
    # À cheval sur la pause déjeuner : refusée quel que soit l'emploi du temps généré
    r = client.post("/api/verifications", headers=ADMIN, json={
        "id_edt": 1, "id_cours": 1, "date_seance": "2026-12-02", "heure_debut": "11:00", "heure_fin": "13:00", "id_salle": 1,
    })
    corps = r.json()
    assert r.status_code == 200 and corps["acceptee"] is False and corps["motif"].startswith("CD-1")


def _reponse(message, finish_reason="stop"):
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)])


class ClientFactice:
    """Imite l'API Groq : au premier tour, le modèle demande un outil ; au
    second, il répond à partir du résultat de l'outil."""

    def __init__(self):
        self.appels = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.appels.append(copy.deepcopy(kwargs))  # l'agent continue d'allonger sa liste
        derniers = kwargs["messages"]
        if derniers[-1]["role"] != "tool":
            appel = SimpleNamespace(id=f"appel_{len(self.appels)}", function=SimpleNamespace(
                name="lire_referentiel", arguments='{"sujet": "salles"}'))
            return _reponse(SimpleNamespace(content="", tool_calls=[appel]), "tool_calls")
        salles = derniers[-1]["content"]
        return _reponse(SimpleNamespace(content=f"Il y a {salles.count('salle ')} salles.", tool_calls=None))


def test_assistant_discussion(client, monkeypatch):
    factice = ClientFactice()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client=factice, **k))

    r1 = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Combien de salles ?"}).json()
    assert r1["statut"] == "traite" and "13 salles" in r1["reponse"]
    r2 = client.post("/api/assistant/messages", headers=ADMIN,
                     json={"id_edt": 1, "texte": "Et maintenant ?", "id_conversation": r1["id_conversation"]}).json()
    assert r2["id_conversation"] == r1["id_conversation"]

    # 1er tour de la 2e demande : système, demande 1, réponse 1, nouvelle demande
    messages = factice.appels[2]["messages"]
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[1]["content"] == "Combien de salles ?" and "13 salles" in messages[2]["content"]
    # 2e tour de la 1re demande : l'appel d'outil et son résultat ont été renvoyés au modèle
    tour2 = factice.appels[1]["messages"]
    assert tour2[-2]["tool_calls"][0]["function"]["name"] == "lire_referentiel" and tour2[-1]["role"] == "tool"
    appel = factice.appels[0]
    assert appel["model"] == config.MODELE and appel["tool_choice"] == "auto" and len(appel["tools"]) == 6


def test_assistant_sans_cle(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(config, "GROQ_API_KEY", "")
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Bonjour"})
    corps = r.json()
    assert r.status_code == 200 and corps["statut"] == "erreur"
    assert "api_key" in corps["reponse"].lower() or "clé" in corps["reponse"].lower()


def test_message_limite_groq():
    from app.agent import message_limite
    assert message_limite("tokens per day (TPD): Limit 200000. Please try again in 5m44.736s.") == (
        "Quota journalier de Groq épuisé : réessayez dans 5m44s, ou passez à une offre Groq payante.")
    assert message_limite("tokens per minute. Please try again in 2.5s.") == "Limite de requêtes Groq atteinte : réessayez dans 2s."


class ClientQuiDecrit:
    """Imite un modèle qui décrit l'appel d'outil au lieu de le faire, puis le fait une fois relancé."""

    def __init__(self):
        self.appels = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.appels.append(copy.deepcopy(kwargs))
        dernier = kwargs["messages"][-1]
        if dernier["role"] == "tool":
            return _reponse(SimpleNamespace(content="Proposition créée.", tool_calls=None))
        if "sans le faire" in dernier["content"]:
            appel = SimpleNamespace(id="appel_1", function=SimpleNamespace(
                name="proposer_generation",
                arguments='{"description": "Semaine du M1IA", "classes": ["M1IA"], "du": "2026-11-09", "au": "2026-11-14"}'))
            return _reponse(SimpleNamespace(content="", tool_calls=[appel]), "tool_calls")
        return _reponse(SimpleNamespace(content="Action : appel à proposer_generation (M1IA).", tool_calls=None))


def test_appel_d_outil_decrit_puis_relance(client, monkeypatch):
    factice = ClientQuiDecrit()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client=factice, **k))
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Planifie la semaine du 9 novembre du M1IA"}).json()
    assert r["statut"] == "traite" and r["reponse"] == "Proposition créée." and len(r["propositions"]) == 1
    assert len(factice.appels) == 3
