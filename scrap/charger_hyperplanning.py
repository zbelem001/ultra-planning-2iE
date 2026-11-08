"""Charge dans la base les cours extraits d'HyperPlanning (extraire_salles.mjs, lus par lire_salles.py) :
filières, classes, matières, enseignants, programme, cours (avec leurs publics mutualisés) et séances, dans la
version à jour du semestre. Chaque séance passe les règles de la base (les mêmes que dans la console) : celles
qu'elle refuse sont comptées par motif, rien n'est forcé.

À blanc par défaut : tout est fait dans une transaction annulée à la fin, puis le bilan est affiché.
--appliquer garde le résultat (une seule version dans l'historique de Planification, restaurable) et écrit dans
brut/import_<date>.json tout ce qu'il a créé ou modifié : annuler_import.py le défait.

Choix :
- une promotion = une classe ; CYCLE ING IIA S9 et S7 vont dans les classes existantes. Les séances de IIA-S9
  ne sont pas touchées (déjà en base et retravaillées) ;
- un cours réunissant plusieurs promotions appartient à la première (par code), les autres en sont les publics ;
- avec les vues par promotion (brut/promotions/), les groupes et options d'HyperPlanning (« TD 01 », « EMIH »,
  « S5D GEAAH »...) deviennent des groupes de type option de leur classe : deux options sont disjointes, leurs
  séances peuvent avoir lieu en même temps, comme dans HyperPlanning. Une séance de plusieurs groupes d'une
  promotion cible le groupe « TD 01 + TD 02 » ;
- le maximum de matières différentes par semaine (CD-13) de la version à jour est relevé à celui d'HyperPlanning ;
- Cours → CM, TD, TP, Projet → TP, Colle → TD ; Examen et Évaluation → examen, Rattrapage → rattrapage ;
  le reste (réunions...) est laissé de côté ;
- une séance est ramenée dans la grille (7h–12h, 13h–16h ; samedi matin) et découpée en séances de 2 à 4 h ;
  une épreuve doit tenir telle quelle (2 à 3 h) ;
- le semestre commence comme l'année d'HyperPlanning (31/08/2026) : son début est avancé s'il est plus tard ;
- seules les séances du semestre sont chargées ; enseignant à désigner si le sien est déjà pris. Une séance pendant un
  congé du calendrier (vacances de fin d'année...) est refusée par la base et laissée de côté ;
- une épreuve d'un module sans cours dans le semestre (module enseigné en groupes, ou ailleurs) est gardée : un cours
  de 2 h de CM est créé pour la porter (une séance appartient toujours à un cours), à compléter ou retirer ensuite.

Usage (depuis backend/) : .venv/bin/python ../scrap/charger_hyperplanning.py [--appliquer]
"""
from __future__ import annotations

import io
import json
import re
import sys
import time as chrono
import unicodedata
from collections import Counter, defaultdict
from datetime import date, datetime, time
from pathlib import Path

sys.path.insert(0, ".")
sys.path.insert(0, str(Path(__file__).parent))

import psycopg  # noqa: E402

from app import config  # noqa: E402
from app.db import entrer_ecole, origine  # noqa: E402
from lire_salles import BRUT, lire, lire_tout  # noqa: E402

ECOLE, ADMINISTRATEUR = 1, 2
TYPES = {"Cours": "CM", "TD": "TD", "TP": "TP", "Projet": "TP", "Colle": "TD", "": "CM"}
EPREUVES = {"Examen": "examen", "Evaluation": "examen", "Rattrapage": "rattrapage"}
JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
PRENOM_INCONNU = "(à compléter)"
NOTE = "Import HyperPlanning"
DEBUT_SEMESTRE = date(2026, 8, 31)  # premier lundi de l'année dans HyperPlanning
VOLUME_PORTEUR = 2  # heures du cours créé pour porter une épreuve seule
APPLIQUER = "--appliquer" in sys.argv
# à blanc, puis défait dans la même transaction avec annuler_import.py : vérifie que la base revient à l'identique
TESTER_ANNULATION = "--tester-annulation" in sys.argv
ETAT = """SELECT (SELECT count(*) FROM filiere), (SELECT count(*) FROM classe), (SELECT count(*) FROM groupe),
  (SELECT count(*) FROM matiere), (SELECT count(*) FROM enseignant), (SELECT count(*) FROM programme),
  (SELECT sum(volume_cm + volume_td + volume_tp) FROM programme), (SELECT count(*) FROM cours),
  (SELECT count(*) FROM cours_public), (SELECT count(*) FROM seance), (SELECT min(date_debut) FROM semestre),
  (SELECT string_agg(valeur::text, ',' ORDER BY id_contrainte) FROM contrainte WHERE type_contrainte = 'CD-13')"""


