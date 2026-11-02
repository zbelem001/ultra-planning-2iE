"""Générateur de données fictives v2, à l'échelle de 2iE (≈ 30 promotions, 2 sites).

Chaque promotion : des matières avec CM (classe entière, amphi), TD (par groupe, salle standard)
et parfois TP (par groupe, laboratoire), découpés en séances de 2 à 4 h.
Les salles et enseignants sont dimensionnés selon la charge (paramètres modifiables).
"""
import argparse
import json
import math
import random

SITES = ["Kamboinsé", "Ouaga"]
T_AMPHI, T_STD, T_LABO = 1, 2, 3
CM_CHOIX = [[2], [2, 2], [3], [2, 3], [4]]
TD_CHOIX = [[2], [2, 2], [3]]
TP_CHOIX = [[3], [4], [2, 2]]
DEMIS = [(j, d) for j in ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
         for d in (0, 1) if not (j == "Samedi" and d == 1)]


def generate(seed=1, nb_classes=3, groupes_min=2, groupes_max=3, charge_cible=24,
             nb_enseignants=None, ratio_vacataires=0.3, taux_salle=0.45, ratio_ouaga=0.3,
             ratio_non_divisees=0.0):
    """ratio_non_divisees : part des promotions sans groupes (TD/TP donnés à la promotion entière)."""
    rnd = random.Random(seed)
    classes, groupes, cours = [], [], []

    def add_cours(ic, gid, tc, tsalle, dec, mat):
        cours.append({"id_cours": len(cours) + 1, "id_classe": ic, "id_groupe": gid,
                      "id_enseignant": None, "id_type_salle": tsalle, "type_cours": tc,
                      "id_matiere": mat, "decoupage": list(dec)})

    mat = 0
    for ic in range(1, nb_classes + 1):
        gids = []
        if rnd.random() < ratio_non_divisees:
            eff_classe = rnd.randint(25, 45)          # promotion sans groupes
        else:
            for g in range(1, rnd.randint(groupes_min, groupes_max) + 1):
                gid = len(groupes) + 1
                groupes.append({"id_groupe": gid, "id_classe": ic, "code_groupe": f"C{ic}-G{g}",
                                "effectif": rnd.randint(28, 45)})
                gids.append(gid)
            eff_classe = sum(groupes[g - 1]["effectif"] for g in gids)
        cibles = gids or [None]                        # None = promotion entière
        classes.append({"id_classe": ic, "code_classe": f"C{ic}", "effectif": eff_classe,
                        "site_principal": SITES[1] if rnd.random() < ratio_ouaga else SITES[0]})
        charge = 0
        while charge < charge_cible:
            mat += 1
            dcm = rnd.choice(CM_CHOIX)
            add_cours(ic, None, "CM", T_AMPHI, dcm, mat)
            charge += sum(dcm)
            dtd = rnd.choice(TD_CHOIX)
            for gid in cibles:
                add_cours(ic, gid, "TD", T_STD, dtd, mat)
            charge += sum(dtd)
            if rnd.random() < 0.5:
                dtp = rnd.choice(TP_CHOIX)
                for gid in cibles:
                    add_cours(ic, gid, "TP", T_LABO, dtp, mat)
                charge += sum(dtp)

    # --- enseignants : dimensionnés selon la charge ---
    heures_cours = {c["id_cours"]: sum(c["decoupage"]) for c in cours}
    total = sum(heures_cours.values())
    moy_max = (1 - ratio_vacataires) * 16 + ratio_vacataires * 8
    n_ens = nb_enseignants or max(3, math.ceil(total / (0.65 * moy_max)))
    enseignants = []
    for i in range(n_ens):
        vac = i >= round(n_ens * (1 - ratio_vacataires))
        enseignants.append({"id_enseignant": i + 1, "matricule": f"E{i+1:04d}",
                            "statut": "vacataire" if vac else "titulaire",
                            "nb_heures_max_semaine": 8 if vac else 16})
    charge_ens = {e["id_enseignant"]: 0 for e in enseignants}
    for c in sorted(cours, key=lambda c: -heures_cours[c["id_cours"]]):
        h = heures_cours[c["id_cours"]]
        libres = [e for e in enseignants
                  if charge_ens[e["id_enseignant"]] + h <= e["nb_heures_max_semaine"]]
        if not libres:
            nid = len(enseignants) + 1
            enseignants.append({"id_enseignant": nid, "matricule": f"E{nid:04d}",
                                "statut": "titulaire", "nb_heures_max_semaine": 16})
            charge_ens[nid] = 0
            libres = [enseignants[-1]]
        e = min(libres, key=lambda e: charge_ens[e["id_enseignant"]])
        c["id_enseignant"] = e["id_enseignant"]
        charge_ens[e["id_enseignant"]] += h

    indispos, prefs = [], []
    plages = {0: (7, 12), 1: (13, 18)}
    for e in enseignants:
        k = 5 if e["statut"] == "vacataire" else 2
        choix = rnd.sample(DEMIS, k + 3)
        for jour, d in choix[:k]:
            indispos.append({"id_enseignant": e["id_enseignant"], "jour": jour,
                             "heure_debut": plages[d][0], "heure_fin": plages[d][1]})
        for jour, d in choix[k:]:
            prefs.append({"id_enseignant": e["id_enseignant"], "jour": jour,
                          "heure_debut": plages[d][0], "heure_fin": plages[d][1]})

    # --- salles : dimensionnées selon les heures par type ---
    heures_type = {T_AMPHI: 0, T_STD: 0, T_LABO: 0}
    for c in cours:
        heures_type[c["id_type_salle"]] += heures_cours[c["id_cours"]]
    heures_dispo = 55 * taux_salle
    salles = []
    cap = {T_AMPHI: lambda: rnd.choice([200, 300]), T_STD: lambda: rnd.choice([50, 60, 80]),
           T_LABO: lambda: 48}
    nom = {T_AMPHI: "AMPHI", T_STD: "S", T_LABO: "LAB"}
    for t, h in heures_type.items():
        n = max(2, math.ceil(h / heures_dispo))
        sites = [SITES[1] if rnd.random() < ratio_ouaga else SITES[0] for _ in range(n)]
        if n >= 2 and SITES[1] not in sites:
            sites[-1] = SITES[1]
        for i in range(n):
            sid = len(salles) + 1
            salles.append({"id_salle": sid, "code_salle": f"{nom[t]}-{i+1}", "capacite": cap[t](),
                           "site": sites[i], "id_type_salle": t, "est_disponible": True})

    return {
        "calendrier": {}, "sites": SITES, "salles": salles, "classes": classes,
        "groupes": groupes, "enseignants": enseignants, "cours": cours,
        "indisponibilites": indispos, "preferences": prefs, "seances_verrouillees": [],
        "parametres": {"time_limit_s": 60},
        "meta": {"classes": len(classes), "groupes": len(groupes), "enseignants": len(enseignants),
                 "classes_non_divisees": sum(1 for c in classes
                                             if not any(g["id_classe"] == c["id_classe"] for g in groupes)),
                 "salles": len(salles), "cours": len(cours),
                 "seances": sum(len(c["decoupage"]) for c in cours), "heures_total": total},
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--classes", type=int, default=3)
    ap.add_argument("--groupes-min", type=int, default=2)
    ap.add_argument("--groupes-max", type=int, default=3)
    ap.add_argument("--non-divisees", type=float, default=0.0, help="part des promotions sans groupes")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default="data/input_v2_demo.json")
    a = ap.parse_args()
    d = generate(a.seed, a.classes, a.groupes_min, a.groupes_max, ratio_non_divisees=a.non_divisees)
    json.dump(d, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("écrit :", a.out, d["meta"])
