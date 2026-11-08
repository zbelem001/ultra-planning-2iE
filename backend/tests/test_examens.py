"""Examens et rattrapages : règles de la base, publication, historique, génération, assistant."""

from datetime import date, time

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import config, propositions, publication
from app.main import app
from app.outils import Contexte, proposer_epreuve, proposer_suppression_seances

ADMIN = {"X-Utilisateur": "2"}
# Semaine sans cours générés dans les tests (la génération s'arrête au bout d'un mois)
LUNDI, MARDI, MERCREDI = "2026-11-23", "2026-11-24", "2026-11-25"


def cours_de(c, classe, matiere=None):
    row = c.execute(
        """SELECT co.id_cours FROM cours co JOIN classe cl ON cl.id_classe = co.id_classe JOIN matiere m USING (id_matiere)
           WHERE cl.code_classe = %s AND (%s::text IS NULL OR m.code_matiere = %s) ORDER BY co.id_groupe IS NOT NULL, co.id_cours LIMIT 1""",
        (classe, matiere, matiere)).fetchone()
    return row[0]


def salle(c, code):
    return c.execute("SELECT id_salle FROM salle WHERE code_salle = %s", (code,)).fetchone()[0]


def poser(c, id_cours, jour, debut="07:00", fin="10:00", id_salle=None, nature="examen", enseignant=None):
    d = date.fromisoformat(jour)
    noms = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
    cr = c.execute("SELECT id_creneau FROM creneau WHERE jour = %s AND heure_debut = %s", (noms[d.weekday()], debut)).fetchone()[0]
    with c.transaction():
        return c.execute(
            """INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_enseignant, id_salle, id_creneau, nature, id_edt)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1) RETURNING id_seance""",
            (d, debut, fin, id_cours, enseignant, id_salle or salle(c, "K-AMPHI1"), cr, nature)).fetchone()[0]


def refuse(c, motif, *a, **k):
    with pytest.raises(psycopg.errors.Error) as e:
        poser(c, *a, **k)
    assert motif in str(e.value), str(e.value)


def test_duree_et_enseignant(conn):
    k = cours_de(conn, "L2INFO")
    refuse(conn, "ck_seance_epreuve_duree", k, LUNDI, "07:00", "11:00")  # 4 h : refusé pour une épreuve
    refuse(conn, "seance", k, LUNDI, "07:00", "08:00")                   # 1 h
    ens = conn.execute("SELECT min(e.id_enseignant) FROM enseignant e WHERE e.statut = 'permanent' "
                       "AND NOT EXISTS (SELECT 1 FROM disponibilite d WHERE d.id_enseignant = e.id_enseignant)").fetchone()[0]
    refuse(conn, "ck_seance_epreuve_sans_enseignant", k, LUNDI, enseignant=ens)
    assert poser(conn, k, LUNDI, "07:00", "09:00") and poser(conn, k, MARDI, "07:00", "10:00")


def test_une_seance_de_cours_dure_jusqu_a_5_h(conn):
    """Une matinée entière (7h-12h) se pose à la main ; au-delà de 5 h, la contrainte ck_seance_duree refuse"""
    k = cours_de(conn, "L2INFO")
    conn.execute("UPDATE programme p SET volume_cm = volume_cm + 10, volume_td = volume_td + 10, volume_tp = volume_tp + 10 "
                 "FROM cours c WHERE c.id_cours = %s AND p.id_classe = c.id_classe AND p.id_matiere = c.id_matiere", (k,))
    conn.execute("UPDATE cours SET volume_horaire = volume_horaire + 10 WHERE id_cours = %s", (k,))
    assert poser(conn, k, LUNDI, "07:00", "12:00", nature="cours")
    with conn.transaction():
        # sans les déclencheurs (rôle de connexion, propriétaire de la base de test) : la seule contrainte de durée
        conn.execute("SET LOCAL ROLE NONE; SET LOCAL session_replication_role = replica")
        refuse(conn, "ck_seance_duree", k, MARDI, "07:00", "13:00", nature="cours")


