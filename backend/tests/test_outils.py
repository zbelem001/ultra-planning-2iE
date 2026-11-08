import json
import os
from datetime import date, timedelta

import psycopg
import pytest

from app import propositions
from app.outils import (
    Contexte, construire_outils, lire_emploi_du_temps, lire_referentiel, proposer_priorites, proposer_suppression_seances,
    a_valider, proposer_generation, proposer_modifications, proposer_replanification,
    proposer_reprogrammation_cours, verifier_seance,
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


# Fenêtre pour replacer les séances d'un lundi sans perdre d'heure : elle déborde sur une semaine que la génération
# des tests laisse vide (elle s'arrête au bout d'un mois). Chaque promotion reste sur son campus mère : trois
# semaines pleines ne suffisent plus toujours.
FENETRE_LIBRE = timedelta(days=33)


def classe_avec_cours_un_lundi(conn):
    return conn.execute(
        """SELECT cl.code_classe, s.date_seance FROM seance s JOIN cours c USING (id_cours) JOIN classe cl USING (id_classe)
           WHERE extract(isodow FROM s.date_seance) = 1 ORDER BY s.date_seance LIMIT 1"""
    ).fetchone()


def test_schemas_des_outils(ctx):
    outils = construire_outils(ctx)
    noms = [o.schema()["function"]["name"] for o in outils]
    assert noms == ["lire_emploi_du_temps", "lire_referentiel", "verifier_seance",
                    "proposer_replanification", "proposer_reprogrammation_cours", "proposer_generation", "proposer_modifications",
                    "proposer_suppression_seances", "proposer_epreuve", "lire_piece_jointe", "proposer_changements_referentiel", "proposer_priorites"]
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
    pas_le_lundi = [{"type": "interdire", "code_classe": classe, "jours": ["Lundi"]}]
    proposer_replanification(ctx, "essai 1", lundi.isoformat(), fin, classes=[classe], contraintes=pas_le_lundi)
    premiere = ctx.propositions_creees[0]
    texte = proposer_replanification(ctx, "essai 2", lundi.isoformat(), fin, classes=[classe], contraintes=pas_le_lundi)
    assert f"remplace la proposition {premiere}" in texte
    assert len(ctx.propositions_creees) == 1
    statut = conn.execute("SELECT statut FROM proposition WHERE id_proposition = %s", (premiere,)).fetchone()[0]
    assert statut == "rejetee"


@pytest.fixture
def cours_etale(conn, monkeypatch):
    """Un cours de la L2INFO : 2 séances la semaine du 23/11, puis 2 la semaine du 7/12 et 1 celle du 14/12.
    Nous sommes le 4/11, avant toutes ces dates."""
    class Jour(date):
        @classmethod
        def today(cls):
            return date(2026, 11, 4)
    monkeypatch.setattr("app.outils.date", Jour)
    k, salle = conn.execute(
        """SELECT c.id_cours, min(s.id_salle) FROM cours c JOIN classe cl USING (id_classe) JOIN seance s USING (id_cours)
           WHERE cl.code_classe = 'L2INFO' AND c.volume_horaire >= 12 GROUP BY c.id_cours ORDER BY c.id_cours LIMIT 1""").fetchone()
    conn.execute("DELETE FROM seance WHERE id_cours = %s", (k,))
    conn.execute("DELETE FROM disponibilite WHERE id_enseignant = (SELECT id_enseignant FROM cours WHERE id_cours = %s)", (k,))
    jours = ["2026-11-23", "2026-11-24", "2026-12-07", "2026-12-08", "2026-12-14"]
    propositions.executer_operations(conn, [
        {"action": "creer", "apres": {"id_cours": k, "date_seance": j, "heure_debut": "07:00", "heure_fin": "09:00", "id_salle": salle}}
        for j in jours], 1, 1)
    return k, salle


def seances_du_cours(conn, k):
    return [r[0] for r in conn.execute("SELECT date_seance FROM seance WHERE id_cours = %s ORDER BY 1", (k,)).fetchall()]


def test_un_calcul_sans_changement_ne_cree_pas_de_proposition(ctx, cours_etale):
    k, _ = cours_etale
    # Ce qui est après la période est signalé : « ce qui reste du cours » ne se réduit pas à la période
    texte = proposer_replanification(ctx, "Reprogrammer le reste", "2026-11-23", "2026-12-05", id_cours=[k])
    assert texte.startswith("Rien n'a changé") and ctx.propositions_creees == []
    assert "3 autre(s) séance(s) de ces cours (6 h)" in texte and "du 2026-12-07 au 2026-12-14" in texte
    assert "proposer_reprogrammation_cours" in texte


def test_reprogrammer_le_reste_d_un_cours_dans_la_periode(ctx, conn, cours_etale):
    k, _ = cours_etale
    texte = proposer_reprogrammation_cours(ctx, "Finir le cours avant décembre", [k], "2026-11-23", "2026-12-05")
    assert texte.startswith("Proposition") and "Non concernées" not in texte
    assert "6 h changent de place, 4 h déjà valides ne bougent pas" in texte
    assert "(3 séance(s))" in texte  # enseignant à prévenir : un déplacement ne compte pas double
    id_prop = ctx.propositions_creees[0]
    consequences = conn.execute("SELECT impact FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]
    # La carte montre les séances retirées et ajoutées
    assert len(consequences["seances_retirees"]) == 3 and len(consequences["seances_ajoutees"]) == 3
    assert consequences["seances_deplacees"] == 3 and consequences["restees_hors_periode"] == []
    assert consequences["seances_supprimees"] == consequences["seances_creees"] == 0  # 3 déplacements, pas 9 changements
    assert propositions.appliquer(conn, id_prop, 1)["seances_creees"] == 3
    dates = seances_du_cours(conn, k)
    assert len(dates) == 5 and dates[-1] <= date(2026, 12, 5)


def test_reprogrammer_ramene_aussi_ce_qui_est_avant_la_periode(ctx, conn, cours_etale):
    k, _ = cours_etale
    proposer_reprogrammation_cours(ctx, "Commencer en décembre", [k], "2026-12-07", "2026-12-19")
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    dates = seances_du_cours(conn, k)
    assert len(dates) == 5 and dates[0] >= date(2026, 12, 7)


def test_les_heures_jamais_programmees_sont_signalees(ctx, conn, cours_etale):
    k, _ = cours_etale
    conn.execute("UPDATE cours SET volume_horaire = 16 WHERE id_cours = %s", (k,))
    texte = proposer_reprogrammation_cours(ctx, "Finir le cours", [k], "2026-11-23", "2026-12-05")
    assert f"Jamais programmées : 6 h du cours {k} (volume 16 h)" in texte and "proposer_generation avec matieres" in texte


def test_une_seance_sans_place_reste_ou_elle_est(ctx, conn, cours_etale):
    k, _ = cours_etale
    conn.execute("UPDATE cours SET heures_semaine_min = 2, heures_semaine_max = 4 WHERE id_cours = %s", (k,))
    texte = proposer_reprogrammation_cours(ctx, "Finir le cours avant décembre", [k], "2026-11-23", "2026-12-05")
    assert "1 séance(s) n'ont pas de place dans la période" in texte and "rythme maximal" in texte
    id_prop = ctx.propositions_creees[0]
    consequences = conn.execute("SELECT impact FROM proposition WHERE id_proposition = %s", (id_prop,)).fetchone()[0]
    assert [x["date"] for x in consequences["restees_hors_periode"]] == ["2026-12-14"] and consequences["heures_perdues"] == []
    propositions.appliquer(conn, id_prop, 1)
    dates = seances_du_cours(conn, k)
    assert len(dates) == 5 and dates[-1] == date(2026, 12, 14) and dates[-2] <= date(2026, 12, 5)  # aucune heure perdue


def test_reprogrammer_verifie_le_cours_et_ne_va_pas_dans_le_passe(ctx, conn, cours_etale):
    k, _ = cours_etale
    assert proposer_reprogrammation_cours(ctx, "x", [999999], "2026-11-23", "2026-12-05").startswith("Demande invalide")
    # Période commencée : rien avant demain, même si la semaine a débuté lundi (semaine libérée pour la L2INFO)
    conn.execute("""DELETE FROM seance s USING cours c, classe cl WHERE c.id_cours = s.id_cours AND cl.id_classe = c.id_classe
                    AND cl.code_classe = 'L2INFO' AND s.date_seance BETWEEN '2026-11-02' AND '2026-11-07'""")
    proposer_reprogrammation_cours(ctx, "x", [k], "2026-11-04", "2026-11-07")
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert all(o["apres"]["date_seance"] > "2026-11-04" for o in ops if o["action"] == "creer")


def test_un_changement_de_seances_attend_la_validation(edt_a_remettre, ctx, conn):
    """L'assistant n'écrit rien : sa proposition attend le planificateur, puis s'écrit dans la version à jour."""
    from app.agent import executer_outil
    from app.db import origine

    classe, lundi = classe_avec_cours_un_lundi(conn)
    compter = lambda: conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1 AND date_seance = %s", (lundi,)).fetchone()[0]  # noqa: E731
    statut = lambda i: conn.execute("SELECT statut FROM proposition WHERE id_proposition = %s", (i,)).fetchone()[0]  # noqa: E731
    avant = compter()
    outils = {o.nom: o for o in construire_outils(ctx)}
    # Assez de place pour replacer les séances de ce seul lundi : aucune heure perdue, et pourtant rien n'est appliqué
    texte = executer_outil(ctx, outils, "proposer_replanification", json.dumps({
        "description": "Libérer le lundi", "du": lundi.isoformat(), "au": (lundi + FENETRE_LIBRE).isoformat(), "classes": [classe],
        "contraintes": [{"type": "interdire", "code_classe": classe, "date_debut": lundi.isoformat(), "date_fin": lundi.isoformat()}]}))
    id_prop = ctx.propositions_creees[0]
    assert texte.startswith(f"Proposition {id_prop} calculée"), texte
    assert f"En attente de validation : la proposition {id_prop} n'est pas appliquée" in texte, texte
    assert statut(id_prop) == "en_attente" and compter() == avant
    # Validée par le planificateur (bouton Valider) : écrite dans la version à jour, avec son motif dans l'historique
    origine(conn, "assistant")
    propositions.appliquer(conn, id_prop, 1)
    assert statut(id_prop) == "appliquee" and compter() < avant
    conn.execute("RESET ROLE")  # l'historique ne se lit que par l'API (propriétaire), dans la même transaction
    origine_, note = conn.execute("SELECT origine, note FROM journal_seance WHERE id_edt = 1 ORDER BY date_action DESC, id_journal DESC LIMIT 1").fetchone()
    assert origine_ == "assistant" and note.startswith("Assistant IA : Libérer le lundi")


def test_ce_qui_perd_des_heures_attend_aussi_la_validation(ctx, conn):
    from app.agent import executer_outil

    classe, lundi = classe_avec_cours_un_lundi(conn)
    outils = {o.nom: o for o in construire_outils(ctx)}
    avant = conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0]
    texte = executer_outil(ctx, outils, "proposer_replanification", json.dumps({
        "description": "Semaine banalisée", "du": lundi.isoformat(), "au": (lundi + timedelta(days=5)).isoformat(), "classes": [classe],
        "contraintes": [{"type": "interdire", "code_classe": classe, "jours": ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]}]}))
    assert "En attente de validation" in texte and "ne seraient plus programmées" in texte, texte
    assert conn.execute("SELECT statut FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0] == "en_attente"
    assert conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0] == avant


