"""Changements du référentiel proposés par l'assistant IA (PROPOSITION de nature « referentiel »).

Ajouter, modifier ou supprimer des lignes :
- référentiel : classes, matières, enseignants, salles, programme, cours ;
- calendrier : semestre de l'emploi du temps (modification seulement), jours fériés, congés,
  créneaux de la grille (ajout et suppression) ;
- enseignants : disponibilités de la semaine type, absences datées, séjours des externes.
Rien n'est écrit avant la validation d'un planificateur ; ensuite, la génération ou la
replanification demandée (PROPOSITION.suite) est lancée.

Les lignes se désignent par leurs codes (classe, matière, matricule, date...), jamais par des
identifiants : une ligne ajoutée dans la même proposition peut servir aux suivantes. Tout passe
par les déclencheurs et contraintes de la base (CD-07 programme, clés étrangères...) : une
suppression encore utilisée (salle avec des séances, matière avec des cours) est refusée.

Opérations (PROPOSITION.modifications) :
- {"action": "ajouter_ligne", "table", "valeurs", "libelle"} ;
- {"action": "modifier_ligne", "table", "cle", "avant", "valeurs", "libelle"} et
  {"action": "supprimer_ligne", "table", "cle", "avant", "libelle"} : « avant » est la ligne lue
  à la préparation ; si elle a changé depuis, l'application est refusée ;
- {"action": "disponibilite", "matricule", "jour", "creneaux", "avant", "niveau", "motif",
  "libelle"} : niveau d'un enseignant sur des créneaux de sa semaine type (niveau null : saisie
  retirée, l'enseignant redevient disponible par défaut).

Un changement du calendrier ou d'un enseignant ne déplace aucune séance : `conflits` liste les
séances qui ne respecteraient plus les règles (jour férié, absence, salle devenue trop petite...),
pour les signaler et enchaîner une replanification.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, time
from decimal import Decimal
from typing import Literal, NotRequired, TypedDict

import psycopg
from psycopg import sql

from .propositions import PropositionRefusee

NomTable = Literal["classe", "matiere", "enseignant", "salle", "programme", "cours", "semestre",
                   "jour_ferie", "conge", "creneau", "disponibilite", "absence", "sejour"]
Valeur = str | float | bool | None


class Changement(TypedDict):
    """Une ligne à ajouter, modifier ou supprimer, désignée par ses codes."""
    action: Literal["ajouter", "modifier", "supprimer"]
    table: NomTable
    cle: NotRequired[dict[str, Valeur]]
    valeurs: NotRequired[dict[str, Valeur]]


JOURS = ("Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi")
NIVEAUX_DISPO = ("disponible", "preference", "indisponible")


@dataclass(frozen=True)
class Champ:
    sorte: str = "texte"            # texte, entier, nombre, date, heure, booleen, choix, ref
    colonne: str = ""               # colonne de la base, si elle diffère du nom du champ
    ref: str = ""                   # sorte « ref » : table désignée par son code (REFS)
    choix: tuple[str, ...] = ()
    vidable: bool = False           # une modification peut le vider


# Tables désignées par un code : (table, identifiant, recherche, colonne affichée, nom)
REFS = {
    "filiere": ("filiere", "id_filiere", "upper(code_filiere) = upper(%(v)s)", "code_filiere", "Filière"),
    "site": ("site", "id_site", "upper(code_site) = upper(%(v)s) OR lower(nom_site) = lower(%(v)s)", "nom_site", "Site"),
    "type_salle": ("type_salle", "id_type_salle", "lower(libelle) = lower(%(v)s)", "libelle", "Type de salle"),
    "enseignant": ("enseignant", "id_enseignant", "upper(matricule) = upper(%(v)s)", "matricule", "Enseignant"),
    "classe": ("classe", "id_classe", "upper(code_classe) = upper(%(v)s)", "code_classe", "Classe"),
    "matiere": ("matiere", "id_matiere", "upper(code_matiere) = upper(%(v)s)", "code_matiere", "Matière"),
    "groupe": ("groupe", "id_groupe", "upper(code_groupe) = upper(%(v)s) AND id_classe = %(classe)s", "code_groupe", "Groupe"),
}


@dataclass(frozen=True)
class Table:
    sql: str                        # table de la base
    article: str                    # « la classe » : libellés des suppressions
    champs: dict[str, Champ]
    requis: tuple[str, ...]         # à l'ajout
    cle: tuple[str, ...]            # champs qui désignent une ligne (modifier, supprimer)
    unique: tuple[str, ...]         # ligne identique sur ces champs : ajout laissé de côté
    resume: str = ""                # champ montré entre parenthèses
    cle_nulle: tuple[str, ...] = () # absents de la clé : vides (cours de toute la classe)
    fixes: tuple[str, ...] = ()     # non modifiables (supprimer puis ajouter)
    actions: tuple[str, ...] = ("ajouter", "modifier", "supprimer")
    semestre: bool = False          # lignes du semestre de l'emploi du temps
    defauts: dict = field(default_factory=dict)


def _ref(table: str, colonne: str, **k) -> Champ:
    return Champ("ref", colonne, table, **k)


_COURS_CLE = ("code_classe", "code_matiere", "type_cours", "code_groupe")

TABLES: dict[str, Table] = {
    "classe": Table("classe", "la classe", {
        "code_classe": Champ(), "libelle": Champ(),
        "niveau": Champ("choix", choix=("L1", "L2", "L3", "M1", "M2", "CPGE1", "CPGE2", "BT", "MAN", "AUTRE")),
        "effectif": Champ("entier"), "code_filiere": _ref("filiere", "id_filiere"),
        "site": _ref("site", "id_site", vidable=True)},
        requis=("code_classe", "libelle", "niveau", "code_filiere"), cle=("code_classe",), unique=("code_classe",),
        resume="libelle"),
    "matiere": Table("matiere", "la matière", {"code_matiere": Champ(), "libelle": Champ(), "coefficient": Champ("nombre")},
                     requis=("code_matiere", "libelle"), cle=("code_matiere",), unique=("code_matiere",), resume="libelle"),
    "enseignant": Table("enseignant", "l'enseignant", {
        "matricule": Champ(), "nom": Champ(), "prenom": Champ(), "email": Champ(vidable=True),
        "telephone": Champ(vidable=True), "grade": Champ(vidable=True),
        "statut": Champ("choix", choix=("permanent", "vacataire_local", "externe")),
        "nb_heures_max_semaine": Champ("entier", vidable=True), "site": _ref("site", "id_site", vidable=True)},
        requis=("matricule", "nom", "prenom"), cle=("matricule",), unique=("matricule",), resume="nom"),
    "salle": Table("salle", "la salle", {
        "code_salle": Champ(), "nom_salle": Champ(), "capacite": Champ("entier"),
        "type_salle": _ref("type_salle", "id_type_salle"), "site": _ref("site", "id_site"),
        "batiment": Champ(vidable=True), "est_disponible": Champ("booleen")},
        requis=("code_salle", "nom_salle", "capacite", "type_salle", "site"), cle=("code_salle",), unique=("code_salle",),
        resume="nom_salle"),
    "programme": Table("programme", "la ligne de programme", {
        "code_classe": _ref("classe", "id_classe"), "code_matiere": _ref("matiere", "id_matiere"),
        "volume_cm": Champ("nombre"), "volume_td": Champ("nombre"), "volume_tp": Champ("nombre")},
        requis=("code_classe", "code_matiere"), cle=("code_classe", "code_matiere"), unique=("code_classe", "code_matiere"),
        fixes=("code_classe", "code_matiere"), semestre=True),
    "cours": Table("cours", "le cours", {
        "code_classe": _ref("classe", "id_classe"), "code_matiere": _ref("matiere", "id_matiere"),
        "type_cours": Champ("choix", choix=("CM", "TD", "TP")), "code_groupe": _ref("groupe", "id_groupe"),
        "volume_horaire": Champ("nombre"), "matricule": _ref("enseignant", "id_enseignant", vidable=True),
        "duree_seance": Champ("nombre"), "nb_seances_semaine": Champ("entier"),
        "heures_semaine_min": Champ("nombre"), "heures_semaine_max": Champ("nombre"),
        "type_salle": _ref("type_salle", "id_type_salle", vidable=True), "priorite": Champ("entier")},
        requis=("code_classe", "code_matiere", "type_cours", "volume_horaire"), cle=_COURS_CLE, unique=_COURS_CLE,
        cle_nulle=("code_groupe",), fixes=_COURS_CLE, semestre=True, defauts={"duree_seance": 2}),
    "semestre": Table("semestre", "le semestre", {"libelle": Champ(), "date_debut": Champ("date"), "date_fin": Champ("date")},
                      requis=(), cle=(), unique=(), actions=("modifier",), semestre=True),
    "jour_ferie": Table("jour_ferie", "le jour férié", {"date_ferie": Champ("date"), "libelle": Champ()},
                        requis=("date_ferie", "libelle"), cle=("date_ferie",), unique=("date_ferie",), resume="libelle"),
    "conge": Table("conge", "le congé", {
        "libelle": Champ(), "type_conge": Champ("choix", choix=("vacances", "examens", "stage", "autre")),
        "date_debut": Champ("date"), "date_fin": Champ("date"), "code_classe": _ref("classe", "id_classe", vidable=True)},
        requis=("libelle", "date_debut", "date_fin"), cle=("libelle", "date_debut", "code_classe"),
        unique=("libelle", "date_debut", "date_fin", "code_classe")),
    "creneau": Table("creneau", "le créneau", {
        "jour": Champ("choix", choix=JOURS), "heure_debut": Champ("heure"), "heure_fin": Champ("heure")},
        requis=("jour", "heure_debut", "heure_fin"), cle=("jour", "heure_debut", "heure_fin"),
        unique=("jour", "heure_debut", "heure_fin"), actions=("ajouter", "supprimer")),
    "absence": Table("absence_enseignant", "l'absence", {
        "matricule": _ref("enseignant", "id_enseignant"), "date_debut": Champ("date"), "date_fin": Champ("date"),
        "motif": Champ(vidable=True)},
        requis=("matricule", "date_debut", "date_fin"), cle=("matricule", "date_debut"),
        unique=("matricule", "date_debut", "date_fin"), fixes=("matricule",)),
    "sejour": Table("sejour_enseignant", "le séjour", {
        "matricule": _ref("enseignant", "id_enseignant"), "date_debut": Champ("date"), "date_fin": Champ("date"),
        "commentaire": Champ(vidable=True)},
        requis=("matricule", "date_debut", "date_fin"), cle=("matricule", "date_debut"),
        unique=("matricule", "date_debut", "date_fin"), fixes=("matricule",)),
}
# Ordre des dépendances : une ligne ajoutée sert aux suivantes, on supprime dans l'ordre inverse
ORDRE: list[str] = ["classe", "matiere", "enseignant", "salle", "programme", "cours", "semestre",
                    "jour_ferie", "conge", "creneau", "disponibilite", "absence", "sejour"]

# Noms des champs dans les libellés
NOMS = {
    "code_classe": "classe", "code_matiere": "matière", "code_salle": "code", "code_filiere": "filière",
    "code_groupe": "groupe", "libelle": "libellé", "niveau": "niveau", "effectif": "effectif", "site": "site",
    "coefficient": "coefficient", "matricule": "enseignant", "nom": "nom", "prenom": "prénom", "email": "e-mail",
    "telephone": "téléphone", "grade": "grade", "statut": "statut", "nb_heures_max_semaine": "heures max par semaine",
    "nom_salle": "nom", "capacite": "capacité", "type_salle": "type de salle", "batiment": "bâtiment",
    "est_disponible": "disponible", "volume_cm": "CM", "volume_td": "TD", "volume_tp": "TP", "type_cours": "type",
    "volume_horaire": "volume", "duree_seance": "durée des séances", "nb_seances_semaine": "séances par semaine",
    "heures_semaine_min": "rythme minimal", "heures_semaine_max": "rythme maximal", "priorite": "priorité",
    "date_debut": "début", "date_fin": "fin", "date_ferie": "date", "type_conge": "type", "jour": "jour",
    "heure_debut": "début", "heure_fin": "fin", "motif": "motif", "commentaire": "commentaire",
}


# --- valeurs -----------------------------------------------------------------------

def _normaliser(t: Table, nom: str, x: Valeur) -> Valeur:
    """Valeur venue du modèle ou d'un fichier (« 12,5 », « 8h », « oui »), dans la forme
    enregistrée dans l'opération. Lève ValueError."""
    if x is None or (isinstance(x, str) and not x.strip()):
        return None
    c = t.champs[nom]
    s = x.strip() if isinstance(x, str) else x
    if c.sorte in ("entier", "nombre"):
        try:
            n = float(str(s).replace(",", ".").replace(" ", ""))
        except ValueError:
            raise ValueError(f"{nom} doit être un nombre (reçu « {x} »)") from None
        if c.sorte == "entier":
            if not n.is_integer():
                raise ValueError(f"{nom} doit être un nombre entier (reçu « {x} »)")
            return int(n)
        return n
    if c.sorte == "date":
        try:
            return date.fromisoformat(str(s)).isoformat()
        except ValueError:
            raise ValueError(f"{nom} doit être une date AAAA-MM-JJ (reçu « {x} »)") from None
    if c.sorte == "heure":
        return _heure(nom, s)
    if c.sorte == "booleen":
        if isinstance(s, bool):
            return s
        if str(s).lower() in ("oui", "vrai", "true", "1"):
            return True
        if str(s).lower() in ("non", "faux", "false", "0"):
            return False
        raise ValueError(f"{nom} : oui ou non (reçu « {x} »)")
    if c.sorte == "choix":
        trouve = next((v for v in c.choix if v.lower() == str(s).lower()), None)
        if trouve is None:
            raise ValueError(f"{nom} : « {x} » n'est pas une valeur possible ({', '.join(c.choix)})")
        return trouve
    return str(s)


