"""Replanification avec le moins de changements possible (mise à jour quotidienne).

Entrée : l'instance v3 avec `seances_existantes` (emploi du temps en cours), un
périmètre (promotions, enseignants ou cours ; vide = tout) et une période.

1. Les séances verrouillées et celles hors périmètre ou hors période sont figées.
2. Chaque séance du périmètre est revérifiée à sa place actuelle avec les données
   du jour (absence, nouvelle règle, salle fermée…) : si elle est toujours valide,
   elle ne bouge pas ; si seule sa salle pose problème, on change de salle.
3. Les séances devenues impossibles sont replacées dans la période, la même
   semaine d'abord.
4. `ramener_depuis` : les séances du périmètre à partir de cette date, hors de la période, y sont
   ramenées, au plus près de leur date ; celles qui n'y trouvent pas de place restent où elles
   sont (type « restée »).
5. `completer=True` : programme en plus les heures encore dues dans la période.

Chaque séance garde son enseignant (`id_enseignant`, qui peut différer de celui du cours
ou manquer : à désigner).

Sortie : le résultat habituel et `modifications` (avant / après / raison), à
présenter au planificateur pour validation.
"""
from __future__ import annotations

import random
import time as chrono
from collections import Counter, defaultdict
from datetime import date

from .instance import Instance
from .planif import Etat, placer_seance, resultat, un_essai
from .valide import valider


def _fmt(inst: Instance, di: int, debut: int, duree: int, salle: int) -> dict:
    return {"date": inst.dates[di].isoformat(), "heure_debut": f"{debut:02d}:00",
            "heure_fin": f"{debut + duree:02d}:00", "id_salle": salle}


def _bornes(inst: Instance, e: Etat, c):
    preds = inst.precede.get(c.matiere, [])
    suivantes = [b for b, avants in inst.precede.items() if c.matiere in avants]
    apres = max((e.fin_matiere[m] for m in preds if m in e.fin_matiere), default=None)
    avant = min((e.debut_matiere[m] for m in suivantes if m in e.debut_matiere), default=None)
    return apres, avant


