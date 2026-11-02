"""Générateur de données fictives calé sur le profil réel de 2iE (format v3).

Repris du profil (`profil_2ie.py`) : promotions, site de chaque promotion, groupes
de TD, options, heures, salles (site, type, capacité), grille horaire, trajet.
Inventé, faute de données : effectifs, découpage en matières, part de TP,
enseignants et leurs disponibilités, règles du planificateur (exemples).

Format v3 (entrée du moteur `moteur/`) :
- calendrier : debut, fin, jours_feries, conges, plages par jour ;
- sites, trajet_min ;
- salles : id_site, type, capacite, reservee_a (promotions, vide = libre) ;
- classes : id_site, effectif ;
- groupes : arbre par promotion (parent None = enfant direct de la promotion),
  type TD, TP ou OPTION ; deux publics d'une même promotion sont en conflit
  si l'un contient l'autre ;
- cours : publics (plusieurs = cours mutualisé), enseignant, type de salle,
  volume, durees (découpage préféré), rythme hebdomadaire min/max ;
- enseignants : statut, plafond hebdomadaire, sejours (externes non résidents),
  indisponibilites et preferences par demi-journée ;
- regles : contraintes du planificateur stockées comme données.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import date, timedelta

try:
    from . import profil_2ie as P
except ImportError:  # lancé comme script
    import profil_2ie as P

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
DEMIS = [(j, d) for j in JOURS for d in (0, 1) if j != "Samedi" or d == 0]
EFFECTIF_TD = 30
EFFECTIF_OPTION = (20, 40)
EFFECTIF_SANS_GROUPE = (25, 60)
H_TYPE = 250                 # heures communes quand l'Excel est vide
PART_TP = 0.25               # part des heures de groupe faites en TP
MATIERE_H = (18, 42)         # volume d'une matière


def semaines_ouvertes(cal) -> int:
    d0, d1 = date.fromisoformat(cal["debut"]), date.fromisoformat(cal["fin"])
    conges = [(date.fromisoformat(a), date.fromisoformat(b)) for a, b in cal["conges"]]
    n, w = 0, d0
    while w <= d1:
        if not any(a <= w <= b for a, b in conges):
            n += 1
        w += timedelta(days=7)
    return n


def heures_semaine(plages) -> int:
    return sum(f - d for p in plages.values() for d, f in p)


def decouper_volume(total, rnd):
    """Découpe un volume en matières de 18 à 42 h."""
    out = []
    while total > 0:
        v = min(total, rnd.randint(*MATIERE_H))
        if 0 < total - v < MATIERE_H[0]:
            v = total
        out.append(v)
        total -= v
    return out


def generate(seed=1, promotions=None, taux_max=0.8, part_cross_site=0.1):
    """promotions : liste de codes à garder (None = toutes). taux_max : part maximale
    de la grille hebdomadaire qu'un étudiant peut occuper (au-delà, les heures sont réduites)."""
    rnd = random.Random(seed)
    cal = dict(P.SEMESTRE, plages=P.PLAGES)
    n_sem = semaines_ouvertes(cal)
    plafond_etudiant = int(taux_max * heures_semaine(P.PLAGES) * n_sem)
    sites = [{"id_site": 1, "nom": P.K}, {"id_site": 2, "nom": P.O}]
    id_site = {s["nom"]: s["id_site"] for s in sites}
    types = {"AMPHI": 1, "STD": 2, "LABO": 3, "INFO": 4, "AUTRE": 5}

    salles = []
    for site, t, cap in P.SALLES:
        salles.append({"id_salle": len(salles) + 1, "code_salle": f"{t}-{len(salles) + 1}",
                       "id_site": id_site[site], "id_type_salle": types[t],
                       "capacite": cap or P.CAPACITE_DEFAUT[t], "reservee_a": []})

    classes, groupes, cours, notes = [], [], [], []
    matiere = 0

    def groupe(ic, parent, t, eff, code):
        groupes.append({"id_groupe": len(groupes) + 1, "id_classe": ic, "parent": parent,
                        "type_groupe": t, "effectif": eff, "code_groupe": code})
        return groupes[-1]["id_groupe"]

    def ajouter(publics, t, tsalle, volume, mat):
        cours.append({"id_cours": len(cours) + 1, "id_matiere": mat, "type_cours": t,
                      "publics": publics, "id_enseignant": None, "id_type_salle": tsalle[0], "types_salle": tsalle,
                      "volume": volume, "durees": [2, 3] if t == "CM" else ([2, 4] if t == "TP" else [2]),
                      "h_sem_min": 2, "h_sem_max": 8 if t == "CM" else 6, "priorite": 1})

    profil = [p for p in P.PROMOTIONS if promotions is None or p[0] in promotions]
    for code, site, statut, h_com, tds, opts in profil:
        ic = len(classes) + 1
        h_com = h_com or H_TYPE
        tds = [h for h in tds if h]           # groupes à 0 h : non ouverts
        opts_h = [h for h in opts if h]
        eff_td = [rnd.randint(24, EFFECTIF_TD) for _ in tds]
        if tds:
            eff = sum(eff_td)
        elif opts_h:
            eff = sum(rnd.randint(*EFFECTIF_OPTION) for _ in opts_h)
        else:
            eff = rnd.randint(*EFFECTIF_SANS_GROUPE)
        # un étudiant suit : commun + son groupe (moyenne) ou son option (max)
        h_grp = (sum(tds) / len(tds)) if tds else (max(opts_h) if opts_h else 0)
        if h_com + h_grp > plafond_etudiant:
            r = plafond_etudiant / (h_com + h_grp)
            notes.append(f"{code} : {h_com + h_grp:.0f} h > {plafond_etudiant} h possibles, réduit à {r:.0%}")
            h_com, tds, opts_h = int(h_com * r), [int(h * r) for h in tds], [int(h * r) for h in opts_h]
        classes.append({"id_classe": ic, "code_classe": code, "id_site": id_site[site],
                        "site_statut": "confirmé" if statut == "c" else "supposé", "effectif": eff})
        s_info = types["LABO"] if site == P.K else types["INFO"]

        # cours communs (promotion entière)
        for v in decouper_volume(h_com, rnd):
            matiere += 1
            ajouter([{"id_classe": ic, "id_groupe": None}], "CM", [types["STD"], types["AMPHI"]], v, matiere)

        # groupes de TD : mêmes matières pour tous les groupes, TP par demi-groupe
        if tds:
            ids = [groupe(ic, None, "TD", eff_td[i], f"TD{i + 1}") for i in range(len(tds))]
            tp = {g: [groupe(ic, g, "TP", -(-eff_td[i] // 2), f"TD{i + 1}-TP{k}") for k in "ab"]
                  for i, g in enumerate(ids)}
            h_moy = int(sum(tds) / len(tds))
            h_tp = int(h_moy * PART_TP)
            for v in decouper_volume(h_moy - h_tp, rnd):
                matiere += 1
                for g in ids:
                    ajouter([{"id_classe": ic, "id_groupe": g}], "TD", [types["STD"]], v, matiere)
            if h_tp >= 4:
                matiere += 1
                for g in ids:
                    for sg in tp[g]:
                        ajouter([{"id_classe": ic, "id_groupe": sg}], "TP", [s_info], h_tp, matiere)

        # options : cours propres à chaque option
        for k, h in enumerate(opts_h):
            e = eff // len(opts_h)
            g = groupe(ic, None, "OPTION", e, f"OPT{k + 1}")
            for v in decouper_volume(h, rnd):
                matiere += 1
                ajouter([{"id_classe": ic, "id_groupe": g}], "CM", [types["STD"], types["AMPHI"]], v, matiere)

    # cours mutualisés : un tiers des CM de A suivis aussi par B (même site), B allégée d'autant
    code_id = {c["code_classe"]: c for c in classes}
    for a, b in P.MUTUALISEES:
        if a not in code_id or b not in code_id:
            continue
        ca, cb = code_id[a], code_id[b]
        if ca["id_site"] != cb["id_site"]:
            notes.append(f"mutualisation {a}/{b} ignorée : sites différents")
            continue
        cm_a = [c for c in cours if c["type_cours"] == "CM" and c["publics"] == [{"id_classe": ca["id_classe"], "id_groupe": None}]]
        cm_b = [c for c in cours if c["type_cours"] == "CM" and c["publics"] == [{"id_classe": cb["id_classe"], "id_groupe": None}]]
        for c in cm_a[: len(cm_a) // 3]:
            c["publics"].append({"id_classe": cb["id_classe"], "id_groupe": None})
            if cm_b:
                cours.remove(cm_b.pop())

    for i, c in enumerate(cours, 1):
        c["id_cours"] = i

    # salles réservées
    for prefixe, site, t, n in P.RESERVATIONS:
        ayants = [c["id_classe"] for c in classes if c["code_classe"].startswith(prefixe)]
        libres = [s for s in salles if s["id_site"] == id_site[site] and s["id_type_salle"] == types[t]
                  and not s["reservee_a"]]
        if ayants:
            for s in sorted(libres, key=lambda s: -s["capacite"])[:n]:
                s["reservee_a"] = ayants

    enseignants = affecter_enseignants(cours, classes, cal, n_sem, rnd, part_cross_site)
    regles = regles_exemples(cours, classes, rnd)

    meta = {"classes": len(classes), "groupes": len(groupes), "cours": len(cours),
            "enseignants": len(enseignants), "salles": len(salles), "semaines": n_sem,
            "heures": sum(c["volume"] for c in cours),
            "mutualises": sum(1 for c in cours if len(c["publics"]) > 1), "notes": notes}
    return {"version": 3, "calendrier": cal, "sites": sites,
            "trajet_min": {"1-2": P.TRAJET_MIN}, "types_salle": {v: k for k, v in types.items()},
            "salles": salles, "classes": classes, "groupes": groupes, "cours": cours,
            "enseignants": enseignants, "regles": regles, "seances_existantes": [],
            "parametres": {}, "meta": meta}


def affecter_enseignants(cours, classes, cal, n_sem, rnd, part_cross_site):
    """Un enseignant prend une matière entière (CM et TD), sur un site, jusqu'à sa charge
    du semestre, tirée autour de la médiane réelle (48 h)."""
    site_classe = {c["id_classe"]: c["id_site"] for c in classes}
    par_matiere = {}
    for c in cours:
        par_matiere.setdefault(c["id_matiere"], []).append(c)
    statuts = list(P.STATUTS)
    poids = list(P.STATUTS.values())
    enseignants, charge = [], {}

    def nouveau(site):
        st = rnd.choices(statuts, poids)[0]
        # charge du semestre : vacataires autour de la médiane réelle, permanents le double
        med = P.ENSEIGNANTS_MEDIANE_H * (2 if st == "permanent" else 1)
        cible = min(250 if st == "permanent" else 110, max(16, int(rnd.lognormvariate(math.log(med), 0.5))))
        e = {"id_enseignant": len(enseignants) + 1, "matricule": f"E{len(enseignants) + 1:04d}",
             "statut": st, "id_site": site, "cible_h": cible,
             "nb_heures_max_semaine": {"permanent": 18, "externe_resident": 12, "externe_non_resident": 30}[st],
             "sejours": [], "indisponibilites": [], "preferences": []}
        enseignants.append(e)
        charge[e["id_enseignant"]] = 0
        return e

    actifs = {1: [], 2: []}
    for mat, liste in par_matiere.items():
        site = site_classe[liste[0]["publics"][0]["id_classe"]]
        h = sum(c["volume"] for c in liste)
        # les gros blocs (7 groupes de TD) sont répartis entre plusieurs enseignants
        lots = [liste] if h <= 90 else [liste[i::math.ceil(h / 90)] for i in range(math.ceil(h / 90))]
        for lot in lots:
            hl = sum(c["volume"] for c in lot)
            pool = actifs[site] + ([e for e in actifs[3 - site]] if rnd.random() < part_cross_site else [])
            cand = [e for e in pool if charge[e["id_enseignant"]] + hl <= e["cible_h"]]
            e = rnd.choice(cand) if cand else nouveau(site)
            if e not in actifs[site] and e["id_site"] == site:
                actifs[site].append(e)
            for c in lot:
                c["id_enseignant"] = e["id_enseignant"]
            charge[e["id_enseignant"]] += hl

    d0 = date.fromisoformat(cal["debut"])
    for e in enseignants:
        h = charge[e["id_enseignant"]]
        e["charge_h"] = h
        del e["cible_h"]
        if e["statut"] == "externe_non_resident":
            # séjour : assez de semaines pour faire ses heures à ~20 h/semaine, plus une de marge ;
            # le rythme maximal de ses cours (CD-14) est fixé en conséquence
            n = min(n_sem, math.ceil(h / 20) + 1)
            debut = d0 + timedelta(days=7 * rnd.randint(0, max(0, n_sem - n - 3)))
            e["sejours"] = [[debut.isoformat(), (debut + timedelta(days=7 * n - 2)).isoformat()]]
            for c in cours:
                if c["id_enseignant"] == e["id_enseignant"]:
                    c["h_sem_max"] = max(c["h_sem_max"], math.ceil(c["volume"] / max(1, n - 1)))
        k_indispo = {"permanent": 2, "externe_resident": 5, "externe_non_resident": 0}[e["statut"]]
        choix = rnd.sample(DEMIS, k_indispo + 2)
        for jour, dm in choix[:k_indispo]:
            e["indisponibilites"].append({"jour": jour, "demi": dm})
        for jour, dm in choix[k_indispo:]:
            e["preferences"].append({"jour": jour, "demi": dm})
    return enseignants


def regles_exemples(cours, classes, rnd):
    """Exemples fictifs de règles du planificateur, pour tester le moteur."""
    regles = [{"id": 1, "type": "cm_avant_td", "dure": False, "poids": 3,
               "libelle": "Le CM d'une matière commence avant ses TD (CS-05)"},
              {"id": 2, "type": "site_unique_jour", "dure": True,
               "libelle": "Une promotion ne change pas de site dans la journée"},
              {"id": 3, "type": "plafond_jour", "cible": {"tous": True}, "heures": 8, "dure": True,
               "libelle": "8 h par jour au plus"},
              {"id": 4, "type": "plafond_jour", "cible": {"tous": True}, "heures": 6, "dure": False, "poids": 2,
               "libelle": "6 h par jour de préférence"}]
    for c in rnd.sample(classes, min(3, len(classes))):
        cm = [x for x in cours if x["publics"][0] == {"id_classe": c["id_classe"], "id_groupe": None}]
        if len(cm) >= 2:
            a, b = cm[0]["id_matiere"], cm[1]["id_matiere"]
            regles.append({"id": len(regles) + 1, "type": "precede", "matiere_avant": a, "matiere_apres": b,
                           "dure": True, "libelle": f"{c['code_classe']} : matière {a} finie avant le début de {b}"})
    c = rnd.choice(classes)
    regles.append({"id": len(regles) + 1, "type": "interdire", "cible": {"id_classe": c["id_classe"]},
                   "jours": ["Mercredi"], "demi": 1, "dure": True,
                   "libelle": f"{c['code_classe']} : pas de cours le mercredi après-midi"})
    return regles


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--promotions", nargs="*", help="codes à garder (défaut : toutes)")
    ap.add_argument("--out", default="data/instance_2ie.json")
    a = ap.parse_args()
    d = generate(a.seed, a.promotions)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)
    print("écrit :", a.out)
    for k, v in d["meta"].items():
        print(f"  {k}: {v}")