def test_une_epreuve_ne_compte_pas_dans_les_volumes(conn):
    k = cours_de(conn, "L2INFO")
    # Volume du cours déjà atteint : l'épreuve passe quand même
    conn.execute("UPDATE cours SET volume_horaire = (SELECT greatest(coalesce(sum(EXTRACT(EPOCH FROM heure_fin - heure_debut)) / 3600, 0), 1) "
                 "FROM seance WHERE id_cours = %s AND id_edt = 1 AND statut <> 'annulee'), heures_semaine_max = 2 WHERE id_cours = %s", (k, k))
    assert poser(conn, k, LUNDI)
    # Une 4e matière dans la semaine n'est pas refusée (CD-13) quand c'est une épreuve
    autres = [r[0] for r in conn.execute(
        """SELECT DISTINCT ON (co.id_matiere) co.id_cours FROM cours co JOIN classe cl ON cl.id_classe = co.id_classe
           WHERE cl.code_classe = 'L2INFO' AND co.id_groupe IS NULL ORDER BY co.id_matiere""").fetchall()]
    conn.execute("UPDATE contrainte SET valeur = 0.5 WHERE id_edt = 1 AND type_contrainte = 'CD-13'")
    assert all(poser(conn, x, MERCREDI, h, f"{int(h[:2]) + 2:02d}:00") for x, h in zip(autres, ["07:00", "09:00"]))


def test_ordre_examen_puis_rattrapage(conn):
    k = cours_de(conn, "L2INFO")
    refuse(conn, "EXAMEN", k, LUNDI, nature="rattrapage")     # pas d'examen avant
    examen = poser(conn, k, MARDI)
    refuse(conn, "EXAMEN", k, LUNDI, nature="rattrapage")     # avant l'examen
    rattrapage = poser(conn, k, MERCREDI, nature="rattrapage")
    refuse(conn, "EXAMEN", k, "2026-11-26")                   # un examen après le rattrapage
    # L'examen ne se retire ni ne s'annule tant que son rattrapage existe
    for ordre in ("DELETE FROM seance WHERE id_seance = %s", "UPDATE seance SET statut = 'annulee' WHERE id_seance = %s"):
        with pytest.raises(psycopg.errors.CheckViolation, match="rattrapage"):
            with conn.transaction():
                conn.execute(ordre, (examen,))
    conn.execute("DELETE FROM seance WHERE id_seance = %s", (rattrapage,))
    conn.execute("DELETE FROM seance WHERE id_seance = %s", (examen,))


def test_deux_classes_dans_la_meme_salle(conn):
    amphi = salle(conn, "K-AMPHI2")   # 120 places ; L2INFO 80, M1IA 30, L3INFO 60
    assert poser(conn, cours_de(conn, "L2INFO"), LUNDI, id_salle=amphi)
    assert poser(conn, cours_de(conn, "M1IA"), LUNDI, id_salle=amphi)
    refuse(conn, "CD-04", cours_de(conn, "L3INFO"), LUNDI, id_salle=amphi)  # 170 pour 120 places
    # Jamais avec un cours, dans un sens comme dans l'autre
    k = cours_de(conn, "L3INFO")
    conn.execute("UPDATE cours SET id_type_salle = NULL WHERE id_cours = %s", (k,))  # seule la salle occupée peut refuser
    conn.execute("DELETE FROM seance WHERE id_cours = %s", (k,))                     # et non le volume du cours
    refuse(conn, "ex_seance_salle_epreuve", k, LUNDI, id_salle=amphi, nature="cours")
    salle_cours = salle(conn, "K-AMPHI1")
    assert poser(conn, k, MARDI, "07:00", "09:00", salle_cours, nature="cours")
    refuse(conn, "ex_seance_salle_epreuve", cours_de(conn, "M1IA"), MARDI, id_salle=salle_cours)


