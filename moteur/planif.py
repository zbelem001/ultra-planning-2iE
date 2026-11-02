"""Placement chronologique sur le semestre (glouton multi-essais).

Pour chaque semaine, dans l'ordre :
1. chaque cours qui a encore des heures demande « reste / semaines encore utilisables
   par son enseignant », au moins `concentration` × son rythme maximal (enseignement
   par modules) ; les cours déjà commencés et les plus urgents passent d'abord, tant
   que le budget horaire de la semaine de chaque public et de chaque enseignant le permet ;
2. les séances de la semaine sont placées une à une (jour, heure, salle), la plus
   contrainte d'abord, au moindre coût ;
3. ce qui n'a pas pu être placé reste dû et redevient demandé la semaine suivante.

Règles dures : pas de chevauchement (salle, enseignant, atomes d'étudiants), salle
du site de la promotion, du bon type, assez grande, réservée seulement à ses ayants
droit, plages horaires, jours ouverts, séjour et indisponibilités de l'enseignant,
plafond journalier, règles « interdire » et « precede ». Le reste est un coût.
"""
from __future__ import annotations

import random
import time as chrono
from collections import Counter, defaultdict

from .instance import JOURS, Cours, Instance, heures_par_semaine, plafond


class Etat:
    def __init__(self, inst: Instance):
        self.inst = inst
        self.salle_occ: set[tuple[int, int, int]] = set()
        self.ens_h: dict[tuple[int, int], set[int]] = defaultdict(set)
        self.ens_site: dict[tuple[int, int], Counter] = defaultdict(Counter)
        self.ens_heure_site: dict[tuple[int, int], dict[int, int]] = defaultdict(dict)   # heure -> site
        self.ens_sem: dict[tuple[int, int], int] = defaultdict(int)
        self.occupe: dict[tuple[int, int], int] = defaultdict(int)     # (jour, heure) -> atomes
        self.atome_h: dict[tuple[int, int], int] = defaultdict(int)    # (jour, atome) -> heures
        self.cours_jour: Counter = Counter()                            # (cours, jour) -> séances
        self.cours_sem: dict[tuple[int, int], int] = defaultdict(int)
        self.debut_matiere: dict[int, tuple[int, int]] = {}
        self.fin_matiere: dict[int, tuple[int, int]] = {}
        self.debut_cm: dict[int, tuple[int, int]] = {}                 # matière -> premier CM
        self.reste = {k: c.volume for k, c in inst.cours.items()}
        self.reste_matiere: dict[int, int] = defaultdict(int)
        for c in inst.cours.values():
            self.reste_matiere[c.matiere] += c.volume
        self.seances: list[dict] = []
        self.cout = 0.0

    def poser(self, c: Cours, di: int, debut: int, duree: int, salle: int, cout: float = 0.0):
        site = self.inst.salles[salle]["id_site"]
        w = self.inst.semaine_de[di]
        for h in range(debut, debut + duree):
            self.salle_occ.add((salle, di, h))
            self.ens_h[c.enseignant, di].add(h)
            self.ens_heure_site[c.enseignant, di][h] = site
            self.occupe[di, h] |= c.masque
        for a in c.atomes:
            self.atome_h[di, a] += duree
        self.ens_site[c.enseignant, di][site] += 1
        self.ens_sem[c.enseignant, w] += duree
        self.cours_jour[c.id, di] += 1
        self.cours_sem[c.id, w] += duree
        m = c.matiere
        self.debut_matiere[m] = min(self.debut_matiere.get(m, (di, debut)), (di, debut))
        self.fin_matiere[m] = max(self.fin_matiere.get(m, (di, debut + duree)), (di, debut + duree))
        if c.type == "CM" and (c.matiere not in self.debut_cm or (di, debut) < self.debut_cm[c.matiere]):
            self.debut_cm[c.matiere] = (di, debut)
        self.reste[c.id] -= duree
        self.reste_matiere[c.matiere] -= duree
        self.cout += cout
        self.seances.append({"id_cours": c.id, "jour": di, "debut": debut, "duree": duree, "id_salle": salle,
                             "cout": cout})

    def enlever(self, s: dict):
        """Retire une séance posée (pour la réoptimiser)."""
        c = self.inst.cours[s["id_cours"]]
        di, debut, duree = s["jour"], s["debut"], s["duree"]
        w = self.inst.semaine_de[di]
        for h in range(debut, debut + duree):
            self.salle_occ.discard((s["id_salle"], di, h))
            self.ens_h[c.enseignant, di].discard(h)
            self.ens_heure_site[c.enseignant, di].pop(h, None)
            self.occupe[di, h] &= ~c.masque
        for a in c.atomes:
            self.atome_h[di, a] -= duree
        self.ens_site[c.enseignant, di][self.inst.salles[s["id_salle"]]["id_site"]] -= 1
        self.ens_sem[c.enseignant, w] -= duree
        self.cours_jour[c.id, di] -= 1
        self.cours_sem[c.id, w] -= duree
        self.reste[c.id] += duree
        self.reste_matiere[c.matiere] += duree
        self.cout -= s.get("cout", 0.0)
        self.seances.remove(s)

    def recalculer_bornes(self, matieres):
        """Début et fin de chaque matière (et premier CM) après des retraits."""
        for m in matieres:
            self.debut_matiere.pop(m, None)
            self.fin_matiere.pop(m, None)
            self.debut_cm.pop(m, None)
        for s in self.seances:
            c = self.inst.cours[s["id_cours"]]
            m = c.matiere
            if m not in matieres:
                continue
            a, b = (s["jour"], s["debut"]), (s["jour"], s["debut"] + s["duree"])
            self.debut_matiere[m] = min(self.debut_matiere.get(m, a), a)
            self.fin_matiere[m] = max(self.fin_matiere.get(m, b), b)
            if c.type == "CM":
                self.debut_cm[m] = min(self.debut_cm.get(m, a), a)


