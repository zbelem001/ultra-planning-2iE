from datetime import timedelta

import pytest

from app import propositions
from app.outils import (
    Contexte, construire_outils, lire_emploi_du_temps, lire_referentiel, proposer_priorites,
    proposer_generation, proposer_replanification, verifier_seance,
)


@pytest.fixture
def ctx(conn):
    id_conv = conn.execute(
        "INSERT INTO conversation (titre, id_utilisateur, id_edt) VALUES ('test', 1, 1) RETURNING id_conversation"
    ).fetchone()[0]
    id_prompt = conn.execute(
        "INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES ('test', 1, 1, %s) RETURNING id_prompt",
        (id_conv,),
    ).fetchone()[0]
    return Contexte(conn, 1, id_prompt, [])


def premiere_seance(conn, code_classe):
    return conn.execute(
        """SELECT s.id_seance, s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle
           FROM seance s JOIN cours c USING (id_cours) JOIN classe cl USING (id_classe)
           WHERE cl.code_classe = %s ORDER BY s.date_seance, s.heure_debut LIMIT 1""",
        (code_classe,),
    ).fetchone()


def classe_avec_cours_un_lundi(conn):
    return conn.execute(
        """SELECT cl.code_classe, s.date_seance FROM seance s JOIN cours c USING (id_cours) JOIN classe cl USING (id_classe)
           WHERE extract(isodow FROM s.date_seance) = 1 ORDER BY s.date_seance LIMIT 1"""
    ).fetchone()


def test_schemas_des_outils(ctx):
    outils = construire_outils(ctx)
    noms = [o.schema()["function"]["name"] for o in outils]
    assert noms == ["lire_emploi_du_temps", "lire_referentiel", "verifier_seance",
                    "proposer_replanification", "proposer_generation", "proposer_priorites"]
    for o in outils:
        f = o.schema()["function"]
        assert f["description"] and f["parameters"]["type"] == "object"
        assert "$ref" not in str(f["parameters"])  # schéma aplati pour le modèle
        # chaque paramètre est documenté
        assert all(p.get("description") for p in f["parameters"]["properties"].values()), f["name"]


def test_lire_emploi_du_temps_et_referentiel(ctx):
    texte = lire_emploi_du_temps(ctx, "2026-10-12", "2026-10-18", code_classe="L2INFO")
    assert "séance" in texte and "L2INFO" in texte
    for sujet in ["cours", "classes", "enseignants", "salles", "programme", "calendrier"]:
        assert lire_referentiel(ctx, sujet).strip(), sujet
    assert "Diallo" in lire_referentiel(ctx, "enseignants")
    assert "Sujet inconnu" in lire_referentiel(ctx, "n'importe quoi")


def test_verifier_seance(ctx, conn):
    s = premiere_seance(conn, "L2INFO")
    # La même séance au même endroit, en doublon : salle déjà occupée
    assert verifier_seance(ctx, s[1], s[2].isoformat(), s[3].strftime("%H:%M"), s[4].strftime("%H:%M"), s[5]).startswith("Refusée")
    # Pendant la pause déjeuner : refusée (CD-10 ou CD-11)
    assert "Refusée" in verifier_seance(ctx, s[1], s[2].isoformat(), "11:00", "13:00", s[5])


def test_replanification_puis_application(ctx, conn):
    # Une classe qui a cours un lundi : on lui interdit ce lundi
    classe, lundi = classe_avec_cours_un_lundi(conn)
    texte = proposer_replanification(
        ctx, f"Pas de cours de {classe} le lundi", lundi.isoformat(), (lundi + timedelta(days=6)).isoformat(),
        classes=[classe], contraintes=[{"type": "interdire", "code_classe": classe, "jours": ["Lundi"]}],
    )
    assert texte.startswith("Proposition")
    id_prop = ctx.propositions_creees[0]
    resultat = propositions.appliquer(conn, id_prop, 1)
    assert resultat["seances_creees"] > 0 and resultat["seances_supprimees"] > 0
    restantes = conn.execute(
        """SELECT count(*) FROM seance s JOIN cours c USING (id_cours) JOIN classe cl USING (id_classe)
           WHERE cl.code_classe = %s AND s.date_seance = %s""", (classe, lundi)
    ).fetchone()[0]
    assert restantes == 0
    statut = conn.execute("SELECT statut FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]
    assert statut == "appliquee"
    # Une proposition décidée ne s'applique pas deux fois
    with pytest.raises(propositions.PropositionRefusee):
        propositions.appliquer(conn, id_prop, 1)


def test_proposition_perimee(ctx, conn):
    classe, lundi = classe_avec_cours_un_lundi(conn)
    proposer_replanification(ctx, f"Décaler la {classe}", lundi.isoformat(), (lundi + timedelta(days=6)).isoformat(),
                             classes=[classe], contraintes=[{"type": "interdire", "code_classe": classe, "jours": ["Lundi"]}])
    id_prop = ctx.propositions_creees[0]
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]
    a_supprimer = [o["id_seance"] for o in ops if o["action"] == "supprimer"]
    assert a_supprimer, "la contrainte aurait dû déplacer des séances"
    conn.execute("DELETE FROM seance WHERE id_seance = %s", (a_supprimer[0],))  # l'emploi du temps change entre-temps
    with pytest.raises(propositions.PropositionRefusee, match="périmée"):
        propositions.appliquer(conn, id_prop, 1)


