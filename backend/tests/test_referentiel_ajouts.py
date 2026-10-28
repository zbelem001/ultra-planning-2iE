"""Ajouts au référentiel proposés par l'assistant, puis génération enchaînée ; fichiers joints."""

import base64
import io

import openpyxl
import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, pieces_jointes, propositions
from app.db import entrer_ecole
from app.main import app
from app.outils import Contexte, lire_piece_jointe, proposer_ajouts_referentiel

ADMIN = {"X-Utilisateur": "2"}
MATIERE = {"table": "matiere", "valeurs": {"code_matiere": "TST-BD", "libelle": "Big Data (test)"}}
PROGRAMME = {"table": "programme", "valeurs": {"code_classe": "L3INFO", "code_matiere": "TST-BD", "volume_cm": "10"}}
COURS = {"table": "cours", "valeurs": {"code_classe": "L3INFO", "code_matiere": "TST-BD", "type_cours": "CM",
                                       "volume_horaire": 10, "matricule": "ENS-001"}}


def avec(ajout, **valeurs):
    return {"table": ajout["table"], "valeurs": {**ajout["valeurs"], **valeurs}}


def nouveau_prompt(c, utilisateur=1):
    id_conv = c.execute("INSERT INTO conversation (titre, id_utilisateur, id_edt) VALUES ('t', %s, 1) RETURNING id_conversation",
                        (utilisateur,)).fetchone()[0]
    return c.execute("INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES ('t', %s, 1, %s) RETURNING id_prompt",
                     (utilisateur, id_conv)).fetchone()[0]


@pytest.fixture
def ctx(conn):
    return Contexte(conn, 1, nouveau_prompt(conn), [])