def test_a_valider_ne_parle_que_d_une_proposition_en_attente(ctx, conn):
    assert a_valider(ctx) is None
    classe, lundi = classe_avec_cours_un_lundi(conn)
    proposer_replanification(ctx, "x", lundi.isoformat(), (lundi + FENETRE_LIBRE).isoformat(), classes=[classe],
                             contraintes=[{"type": "interdire", "code_classe": classe, "date_debut": lundi.isoformat(), "date_fin": lundi.isoformat()}])
    id_prop = ctx.propositions_creees[0]
    assert a_valider(ctx).startswith(f"En attente de validation : la proposition {id_prop}")
    propositions.rejeter(conn, id_prop, 1)
    assert a_valider(ctx) is None


def test_un_deplacement_n_est_pas_annonce_sans_changement(ctx, conn, cours_etale):
    k, salle = cours_etale
    id_seance = conn.execute("SELECT id_seance FROM seance WHERE id_cours = %s AND date_seance = '2026-12-14'", (k,)).fetchone()[0]
    texte = proposer_modifications(ctx, "Décaler", [{"action": "deplacer", "id_seance": id_seance, "date_seance": "2026-12-15",
                                                    "heure_debut": "07:00", "heure_fin": "09:00", "id_salle": salle}])
    assert texte.startswith("Proposition") and "1 séance(s) déplacée(s)" in texte and "Aucun changement" not in texte


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
    # Une semaine à venir (la génération ne programme jamais dans le passé)
    lundi = date.today() - timedelta(days=date.today().weekday()) + timedelta(weeks=2)
    samedi = lundi + timedelta(days=5)
    texte = proposer_generation(ctx, "Une semaine du M1IA", classes=["M1IA"], du=lundi.isoformat(),
                                au=(lundi + timedelta(days=2)).isoformat())
    assert f"Période générée : du {lundi} au {samedi}" in texte and "restent à programmer après la période" in texte
    assert "ne seraient plus programmées" not in texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()[0]
    assert ops and all(lundi.isoformat() <= o["apres"]["date_seance"] <= samedi.isoformat() for o in ops)


