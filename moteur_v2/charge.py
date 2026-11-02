"""Test de charge : génère des instances de taille croissante, résout, valide, affiche un tableau.

Exemple :  python moteur_v2/charge.py --classes 3 10 30 --groupes-min 3 --groupes-max 4 --temps 120
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from generate_data import generate   # noqa: E402
from validate import validate        # noqa: E402
from greedy import meilleur_placement   # noqa: E402
from qualite import evaluer          # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--classes", type=int, nargs="+", default=[3, 10])
    ap.add_argument("--groupes-min", type=int, default=2)
    ap.add_argument("--groupes-max", type=int, default=4)
    ap.add_argument("--temps", type=int, default=60, help="limite du solveur en secondes")
    ap.add_argument("--non-divisees", type=float, default=0.4,
                    help="part des promotions sans groupes (0.4 = 40 %%)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="charge_resultats.json")
    ap.add_argument("--log", action="store_true", help="journal détaillé du solveur")
    a = ap.parse_args()
    cpus = os.cpu_count() or 2
    print(f"processeurs disponibles : {cpus}")
    try:
        from solver import solve
    except ImportError:
        sys.exit("ortools n'est pas installé : pip install ortools")

    rows = []
    print(f"{'promos':>6} {'groupes':>7} {'ens.':>5} {'salles':>6} {'séances':>7} | "
          f"{'statut':>9} {'placé':>6} {'viol.':>5} {'variables':>10} {'temps(s)':>9} "
          f"{'objectif':>10} {'borne':>10} | {'glouton':>8} {'constr.(s)':>10}")
    for n in a.classes:
        data = generate(a.seed, n, a.groupes_min, a.groupes_max, ratio_non_divisees=a.non_divisees)
        data["parametres"] = {"time_limit_s": a.temps, "num_workers": cpus}
        t = time.time()
        res = solve(data, log=a.log)
        dur = time.time() - t
        viol = validate(data, res)
        q_f = evaluer(data, res)
        q_g = evaluer(data, meilleur_placement(data))
        mt = data["meta"]
        row = {"promotions": n, "groupes": mt["groupes"], "enseignants": mt["enseignants"],
               "salles": mt["salles"], "seances": mt["seances"], "statut": res["statut"],
               "taux_placement": res["taux_placement"], "violations": len(viol),
               "variables": res["taille_modele"].get("variables"), "temps_s": round(dur, 1),
               "objectif": res["objectif"], "borne": res["borne"], "processeurs": cpus,
               "glouton": res["glouton"], "temps_construction_s": res["temps_construction_s"],
               "qualite_glouton": q_g, "qualite_final": q_f,
               "non_placees": len(res["non_placees"]), "avertissements": res["avertissements"][:5],
               "premiers_motifs": [x["motif"] for x in res["non_placees"][:3]],
               "premieres_violations": viol[:5]}
        rows.append(row)
        print(f"{n:>6} {mt['groupes']:>7} {mt['enseignants']:>5} {mt['salles']:>6} {mt['seances']:>7} | "
              f"{res['statut']:>9} {res['taux_placement']:>6.2%} {len(viol):>5} "
              f"{row['variables'] or 0:>10} {dur:>9.1f} "
              f"{(res['objectif'] if res['objectif'] is not None else float('nan')):>10.0f} "
              f"{(res['borne'] if res['borne'] is not None else float('nan')):>10.0f} | "
              f"{res['glouton']['taux_placement']:>8.2%} "
              f"{(res['temps_construction_s'] if res['temps_construction_s'] is not None else float('nan')):>10.1f}")
        print(f"       qualité glouton -> final : score {q_g['score']:.0f} -> {q_f['score']:.0f} "
              f"(gain {q_g['score'] - q_f['score']:.0f}) | trous/groupe {q_g['trous_heures_par_groupe']} -> "
              f"{q_f['trous_heures_par_groupe']} h | sur préférence {q_g['seances_sur_preference_pct']} -> "
              f"{q_f['seances_sur_preference_pct']} % | changements midi (groupes) "
              f"{q_g['changements_site_midi_groupes']} -> {q_f['changements_site_midi_groupes']} | "
              f"hors site principal {q_g['seances_hors_site_principal']} -> {q_f['seances_hors_site_principal']}")
        sys.stdout.flush()
    json.dump(rows, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("détail :", a.out)


if __name__ == "__main__":
    main()