def sans_accents(s: str) -> str:
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()


def cle(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", sans_accents(s).upper())


def code_promotion(p: str) -> str:
    s = " ".join(sans_accents(p).upper().split())
    for a, b in (("BACHELOR TECHNO", "BT"), ("BACHELOR", "BACH"), ("CYCLE ING ", ""), ("COURS PREPA", "PREPA"), ("MASTER ", "M")):
        s = s.replace(a, b)
    return re.sub(r"[^A-Z0-9]+", "-", s).strip("-")


def niveau(code: str) -> str:
    t = code.split("-")
    if t[0] == "BT" or "ELECTRO" in code:
        return "BT"
    if t[0] == "PREPA":
        return "CPGE1" if t[-1] == "1" else "CPGE2"
    if t[0] in ("M1", "M2"):
        return t[0]
    if m := re.search(r"(?:^|-)(?:L|ANNEE-)([123])(?:\b|-|$)", code):
        return f"L{m.group(1)}"
    if m := re.search(r"(?:^|-)S(\d+)", code):
        return ["L1", "L1", "L2", "L2", "L3", "L3", "M1", "M1", "M2", "M2"][min(int(m.group(1)), 10) - 1]
    return "AUTRE"


def famille(code: str) -> str:
    if code.startswith("IIA"):
        return "IA"
    t = [x for x in code.split("-") if not re.fullmatch(r"S\d+|L\d[DS]?|[123]|D|S|ANNEE", x)]
    return "-".join("M" if x in ("M1", "M2") else x for x in t) or code


def libelle_famille(f: str) -> str:
    noms = {"BACH": "Bachelor", "BT": "Bachelor technologique", "M": "Master", "PREPA": "Classes préparatoires"}
    return " ".join(noms.get(x, x) for x in f.split("-"))


def matricule(nom: str) -> str:
    return "HP-" + re.sub(r"[^A-Z0-9]+", "-", sans_accents(nom).upper()).strip("-")


def code_matiere(libelle: str, pris: set[str]) -> str:
    texte = sans_accents(re.sub(r"[’'](?=\w)", " ", libelle))
    mots = [m for m in re.split(r"[^A-Za-z0-9]+", texte) if len(m) >= 3 or m.isupper()]
    base = "HP-" + ("".join(m[0] for m in mots).upper()[:5] or "MAT")
    code, i = base, 2
    while code in pris:
        code, i = f"{base}{i}", i + 1
    pris.add(code)
    return code


def publics_de(s) -> list[tuple[str, str | None]]:
    """(promotion, groupe ou None pour la promotion entière), triés par code : le premier est le propriétaire."""
    out: dict[str, str | None] = {}
    for p in s.promotions:
        g = s.groupes.get(" ".join(p.split()))
        out[code_promotion(p)] = " + ".join(g) if g else None
    return sorted(out.items())


def morceaux(debut: int, fin: int, blocs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Parties de [debut, fin[ dans les plages de la grille, découpées en séances de 2 à 4 h."""
    out = []
    for a, b in blocs:
        x, y = max(debut, a), min(fin, b)
        n = y - x
        while n >= 2:
            longueur = n if n <= 4 else 3  # 5 h : 3 + 2 ; 6 h : 3 + 3 ; 7 h : 3 + 4
            out.append((x, x + longueur))
            x, n = x + longueur, n - longueur
    return out


def principal() -> None:
    conn = psycopg.connect(config.DATABASE_URL, connect_timeout=15)
    entrer_ecole(conn, ECOLE, ADMINISTRATEUR)
    origine(conn, "systeme")
    conn.execute("SELECT set_config('app.note', %s, true)", (NOTE,))
    q = lambda s, *a: conn.execute(s, a).fetchall()  # noqa: E731

    def plusieurs(sql: str, lignes: list[tuple]) -> list[int]:
        """INSERT ... RETURNING pour chaque ligne, en un seul échange avec la base ; identifiants dans l'ordre des lignes"""
        if not lignes:
            return []
        ids = []
        with conn.cursor() as cur:
            cur.executemany(sql, lignes, returning=True)
            while True:
                ids.append(cur.fetchone()[0])
                if not cur.nextset():
                    break
        return ids
    etat_avant = q(ETAT)[0]
    t0 = chrono.monotonic()

    id_semestre, sem_debut, sem_fin = q("SELECT id_semestre, date_debut, date_fin FROM semestre ORDER BY date_debut DESC LIMIT 1")[0]
    if sem_debut > DEBUT_SEMESTRE:
        conn.execute("UPDATE semestre SET date_debut = %s WHERE id_semestre = %s", (DEBUT_SEMESTRE, id_semestre))
        print(f"Début du semestre avancé : {sem_debut:%d/%m/%Y} → {DEBUT_SEMESTRE:%d/%m/%Y}")
        semestre_debut_avant, sem_debut = sem_debut, DEBUT_SEMESTRE
    else:
        semestre_debut_avant = None
    id_edt = q("SELECT id_edt FROM emploi_du_temps WHERE id_semestre = %s AND statut = 'brouillon' ORDER BY version DESC LIMIT 1", id_semestre)[0][0]
    salles = {nom: (i, site) for i, nom, site in q("SELECT id_salle, nom_salle, id_site FROM salle")}
    creneaux = {(j, h.hour): i for i, j, h in q("SELECT id_creneau, jour, heure_debut FROM creneau")}
    blocs_jour: dict[str, list[tuple[int, int]]] = {}
    for jour in JOURS:
        heures = sorted(h for (j, h) in creneaux if j == jour)
        blocs = []
        for h in heures:
            if blocs and blocs[-1][1] == h:
                blocs[-1][1] = h + 1
            else:
                blocs.append([h, h + 1])
        blocs_jour[jour] = [tuple(b) for b in blocs]

    bilan = Counter()
    exemples = defaultdict(list)
    # pour annuler_import.py : ce qui est créé, et l'état d'avant de ce qui est modifié
    trace = {"id_edt": id_edt, "id_semestre": id_semestre, "creees": defaultdict(list), "programme_avant": [],
             "semestre_debut_avant": semestre_debut_avant and semestre_debut_avant.isoformat(), "cd13_avant": None}

    def ecarter(motif: str, s, heures: float | None = None) -> None:
        bilan[motif] += 1
        if heures:
            bilan[f"{motif} (heures)"] += heures
        if len(exemples[motif]) < 3:
            exemples[motif].append(f"{s.date} {s.debut}h–{s.fin}h {s.matiere} · {', '.join(s.promotions)[:60]}")

    # --- les séances d'HyperPlanning, ramenées à notre modèle ----------------------------
    par_promotion = any((BRUT / "promotions").glob("*.json"))
    seances = lire_tout() if par_promotion else lire()
    print("Séances lues :", "vues par promotion et par salle" if par_promotion else "vues par salle seulement")
    bilan["séances distinctes lues"] = len(seances)
    retenues = []  # (seance HP, publics [(promotion, groupe)], nature ou type, morceaux)
    for s in seances:
        pubs = publics_de(s)
        promos = [c for c, _ in pubs]
        if s.annulee:
            ecarter("annulée dans HyperPlanning", s)
        elif not promos:
            ecarter("sans promotion", s)
        elif not (sem_debut <= s.date <= sem_fin):
            ecarter("hors du semestre du référentiel", s, s.fin - s.debut)
        elif any(cle(p) == "IIAS9" for p in promos):
            ecarter("IIA-S9 (déjà en base, non touchée)", s)
        elif s.type_hp in EPREUVES:
            if not (2 <= s.fin - s.debut <= 3) or morceaux(s.debut, s.fin, blocs_jour[JOURS[s.date.weekday()]]) != [(s.debut, s.fin)]:
                ecarter("épreuve hors grille ou de plus de 3 h", s)
            else:
                retenues.append((s, pubs, EPREUVES[s.type_hp], [(s.debut, s.fin)]))
        elif s.type_hp in TYPES:
            parts = morceaux(s.debut, s.fin, blocs_jour[JOURS[s.date.weekday()]])
            perdu = (s.fin - s.debut) - sum(b - a for a, b in parts)
            if not parts:
                ecarter("hors grille ou moins de 2 h", s, s.fin - s.debut)
                continue
            if perdu:
                bilan["heures hors grille perdues sur des séances gardées"] += perdu
            if len(parts) > 1:
                bilan["séances découpées"] += 1
            retenues.append((s, pubs, TYPES[s.type_hp], parts))
        else:
            ecarter(f"type « {s.type_hp} » non repris", s)
    bilan["séances retenues"] = len(retenues)
    bilan["avec plusieurs enseignants (le premier gardé)"] = sum(len(s.enseignants) > 1 for s, *_ in retenues)
    bilan["dans plusieurs salles (la première gardée)"] = sum(len(s.salles) > 1 for s, *_ in retenues)

    # --- référentiel : filières, classes ----------------------------------------------
    existantes = {cle(code): (i, code) for i, code in q("SELECT id_classe, code_classe FROM classe")}
    filieres = {code: i for i, code in q("SELECT id_filiere, code_filiere FROM filiere")}
    sites = {code: i for i, code in q("SELECT id_site, code_site FROM site")}
    toutes = sorted({c for _, pubs, *_ in retenues for c, _ in pubs})
    site_promo: dict[str, Counter] = defaultdict(Counter)
    for s, pubs, *_ in retenues:
        for c, _ in pubs:
            site_promo[c][salles.get(s.salles[0], (None, None))[1] if s.salles else None] += 1
    nouvelles_filieres = {}
    for p in toutes:
        f = famille(p)
        if cle(p) not in existantes and f not in filieres and f not in nouvelles_filieres:
            membres = Counter()
            for x in toutes:
                if famille(x) == f:
                    membres += site_promo[x]
            nouvelles_filieres[f] = membres.most_common(1)[0][0] if membres else None
    for f, site in sorted(nouvelles_filieres.items()):
        filieres[f] = q("INSERT INTO filiere (code_filiere, libelle, id_site, id_ecole) VALUES (%s, %s, %s, %s) RETURNING id_filiere",
                        f, libelle_famille(f), site, ECOLE)[0][0]
        trace["creees"]["filiere"].append(filieres[f])
    classe_de: dict[str, int] = {}
    noms_promo = {code_promotion(p): " ".join(p.split()) for s, *_ in retenues for p in s.promotions}
    for p in toutes:
        if cle(p) in existantes:
            classe_de[p] = existantes[cle(p)][0]
            continue
        classe_de[p] = q("INSERT INTO classe (code_classe, libelle, niveau, effectif, id_filiere, id_ecole) VALUES (%s, %s, %s, 0, %s, %s) "
                         "RETURNING id_classe", p, noms_promo[p], niveau(p), filieres[famille(p)], ECOLE)[0][0]
        trace["creees"]["classe"].append(classe_de[p])
        bilan["classes créées"] += 1
    bilan["filières créées"] = len(nouvelles_filieres)

    # --- groupes et options d'HyperPlanning (vues par promotion) --------------------------
    groupe_de: dict[tuple[str, str], int] = {}
    deja = {(c, g): i for i, c, g in q("SELECT id_groupe, id_classe, code_groupe FROM groupe")}
    voulus = sorted({x for _, pubs, t, _ in retenues if t in ("CM", "TD", "TP") for x in pubs if x[1]})
    a_creer = sorted({(classe_de[c], g) for c, g in voulus} - set(deja))
    for k, i in zip(a_creer, plusieurs("INSERT INTO groupe (code_groupe, type_groupe, effectif, id_classe, id_ecole) "
                                       "VALUES (%s, 'OPTION', 0, %s, %s) RETURNING id_groupe", [(g, c, ECOLE) for c, g in a_creer])):
        deja[k] = i
        trace["creees"]["groupe"].append(i)
    bilan["groupes et options créés"] = len(a_creer)
    for c, g in voulus:
        groupe_de[(c, g)] = deja[(classe_de[c], g)]
    gid = lambda pub: groupe_de[pub] if pub[1] else None  # noqa: E731

    # --- matières, enseignants ----------------------------------------------------------
    matieres = {" ".join(sans_accents(l).lower().split()): (i, c) for i, c, l in q("SELECT id_matiere, code_matiere, libelle FROM matiere")}
    pris = {c for _, c in matieres.values()}
    nouvelles = []  # (clé, code, libellé)
    for libelle in sorted({s.matiere for s, *_ in retenues}):
        k = " ".join(sans_accents(libelle).lower().split())
        if k not in matieres and k not in {x[0] for x in nouvelles}:
            nouvelles.append((k, code_matiere(libelle, pris), libelle))
    for (k, c, _), i in zip(nouvelles, plusieurs("INSERT INTO matiere (code_matiere, libelle, coefficient, id_ecole) VALUES (%s, %s, 1, %s) "
                                                 "RETURNING id_matiere", [(c, l, ECOLE) for _, c, l in nouvelles])):
        matieres[k] = (i, c)
        trace["creees"]["matiere"].append(i)
    bilan["matières créées"] = len(nouvelles)
    mat = lambda l: matieres[" ".join(sans_accents(l).lower().split())][0]  # noqa: E731
    enseignants = {m: i for i, m in q("SELECT id_enseignant, matricule FROM enseignant")}
    noms = {}
    for nom in sorted({s.enseignants[0] for s, *_ in retenues if s.enseignants}):
        if matricule(nom) not in enseignants:
            noms.setdefault(matricule(nom), nom)
    for m, i in zip(noms, plusieurs("INSERT INTO enseignant (matricule, nom, prenom, statut, id_ecole) VALUES (%s, %s, %s, 'permanent', %s) "
                                    "RETURNING id_enseignant", [(m, nom, PRENOM_INCONNU, ECOLE) for m, nom in noms.items()])):
        enseignants[m] = i
        trace["creees"]["enseignant"].append(i)
    bilan["enseignants créés"] = len(noms)
    ens = lambda s: enseignants[matricule(s.enseignants[0])] if s.enseignants else None  # noqa: E731

    # --- cours (avec publics), programme -------------------------------------------------
    groupes_cours: dict[tuple, list] = defaultdict(list)  # (propriétaire, matière, type, autres publics) -> morceaux
    for s, pubs, t, parts in retenues:
        if t in ("CM", "TD", "TP"):
            for a, b in parts:
                groupes_cours[(pubs[0], mat(s.matiere), t, tuple(pubs[1:]))].append((s, a, b))
    # épreuves d'un module sans cours de cette promotion : un cours de CM les porte
    porteurs = set()
    for s, pubs, t, _ in retenues:
        m = mat(s.matiere)
        if t not in ("CM", "TD", "TP") and not any(k[0][0] == pubs[0][0] and k[1] == m for k in groupes_cours):
            porteurs.add(((pubs[0][0], None), m, "CM", tuple((c, None) for c, _ in pubs[1:])))
    volumes: dict[tuple, float] = defaultdict(float)  # (classe, matière, type) -> plus grand volume d'un cours
    for (proprio, m, t, publics), ms in [*groupes_cours.items(), *((k, None) for k in porteurs)]:
        v = sum(b - a for _, a, b in ms) if ms is not None else VOLUME_PORTEUR
        for p, _ in (proprio, *publics):
            volumes[(classe_de[p], m, t)] = max(volumes[(classe_de[p], m, t)], v)
    programme = defaultdict(lambda: {"CM": 0.0, "TD": 0.0, "TP": 0.0})
    for (c, m, t), v in volumes.items():
        programme[(c, m)][t] = v
    existant = {(c, m): (i, cm, td, tp) for i, c, m, cm, td, tp in q(
        "SELECT id_programme, id_classe, id_matiere, volume_cm, volume_td, volume_tp FROM programme WHERE id_semestre = %s", id_semestre)}
    maj, ajouts = [], []
    for (c, m), v in programme.items():
        if (c, m) in existant:
            i, *vols = existant[(c, m)]
            trace["programme_avant"].append([i, *(float(x) for x in vols)])
            maj.append((v["CM"], v["TD"], v["TP"], i))
        else:
            ajouts.append((c, m, id_semestre, v["CM"], v["TD"], v["TP"], ECOLE))
    if maj:
        conn.cursor().executemany("UPDATE programme SET volume_cm = greatest(volume_cm, %s), volume_td = greatest(volume_td, %s), "
                                  "volume_tp = greatest(volume_tp, %s) WHERE id_programme = %s", maj)
    trace["creees"]["programme"] += plusieurs("INSERT INTO programme (id_classe, id_matiere, id_semestre, volume_cm, volume_td, volume_tp, id_ecole) "
                                              "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id_programme", ajouts)
    bilan["lignes de programme créées"] = len(ajouts)
    cles, valeurs = [], []
    for (proprio, m, t, publics), ms in sorted(groupes_cours.items(), key=lambda x: str(x[0])):  # str : un public sans groupe a None
        semaines = Counter((s.date.isocalendar()[:2]) for s, _, _ in ms)
        heures_sem = Counter()
        for s, a, b in ms:
            heures_sem[s.date.isocalendar()[:2]] += b - a
        durees = Counter(b - a for _, a, b in ms)
        prof = Counter(ens(s) for s, _, _ in ms if ens(s)).most_common(1)
        cles.append((proprio, m, t, publics))
        valeurs.append((t, sum(b - a for _, a, b in ms), min(4, max(2, durees.most_common(1)[0][0])), max(semaines.values()),
                        max(2, max(heures_sem.values())), m, classe_de[proprio[0]], gid(proprio), prof[0][0] if prof else None, id_semestre, ECOLE))
    for k in sorted(porteurs, key=str):  # épreuves seules : 2 h de CM, sans enseignant
        cles.append(k)
        valeurs.append(("CM", VOLUME_PORTEUR, 2, 1, 2, k[1], classe_de[k[0][0]], None, None, id_semestre, ECOLE))
    id_cours: dict[tuple, int] = dict(zip(cles, plusieurs(
        "INSERT INTO cours (type_cours, volume_horaire, duree_seance, nb_seances_semaine, priorite, heures_semaine_min, heures_semaine_max, "
        "id_matiere, id_classe, id_groupe, id_enseignant, id_semestre, id_ecole) VALUES (%s, %s, %s, %s, 0, 2, %s, %s, %s, %s, %s, %s, %s) "
        "RETURNING id_cours", valeurs)))
    trace["creees"]["cours"] += [id_cours[k] for k in cles]
    publics_lignes = [(id_cours[k], classe_de[p[0]], gid(p), ECOLE) for k in cles for p in k[3]]
    if publics_lignes:
        conn.cursor().executemany("INSERT INTO cours_public (id_cours, id_classe, id_groupe, id_ecole) VALUES (%s, %s, %s, %s)", publics_lignes)
    bilan["publics mutualisés"] = len(publics_lignes)
    bilan["cours créés"] = len(id_cours)
    bilan[f"dont cours de {VOLUME_PORTEUR} h créés pour porter une épreuve seule"] = len(porteurs)

    # --- séances : chacune passe les règles de la base, dans l'ordre des dates ------------
    lignes = []
    for s, pubs, t, parts in retenues:
        if t in ("CM", "TD", "TP"):
            k, nature, prof = (pubs[0], mat(s.matiere), t, tuple(pubs[1:])), "cours", ens(s)
        else:
            entiers = ((pubs[0][0], None), tuple((c, None) for c, _ in pubs[1:]))
            choix = [x for x in id_cours if (x[0], x[3]) == entiers and x[1] == mat(s.matiere)] \
                or [x for x in id_cours if x[0][0] == pubs[0][0] and x[1] == mat(s.matiere)]
            if not choix:
                ecarter("épreuve d'un module sans cours dans le semestre", s)
                continue
            k, nature, prof = sorted(choix, key=lambda x: "CM TD TP".index(x[2]))[0], t, None
        if not s.salles:
            ecarter("sans salle dans HyperPlanning", s)
            continue
        salle = salles.get(s.salles[0])
        if salle is None:
            ecarter("salle inconnue", s)
            continue
        for a, b in parts:
            creneau = creneaux.get((JOURS[s.date.weekday()], a))
            lignes.append((len(lignes), s.date, time(a), time(b), id_cours[k], prof, salle[0], creneau, nature, s))
    # CD-13 : autant de matières différentes par semaine que dans HyperPlanning, pour chaque classe
    mat_semaine: dict[tuple, set] = defaultdict(set)
    for _i, d, _a, _b, c, _p, _sa, _cr, n, s in lignes:
        if n == "cours":
            for code, _g in publics_de(s):
                mat_semaine[(code, d.isocalendar()[:2])].add(mat(s.matiere))
    if mat_semaine:
        (classe_max, semaine_max), plus = max(mat_semaine.items(), key=lambda x: len(x[1]))
        actuel = q("SELECT max(valeur) FROM contrainte WHERE id_edt = %s AND type_contrainte = 'CD-13'", id_edt)[0][0]
        if actuel is not None and len(plus) > actuel:
            trace["cd13_avant"] = float(actuel)
            conn.execute("UPDATE contrainte SET valeur = %s WHERE id_edt = %s AND type_contrainte = 'CD-13'", (len(plus), id_edt))
            print(f"CD-13 relevé à {len(plus)} matières par semaine (au lieu de {actuel:g}) : "
                  f"{classe_max} en a {len(plus)} la semaine {semaine_max[1]} dans HyperPlanning")
    print(f"Référentiel préparé ({chrono.monotonic() - t0:.0f} s), {len(lignes)} séances à contrôler", flush=True)
    tampon = io.StringIO()
    for i, d, a, b, c, p, sa, cr, n, _ in lignes:
        tampon.write("\t".join(str(x) if x is not None else r"\N" for x in (i, d, a, b, c, p, sa, cr, n)) + "\n")
    conn.execute("CREATE TEMP TABLE imp_seance (idx int PRIMARY KEY, date_seance date, heure_debut time, heure_fin time, id_cours bigint, "
                 "id_enseignant bigint, id_salle bigint, id_creneau bigint, nature text, res text, motif text) ON COMMIT DROP")
    with conn.cursor().copy("COPY imp_seance (idx, date_seance, heure_debut, heure_fin, id_cours, id_enseignant, id_salle, id_creneau, nature) FROM STDIN") as cp:
        cp.write(tampon.getvalue())
    inserer = (f"INSERT INTO seance (date_seance, heure_debut, heure_fin, id_cours, id_enseignant, id_salle, id_creneau, id_edt, id_ecole, nature) "
               f"VALUES (r.date_seance, r.heure_debut, r.heure_fin, r.id_cours, {{ens}}, r.id_salle, r.id_creneau, {int(id_edt)}, {ECOLE}, r.nature)")
    lots = [lignes[i:i + 250] for i in range(0, len(lignes), 250)]
    for n, lot in enumerate(lots, 1):
        premier, dernier = lot[0][0], lot[-1][0]
        conn.execute(f"""
DO $$
DECLARE r record; e text;
BEGIN
  FOR r IN SELECT * FROM imp_seance WHERE idx BETWEEN {premier} AND {dernier} ORDER BY date_seance, heure_debut, idx LOOP
    BEGIN
      {inserer.format(ens='r.id_enseignant')};
      UPDATE imp_seance SET res = 'ok' WHERE idx = r.idx;
    EXCEPTION WHEN OTHERS THEN
      e := SQLERRM;
      IF r.id_enseignant IS NOT NULL AND (e LIKE 'CD-02%' OR e LIKE 'CD-06%') THEN
        BEGIN
          {inserer.format(ens='NULL')};
          UPDATE imp_seance SET res = 'sans enseignant', motif = e WHERE idx = r.idx;
        EXCEPTION WHEN OTHERS THEN
          UPDATE imp_seance SET res = 'refusée', motif = SQLERRM WHERE idx = r.idx;
        END;
      ELSE
        UPDATE imp_seance SET res = 'refusée', motif = e WHERE idx = r.idx;
      END IF;
    END;
  END LOOP;
END $$""")
        print(f"  lot {n}/{len(lots)} contrôlé ({chrono.monotonic() - t0:.0f} s)", flush=True)
    resultats = {i: (res, motif) for i, res, motif in q("SELECT idx, res, motif FROM imp_seance")}

    # --- bilan --------------------------------------------------------------------------
    par_res = Counter(r for r, _ in resultats.values())
    motifs = Counter(re.match(r"([A-Z]{2,}-?\d*|[^:]{0,40})", m or "").group(1) for r, m in resultats.values() if r == "refusée")
    par_classe = defaultdict(Counter)
    for i, *_rest, s in lignes:
        par_classe[s.promotions and code_promotion(s.promotions[0])][resultats[i][0]] += 1
    exemples_refus = defaultdict(list)
    for i, *_rest, s in lignes:
        r, m = resultats[i]
        code = re.match(r"([A-Z]{2,}-?\d*|[^:]{0,40})", m or "").group(1)
        if r == "refusée" and len(exemples_refus[code]) < 2:
            exemples_refus[code].append(f"{s.date} {lignes[i][2].hour}h {s.matiere} · {', '.join(s.promotions)[:50]} : {(m or '')[:110]}")

    print("\n=== BILAN", "(appliqué)" if APPLIQUER else "(à blanc : rien n'est gardé)")
    for k, v in bilan.items():
        print(f"  {k} : {v:g}" if isinstance(v, float) else f"  {k} : {v}")
    print(f"  séances à contrôler (après découpage) : {len(lignes)}")
    for k, v in par_res.most_common():
        print(f"    {k} : {v}")
    print("  motifs de refus :")
    for k, v in motifs.most_common():
        print(f"    {v:5}  {k}  ex. {exemples_refus[k][0] if exemples_refus[k] else ''}")
    print("  écartées avant contrôle, exemples :")
    for k, v in exemples.items():
        print(f"    {k} : {v[0]}")
    print("  par promotion (gardées / sans enseignant / refusées) :")
    for p, c in sorted(par_classe.items()):
        print(f"    {p:42} {c['ok']:4} {c['sans enseignant']:4} {c['refusée']:4}")
    if APPLIQUER:
        conn.commit()
        fichier = BRUT / f"import_{datetime.now():%Y%m%d_%H%M%S}.json"
        fichier.write_text(json.dumps(trace, indent=1))
        print(f"\nTransaction validée. Pour la défaire : annuler_import.py {fichier.name}")
    else:
        if TESTER_ANNULATION:
            from annuler_import import defaire
            print("\nAnnulation, dans la même transaction :")
            trace_json = json.loads(json.dumps(trace))  # comme relue du fichier
            defaire(conn, trace_json)
            etat_apres = q(ETAT)[0]
            print("Base revenue à l'identique." if etat_apres == etat_avant else f"ÉCART :\n  avant {etat_avant}\n  après {etat_apres}")
        conn.rollback()
        print("\nÀ blanc : transaction annulée, la base n'a pas changé.")


if __name__ == "__main__":
    principal()
