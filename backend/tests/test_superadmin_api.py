import uuid
from datetime import datetime, timedelta, timezone

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app import auth, config, supabase_admin
from app.main import app

from .conftest import supprimer_ecoles

ADMIN_2IE = {"X-Utilisateur": "2"}


class SupabaseFactice:
    """Remplace l'API d'administration de Supabase Auth."""

    def __init__(self):
        self.invitations, self.reinitialisations, self.blocages, self.en_echec = [], [], [], False
        self.emails_changes, self.supprimes = [], []
        self.acceptes: set[str] = set()

    def inviter(self, email, redirection, donnees=None):
        if self.en_echec:
            raise supabase_admin.ErreurSupabase("SMTP indisponible")
        self.invitations.append((email, redirection))
        return str(uuid.uuid4())

    def reinitialiser(self, email, redirection):
        self.reinitialisations.append(email)

    def etat(self, auth_id):
        return "acceptee" if auth_id in self.acceptes else "en_attente"

    def bloquer(self, auth_id, bloque):
        self.blocages.append((auth_id, bloque))

    def changer_email(self, auth_id, email):
        self.emails_changes.append((auth_id, email))

    def supprimer(self, auth_id):
        self.supprimes.append(auth_id)


@pytest.fixture
def supa(monkeypatch):
    f = SupabaseFactice()
    for nom in ("inviter", "reinitialiser", "etat", "bloquer", "changer_email", "supprimer"):
        monkeypatch.setattr(supabase_admin, nom, getattr(f, nom))
    return f


@pytest.fixture
def client(conn):
    """Un super admin de test ; les écoles et comptes créés sont supprimés à la fin."""
    with psycopg.connect(config.DATABASE_URL) as c:
        id_sa = c.execute("INSERT INTO utilisateur (login, email, role, auth_id) VALUES "
                          "('sa-test', 'sa-test@exemple.org', 'superadmin', %s) RETURNING id_utilisateur",
                          (str(uuid.uuid4()),)).fetchone()[0]
    t = TestClient(app)
    t.sa = {"X-Utilisateur": str(id_sa)}
    t.id_sa = id_sa
    yield t
    supprimer_ecoles("T-%")
    with psycopg.connect(config.DATABASE_URL) as c:
        c.execute("DELETE FROM utilisateur WHERE id_utilisateur = %s OR login = 'pirate'", (id_sa,))