def test_generation_de_certains_modules(ctx, conn):
    """« Programme Bases de données pour la L2INFO » : seuls les cours de cette matière."""
    bd = {r[0] for r in conn.execute(
        "SELECT id_cours FROM cours JOIN matiere USING (id_matiere) JOIN classe USING (id_classe) "
        "WHERE code_matiere = 'BD' AND code_classe = 'L2INFO'")}
    texte = proposer_generation(ctx, "BD de la L2INFO", classes=["L2INFO"], du="2026-11-02", au="2026-11-28",
                                matieres=["bases de donnees"])
    assert texte.startswith("Proposition"), texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()[0]
    assert ops and {o.get("apres", o.get("avant"))["id_cours"] for o in ops} <= bd


def test_modules_pas_prets(ctx):
    # Matière inconnue : rien de créé, et la liste des matières de la classe
    texte = proposer_generation(ctx, "x", classes=["L2INFO"], matieres=["Big Data"])
    assert texte.startswith("Rien à générer") and "introuvable" in texte and "Algorithmique" in texte
    assert ctx.propositions_creees == []
    # Matière existante mais hors du programme de la classe (CD-07)
    assert "n'est pas au programme de L2INFO" in proposer_generation(ctx, "x", classes=["L2INFO"], matieres=["WEB"])
    # Au programme mais sans cours (M2IA : programme d'apprentissage automatique, aucun cours)
    assert "n'a encore aucun cours" in proposer_generation(ctx, "x", classes=["M2IA"], matieres=["ML"])
    # Un module prêt et un autre non : proposition pour le premier, explication pour le second
    texte = proposer_generation(ctx, "x", classes=["L2INFO"], du="2026-11-02", au="2026-11-07", matieres=["BD", "Big Data"])
    assert texte.startswith("Proposition") and "Modules non programmés" in texte and "Big Data" in texte


