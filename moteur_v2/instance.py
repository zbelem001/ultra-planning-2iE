"""Préparation d'une instance de planification (SANS OR-Tools).

Transforme le JSON d'entrée en "séances à placer" avec, pour chacune :
horaires possibles, salles compatibles, entités concernées (groupes, enseignant).
Testable sans solveur.

Temps : grille d'1 heure. Un horaire de début est un entier  jour_index * 24 + heure.
"""
from collections import defaultdict

SPD = 24  # heures par jour dans l'index de temps global

DEFAUT_CAL = {
    "jours": ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"],
    "heure_ouverture": 7,
    "heure_fermeture": 18,          # HYPOTHÈSE : à confirmer avec le planificateur
    "pause": [12, 13],
    "samedi_apres_midi": False,
    "duree_min": 2,
    "duree_max": 4,
}

DEFAUT_PARAM = {
    "max_heures_jour": 8,            # dur
    "max_heures_jour_souple": 6,     # préféré
    "heures_debut_preferees": [7, 13],
    "poids": {"cs01": 10, "cs03": 8, "cs04": 5, "cs06_groupe": 4,
              "cs06_enseignant": 2, "cs08": 1, "cs09": 3},
    "time_limit_s": 120,
    "num_workers": 8,
    "gap_relatif": 0.02,
    "essais_glouton": 12,           # relances du glouton avec des ordres différents
    "budget_glouton_s": 20,         # temps maximum pour ces relances
    "max_variables_solveur": 40000, # au-delà, on ne lance pas OR-Tools (glouton seul)
}


def fusion_param(data):
    given = data.get("parametres", {})
    prm = {**DEFAUT_PARAM, **given}
    prm["poids"] = {**DEFAUT_PARAM["poids"], **given.get("poids", {})}
    return prm


