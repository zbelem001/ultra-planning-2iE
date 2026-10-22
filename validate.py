"""Validateur v2 INDÉPENDANT du solveur : recompte toutes les contraintes dures.

Résultat attendu : {"seances": [{"id_cours","index","jour","heure_debut","duree","id_salle"}, ...]}
Retourne la liste des violations (vide = OK).
"""
from collections import defaultdict

try:  # utilisé comme paquet (from moteur_v2.solver import solve) ou comme scripts
    from .instance import DEFAUT_CAL, DEFAUT_PARAM
except ImportError:
    from instance import DEFAUT_CAL, DEFAUT_PARAM


def validate(data, result):
    v = []
    cal = {**DEFAUT_CAL, **data.get("calendrier", {})}
    prm = {**DEFAUT_PARAM, **data.get("parametres", {})}
    jours = cal["jours"]
    jidx = {j: i for i, j in enumerate(jours)}
    p0, p1 = cal["pause"]
    salles = {s["id_salle"]: s for s in data["salles"]}
    classes = {c["id_classe"]: c for c in data["classes"]}
    groupes = {g["id_groupe"]: g for g in data["groupes"]}
    cours = {c["id_cours"]: c for c in data["cours"]}
    gpc = defaultdict(list)
    for g in data["groupes"]:
        gpc[g["id_classe"]].append(g["id_groupe"])
    indispo = set()
    for it in data.get("indisponibilites", []):
        for h in range(it["heure_debut"], it["heure_fin"]):
            indispo.add((it["id_enseignant"], jidx[it["jour"]], h))

    occup = defaultdict(list)          # (ressource, j, h) -> [tags]
    charge = defaultdict(int)          # (entité, j) -> heures
    sites_demi = defaultdict(set)      # (entité, j, demi) -> {sites}
    vus = set()

    for s in result["seances"]:
        cid, k = s["id_cours"], s["index"]
        tag = f"cours {cid} séance {k}"
        c = cours.get(cid)
        if c is None:
            v.append(f"{tag}: cours inconnu"); continue
        dec = c.get("decoupage") or [c.get("duree_seance", 2)] * c.get("nb_seances_semaine", 1)
        if (cid, k) in vus:
            v.append(f"{tag}: placée deux fois")
        vus.add((cid, k))
        if not 0 <= k < len(dec):
            v.append(f"{tag}: index hors découpage prévu (CD-08)"); continue
        d = s["duree"]
        if d != dec[k]:
            v.append(f"{tag}: durée {d} h différente du découpage prévu {dec[k]} h (CD-08)")
        if not cal["duree_min"] <= d <= cal["duree_max"]:
            v.append(f"{tag}: durée {d} h hors de [{cal['duree_min']}, {cal['duree_max']}]")
        if s["jour"] not in jidx:
            v.append(f"{tag}: jour inconnu"); continue
        j, h0 = jidx[s["jour"]], s["heure_debut"]
        fin = h0 + d
        if h0 < cal["heure_ouverture"] or fin > cal["heure_fermeture"]:
            v.append(f"{tag}: hors des horaires d'ouverture")
        if not (fin <= p0 or h0 >= p1):
            v.append(f"{tag}: chevauche la pause {p0}h-{p1}h")
        if s["jour"] == "Samedi" and not cal["samedi_apres_midi"] and fin > p0:
            v.append(f"{tag}: cours le samedi après-midi")
        sid = s["id_salle"]
        if sid not in salles:
            v.append(f"{tag}: salle {sid} inconnue"); continue
        salle = salles[sid]
        eff = (groupes[c["id_groupe"]]["effectif"] if c.get("id_groupe")
               else classes[c["id_classe"]]["effectif"])
        if not salle.get("est_disponible", True):
            v.append(f"{tag}: salle {sid} indisponible")
        if salle["capacite"] < eff:
            v.append(f"{tag}: capacité {salle['capacite']} < effectif {eff} (CD-04)")
        if c.get("id_type_salle") is not None and salle["id_type_salle"] != c["id_type_salle"]:
            v.append(f"{tag}: type de salle incorrect (CD-05)")
        ens = c["id_enseignant"]
        ents = ([("G", c["id_groupe"])] if c.get("id_groupe")
                else [("G", g) for g in gpc[c["id_classe"]]] or [("C", c["id_classe"])])
        ressources = [("S", sid), ("E", ens)] + ents
        for hh in range(h0, fin):
            if (ens, j, hh) in indispo:
                v.append(f"{tag}: enseignant {ens} indisponible {s['jour']} {hh}h (CD-06)")
            for r in ressources:
                occup[(r, j, hh)].append(tag)
        demi = 0 if h0 < p0 else 1
        for e in ents + [("E", ens)]:
            charge[(e, j)] += d
            sites_demi[(e, j, demi)].add(salle["site"])

    noms = {"S": "salle", "E": "enseignant", "G": "groupe", "C": "classe"}
    codes = {"S": "CD-01", "E": "CD-02", "G": "CD-03", "C": "CD-03"}
    deja = set()
    for (r, j, hh), tags in occup.items():
        t = sorted(set(tags))
        if len(t) > 1 and (r, tuple(t)) not in deja:
            deja.add((r, tuple(t)))
            v.append(f"{noms[r[0]]} {r[1]} {jours[j]} {hh}h: conflit {t} ({codes[r[0]]})")
    for (e, j), h in charge.items():
        if h > prm["max_heures_jour"]:
            v.append(f"{noms[e[0]]} {e[1]} {jours[j]}: {h} h > {prm['max_heures_jour']} h/jour")
    for (e, j, demi), sites in sites_demi.items():
        if len(sites) > 1:
            v.append(f"{noms[e[0]]} {e[1]} {jours[j]} ({'matin' if demi == 0 else 'après-midi'}): "
                     f"plusieurs sites {sorted(sites)} dans la même demi-journée (trajet 1 h)")
    return v
