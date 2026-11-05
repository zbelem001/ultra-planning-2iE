"""Moteur de planification v3 (2iE) de Soraya Pitroipa : séances datées sur le semestre.

Format JSON autonome (voir generateur.py). Le solveur d'UltraPlanning l'appelle depuis
ses propres données (ultraplanning_solver.moteur, adaptateur v3_adaptateur.py).

    from ultraplanning_solver.v3 import generer
    res = generer(data)          # data : instance au format v3 (voir generateur.py)
    res = replanifier(data, perimetre={"id_classes": [3]}, du="2026-11-02")   # mise à jour

Chaîne : placement chronologique glouton multi-essais (planif.py), puis amélioration
par CP-SAT sur des sous-problèmes promotion × semaine (ameliore.py, si OR-Tools est
installé), validation indépendante (valide.py) et indicateurs de qualité (qualite.py).
"""
from __future__ import annotations

import os
import time

from .instance import Instance
from .planif import planifier, resultat
from .qualite import evaluer
from .replanif import replanifier
from .valide import valider


def generer(data: dict, essais: int | None = None, seed: int = 1, concentration: float = 0.5,
            temps_amelioration: float = 60.0, processus: int | None = None) -> dict:
    t0 = time.perf_counter()
    inst = Instance(data)
    res = planifier(inst, essais, seed, concentration, processus=processus or os.cpu_count() or 1)
    st = res["statistiques"]
    st["glouton"] = {"taux": st["taux"], "duree_s": st["duree_s"]}
    if res["non_programmes"] and temps_amelioration > 0:
        try:
            from .ameliore import ameliorer, etat_depuis
        except ImportError:
            st["amelioration"] = "OR-Tools absent : résultat du glouton seul"
        else:
            raisons_glouton = {n["id_cours"]: n["raison"] for n in res["non_programmes"]}
            e = etat_depuis(inst, res["seances"])
            info = ameliorer(inst, e, temps_amelioration)
            raisons = {k: {r: 1} for k, r in raisons_glouton.items()}
            from collections import Counter
            res = resultat(inst, e, {k: Counter(v) for k, v in raisons.items()}, {})
            res["statistiques"].update({k: v for k, v in st.items() if k not in res["statistiques"]})
            res["statistiques"]["amelioration"] = info
            res["statistiques"].pop("cout", None)   # coût du glouton, non recalculé après CP-SAT
            st = res["statistiques"]
    viol = valider(data, res["seances"])
    st["violations"] = len(viol)
    st["qualite"] = evaluer(inst, res["seances"])
    st["duree_totale_s"] = round(time.perf_counter() - t0, 2)
    res["violations"] = viol
    return res


__all__ = ["generer", "replanifier", "Instance", "planifier", "valider", "evaluer"]