def test_toute_la_classe_compose(conn):
    # Épreuve rattachée au cours d'un seul groupe : toute la classe est prise, effectif compris
    g = conn.execute(
        """SELECT co.id_cours FROM cours co JOIN classe cl ON cl.id_classe = co.id_classe
           WHERE cl.code_classe = 'L2INFO' AND co.id_groupe IS NOT NULL ORDER BY 1 LIMIT 1""").fetchone()[0]
    entiere = cours_de(conn, "L2INFO")
    assert poser(conn, g, LUNDI, id_salle=salle(conn, "K-AMPHI1"))
    refuse(conn, "CD-03", entiere, LUNDI, "08:00", "10:00", salle(conn, "K-AMPHI2"), nature="cours")
    refuse(conn, "CD-04", g, MARDI, id_salle=salle(conn, "K-B201"))  # 40 places pour les 80 de la classe


def test_conge_d_examens(conn):
    k = cours_de(conn, "L2INFO")
    conn.execute("UPDATE cours SET volume_horaire = volume_horaire WHERE id_cours = %s", (k,))
    assert poser(conn, k, "2027-02-15")                       # période d'examens : ouverte aux épreuves
    refuse(conn, "CD-09", k, "2027-02-16", nature="cours")    # fermée aux cours
    refuse(conn, "CD-09", k, "2026-12-22")                    # des vacances restent fermées


@pytest.fixture
def client(edt_a_remettre, monkeypatch):
    envois: list = []
    monkeypatch.setattr(publication, "planifier", envois.extend)
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.exemple.org")
    monkeypatch.setattr(config, "SMTP_FROM", "scolarite@exemple.org")
    t = TestClient(app)
    t.envois = envois
    return t


def app_conn():
    c = psycopg.connect(config.DATABASE_URL)
    c.execute("SELECT set_config('app.id_ecole', '1', false), set_config('app.id_utilisateur', '2', false), "
              "set_config('app.origine', 'console', false), set_config('role', 'ultraplanning_app', false)")
    return c


def test_publication_et_invites_sans_e_mail(client):
    assert client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).status_code == 200
    client.envois.clear()
    with app_conn() as c:
        k = cours_de(c, "L2INFO")
        poser(c, k, LUNDI)
    r = client.post("/api/emplois-du-temps/1/publier", headers=ADMIN).json()
    assert r["ajoutees"] == 1 and client.envois == []  # pas d'enseignant : personne à prévenir
    p = client.get("/api/base/public?ecole=2IE").json()["seance"]
    assert sum(s["nature"] == "examen" for s in p) == 1


def test_historique_et_restauration(client):
    with app_conn() as c:
        k = cours_de(c, "L2INFO")
        examen = poser(c, k, MARDI)
    v = client.get("/api/emplois-du-temps/1/versions", headers=ADMIN).json()
    assert v["versions"][0]["titre"].startswith("Ajout : Examen · ")
    numero = v["total"]
    with app_conn() as c:
        rattrapage = poser(c, k, MERCREDI, nature="rattrapage")
        c.execute("DELETE FROM seance WHERE id_seance = %s", (rattrapage,))
        c.execute("DELETE FROM seance WHERE id_seance = %s", (examen,))
    r = client.post(f"/api/emplois-du-temps/1/versions/{numero}/restaurer", headers=ADMIN, json={"appliquer": True}).json()
    assert r["ajoutees"] == 1 and r["refusees"] == 0
    s = client.get(f"/api/emplois-du-temps/1/versions/{numero}", headers=ADMIN).json()["seances"]
    assert [x["id_seance"] for x in s if x["nature"] == "examen"] == [examen]
    with psycopg.connect(config.DATABASE_URL) as c:
        assert c.execute("SELECT nature, id_enseignant FROM seance WHERE id_seance = %s", (examen,)).fetchone() == ("examen", None)


