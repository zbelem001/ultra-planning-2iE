import copy
import json
import time
from types import SimpleNamespace

import psycopg
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
    assert appel["model"] == config.MODELE and appel["tool_choice"] == "auto" and len(appel["tools"]) == 12


def test_assistant_sans_cle(client, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(config, "GROQ_API_KEY", "")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
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
                name="proposer_replanification",
                arguments='{"description": "Libérer le début de semaine du M1IA", "classes": ["M1IA"], "du": "2026-10-12", "au": "2026-11-07", '
                          '"contraintes": [{"type": "interdire", "code_classe": "M1IA", "jours": ["Lundi", "Mardi", "Mercredi"]}]}'))
            return _reponse(SimpleNamespace(content="", tool_calls=[appel]), "tool_calls")
        return _reponse(SimpleNamespace(content="Action : appel à proposer_replanification (M1IA).", tool_calls=None))


def test_appel_d_outil_decrit_puis_relance(client, edt_a_remettre, monkeypatch):
    factice = ClientQuiDecrit()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client=factice, **k))
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Libère le début de semaine du M1IA"}).json()
    assert r["statut"] == "traite" and r["reponse"] == "Proposition créée." and len(r["propositions"]) == 1
    assert len(factice.appels) == 3


class FluxFactice:
    """Imite messages.stream du SDK : le texte par morceaux, puis le message complet."""

    def __init__(self, rep):
        self.rep = rep
        textes = [b.text for b in rep.content if b.type == "text"]
        self.text_stream = iter([m + " " for t in textes for m in t.split(" ")])

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.rep


class ClaudeFactice:
    """Imite l'API Messages d'Anthropic : un appel d'outil, puis la réponse."""

    def __init__(self):
        self.appels = []
        self.messages = SimpleNamespace(stream=self.stream)

    def stream(self, **kwargs):
        rep = self.reponse(**kwargs)
        return FluxFactice(rep)

    def reponse(self, **kwargs):
        self.appels.append(copy.deepcopy({k: v for k, v in kwargs.items() if k != "messages"}) | {"messages": list(kwargs["messages"])})
        dernier = kwargs["messages"][-1]["content"]
        if isinstance(dernier, list) and dernier and dernier[0]["type"] == "tool_result":
            salles = dernier[0]["content"]
            return SimpleNamespace(stop_reason="end_turn", content=[
                SimpleNamespace(type="thinking", thinking=""),
                SimpleNamespace(type="text", text=f"Il y a **{salles.count('salle ')}** salles.")])
        return SimpleNamespace(stop_reason="tool_use", content=[
            SimpleNamespace(type="tool_use", id="toolu_1", name="lire_referentiel", input={"sujet": "salles"})])


def test_assistant_avec_claude(client, monkeypatch):
    claude = ClaudeFactice()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client_anthropic=claude, **k))
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Combien de salles ?"}).json()
    assert r["statut"] == "traite" and r["reponse"] == "Il y a 13 salles." and r["modele"] == config.ANTHROPIC_MODEL
    premier, second = claude.appels
    assert premier["model"] == config.ANTHROPIC_MODEL and "temperature" not in premier
    assert premier["output_config"] == {"effort": config.EFFORT} and premier["system"][0]["cache_control"]
    assert premier["thinking"] == {"type": "disabled"}  # pas de réflexion préalable : réponses plus rapides
    assert {t["name"] for t in premier["tools"]} >= {"lire_referentiel", "proposer_generation"}
    assert all("input_schema" in t for t in premier["tools"])
    # 2e appel : la réponse complète du modèle, puis le résultat de l'outil dans un message utilisateur
    assert second["messages"][-2]["role"] == "assistant" and second["messages"][-1]["content"][0]["tool_use_id"] == "toolu_1"


def test_relais_vers_le_second_fournisseur(client, monkeypatch):
    """Groq saturé (quota du jour) : Claude répond à sa place."""
    def groq_sature(*a, **k):
        raise agent.AgentIndisponible("Quota journalier de Groq épuisé")
    monkeypatch.setattr(agent, "_boucle_groq", groq_sature)
    monkeypatch.setattr(config, "GROQ_API_KEY", "gsk_test")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(config, "LLM", "groq")
    assert agent.fournisseurs() == ["groq", "anthropic"]
    monkeypatch.setattr(config, "LLM", "anthropic")
    assert agent.fournisseurs() == ["anthropic", "groq"]
    monkeypatch.setattr(config, "LLM", "groq")
    claude = ClaudeFactice()
    agent.llm_anthropic._client.cache_clear()
    monkeypatch.setattr(agent.llm_anthropic.anthropic, "Anthropic", lambda **k: claude)
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Combien de salles ?"}).json()
    assert r["statut"] == "traite" and r["modele"] == config.ANTHROPIC_MODEL and len(claude.appels) == 2
    agent.llm_anthropic._client.cache_clear()


