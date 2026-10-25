"""Ligne de commande : python -m ultraplanning_solver --help"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from datetime import date

import psycopg

from .base import charger, enregistrer
from .demande import Demande, Perimetre
from .moteur import generer


def main() -> None:
    p = argparse.ArgumentParser(prog="ultraplanning_solver", description="Génère un emploi du temps avec CP-SAT.")
    p.add_argument("--dsn", default=os.environ.get("DATABASE_URL"), help="Connexion PostgreSQL (défaut : $DATABASE_URL)")
    p.add_argument("--edt", type=int, required=True, help="Identifiant de l'emploi du temps (brouillon)")
    p.add_argument("--filiere", action="append", default=[], help="Code de filière du périmètre (répétable)")
    p.add_argument("--classe", action="append", default=[], help="Code de classe du périmètre (répétable)")
    p.add_argument("--du", type=date.fromisoformat, help="Début de la période (AAAA-MM-JJ)")
    p.add_argument("--au", type=date.fromisoformat, help="Fin de la période (AAAA-MM-JJ)")
    p.add_argument("--minimiser-changements", action="store_true", help="Replanification : changer le moins possible")
    p.add_argument("--ecrire", action="store_true", help="Enregistrer le résultat dans la base")
    p.add_argument("--json", action="store_true", help="Sortie JSON")
    a = p.parse_args()
    if not a.dsn:
        p.error("indiquez --dsn ou la variable DATABASE_URL")

    with psycopg.connect(a.dsn) as conn:
        d = charger(conn, a.edt)
        # les codes ne sont uniques que dans une école : celle de l'emploi du temps
        filieres = {r[0] for r in conn.execute(
            "SELECT id_filiere FROM filiere WHERE id_ecole = %s AND code_filiere = ANY(%s)", (d.id_ecole, a.filiere))}
        classes = {r[0] for r in conn.execute(
            "SELECT id_classe FROM classe WHERE id_ecole = %s AND code_classe = ANY(%s)", (d.id_ecole, a.classe))}
        demande = Demande(
            perimetre=Perimetre(frozenset(filieres), frozenset(classes)),
            du=a.du, au=a.au, minimiser_changements=a.minimiser_changements,
        )
        r = generer(d, demande)
        ecrites = enregistrer(conn, a.edt, r) if a.ecrire else 0

    if a.json:
        print(json.dumps({
            "statistiques": r.statistiques,
            "non_places": [n.__dict__ | {"semaine": n.semaine.isoformat() if n.semaine else None} for n in r.non_places],
            "modifications": r.modifications(),
            "seances_ecrites": ecrites,
        }, ensure_ascii=False, indent=2, default=str))
        return

    s = r.statistiques
    print(f"{s['heures_placees']} h placées sur {s['heures_demandees']} h demandées · {s['cours']} cours · "
          f"{s['semaines']} semaines · {s['iterations']} itération(s) · {s['duree_s']} s")
    par_cours = defaultdict(int)
    for x in r.seances:
        par_cours[x.id_cours] += x.duree
    for n in r.non_places:
        print(f"  non placé : cours {n.id_cours}, {n.heures} h — {n.raison}")
    if a.ecrire:
        print(f"{ecrites} séances enregistrées dans l'emploi du temps {a.edt} (validées par la base).")


if __name__ == "__main__":
    main()