def test_ecoles_et_comptes(client, supa):
    r = client.post("/api/superadmin/ecoles", headers=client.sa,
                    json={"code_ecole": "t-ouaga", "nom": "École de test", "ville": "Ouagadougou"})
    assert r.status_code == 201 and r.json()["code_ecole"] == "T-OUAGA"
    id_ecole = r.json()["id_ecole"]
    assert client.post("/api/superadmin/ecoles", headers=client.sa, json={"code_ecole": "T-OUAGA", "nom": "Doublon"}).status_code == 409

    r = client.post(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa,
                    json={"email": "Directeur@Exemple.org", "login": "direction"})
    assert r.status_code == 201 and r.json()["email"] == "directeur@exemple.org" and r.json()["invitation"] == "en_attente"
    assert supa.invitations == [("directeur@exemple.org", config.URL_CONSOLE)]
    id_compte = r.json()["id_utilisateur"]
    # Même e-mail : refusé ; invitation impossible : aucun compte gardé
    assert client.post(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa,
                       json={"email": "directeur@exemple.org", "login": "autre"}).status_code == 409
    supa.en_echec = True
    r = client.post(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa, json={"email": "x@exemple.org", "login": "xx"})
    assert r.status_code == 502 and "SMTP" in r.json()["detail"]
    supa.en_echec = False
    comptes = client.get(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa).json()
    assert [c["login"] for c in comptes] == ["direction"]

    ecole = next(e for e in client.get("/api/superadmin/ecoles", headers=client.sa).json() if e["id_ecole"] == id_ecole)
    assert ecole["nb_administrateurs"] == 1 and ecole["statut"] == "active"

    # Le compte invité entre dans la console de son école
    assert client.get("/api/moi", headers={"X-Utilisateur": str(id_compte)}).json()["ecole"]["code_ecole"] == "T-OUAGA"
    # Renvoyer : invitation tant qu'elle n'est pas acceptée, puis lien de nouveau mot de passe
    assert client.post(f"/api/superadmin/comptes/{id_compte}/inviter", headers=client.sa).json() == {"envoi": "invitation"}
    with psycopg.connect(config.DATABASE_URL) as c:
        supa.acceptes.add(str(c.execute("SELECT auth_id FROM utilisateur WHERE id_utilisateur = %s", (id_compte,)).fetchone()[0]))
    assert client.post(f"/api/superadmin/comptes/{id_compte}/inviter", headers=client.sa).json() == {"envoi": "reinitialisation"}

    # Désactivation : bloqué dans Supabase et refusé par l'API
    assert client.patch(f"/api/superadmin/comptes/{id_compte}", headers=client.sa, json={"est_actif": False}).status_code == 200
    assert supa.blocages[-1][1] is True
    assert client.get("/api/moi", headers={"X-Utilisateur": str(id_compte)}).status_code == 403
    client.patch(f"/api/superadmin/comptes/{id_compte}", headers=client.sa, json={"est_actif": True})
    # École suspendue : plus de connexion, plus d'invitation
    client.patch(f"/api/superadmin/ecoles/{id_ecole}", headers=client.sa, json={"statut": "suspendue"})
    r = client.get("/api/moi", headers={"X-Utilisateur": str(id_compte)})
    assert r.status_code == 403 and "suspendu" in r.json()["detail"]
    assert client.post(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa,
                       json={"email": "y@exemple.org", "login": "yy"}).status_code == 409


def test_roles_separes(client, supa):
    assert client.get("/api/superadmin/ecoles", headers=ADMIN_2IE).status_code == 403
    assert client.get("/api/base", headers=client.sa).status_code == 403
    assert client.get("/api/superadmin/ecoles").status_code == 401
    # Le super admin n'est pas modifiable depuis la console
    assert client.patch(f"/api/superadmin/comptes/{client.id_sa}", headers=client.sa, json={"est_actif": False}).status_code == 404


def test_une_ecole_ne_gere_que_ses_comptes(client, supa):
    base = client.get("/api/base", headers=ADMIN_2IE).json()
    assert base["utilisateur"] and all(u["id_ecole"] == 1 and u["auth_id"] is None for u in base["utilisateur"])
    assert all(u["role"] != "superadmin" for u in base["utilisateur"])
    # Plus de compte créé ou modifié par synchronisation : seulement par invitation
    moi = next(u for u in base["utilisateur"] if u["id_utilisateur"] == 2)
    r = client.post("/api/base/sync", headers=ADMIN_2IE, json={"tables": {"utilisateur": {"upsert": [{**moi, "login": "x"}]}}})
    assert r.status_code == 403 and "invitation" in r.json()["detail"]
    # Le super admin est invisible pour les routes de l'école
    assert client.patch(f"/api/ecole/comptes/{client.id_sa}", headers=ADMIN_2IE, json={"est_actif": False}).status_code == 404


