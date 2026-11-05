"""Convertit les réponses HyperPlanning de brut/ en CSV importables dans le référentiel
d'UltraPlanning (Référentiel > Importer un fichier), dans csv/.

Colonnes : noms des champs du référentiel (code_salle, nom_salle...) ; les références par
libellé ou code, comme l'import les attend (site « Campus de Ouagadougou », filière « IA »,
classe « IIA-S9 », matière « IIA-ML », enseignant « NOM (à compléter) »...).

Ordre d'import : sites, salles, classes, matieres, enseignants, programme, cours.
seances.csv est la liste brute des séances (référence), pas un fichier du référentiel.

Usage : python3 vers_csv.py
"""

from __future__ import annotations

import csv
import glob
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

# --- correspondances (à ajuster au besoin) -------------------------------------------
CLASSE = {"code_classe": "IIA-S9", "libelle": "Cycle ingénieur IIA S9", "niveau": "M2", "effectif": 0, "filiere": "IA"}
SEMESTRE = "Semestre 1 2026-2027"  # semestre du référentiel auquel rattacher programme et cours
TYPES = {"Cours": "CM", "TD": "TD", "TP": "TP", "Projet": "TP"}  # Examen et autres : hors cours
SITES = {"Ouaga": ("OUAGA", "Campus de Ouagadougou"), "Kamboinsé": ("KAMB", "Campus de Kamboinsé")}
PRENOM_INCONNU = "(à compléter)"  # HyperPlanning ne donne que le nom de famille

BRUT, SORTIE = Path("brut"), Path("csv")


def sans_accents(s: str) -> str:
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()


def type_de_salle(nom: str) -> str:
    n = sans_accents(nom).upper()
    if "AMPHI" in n:
        return "Amphithéâtre"
    if "INFO" in n:
        return "Salle informatique"
    if "LABO" in n or "LAB " in n:
        return "Laboratoire"
    return "Salle standard"


def code_salle(nom: str) -> str:
    n = sans_accents(nom).upper()
    n = re.sub(r"^SALLE\s+", "", n)
    n = re.sub(r"\s*-\s*.*$", "", n) if "AMPHITHEATRE" in n else n  # « AMPHITHEATRE 1 - Hugues DEVEVEY »
    n = n.replace("AMPHITHEATRE", "AMPHI")
    return re.sub(r"[^A-Z0-9]+", "-", n).strip("-")[:20]


def code_matiere(libelle: str, pris: set[str]) -> str:
    texte = sans_accents(re.sub(r"[’'](?=\w)", " ", libelle))  # « l’éthique » : deux mots
    mots = [m for m in re.split(r"[^A-Za-z0-9]+", texte) if len(m) >= 3 or m.isupper()]
    base = "IIA-" + "".join(m[0] for m in mots).upper()[:5]
    code, i = base, 2
    while code in pris:
        code, i = f"{base}{i}", i + 1
    pris.add(code)
    return code


def libelle(c) -> str | None:
    if isinstance(c, dict):
        return c.get("L")
    if isinstance(c, list):
        return " / ".join(x.get("L", "") for x in c) or None
    return c or None


def ecrire(nom: str, colonnes: list[str], lignes: list[dict]) -> None:
    SORTIE.mkdir(exist_ok=True)
    with open(SORTIE / nom, "w", newline="", encoding="utf-8-sig") as f:  # BOM : Excel lit les accents
        w = csv.DictWriter(f, colonnes, delimiter=";")
        w.writeheader()
        w.writerows(lignes)
    print(f"{nom} : {len(lignes)} ligne(s)")


# --- lecture -------------------------------------------------------------------------
param = json.load(open(BRUT / "parametres.json"))["dataSec"]["data"]["parametreGeneral"]
premier_lundi = datetime.strptime(param["PremierLundi"]["V"], "%d/%m/%Y").date()
places_jour = param["PlacesParJour"]

cours_hp = {}
for f in sorted(glob.glob(str(BRUT / "semaine_iso_*.json"))):
    for c in json.load(open(f))["dataSec"]["data"]["ListeCours"]:
        cours_hp[c["N"], c["dom"]] = c  # une même réponse peut revenir pour deux clics

seances = []
for c in cours_hp.values():
    g = {x["G"]: libelle(x["C"]) for x in c["listeC"]}
    semaine = int(c["dom"].strip("[]"))
    jour, place = divmod(c["p"], places_jour)
    d = premier_lundi + timedelta(weeks=semaine - 1, days=jour)
    debut = 7 + place  # grille d'une heure à partir de 7h
    seances.append({
        "date": d, "debut": debut, "fin": debut + c["d"], "duree": c["d"], "matiere": g.get(0), "enseignant": g.get(1),
        "salle": g.get(3), "site": g.get(10), "type_hp": g.get(7), "numero": g.get(6), "semaine": semaine,
    })
seances.sort(key=lambda s: (s["date"], s["debut"]))