def test_codes_inconnus_et_priorites(ctx, conn):
    assert proposer_replanification(ctx, "x", "2026-10-12", "2026-10-18", classes=["XX"]).startswith("Demande invalide")
    proposer_priorites(ctx, [{"id_cours": 1, "priorite": 5, "justification": "Prérequis des TD d'algorithmique"}])
    assert conn.execute("SELECT priorite_suggeree FROM cours WHERE id_cours = 1").fetchone()[0] == 5


def test_execution_d_un_appel_d_outil_mal_forme(ctx):
    from app.agent import executer_outil

    outils = {o.nom: o for o in construire_outils(ctx)}
    assert "outil inconnu" in executer_outil(ctx, outils, "supprimer_tout", "{}")
    assert "JSON" in executer_outil(ctx, outils, "lire_referentiel", "{pas du json")
    assert "arguments invalides" in executer_outil(ctx, outils, "lire_referentiel", '{"sujet": "météo"}')
    assert "arguments invalides" in executer_outil(ctx, outils, "lire_referentiel", '{"sujet": "salles", "en_trop": 1}')
    assert "salle" in executer_outil(ctx, outils, "lire_referentiel", '{"sujet": "salles"}')


def test_une_seule_proposition_par_message(ctx, conn):
    classe, lundi = classe_avec_cours_un_lundi(conn)
    fin = (lundi + timedelta(days=5)).isoformat()
    proposer_replanification(ctx, "essai 1", lundi.isoformat(), fin, classes=[classe])
    premiere = ctx.propositions_creees[0]
    texte = proposer_replanification(ctx, "essai 2", lundi.isoformat(), fin, classes=[classe])
    assert f"remplace la proposition {premiere}" in texte
    assert len(ctx.propositions_creees) == 1
    statut = conn.execute("SELECT statut FROM proposition WHERE id_proposition = %s", (premiere,)).fetchone()[0]
    assert statut == "rejetee"


def test_analyse_d_impact(ctx, conn):
    classe, lundi = classe_avec_cours_un_lundi(conn)
    texte = proposer_replanification(
        ctx, "Libérer le lundi", lundi.isoformat(), (lundi + timedelta(days=5)).isoformat(),
        classes=[classe], contraintes=[{"type": "interdire", "code_classe": classe, "jours": ["Lundi"],
                                       "date_debut": lundi.isoformat(), "date_fin": lundi.isoformat()}],
    )
    assert "Conséquences :" in texte and "Enseignants à prévenir" in texte
    impact = conn.execute("SELECT impact FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert impact["seances_deplacees"] >= 1 and classe in impact["classes_concernees"]
    assert impact["enseignants_a_prevenir"] and {"heures_perdues", "fins_decalees", "journees_chargees", "changements_de_site"} <= set(impact)


def test_impact_signale_les_heures_perdues(ctx, conn):
    # Interdire toute la semaine : rien ne peut être replacé, les heures sont perdues
    classe, lundi = classe_avec_cours_un_lundi(conn)
    jours = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
    texte = proposer_replanification(ctx, "Semaine banalisée", lundi.isoformat(), (lundi + timedelta(days=5)).isoformat(),
                                     classes=[classe], contraintes=[{"type": "interdire", "code_classe": classe, "jours": jours}])
    assert "ATTENTION" in texte and "ne seraient plus programmées" in texte


def test_generation_d_une_classe_sans_seance(ctx, conn):
    # Classe vidée : le programme est calculé jusqu'à la fin du semestre puis appliqué
    conn.execute("""DELETE FROM seance WHERE id_cours IN
                    (SELECT id_cours FROM cours JOIN classe USING (id_classe) WHERE code_classe = 'M1IA')""")
    texte = proposer_generation(ctx, "Programme du M1IA", classes=["M1IA"], du="2026-11-02", au="2026-12-19")
    assert texte.startswith("Proposition") and "Période générée" in texte
    resultat = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert resultat["seances_creees"] > 0 and resultat["seances_supprimees"] == 0
    assert proposer_generation(ctx, "Tout", classes=[]).startswith("Demande invalide")


def test_generation_d_une_semaine_reporte_le_reste(ctx, conn):
    conn.execute("""DELETE FROM seance WHERE id_cours IN
                    (SELECT id_cours FROM cours JOIN classe USING (id_classe) WHERE code_classe = 'M1IA')""")
    texte = proposer_generation(ctx, "Semaine du 2 novembre du M1IA", classes=["M1IA"], du="2026-11-02", au="2026-11-04")
    assert "Période générée : du 2026-11-02 au 2026-11-07" in texte and "restent à programmer après la période" in texte
    assert "ne seraient plus programmées" not in texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()[0]
    assert ops and all("2026-11-02" <= o["apres"]["date_seance"] <= "2026-11-07" for o in ops)