def test_la_generation_ne_touche_pas_aux_epreuves_et_les_contourne(edt_a_remettre):
    from ultraplanning_solver import Demande, generer
    from ultraplanning_solver.base import charger, enregistrer

    with app_conn() as c:
        k = cours_de(c, "L2INFO")
        amphi = salle(c, "K-AMPHI2")
        examen = poser(c, k, LUNDI, id_salle=amphi)
        avant_volume = c.execute("SELECT count(*) FROM seance WHERE id_edt = 1 AND nature = 'cours'").fetchone()[0]
    with psycopg.connect(config.DATABASE_URL) as c:
        d = charger(c, 1)
        assert [x.id_seance for x in d.examens] == [examen] and all(x.id_seance != examen for x in d.seances)
        # Toute la semaine de l'épreuve : le lundi matin, ni L2INFO ni l'amphi
        r = generer(d, Demande(du=date(2026, 11, 23), au=date(2026, 11, 28), temps_max_placement=3, temps_amelioration=2, essais=2, processus=1))
        assert all(s.id_salle != amphi or s.date_seance != date(2026, 11, 23) or s.heure_debut >= time(10) for s in r.seances)
        conflit = [s for s in r.seances if s.date_seance == date(2026, 11, 23) and s.heure_debut < time(10)
                   and d.cours[s.id_cours].id_classe == d.cours[k].id_classe]
        assert not conflit and r.seances
        assert not r.statistiques.get("violations")
        enregistrer(c, 1, r)   # la base accepte, l'épreuve est toujours là
        assert c.execute("SELECT count(*) FROM seance WHERE id_seance = %s", (examen,)).fetchone()[0] == 1
        assert avant_volume >= 0


@pytest.fixture
def ctx(conn):
    id_conv = conn.execute("INSERT INTO conversation (titre, id_utilisateur, id_edt) VALUES ('t', 1, 1) RETURNING id_conversation").fetchone()[0]
    p = conn.execute("INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES ('t', 1, 1, %s) RETURNING id_prompt", (id_conv,)).fetchone()[0]
    return Contexte(conn, 1, p, [])


def test_assistant_programme_une_epreuve(ctx, conn):
    matiere = conn.execute("SELECT m.code_matiere FROM cours co JOIN matiere m USING (id_matiere) WHERE co.id_cours = %s",
                           (cours_de(conn, "L2INFO"),)).fetchone()[0]
    # Sans salle : la plus petite assez grande (80 étudiants)
    texte = proposer_epreuve(ctx, "Examen", "L2INFO", matiere, MARDI, "07:00", "10:00")
    assert texte.startswith("Proposition"), texte
    ops, impact = conn.execute("SELECT modifications, impact FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()
    assert ops[0]["apres"]["nature"] == "examen" and ops[0]["apres"]["id_enseignant"] is None
    capacite = conn.execute("SELECT capacite FROM salle WHERE id_salle = %s", (ops[0]["apres"]["id_salle"],)).fetchone()[0]
    assert capacite >= 80 and capacite == conn.execute("SELECT min(capacite) FROM salle WHERE capacite >= 80 AND est_disponible").fetchone()[0]
    assert "Examen" in impact["seances_ajoutees"][0]
    assert conn.execute("SELECT count(*) FROM seance WHERE nature <> 'cours'").fetchone()[0] == 0  # rien d'écrit
    assert propositions.appliquer(conn, ctx.propositions_creees[0], 1)["seances_creees"] == 1
    # Rattrapage avant l'examen : refusé ; après : accepté, sur un campus choisi
    ctx.propositions_creees.clear()
    assert "EXAMEN" in proposer_epreuve(ctx, "R", "L2INFO", matiere, LUNDI, "07:00", "09:00", "rattrapage")
    texte = proposer_epreuve(ctx, "R", "L2INFO", matiere, MERCREDI, "07:00", "09:00", "rattrapage", site="OUAGA")
    assert texte.startswith("Proposition"), texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert conn.execute("SELECT code_site FROM salle JOIN site USING (id_site) WHERE id_salle = %s", (ops[0]["apres"]["id_salle"],)).fetchone()[0] == "OUAGA"
    # Refus avant la base
    assert "2 h à 3 h" in proposer_epreuve(ctx, "x", "L2INFO", matiere, LUNDI, "07:00", "11:00")
    assert "aucun cours" in proposer_epreuve(ctx, "x", "L2INFO", "ZZZ", LUNDI, "07:00", "09:00")


def test_la_suppression_laisse_les_epreuves_sauf_demande(ctx, conn):
    k = cours_de(conn, "L2INFO")
    examen = poser(conn, k, LUNDI)
    jour = conn.execute("SELECT date_seance FROM seance WHERE id_seance = %s", (examen,)).fetchone()[0].isoformat()
    texte = proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour, au=jour)
    assert texte.startswith("Aucune séance") and "1 examen(s) ou rattrapage(s)" in texte  # il sait qu'une épreuve existe
    texte = proposer_suppression_seances(ctx, "x", code_classe="L2INFO", du=jour, au=jour, nature="examen")
    assert texte.startswith("Proposition"), texte
    ops = conn.execute("SELECT modifications FROM proposition WHERE id_proposition = %s", (ctx.propositions_creees[0],)).fetchone()[0]
    assert [o["id_seance"] for o in ops] == [examen]


