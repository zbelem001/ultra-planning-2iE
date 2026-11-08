"""Tests d'intégration sur une base PostgreSQL chargée avec schema_supabase.sql.

Lancés seulement si DATABASE_URL est défini. ATTENTION : ils vident la table
seance de cette base ; ne jamais les lancer sur une base de production.
"""

import os
from datetime import date, time, timedelta

import psycopg
import psycopg.types.json
import pytest

from ultraplanning_solver import Demande, Perimetre, generer
from ultraplanning_solver.base import charger, enregistrer, verifier
from ultraplanning_solver.donnees import Seance, jour_de

from .jeu import violations

DSN = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL non défini")


@pytest.fixture
def conn():
    with psycopg.connect(DSN) as c:
        c.execute("DELETE FROM seance")
        c.commit()
        yield c


def test_generation_du_semestre_acceptee_par_la_base(conn):
    d = charger(conn, 1)
    r = generer(d, Demande(temps_max_placement=5))
    assert violations(d, r.seances) == []
    assert r.heures_placees == r.statistiques["heures_demandees"]
    # Le déclencheur de la base revalide chaque séance (CD-01 à CD-14)
    assert enregistrer(conn, 1, r) == len(r.seances)
    n = conn.execute("SELECT count(*) FROM seance WHERE id_edt = 1").fetchone()[0]
    assert n == len(r.seances)


def test_perimetre_une_filiere(conn):
    d = charger(conn, 1)
    ia = conn.execute("SELECT id_filiere FROM filiere WHERE code_filiere = 'IA'").fetchone()[0]
    r = generer(d, Demande(perimetre=Perimetre(id_filieres=frozenset({ia})), temps_max_placement=5))
    assert r.seances and all(d.classes[d.cours[s.id_cours].id_classe].id_filiere == ia for s in r.seances)
    enregistrer(conn, 1, r)


def test_verifier_renvoie_le_motif_de_la_base(conn):
    d = charger(conn, 1)
    # L'Algorithmique de L2 confiée à Ouédraogo, lundi 8 h : il est indisponible (CD-06)
    s = Seance(1, date(2026, 10, 19), time(8), time(10), 1)
    assert "CD-06" in verifier(conn, 1, s)
    # Le même cours le mardi à 8 h est accepté, et rien n'est écrit
    assert verifier(conn, 1, Seance(1, date(2026, 10, 20), time(8), time(10), 1)) is None
    assert conn.execute("SELECT count(*) FROM seance").fetchone()[0] == 0
    assert d.cours[1].type_cours == "CM"


# --- Règles 2iE (version 11) : arbre des groupes, cours mutualisés, sites, salles réservées ---------

def _groupe(conn, ic, code, t, parent=None):
    return conn.execute("INSERT INTO groupe (code_groupe, type_groupe, effectif, id_classe, id_groupe_parent, id_ecole) "
                        "VALUES (%s, %s, 10, %s, %s, 1) RETURNING id_groupe", (code, t, ic, parent)).fetchone()[0]


def test_arbre_des_groupes_et_options(conn):
    with conn.transaction(force_rollback=True):
        ic = conn.execute("SELECT id_classe FROM classe WHERE code_classe = 'M2IA'").fetchone()[0]
        td1, td2 = _groupe(conn, ic, "T-TD1", "TD"), _groupe(conn, ic, "T-TD2", "TD")
        tp1 = _groupe(conn, ic, "T-TP1", "TP", td1)
        oa, ob = _groupe(conn, ic, "T-OA", "OPTION"), _groupe(conn, ic, "T-OB", "OPTION")

        def conflit(a, b):
            return conn.execute("SELECT publics_en_conflit(%s, %s, %s, %s)", (ic, a, ic, b)).fetchone()[0]

        assert not conflit(td1, td2) and not conflit(tp1, td2)   # branches sœurs du même type
        assert conflit(tp1, td1) and conflit(td1, None)           # l'un contient l'autre
        assert not conflit(oa, ob) and conflit(oa, td1)           # options sœurs ; option et TD croisés
        autre = conn.execute("SELECT id_classe FROM classe WHERE code_classe = 'L1INFO'").fetchone()[0]
        with pytest.raises(psycopg.errors.CheckViolation, match="même classe"), conn.transaction():
            _groupe(conn, autre, "T-X", "TP", td1)


def _creneau_libre(conn, *cours_salles):
    """Premier créneau d'octobre-novembre 2026 où chaque (cours, salle) est accepté, chacun seul."""
    for n in range(40):
        d = date(2026, 10, 19) + timedelta(days=n)
        for h in (7, 9, 13):
            if all(verifier(conn, 1, Seance(k, d, time(h), time(h + 2), salle)) is None for k, salle in cours_salles):
                return d, h
    raise AssertionError(f"aucun créneau pour {cours_salles}")