def deplacer_quelque_part(ctx, s):
    """Déplace la séance s à une semaine libre plus loin ; renvoie le texte de l'outil."""
    for semaines in range(1, 10):
        texte = proposer_modifications(ctx, "Report d'une séance", [
            {"action": "deplacer", "id_seance": s[0], "date_seance": (s[2] + timedelta(weeks=semaines)).isoformat()}])
        if texte.startswith("Proposition"):
            return texte
    pytest.fail(texte)


def test_modifications_ponctuelles(ctx, conn):
    s = premiere_seance(conn, "L2INFO")
    texte = deplacer_quelque_part(ctx, s)
    assert "déplacement : séance" in texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s",
                       (ctx.propositions_creees[0],)).fetchone()[0]
    nouvelle_date = ops[0]["apres"]["date_seance"]
    # Rien n'est écrit tant que la proposition n'est pas appliquée
    assert conn.execute("SELECT date_seance FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0] == s[2]
    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["seances_modifiees"] == 1
    ligne = conn.execute("SELECT date_seance, heure_debut, heure_fin FROM seance WHERE id_seance = %s", (s[0],)).fetchone()
    assert (ligne[0].isoformat(), ligne[1], ligne[2]) == (nouvelle_date, s[3], s[4])  # même durée, mêmes heures

    # Annuler puis rétablir
    proposer_modifications(ctx, "Annulation", [{"action": "annuler", "id_seance": s[0]}])
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT statut FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0] == "annulee"
    impact = conn.execute("SELECT impact FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert impact["seances_supprimees"] == 1 and impact["classes_concernees"] == ["L2INFO"]
    proposer_modifications(ctx, "Rétablissement", [{"action": "retablir", "id_seance": s[0]}])
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT statut FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0] == "planifiee"


