import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "moteur_v2"))
from generate_data import generate        # noqa: E402
from instance import Instance             # noqa: E402
from validate import validate             # noqa: E402

try:
    import ortools  # noqa: F401
    from solver import solve
    HAS_ORTOOLS = True
except ImportError:
    HAS_ORTOOLS = False


def petit():
    """1 classe de 60 (2 groupes de 30), 2 sites, 3 salles, 3 enseignants."""
    return {
        "sites": ["K", "O"],
        "salles": [
            {"id_salle": 1, "capacite": 100, "site": "K", "id_type_salle": 1},
            {"id_salle": 2, "capacite": 50, "site": "K", "id_type_salle": 2},
            {"id_salle": 3, "capacite": 50, "site": "O", "id_type_salle": 2},
        ],
        "classes": [{"id_classe": 1, "effectif": 60, "site_principal": "K"}],
        "groupes": [{"id_groupe": 1, "id_classe": 1, "effectif": 30},
                    {"id_groupe": 2, "id_classe": 1, "effectif": 30}],
        "enseignants": [{"id_enseignant": i} for i in (1, 2, 3)],
        "cours": [
            {"id_cours": 1, "id_classe": 1, "id_groupe": None, "id_enseignant": 1,
             "id_type_salle": 1, "type_cours": "CM", "decoupage": [3]},
            {"id_cours": 2, "id_classe": 1, "id_groupe": 1, "id_enseignant": 2,
             "id_type_salle": 2, "type_cours": "TD", "decoupage": [2]},
            {"id_cours": 3, "id_classe": 1, "id_groupe": 2, "id_enseignant": 3,
             "id_type_salle": 2, "type_cours": "TD", "decoupage": [2]},
        ],
        "indisponibilites": [], "preferences": [], "seances_verrouillees": [],
    }


def sc(cid, jour, h, d, salle, k=0):
    return {"id_cours": cid, "index": k, "jour": jour, "heure_debut": h, "duree": d, "id_salle": salle}


OK = [sc(1, "Lundi", 7, 3, 1), sc(2, "Lundi", 13, 2, 2), sc(3, "Lundi", 13, 2, 3)]


def viols(data, seances):
    return validate(data, {"seances": seances})