def test_cours_mutualise_sites_et_salles_reservees(conn):
    with conn.transaction(force_rollback=True):
        q = lambda sql, *p: conn.execute(sql, p).fetchone()  # noqa: E731
        # Deux cours de classe entière, de classes et d'enseignants différents
        k1, c1, e1 = q("SELECT id_cours, id_classe, id_enseignant FROM cours WHERE id_groupe IS NULL ORDER BY id_cours LIMIT 1")
        k2, c2 = q("SELECT id_cours, id_classe FROM cours WHERE id_groupe IS NULL AND id_classe <> %s AND id_enseignant <> %s "
                   "ORDER BY id_cours LIMIT 1", c1, e1)
        amphi, autre_amphi = [r[0] for r in conn.execute(
            "SELECT id_salle FROM salle s JOIN type_salle t USING (id_type_salle, id_ecole) "
            "WHERE t.libelle = 'Amphithéâtre' ORDER BY capacite DESC LIMIT 2").fetchall()]
        conn.execute("UPDATE cours SET id_type_salle = NULL WHERE id_cours IN (%s, %s)", (k1, k2))
        d, h = _creneau_libre(conn, (k2, amphi), (k1, autre_amphi))
        conn.execute("INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                     "SELECT %s, %s, %s, %s, %s, id_creneau, 1, 1 FROM creneau WHERE id_ecole = 1 AND jour = %s AND heure_debut = %s",
                     (d, time(h), time(h + 2), k2, amphi, jour_de(d), time(h)))
        assert verifier(conn, 1, Seance(k1, d, time(h), time(h + 2), autre_amphi)) is None
        # Mutualisé avec la classe de k2 : la classe de k2 est déjà en cours (CD-03)
        conn.execute("INSERT INTO cours_public (id_cours, id_classe, id_ecole) VALUES (%s, %s, 1)", (k1, c2))
        assert "CD-03" in verifier(conn, 1, Seance(k1, d, time(h), time(h + 2), autre_amphi))
        # Effectif de tous les publics (CD-04) : une petite salle ne suffit plus
        petite = q("SELECT id_salle FROM salle ORDER BY capacite LIMIT 1")[0]
        assert "CD-04" in verifier(conn, 1, Seance(k1, d + timedelta(days=1), time(13), time(15), petite))
        conn.execute("DELETE FROM cours_public WHERE id_cours = %s", (k1,))

        # Types de salle acceptés (CD-05) : le cours exige un amphi, une salle standard est aussi acceptée
        std = q("SELECT id_salle FROM salle s JOIN type_salle t USING (id_type_salle, id_ecole) "
                "WHERE t.libelle = 'Salle standard' ORDER BY capacite DESC LIMIT 1")[0]
        amphi_t, std_t = (q("SELECT id_type_salle FROM type_salle WHERE libelle = %s", x)[0] for x in ("Amphithéâtre", "Salle standard"))
        conn.execute("UPDATE cours SET id_type_salle = %s WHERE id_cours = %s", (amphi_t, k1))
        d1, h1 = _creneau_libre(conn, (k1, amphi))
        assert "CD-05" in (verifier(conn, 1, Seance(k1, d1, time(h1), time(h1 + 2), std)) or "")
        conn.execute("INSERT INTO cours_type_salle (id_cours, id_type_salle, id_ecole) VALUES (%s, %s, 1)", (k1, std_t))
        assert "CD-05" not in (verifier(conn, 1, Seance(k1, d1, time(h1), time(h1 + 2), std)) or "")

        # Site (version 16) : une promotion peut aller sur un autre campus que le sien, pas sur deux le même jour
        site_amphi = q("SELECT id_site FROM salle WHERE id_salle = %s", amphi)[0]
        autre_site = q("SELECT id_site FROM site WHERE id_site <> %s ORDER BY id_site LIMIT 1", site_amphi)[0]
        conn.execute("UPDATE classe SET id_site = %s WHERE id_classe = %s", (autre_site, c1))
        assert verifier(conn, 1, Seance(k1, d1, time(h1), time(h1 + 2), amphi)) is None
        conn.execute("INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_salle, id_creneau, id_edt, id_ecole) "
                     "SELECT %s, %s, %s, %s, %s, id_creneau, 1, 1 FROM creneau WHERE id_ecole = 1 AND jour = %s AND heure_debut = %s",
                     (d1, time(h1), time(h1 + 2), k1, amphi, jour_de(d1), time(h1)))
        # le même jour, une autre heure libre pour la promotion : son campus d'origine est refusé, le même accepté
        ailleurs = q("SELECT id_salle FROM salle s JOIN type_salle t USING (id_type_salle, id_ecole) WHERE s.id_site = %s "
                     "AND t.libelle IN ('Amphithéâtre', 'Salle standard') ORDER BY capacite DESC LIMIT 1", autre_site)[0]
        libre = next(hh for hh in (7, 8, 9, 10, 13, 14) if not (h1 - 2 < hh < h1 + 2)
                     and verifier(conn, 1, Seance(k1, d1, time(hh), time(hh + 2), amphi)) is None)
        assert "SITE" in (verifier(conn, 1, Seance(k1, d1, time(libre), time(libre + 2), ailleurs)) or "")
        conn.execute("DELETE FROM seance WHERE id_cours = %s AND date_seance = %s AND heure_debut = %s", (k1, d1, time(h1)))
        conn.execute("UPDATE classe SET id_site = NULL WHERE id_classe = %s", (c1,))

        # Salle réservée à une autre formation (CD-12)
        conn.execute("INSERT INTO salle_reservation (id_salle, id_classe, id_ecole) VALUES (%s, %s, 1)", (amphi, c2))
        assert "CD-12" in verifier(conn, 1, Seance(k1, d1, time(h1), time(h1 + 2), amphi))