def test_modifications_refusees_par_la_base(ctx, conn):
    s = premiere_seance(conn, "L2INFO")
    # Ajouter une séance par-dessus une autre, dans la même salle : refusé, aucune proposition
    texte = proposer_modifications(ctx, "Doublon", [{"action": "ajouter", "id_cours": s[1], "date_seance": s[2].isoformat(),
                                                    "heure_debut": s[3].strftime("%H:%M"), "heure_fin": s[4].strftime("%H:%M"),
                                                    "id_salle": s[5]}])
    assert "Aucune proposition créée" in texte and ctx.propositions_creees == []
    assert proposer_modifications(ctx, "x", [{"action": "annuler", "id_seance": 999999}]).startswith("Demande invalide")
    assert "il manque" in proposer_modifications(ctx, "x", [{"action": "ajouter", "id_cours": s[1]}])
    assert "rien ne change" in proposer_modifications(ctx, "x", [{"action": "deplacer", "id_seance": s[0]}])


def test_modification_perimee(ctx, conn):
    s = premiere_seance(conn, "L2INFO")
    deplacer_quelque_part(ctx, s)
    conn.execute("UPDATE seance SET statut = 'annulee' WHERE id_seance = %s", (s[0],))  # changée entre-temps
    with pytest.raises(propositions.PropositionRefusee, match="périmée"):
        propositions.appliquer(conn, ctx.propositions_creees[0], 1)


def test_enseignant_par_seance(ctx, conn):
    s = premiere_seance(conn, "L2INFO")
    prevu = conn.execute("SELECT id_enseignant FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0]
    assert prevu is not None  # reprise de l'enseignant prévu du cours à la génération
    # Un autre enseignant, libre sur cette plage
    autre, matricule = conn.execute(
        """SELECT e.id_enseignant, e.matricule FROM enseignant e WHERE e.id_enseignant <> %s AND NOT EXISTS (
               SELECT 1 FROM seance x WHERE x.id_edt = 1 AND x.id_enseignant = e.id_enseignant AND x.statut <> 'annulee'
                 AND x.date_seance = %s AND x.heure_debut < %s AND x.heure_fin > %s)
             AND NOT EXISTS (SELECT 1 FROM disponibilite d WHERE d.id_enseignant = e.id_enseignant AND d.niveau = 'indisponible')
             AND e.statut <> 'externe' ORDER BY e.id_enseignant LIMIT 1""", (prevu, s[2], s[4], s[3])).fetchone()
    texte = proposer_modifications(ctx, "Remplaçant", [{"action": "changer_enseignant", "id_seance": s[0], "matricule": matricule}])
    assert texte.startswith("Proposition") and "changement d'enseignant" in texte, texte
    impact = conn.execute("SELECT impact FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert len(impact["enseignants_a_prevenir"]) == 2 and impact["seances_deplacees"] == 0  # l'ancien et le nouveau
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT id_enseignant FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0] == autre
    # Le cours garde son enseignant prévu
    assert conn.execute("SELECT id_enseignant FROM cours WHERE id_cours = %s", (s[1],)).fetchone()[0] == prevu

    # Retirer l'enseignant : la séance est « à désigner »
    proposer_modifications(ctx, "Sans enseignant", [{"action": "changer_enseignant", "id_seance": s[0], "matricule": ""}])
    propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT id_enseignant FROM seance WHERE id_seance = %s", (s[0],)).fetchone()[0] is None
    assert "enseignant à désigner" in lire_emploi_du_temps(ctx, s[2].isoformat(), s[2].isoformat(), code_classe="L2INFO")


def test_controles_d_enseignant_dans_la_base(conn):
    import psycopg

    a, b = conn.execute(
        """SELECT a.id_seance, b.id_seance FROM seance a JOIN seance b ON b.id_edt = a.id_edt AND b.date_seance = a.date_seance
           AND b.id_seance <> a.id_seance AND b.heure_debut < a.heure_fin AND b.heure_fin > a.heure_debut
           AND b.id_enseignant <> a.id_enseignant WHERE a.id_edt = 1 LIMIT 1""").fetchone()
    # CD-02 : l'enseignant de la séance b ne peut pas aussi animer la séance a, en même temps
    with pytest.raises(psycopg.errors.CheckViolation, match="CD-02"), conn.transaction():
        conn.execute("UPDATE seance SET id_enseignant = (SELECT id_enseignant FROM seance WHERE id_seance = %s) WHERE id_seance = %s", (b, a))
    # Sans enseignant : aucun contrôle d'enseignant
    with conn.transaction():
        conn.execute("UPDATE seance SET id_enseignant = NULL WHERE id_seance IN (%s, %s)", (a, b))
    # Un cours peut n'avoir aucun enseignant prévu, et il n'y a plus d'habilitations
    conn.execute("UPDATE cours SET id_enseignant = NULL WHERE id_cours = (SELECT id_cours FROM seance WHERE id_seance = %s)", (a,))
    assert conn.execute("SELECT to_regclass('habilitation')").fetchone()[0] is None


# --- suppression de séances par critères --------------------------------------------

DU, AU = "2026-10-12", "2027-02-19"


def seances_de(conn, classe):
    """(id_seance, date, début, id_cours, matière, type) des séances non annulées de la classe, dans l'ordre."""
    return conn.execute(
        """SELECT s.id_seance, s.date_seance, s.heure_debut, s.id_cours, m.code_matiere, c.type_cours
           FROM seance s JOIN cours c USING (id_cours) JOIN matiere m USING (id_matiere) JOIN classe cl ON cl.id_classe = c.id_classe
           WHERE s.id_edt = 1 AND cl.code_classe = %s AND s.statut <> 'annulee' ORDER BY 2, 3""", (classe,)).fetchall()


def operations_proposees(conn, ctx):
    return conn.execute("SELECT modifications, impact FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()


def test_suppression_par_criteres(ctx, conn):
    seances = seances_de(conn, "L2INFO")
    matiere, type_cours = seances[0][4], seances[0][5]
    attendues = {s[0] for s in seances if s[4] == matiere and s[5] == type_cours}
    n_total = conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0]

    texte = proposer_suppression_seances(ctx, "Retrait", code_classe="L2INFO", code_matiere=matiere, type_cours=type_cours, du=DU, au=AU)
    assert texte.startswith("Proposition"), texte
    assert f"{len(attendues)} séance(s) à supprimer" in texte
    ops, consequences = operations_proposees(conn, ctx)
    assert {o["id_seance"] for o in ops} == attendues and all(o["action"] == "supprimer" for o in ops)
    # Rien n'est écrit avant validation, et la carte dit quelles séances partent
    assert conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0] == n_total
    assert consequences["seances_supprimees"] == len(attendues) == len(consequences["seances_retirees"])
    assert "L2INFO" in consequences["seances_retirees"][0] and consequences["heures_retirees"] > 0

    r = propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert r["seances_supprimees"] == len(attendues)
    assert conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0] == n_total - len(attendues)


