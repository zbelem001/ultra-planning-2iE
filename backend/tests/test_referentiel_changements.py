"""Changements du référentiel proposés par l'assistant (ajouts, modifications, suppressions, calendrier,
enseignants), puis génération ou replanification enchaînée ; fichiers joints."""

import base64
import io
from datetime import timedelta

import openpyxl
import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, pieces_jointes, propositions
from app.db import entrer_ecole
from app.main import app
from app.outils import Contexte, lire_piece_jointe, proposer_changements_referentiel

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
    texte = proposer_changements_referentiel(ctx, "Module Big Data de la L3INFO", [COURS, PROGRAMME, MATIERE])
    assert texte.startswith("Proposition"), texte
    # Rien n'est écrit avant validation
    assert conn.execute("SELECT count(*) FROM matiere WHERE code_matiere = 'TST-BD'").fetchone()[0] == 0
    ops = conn.execute("SELECT modifications, nature FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()
    assert ops[1] == "referentiel"
    assert [o["table"] for o in ops[0]] == ["matiere", "programme", "cours"]  # ordre des dépendances

    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["lignes_ajoutees"] == 3 and r["suite"] is None
    assert conn.execute("SELECT count(*) FROM cours JOIN matiere USING (id_matiere) WHERE code_matiere = 'TST-BD'").fetchone()[0] == 1

    # Plus rien à ajouter ensuite
    assert proposer_changements_referentiel(ctx, "Encore", [MATIERE, PROGRAMME]).startswith("Rien à changer")


def test_ajouts_refuses(ctx):
    # Champs manquants ou sans objet : refus avant la base
    texte = proposer_changements_referentiel(ctx, "x", [{"table": "cours", "valeurs": {"code_classe": "L3INFO"}},
                                                   {"table": "matiere", "valeurs": {"code_matiere": "X", "libelle": "X", "capacite": 3}}])
    assert texte.startswith("Demande invalide") and "il manque" in texte and "sans objet" in texte
    # Cours plus long que le programme : refusé par la base (CD-07), aucune proposition
    texte = proposer_changements_referentiel(ctx, "x", [MATIERE, PROGRAMME, avec(COURS, volume_horaire=30)])
    assert "CD-07" in texte and "Aucune proposition" in texte and ctx.propositions_creees == []
    # Code inconnu
    assert "introuvable" in proposer_changements_referentiel(ctx, "x", [MATIERE, avec(PROGRAMME, code_classe="ZZZ")])


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


def test_ajouts_puis_generation_enchainee(client, edt_a_remettre):
    with psycopg.connect(config.DATABASE_URL) as c:
        entrer_ecole(c, 1)
        ctx = Contexte(c, 1, nouveau_prompt(c, 2), [])
        texte = proposer_changements_referentiel(ctx, "Big Data en L3INFO", [MATIERE, PROGRAMME, COURS], ensuite={
            "description": "Programmer Big Data en L3INFO", "classes": ["L3INFO"], "matieres": ["TST-BD"]})
        assert "la génération sera lancée automatiquement" in texte
        id_prop = ctx.propositions_creees[0]
    r = client.post(f"/api/propositions/{id_prop}/appliquer", headers=ADMIN).json()
    assert r["nature"] == "referentiel" and r["lignes_ajoutees"] == 3
    id_suite = r["suite"]["id_proposition"]
    assert id_suite and r["suite"]["message"] == f"Proposition {id_suite} calculée : à valider sur sa carte, dans la discussion.", r["suite"]
    seances_bd = lambda c: c.execute("SELECT count(*) FROM seance s JOIN cours USING (id_cours) JOIN matiere USING (id_matiere) "  # noqa: E731
                                     "WHERE code_matiere = 'TST-BD'").fetchone()[0]
    with psycopg.connect(config.DATABASE_URL) as c:
        nature, statut, id_prompt = c.execute("SELECT nature, statut, id_prompt FROM proposition WHERE id_proposition = %s",
                                              (id_suite,)).fetchone()
        # La génération attend à son tour la validation, sous le même message de la discussion
        assert (nature, statut) == ("seances", "en_attente") and seances_bd(c) == 0
        assert id_prompt == c.execute("SELECT id_prompt FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]
    r = client.post(f"/api/propositions/{id_suite}/appliquer", headers=ADMIN).json()
    assert r["nature"] == "seances" and r["seances_creees"], r
    with psycopg.connect(config.DATABASE_URL) as c:
        assert seances_bd(c) == r["seances_creees"]


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


# --- modifications, suppressions, calendrier et enseignants ---------------------------

def premiere_seance(c):
    """(date, classe, matricule, salle) de la première séance de l'emploi du temps 1."""
    return c.execute(
        """SELECT s.date_seance, cl.code_classe, e.matricule, sa.code_salle FROM seance s
           JOIN cours co ON co.id_cours = s.id_cours JOIN classe cl ON cl.id_classe = co.id_classe
           JOIN enseignant e ON e.id_enseignant = s.id_enseignant JOIN salle sa ON sa.id_salle = s.id_salle
           WHERE s.id_edt = 1 AND s.statut <> 'annulee' ORDER BY s.date_seance, s.heure_debut LIMIT 1""").fetchone()


def proposition(c, id_prop):
    return c.execute("SELECT modifications, impact, suite FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()


def test_modifier_et_supprimer(ctx, conn):
    texte = proposer_changements_referentiel(ctx, "Corrections", [
        {"action": "modifier", "table": "classe", "cle": {"code_classe": "M2IA"}, "valeurs": {"effectif": "26", "site": "OUAGA"}},
        {"action": "modifier", "table": "enseignant", "cle": {"matricule": "ENS-001"}, "valeurs": {"prenom": "Awa", "email": None}},
        {"action": "supprimer", "table": "jour_ferie", "cle": {"date_ferie": "2026-12-25"}},
        # clé donnée dans valeurs : désigne la ligne ; valeur identique : laissée telle quelle
        {"action": "modifier", "table": "matiere", "valeurs": {"code_matiere": "WEB", "coefficient": 2}},
    ])
    assert texte.startswith("Proposition"), texte
    assert "Déjà à jour" in texte
    assert conn.execute("SELECT effectif FROM classe WHERE code_classe = 'M2IA'").fetchone()[0] == 24  # rien d'écrit
    ops, impact, _ = proposition(conn, ctx.propositions_creees[0])
    assert [o["action"] for o in ops] == ["modifier_ligne", "modifier_ligne", "supprimer_ligne"]
    assert ops[0]["valeurs"] == {"effectif": 26, "site": "Campus de Ouagadougou"} and ops[0]["avant"]["effectif"] == 24
    assert "effectif 24 → 26" in ops[0]["libelle"] and "site non renseigné → Campus de Ouagadougou" in ops[0]["libelle"]
    assert impact["lignes_modifiees"] == 2 and impact["lignes_supprimees"] == 1

    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert (r["lignes_modifiees"], r["lignes_supprimees"]) == (2, 1)
    assert conn.execute("SELECT c.effectif, s.code_site FROM classe c JOIN site s USING (id_site) "
                        "WHERE code_classe = 'M2IA'").fetchone() == (26, "OUAGA")
    assert conn.execute("SELECT prenom, email FROM enseignant WHERE matricule = 'ENS-001'").fetchone() == ("Awa", None)
    assert conn.execute("SELECT count(*) FROM jour_ferie WHERE date_ferie = '2026-12-25'").fetchone()[0] == 0


def test_volumes_baisses_ensemble(ctx, conn):
    # Le programme ne peut descendre sous le cours (CD-07) : le cours est baissé d'abord, quel que soit l'ordre
    texte = proposer_changements_referentiel(ctx, "Baisser WEB", [
        {"action": "modifier", "table": "programme", "cle": {"code_classe": "L3INFO", "code_matiere": "WEB"}, "valeurs": {"volume_cm": 30}},
        {"action": "modifier", "table": "cours", "cle": {"code_classe": "L3INFO", "code_matiere": "WEB", "type_cours": "CM"},
         "valeurs": {"volume_horaire": 30}},
    ])
    assert texte.startswith("Proposition"), texte
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT volume_horaire FROM cours JOIN matiere USING (id_matiere) JOIN classe USING (id_classe) "
                        "WHERE code_matiere = 'WEB' AND code_classe = 'L3INFO'").fetchone()[0] == 30


def test_calendrier_et_seances_touchees(ctx, conn):
    jour, classe, matricule, _ = premiere_seance(conn)
    le_jour = conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1 AND statut <> 'annulee' AND date_seance = %s",
                           (jour,)).fetchone()[0]
    du_prof = conn.execute("SELECT count(*) FROM seance s JOIN enseignant e USING (id_enseignant) WHERE s.id_edt = 1 "
                           "AND s.statut <> 'annulee' AND s.date_seance = %s AND e.matricule = %s", (jour, matricule)).fetchone()[0]
    texte = proposer_changements_referentiel(ctx, "Journée banalisée, absence, indisponibilité", [
        {"action": "ajouter", "table": "jour_ferie", "valeurs": {"date_ferie": jour.isoformat(), "libelle": "Journée banalisée"}},
        {"action": "ajouter", "table": "absence", "valeurs": {"matricule": matricule, "date_debut": jour.isoformat(),
                                                             "date_fin": jour.isoformat(), "motif": "Mission"}},
        {"action": "ajouter", "table": "disponibilite", "valeurs": {"matricule": matricule, "jour": "mercredi", "heure_debut": "13h",
                                                                   "heure_fin": "16:00", "niveau": "indisponible"}},
    ], ensuite={"description": "Replanifier", "mode": "replanifier", "classes": [classe],
                "du": jour.isoformat(), "au": jour.isoformat()})
    assert texte.startswith("Proposition"), texte
    assert "CD-09 : jour férié" in texte and "la replanification sera lancée" in texte
    ops, impact, suite = proposition(conn, ctx.propositions_creees[0])
    regles = {c["regle"]: c for c in impact["conflits"]}
    assert regles["CD-09 : jour férié"]["nombre"] == le_jour and regles["CD-09 : jour férié"]["du"] == jour.isoformat()
    assert regles["CD-06 : enseignant absent"]["nombre"] == du_prof
    dispo = next(o for o in ops if o["action"] == "disponibilite")
    assert dispo["creneaux"] == [["13:00", "14:00"], ["14:00", "15:00"], ["15:00", "16:00"]] and dispo["avant"] == [None] * 3
    assert suite["mode"] == "replanifier"

    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["lignes_ajoutees"] == 3
    assert conn.execute("SELECT count(*) FROM disponibilite d JOIN enseignant e USING (id_enseignant) "
                        "WHERE e.matricule = %s AND d.niveau = 'indisponible'", (matricule,)).fetchone()[0] >= 3
    # Retirer l'indisponibilité : les créneaux redeviennent disponibles par défaut
    ctx.propositions_creees.clear()
    proposer_changements_referentiel(ctx, "Retirer", [{"action": "supprimer", "table": "disponibilite", "cle": {
        "matricule": matricule, "jour": "Mercredi", "heure_debut": "13:00", "heure_fin": "16:00"}}])
    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["lignes_supprimees"] == 1


def test_semestre_raccourci(ctx, conn):
    jour, *_ = premiere_seance(conn)
    texte = proposer_changements_referentiel(ctx, "Rentrée décalée", [
        {"action": "modifier", "table": "semestre", "valeurs": {"date_debut": (jour + timedelta(days=1)).isoformat()}}])
    assert "CD-09 : hors des dates du semestre" in texte, texte
    ops, *_ = proposition(conn, ctx.propositions_creees[0])
    assert ops[0]["avant"]["date_debut"] < ops[0]["valeurs"]["date_debut"]


def test_changements_refuses(ctx, conn):
    _, _, _, salle = premiere_seance(conn)
    # Salle encore utilisée : refusée par la base, aucune proposition
    texte = proposer_changements_referentiel(ctx, "x", [{"action": "supprimer", "table": "salle", "cle": {"code_salle": salle}}])
    assert "encore utilisée par des séances" in texte and ctx.propositions_creees == []
    texte = proposer_changements_referentiel(ctx, "x", [
        {"action": "modifier", "table": "cours", "cle": {"code_classe": "L3INFO", "code_matiere": "WEB", "type_cours": "CM"},
         "valeurs": {"type_cours": "TD"}},
        {"action": "modifier", "table": "creneau", "cle": {"jour": "Lundi", "heure_debut": "07:00", "heure_fin": "08:00"},
         "valeurs": {"heure_fin": "09:00"}},
        {"action": "modifier", "table": "matiere", "cle": {"code_matiere": "ZZZ"}, "valeurs": {"libelle": "x"}},
        {"action": "ajouter", "table": "jour_ferie", "valeurs": {"date_ferie": "31/12/2026", "libelle": "x"}},
        {"action": "ajouter", "table": "disponibilite", "valeurs": {"matricule": "ENS-001", "jour": "Dimanche",
                                                                   "heure_debut": "8", "heure_fin": "10", "niveau": "indisponible"}},
    ])
    assert texte.startswith("Demande invalide"), texte
    for motif in ("ne se modifie pas", "impossible de modifier le créneau", "introuvable", "AAAA-MM-JJ", "Dimanche"):
        assert motif in texte, motif


def test_ligne_changee_depuis_la_proposition(ctx, conn):
    proposer_changements_referentiel(ctx, "x", [{"action": "modifier", "table": "matiere", "cle": {"code_matiere": "WEB"},
                                                 "valeurs": {"coefficient": 3}}])
    conn.execute("UPDATE matiere SET coefficient = 5 WHERE code_matiere = 'WEB'")
    with pytest.raises(propositions.PropositionRefusee, match="a changé depuis la proposition"):
        propositions.appliquer(conn, ctx.propositions_creees[0], 1)


def test_absence_puis_replanification_enchainee(client, edt_a_remettre):
    with psycopg.connect(config.DATABASE_URL) as c:
        entrer_ecole(c, 1)
        jour, classe, matricule, _ = premiere_seance(c)
        ctx = Contexte(c, 1, nouveau_prompt(c, 2), [])
        texte = proposer_changements_referentiel(ctx, "Absence", [
            {"action": "ajouter", "table": "absence", "valeurs": {"matricule": matricule, "date_debut": jour.isoformat(),
                                                                 "date_fin": jour.isoformat(), "motif": "TEST-ABS"}}],
            ensuite={"description": "Replanifier", "mode": "replanifier", "classes": [classe],
                     "du": jour.isoformat(), "au": jour.isoformat()})
        assert "CD-06 : enseignant absent" in texte, texte
        id_prop = ctx.propositions_creees[0]
    try:
        r = client.post(f"/api/propositions/{id_prop}/appliquer", headers=ADMIN).json()
        assert r["lignes_ajoutees"] == 1 and r["suite"]["id_proposition"], r
        assert r["suite"]["message"].endswith("à valider sur sa carte, dans la discussion."), r  # à valider à son tour
        with psycopg.connect(config.DATABASE_URL) as c:
            ops = c.execute("SELECT modifications FROM proposition WHERE id_proposition = %s",
                            (r["suite"]["id_proposition"],)).fetchone()[0]
            id_ens = c.execute("SELECT id_enseignant FROM enseignant WHERE matricule = %s", (matricule,)).fetchone()[0]
        # Plus aucune séance de l'enseignant ce jour-là après la replanification proposée
        assert not [o for o in ops if o.get("apres") and o["apres"]["date_seance"] == jour.isoformat()
                    and o["apres"].get("id_enseignant") == id_ens]
        assert any(o["action"] in ("modifier", "supprimer") for o in ops)
    finally:
        with psycopg.connect(config.DATABASE_URL) as c:
            c.execute("DELETE FROM absence_enseignant WHERE motif = 'TEST-ABS'")