def replanifier_etat(inst: Instance, existantes: list[dict], dans_perimetre, du_d: date, au_d: date,
                     completer: bool, rnd: random.Random, ramener_depuis: date | None = None):
    """Cœur de la replanification. `existantes` : séances au format v3 (id_cours, date, heure_debut,
    heure_fin, id_salle, est_verrouillee, id_enseignant facultatif) ; `dans_perimetre(cours)`.
    Renvoie (état, modifications, raisons, séances vérifiées, avertissements)."""
    semaines = sorted({inst.semaine_de[i] for i, x in enumerate(inst.dates) if du_d <= x <= au_d})
    e = Etat(inst)
    a_verifier, a_ramener, modifications, avertissements = [], [], [], []

    # 1. séances figées
    for s in existantes:
        c = inst.cours[s["id_cours"]]
        ens = s.get("id_enseignant", c.enseignant)
        d = date.fromisoformat(s["date"])
        h0, h1 = int(s["heure_debut"][:2]), int(s["heure_fin"][:2])
        concernee = dans_perimetre(c) and du_d <= d <= au_d
        if ramener_depuis and dans_perimetre(c) and not concernee and d >= ramener_depuis and not s.get("est_verrouillee"):
            a_ramener.append((c, d, h0, h1 - h0, s["id_salle"], ens))
            continue
        if s.get("est_verrouillee") or not concernee:
            if d in inst.index_date:
                e.poser(c, inst.index_date[d], h0, h1 - h0, s["id_salle"], ens=ens, fixe=True)
            elif s.get("est_verrouillee"):
                avertissements.append(f"séance verrouillée du cours {c.id} le {s['date']} : jour fermé, gardée telle quelle")
            continue
        a_verifier.append((c, d, h0, h1 - h0, s["id_salle"], ens))

    # 2. revérifier chaque séance du périmètre à sa place (ordre chronologique)
    a_replacer = []
    for c, d, h0, duree, salle, ens in sorted(a_verifier, key=lambda x: (x[1], x[2])):
        avant = _fmt(inst, inst.index_date[d], h0, duree, salle) if d in inst.index_date else \
            {"date": d.isoformat(), "heure_debut": f"{h0:02d}:00", "heure_fin": f"{h0 + duree:02d}:00", "id_salle": salle}
        echecs: Counter = Counter()
        if d in inst.index_date:
            di = inst.index_date[d]
            w = inst.semaine_de[di]
            if placer_seance(inst, e, c, duree, w, rnd, echecs, *_bornes(inst, e, c), seulement=(di, h0),
                             salle_pref=salle, ens=ens):
                nouvelle = e.seances[-1]
                if nouvelle["id_salle"] != salle:
                    modifications.append({"id_cours": c.id, "type": "salle changée", "avant": avant,
                                          "apres": _fmt(inst, di, h0, duree, nouvelle["id_salle"]),
                                          "raison": "salle d'origine plus possible"})
                continue
        else:
            w = (d - inst.lundi0).days // 7
            echecs["jour fermé (férié ou congé)"] += 1
        raison = echecs.most_common(1)[0][0] if echecs else "créneau plus valide"
        a_replacer.append((c, duree, w, avant, raison, ens))

    # 3. replacer : même semaine d'abord, puis les suivantes, puis les précédentes de la période
    for c, duree, w0, avant, raison, ens in a_replacer:
        ordre = [w for w in semaines if w >= w0] + [w for w in reversed(semaines) if w < w0]
        apres = None
        for w in ordre:
            if placer_seance(inst, e, c, duree, w, rnd, Counter(), *_bornes(inst, e, c), ens=ens):
                s = e.seances[-1]
                apres = _fmt(inst, s["jour"], s["debut"], s["duree"], s["id_salle"])
                break
        modifications.append({"id_cours": c.id, "type": "déplacée" if apres else "non replacée",
                              "avant": avant, "apres": apres, "raison": raison})

    # 4. ramener dans la période ce qui est prévu hors d'elle, au plus près de sa date
    for c, d, h0, duree, salle, ens in sorted(a_ramener, key=lambda x: (x[1], x[2])):
        avant = {"date": d.isoformat(), "heure_debut": f"{h0:02d}:00", "heure_fin": f"{h0 + duree:02d}:00", "id_salle": salle}
        echecs = Counter()
        if any(placer_seance(inst, e, c, duree, w, rnd, echecs, *_bornes(inst, e, c), salle_pref=salle, ens=ens)
               for w in (reversed(semaines) if d > au_d else semaines)):
            s = e.seances[-1]
            modifications.append({"id_cours": c.id, "type": "déplacée", "avant": avant,
                                  "apres": _fmt(inst, s["jour"], s["debut"], s["duree"], s["id_salle"]),
                                  "raison": "ramenée dans la période"})
            continue
        if d in inst.index_date:
            e.poser(c, inst.index_date[d], h0, duree, salle, ens=ens, fixe=True)
        modifications.append({"id_cours": c.id, "type": "restée", "avant": avant, "apres": None,
                              "raison": echecs.most_common(1)[0][0] if echecs else "aucune semaine dans la période"})

    # 5. compléter le programme dans la période
    raisons: dict[int, Counter] = defaultdict(Counter)
    if completer and semaines:
        cibles = {k for k, c in inst.cours.items() if dans_perimetre(c)}
        avant_n = len(e.seances)
        e, raisons = un_essai(inst, rnd, 0.5, 0.85, e, semaines, cibles)
        for s in e.seances[avant_n:]:
            modifications.append({"id_cours": s["id_cours"], "type": "ajoutée", "avant": None,
                                  "apres": _fmt(inst, s["jour"], s["debut"], s["duree"], s["id_salle"]),
                                  "raison": "heures encore dues"})
    for c, *_ in a_replacer:   # heures d'une séance qui n'a pas pu être replacée
        if not raisons.get(c.id):
            raisons[c.id][next(r for x, _, _, _, r, _ in a_replacer if x.id == c.id)] += 1
    return e, modifications, raisons, len(a_verifier), avertissements


def replanifier(data: dict, perimetre: dict | None = None, du: str | None = None, au: str | None = None,
                completer: bool = False, seed: int = 1) -> dict:
    t0 = chrono.perf_counter()
    inst = Instance(data)
    rnd = random.Random(seed)
    p = perimetre or {}
    classes, ens, cours_ids = set(p.get("id_classes", [])), set(p.get("id_enseignants", [])), set(p.get("id_cours", []))

    def dans_perimetre(c) -> bool:
        if not (classes or ens or cours_ids):
            return True
        return c.id in cours_ids or c.enseignant in ens or bool(classes & set(c.classes))

    du_d = date.fromisoformat(du) if du else inst.dates[0]
    au_d = date.fromisoformat(au) if au else inst.dates[-1]
    e, modifications, raisons, verifiees, avertissements = replanifier_etat(
        inst, data.get("seances_existantes", []), dans_perimetre, du_d, au_d, completer, rnd)

    res = resultat(inst, e, raisons, {})
    compte = Counter(m["type"] for m in modifications)
    res["statistiques"].update({
        "duree_s": round(chrono.perf_counter() - t0, 2), "seances_verifiees": verifiees,
        "inchangees": verifiees - compte["déplacée"] - compte["non replacée"] - compte["salle changée"],
        **{k.replace(" ", "_"): v for k, v in compte.items()},
    })
    res["statistiques"]["avertissements"] = inst.erreurs + avertissements
    res["modifications"] = modifications
    res["violations"] = valider(data, res["seances"])
    return res