class TestInstance(unittest.TestCase):
    def test_pas_de_chevauchement_de_la_pause(self):
        inst = Instance(petit())
        for st in inst.starts(3, 1):
            h = st % 24
            self.assertTrue(h + 3 <= 12 or h >= 13, h)

    def test_samedi_matin_seulement(self):
        inst = Instance(petit())
        samedi = [st for st in inst.starts(2, 1) if st // 24 == 5]
        self.assertTrue(samedi)
        self.assertTrue(all(st % 24 + 2 <= 12 for st in samedi))

    def test_indisponibilite_retire_les_horaires(self):
        d = petit()
        d["indisponibilites"] = [{"id_enseignant": 1, "jour": "Lundi", "heure_debut": 7, "heure_fin": 12}]
        inst = Instance(d)
        self.assertFalse([st for st in inst.starts(2, 1) if st // 24 == 0 and st % 24 < 12])

    def test_cm_conflit_avec_tous_les_groupes(self):
        inst = Instance(petit())
        cm = next(s for s in inst.sessions if s["cid"] == 1)
        self.assertEqual(cm["entites"], [("G", 1), ("G", 2)])


class TestValidateur(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(viols(petit(), OK), [])

    def test_pause(self):
        self.assertTrue(any("pause" in x for x in viols(petit(), [sc(1, "Lundi", 11, 3, 1)])))

    def test_samedi_apres_midi(self):
        self.assertTrue(any("samedi" in x for x in viols(petit(), [sc(2, "Samedi", 13, 2, 2)])))

    def test_hors_ouverture(self):
        self.assertTrue(any("ouverture" in x for x in viols(petit(), [sc(2, "Lundi", 17, 2, 2)])))

    def test_conflit_salle(self):
        v = viols(petit(), [sc(2, "Lundi", 13, 2, 2), sc(3, "Lundi", 14, 2, 2)])
        self.assertTrue(any("CD-01" in x for x in v))

    def test_cm_bloque_les_groupes(self):
        v = viols(petit(), [sc(1, "Lundi", 7, 3, 1), sc(2, "Lundi", 8, 2, 2)])
        self.assertTrue(any("CD-03" in x for x in v))

    def test_conflit_enseignant(self):
        d = petit()
        d["cours"][2]["id_enseignant"] = 2
        v = viols(d, [sc(2, "Lundi", 13, 2, 2), sc(3, "Lundi", 14, 2, 3)])
        self.assertTrue(any("CD-02" in x for x in v))

    def test_site_dans_la_meme_demi_journee(self):
        # groupe 2 : CM le matin à K puis TD le matin à O -> impossible (1 h de route)
        v = viols(petit(), [sc(1, "Lundi", 7, 3, 1), sc(3, "Lundi", 10, 2, 3)])
        self.assertTrue(any("plusieurs sites" in x for x in v))

    def test_changement_de_site_a_midi_autorise(self):
        v = viols(petit(), [sc(1, "Lundi", 7, 3, 1), sc(3, "Lundi", 13, 2, 3)])
        self.assertEqual(v, [])

    def test_capacite(self):
        d = petit()
        d["salles"][1]["capacite"] = 20
        self.assertTrue(any("CD-04" in x for x in viols(d, [sc(2, "Lundi", 13, 2, 2)])))

    def test_type_salle(self):
        self.assertTrue(any("CD-05" in x for x in viols(petit(), [sc(2, "Lundi", 13, 2, 1)])))

    def test_indisponibilite_enseignant(self):
        d = petit()
        d["indisponibilites"] = [{"id_enseignant": 2, "jour": "Lundi", "heure_debut": 13, "heure_fin": 15}]
        self.assertTrue(any("CD-06" in x for x in viols(d, [sc(2, "Lundi", 13, 2, 2)])))

    def test_duree_differente_du_decoupage(self):
        self.assertTrue(any("CD-08" in x for x in viols(petit(), [sc(2, "Lundi", 13, 3, 2)])))

    def test_plus_de_8h_par_jour(self):
        d = petit()
        for i, dur in enumerate([3, 2, 3, 2], start=10):
            d["cours"].append({"id_cours": i, "id_classe": 1, "id_groupe": 1, "id_enseignant": 1 + i % 3,
                               "id_type_salle": None, "decoupage": [dur]})
        d["salles"] += [{"id_salle": s, "capacite": 100, "site": "K", "id_type_salle": 2} for s in (11, 12, 13, 14)]
        seances = [sc(10, "Mardi", 7, 3, 11), sc(11, "Mardi", 10, 2, 12),
                   sc(12, "Mardi", 13, 3, 13), sc(13, "Mardi", 16, 2, 14)]
        d["cours"] = [c for c in d["cours"] if c["id_cours"] >= 10]
        self.assertTrue(any("h/jour" in x for x in viols(d, seances)))


class TestGenerateur(unittest.TestCase):
    def test_deterministe(self):
        self.assertEqual(generate(seed=3, nb_classes=2), generate(seed=3, nb_classes=2))

    def test_toutes_les_seances_ont_horaires_et_salles(self):
        for n in (2, 6):
            inst = Instance(generate(seed=5, nb_classes=n))
            self.assertEqual([x for x in inst.diagnostics() if "sans" in x], [])

    def test_plafond_enseignants_respecte(self):
        inst = Instance(generate(seed=2, nb_classes=8))
        self.assertEqual([x for x in inst.diagnostics() if "plafond" in x], [])

    def test_echelle_30_promotions(self):
        d = generate(seed=1, nb_classes=30, groupes_min=3, groupes_max=4)
        self.assertEqual(d["meta"]["classes"], 30)
        Instance(d)


@unittest.skipUnless(HAS_ORTOOLS, "ortools non installé : pip install ortools")
class TestSolveur(unittest.TestCase):
    def test_petit_cas(self):
        d = petit()
        res = solve(d)
        self.assertIn(res["statut"], ("OPTIMAL", "FEASIBLE"))
        self.assertEqual(validate(d, res), [])
        self.assertEqual(res["taux_placement"], 1.0)

    def test_generateur_3_promotions(self):
        d = generate(seed=1, nb_classes=3)
        d["parametres"] = {"time_limit_s": 30}
        res = solve(d)
        self.assertEqual(validate(d, res), [])
        self.assertGreaterEqual(res["taux_placement"], 0.95)

    def test_cours_impossible_est_explique(self):
        d = petit()
        d["indisponibilites"] = [{"id_enseignant": 2, "jour": j, "heure_debut": 7, "heure_fin": 18}
                                 for j in ("Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi")]
        res = solve(d)
        self.assertEqual(validate(d, res), [])
        self.assertTrue(any("aucun horaire" in n["motif"] for n in res["non_placees"]))

    def test_verrouillage(self):
        d = petit()
        d["seances_verrouillees"] = [{"id_cours": 2, "index": 0, "jour": "Jeudi",
                                      "heure_debut": 8, "id_salle": 2}]
        res = solve(d)
        self.assertTrue(any(s["id_cours"] == 2 and s["jour"] == "Jeudi" and s["heure_debut"] == 8
                            and s["id_salle"] == 2 for s in res["seances"]))
        self.assertEqual(validate(d, res), [])

    def test_instance_trop_grosse_renvoie_le_glouton(self):
        d = generate(seed=1, nb_classes=3)
        d["parametres"] = {"max_variables_solveur": 10}
        res = solve(d)
        self.assertIn("trop grand", res["statut"])
        self.assertEqual(validate(d, res), [])
        self.assertGreaterEqual(res["taux_placement"], 0.95)

    def test_site_et_8h(self):
        d = generate(seed=4, nb_classes=3)
        d["parametres"] = {"time_limit_s": 30}
        res = solve(d)
        v = validate(d, res)
        self.assertFalse([x for x in v if "sites" in x or "h/jour" in x])


if __name__ == "__main__":
    unittest.main(verbosity=2)