def test_suppression_autres_criteres(ctx, conn):
    seances = seances_de(conn, "L2INFO")
    jour = seances[0][1]
    # Une seule journée de l'emploi du temps de la classe
    assert proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour.isoformat(), au=jour.isoformat()).startswith("Proposition")
    ops, _ = operations_proposees(conn, ctx)
    assert {o["id_seance"] for o in ops} == {s[0] for s in seances if s[1] == jour}
    # Les matins seulement, ce jour-là (une nouvelle proposition remplace la précédente)
    proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour.isoformat(), au=jour.isoformat(), heure_max="12:00")
    ops, _ = operations_proposees(conn, ctx)
    assert ops and all(o["avant"]["heure_debut"] < "12:00" for o in ops)
    assert {o["id_seance"] for o in ops} == {s[0] for s in seances if s[1] == jour and s[2].hour < 12}
    # Un jour de la semaine
    noms = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
    proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=DU, au=AU, jours=[noms[jour.weekday()]])
    ops, _ = operations_proposees(conn, ctx)
    assert {o["id_seance"] for o in ops} == {s[0] for s in seances if s[1].weekday() == jour.weekday()}
    # Des séances précises
    proposer_suppression_seances(ctx, "x", id_seances=[seances[0][0], seances[1][0]])
    ops, _ = operations_proposees(conn, ctx)
    assert {o["id_seance"] for o in ops} == {seances[0][0], seances[1][0]}
    # L'emploi du temps d'une salle ou d'un enseignant
    salle, matricule = conn.execute(
        """SELECT sa.code_salle, e.matricule FROM seance s JOIN salle sa USING (id_salle) JOIN enseignant e USING (id_enseignant)
           WHERE s.id_seance = %s""", (seances[0][0],)).fetchone()
    assert proposer_suppression_seances(ctx, "x", code_salle=salle, du=DU, au=AU).startswith("Proposition")
    assert all(conn.execute("SELECT code_salle FROM seance JOIN salle USING (id_salle) WHERE id_seance = %s", (o["id_seance"],)).fetchone()[0] == salle
               for o in operations_proposees(conn, ctx)[0])
    assert proposer_suppression_seances(ctx, "x", matricule=matricule, du=DU, au=AU).startswith("Proposition")