def _heure(nom: str, x) -> str:
    m = re.fullmatch(r"(\d{1,2})(?:[:hH](\d{2})?)?", str(x).strip())
    if not m or int(m[1]) > 23 or int(m[2] or 0) > 59:
        raise ValueError(f"{nom} doit être une heure HH:MM (reçu « {x} »)")
    return f"{int(m[1]):02d}:{m[2] or '00'}"


def _simple(x):
    """Valeur lue dans la base, dans la forme des opérations (JSON)."""
    if isinstance(x, Decimal):
        return float(x)
    if isinstance(x, date):
        return x.isoformat()
    if isinstance(x, time):
        return x.strftime("%H:%M")
    return x


def _texte(nom: str, x) -> str:
    if x is None or x == "":
        return "non renseigné"
    if isinstance(x, bool):
        return "oui" if x else "non"
    if isinstance(x, float):
        return f"{x:g}"
    if isinstance(x, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", x):
        return date.fromisoformat(x).strftime("%d/%m/%Y")
    if nom == "statut":
        return {"vacataire_local": "vacataire local"}.get(x, x)
    return str(x)


# --- accès à la base ---------------------------------------------------------------

def _id_ref(conn: psycopg.Connection, ref: str, code, contexte: dict) -> int:
    table, ident, recherche, _, nom = REFS[ref]
    params = {"v": str(code)}
    if ref == "groupe":
        params["classe"] = _id_ref(conn, "classe", contexte.get("code_classe"), {})
    row = conn.execute(f"SELECT {ident} FROM {table} WHERE {recherche}", params).fetchone()  # noqa: S608 (REFS : constantes)
    if row is None:
        raise PropositionRefusee(f"{nom} « {code} » introuvable dans le référentiel")
    return row[0]


def _affichage_ref(conn: psycopg.Connection, ref: str, code, contexte: dict):
    """Code tel que la base l'affiche (nom du site plutôt que son code) ; inchangé s'il est inconnu."""
    if code is None:
        return None
    try:
        ident = _id_ref(conn, ref, code, contexte)
    except PropositionRefusee:
        return code
    table, cle, _, aff, _ = REFS[ref]
    return conn.execute(f"SELECT {aff} FROM {table} WHERE {cle} = %s", (ident,)).fetchone()[0]  # noqa: S608


def _colonnes(conn: psycopg.Connection, t: Table, v: dict, contexte: dict) -> dict:
    """Colonnes de la base et leurs valeurs (codes remplacés par les identifiants)."""
    return {t.champs[k].colonne or k: (_id_ref(conn, t.champs[k].ref, x, contexte)
                                       if t.champs[k].sorte == "ref" and x is not None else x)
            for k, x in v.items()}


def _ou(conn: psycopg.Connection, t: Table, cle: dict, id_semestre: int, champs_nuls: tuple[str, ...] = ()):
    """Condition qui désigne les lignes (WHERE), avec ses paramètres nommés."""
    conds, params = [], {}
    if t.semestre:
        conds.append(sql.SQL("id_semestre = %(_semestre)s"))
        params["_semestre"] = id_semestre
    designation = {**{k: None for k in champs_nuls}, **cle}
    for i, (k, x) in enumerate(designation.items()):
        c = t.champs[k]
        col = sql.Identifier(c.colonne or k)
        if x is None:
            conds.append(sql.SQL("{} IS NULL").format(col))
            continue
        p = f"p{i}"
        if c.sorte in ("texte", "choix"):
            conds.append(sql.SQL("upper({}) = upper({})").format(col, sql.Placeholder(p)))
        else:
            conds.append(sql.SQL("{} = {}").format(col, sql.Placeholder(p)))
        params[p] = _id_ref(conn, c.ref, x, designation) if c.sorte == "ref" else x
    return (sql.SQL(" AND ").join(conds) if conds else sql.SQL("TRUE")), params


def _lire(conn: psycopg.Connection, t: Table, ou, params: dict) -> list[dict]:
    exprs = []
    for k, c in t.champs.items():
        col = sql.Identifier(c.colonne or k)
        if c.sorte == "ref":
            table, ident, _, aff, _ = REFS[c.ref]
            exprs.append(sql.SQL("(SELECT x.{} FROM {} x WHERE x.{} = t.{})").format(
                sql.Identifier(aff), sql.Identifier(table), sql.Identifier(ident), col))
        else:
            exprs.append(sql.SQL("t.{}").format(col))
    q = sql.SQL("SELECT {} FROM {} t WHERE {}").format(sql.SQL(", ").join(exprs), sql.Identifier(t.sql), ou)
    return [{k: _simple(x) for k, x in zip(t.champs, r)} for r in conn.execute(q, params).fetchall()]


def _trouver(conn: psycopg.Connection, nom: str, cle: dict, id_semestre: int):
    """La ligne désignée : (condition, paramètres, ligne). Lève ValueError si aucune ou plusieurs."""
    t = TABLES[nom]
    ou, params = _ou(conn, t, cle, id_semestre, tuple(k for k in t.cle_nulle if k not in cle))
    lignes = _lire(conn, t, ou, params)
    designation = _designation(nom, cle) or nom
    if not lignes:
        raise ValueError(f"{t.article} {designation} est introuvable (lisez le référentiel pour la désigner)")
    if len(lignes) > 1:
        raise ValueError(f"plusieurs lignes correspondent à {t.article} {designation} : précisez "
                         + ", ".join(k for k in t.cle if k not in cle))
    return ou, params, lignes[0]


def existe(conn: psycopg.Connection, nom: str, v: dict, id_semestre: int) -> bool:
    """Une ligne identique (mêmes champs uniques) est-elle déjà dans le référentiel ?"""
    t = TABLES[nom]
    try:
        ou, params = _ou(conn, t, {k: v.get(k) for k in t.unique}, id_semestre)
    except PropositionRefusee:  # un code qui n'existe pas encore : la ligne non plus
        return False
    return bool(_lire(conn, t, ou, params))


# --- libellés ----------------------------------------------------------------------

def _designation(nom: str, v: dict) -> str:
    if nom == "semestre":
        return v.get("libelle") or ""
    if nom in ("absence", "sejour"):
        return f"de {v.get('matricule')}" + (f" du {_texte('', v['date_debut'])}" if v.get("date_debut") else "")
    if nom == "creneau":
        return f"du {str(v.get('jour', '')).lower()} {v.get('heure_debut')}–{v.get('heure_fin')}"
    if nom == "jour_ferie":
        return f"du {_texte('', v.get('date_ferie'))}"
    if nom == "conge":
        return f"« {v.get('libelle')} »" if v.get("libelle") else (f"du {_texte('', v['date_debut'])}" if v.get("date_debut") else "")
    t = TABLES[nom]
    return " ".join(str(v[k]) for k in t.cle if v.get(k) not in (None, ""))


def _periode(debut, fin) -> str:
    return f"le {_texte('', debut)}" if debut == fin else f"du {_texte('', debut)} au {_texte('', fin)}"


def libelle_ajout(nom: str, v: dict) -> str:
    """Ligne lisible, montrée au planificateur sur la carte de la proposition."""
    g = lambda k, d=None: v.get(k, d)  # noqa: E731
    if nom == "classe":
        return f"Classe {g('code_classe')} : {g('libelle')} ({g('niveau')}, filière {g('code_filiere')}, {g('effectif', 0)} étudiants)"
    if nom == "matiere":
        return f"Matière {g('code_matiere')} : {g('libelle')}"
    if nom == "enseignant":
        return f"Enseignant {g('matricule')} : {g('prenom')} {g('nom')} ({_texte('statut', g('statut', 'permanent'))})"
    if nom == "salle":
        return (f"Salle {g('code_salle')} : {g('nom_salle')}, {g('capacite')} places, {g('type_salle')}, {g('site')}"
                + (f", {g('batiment')}" if g("batiment") else ""))
    if nom == "programme":
        vol = ", ".join(f"{t.upper()} {g(f'volume_{t}'):g} h" for t in ("cm", "td", "tp") if g(f"volume_{t}"))
        return f"Programme de {g('code_classe')} : {g('code_matiere')} ({vol})"
    if nom == "cours":
        groupe = f" groupe {g('code_groupe')}" if g("code_groupe") else ""
        return (f"Cours {g('type_cours')} {g('code_matiere')} pour {g('code_classe')}{groupe} : {g('volume_horaire'):g} h, "
                f"séances de {g('duree_seance', 2):g} h, " + (f"enseignant {g('matricule')}" if g("matricule") else "enseignant à désigner"))
    if nom == "jour_ferie":
        return f"Jour férié le {_texte('', g('date_ferie'))} : {g('libelle')}"
    if nom == "conge":
        return (f"Congé « {g('libelle')} » {_periode(g('date_debut'), g('date_fin'))}"
                + (f" pour {g('code_classe')}" if g("code_classe") else " pour toutes les classes")
                + (f" ({g('type_conge')})" if g("type_conge") else ""))
    if nom == "creneau":
        return f"Créneau du {str(g('jour')).lower()} de {g('heure_debut')} à {g('heure_fin')}"
    if nom == "absence":
        return (f"Absence de {g('matricule')} {_periode(g('date_debut'), g('date_fin'))}"
                + (f" ({g('motif')})" if g("motif") else ""))
    if nom == "sejour":
        return (f"Séjour de {g('matricule')} {_periode(g('date_debut'), g('date_fin'))}"
                + (f" ({g('commentaire')})" if g("commentaire") else ""))
    return f"{nom} : " + ", ".join(f"{NOMS.get(k, k)} {_texte(k, x)}" for k, x in v.items())


def _libelle_modif(nom: str, cle: dict, avant: dict, valeurs: dict) -> str:
    t = TABLES[nom]
    sujet = f"{t.article[0].upper()}{t.article[1:]} {_designation(nom, {**avant, **cle})}".strip()
    return f"{sujet} : " + ", ".join(f"{NOMS.get(k, k)} {_texte(k, avant.get(k))} → {_texte(k, x)}" for k, x in valeurs.items())


def _libelle_suppression(nom: str, avant: dict) -> str:
    t = TABLES[nom]
    resume = ""
    if nom == "enseignant":
        resume = f" ({avant.get('prenom')} {avant.get('nom')})"
    elif t.resume and avant.get(t.resume):
        resume = f" ({avant[t.resume]})"
    if nom == "conge":
        resume = f" (du {_texte('', avant['date_debut'])} au {_texte('', avant['date_fin'])})"
    if nom in ("absence", "sejour"):
        resume = f" au {_texte('', avant['date_fin'])}"
    return f"Supprimer {t.article} {_designation(nom, avant)}{resume}"


# --- disponibilités (semaine type) -------------------------------------------------

def _preparer_dispo(conn: psycopg.Connection, action: str, v: dict) -> tuple[dict | None, str | None]:
    """Un niveau sur une plage d'un jour : un changement par créneau de la grille compris dans la plage."""
    inconnus = set(v) - {"matricule", "jour", "heure_debut", "heure_fin", "niveau", "motif"}
    if inconnus:
        raise ValueError(f"champs sans objet pour une disponibilité : {', '.join(sorted(inconnus))}")
    requis = ("matricule", "jour", "heure_debut", "heure_fin") + (("niveau",) if action != "supprimer" else ())
    manquants = [k for k in requis if v.get(k) in (None, "")]
    if manquants:
        raise ValueError(f"il manque {', '.join(manquants)}")
    jour = next((j for j in JOURS if j.lower() == str(v["jour"]).strip().lower()), None)
    if jour is None:
        raise ValueError(f"jour : « {v['jour']} » n'est pas un jour de cours ({', '.join(JOURS)})")
    debut, fin = _heure("heure_debut", v["heure_debut"]), _heure("heure_fin", v["heure_fin"])
    niveau = None
    if action != "supprimer":
        niveau = next((n for n in NIVEAUX_DISPO if n == str(v["niveau"]).strip().lower().replace("é", "e")), None)
        if niveau is None:
            raise ValueError(f"niveau : « {v['niveau']} » n'est pas une valeur possible ({', '.join(NIVEAUX_DISPO)})")
    motif = (str(v["motif"]).strip() or None) if v.get("motif") is not None else None
    id_ens = _id_ref(conn, "enseignant", v["matricule"], {})
    creneaux = conn.execute(
        "SELECT id_creneau, to_char(heure_debut, 'HH24:MI'), to_char(heure_fin, 'HH24:MI') FROM creneau "
        "WHERE jour = %s AND heure_debut >= %s AND heure_fin <= %s ORDER BY heure_debut", (jour, debut, fin)).fetchall()
    if not creneaux:
        raise ValueError(f"aucun créneau de la grille le {jour.lower()} entre {debut} et {fin}")
    actuels = dict(conn.execute("SELECT id_creneau, niveau FROM disponibilite WHERE id_enseignant = %s AND id_creneau = ANY(%s)",
                                (id_ens, [c[0] for c in creneaux])).fetchall())
    a_changer = [(c, actuels.get(c[0])) for c in creneaux if actuels.get(c[0]) != niveau]
    quoi = {None: "saisie retirée (disponible par défaut)", "preference": "préférence"}.get(niveau, niveau)
    libelle = (f"Disponibilité de {str(v['matricule']).upper()} le {jour.lower()} de {debut} à {fin} : {quoi}"
               + (f" ({motif})" if motif else ""))
    if not a_changer:
        return None, f"Déjà enregistré, laissé tel quel : {libelle}"
    return {"action": "disponibilite", "table": "disponibilite", "matricule": str(v["matricule"]), "jour": jour,
            "creneaux": [[c[1], c[2]] for c, _ in a_changer], "avant": [a for _, a in a_changer],
            "niveau": niveau, "motif": motif, "libelle": libelle}, None


def _executer_dispo(conn: psycopg.Connection, op: dict) -> str:
    id_ens = _id_ref(conn, "enseignant", op["matricule"], {})
    for (debut, fin), avant in zip(op["creneaux"], op["avant"]):
        row = conn.execute("SELECT id_creneau FROM creneau WHERE jour = %s AND heure_debut = %s AND heure_fin = %s",
                           (op["jour"], debut, fin)).fetchone()
        if row is None:
            raise PropositionRefusee(f"{op['libelle']} : le créneau de {debut} à {fin} n'existe plus")
        actuel = conn.execute("SELECT niveau FROM disponibilite WHERE id_enseignant = %s AND id_creneau = %s",
                              (id_ens, row[0])).fetchone()
        if (actuel[0] if actuel else None) != avant:
            raise PropositionRefusee(f"{op['libelle']} : la disponibilité a changé depuis la proposition")
        if op["niveau"] is None:
            conn.execute("DELETE FROM disponibilite WHERE id_enseignant = %s AND id_creneau = %s", (id_ens, row[0]))
        elif actuel:
            conn.execute("UPDATE disponibilite SET niveau = %s, motif = %s WHERE id_enseignant = %s AND id_creneau = %s",
                         (op["niveau"], op["motif"], id_ens, row[0]))
        else:
            conn.execute("INSERT INTO disponibilite (id_enseignant, id_creneau, niveau, motif) VALUES (%s, %s, %s, %s)",
                         (id_ens, row[0], op["niveau"], op["motif"]))
    if op["niveau"] is None:
        return "lignes_supprimees"
    return "lignes_ajoutees" if all(a is None for a in op["avant"]) else "lignes_modifiees"


# --- préparation et exécution ------------------------------------------------------

def _champs(t: Table, nom: str, brut: dict, quoi: str) -> dict:
    inconnus = [k for k in brut if k not in t.champs]
    if inconnus:
        raise ValueError(f"champs sans objet pour {quoi} : {', '.join(inconnus)} (possibles : {', '.join(t.champs)})")
    return {k: _normaliser(t, k, x) for k, x in brut.items()}


def preparer(conn: psycopg.Connection, id_semestre: int, changements: list[dict]) -> tuple[list[dict], list[str]]:
    """Contrôle les changements demandés ; renvoie (opérations, remarques). Lève ValueError avec
    tous les problèmes trouvés. Un changement sans « action » est un ajout (ancien format)."""
    erreurs, remarques, ajouts, autres = [], [], [], []
    for n, a in enumerate(changements, 1):
        action = a.get("action") or "ajouter"
        nom = a.get("table")
        quoi = f"changement {n} ({action} {nom})"
        cle = dict(a.get("cle") or {})
        valeurs = dict(a.get("valeurs") or {})
        try:
            if nom == "disponibilite":
                if action not in ("ajouter", "modifier", "supprimer"):
                    raise ValueError(f"action inconnue : {action}")
                op, remarque = _preparer_dispo(conn, action, {**cle, **valeurs})
                (autres.append(op) if op else remarques.append(remarque))
                continue
            if nom not in TABLES:
                raise ValueError(f"table inconnue (possibles : {', '.join(ORDRE)})")
            t = TABLES[nom]
            if action not in t.actions:
                raise ValueError(f"impossible de {action} {t.article} (possible : {' ou '.join(t.actions)})")
            if action == "ajouter":
                v = {k: x for k, x in _champs(t, nom, {**cle, **valeurs}, t.article).items() if x is not None}
                manquants = [k for k in t.requis if k not in v]
                if manquants:
                    raise ValueError(f"il manque {', '.join(manquants)}")
                if nom == "programme" and not any(v.get(f"volume_{x}") for x in ("cm", "td", "tp")):
                    raise ValueError("donnez au moins un volume (volume_cm, volume_td ou volume_tp)")
                if existe(conn, nom, v, id_semestre):
                    remarques.append(f"Déjà dans le référentiel, laissé tel quel : {libelle_ajout(nom, v)}")
                    continue
                ajouts.append({"action": "ajouter_ligne", "table": nom, "valeurs": v, "libelle": libelle_ajout(nom, v)})
                continue

            # modifier ou supprimer : la ligne se désigne par sa clé (prise dans valeurs si la clé est vide)
            if not cle and action == "modifier":
                cle = {k: valeurs.pop(k) for k in t.cle if k in valeurs}
            if not cle and action == "supprimer":
                cle = {k: x for k, x in valeurs.items() if k in t.cle}
            hors_cle = [k for k in cle if k not in t.cle]
            if hors_cle:
                raise ValueError(f"pour désigner {t.article}, utilisez {', '.join(t.cle)} (reçu {', '.join(hors_cle)})")
            cle = {k: x for k, x in _champs(t, nom, cle, t.article).items() if x is not None}
            if t.cle and not cle:
                raise ValueError(f"désignez {t.article} par {', '.join(t.cle)}")
            _, _, avant = _trouver(conn, nom, cle, id_semestre)
            if action == "supprimer":
                autres.append({"action": "supprimer_ligne", "table": nom, "cle": cle, "avant": avant,
                               "libelle": _libelle_suppression(nom, avant)})
                remarques += _consequences_suppression(conn, nom, cle, id_semestre)
                continue
            v = _champs(t, nom, valeurs, t.article)
            fixes = [k for k in v if k in t.fixes]
            if fixes:
                raise ValueError(f"{', '.join(fixes)} ne se modifie pas : supprimez la ligne puis ajoutez-en une autre")
            non_vidables = [k for k, x in v.items() if x is None and not t.champs[k].vidable]
            if non_vidables:
                raise ValueError(f"{', '.join(non_vidables)} ne peut pas être vide")
            if not v:
                raise ValueError("aucune valeur à changer")
            contexte = {**avant, **cle}
            v = {k: (_affichage_ref(conn, t.champs[k].ref, x, contexte) if t.champs[k].sorte == "ref" else x) for k, x in v.items()}
            changes = {k: x for k, x in v.items() if avant.get(k) != x}
            if not changes:
                remarques.append(f"Déjà à jour, laissé tel quel : {t.article} {_designation(nom, contexte)}")
                continue
            autres.append({"action": "modifier_ligne", "table": nom, "cle": cle, "avant": avant, "valeurs": changes,
                           "libelle": _libelle_modif(nom, cle, avant, changes)})
        except (ValueError, PropositionRefusee) as e:
            erreurs.append(f"{quoi} : {e}")
    if erreurs:
        raise ValueError(" ; ".join(erreurs))
    ajouts.sort(key=lambda o: ORDRE.index(o["table"]))
    return ajouts + autres, remarques


def _consequences_suppression(conn: psycopg.Connection, nom: str, cle: dict, id_semestre: int) -> list[str]:
    """Ce qu'une suppression emporte avec elle (cascades et « à désigner »)."""
    if nom == "enseignant":
        id_ens = _id_ref(conn, "enseignant", cle["matricule"], {})
        n_cours, n_seances = conn.execute(
            "SELECT (SELECT count(*) FROM cours WHERE id_enseignant = %(e)s), (SELECT count(*) FROM seance WHERE id_enseignant = %(e)s)",
            {"e": id_ens}).fetchone()
        if n_cours or n_seances:
            return [f"Supprimer {cle['matricule']} : ses {n_cours} cours et {n_seances} séance(s) passent à « enseignant à désigner » ; "
                    "ses disponibilités, absences et séjours sont supprimés."]
    if nom == "creneau":
        n = conn.execute("SELECT count(*) FROM disponibilite d JOIN creneau c USING (id_creneau) WHERE c.jour = %s "
                         "AND c.heure_debut = %s AND c.heure_fin = %s", (cle["jour"], cle["heure_debut"], cle["heure_fin"])).fetchone()[0]
        if n:
            return [f"Supprimer le créneau {_designation(nom, cle)} retire aussi {n} disponibilité(s) d'enseignants saisies dessus."]
    if nom == "classe":
        return [f"Supprimer {cle['code_classe']} retire aussi ses groupes, son programme et ses congés propres "
                "(refusé par la base si elle a encore des cours)."]
    return []


TABLES_FR = {"seance": "des séances", "cours": "des cours", "programme": "le programme", "classe": "des classes",
             "salle": "des salles", "filiere": "des filières", "conge": "des congés", "groupe": "des groupes",
             "disponibilite": "des disponibilités", "enseignant": "des enseignants"}


def _motif(op: dict, e: psycopg.Error) -> str:
    message = e.diag.message_primary or str(e)
    if isinstance(e, psycopg.errors.ForeignKeyViolation) and op["action"] == "supprimer_ligne":
        m = re.search(r'on table "(\w+)"\s*$', message)
        utilise = TABLES_FR.get(m[1], f"la table {m[1]}") if m else "d'autres lignes"
        return f"Refusée par la base ({op['libelle']}) : encore utilisée par {utilise} ; retirez-les d'abord"
    if isinstance(e, psycopg.errors.UniqueViolation):
        return f"Refusée par la base ({op['libelle']}) : une autre ligne a déjà ce code ou ces valeurs"
    return f"Refusée par la base ({op['libelle']}) : {message}"


def _appliquer(conn: psycopg.Connection, op: dict, id_semestre: int) -> str:
    """Une opération ; renvoie le compteur à incrémenter."""
    if op["action"] == "disponibilite":
        return _executer_dispo(conn, op)
    nom = op["table"]
    t = TABLES[nom]
    if op["action"] == "ajouter_ligne":
        v = {**t.defauts, **op["valeurs"]}
        cols = _colonnes(conn, t, v, v)
        if t.semestre:
            cols["id_semestre"] = id_semestre
        conn.execute(sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
            sql.Identifier(t.sql), sql.SQL(", ").join(map(sql.Identifier, cols)),
            sql.SQL(", ").join(sql.Placeholder() * len(cols))), list(cols.values()))
        return "lignes_ajoutees"
    try:
        ou, params, actuelle = _trouver(conn, nom, op["cle"], id_semestre)
    except ValueError as e:
        raise PropositionRefusee(f"{op['libelle']} : {e}") from e
    if op["action"] == "supprimer_ligne":
        conn.execute(sql.SQL("DELETE FROM {} WHERE {}").format(sql.Identifier(t.sql), ou), params)
        return "lignes_supprimees"
    if any(actuelle.get(k) != op["avant"].get(k) for k in op["valeurs"]):
        raise PropositionRefusee(f"{op['libelle']} : la ligne a changé depuis la proposition")
    cols = _colonnes(conn, t, op["valeurs"], {**actuelle, **op["cle"], **op["valeurs"]})
    affect = [sql.SQL("{} = {}").format(sql.Identifier(c), sql.Placeholder(f"s{i}")) for i, c in enumerate(cols)]
    conn.execute(sql.SQL("UPDATE {} SET {} WHERE {}").format(sql.Identifier(t.sql), sql.SQL(", ").join(affect), ou),
                 {**params, **{f"s{i}": x for i, x in enumerate(cols.values())}})
    return "lignes_modifiees"


