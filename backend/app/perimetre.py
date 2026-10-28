"""Périmètre d'une génération : des classes ou des filières, réduites au besoin à certaines
matières (« les modules Big Data et Computer Vision de la L3IA »).

Les matières se désignent par leur code ou leur nom, sans tenir compte des majuscules ni des
accents. Le solveur ne programme que des cours existants : quand un module n'est pas prêt
(matière inconnue, absente du programme de la classe, ou sans cours), on explique quoi créer
dans le référentiel au lieu de répondre « rien à placer ».
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

import psycopg

from ultraplanning_solver import Perimetre


@dataclass
class Selection:
    perimetre: Perimetre
    avertissements: list[str] = field(default_factory=list)  # modules non prêts, en clair
    vide: bool = False  # aucun cours à programmer


def normaliser(s: str) -> str:
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _ids(conn: psycopg.Connection, table: str, colonne: str, codes: list[str]) -> dict[int, str]:
    if not codes:
        return {}
    rows = conn.execute(f"SELECT id_{table}, {colonne} FROM {table} WHERE upper({colonne}) = ANY(%s)",
                        ([c.strip().upper() for c in codes],)).fetchall()
    inconnus = {c.strip().upper() for c in codes} - {r[1].upper() for r in rows}
    if inconnus:
        raise ValueError(f"Codes inconnus ({table}) : {', '.join(sorted(inconnus))}")
    return dict(rows)


def resoudre(conn: psycopg.Connection, id_edt: int, classes: list[str] | None, filieres: list[str] | None,
             matieres: list[str] | None) -> Selection:
    """Lève ValueError pour un code de classe ou de filière inconnu."""
    id_classes = _ids(conn, "classe", "code_classe", classes or [])
    id_filieres = _ids(conn, "filiere", "code_filiere", filieres or [])
    if not matieres:
        return Selection(Perimetre(frozenset(id_filieres), frozenset(id_classes)))

    id_semestre = conn.execute("SELECT id_semestre FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()[0]
    visees = conn.execute(
        "SELECT id_classe, code_classe FROM classe WHERE (id_classe = ANY(%s) OR id_filiere = ANY(%s)) "
        "AND (%s OR %s) ORDER BY code_classe",
        (list(id_classes), list(id_filieres), bool(id_classes), bool(id_filieres)),
    ).fetchall()
    noms_classes = ", ".join(c for _, c in visees) or "ces classes"
    toutes = conn.execute("SELECT id_matiere, code_matiere, libelle FROM matiere ORDER BY libelle").fetchall()
    au_programme = conn.execute(
        "SELECT DISTINCT m.id_matiere, m.code_matiere, m.libelle FROM programme p JOIN matiere m USING (id_matiere) "
        "WHERE p.id_classe = ANY(%s) AND p.id_semestre = %s ORDER BY m.libelle",
        ([c for c, _ in visees], id_semestre),
    ).fetchall()

    avertissements: list[str] = []
    retenues = []
    for demandee in matieres:
        n = normaliser(demandee)
        exactes = [m for m in toutes if n in (normaliser(m[1]), normaliser(m[2]))]
        partielles = [m for m in toutes if n and (n in normaliser(m[2]) or n in normaliser(m[1]))]
        trouvees = exactes or (partielles if len(partielles) == 1 else [])
        if not trouvees:
            liste = ", ".join(f"{m[2]} ({m[1]})" for m in au_programme) or "aucune"
            ambigu = f" Plusieurs correspondent : {', '.join(m[2] for m in partielles)}." if len(partielles) > 1 else ""
            avertissements.append(
                f"Matière « {demandee} » introuvable dans le référentiel.{ambigu} Matières au programme de "
                f"{noms_classes} : {liste}. Il faut créer la matière, l'ajouter au programme de la classe, "
                "puis créer ses cours (Référentiel, ou ajouts proposés par l'assistant).")
            continue
        retenues.append(trouvees[0])

    id_cours: set[int] = set()
    programme = {(r[0], r[1]) for r in conn.execute(
        "SELECT id_classe, id_matiere FROM programme WHERE id_classe = ANY(%s) AND id_semestre = %s",
        ([c for c, _ in visees], id_semestre)).fetchall()}
    for id_matiere, code, libelle in retenues:
        for id_classe, code_classe in visees:
            cours = [r[0] for r in conn.execute(
                "SELECT id_cours FROM cours WHERE id_classe = %s AND id_matiere = %s AND id_semestre = %s",
                (id_classe, id_matiere, id_semestre)).fetchall()]
            if cours:
                id_cours.update(cours)
            elif (id_classe, id_matiere) not in programme:
                avertissements.append(
                    f"{libelle} ({code}) n'est pas au programme de {code_classe} pour ce semestre (CD-07) : "
                    "il faut l'ajouter au programme (volumes CM, TD, TP), puis créer ses cours.")
            else:
                avertissements.append(
                    f"{libelle} ({code}) est au programme de {code_classe} mais n'a encore aucun cours : "
                    "il faut créer ses cours (type CM, TD ou TP, volume, enseignant).")
    return Selection(Perimetre(id_cours=frozenset(id_cours)), avertissements, vide=not id_cours)
