"""Historique de la version à jour : chaque changement enregistré est une version, lue dans le
journal des séances (fonctions versions_edt et seances_version de la base).

Seules les 10 dernières versions sont gardées dans l'historique (VERSIONS_GARDEES) : on les liste, on en
affiche les séances et on peut les restaurer. Le journal des séances, lui, garde tout (audit). La restauration remplace la version à jour et s'ajoute à l'historique : rien n'est
effacé. Les invités n'en voient rien avant une publication. Le référentiel, lui, n'est pas
restauré : une séance dont le cours, la salle ou le créneau n'existe plus, ou que les règles
refusent aujourd'hui (jour férié, enseignant absent...), ne revient pas, et le motif est donné.
"""

from __future__ import annotations

from datetime import date, datetime

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from .auth import Utilisateur, utilisateur_courant
from .db import connexion, origine
from .publication import JOURS, MOIS

routeur = APIRouter()

VERSIONS_GARDEES = 10  # versions de la version à jour proposées dans l'historique, les plus récentes

ORIGINES = {"console": "Modification manuelle", "generation": "Génération", "assistant": "Assistant IA",
            "restauration": "Restauration", "systeme": "Script ou import"}
CHAMPS = ("date_seance", "heure_debut", "heure_fin", "statut", "est_verrouillee", "id_cours", "id_enseignant",
          "id_salle", "id_creneau", "nature")
NATURES = {"examen": "Examen", "rattrapage": "Rattrapage"}
_REFUS = (psycopg.errors.IntegrityError, psycopg.errors.RaiseException, psycopg.errors.DataError)


class _Annuler(Exception):
    """Aperçu : tout est fait dans la base, puis annulé."""