def placer_seance(inst: Instance, e: Etat, c: Cours, duree: int, w: int, rnd: random.Random,
                  echecs: Counter, apres=None, avant=None, seulement=None, salle_pref=None) -> bool:
    """apres / avant : bornes (jour, heure) imposées par les règles « precede ».
    seulement = (jour, début) : ne teste que ce créneau (vérifier une séance existante) ;
    salle_pref : salle prise en priorité si elle convient (moins de changements)."""
    P = inst.param["poids"]
    pres = inst.ens_present[c.enseignant]
    indispo, pref = inst.ens_indispo[c.enseignant], inst.ens_pref[c.enseignant]
    indispo_h = inst.ens_indispo_h[c.enseignant]
    plaf = inst.plafond_dur
    meilleur = None
    if e.cours_sem[c.id, w] + duree > c.h_max:   # rythme maximal (CD-14), règle dure
        echecs["rythme maximal du cours atteint cette semaine"] += 1
        return False
    for di in ([seulement[0]] if seulement else inst.jours_semaine[w]):
        if not pres[di]:
            echecs["enseignant absent (séjour ou absence)"] += 1
            continue
        jour = JOURS[inst.dates[di].weekday()]
        eh = e.ens_h.get((c.enseignant, di), set())
        if len(eh) + duree > plaf:
            echecs["plafond journalier de l'enseignant"] += 1
            continue
        if max((e.atome_h.get((di, a), 0) for a in c.atomes), default=0) + duree > plaf:
            echecs["plafond journalier des étudiants"] += 1
            continue
        autres_sites = {x for x, n in e.ens_site.get((c.enseignant, di), {}).items() if n > 0} - {c.site}
        loin = [h for h, x in e.ens_heure_site.get((c.enseignant, di), {}).items() if x != c.site]
        if autres_sites and inst.deux_sites_dur:
            echecs["enseignant déjà sur l'autre site ce jour"] += 1
            continue
        for demi, (a, b) in enumerate(inst.plages[di]):
            if (jour, demi) in indispo:
                echecs["indisponibilité de l'enseignant"] += 1
                continue
            if inst.interdit(c, jour, demi, di):
                echecs["règle « interdire »"] += 1
                continue
            for s in range(a, b - duree + 1):
                if seulement and s != seulement[1]:
                    continue
                if (apres and (di, s) < apres) or (avant and (di, s + duree) > avant):
                    echecs["règle « precede » : ordre des matières"] += 1
                    continue
                hs = range(s, s + duree)
                if any(e.occupe.get((di, h), 0) & c.masque for h in hs):
                    echecs["étudiants déjà en cours"] += 1
                    continue
                if any(h in eh for h in hs):
                    echecs["enseignant déjà en cours"] += 1
                    continue
                if indispo_h and any((jour, h) in indispo_h for h in hs):
                    echecs["indisponibilité de l'enseignant"] += 1
                    continue
                if not trajet_ok(loin, s, duree, inst.trajet_h):
                    echecs["temps de trajet de l'enseignant entre les sites"] += 1
                    continue
                ordre = ([salle_pref] + c.salles) if salle_pref in c.salles else c.salles
                salle = next((r for r in ordre if all((r, di, h) not in e.salle_occ for h in hs)), None)
                if salle is None:
                    echecs["aucune salle libre"] += 1
                    continue
                cout = 0.0
                if (jour, demi) in pref:
                    cout -= P["preference"]
                if s == a:
                    cout -= P["debut_demi"]
                if e.occupe.get((di, s - 1), 0) & c.masque or e.occupe.get((di, s + duree), 0) & c.masque:
                    cout -= P["colle"]
                if e.cours_jour.get((c.id, di), 0) > 0:
                    cout += P["meme_cours_jour"]
                if autres_sites:
                    cout += P["enseignant_deux_sites"]
                if inst.plafond_souple:
                    m = max((e.atome_h.get((di, x), 0) for x in c.atomes), default=0) + duree
                    cout += P["plafond_jour_souple"] * max(0, m - inst.plafond_souple)
                if inst.cm_avant_td and c.type != "CM":
                    d0 = e.debut_cm.get(c.matiere)
                    if d0 is not None and (di, s) < d0:
                        cout += P["cm_avant_td"]
                if jour == "Samedi":
                    cout += P["samedi"]
                if salle_pref is not None and salle != salle_pref:
                    cout += 1
                cout += rnd.random() * 0.5
                if meilleur is None or cout < meilleur[0]:
                    meilleur = (cout, di, s, salle)
    if meilleur is None:
        return False
    cout, di, s, salle = meilleur
    e.poser(c, di, s, duree, salle, cout)
    return True


