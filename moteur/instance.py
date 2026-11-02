"""Lecture d'une instance v3 (voir generateur.py) et précalculs du moteur.

Publics : chaque promotion est découpée en « atomes » d'étudiants, les feuilles de
son arbre de groupes (une promotion sans groupe = un atome). Un public occupe les
atomes sous lui ; deux séances sont en conflit d'étudiants si leurs atomes se
croisent. Les atomes sont codés en bits d'un entier : le test est un ET binaire.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
# statuts de la base (table enseignant) -> statuts du moteur
STATUTS_BASE = {"vacataire_local": "externe_resident", "externe": "externe_non_resident"}

DEFAUT_PARAM = {
    "essais": 8,                     # passages gloutons (ordres différents)
    "plafond_jour_dur": 8,           # heures par jour et par étudiant ou enseignant
    "poids": {
        "preference": 4,             # demi-journée préférée de l'enseignant (bonus)
        "debut_demi": 1,             # séance qui commence à l'ouverture d'une demi-journée (bonus)
        "colle": 2,                  # séance collée à une autre du même public (bonus)
        "meme_cours_jour": 6,        # deux séances du même cours le même jour
        "plafond_jour_souple": 2,    # par heure au-delà du plafond souple
        "enseignant_deux_sites": 50, # enseignant sur deux sites le même jour
        "cm_avant_td": 3,            # TD avant le début du CM de la matière
        "samedi": 1,                 # séance le samedi
    },
}


def _d(s: str) -> date:
    return date.fromisoformat(s)


@dataclass
class Cours:
    id: int
    matiere: int
    type: str
    classes: list[int]
    masque: int                      # atomes d'étudiants occupés
    atomes: list[int]
    effectif: int
    enseignant: int
    types_salle: list[int]
    volume: int
    durees: list[int]
    h_min: int
    h_max: int
    site: int
    salles: list[int] = field(default_factory=list)   # salles possibles, meilleure d'abord


class Instance:
    def __init__(self, data: dict):
        self.data = data
        p = dict(DEFAUT_PARAM)
        p.update({k: v for k, v in data.get("parametres", {}).items() if k != "poids"})
        p["poids"] = {**DEFAUT_PARAM["poids"], **data.get("parametres", {}).get("poids", {})}
        self.param = p
        self.erreurs: list[str] = []
        self._calendrier(data["calendrier"])
        self.salles = {s["id_salle"]: s for s in data["salles"]}
        # écart minimal (heures) entre deux séances d'un enseignant sur deux sites le même jour
        self.trajet_h = plafond(max(data.get("trajet_min", {}).values() or [60]) / 60)
        self.classes = {c["id_classe"]: c for c in data["classes"]}
        self.enseignants = {e["id_enseignant"]: dict(e, statut=STATUTS_BASE.get(e.get("statut"), e.get("statut")))
                            for e in data["enseignants"]}
        self._atomes(data["groupes"])
        self._enseignants()
        self.regles = data.get("regles", [])
        self._regles()
        self.cours: dict[int, Cours] = {}
        for c in data["cours"]:
            self._cours(c)

    # --- calendrier -----------------------------------------------------------
    def _calendrier(self, cal):
        fer = {_d(x) for x in cal.get("jours_feries", [])}
        conges = [(_d(a), _d(b)) for a, b in cal.get("conges", [])]
        d, fin = _d(cal["debut"]), _d(cal["fin"])
        self.dates: list[date] = []
        self.plages: list[list[tuple[int, int]]] = []   # par date : demi-journées (début, fin)
        while d <= fin:
            if d.weekday() < 6 and d not in fer and not any(a <= d <= b for a, b in conges):
                pl = cal["plages"].get(JOURS[d.weekday()], [])
                if pl:
                    self.dates.append(d)
                    self.plages.append([tuple(x) for x in pl])
            d += timedelta(days=1)
        self.lundi0 = _d(cal["debut"]) - timedelta(days=_d(cal["debut"]).weekday())
        self.semaine_de = [(x - self.lundi0).days // 7 for x in self.dates]
        self.index_date = {x: i for i, x in enumerate(self.dates)}
        self.n_semaines = (self.semaine_de[-1] + 1) if self.dates else 0
        self.jours_semaine = [[] for _ in range(self.n_semaines)]
        for i, w in enumerate(self.semaine_de):
            self.jours_semaine[w].append(i)

    # --- groupes et atomes ----------------------------------------------------
    def _atomes(self, groupes):
        enfants: dict[tuple[int, int | None], list[int]] = {}
        self.groupes = {g["id_groupe"]: g for g in groupes}
        for g in groupes:
            enfants.setdefault((g["id_classe"], g["parent"]), []).append(g["id_groupe"])
        self.n_atomes = 0
        self.atomes_classe: dict[int, list[int]] = {}
        self.atomes_groupe: dict[int, list[int]] = {}

        def nouvel_atome():
            self.n_atomes += 1
            return self.n_atomes - 1

        def feuilles(ic, parent):
            """Frères du même type = découpage (disjoints) ; frères de types différents =
            découpages croisés (ex. TD et TP sans parent) : un atome par combinaison."""
            fils = enfants.get((ic, parent), [])
            if not fils:
                return [nouvel_atome()]
            par_type: dict[str, list[int]] = {}
            for g in fils:
                par_type.setdefault(self.groupes[g]["type_groupe"], []).append(g)
            if len(par_type) == 1:
                out = []
                for g in fils:
                    f = feuilles(ic, g)
                    self.atomes_groupe[g] = f
                    out += f
                return out
            # découpages croisés : les sous-groupes éventuels prennent tout leur parent (prudent)
            combos = [[]]
            for gs in par_type.values():
                combos = [c + [g] for c in combos for g in gs]
            out = []
            for c in combos:
                a = nouvel_atome()
                out.append(a)
                for g in c:
                    self.atomes_groupe.setdefault(g, []).append(a)
            for g in fils:
                pile = list(enfants.get((ic, g), []))
                while pile:
                    x = pile.pop()
                    self.atomes_groupe[x] = self.atomes_groupe[g]
                    pile += enfants.get((ic, x), [])
            return out

        for ic in self.classes:
            self.atomes_classe[ic] = feuilles(ic, None)
        self.classe_atome = {a: ic for ic, l in self.atomes_classe.items() for a in l}

    def public(self, p) -> tuple[list[int], int]:
        if p.get("id_groupe") is None:
            return self.atomes_classe[p["id_classe"]], self.classes[p["id_classe"]]["effectif"]
        return self.atomes_groupe[p["id_groupe"]], self.groupes[p["id_groupe"]]["effectif"]

    # --- enseignants ----------------------------------------------------------
    def _enseignants(self):
        self.ens_present: dict[int, list[bool]] = {}
        self.ens_indispo: dict[int, set[tuple[str, int]]] = {}       # (jour, demi-journée)
        self.ens_indispo_h: dict[int, set[tuple[str, int]]] = {}     # (jour, heure), table disponibilite
        self.ens_pref: dict[int, set[tuple[str, int]]] = {}
        for k, e in self.enseignants.items():
            sej = [(_d(a), _d(b)) for a, b in e.get("sejours", [])]
            absences = [(_d(a), _d(b)) for a, b in e.get("absences", [])]   # absences datées (maladie, mission…)
            non_resident = e.get("statut") == "externe_non_resident"
            self.ens_present[k] = [(not non_resident or any(a <= x <= b for a, b in sej))
                                   and not any(a <= x <= b for a, b in absences) for x in self.dates]
            ind = e.get("indisponibilites", [])
            self.ens_indispo[k] = {(i["jour"], i["demi"]) for i in ind if "demi" in i}
            self.ens_indispo_h[k] = {(i["jour"], h) for i in ind if "heure_debut" in i
                                     for h in range(i["heure_debut"], i["heure_fin"])}
            self.ens_pref[k] = {(i["jour"], i["demi"]) for i in e.get("preferences", []) if "demi" in i}
            for i in e.get("preferences", []):   # préférence à l'heure : compte pour sa demi-journée
                if "heure_debut" in i:
                    pl = self.data["calendrier"]["plages"].get(i["jour"], [])
                    self.ens_pref[k] |= {(i["jour"], n) for n, (a, b) in enumerate(pl) if a <= i["heure_debut"] < b}

    # --- règles stockées comme données ----------------------------------------
    def _regles(self):
        self.interdits: list[dict] = []
        self.precede: dict[int, list[int]] = {}       # matière -> matières à finir avant
        self.plafond_dur = self.param["plafond_jour_dur"]
        self.plafond_souple = None
        self.cm_avant_td = False
        self.deux_sites_dur = False
        for r in self.regles:
            t = r["type"]
            if t == "interdire":
                self.interdits.append(r)
            elif t == "precede":
                self.precede.setdefault(r["matiere_apres"], []).append(r["matiere_avant"])
            elif t == "plafond_jour":
                if r.get("dure", True):
                    self.plafond_dur = min(self.plafond_dur, r["heures"])
                else:
                    self.plafond_souple = r["heures"]
                    self.param["poids"]["plafond_jour_souple"] = r.get("poids", self.param["poids"]["plafond_jour_souple"])
            elif t == "cm_avant_td":
                self.cm_avant_td = True
                self.param["poids"]["cm_avant_td"] = r.get("poids", self.param["poids"]["cm_avant_td"])
            elif t == "enseignant_site_unique_jour":
                self.deux_sites_dur = r.get("dure", False)
            elif t == "site_unique_jour":
                pass  # garanti : une promotion a un site et toutes ses salles y sont
            else:
                self.erreurs.append(f"règle {r.get('id')} : type « {t} » inconnu, ignorée")

    def interdit(self, c: Cours, jour: str, demi: int, di: int | None = None) -> bool:
        """Règle « interdire » ; `du` / `au` facultatifs bornent sa période de validité."""
        for r in self.interdits:
            if di is not None and (("du" in r and self.dates[di] < _d(r["du"])) or
                                   ("au" in r and self.dates[di] > _d(r["au"]))):
                continue
            cib = r.get("cible", {})
            if "id_classe" in cib and cib["id_classe"] not in c.classes:
                continue
            if "id_enseignant" in cib and cib["id_enseignant"] != c.enseignant:
                continue
            if "id_cours" in cib and cib["id_cours"] != c.id:
                continue
            if r.get("jours") and jour not in r["jours"]:
                continue
            if r.get("demi") is not None and r["demi"] != demi:
                continue
            return True
        return False

    # --- cours ----------------------------------------------------------------
    def _cours(self, c):
        atomes, eff = [], 0
        for p in c["publics"]:
            a, e = self.public(p)
            atomes += a
            eff += e
        classes = sorted({p["id_classe"] for p in c["publics"]})
        sites = {self.classes[i]["id_site"] for i in classes}
        if len(sites) > 1:
            self.erreurs.append(f"cours {c['id_cours']} : publics sur plusieurs sites, non programmable")
        site = min(sites)
        k = Cours(c["id_cours"], c["id_matiere"], c["type_cours"], classes,
                  sum(1 << a for a in set(atomes)), sorted(set(atomes)), eff, c["id_enseignant"],
                  types_salle_de(c), c["volume"], sorted(c.get("durees") or [2], reverse=True),
                  c.get("h_sem_min", 2), c.get("h_sem_max", 8), site)
        possibles = []
        for s in self.salles.values():
            if s["id_site"] != site or (k.types_salle and s["id_type_salle"] not in k.types_salle) or s["capacite"] < eff:
                continue
            if not s.get("est_disponible", True):
                continue
            res = s.get("reservee_a") or []
            if res and not set(res) & set(classes):
                continue
            # réservée au cours d'abord, puis la plus petite qui convient
            possibles.append((0 if res else 1, s["capacite"], s["id_salle"]))
        k.salles = [x[2] for x in sorted(possibles)]
        # rythme maximal = règle dure (CD-14, vérifiée par la base) : on signale seulement
        # quand la présence de l'enseignant ne suffit pas à faire le volume
        n_pres = sum(1 for w in range(self.n_semaines)
                     if any(self.ens_present[k.enseignant][i] for i in self.jours_semaine[w]))
        if k.volume > k.h_max * n_pres:
            self.erreurs.append(f"cours {k.id} : {k.volume} h impossibles en {n_pres} semaine(s) de présence de "
                                f"l'enseignant à {k.h_max} h maximum par semaine (il faudrait {plafond(k.volume / max(n_pres, 1))} h)")
        if len(sites) == 1 and not k.salles:
            self.erreurs.append(f"cours {k.id} : aucune salle (types {k.types_salle}, {eff} places, site {site})")
        self.cours[k.id] = k

    def demi_de(self, di: int, h: int) -> int:
        for i, (a, b) in enumerate(self.plages[di]):
            if a <= h < b:
                return i
        return -1

    def semaines_restantes(self, c: Cours, w: int, fin: int | None = None) -> int:
        """Semaines de w à fin (exclue) où l'enseignant est présent au moins un jour."""
        pres = self.ens_present[c.enseignant]
        fin = self.n_semaines if fin is None else fin
        return sum(1 for x in range(w, fin) if any(pres[i] for i in self.jours_semaine[x]))


def types_salle_de(c: dict) -> list[int]:
    """Types de salle acceptés : liste `types_salle`, sinon `id_type_salle` (colonne de la base) ;
    liste vide = tout type (id_type_salle NULL dans la base)."""
    if c.get("types_salle"):
        return list(c["types_salle"])
    return [c["id_type_salle"]] if c.get("id_type_salle") is not None else []


def heures_par_semaine(cible: int, durees: list[int]) -> list[int]:
    """Découpe des heures d'une semaine en séances selon les durées préférées."""
    out, reste = [], cible
    while reste > 0:
        d = next((x for x in durees if x <= reste and (reste - x == 0 or reste - x >= min(durees))), None)
        if d is None:
            d = min(durees) if reste >= min(durees) else reste
        out.append(d)
        reste -= d
    return out


def plafond(x: float) -> int:
    return int(math.ceil(x))
