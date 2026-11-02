import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "moteur_v2"))
sys.path.insert(0, os.path.dirname(__file__))
from generate_data import generate        # noqa: E402
from greedy import construire, meilleur_placement   # noqa: E402
from validate import validate             # noqa: E402
from test_v2 import petit                 # noqa: E402


class TestGlouton(unittest.TestCase):
    def test_petit_cas(self):
        d = petit()
        r = construire(d)
        self.assertEqual(validate(d, r), [])
        self.assertEqual(r["taux_placement"], 1.0)

    def test_valide_a_plusieurs_echelles(self):
        for n, (a, b) in [(3, (2, 4)), (10, (2, 4)), (30, (3, 4))]:
            d = generate(seed=1, nb_classes=n, groupes_min=a, groupes_max=b)
            r = construire(d)
            self.assertEqual(validate(d, r), [], n)
            self.assertGreaterEqual(r["taux_placement"], 0.95, n)

    def test_promotions_non_divisees(self):
        for ratio in (0.4, 1.0):
            d = generate(seed=2, nb_classes=10, groupes_min=3, groupes_max=4, ratio_non_divisees=ratio)
            self.assertGreater(d["meta"]["classes_non_divisees"], 0)
            r = construire(d)
            self.assertEqual(validate(d, r), [], ratio)
            self.assertGreaterEqual(r["taux_placement"], 0.95, ratio)

    def test_meilleur_placement_ne_fait_pas_pire(self):
        for seed in (1, 2, 3):
            d = generate(seed=seed, nb_classes=8, groupes_min=3, groupes_max=4, ratio_non_divisees=0.4)
            r1, rn = construire(d), meilleur_placement(d, essais=6)
            self.assertEqual(validate(d, rn), [], seed)
            self.assertLessEqual(len(rn["non_placees"]), len(r1["non_placees"]), seed)

    def test_plusieurs_graines(self):
        for seed in range(2, 8):
            d = generate(seed=seed, nb_classes=6)
            r = construire(d)
            self.assertEqual(validate(d, r), [], seed)

    def test_cours_impossible_explique(self):
        d = petit()
        d["indisponibilites"] = [{"id_enseignant": 2, "jour": j, "heure_debut": 7, "heure_fin": 18}
                                 for j in ("Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi")]
        r = construire(d)
        self.assertEqual(validate(d, r), [])
        self.assertTrue(any("aucun horaire" in n["motif"] for n in r["non_placees"]))

    def test_verrouillage(self):
        d = petit()
        d["seances_verrouillees"] = [{"id_cours": 2, "index": 0, "jour": "Jeudi",
                                      "heure_debut": 8, "id_salle": 2}]
        r = construire(d)
        self.assertTrue(any(s["id_cours"] == 2 and s["jour"] == "Jeudi" and s["heure_debut"] == 8
                            for s in r["seances"]))
        self.assertEqual(validate(d, r), [])

    def test_ordre_des_seances_identiques(self):
        d = generate(seed=3, nb_classes=4)
        r = construire(d)
        par = {}
        jid = {j: i for i, j in enumerate(["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"])}
        for s in sorted(r["seances"], key=lambda s: s["index"]):
            par.setdefault((s["id_cours"], s["duree"]), []).append(jid[s["jour"]] * 24 + s["heure_debut"])
        for v in par.values():
            self.assertEqual(v, sorted(v))


class TestQualite(unittest.TestCase):
    def test_trous_et_preferences(self):
        from qualite import evaluer
        d = petit()
        d["cours"].append({"id_cours": 4, "id_classe": 1, "id_groupe": 1, "id_enseignant": 1,
                           "id_type_salle": 2, "decoupage": [2]})
        d["preferences"] = [{"id_enseignant": 2, "jour": "Lundi", "heure_debut": 7, "heure_fin": 9}]
        # groupe 1 : TD 7-9 puis TD 10-12 le lundi matin -> 1 h de trou ; seul le cours 2 est sur sa préférence
        r = {"seances": [
            {"id_cours": 2, "index": 0, "jour": "Lundi", "heure_debut": 7, "duree": 2, "id_salle": 2},
            {"id_cours": 4, "index": 0, "jour": "Lundi", "heure_debut": 10, "duree": 2, "id_salle": 2}]}
        q = evaluer(d, r)
        self.assertEqual(q["trous_heures_total"], 1)
        self.assertEqual(q["seances_sur_preference_pct"], 50.0)
        self.assertEqual(q["seances_placees"], 2)

    def test_score_sur_planning_glouton(self):
        from qualite import evaluer
        d = generate(seed=1, nb_classes=3, ratio_non_divisees=0.4)
        q = evaluer(d, construire(d))
        self.assertLess(q["score"], 0)       # les bonus de préférence dominent


if __name__ == "__main__":
    unittest.main(verbosity=2)