def trajet_ok(loin: list[int], s: int, duree: int, trajet_h: int) -> bool:
    """loin : heures déjà occupées par l'enseignant sur l'autre site ce jour-là."""
    return all(h + 1 + trajet_h <= s or s + duree + trajet_h <= h for h in loin)


def heures_ouvertes(inst: Instance, w: int) -> int:
    return sum(b - a for di in inst.jours_semaine[w] for a, b in inst.plages[di])


def un_essai(inst: Instance, rnd: random.Random, concentration: float, taux_budget: float,
             e: Etat | None = None, semaines=None, cours_ok=None) -> tuple[Etat, dict]:
    """e : état de départ (séances figées déjà posées) ; semaines : semaines à remplir ;
    cours_ok : cours à programmer (défaut : tous)."""
    e = e or Etat(inst)
    semaines = list(semaines) if semaines is not None else list(range(inst.n_semaines))
    raisons: dict[int, Counter] = defaultdict(Counter)
    commence: set[int] = set()
    passage = {k for k, c in inst.cours.items()
               if inst.enseignants[c.enseignant].get("statut") == "externe_non_resident"}
    for w in semaines:
        ouvert = heures_ouvertes(inst, w)
        budget_atome: dict[int, float] = defaultdict(lambda: taux_budget * ouvert)
        budget_ens: dict[int, int] = {}
        demandes = []
        for k, c in inst.cours.items():
            r = e.reste[k]
            if r <= 0 or (cours_ok is not None and k not in cours_ok):
                continue
            if any(e.reste_matiere[m] > 0 for m in inst.precede.get(c.matiere, [])):
                raisons[k]["règle « precede » : matière précédente non terminée"] += 1
                continue
            n = inst.semaines_restantes(c, w, semaines[-1] + 1)
            if n == 0:
                raisons[k]["enseignant absent (séjour)"] += 1
                continue
            if not any(inst.ens_present[c.enseignant][di] for di in inst.jours_semaine[w]):
                continue
            cible = min(r, c.h_max, max(plafond(r / n), c.h_min, round(concentration * c.h_max)))
            # un externe de passage ne pourra pas rattraper après son départ : il passe d'abord
            urgence = (r / (n * c.h_max) + (0.3 if k in commence else 0.0)
                       + (1.0 if k in passage else 0.0) + rnd.random() * 0.2)
            demandes.append((urgence, c, cible))
        demandes.sort(key=lambda x: -x[0])
        seances = []
        for _, c, cible in demandes:
            ens = inst.enseignants[c.enseignant]
            b_ens = budget_ens.setdefault(c.enseignant, (ens.get("nb_heures_max_semaine") or 99) - e.ens_sem[c.enseignant, w])
            dispo = min([b_ens] + [budget_atome[a] for a in c.atomes])
            h = min(cible, int(dispo))
            if h < min(c.durees) and h < e.reste[c.id]:
                raisons[c.id]["semaine pleine (budget de la promotion ou de l'enseignant)"] += 1
                continue
            if h <= 0:
                continue
            budget_ens[c.enseignant] -= h
            for a in c.atomes:
                budget_atome[a] -= h
            for d in heures_par_semaine(h, c.durees):
                seances.append((c, d))
        # les plus contraintes d'abord : externes de passage, peu de salles, gros publics, longues séances
        seances.sort(key=lambda x: (x[0].id not in passage, len(x[0].salles), -x[0].effectif, -x[1], rnd.random()))
        for c, d in seances:
            echecs: Counter = Counter()
            if placer_seance(inst, e, c, d, w, rnd, echecs):
                commence.add(c.id)
            else:
                raisons[c.id].update({echecs.most_common(1)[0][0] if echecs else "aucun créneau": 1})
    rattrapage(inst, e, rnd, raisons, semaines, cours_ok)
    return e, raisons


