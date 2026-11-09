"""Tests du moteur v3 de Soraya Pitroipa (ultraplanning_solver/v3) : règles dures, publics,
règles du planificateur, validateur."""
import unittest

from ultraplanning_solver.v3.generateur import generate
from ultraplanning_solver.v3.instance import Instance, heures_par_semaine
from ultraplanning_solver.v3.planif import planifier
from ultraplanning_solver.v3.valide import valider

PLAGES = {j: [[7, 12], [13, 16]] for j in ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"]}
PLAGES["Samedi"] = [[7, 12]]
AMPHI, STD, LABO = 1, 2, 3


def mini(cours, semaines=2, groupes=(), enseignants=None, regles=(), salles=None, classes=None):
    """Petite instance : 2 promotions (site 1), 4 salles au site 1, 1 au site 2."""
    fin = {1: "2026-09-19", 2: "2026-09-26", 4: "2026-10-10"}[semaines]
    ens_ids = {c["id_enseignant"] for c in cours}
    return {
        "calendrier": {"debut": "2026-09-14", "fin": fin, "jours_feries": [], "conges": [], "plages": PLAGES},
        "sites": [{"id_site": 1}, {"id_site": 2}],
        "salles": salles or [
            {"id_salle": 1, "id_site": 1, "id_type_salle": AMPHI, "capacite": 200, "reservee_a": []},
            {"id_salle": 2, "id_site": 1, "id_type_salle": STD, "capacite": 40, "reservee_a": []},
            {"id_salle": 3, "id_site": 1, "id_type_salle": STD, "capacite": 40, "reservee_a": []},
            {"id_salle": 4, "id_site": 1, "id_type_salle": LABO, "capacite": 20, "reservee_a": []},
            {"id_salle": 5, "id_site": 2, "id_type_salle": STD, "capacite": 80, "reservee_a": []},
        ],
        "classes": classes or [{"id_classe": 1, "code_classe": "A", "id_site": 1, "effectif": 60},
                               {"id_classe": 2, "code_classe": "B", "id_site": 1, "effectif": 40}],
        "groupes": list(groupes),
        "enseignants": enseignants or [{"id_enseignant": e, "statut": "permanent", "nb_heures_max_semaine": 30,
                                        "sejours": [], "indisponibilites": [], "preferences": []} for e in ens_ids],
        "cours": cours,
        "regles": list(regles),
    }


def cours(i, classe, volume, ens, types=(STD,), groupe=None, t="CM", matiere=None, publics=None, hmax=8):
    return {"id_cours": i, "id_matiere": matiere or i, "type_cours": t,
            "publics": publics or [{"id_classe": classe, "id_groupe": groupe}],
            "id_enseignant": ens, "id_type_salle": types[0], "types_salle": list(types),
            "volume": volume, "durees": [2], "h_sem_min": 2, "h_sem_max": hmax}


def lancer(data, **kw):
    res = planifier(Instance(data), essais=kw.pop("essais", 2), **kw)
    return res, valider(data, res["seances"])


def heures(res, k):
    return sum(int(s["heure_fin"][:2]) - int(s["heure_debut"][:2]) for s in res["seances"] if s["id_cours"] == k)


class TestMoteur(unittest.TestCase):
    def test_volume_complet_sans_violation(self):
        d = mini([cours(1, 1, 16, 1, (AMPHI,)), cours(2, 2, 12, 2), cours(3, 2, 10, 3)])
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(res["statistiques"]["taux"], 100.0)

    def test_salle_principale_preferee_sans_etre_imposee(self):
        """Salle principale de la classe (version 17) : prise quand elle convient, sinon une autre salle."""
        classes = [{"id_classe": 1, "code_classe": "A", "id_site": 1, "effectif": 60},
                   {"id_classe": 2, "code_classe": "B", "id_site": 1, "effectif": 40, "id_salle_principale": 3}]
        # sans elle, la salle 2 (même taille, avant la 3) serait prise
        d = mini([cours(1, 2, 8, 1), cours(2, 2, 4, 2, (AMPHI,))], classes=classes)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual({s["id_salle"] for s in res["seances"] if s["id_cours"] == 1}, {3})
        # un cours qui veut un amphithéâtre ne va pas dans la salle principale (salle standard), sans erreur
        self.assertEqual({s["id_salle"] for s in res["seances"] if s["id_cours"] == 2}, {1})
        # salle principale prise toute la première semaine : le cours se fait quand même, ailleurs
        d["salles_bloquees"] = [{"id_salle": 3, "date": f"2026-09-{j}", "debut": 7, "fin": 16} for j in range(14, 20)]
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1), 8)
        par_semaine = {(s["date"] < "2026-09-21", s["id_salle"]) for s in res["seances"] if s["id_cours"] == 1}
        self.assertTrue(all(salle != 3 for premiere, salle in par_semaine if premiere), par_semaine)
        self.assertIn((False, 3), par_semaine)
        # salle principale indisponible : aucune préférence, aucune erreur
        d.pop("salles_bloquees")
        d["salles"] = [dict(s, est_disponible=s["id_salle"] != 3) for s in d["salles"]]
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1), 8)

    def test_rythme_souhaite_tenu_sauf_si_cs08_desactivee(self):
        """CS-08 (souple) : la génération tient le rythme souhaité ; désactivée, elle peut le dépasser pour tout placer."""
        d = mini([cours(1, 2, 12, 1, hmax=4)], semaines=1)
        res, v = lancer(d)
        self.assertEqual((v, heures(res, 1)), ([], 4))
        d["parametres"] = {"rythme_strict": False, "poids": {"rythme": 0}}
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertGreater(heures(res, 1), 4)

    def test_decoupage(self):
        self.assertEqual(heures_par_semaine(5, [3, 2]), [3, 2])
        self.assertEqual(heures_par_semaine(4, [2]), [2, 2])
        self.assertEqual(heures_par_semaine(1, [2]), [])   # séances de 2 à 4 h (CD-10 de la base)
        self.assertEqual(heures_par_semaine(7, [2]), [2, 2, 3])

    def test_groupes_freres_en_parallele_mais_pas_avec_la_promotion(self):
        g = [{"id_groupe": 10, "id_classe": 1, "parent": None, "type_groupe": "TD", "effectif": 30},
             {"id_groupe": 11, "id_classe": 1, "parent": None, "type_groupe": "TD", "effectif": 30}]
        # deux TD de 40 h sur une semaine : impossible sans les mettre en parallèle
        d = mini([cours(1, 1, 38, 1, groupe=10, hmax=40), cours(2, 1, 38, 2, groupe=11, hmax=40),
                  cours(3, 1, 4, 3, (AMPHI,))], semaines=1, groupes=g)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 3), 4)
        self.assertGreater(heures(res, 1) + heures(res, 2), 45)

    def test_sous_groupe_tp_en_conflit_avec_son_td(self):
        g = [{"id_groupe": 10, "id_classe": 1, "parent": None, "type_groupe": "TD", "effectif": 30},
             {"id_groupe": 12, "id_classe": 1, "parent": 10, "type_groupe": "TP", "effectif": 15}]
        # séances de 2 h : 6 h utilisables par jour en semaine, 4 h le samedi, soit 34 h
        d = mini([cours(1, 1, 18, 1, groupe=10, hmax=18), cours(2, 1, 16, 2, (LABO,), groupe=12, t="TP", hmax=16)],
                 semaines=1, groupes=g)
        res, v = lancer(d, taux_budget=1.0)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1) + heures(res, 2), 34)

    def test_cours_mutualise_occupe_les_deux_promotions(self):
        mut = cours(1, 1, 20, 1, (AMPHI,), publics=[{"id_classe": 1, "id_groupe": None},
                                                     {"id_classe": 2, "id_groupe": None}], hmax=20)
        d = mini([mut, cours(2, 2, 14, 2, hmax=14)], semaines=1)
        res, v = lancer(d, taux_budget=1.0)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1), 20)
        self.assertEqual(heures(res, 2), 14)   # 20 + 14 = 34 h, le maximum en séances de 2 h

    def test_site_de_la_promotion(self):
        d = mini([cours(1, 1, 10, 1, (STD,))],
                 classes=[{"id_classe": 1, "code_classe": "A", "id_site": 2, "effectif": 60}])
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertTrue(all(s["id_salle"] == 5 for s in res["seances"]))

    def test_salle_reservee(self):
        salles = mini([])["salles"]
        salles[1]["reservee_a"] = [2]
        d = mini([cours(1, 1, 10, 1), cours(2, 2, 10, 2)], salles=salles,
                 classes=[{"id_classe": 1, "code_classe": "A", "id_site": 1, "effectif": 30},
                          {"id_classe": 2, "code_classe": "B", "id_site": 1, "effectif": 30}])
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertFalse(any(s["id_salle"] == 2 for s in res["seances"] if s["id_cours"] == 1))

    def test_externe_seulement_pendant_son_sejour_et_ramasse(self):
        ens = [{"id_enseignant": 1, "statut": "externe_non_resident", "nb_heures_max_semaine": 30,
                "sejours": [["2026-09-28", "2026-10-03"]], "indisponibilites": [], "preferences": []}]
        d = mini([cours(1, 2, 20, 1, hmax=20)], semaines=4, enseignants=ens)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1), 20)  # tout ramassé sur la semaine du séjour
        self.assertTrue(all("2026-09-28" <= s["date"] <= "2026-10-03" for s in res["seances"]))

    def test_rythme_maximal_trop_bas_pour_le_sejour(self):
        ens = [{"id_enseignant": 1, "statut": "externe_non_resident", "nb_heures_max_semaine": 30,
                "sejours": [["2026-09-28", "2026-10-03"]], "indisponibilites": [], "preferences": []}]
        d = mini([cours(1, 2, 20, 1, hmax=6)], semaines=4, enseignants=ens)
        res, v = lancer(d)
        self.assertEqual(v, [])                   # CD-14 respectée : 6 h au plus
        self.assertEqual(heures(res, 1), 6)
        self.assertTrue(any("il faudrait 20 h" in a for a in res["statistiques"]["avertissements"]))

    def test_indisponibilite(self):
        ens = [{"id_enseignant": 1, "statut": "permanent", "nb_heures_max_semaine": 30, "sejours": [],
                "indisponibilites": [{"jour": j, "demi": 0} for j in ["Lundi", "Mardi", "Mercredi", "Jeudi"]],
                "preferences": []}]
        d = mini([cours(1, 2, 8, 1)], enseignants=ens)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual(heures(res, 1), 8)

    def test_temps_de_trajet_entre_sites(self):
        # un enseignant, une promotion par site, 5 jours ouvrés : il doit changer de site dans la journée
        classes = [{"id_classe": 1, "code_classe": "K", "id_site": 1, "effectif": 30},
                   {"id_classe": 2, "code_classe": "O", "id_site": 2, "effectif": 30}]
        d = mini([cours(1, 1, 14, 1, hmax=14), cours(2, 2, 14, 1, hmax=14)], semaines=1, classes=classes)
        d["calendrier"]["plages"] = {j: p for j, p in PLAGES.items() if j != "Samedi"}
        d["trajet_min"] = {"1-2": 60}
        res, v = lancer(d, taux_budget=1.0)
        self.assertEqual(v, [])
        jours = {}
        for x in res["seances"]:
            site = 1 if x["id_salle"] != 5 else 2
            jours.setdefault(x["date"], []).append((x["heure_debut"], x["heure_fin"], site))
        self.assertTrue(any(len({t[2] for t in l}) == 2 for l in jours.values()))  # le cas se produit
        for l in jours.values():
            for a0, a1, sa in l:
                for b0, b1, sb in l:
                    if sa != sb and a1 <= b0:
                        self.assertGreaterEqual(int(b0[:2]) - int(a1[:2]), 1)

    def test_validateur_trajet(self):
        classes = [{"id_classe": 1, "code_classe": "K", "id_site": 1, "effectif": 30},
                   {"id_classe": 2, "code_classe": "O", "id_site": 2, "effectif": 30}]
        d = mini([cours(1, 1, 2, 1), cours(2, 2, 2, 1)], classes=classes)
        mauvaises = [{"id_cours": 1, "date": "2026-09-14", "heure_debut": "08:00", "heure_fin": "10:00", "id_salle": 2},
                     {"id_cours": 2, "date": "2026-09-14", "heure_debut": "10:00", "heure_fin": "12:00", "id_salle": 5}]
        self.assertTrue(any("trajet" in x for x in valider(d, mauvaises)))

    def test_regle_precede(self):
        r = [{"id": 1, "type": "precede", "matiere_avant": 1, "matiere_apres": 2, "dure": True}]
        d = mini([cours(1, 2, 12, 1, hmax=6), cours(2, 2, 12, 2, hmax=6)], semaines=4, regles=r)
        res, v = lancer(d)
        self.assertEqual(v, [])
        fin1 = max((s["date"], s["heure_fin"]) for s in res["seances"] if s["id_cours"] == 1)
        deb2 = min((s["date"], s["heure_debut"]) for s in res["seances"] if s["id_cours"] == 2)
        self.assertLessEqual(fin1, deb2)

    def test_regle_interdire(self):
        r = [{"id": 1, "type": "interdire", "cible": {"id_classe": 2}, "jours": ["Mercredi"], "demi": 1, "dure": True}]
        d = mini([cours(1, 2, 40, 1, hmax=40)], semaines=1, regles=r)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertFalse(any(s["date"] == "2026-09-16" and s["heure_debut"] >= "13" for s in res["seances"]))

    def test_plafond_journalier(self):
        r = [{"id": 1, "type": "plafond_jour", "cible": {"tous": True}, "heures": 4, "dure": True}]
        d = mini([cours(1, 2, 40, 1, hmax=40)], semaines=1, regles=r)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertLessEqual(heures(res, 1), 6 * 4)
        self.assertTrue(res["non_programmes"])

    def test_non_programme_avec_raison(self):
        d = mini([cours(1, 2, 10, 1, (LABO,))])  # 40 étudiants, labo de 20 places
        res, _ = lancer(d)
        self.assertEqual(res["non_programmes"][0]["heures"], 10)
        self.assertTrue(res["statistiques"]["avertissements"])

    def test_validateur_detecte_les_erreurs(self):
        d = mini([cours(1, 1, 4, 1, (AMPHI,)), cours(2, 1, 4, 2)])
        mauvaises = [
            {"id_cours": 1, "date": "2026-09-14", "heure_debut": "07:00", "heure_fin": "09:00", "id_salle": 1},
            {"id_cours": 2, "date": "2026-09-14", "heure_debut": "08:00", "heure_fin": "10:00", "id_salle": 2},
            {"id_cours": 2, "date": "2026-09-19", "heure_debut": "13:00", "heure_fin": "15:00", "id_salle": 5},
            # mardi matin : la promotion 1 au site 1 puis au site 2 sans passer par la pause de midi
            {"id_cours": 1, "date": "2026-09-15", "heure_debut": "07:00", "heure_fin": "09:00", "id_salle": 1},
            {"id_cours": 2, "date": "2026-09-15", "heure_debut": "09:00", "heure_fin": "11:00", "id_salle": 5},
            # mercredi : site 1 le matin, site 2 l'après-midi (changement à midi) : accepté
            {"id_cours": 1, "date": "2026-09-16", "heure_debut": "07:00", "heure_fin": "09:00", "id_salle": 1},
            {"id_cours": 2, "date": "2026-09-16", "heure_debut": "13:00", "heure_fin": "15:00", "id_salle": 5},
        ]
        v = " | ".join(valider(d, mauvaises))
        self.assertIn("étudiants communs", v)
        self.assertIn("salle trop petite", v)
        self.assertIn("hors des plages", v)
        self.assertIn("le 2026-09-15 : étudiants communs sur deux campus la même demi-journée", v)
        self.assertNotIn("le 2026-09-16 : étudiants communs sur deux campus", v)

    def test_cours_mutualise_entre_deux_campus(self):
        """Une promotion peut aller sur l'autre campus pour un cours mutualisé, jamais sur les deux la même
        demi-journée (elle change de campus à midi) ; ses autres cours restent sur son campus."""
        classes = [{"id_classe": 1, "code_classe": "A", "id_site": 1, "effectif": 30},
                   {"id_classe": 2, "code_classe": "B", "id_site": 2, "effectif": 30}]
        salles = [{"id_salle": 1, "id_site": 1, "id_type_salle": STD, "capacite": 80, "reservee_a": []},
                  {"id_salle": 2, "id_site": 1, "id_type_salle": STD, "capacite": 40, "reservee_a": []},
                  {"id_salle": 5, "id_site": 2, "id_type_salle": STD, "capacite": 80, "reservee_a": []}]
        d = mini([cours(1, 1, 8, 1, publics=[{"id_classe": 1, "id_groupe": None}, {"id_classe": 2, "id_groupe": None}]),
                  cours(2, 2, 12, 2), cours(3, 1, 8, 3)], classes=classes, salles=salles)
        res, v = lancer(d)
        self.assertEqual(v, [])
        self.assertEqual((heures(res, 1), heures(res, 2), heures(res, 3)), (8, 12, 8))
        site = {x["id_salle"]: x["id_site"] for x in salles}
        par_demi = {}
        for x in res["seances"]:
            demi = 0 if int(x["heure_debut"][:2]) < 12 else 1
            for p in next(c for c in d["cours"] if c["id_cours"] == x["id_cours"])["publics"]:
                par_demi.setdefault((p["id_classe"], x["date"], demi), set()).add(site[x["id_salle"]])
        self.assertTrue(all(len(s) == 1 for s in par_demi.values()))
        # le cours mutualisé a lieu au campus de sa classe (A) ; les cours de B restent au sien
        self.assertTrue(all(site[x["id_salle"]] == 1 for x in res["seances"] if x["id_cours"] == 1))
        self.assertTrue(all(site[x["id_salle"]] == 2 for x in res["seances"] if x["id_cours"] == 2))

    def test_instance_2ie_complete(self):
        d = generate(seed=3, promotions=["S1", "S5 D", "S5 S", "CPGE 1", "S9 IAA"])
        res, v = lancer(d, essais=1)
        self.assertEqual(v, [])
        self.assertGreater(res["statistiques"]["taux"], 95)

    def test_amelioration_cpsat_sans_regression(self):
        from ultraplanning_solver.v3 import generer
        d = generate(seed=2, promotions=["S5 D", "S5 S", "S6 D", "BT TOPO SIG S6"])
        res = generer(d, essais=1, temps_amelioration=20, processus=1)
        st = res["statistiques"]
        self.assertEqual(res["violations"], [])
        self.assertGreaterEqual(st["taux"], st["glouton"]["taux"])
        fait = {}
        for x in res["seances"]:
            fait[x["id_cours"]] = fait.get(x["id_cours"], 0) + int(x["heure_fin"][:2]) - int(x["heure_debut"][:2])
        vol = {c["id_cours"]: c["volume"] for c in d["cours"]}
        self.assertTrue(all(h <= vol[k] for k, h in fait.items()))