def test_ajouts_verifies_puis_appliques(ctx, conn):
    texte = proposer_ajouts_referentiel(ctx, "Module Big Data de la L3INFO", [COURS, PROGRAMME, MATIERE])
    assert texte.startswith("Proposition"), texte
    assert "Habilitation ajoutée" in texte  # ENS-001 n'est pas habilité pour cette nouvelle matière
    # Rien n'est écrit avant validation
    assert conn.execute("SELECT count(*) FROM matiere WHERE code_matiere = 'TST-BD'").fetchone()[0] == 0
    ops = conn.execute("SELECT modifications, nature FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()
    assert ops[1] == "referentiel"
    assert [o["table"] for o in ops[0]] == ["matiere", "habilitation", "programme", "cours"]  # ordre des dépendances

    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["lignes_ajoutees"] == 4 and r["en_direct"] is False and r["suite"] is None
    assert conn.execute("SELECT count(*) FROM cours JOIN matiere USING (id_matiere) WHERE code_matiere = 'TST-BD'").fetchone()[0] == 1

    # Plus rien à ajouter ensuite
    assert proposer_ajouts_referentiel(ctx, "Encore", [MATIERE, PROGRAMME]).startswith("Rien à ajouter")


def test_ajouts_refuses(ctx):
    # Champs manquants ou sans objet : refus avant la base
    texte = proposer_ajouts_referentiel(ctx, "x", [{"table": "cours", "valeurs": {"code_classe": "L3INFO"}},
                                                   {"table": "matiere", "valeurs": {"code_matiere": "X", "libelle": "X", "capacite": 3}}])
    assert texte.startswith("Demande invalide") and "il manque" in texte and "sans objet" in texte
    # Cours plus long que le programme : refusé par la base (CD-07), aucune proposition
    texte = proposer_ajouts_referentiel(ctx, "x", [MATIERE, PROGRAMME, avec(COURS, volume_horaire=30)])
    assert "CD-07" in texte and "Aucune proposition" in texte and ctx.propositions_creees == []
    # Code inconnu
    assert "introuvable" in proposer_ajouts_referentiel(ctx, "x", [MATIERE, avec(PROGRAMME, code_classe="ZZZ")])


def test_lecture_des_fichiers(conn):
    csv_ = "Code;Matière;Volume CM\nBD;Big Data;20\n\nCV;Vision;15\n".encode("cp1252")
    assert pieces_jointes.lire("text/csv", csv_).lignes == ["Code ; Matière ; Volume CM", "BD ; Big Data ; 20", "CV ; Vision ; 15"]

    classeur = openpyxl.Workbook()
    classeur.active.title = "Maquette"
    classeur.active.append(["Code", "Volume"])
    classeur.active.append(["BD", 20.0])
    tampon = io.BytesIO()
    classeur.save(tampon)
    xlsx = tampon.getvalue()
    assert pieces_jointes.lire(pieces_jointes.type_de("maquette.xlsx"), xlsx).lignes == ["[feuille « Maquette »]", "Code ; Volume", "BD ; 20"]
    assert pieces_jointes.lire("image/png", b"\x89PNG").visuel
    with pytest.raises(pieces_jointes.FichierRefuse, match="xlsx"):
        pieces_jointes.type_de("ancien.xls")
    with pytest.raises(pieces_jointes.FichierRefuse, match="5 Mo"):
        pieces_jointes.decoder(base64.b64encode(b"x" * (pieces_jointes.TAILLE_MAX + 1)).decode())

    # Lecture par morceaux dans la discussion
    id_prompt = nouveau_prompt(conn)
    conn.execute("INSERT INTO piece_jointe (nom, type_mime, taille, contenu, id_prompt) VALUES ('m.csv', 'text/csv', %s, %s, %s)",
                 (len(csv_), csv_, id_prompt))
    ctx = Contexte(conn, 1, id_prompt, [])
    texte = lire_piece_jointe(ctx, nombre=2)
    assert "lignes 1 à 2 sur 3" in texte and "2: BD ; Big Data ; 20" in texte and "debut=3" in texte
    assert "3: CV ; Vision ; 15" in lire_piece_jointe(ctx, debut=3)


@pytest.fixture
def client(base_generee):
    yield TestClient(app)
    with psycopg.connect(config.DATABASE_URL) as c:  # retour à l'état des autres tests
        c.execute("DELETE FROM proposition")
        c.execute("DELETE FROM seance WHERE id_cours IN (SELECT id_cours FROM cours JOIN matiere USING (id_matiere) WHERE code_matiere = 'TST-BD')")
        c.execute("DELETE FROM cours WHERE id_matiere IN (SELECT id_matiere FROM matiere WHERE code_matiere = 'TST-BD')")
        c.execute("DELETE FROM programme WHERE id_matiere IN (SELECT id_matiere FROM matiere WHERE code_matiere = 'TST-BD')")
        c.execute("DELETE FROM matiere WHERE code_matiere = 'TST-BD'")


def test_ajouts_puis_generation_enchainee(client):
    with psycopg.connect(config.DATABASE_URL) as c:
        entrer_ecole(c, 1)
        ctx = Contexte(c, 1, nouveau_prompt(c, 2), [])
        texte = proposer_ajouts_referentiel(ctx, "Big Data en L3INFO", [MATIERE, PROGRAMME, COURS], ensuite={
            "description": "Programmer Big Data en L3INFO", "classes": ["L3INFO"], "matieres": ["TST-BD"]})
        assert "la génération sera lancée automatiquement" in texte
        id_prop = ctx.propositions_creees[0]
    r = client.post(f"/api/propositions/{id_prop}/appliquer", headers=ADMIN).json()
    assert r["nature"] == "referentiel" and r["lignes_ajoutees"] == 4
    assert r["suite"]["id_proposition"], r["suite"]
    with psycopg.connect(config.DATABASE_URL) as c:
        nature, statut, id_prompt = c.execute("SELECT nature, statut, id_prompt FROM proposition WHERE id_proposition = %s",
                                              (r["suite"]["id_proposition"],)).fetchone()
        assert (nature, statut) == ("seances", "en_attente")
        assert id_prompt == c.execute("SELECT id_prompt FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]


def test_message_avec_piece_jointe(client, monkeypatch):
    monkeypatch.setattr(config, "GROQ_API_KEY", "")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "")
    piece = {"nom": "maquette.csv", "contenu": base64.b64encode(b"Code;Volume\nBD;20\n").decode()}
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "Lis ce fichier", "piece_jointe": piece})
    assert r.status_code == 200
    with psycopg.connect(config.DATABASE_URL) as c:
        texte, nom = c.execute("SELECT p.texte, pj.nom FROM prompt p JOIN piece_jointe pj USING (id_prompt) "
                               "WHERE p.id_prompt = %s", (r.json()["id_prompt"],)).fetchone()
    assert nom == "maquette.csv" and texte.endswith("[Pièce jointe : maquette.csv]")
    # Format refusé : rien n'est enregistré
    r = client.post("/api/assistant/messages", headers=ADMIN, json={"id_edt": 1, "texte": "x",
                                                                    "piece_jointe": {**piece, "nom": "vieux.xls"}})
    assert r.status_code == 422 and "xlsx" in r.json()["detail"]