# --- salles et sites -----------------------------------------------------------------
salles_hp = json.load(open(BRUT / "salles.json"))["dataSec"]["data"]["listeSalles"]["V"]
codes_salle = {}
lignes_salles = []
for s in sorted(salles_hp, key=lambda x: x["L"]):
    site = s["site"]["V"]["L"]
    code = code_salle(s["L"])
    while code in codes_salle.values():
        code += "B"
    codes_salle[s["L"]] = code
    lignes_salles.append({
        "code_salle": code, "nom_salle": s["L"], "type_salle": type_de_salle(s["L"]),
        "capacite": s.get("capacite") or 1, "site": SITES.get(site, (site, site))[1], "batiment": "",
        "est_disponible": "oui",
    })
ecrire("salles.csv", ["code_salle", "nom_salle", "type_salle", "capacite", "site", "batiment", "est_disponible"], lignes_salles)
ecrire("sites.csv", ["code_site", "nom_site", "type_site"],
       [{"code_site": code, "nom_site": nom, "type_site": "campus"} for code, nom in SITES.values()])

# --- classe --------------------------------------------------------------------------
ecrire("classes.csv", ["code_classe", "libelle", "niveau", "effectif", "filiere"], [CLASSE])

# --- matières et enseignants ---------------------------------------------------------
pris: set[str] = set()
codes_mat = {m: code_matiere(m, pris) for m in sorted({s["matiere"] for s in seances if s["matiere"]})}
ecrire("matieres.csv", ["code_matiere", "libelle", "coefficient"],
       [{"code_matiere": c, "libelle": m, "coefficient": 1} for m, c in codes_mat.items()])

noms_ens = sorted({e for s in seances if s["enseignant"] for e in s["enseignant"].split(" / ")})
ecrire("enseignants.csv", ["matricule", "nom", "prenom", "statut"],
       [{"matricule": f"HP-{sans_accents(n).upper()}", "nom": n, "prenom": PRENOM_INCONNU, "statut": "permanent"} for n in noms_ens])
etiquette_ens = lambda n: f"{n} {PRENOM_INCONNU}"  # noqa: E731 - libellé attendu par l'import (nom prénom)

# --- programme et cours (séances des types CM / TD / TP) ------------------------------
par_cours: dict[tuple[str, str], list[dict]] = defaultdict(list)
for s in seances:
    t = TYPES.get(s["type_hp"] or "")
    if t and s["matiere"]:
        par_cours[s["matiere"], t].append(s)

programme: dict[str, dict] = defaultdict(lambda: {"CM": 0, "TD": 0, "TP": 0})
lignes_cours = []
for (mat, t), ss in sorted(par_cours.items()):
    volume = sum(s["duree"] for s in ss)
    programme[mat][t] += volume
    par_semaine = Counter(s["semaine"] for s in ss)
    heures_semaine = Counter()
    for s in ss:
        heures_semaine[s["semaine"]] += s["duree"]
    enseignants = Counter(s["enseignant"] for s in ss if s["enseignant"])
    duree = Counter(min(max(s["duree"], 2), 4) for s in ss).most_common(1)[0][0]
    lignes_cours.append({
        "matiere": codes_mat[mat], "type_cours": t, "classe": CLASSE["code_classe"], "groupe": "",
        "enseignant": etiquette_ens(enseignants.most_common(1)[0][0].split(" / ")[0]) if enseignants else "",
        "volume_horaire": volume, "duree_seance": duree, "nb_seances_semaine": max(par_semaine.values()),
        "priorite": 0, "heures_semaine_min": 2, "heures_semaine_max": max(2, max(heures_semaine.values())),
        "semestre": SEMESTRE,
    })
ecrire("programme.csv", ["classe", "matiere", "semestre", "volume_cm", "volume_td", "volume_tp"],
       [{"classe": CLASSE["code_classe"], "matiere": codes_mat[m], "semestre": SEMESTRE,
         "volume_cm": v["CM"], "volume_td": v["TD"], "volume_tp": v["TP"]} for m, v in sorted(programme.items())])
ecrire("cours.csv", ["matiere", "type_cours", "classe", "groupe", "enseignant", "volume_horaire", "duree_seance",
                     "nb_seances_semaine", "priorite", "heures_semaine_min", "heures_semaine_max", "semestre"], lignes_cours)

# --- séances (référence) -------------------------------------------------------------
JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
ecrire("seances.csv", ["date", "jour", "heure_debut", "heure_fin", "duree_h", "classe", "matiere", "libelle_matiere",
                       "type_hyperplanning", "type_cours", "enseignant", "salle", "code_salle", "site", "numero", "semaine"],
       [{"date": s["date"].isoformat(), "jour": JOURS[s["date"].weekday()], "heure_debut": f"{s['debut']:02d}:00",
         "heure_fin": f"{s['fin']:02d}:00", "duree_h": s["duree"], "classe": CLASSE["code_classe"],
         "matiere": codes_mat.get(s["matiere"], ""), "libelle_matiere": s["matiere"] or "", "type_hyperplanning": s["type_hp"] or "",
         "type_cours": TYPES.get(s["type_hp"] or "", ""), "enseignant": s["enseignant"] or "", "salle": s["salle"] or "",
         "code_salle": codes_salle.get(s["salle"] or "", ""), "site": SITES.get(s["site"] or "", ("", s["site"] or ""))[1],
         "numero": s["numero"] or "", "semaine": s["semaine"]} for s in seances])
print(f"séances du {seances[0]['date']} au {seances[-1]['date']}")