ERREURS_BASE = (psycopg.errors.IntegrityError, psycopg.errors.RaiseException, psycopg.errors.DataError)


def executer(conn: psycopg.Connection, ops: list[dict], id_edt: int) -> dict:
    """Applique les opérations (dans la transaction de l'appelant) : ajouts dans l'ordre des
    dépendances, puis modifications et suppressions. Un ajout apparu entre-temps est laissé tel
    quel. Une modification refusée par la base est retentée après les autres (baisser le volume
    d'un cours avant celui de son programme...). Lève PropositionRefusee avec le motif."""
    id_semestre = conn.execute("SELECT id_semestre FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()[0]
    compte = {"lignes_ajoutees": 0, "lignes_modifiees": 0, "lignes_supprimees": 0, "lignes_deja_presentes": 0}
    rang = lambda o: ORDRE.index(o["table"])  # noqa: E731
    for op in sorted((o for o in ops if o["action"] == "ajouter_ligne"), key=rang):
        if existe(conn, op["table"], op["valeurs"], id_semestre):
            compte["lignes_deja_presentes"] += 1
            continue
        try:
            with conn.transaction():
                compte[_appliquer(conn, op, id_semestre)] += 1
        except ERREURS_BASE as e:
            raise PropositionRefusee(_motif(op, e)) from e

    restantes = sorted((o for o in ops if o["action"] != "ajouter_ligne"),
                       key=lambda o: (o["action"] == "supprimer_ligne", -rang(o) if o["action"] == "supprimer_ligne" else rang(o)))
    while restantes:
        echecs = []
        for op in restantes:
            try:
                with conn.transaction():
                    compte[_appliquer(conn, op, id_semestre)] += 1
            except ERREURS_BASE as e:
                echecs.append((op, e))
        if len(echecs) == len(restantes):
            op, e = echecs[0]
            raise PropositionRefusee(_motif(op, e)) from e
        restantes = [op for op, _ in echecs]
    return compte


# --- séances que les changements rendraient invalides ---------------------------------

_CONFLITS = """
WITH s AS (
    SELECT s.id_seance, s.id_edt, s.date_seance, s.heure_debut, s.heure_fin, s.id_cours, s.id_enseignant, s.id_creneau,
           s.nature, s.id_salle, co.id_classe, co.id_type_salle AS type_exige, sa.est_disponible, sa.capacite, sa.id_site AS site_salle,
           sa.id_type_salle AS type_salle, se.date_debut AS sem_debut, se.date_fin AS sem_fin,
           format('%%s · %%s %%s, %%s %%s–%%s, salle %%s (v%%s)', cl.code_classe, m.libelle, co.type_cours,
                  to_char(s.date_seance, 'DD/MM/YYYY'), to_char(s.heure_debut, 'HH24:MI'), to_char(s.heure_fin, 'HH24:MI'),
                  sa.code_salle, e.version) AS libelle
    FROM seance s
    JOIN emploi_du_temps e ON e.id_edt = s.id_edt
    JOIN semestre se ON se.id_semestre = e.id_semestre
    JOIN cours co ON co.id_cours = s.id_cours
    JOIN classe cl ON cl.id_classe = co.id_classe
    JOIN matiere m ON m.id_matiere = co.id_matiere
    JOIN salle sa ON sa.id_salle = s.id_salle
    WHERE e.id_semestre = (SELECT id_semestre FROM emploi_du_temps WHERE id_edt = %(edt)s)
      AND e.statut <> 'archive' AND s.statut <> 'annulee'
), h AS (
    SELECT s.id_cours, s.id_edt, date_trunc('week', s.date_seance::timestamp)::date AS semaine,
           sum(EXTRACT(EPOCH FROM s.heure_fin - s.heure_debut)) / 3600 AS heures
    FROM s WHERE s.nature = 'cours' GROUP BY 1, 2, 3
), cours_lib AS (
    SELECT co.id_cours, co.volume_horaire, co.heures_semaine_max,
           format('%%s · %%s %%s', cl.code_classe, m.libelle, co.type_cours) AS libelle
    FROM cours co JOIN classe cl ON cl.id_classe = co.id_classe JOIN matiere m ON m.id_matiere = co.id_matiere
)
SELECT 'CD-09 : hors des dates du semestre', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE s.date_seance NOT BETWEEN s.sem_debut AND s.sem_fin
UNION ALL
SELECT 'CD-09 : jour férié', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE EXISTS (SELECT 1 FROM jour_ferie f WHERE f.date_ferie = s.date_seance)
UNION ALL
SELECT 'CD-09 : pendant un congé', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE EXISTS (SELECT 1 FROM conge g WHERE s.date_seance BETWEEN g.date_debut AND g.date_fin
                                      AND (g.id_classe IS NULL OR g.id_classe = s.id_classe)
                                      AND NOT (s.nature <> 'cours' AND g.type_conge = 'examens'))
UNION ALL
SELECT 'CD-10 : hors de la grille horaire', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE NOT EXISTS (SELECT 1 FROM creneau c JOIN creneau d ON d.jour = c.jour
                  WHERE c.id_creneau = s.id_creneau AND d.heure_fin = s.heure_fin)
UNION ALL
SELECT 'CD-12 : salle marquée indisponible', s.id_seance::text, s.libelle, s.date_seance FROM s WHERE NOT s.est_disponible
UNION ALL
SELECT 'CD-04 : salle trop petite', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE s.capacite < (SELECT coalesce(sum(coalesce(g.effectif, cl.effectif)), 0)
                    FROM publics_seance(s.id_cours, s.nature) p JOIN classe cl ON cl.id_classe = p.id_classe
                    LEFT JOIN groupe g ON g.id_groupe = p.id_groupe)
                   + (SELECT coalesce(sum(cl.effectif), 0)   -- épreuves qui partagent la salle
                      FROM seance o CROSS JOIN LATERAL publics_seance(o.id_cours, o.nature) p JOIN classe cl ON cl.id_classe = p.id_classe
                      WHERE s.nature <> 'cours' AND o.nature <> 'cours' AND o.id_edt = s.id_edt AND o.id_salle = s.id_salle
                        AND o.statut <> 'annulee' AND o.id_seance <> s.id_seance
                        AND o.plage && tsrange(s.date_seance + s.heure_debut, s.date_seance + s.heure_fin))
UNION ALL
SELECT 'CD-05 : type de salle non accepté', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE s.nature = 'cours' AND (s.type_exige IS NOT NULL OR EXISTS (SELECT 1 FROM cours_type_salle t WHERE t.id_cours = s.id_cours))
  AND s.type_salle IS DISTINCT FROM s.type_exige
  AND NOT EXISTS (SELECT 1 FROM cours_type_salle t WHERE t.id_cours = s.id_cours AND t.id_type_salle = s.type_salle)
UNION ALL
SELECT 'SITE : salle hors du site de la promotion', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE s.nature = 'cours' AND EXISTS (SELECT 1 FROM publics_du_cours(s.id_cours) p JOIN classe cl ON cl.id_classe = p.id_classe
              WHERE cl.id_site IS NOT NULL AND cl.id_site <> s.site_salle)
UNION ALL
SELECT 'CD-06 : enseignant absent', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE EXISTS (SELECT 1 FROM absence_enseignant a WHERE a.id_enseignant = s.id_enseignant
                                                   AND s.date_seance BETWEEN a.date_debut AND a.date_fin)
UNION ALL
SELECT 'CD-06 : intervenant externe hors de ses séjours', s.id_seance::text, s.libelle, s.date_seance FROM s
JOIN enseignant en ON en.id_enseignant = s.id_enseignant
WHERE en.statut = 'externe'
  AND NOT EXISTS (SELECT 1 FROM sejour_enseignant j WHERE j.id_enseignant = s.id_enseignant
                                                      AND s.date_seance BETWEEN j.date_debut AND j.date_fin)
UNION ALL
SELECT 'CD-06 : enseignant indisponible sur le créneau', s.id_seance::text, s.libelle, s.date_seance FROM s
WHERE EXISTS (SELECT 1 FROM disponibilite d JOIN creneau c ON c.id_creneau = d.id_creneau
              JOIN creneau sc ON sc.id_creneau = s.id_creneau
              WHERE d.id_enseignant = s.id_enseignant AND d.niveau = 'indisponible' AND c.jour = sc.jour
                AND c.heure_debut < s.heure_fin AND c.heure_fin > s.heure_debut)
UNION ALL
SELECT 'CD-08 : volume du cours dépassé', 'c' || x.id_cours || '-' || x.id_edt,
       format('%%s : %%s h planifiées pour %%s h prévues (v%%s)', c.libelle, trim_scale(round(x.heures, 1)),
              trim_scale(c.volume_horaire), e.version), NULL::date
FROM (SELECT id_cours, id_edt, sum(heures) AS heures FROM h GROUP BY 1, 2) x
JOIN cours_lib c ON c.id_cours = x.id_cours JOIN emploi_du_temps e ON e.id_edt = x.id_edt
WHERE x.heures > c.volume_horaire
UNION ALL
SELECT 'CD-14 : rythme hebdomadaire dépassé', 'c' || h.id_cours || '-' || h.id_edt || '-' || h.semaine,
       format('%%s : %%s h la semaine du %%s pour %%s h au plus (v%%s)', c.libelle, trim_scale(round(h.heures, 1)),
              to_char(h.semaine, 'DD/MM/YYYY'), trim_scale(c.heures_semaine_max), e.version), h.semaine
FROM h JOIN cours_lib c ON c.id_cours = h.id_cours JOIN emploi_du_temps e ON e.id_edt = h.id_edt
WHERE h.heures > c.heures_semaine_max
"""


def conflits(conn: psycopg.Connection, id_edt: int) -> dict[tuple[str, str], tuple[str, date | None]]:
    """Séances (et cours) des versions en cours du semestre qui ne respectent pas les règles que
    le référentiel peut changer : {(règle, identifiant): (libellé, date)}."""
    return {(r[0], r[1]): (r[2], r[3]) for r in conn.execute(_CONFLITS, {"edt": id_edt}).fetchall()}


def nouveaux_conflits(avant: dict, apres: dict) -> list[dict]:
    """Ce que les changements ajoutent, regroupé par règle : [{regle, nombre, exemples}]."""
    groupes: dict[str, list[tuple]] = {}
    for k, (libelle, quand) in apres.items():
        if k not in avant:
            groupes.setdefault(k[0], []).append((quand or date.min, libelle))
    sortie = []
    for regle, lignes in sorted(groupes.items()):
        dates = [q for q, _ in lignes if q != date.min]
        sortie.append({"regle": regle, "nombre": len(lignes), "exemples": [x for _, x in sorted(lignes)[:6]],
                       "du": min(dates).isoformat() if dates else None, "au": max(dates).isoformat() if dates else None})
    return sortie