def test_suppression_refusee_ou_vide(ctx, conn):
    assert "précisez l'emploi du temps" in proposer_suppression_seances(ctx, "x", du=DU, au=AU)
    assert "ZZZ" in proposer_suppression_seances(ctx, "x", code_classe="ZZZ") and ctx.propositions_creees == []
    assert "Demande invalide" in proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du="12/10/2026")
    assert "Demande invalide" in proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=DU, heure_min="matin")
    assert "introuvable" in proposer_suppression_seances(ctx, "x", id_seances=[999999999])
    # Aucune séance : pas de proposition, et le rappel que la recherche part d'aujourd'hui sans date
    assert proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du="2027-02-15", au="2027-02-19").startswith("Aucune séance")
    assert ctx.propositions_creees == []
    # Sans date de début, les séances passées restent
    texte = proposer_suppression_seances(ctx, "x", code_classe="L2INFO")
    if texte.startswith("Proposition"):
        assert all(o["avant"]["date_seance"] >= "2026-11-01" for o in operations_proposees(conn, ctx)[0])
    else:
        assert "pour inclure les séances passées" in texte


def test_les_seances_verrouillees_restent_sans_confirmation(ctx, conn):
    seances = seances_de(conn, "L2INFO")
    jour = seances[0][1]
    du_jour = [s[0] for s in seances if s[1] == jour]
    conn.execute("UPDATE seance SET est_verrouillee = TRUE WHERE id_seance = %s", (du_jour[0],))

    texte = proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour.isoformat(), au=jour.isoformat())
    if len(du_jour) > 1:
        assert "verrouillée(s) laissée(s) en place" in texte
        assert du_jour[0] not in {o["id_seance"] for o in operations_proposees(conn, ctx)[0]}
    # Toutes verrouillées : rien à proposer
    ctx.propositions_creees.clear()
    conn.execute("UPDATE seance SET est_verrouillee = TRUE WHERE id_seance = ANY(%s)", (du_jour,))
    texte = proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour.isoformat(), au=jour.isoformat())
    assert "que" in texte and "verrouillée" in texte and ctx.propositions_creees == []
    # Confirmation du planificateur
    assert proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour.isoformat(), au=jour.isoformat(),
                                        inclure_verrouillees=True).startswith("Proposition")
    assert {o["id_seance"] for o in operations_proposees(conn, ctx)[0]} == set(du_jour)
    # Une séance verrouillée ne se retire pas non plus une par une
    assert "verrouillée" in proposer_modifications(ctx, "x", [{"action": "supprimer", "id_seance": du_jour[0]}])


def test_classe_d_un_cours_mutualise(ctx, conn):
    """L'emploi du temps d'une classe comprend les cours qu'elle partage ; on le signale."""
    s = seances_de(conn, "L2INFO")[0]
    id_classe = conn.execute("SELECT id_classe FROM classe WHERE code_classe = 'M2IA'").fetchone()[0]
    conn.execute("INSERT INTO cours_public (id_cours, id_classe) VALUES (%s, %s)", (s[3], id_classe))
    assert s[0] in {int(l.split()[1]) for l in lire_emploi_du_temps(ctx, s[1].isoformat(), s[1].isoformat(), code_classe="M2IA").splitlines()}
    texte = proposer_suppression_seances(ctx, "x", code_classe="M2IA", du=s[1].isoformat(), au=s[1].isoformat())
    assert "mutualisés" in texte and s[0] in {o["id_seance"] for o in operations_proposees(conn, ctx)[0]}


def test_une_proposition_perimee_ne_supprime_rien(ctx, conn):
    a, b = seances_de(conn, "L2INFO")[:2]
    proposer_suppression_seances(ctx, "x", id_seances=[a[0], b[0]])
    conn.execute("DELETE FROM seance WHERE id_seance = %s", (a[0],))
    with pytest.raises(propositions.PropositionRefusee, match="périmée"):
        propositions.appliquer(conn, ctx.propositions_creees[0], 1)
    assert conn.execute("SELECT count(*) FROM seance WHERE id_seance = %s", (b[0],)).fetchone()[0] == 1
