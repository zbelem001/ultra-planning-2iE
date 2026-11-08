"""Défait un import d'HyperPlanning (charger_hyperplanning.py --appliquer) d'après sa trace brut/import_<date>.json :
séances et cours importés, programme, groupes, enseignants,
matières, classes et filières créés ; volumes du programme, début du semestre et maximum CD-13 d'avant.

À blanc par défaut (transaction annulée) ; --appliquer valide. Si une donnée créée par l'import sert depuis à autre
chose (un cours ajouté à une classe importée...), la base refuse la suppression et rien n'est défait.
Si les séances importées ont été publiées : elles sont retirées de la version à jour seulement (la version publiée ne
change que par une publication) ; publier la version à jour, puis relancer le script pour défaire le reste.

Usage (depuis backend/) : .venv/bin/python ../scrap/annuler_import.py import_<date>.json [--appliquer]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

import psycopg  # noqa: E402

from app import config  # noqa: E402
from app.db import entrer_ecole, origine  # noqa: E402

ECOLE, ADMINISTRATEUR = 1, 2
APPLIQUER = "--appliquer" in sys.argv


def defaire(conn, trace: dict) -> bool:
    """Défait l'import dans la transaction en cours ; False s'il reste des séances publiées (seule la version à jour
    a été nettoyée)."""
    creees = trace["creees"]

    def supprimer(sql: str, ids: list[int], libelle: str) -> None:
        if ids:
            n = conn.execute(sql, (ids,)).rowcount
            print(f"  {libelle} : {n}")

    cours = creees.get("cours", [])
    # un examen ne part pas avant son rattrapage ; seule la version à jour se modifie
    for nature in ("rattrapage", "examen", "cours"):
        supprimer(f"DELETE FROM seance s USING emploi_du_temps e WHERE e.id_edt = s.id_edt AND e.statut = 'brouillon' "
                  f"AND s.id_cours = ANY(%s) AND s.nature = '{nature}'", cours, f"séances de la version à jour ({nature})")
    publiees = conn.execute("SELECT count(*) FROM seance WHERE id_cours = ANY(%s)", (cours,)).fetchone()[0] if cours else 0
    if publiees:
        print(f"{publiees} séances importées sont dans la version publiée : publiez la version à jour, puis relancez ce script "
              "pour défaire le reste.")
        return False
    supprimer("DELETE FROM cours WHERE id_cours = ANY(%s)", cours, "cours (et leurs publics)")
    supprimer("DELETE FROM programme WHERE id_programme = ANY(%s)", creees.get("programme", []), "lignes de programme")
    for id_programme, cm, td, tp in trace["programme_avant"]:
        conn.execute("UPDATE programme SET volume_cm = %s, volume_td = %s, volume_tp = %s WHERE id_programme = %s", (cm, td, tp, id_programme))
    if trace["programme_avant"]:
        print(f"  volumes du programme remis : {len(trace['programme_avant'])}")
    supprimer("DELETE FROM groupe WHERE id_groupe = ANY(%s)", creees.get("groupe", []), "groupes et options")
    supprimer("DELETE FROM enseignant WHERE id_enseignant = ANY(%s)", creees.get("enseignant", []), "enseignants")
    supprimer("DELETE FROM matiere WHERE id_matiere = ANY(%s)", creees.get("matiere", []), "matières")
    supprimer("DELETE FROM classe WHERE id_classe = ANY(%s)", creees.get("classe", []), "classes")
    supprimer("DELETE FROM filiere WHERE id_filiere = ANY(%s)", creees.get("filiere", []), "filières")
    if trace.get("cd13_avant") is not None:
        conn.execute("UPDATE contrainte SET valeur = %s WHERE id_edt = %s AND type_contrainte = 'CD-13'", (trace["cd13_avant"], trace["id_edt"]))
        print(f"  CD-13 remis à {trace['cd13_avant']:g}")
    if trace.get("semestre_debut_avant"):
        conn.execute("UPDATE semestre SET date_debut = %s WHERE id_semestre = %s", (trace["semestre_debut_avant"], trace["id_semestre"]))
        print(f"  début du semestre remis au {trace['semestre_debut_avant']}")
    return True


def principal() -> None:
    noms = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(noms) != 1:
        sys.exit(__doc__)
    trace = json.loads((Path(__file__).parent / "brut" / Path(noms[0]).name).read_text())
    conn = psycopg.connect(config.DATABASE_URL, connect_timeout=15)
    entrer_ecole(conn, ECOLE, ADMINISTRATEUR)
    origine(conn, "systeme")
    conn.execute("SELECT set_config('app.note', %s, true)", ("Annulation de l'import HyperPlanning",))
    complet = defaire(conn, trace)
    if APPLIQUER:
        conn.commit()
        print("Import défait." if complet else "Séances retirées de la version à jour.")
    else:
        conn.rollback()
        print("À blanc : transaction annulée, la base n'a pas changé.")


if __name__ == "__main__":
    principal()