def _edt_existe(conn: psycopg.Connection, id_edt: int) -> str:
    row = conn.execute("SELECT statut FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise HTTPException(404, "Emploi du temps introuvable")
    return row[0]


def _date_version(conn: psycopg.Connection, id_edt: int, numero: int) -> datetime:
    row = conn.execute("SELECT date_version, (SELECT count(*) FROM versions_edt(%s)) FROM versions_edt(%s) WHERE numero = %s",
                       (id_edt, id_edt, numero)).fetchone()
    if row is None:
        raise HTTPException(404, "Version introuvable")
    if numero <= row[1] - VERSIONS_GARDEES:
        raise HTTPException(410, f"Version trop ancienne : l'historique ne garde que les {VERSIONS_GARDEES} dernières versions")
    return row[0]


def _quand(s: dict) -> str:
    d = date.fromisoformat(s["date_seance"])
    return f"{JOURS[d.weekday()]} {d.day} {MOIS[d.month - 1]} {s['heure_debut'][:5]}–{s['heure_fin'][:5]}"


def _noms_cours(conn: psycopg.Connection, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    return dict(conn.execute(
        """SELECT c.id_cours, m.libelle || ' ' || c.type_cours || ' · ' || cl.code_classe || coalesce(' · ' || g.code_groupe, '')
           FROM cours c JOIN matiere m USING (id_matiere, id_ecole) JOIN classe cl ON cl.id_classe = c.id_classe
           LEFT JOIN groupe g ON g.id_groupe = c.id_groupe WHERE c.id_cours = ANY(%s)""", (list(ids),)).fetchall())


def _titre(detail: dict | None, note: str | None, origine_: str, noms: dict[int, str]) -> str:
    """Une ligne lisible : la séance touchée si elle est seule, sinon le motif ou l'origine."""
    if note:
        return note
    if not detail:
        return ORIGINES.get(origine_, origine_)
    a, b = detail["avant"], detail["apres"]
    nom = noms.get((b or a)["id_cours"], "Séance d'un cours supprimé")
    nature = NATURES.get((b or a).get("nature"))
    if nature:
        nom = f"{nature} · {nom}"
    if a is None:
        return f"Ajout : {nom}, {_quand(b)}"
    if b is None:
        return f"Suppression : {nom}, {_quand(a)}"
    if a["statut"] != "annulee" and b["statut"] == "annulee":
        return f"Annulation : {nom}, {_quand(a)}"
    if a["statut"] == "annulee" and b["statut"] != "annulee":
        return f"Rétablissement : {nom}, {_quand(b)}"
    if any(a[k] != b[k] for k in ("date_seance", "heure_debut", "heure_fin")):
        return f"Déplacement : {nom}, {_quand(a)} → {_quand(b)}"
    if a["id_salle"] != b["id_salle"]:
        return f"Changement de salle : {nom}, {_quand(b)}"
    if a.get("id_enseignant") != b.get("id_enseignant"):
        return f"Changement d'enseignant : {nom}, {_quand(b)}"
    if a["est_verrouillee"] != b["est_verrouillee"]:
        return f"{'Verrouillage' if b['est_verrouillee'] else 'Déverrouillage'} : {nom}, {_quand(b)}"
    return f"Modification : {nom}, {_quand(b)}"


@routeur.get("/api/emplois-du-temps/{id_edt}/versions")
def lister_versions(id_edt: int, limite: int = Query(200, ge=1, le=500), avant: int | None = None,
                    conn: psycopg.Connection = Depends(connexion), _: Utilisateur = Depends(utilisateur_courant)) -> dict:
    """Les 10 dernières versions (VERSIONS_GARDEES), de la plus récente à la plus ancienne ; `avant` : suite de
    la liste, parmi elles. `total` : toutes les versions enregistrées depuis le début."""
    _edt_existe(conn, id_edt)
    total = conn.execute("SELECT count(*) FROM versions_edt(%s)", (id_edt,)).fetchone()[0]
    rows = conn.execute(
        "SELECT numero, date_version, origine, id_utilisateur, note, ajoutees, retirees, modifiees, detail "
        "FROM versions_edt(%s) WHERE numero < %s AND numero > %s ORDER BY numero DESC LIMIT %s",
        (id_edt, avant if avant is not None else total + 1, total - VERSIONS_GARDEES, limite),
    ).fetchall()
    noms = _noms_cours(conn, {(r[8]["apres"] or r[8]["avant"])["id_cours"] for r in rows if r[8]})
    auteurs = dict(conn.execute("SELECT id_utilisateur, login FROM utilisateur").fetchall())
    publications = conn.execute(
        "SELECT date_version, max(date_publication) FROM publication_edt WHERE id_edt = %s GROUP BY date_version", (id_edt,)
    ).fetchall()
    publiees = dict(publications)
    en_ligne = conn.execute(
        "SELECT date_version FROM publication_edt p JOIN emploi_du_temps e ON e.id_semestre = "
        "(SELECT id_semestre FROM emploi_du_temps WHERE id_edt = p.id_edt) AND e.statut = 'publie' "
        "WHERE p.id_edt = %s ORDER BY p.date_publication DESC LIMIT 1", (id_edt,),
    ).fetchone()
    return {
        "total": total,
        "gardees": VERSIONS_GARDEES,
        "versions": [{
            "numero": r[0], "date": r[1], "origine": r[2], "origine_libelle": ORIGINES.get(r[2], r[2]),
            "auteur": auteurs.get(r[3]), "titre": _titre(r[8], r[4], r[2], noms),
            "ajoutees": r[5], "retirees": r[6], "modifiees": r[7],
            "publiee_le": publiees.get(r[1]), "en_ligne": en_ligne is not None and en_ligne[0] == r[1],
        } for r in rows],
    }


def _normaliser(j: dict, enseignant_du_cours: dict[int, int | None]) -> dict:
    """Une séance du journal, dans la forme de la base. Les lignes d'avant le schéma 10 n'ont
    pas d'enseignant : c'était alors celui du cours."""
    s = {k: j.get(k) for k in CHAMPS}
    s["id_seance"] = j["id_seance"]
    s["heure_debut"], s["heure_fin"] = j["heure_debut"][:5], j["heure_fin"][:5]
    s["nature"] = j.get("nature", "cours")  # lignes d'avant le schéma 13
    if "id_enseignant" not in j:
        s["id_enseignant"] = enseignant_du_cours.get(j["id_cours"])
    return s


def _etat(conn: psycopg.Connection, id_edt: int, quand: datetime) -> dict[int, dict]:
    lignes = [r[0] for r in conn.execute("SELECT * FROM seances_version(%s, %s)", (id_edt, quand)).fetchall()]
    enseignants = dict(conn.execute("SELECT id_cours, id_enseignant FROM cours").fetchall())
    return {j["id_seance"]: _normaliser(j, enseignants) for j in lignes}


def _existants(conn: psycopg.Connection) -> dict[str, set[int]]:
    return {t: {r[0] for r in conn.execute(f"SELECT id_{t} FROM {t}").fetchall()}  # noqa: S608 (noms constants)
            for t in ("cours", "salle", "creneau", "enseignant")}


def _reference_perdue(s: dict, existe: dict[str, set[int]]) -> str | None:
    if s["id_cours"] not in existe["cours"]:
        return "son cours n'existe plus"
    if s["id_salle"] not in existe["salle"]:
        return "sa salle n'existe plus"
    if s["id_creneau"] not in existe["creneau"]:
        return "son créneau n'existe plus"
    return None


@routeur.get("/api/emplois-du-temps/{id_edt}/versions/{numero}")
def seances_de_la_version(id_edt: int, numero: int, conn: psycopg.Connection = Depends(connexion),
                          _: Utilisateur = Depends(utilisateur_courant)) -> dict:
    """Séances de cette version, pour les afficher ; celles dont le cours, la salle ou le créneau
    n'existe plus ne s'affichent pas et sont comptées."""
    _edt_existe(conn, id_edt)
    quand = _date_version(conn, id_edt, numero)
    existe = _existants(conn)
    seances, perdues = [], 0
    for s in _etat(conn, id_edt, quand).values():
        if _reference_perdue(s, existe):
            perdues += 1
            continue
        if s["id_enseignant"] not in existe["enseignant"]:
            s["id_enseignant"] = None
        seances.append({**s, "id_edt": id_edt})
    return {"numero": numero, "date": quand, "seances": seances, "hors_referentiel": perdues}


def _actuelles(conn: psycopg.Connection, id_edt: int) -> dict[int, dict]:
    rows = conn.execute(
        "SELECT id_seance, date_seance, to_char(heure_debut, 'HH24:MI'), to_char(heure_fin, 'HH24:MI'), statut, "
        "est_verrouillee, id_cours, id_enseignant, id_salle, id_creneau, nature FROM seance WHERE id_edt = %s", (id_edt,),
    ).fetchall()
    return {r[0]: {"id_seance": r[0], "date_seance": r[1].isoformat(), "heure_debut": r[2], "heure_fin": r[3], "statut": r[4],
                   "est_verrouillee": r[5], "id_cours": r[6], "id_enseignant": r[7], "id_salle": r[8], "id_creneau": r[9],
                   "nature": r[10]}
            for r in rows}


_INSERER = """
    INSERT INTO seance (id_seance, date_seance, heure_debut, heure_fin, statut, est_verrouillee, id_cours, id_enseignant,
                        id_salle, id_creneau, nature, id_edt) OVERRIDING SYSTEM VALUE
    SELECT r.id_seance, r.date_seance, r.heure_debut, r.heure_fin, r.statut, r.est_verrouillee, r.id_cours, r.id_enseignant,
           r.id_salle, r.id_creneau, r.nature, %s
    FROM jsonb_to_recordset(%s) AS r(id_seance BIGINT, date_seance DATE, heure_debut TIME, heure_fin TIME, statut TEXT,
         est_verrouillee BOOLEAN, id_cours BIGINT, id_enseignant BIGINT, id_salle BIGINT, id_creneau BIGINT, nature TEXT)
    ORDER BY r.date_seance, r.heure_debut
"""


def _motif(e: psycopg.Error) -> str:
    if isinstance(e, psycopg.errors.ExclusionViolation):
        return "CD-01 : la salle est déjà occupée sur cette plage horaire"
    return e.diag.message_primary or str(e)


def _inserer(conn: psycopg.Connection, id_edt: int, seances: list[dict]) -> None:
    conn.execute(_INSERER, (id_edt, Jsonb(seances)))


def _restaurer(conn: psycopg.Connection, id_edt: int, numero: int, quand: datetime) -> dict:
    """Met la version à jour dans l'état de cette version (dans la transaction de l'appelant).
    Les séances à changer sont retirées d'abord, pour ne pas se gêner entre elles, puis remises :
    toutes d'un coup, et une par une seulement si la base en refuse."""
    cible, actuelles = _etat(conn, id_edt, quand), _actuelles(conn, id_edt)
    existe = _existants(conn)
    noms = _noms_cours(conn, {s["id_cours"] for s in cible.values()})
    refusees: list[dict] = []

    def refuser(s: dict, motif: str) -> None:
        nom = noms.get(s["id_cours"], "Séance d'un cours supprimé")
        refusees.append({"seance": f"{nom}, {_quand(s)}", "motif": motif})

    a_remettre, a_changer = [], []
    for i, s in cible.items():
        present = actuelles.get(i)
        if present is not None and all(present[k] == s[k] for k in CHAMPS):
            continue
        motif = _reference_perdue(s, existe)
        if motif:
            refuser(s, motif)
            continue
        if s["id_enseignant"] not in existe["enseignant"]:
            s["id_enseignant"] = None
        (a_remettre if present is None else a_changer).append(s)
    a_retirer = [i for i in actuelles if i not in cible]
    changees = {s["id_seance"] for s in a_changer}
    inchangees = len(actuelles) - len(a_retirer) - len(changees)

    origine(conn, "restauration")
    conn.execute("SELECT set_config('app.note', %s, true)", (f"Restauration de la version {numero}",))
    conn.execute("DELETE FROM seance WHERE id_seance = ANY(%s)", (a_retirer + list(changees),))
    a_inserer = sorted(a_remettre + a_changer, key=lambda s: (s["date_seance"], s["heure_debut"], s["id_seance"]))
    ajoutees, modifiees = len(a_remettre), len(a_changer)
    try:
        with conn.transaction():
            _inserer(conn, id_edt, a_inserer)
    except _REFUS:
        ajoutees, modifiees = 0, 0
        gardees = []
        for s in a_inserer:
            try:
                with conn.transaction():
                    _inserer(conn, id_edt, [s])
                if s["id_seance"] in changees:
                    modifiees += 1
                else:
                    ajoutees += 1
            except _REFUS as e:
                refuser(s, _motif(e))
                if s["id_seance"] in changees:
                    gardees.append(actuelles[s["id_seance"]])
        for s in gardees:  # séance qui ne peut pas revenir à cet état : elle reste comme elle était, si la place est libre
            try:
                with conn.transaction():
                    _inserer(conn, id_edt, [s])
                inchangees += 1
            except _REFUS as e:
                refuser(s, f"retirée de la version à jour, sa place est prise : {_motif(e)}")
    return {"numero": numero, "date": quand, "ajoutees": ajoutees, "retirees": len(a_retirer), "modifiees": modifiees,
            "inchangees": inchangees, "refusees": len(refusees), "exemples": refusees[:20]}


class Restauration(BaseModel):
    # Faux : aperçu, rien n'est écrit
    appliquer: bool = False


@routeur.post("/api/emplois-du-temps/{id_edt}/versions/{numero}/restaurer")
def restaurer(id_edt: int, numero: int, r: Restauration, conn: psycopg.Connection = Depends(connexion),
              _: Utilisateur = Depends(utilisateur_courant)) -> dict:
    if _edt_existe(conn, id_edt) in ("publie", "archive"):
        raise HTTPException(409, "Seule la version à jour se restaure")
    quand = _date_version(conn, id_edt, numero)
    resultat: dict = {}
    try:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (id_edt,))
            resultat = _restaurer(conn, id_edt, numero, quand)
            if not r.appliquer:
                raise _Annuler
    except _Annuler:
        pass
    origine(conn, "console")
    return resultat | {"appliquee": r.appliquer}