def test_assistant_etapes_en_direct(client, monkeypatch):
    """Seul le vrai travail est annoncé (ici, un outil), puis le texte s'écrit, puis la réponse (Server-Sent Events)."""
    claude = ClaudeFactice()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client_anthropic=claude, **k))
    with client.stream("POST", "/api/assistant/messages/flux", headers=ADMIN, json={"id_edt": 1, "texte": "Combien de salles ?"}) as r:
        assert r.headers["content-type"].startswith("text/event-stream") and "content-encoding" not in r.headers
        evenements = [json.loads(l[6:]) for l in r.iter_lines() if l.startswith("data: ")]
    etapes = [(e["etape"], e["detail"]) for e in evenements if e["type"] == "etape"]
    assert etapes == [("analyse", "Consultation du référentiel : les salles")]
    assert [e["type"] for e in evenements][0] == "etape"
    assert "".join(e["morceau"] for e in evenements if e["type"] == "texte").strip() == "Il y a **13** salles."
    assert evenements[-1]["type"] == "fin" and evenements[-1]["reponse"] == "Il y a 13 salles."
    # Discussion d'une autre personne : erreur annoncée dans le flux
    with client.stream("POST", "/api/assistant/messages/flux", headers={"X-Utilisateur": "2"},
                       json={"id_edt": 1, "texte": "Suite", "id_conversation": evenements[-1]["id_conversation"]}) as r:
        dernier = [json.loads(l[6:]) for l in r.iter_lines() if l.startswith("data: ")][-1]
    assert dernier == {"type": "erreur", "detail": "Discussion introuvable"}


def test_phrases_des_etapes():
    assert agent.etape_outil("verifier_seance", {"date_seance": "2026-11-04", "heure_debut": "13:00", "heure_fin": "15:00"}) == (
        "verification", "Test d'une séance le mercredi 4/11 de 13:00 à 15:00 contre les règles CD-01 à CD-14")
    assert agent.etape_outil("proposer_generation", {"classes": ["M1IA"]})[1] == "Le solveur génère l'emploi du temps de M1IA"
    assert agent.resultat_court("lire_referentiel", "salle 1 | …") is None
    assert agent.resultat_court("verifier_seance", "Refusée : CD-03 : la classe…\nsuite").startswith("Refusée : CD-03")


def test_generation_par_matiere_refusee_si_rien_a_faire(client):
    r = client.post("/api/generations", headers=ADMIN, json={"id_edt": 1, "classes": ["L2INFO"], "matieres": ["Big Data"]})
    assert r.status_code == 422 and "introuvable" in r.json()["detail"]
    r = client.post("/api/generations", headers=ADMIN, json={"id_edt": 1, "matieres": ["BD"]})
    assert r.status_code == 422


def test_les_reperes_evitent_un_outil(client):
    from app.db import entrer_ecole
    with psycopg.connect(config.DATABASE_URL) as c:
        entrer_ecole(c, 1)
        chiffres = agent.reperes(c, 1)
        salles = c.execute("SELECT count(*) FROM salle").fetchone()[0]
    assert f"{salles} salles" in chiffres and "Repères : " + chiffres in agent.contexte(1, chiffres=chiffres)


def test_un_texte_qui_n_etait_pas_la_reponse_est_oublie(client, monkeypatch):
    """Le modèle écrit avant d'appeler un outil : l'interface doit oublier ce début."""
    class Bavard(ClaudeFactice):
        def reponse(self, **kwargs):
            rep = super().reponse(**kwargs)
            if rep.stop_reason == "tool_use":
                rep.content.insert(0, SimpleNamespace(type="text", text="Je regarde."))
            return rep

    claude = Bavard()
    vrai = agent.repondre
    monkeypatch.setattr(agent, "repondre", lambda *a, **k: vrai(*a, client_anthropic=claude, **k))
    with client.stream("POST", "/api/assistant/messages/flux", headers=ADMIN, json={"id_edt": 1, "texte": "Combien de salles ?"}) as r:
        types = [json.loads(l[6:])["type"] for l in r.iter_lines() if l.startswith("data: ")]
    assert types.index("efface") > types.index("texte") and types[-1] == "fin"
    assert "texte" in types[types.index("efface"):]