class TestReplanification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = generate(seed=4, promotions=["S2", "S4", "CPGE 1"])
        res, _ = lancer(cls.d, essais=1)
        cls.d["seances_existantes"] = [dict(x, est_verrouillee=False) for x in res["seances"]]

    def copie(self):
        import copy
        return copy.deepcopy(self.d)

    def test_rien_ne_change_si_rien_ne_change(self):
        from ultraplanning_solver.v3.replanif import replanifier
        x = replanifier(self.copie())
        self.assertEqual(x["modifications"], [])
        self.assertEqual(x["violations"], [])
        self.assertEqual(len(x["seances"]), len(self.d["seances_existantes"]))

    def test_absence_ne_deplace_que_ses_seances(self):
        from ultraplanning_solver.v3.replanif import replanifier
        d = self.copie()
        cours_ens = {c["id_cours"]: c["id_enseignant"] for c in d["cours"]}
        cible = next(x for x in d["seances_existantes"] if x["date"] >= "2026-10-12")
        ens = cours_ens[cible["id_cours"]]
        next(e for e in d["enseignants"] if e["id_enseignant"] == ens)["absences"] = [[cible["date"], cible["date"]]]
        x = replanifier(d, du="2026-10-12", au="2026-11-07")
        self.assertEqual(x["violations"], [])
        self.assertTrue(x["modifications"])
        self.assertTrue(all(cours_ens[m["id_cours"]] == ens for m in x["modifications"]))
        self.assertFalse(any(cours_ens[s["id_cours"]] == ens and s["date"] == cible["date"] for s in x["seances"]))

    def test_seance_verrouillee_ne_bouge_pas(self):
        from ultraplanning_solver.v3.replanif import replanifier
        d = self.copie()
        v = d["seances_existantes"][5]
        v["est_verrouillee"] = True
        ic = next(c for c in d["cours"] if c["id_cours"] == v["id_cours"])["publics"][0]["id_classe"]
        d["regles"].append({"id": 98, "type": "interdire", "cible": {"id_classe": ic}, "dure": True})
        x = replanifier(d)
        gardee = {k: v[k] for k in ("id_cours", "date", "heure_debut", "heure_fin", "id_salle")}
        self.assertIn(gardee, [{k: s[k] for k in gardee} for s in x["seances"]])   # les séances portent aussi leur enseignant

    def test_regle_avec_periode_de_validite(self):
        from ultraplanning_solver.v3.replanif import replanifier
        d = self.copie()
        ic = d["classes"][0]["id_classe"]
        d["regles"].append({"id": 97, "type": "interdire", "cible": {"id_classe": ic}, "jours": ["Mardi"],
                            "dure": True, "du": "2026-11-02"})
        x = replanifier(d, perimetre={"id_classes": [ic]}, du="2026-11-02")
        self.assertEqual(x["violations"], [])
        self.assertTrue(all(m["avant"]["date"] >= "2026-11-02" for m in x["modifications"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