def rattrapage(inst: Instance, e: Etat, rnd: random.Random, raisons, semaines=None, cours_ok=None):
    """Remet les heures restantes dans toute semaine où il reste de la place,
    en respectant l'ordre des matières et le rythme maximal."""
    suivantes: dict[int, list[int]] = defaultdict(list)
    for b, avants in inst.precede.items():
        for a in avants:
            suivantes[a].append(b)
    for k in sorted(e.reste, key=lambda k: -e.reste[k]):
        c = inst.cours[k]
        if e.reste[k] <= 0 or (cours_ok is not None and k not in cours_ok):
            continue
        preds = inst.precede.get(c.matiere, [])
        if any(e.reste_matiere[m] > 0 for m in preds):
            continue
        apres = max((e.fin_matiere[m] for m in preds if m in e.fin_matiere), default=None)
        avant = min((e.debut_matiere[m] for m in suivantes[c.matiere] if m in e.debut_matiere), default=None)
        cap = inst.enseignants[c.enseignant].get("nb_heures_max_semaine") or 99
        for w in (semaines if semaines is not None else range(inst.n_semaines)):
            while e.reste[k] > 0 and e.cours_sem[k, w] < c.h_max:
                r = min(e.reste[k], c.h_max - e.cours_sem[k, w], cap - e.ens_sem[c.enseignant, w])
                if r <= 0:
                    break
                d = next((x for x in c.durees if x <= r), r)
                echecs: Counter = Counter()
                if not placer_seance(inst, e, c, d, w, rnd, echecs, apres, avant):
                    if echecs:
                        raisons[k][echecs.most_common(1)[0][0]] += 1
                    break


def _essai_isole(data: dict, graine: int, concentration: float, taux_budget: float):
    """Un essai dans un processus séparé ; renvoie la clé de choix et le résultat."""
    inst = Instance(data)
    e, raisons = un_essai(inst, random.Random(graine), concentration, taux_budget)
    cle = (sum(max(r, 0) for r in e.reste.values()), e.cout)
    return cle, resultat(inst, e, raisons, {})


def planifier(inst: Instance, essais: int | None = None, seed: int = 1, concentration: float = 0.5,
              taux_budget: float = 0.85, temps_max: float | None = None, processus: int = 1) -> dict:
    """Plusieurs passages, ordres différents ; garde celui qui place le plus d'heures, puis le moindre coût.
    processus > 1 : les essais tournent en parallèle."""
    t0 = chrono.perf_counter()
    essais = essais or inst.param["essais"]
    if processus > 1 and essais > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(processus, essais)) as pool:
            futurs = [pool.submit(_essai_isole, inst.data, seed * 1000 + i, concentration, taux_budget)
                      for i in range(essais)]
            sorties = [f.result() for f in futurs]
        i_best = min(range(essais), key=lambda i: sorties[i][0])
        res = sorties[i_best][1]
        res["statistiques"].update({"essais": essais, "meilleur_essai": i_best, "processus": processus,
                                    "duree_s": round(chrono.perf_counter() - t0, 2)})
        return res
    meilleur = None
    for i in range(essais):
        e, raisons = un_essai(inst, random.Random(seed * 1000 + i), concentration, taux_budget)
        cle = (sum(max(r, 0) for r in e.reste.values()), e.cout)
        if meilleur is None or cle < meilleur[0]:
            meilleur = (cle, e, raisons, i)
        if temps_max and chrono.perf_counter() - t0 > temps_max:
            essais = i + 1
            break
    _, e, raisons, i_best = meilleur
    return resultat(inst, e, raisons, {"essais": essais, "meilleur_essai": i_best,
                                       "duree_s": round(chrono.perf_counter() - t0, 2)})


def resultat(inst: Instance, e: Etat, raisons, stats) -> dict:
    seances = [{"id_cours": s["id_cours"], "date": inst.dates[s["jour"]].isoformat(),
                "heure_debut": f"{s['debut']:02d}:00", "heure_fin": f"{s['debut'] + s['duree']:02d}:00",
                "id_salle": s["id_salle"]} for s in sorted(e.seances, key=lambda s: (s["jour"], s["debut"], s["id_cours"]))]
    non = []
    for k, r in e.reste.items():
        if r > 0:
            raison = raisons[k].most_common(1)[0][0] if raisons.get(k) else "pas assez de semaines"
            non.append({"id_cours": k, "heures": r, "raison": raison})
    total = sum(c.volume for c in inst.cours.values())
    place = total - sum(max(r, 0) for r in e.reste.values())
    stats.update({"heures_demandees": total, "heures_placees": place,
                  "taux": round(100 * place / max(total, 1), 2), "seances": len(seances),
                  "cours_incomplets": len(non), "cout": round(e.cout, 1), "avertissements": inst.erreurs})
    return {"seances": seances, "non_programmes": non, "statistiques": stats}