def test_generation_avec_les_donnees_2ie(conn):
    """Chargées depuis la base (version 11) puis respectées par le moteur et revalidées à l'écriture :
    cours mutualisé, type de salle accepté, salle réservée, règle « interdire » du planificateur."""
    with conn.transaction(force_rollback=True):
        q = lambda sql, *p: conn.execute(sql, p).fetchone()  # noqa: E731
        k1, c1 = q("SELECT id_cours, id_classe FROM cours WHERE id_groupe IS NULL AND type_cours = 'CM' ORDER BY id_cours LIMIT 1")
        c2 = q("SELECT id_classe FROM classe WHERE id_classe <> %s AND NOT EXISTS "
               "(SELECT 1 FROM groupe g WHERE g.id_classe = classe.id_classe) ORDER BY id_classe LIMIT 1", c1)[0]
        conn.execute("INSERT INTO cours_public (id_cours, id_classe, id_ecole) VALUES (%s, %s, 1)", (k1, c2))
        std_t = q("SELECT id_type_salle FROM type_salle WHERE libelle = 'Salle standard'")[0]
        conn.execute("INSERT INTO cours_type_salle (id_cours, id_type_salle, id_ecole) VALUES (%s, %s, 1)", (k1, std_t))
        labo = q("SELECT id_salle FROM salle s JOIN type_salle t USING (id_type_salle, id_ecole) WHERE t.libelle = 'Laboratoire' LIMIT 1")[0]
        conn.execute("INSERT INTO salle_reservation (id_salle, id_classe, id_ecole) VALUES (%s, %s, 1)", (labo, c2))
        conn.execute("INSERT INTO site_trajet (id_site_a, id_site_b, minutes, id_ecole) "
                     "SELECT min(id_site), max(id_site), 90, 1 FROM site WHERE id_ecole = 1")
        conn.execute("""INSERT INTO contrainte (libelle, type_contrainte, nature, poids, est_active, parametres, id_edt, id_ecole)
                        VALUES ('Pas de cours le lundi', 'interdire', 'dure', 0, TRUE, %s, 1, 1)""",
                     (psycopg.types.json.Jsonb({"cible": {"id_classe": c1}, "jours": ["Lundi"]}),))
        d = charger(conn, 1)
        assert d.cours[k1].publics_suppl == ((c2, None),) and std_t in d.cours[k1].types_salle
        assert d.salles[labo].reservee_a == frozenset({c2}) and 90 in d.trajet_min.values()
        assert [r["type"] for r in d.regles] == ["interdire"]
        r = generer(d, Demande(essais=2, temps_amelioration=5))
        assert r.seances and r.statistiques["moteur"] == "v3"
        lundi = [s for s in r.seances if s.date_seance.weekday() == 0
                 and c1 in (d.cours[s.id_cours].id_classe, *(c for c, _ in d.cours[s.id_cours].publics_suppl))]
        assert lundi == []
        assert all(s.id_salle != labo or c2 in (d.cours[s.id_cours].id_classe, *(c for c, _ in d.cours[s.id_cours].publics_suppl))
                   for s in r.seances)
        # Les déclencheurs de la base acceptent tout (CD-03 mutualisé, CD-05, salle réservée, CD-13...)
        assert enregistrer(conn, 1, r) == len(r.seances)
