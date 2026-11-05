"""python -m ultraplanning_solver.v3 instance.json [--out resultat.json] [--essais N] [--amelioration S]"""
import argparse
import json
import os
import sys

from . import generer


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ultraplanning_solver.v3")
    ap.add_argument("instance")
    ap.add_argument("--out")
    ap.add_argument("--essais", type=int)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--processus", type=int, default=os.cpu_count() or 1, help="essais en parallèle")
    ap.add_argument("--concentration", type=float, default=0.5,
                    help="part du rythme maximal demandée chaque semaine (0 = étalé, 1 = par modules)")
    ap.add_argument("--amelioration", type=float, default=60.0,
                    help="secondes d'amélioration CP-SAT (0 = glouton seul)")
    a = ap.parse_args(argv)
    with open(a.instance, encoding="utf-8") as f:
        data = json.load(f)
    res = generer(data, a.essais, a.seed, a.concentration, a.amelioration, a.processus)
    st = res["statistiques"]
    print(json.dumps({k: v for k, v in st.items() if k != "avertissements"}, ensure_ascii=False, indent=1))
    for w in st["avertissements"][:10]:
        print("  avertissement :", w)
    for x in res["violations"][:10]:
        print("  VIOLATION :", x)
    raisons = {}
    for n in res["non_programmes"]:
        raisons[n["raison"]] = raisons.get(n["raison"], 0) + n["heures"]
    for r, h in sorted(raisons.items(), key=lambda x: -x[1]):
        print(f"  non programmé : {h} h — {r}")
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
    return 0 if not res["violations"] else 1


if __name__ == "__main__":
    sys.exit(main())