class Instance:
    def __init__(self, data):
        self.data = data
        self.cal = {**DEFAUT_CAL, **data.get("calendrier", {})}
        self.prm = fusion_param(data)
        self.jours = self.cal["jours"]
        self.jour_idx = {j: i for i, j in enumerate(self.jours)}
        self.open = self.cal["heure_ouverture"]
        self.close = self.cal["heure_fermeture"]
        self.pause = tuple(self.cal["pause"])
        self.salles = {s["id_salle"]: s for s in data["salles"]}
        self.sites = data.get("sites") or sorted({s["site"] for s in data["salles"]})
        self.classes = {c["id_classe"]: c for c in data["classes"]}
        self.groupes = {g["id_groupe"]: g for g in data["groupes"]}
        self.enseignants = {e["id_enseignant"]: e for e in data["enseignants"]}
        self.groupes_par_classe = defaultdict(list)
        for g in data["groupes"]:
            self.groupes_par_classe[g["id_classe"]].append(g["id_groupe"])
        self.indispo = self._heures(data.get("indisponibilites", []))
        self.pref = self._heures(data.get("preferences", []))
        self.sessions = []
        self._construire()

    # ---------- données de base ----------
    def _heures(self, items):
        out = defaultdict(set)
        for it in items:
            j = self.jour_idx[it["jour"]]
            for h in range(it["heure_debut"], it["heure_fin"]):
                out[it["id_enseignant"]].add((j, h))
        return out

    def decoupage(self, c):
        if c.get("decoupage"):
            return list(c["decoupage"])
        return [c.get("duree_seance", 2)] * c.get("nb_seances_semaine", 1)

    def effectif(self, c):
        if c.get("id_groupe"):
            return self.groupes[c["id_groupe"]]["effectif"]
        return self.classes[c["id_classe"]]["effectif"]

    def entites(self, c):
        """Entités qui suivent le cours : groupe, ou tous les groupes de la classe, ou la classe."""
        if c.get("id_groupe"):
            return [("G", c["id_groupe"])]
        gs = self.groupes_par_classe.get(c["id_classe"])
        return [("G", g) for g in gs] if gs else [("C", c["id_classe"])]

    def demi(self, start):
        j, h = divmod(start, SPD)
        return (j, 0 if h < self.pause[0] else 1)

    # ---------- horaires possibles ----------
    def starts(self, duree, ens):
        p0, p1 = self.pause
        indis = self.indispo.get(ens, ())
        res = []
        for j, nom in enumerate(self.jours):
            for h in range(self.open, self.close - duree + 1):
                fin = h + duree
                if not (fin <= p0 or h >= p1):
                    continue                          # chevauche la pause
                if nom == "Samedi" and not self.cal["samedi_apres_midi"] and fin > p0:
                    continue                          # pas de cours le samedi après-midi
                if any((j, hh) in indis for hh in range(h, fin)):
                    continue                          # enseignant indisponible
                res.append(j * SPD + h)
        return res

    def score(self, start, duree, ens):
        w = self.prm["poids"]
        j, h = divmod(start, SPD)
        pref = self.pref.get(ens, ())
        n = sum(1 for hh in range(h, h + duree) if (j, hh) in pref)
        s = w["cs01"] * n
        if h in self.prm["heures_debut_preferees"]:
            s += w["cs08"]
        return s

    # ---------- salles ----------
    def salles_compatibles(self, c):
        eff = self.effectif(c)
        ok, motifs = [], defaultdict(int)
        for sid, s in self.salles.items():
            if not s.get("est_disponible", True):
                motifs["salle indisponible"] += 1
            elif c.get("id_type_salle") is not None and s["id_type_salle"] != c["id_type_salle"]:
                motifs["type de salle incorrect"] += 1
            elif s["capacite"] < eff:
                motifs["capacité insuffisante"] += 1
            else:
                ok.append(sid)
        return ok, dict(motifs)

    # ---------- séances ----------
    def _construire(self):
        cache = {}
        for c in self.data["cours"]:
            ens = c["id_enseignant"]
            salles_ok, motifs = self.salles_compatibles(c)
            ents = self.entites(c)
            for k, d in enumerate(self.decoupage(c)):
                if (d, ens) not in cache:
                    st = self.starts(d, ens)
                    cache[(d, ens)] = (st, {x: self.score(x, d, ens) for x in st})
                starts, scores = cache[(d, ens)]
                self.sessions.append({
                    "cid": c["id_cours"], "k": k, "duree": d, "ens": ens,
                    "classe": c["id_classe"], "entites": ents,
                    "starts": starts, "scores": scores,
                    "rooms": salles_ok, "motifs_salles": motifs,
                    "type_cours": c.get("type_cours"),
                })

    def explication(self, s):
        if not s["starts"]:
            return (f"aucun horaire possible : séance de {s['duree']} h incompatible avec la pause / "
                    "la fermeture, ou enseignant indisponible sur toutes les plages")
        if not s["rooms"]:
            det = ", ".join(f"{n}× {m}" for m, n in s["motifs_salles"].items()) or "aucune salle"
            return f"aucune salle compatible ({det})"
        return ("ressources saturées : tous les horaires/salles valides sont pris par d'autres séances "
                "(salle, enseignant ou groupe), ou la limite d'heures par jour serait dépassée")

    def diagnostics(self):
        """Alertes rapides avant de lancer le solveur."""
        out = []
        charge = defaultdict(int)
        for s in self.sessions:
            charge[s["ens"]] += s["duree"]
        for eid, e in self.enseignants.items():
            mx = e.get("nb_heures_max_semaine")
            if mx and charge[eid] > mx:
                out.append(f"enseignant {eid} : {charge[eid]} h prévues > plafond {mx} h/semaine")
        sans_h = sum(1 for s in self.sessions if not s["starts"])
        sans_s = sum(1 for s in self.sessions if not s["rooms"])
        if sans_h:
            out.append(f"{sans_h} séance(s) sans aucun horaire possible")
        if sans_s:
            out.append(f"{sans_s} séance(s) sans salle compatible")
        par_ent = defaultdict(int)
        for s in self.sessions:
            for e in s["entites"]:
                par_ent[e] += s["duree"]
        limite = self.prm["max_heures_jour"] * (len(self.jours) - 1) + 5
        for e, h in par_ent.items():
            if h > limite:
                out.append(f"{e} : {h} h/semaine, au-delà du maximum possible ({limite} h)")
        return out