def test_les_memes_etudiants_n_ont_cours_que_sur_un_campus_par_demi_journee(conn):
    """Contrôle SITE (version 16) : une promotion peut aller sur l'autre campus ; les mêmes étudiants changent de
    campus à la pause de midi, pas dans la même demi-journée ; deux groupes différents peuvent être séparés"""
    def plus_d_heures(k):
        conn.execute("UPDATE programme p SET volume_cm = volume_cm + 10, volume_td = volume_td + 10, volume_tp = volume_tp + 10 "
                     "FROM cours c WHERE c.id_cours = %s AND p.id_classe = c.id_classe AND p.id_matiere = c.id_matiere", (k,))
        conn.execute("UPDATE cours SET volume_horaire = volume_horaire + 10, heures_semaine_max = 20 WHERE id_cours = %s", (k,))

    k = cours_de(conn, "L2INFO")  # CM en amphithéâtre ; la promotion est au campus de Kamboinsé
    plus_d_heures(k)
    # le matin à Ouagadougou : accepté (avant, la salle devait être sur le campus de la promotion)
    assert poser(conn, k, LUNDI, "07:00", "09:00", id_salle=salle(conn, "O-AMPHI1"), nature="cours")
    # le même matin à Kamboinsé : refusé
    refuse(conn, "SITE", k, LUNDI, "09:00", "11:00", id_salle=salle(conn, "K-AMPHI1"), nature="cours")
    # l'après-midi à Kamboinsé : accepté (changement de campus à midi)
    assert poser(conn, k, LUNDI, "13:00", "15:00", id_salle=salle(conn, "K-AMPHI1"), nature="cours")

    # deux groupes de TD différents, en même temps, chacun sur un campus : pas d'étudiants communs, accepté
    td = dict(conn.execute("""SELECT g.code_groupe, co.id_cours FROM cours co JOIN groupe g ON g.id_groupe = co.id_groupe
                              JOIN classe cl ON cl.id_classe = co.id_classe
                              WHERE cl.code_classe = 'L2INFO' AND co.type_cours = 'TD' ORDER BY g.code_groupe""").fetchall())
    (ga, ka), (gb, kb) = list(td.items())[:2]
    plus_d_heures(ka)
    plus_d_heures(kb)
    conn.execute("UPDATE cours SET id_type_salle = NULL WHERE id_cours IN (%s, %s)", (ka, kb))
    assert poser(conn, ka, MERCREDI, "07:00", "09:00", id_salle=salle(conn, "O-B101"), nature="cours")
    assert poser(conn, kb, MERCREDI, "07:00", "09:00", id_salle=salle(conn, "K-A101"), nature="cours")
