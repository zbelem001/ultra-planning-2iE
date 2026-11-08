"""Lecture de brut/salles/*.json (extraire_salles.mjs) : une ligne par séance, sans doublon.

Chaque cours d'HyperPlanning porte ses semaines (`dom` : « [12] », « [10..11] », « [3,5] », indices depuis le
premier lundi de l'année) et sa place dans la semaine (`p` = jour × places par jour + heure depuis 7 h). Une séance
revient dans chaque vue qui la montre (ses salles, ses promotions), sous un identifiant qui change d'une session du
navigateur à l'autre : fusionner() les rapproche par leur contenu.
"""
from __future__ import annotations

import glob
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

BRUT = Path(__file__).parent / "brut"


@dataclass
class SeanceHP:
    cle: tuple
    date: date
    debut: int  # heure
    fin: int
    matiere: str
    enseignants: list[str]
    promotions: list[str]
    salles: list[str]
    type_hp: str
    numero: str
    annulee: bool = False
    autres: dict = field(default_factory=dict)  # contenus non reconnus, pour l'analyse
    # vue par promotion : groupes (contenu 14) et options (contenu 15) affichés pour chaque promotion
    groupes: dict = field(default_factory=dict)


def _libelles(c) -> list[str]:
    if c is None:
        return []
    if isinstance(c, str):
        return [c]
    if isinstance(c, dict):
        return [c["L"]] if c.get("L") else []
    if isinstance(c, list):
        return [x["L"] for x in c if isinstance(x, dict) and x.get("L")]
    return []


def semaines(dom: str) -> list[int]:
    out = []
    for partie in dom.strip("[]").split(","):
        partie = partie.strip()
        if not partie:
            continue
        if ".." in partie:
            a, b = partie.split("..")
            out += range(int(a), int(b) + 1)
        else:
            out.append(int(partie))
    return out


def parametres() -> tuple[date, int]:
    p = json.load(open(BRUT / "parametres_salles.json"))["dataSec"]["data"]["parametreGeneral"]
    return datetime.strptime(p["PremierLundi"]["V"], "%d/%m/%Y").date(), int(p["PlacesParJour"])


def _vues(dossier: str) -> list[SeanceHP]:
    """Une ligne par cours et par semaine, telle que chaque fichier la montre (brut/salles/ : la salle du fichier en
    premier ; brut/promotions/ : la promotion du fichier, avec ses groupes et options)."""
    premier_lundi, places_jour = parametres()
    out = []
    for f in sorted(glob.glob(str(BRUT / dossier / "*.json"))):
        d = json.load(open(f))
        salle = d.get("salle")
        promo = " ".join(d["promotion"].split()) if "promotion" in d else None
        for s in d["semaines"]:
            for nom_liste, annulee in (("ListeCours", False), ("ListeAnnulationsCours", True)):
                liste = s.get(nom_liste) or []
                if isinstance(liste, dict):
                    liste = liste.get("V", [])
                for c in liste:
                    if "listeC" not in c or "dom" not in c:
                        continue
                    g: dict[int, list[str]] = {}
                    for x in c["listeC"]:
                        g.setdefault(int(x["G"]), []).extend(_libelles(x.get("C")))
                    jour, place = divmod(int(c["p"]), places_jour)
                    salles = [x for x in g.get(3, []) if x != salle]
                    for w in semaines(c["dom"]):
                        out.append(SeanceHP(
                            cle=(c.get("N"), w), date=premier_lundi + timedelta(weeks=w - 1, days=jour), debut=7 + place,
                            fin=7 + place + int(c["d"]), matiere=(g.get(0) or [""])[0], enseignants=g.get(1, []),
                            promotions=[promo] if promo else g.get(13, []), salles=([salle] if salle else []) + salles,
                            type_hp=(g.get(7) or [""])[0], numero=(g.get(6) or [""])[0], annulee=annulee,
                            autres={k: v for k, v in g.items() if k not in (0, 1, 3, 6, 7, 9, 13, 14, 15) and v},
                            groupes={promo: sorted({" ".join(x.split()) for x in g.get(14, []) + g.get(15, [])})} if promo else {},
                        ))
    return out