def test_jeton_supabase(client, monkeypatch):
    cle = ec.generate_private_key(ec.SECP256R1())
    monkeypatch.setattr(config, "SUPABASE_URL", "https://exemple.supabase.co")
    monkeypatch.setattr(config, "SUPABASE_JWKS_URL", "https://exemple.supabase.co/auth/v1/.well-known/jwks.json")
    monkeypatch.setattr(auth, "_jwks", lambda: type("J", (), {"get_signing_key_from_jwt": lambda self, t: type("K", (), {"key": cle.public_key()})()})())
    with psycopg.connect(config.DATABASE_URL) as c:
        auth_id = str(c.execute("SELECT auth_id FROM utilisateur WHERE id_utilisateur = %s", (client.id_sa,)).fetchone()[0])

    def jeton(**k):
        claims = {"sub": auth_id, "aud": "authenticated", "iss": "https://exemple.supabase.co/auth/v1",
                  "exp": datetime.now(timezone.utc) + timedelta(hours=1)} | k
        return {"Authorization": "Bearer " + jwt.encode(claims, cle, algorithm="ES256")}

    assert client.get("/api/moi", headers=jeton()).json()["role"] == "superadmin"
    assert client.get("/api/moi", headers=jeton(exp=datetime.now(timezone.utc) - timedelta(minutes=1))).json()["detail"].startswith("Session expirée")
    assert client.get("/api/moi", headers=jeton(aud="autre")).status_code == 401
    assert client.get("/api/moi", headers=jeton(sub=str(uuid.uuid4()))).status_code == 401
    # Sans le mode développement, l'en-tête X-Utilisateur ne suffit plus
    monkeypatch.setattr(config, "AUTH_DEV", False)
    assert client.get("/api/moi", headers=client.sa).status_code == 401


def test_modifier_un_compte(client, supa):
    id_ecole = client.post("/api/superadmin/ecoles", headers=client.sa, json={"code_ecole": "T-MOD", "nom": "École modif"}).json()["id_ecole"]
    creer = lambda e, l: client.post(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa,  # noqa: E731
                                     json={"email": e, "login": l}).json()["id_utilisateur"]
    a, b = creer("ancien@exemple.org", "direction"), creer("autre@exemple.org", "scolarite")
    auth_id = lambda i: str(psycopg.connect(config.DATABASE_URL).execute(  # noqa: E731
        "SELECT auth_id FROM utilisateur WHERE id_utilisateur = %s", (i,)).fetchone()[0])
    patch = lambda i, **k: client.patch(f"/api/superadmin/comptes/{i}", headers=client.sa, json=k)  # noqa: E731

    # Invitation en attente : nouvelle invitation à la nouvelle adresse, ancien compte Auth supprimé
    avant = auth_id(a)
    r = patch(a, email="Nouveau@Exemple.org", login="dir", role="planificateur")
    assert r.status_code == 200 and r.json()["envoi"] == "invitation"
    assert (r.json()["email"], r.json()["login"], r.json()["role"]) == ("nouveau@exemple.org", "dir", "planificateur")
    assert supa.invitations[-1][0] == "nouveau@exemple.org" and supa.supprimes == [avant] and auth_id(a) != avant
    # Invitation acceptée : l'adresse change dans Supabase, même compte Auth, pas d'e-mail
    supa.acceptes.add(auth_id(a))
    r = patch(a, email="final@exemple.org")
    assert r.json()["envoi"] is None and supa.emails_changes == [(auth_id(a), "final@exemple.org")]
    # Doublons refusés, rien de modifié
    assert patch(a, email="autre@exemple.org").status_code == 409
    assert patch(b, login="dir").status_code == 409
    assert patch(a).status_code == 422
    # Supabase refuse : la base n'est pas modifiée
    supa.acceptes.clear()
    supa.en_echec = True
    assert patch(b, email="b2@exemple.org").status_code == 502
    comptes = {c["id_utilisateur"]: c for c in client.get(f"/api/superadmin/ecoles/{id_ecole}/comptes", headers=client.sa).json()}
    assert comptes[a]["email"] == "final@exemple.org" and comptes[b]["email"] == "autre@exemple.org"


def test_une_nouvelle_ecole_recoit_sa_grille(client, supa):
    id_ecole = client.post("/api/superadmin/ecoles", headers=client.sa, json={"code_ecole": "T-GRILLE", "nom": "École grille"}).json()["id_ecole"]
    with psycopg.connect(config.DATABASE_URL) as c:
        compte = lambda t: c.execute(f"SELECT count(*) FROM {t} WHERE id_ecole = %s", (id_ecole,)).fetchone()[0]  # noqa: E731
        assert (compte("creneau"), compte("pause"), compte("type_salle")) == (45, 1, 4)
