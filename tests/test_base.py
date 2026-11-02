"""Adaptateur base -> moteur v3, testé sans base avec les données des tests de Zakaria.

Nécessite le solveur de Zakaria (branche zakaria, dossier solver/) : chemin dans la
variable d'environnement ZAK_SOLVER. Sans elle, les tests sont sautés.
Le résultat du moteur v3 est vérifié par notre validateur ET par celui de Zakaria.
"""
import os
import sys
import unittest
from datetime import date, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
ZAK = os.environ.get("ZAK_SOLVER")
if ZAK:
    sys.path.insert(0, ZAK)
    sys.path.insert(0, os.path.join(ZAK, "tests"))

try:
    import jeu  # noqa: E402
    from ultraplanning_solver.donnees import Conge, Periode, Seance  # noqa: E402
except ImportError:
    jeu = None

from moteur import generer, replanifier  # noqa: E402
from moteur.base import donnees_vers_v3, enregistrer  # noqa: E402


def vers_zak(res):
    return [Seance(s["id_cours"], date.fromisoformat(s["date"]), time(int(s["heure_debut"][:2])),
                   time(int(s["heure_fin"][:2])), s["id_salle"]) for s in res["seances"]]


@unittest.skipIf(jeu is None, "solveur de Zakaria absent (variable ZAK_SOLVER)")
class TestAdaptateur(unittest.TestCase):
    def jeu_classique(self, **kw):
        c = jeu.cours
        liste = [
            c(1, "CM", 20, 1, 1, 1, jeu.AMPHI, durees=(2, 3)),
            c(2, "TD", 12, 1, 1, 2, jeu.STANDARD, id_groupe=10),
            c(3, "TD", 12, 1, 1, 2, jeu.STANDARD, id_groupe=11),
            c(4, "TP", 8, 2, 1, 3, jeu.LABO, id_groupe=20, durees=(4,)),
            c(5, "TP", 8, 2, 1, 3, jeu.LABO, id_groupe=21, durees=(4,)),
            c(6, "CM", 16, 3, 2, 4, jeu.STANDARD),
        ]
        return jeu.donnees(liste, semaines=4, **kw)

    def test_grille_et_conversion(self):
        v3 = donnees_vers_v3(self.jeu_classique())
        self.assertEqual(v3["calendrier"]["plages"]["Lundi"], [[7, 12], [13, 16]])
        self.assertEqual(v3["calendrier"]["plages"]["Samedi"], [[7, 12]])
        self.assertEqual(len(v3["cours"]), 6)
        self.assertTrue(any("CD-13" in a for a in v3["meta"]["avertissements"]))

    def test_double_validation(self):
        d = self.jeu_classique()
        res = generer(donnees_vers_v3(d), essais=2, temps_amelioration=0, processus=1)
        self.assertEqual(res["violations"], [])            # notre validateur
        self.assertEqual(jeu.violations(d, vers_zak(res)), [])   # le sien
        self.assertEqual(res["statistiques"]["taux"], 100.0)

    def test_externe_et_indisponibilites_de_la_base(self):
        from ultraplanning_solver.donnees import Enseignant
        ens = {1: Enseignant(1, "E1", "externe", 30), 2: Enseignant(2, "E2", "vacataire_local", 12),
               3: Enseignant(3, "E3", "permanent", 30), 4: Enseignant(4, "E4", "permanent", 30)}
        sejour = {1: [Periode(date(2026, 10, 19), date(2026, 10, 24))]}
        dispo = {(2, j, time(h)): "indisponible" for j in ["Lundi", "Mardi"] for h in range(7, 16)}
        d = self.jeu_classique(enseignants=ens, sejours=sejour, disponibilites=dispo)
        res = generer(donnees_vers_v3(d), essais=2, temps_amelioration=0, processus=1)
        self.assertEqual(res["violations"], [])
        self.assertEqual(jeu.violations(d, vers_zak(res)), [])
        cm = [s for s in res["seances"] if s["id_cours"] == 1]
        self.assertTrue(cm and all("2026-10-19" <= s["date"] <= "2026-10-24" for s in cm))
        # 20 h en une semaine de séjour, rythme maximal 15 h (CD-14) : 15 h et un avertissement
        self.assertEqual(sum(int(s["heure_fin"][:2]) - int(s["heure_debut"][:2]) for s in cm), 15)
        self.assertTrue(any(a.startswith("cours 1 :") for a in res["statistiques"]["avertissements"]))

    def test_conge_d_une_promotion(self):
        d = self.jeu_classique()
        d.conges.append(Conge(date(2026, 10, 12), date(2026, 10, 17), 2))
        res = generer(donnees_vers_v3(d), essais=2, temps_amelioration=0, processus=1)
        self.assertEqual(res["violations"], [])
        self.assertFalse(any(s["id_cours"] == 6 and s["date"] <= "2026-10-17" for s in res["seances"]))

    def test_enregistrer_n_ecrit_que_les_differences(self):
        d = self.jeu_classique()
        v3 = donnees_vers_v3(d)
        res = generer(v3, essais=1, temps_amelioration=0, processus=1)
        v3["seances_existantes"] = [dict(s, id_seance=i + 1, est_verrouillee=False) for i, s in enumerate(res["seances"])]
        v3["enseignants"][0]["absences"] = [[res["seances"][0]["date"]] * 2]
        nouveau = replanifier(v3)

        class Faux:
            def __init__(self):
                self.sql = []

            def transaction(self):
                import contextlib
                return contextlib.nullcontext()

            def execute(self, q, p=()):
                self.sql.append((q.split()[0], p))

                class R:
                    def fetchone(self_inner):
                        return (99,)
                return R()

        conn = Faux()
        bilan = enregistrer(conn, v3, nouveau)
        touchees = [m for m in nouveau["modifications"] if m["type"] in ("déplacée", "salle changée", "non replacée")]
        self.assertGreater(bilan["inchangees"], 0)
        self.assertEqual(bilan["supprimees"], len(touchees))
        self.assertEqual(sum(1 for q, _ in conn.sql if q == "INSERT"), bilan["ajoutees"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