def fusionner(vues: list[SeanceHP]) -> list[SeanceHP]:
    """Une séance par cours réel. Les identifiants d'HyperPlanning changent d'une session du navigateur à l'autre :
    deux lignes sont la même séance si elles ont même date, mêmes heures, même matière, mêmes enseignants, et des
    salles en commun (ou aucune salle ni l'une ni l'autre). Promotions, groupes et salles sont réunis."""
    norm = lambda t: " ".join(t.lower().split())  # noqa: E731
    paquets: dict[tuple, list[SeanceHP]] = {}
    for v in vues:
        k = (v.date, v.debut, v.fin, norm(v.matiere), tuple(sorted(norm(e) for e in v.enseignants)))
        paquets.setdefault(k, []).append(v)
    out = []
    for lignes in paquets.values():
        seances: list[SeanceHP] = []
        for v in lignes:
            sa = {norm(x) for x in v.salles}
            memes = [s for s in seances if ({norm(x) for x in s.salles} & sa) or (not s.salles and not sa)]
            if not memes:
                seances.append(SeanceHP(cle=v.cle, date=v.date, debut=v.debut, fin=v.fin, matiere=v.matiere, enseignants=list(v.enseignants),
                                        promotions=list(v.promotions), salles=list(v.salles), type_hp=v.type_hp, numero=v.numero,
                                        annulee=v.annulee, autres=dict(v.autres), groupes={k: list(g) for k, g in v.groupes.items()}))
                continue
            s = memes[0]
            for autre in memes[1:]:  # cette ligne relie deux séances déjà vues : elles n'en font qu'une
                _ajouter(s, autre)
                seances.remove(autre)
            _ajouter(s, v)
        out += seances
    return sorted(out, key=lambda s: (s.date, s.debut, s.matiere))


def _ajouter(s: SeanceHP, v: SeanceHP) -> None:
    for x in v.salles:
        if x not in s.salles:
            s.salles.append(x)
    vues = {" ".join(x.split()) for x in s.promotions}
    s.promotions += [x for x in v.promotions if " ".join(x.split()) not in vues]
    for k, g in v.groupes.items():
        s.groupes[k] = sorted(set(s.groupes.get(k, [])) | set(g))
    s.annulee = s.annulee and v.annulee  # annulée seulement si toutes les vues le disent
    for k, x in v.autres.items():
        s.autres.setdefault(k, x)


def lire() -> list[SeanceHP]:
    """Vues par salle seulement"""
    return fusionner(_vues("salles"))


def lire_promotions() -> list[SeanceHP]:
    """Vues par promotion seulement (brut/promotions/, extraire_salles.mjs --promotions)"""
    return fusionner(_vues("promotions"))


def lire_tout() -> list[SeanceHP]:
    """Vues par promotion (promotions, groupes, options) et par salle (salles, séances sans promotion affichée)"""
    return fusionner(_vues("promotions") + _vues("salles"))


if __name__ == "__main__":
    from collections import Counter

    ss = lire()
    print(f"{len(glob.glob(str(BRUT / 'salles' / '*.json')))} salles lues, {len(ss)} séances distinctes "
          f"({sum(s.annulee for s in ss)} annulées), du {ss[0].date} au {ss[-1].date}")
    print("types :", Counter(s.type_hp for s in ss).most_common())
    print("durées :", sorted(Counter(s.fin - s.debut for s in ss).items()))
    print("heures de début :", sorted(Counter(s.debut for s in ss).items()))
    print("promotions par séance :", sorted(Counter(len(s.promotions) for s in ss).items()))
    print("enseignants par séance :", sorted(Counter(len(s.enseignants) for s in ss).items()))
    print("salles par séance :", sorted(Counter(len(s.salles) for s in ss).items()))
    promos = Counter(p for s in ss for p in s.promotions)
    print(f"{len(promos)} promotions :")
    for p, n in sorted(promos.items()):
        print(f"   {n:4} {p}")
    print("autres contenus :", Counter(k for s in ss for k in s.autres).most_common(), [s.autres for s in ss if s.autres][:3])
    print("matières :", len({s.matiere for s in ss}), "| enseignants :", len({e for s in ss for e in s.enseignants}))
