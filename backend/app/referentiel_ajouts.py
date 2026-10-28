"""Ajouts au référentiel proposés par l'assistant IA (PROPOSITION de nature « referentiel »).

Quand un module n'est pas prêt (matière inconnue, hors programme, sans cours), l'assistant
demande les informations manquantes ou les lit dans un fichier joint, puis propose les lignes
à ajouter : classes, matières, enseignants, salles, habilitations, programme, cours. Rien n'est
écrit avant la validation d'un planificateur ; ensuite, la génération demandée (PROPOSITION.suite)
est lancée.

Uniquement des ajouts : une ligne qui existe déjà (même code, ou même clé) est laissée telle
quelle. Les lignes se désignent par leurs codes (classe, matière, matricule...), jamais par des
identifiants : une ligne ajoutée dans la même proposition peut donc servir aux suivantes. Les
insertions passent par les déclencheurs de la base (CD-06 habilitation, CD-07 programme).

Opération : {"action": "ajouter_ligne", "table": ..., "valeurs": {...}, "libelle": "..."}.
"""

from __future__ import annotations

from typing import Literal, TypedDict

import psycopg

from .propositions import PropositionRefusee

TableAjout = Literal["classe", "matiere", "enseignant", "salle", "habilitation", "programme", "cours"]
ORDRE: list[str] = ["classe", "matiere", "enseignant", "salle", "habilitation", "programme", "cours"]


class Ajout(TypedDict):
    """Une ligne : sa table et ses valeurs (champs de CHAMPS), par codes."""
    table: TableAjout
    valeurs: dict[str, str | float]


# Champs requis et facultatifs de chaque table
CHAMPS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "classe": (("code_classe", "libelle", "niveau", "code_filiere"), ("effectif",)),
    "matiere": (("code_matiere", "libelle"), ("coefficient",)),
    "enseignant": (("matricule", "nom", "prenom"), ("email", "grade", "statut")),
    "salle": (("code_salle", "nom_salle", "capacite", "type_salle", "site"), ()),
    "habilitation": (("matricule", "code_matiere", "type_cours"), ()),
    "programme": (("code_classe", "code_matiere"), ("volume_cm", "volume_td", "volume_tp")),
    "cours": (("code_classe", "code_matiere", "type_cours", "volume_horaire", "matricule"),
              ("duree_seance", "nb_seances_semaine", "heures_semaine_max", "code_groupe", "type_salle")),
}


NUMERIQUES = {"effectif", "coefficient", "capacite", "volume_cm", "volume_td", "volume_tp", "volume_horaire",
              "duree_seance", "nb_seances_semaine", "heures_semaine_max"}
ENTIERS = {"effectif", "capacite", "nb_seances_semaine"}


def _un(conn: psycopg.Connection, sql: str, valeur, quoi: str) -> int:
    row = conn.execute(sql, (valeur,)).fetchone()
    if row is None:
        raise PropositionRefusee(f"{quoi} « {valeur} » introuvable dans le référentiel")
    return row[0]


def _classe(conn, code): return _un(conn, "SELECT id_classe FROM classe WHERE upper(code_classe) = upper(%s)", code, "Classe")
def _matiere(conn, code): return _un(conn, "SELECT id_matiere FROM matiere WHERE upper(code_matiere) = upper(%s)", code, "Matière")
def _enseignant(conn, m): return _un(conn, "SELECT id_enseignant FROM enseignant WHERE upper(matricule) = upper(%s)", m, "Enseignant")
def _type_salle(conn, t): return _un(conn, "SELECT id_type_salle FROM type_salle WHERE lower(libelle) = lower(%s)", t, "Type de salle")


def _un_site(conn, s) -> int:
    row = conn.execute("SELECT id_site FROM site WHERE upper(code_site) = upper(%s) OR lower(nom_site) = lower(%s)", (s, s)).fetchone()
    if row is None:
        raise PropositionRefusee(f"Site « {s} » introuvable dans le référentiel")
    return row[0]


def existe(conn: psycopg.Connection, table: str, v: dict, id_semestre: int) -> bool:
    """La ligne est-elle déjà dans le référentiel (même code ou même clé) ?"""
    q = lambda sql, *p: conn.execute(sql, p).fetchone() is not None  # noqa: E731
    if table == "classe":
        return q("SELECT 1 FROM classe WHERE upper(code_classe) = upper(%s)", v["code_classe"])
    if table == "matiere":
        return q("SELECT 1 FROM matiere WHERE upper(code_matiere) = upper(%s)", v["code_matiere"])
    if table == "enseignant":
        return q("SELECT 1 FROM enseignant WHERE upper(matricule) = upper(%s)", v["matricule"])
    if table == "salle":
        return q("SELECT 1 FROM salle WHERE upper(code_salle) = upper(%s)", v["code_salle"])
    if table == "habilitation":
        return q("""SELECT 1 FROM habilitation h JOIN enseignant e USING (id_enseignant) JOIN matiere m USING (id_matiere)
                    WHERE upper(e.matricule) = upper(%s) AND upper(m.code_matiere) = upper(%s) AND h.type_cours = %s""",
                 v["matricule"], v["code_matiere"], v["type_cours"])
    if table == "programme":
        return q("""SELECT 1 FROM programme p JOIN classe c USING (id_classe) JOIN matiere m USING (id_matiere)
                    WHERE upper(c.code_classe) = upper(%s) AND upper(m.code_matiere) = upper(%s) AND p.id_semestre = %s""",
                 v["code_classe"], v["code_matiere"], id_semestre)
    return q("""SELECT 1 FROM cours co JOIN classe c USING (id_classe) JOIN matiere m USING (id_matiere)
                LEFT JOIN groupe g ON g.id_groupe = co.id_groupe
                WHERE upper(c.code_classe) = upper(%s) AND upper(m.code_matiere) = upper(%s) AND co.type_cours = %s
                  AND co.id_semestre = %s AND upper(coalesce(g.code_groupe, '')) = upper(%s)""",
             v["code_classe"], v["code_matiere"], v["type_cours"], id_semestre, v.get("code_groupe") or "")


def _inserer(conn: psycopg.Connection, table: str, v: dict, id_semestre: int) -> None:
    x = conn.execute
    if table == "classe":
        x("INSERT INTO classe (code_classe, libelle, niveau, effectif, id_filiere) VALUES (%s, %s, %s, %s, %s)",
          (v["code_classe"], v["libelle"], v["niveau"], v.get("effectif", 0),
           _un(conn, "SELECT id_filiere FROM filiere WHERE upper(code_filiere) = upper(%s)", v["code_filiere"], "Filière")))
    elif table == "matiere":
        x("INSERT INTO matiere (code_matiere, libelle, coefficient) VALUES (%s, %s, %s)",
          (v["code_matiere"], v["libelle"], v.get("coefficient", 1)))
    elif table == "enseignant":
        x("INSERT INTO enseignant (matricule, nom, prenom, email, grade, statut) VALUES (%s, %s, %s, %s, %s, %s)",
          (v["matricule"], v["nom"], v["prenom"], v.get("email"), v.get("grade"), v.get("statut", "permanent")))
    elif table == "salle":
        x("INSERT INTO salle (code_salle, nom_salle, capacite, id_type_salle, id_site) VALUES (%s, %s, %s, %s, %s)",
          (v["code_salle"], v["nom_salle"], v["capacite"], _type_salle(conn, v["type_salle"]), _un_site(conn, v["site"])))
    elif table == "habilitation":
        x("INSERT INTO habilitation (id_enseignant, id_matiere, type_cours) VALUES (%s, %s, %s)",
          (_enseignant(conn, v["matricule"]), _matiere(conn, v["code_matiere"]), v["type_cours"]))
    elif table == "programme":
        x("INSERT INTO programme (id_classe, id_matiere, id_semestre, volume_cm, volume_td, volume_tp) VALUES (%s, %s, %s, %s, %s, %s)",
          (_classe(conn, v["code_classe"]), _matiere(conn, v["code_matiere"]), id_semestre,
           v.get("volume_cm", 0), v.get("volume_td", 0), v.get("volume_tp", 0)))
    else:
        id_classe = _classe(conn, v["code_classe"])
        id_groupe = None
        if v.get("code_groupe"):
            row = x("SELECT id_groupe FROM groupe WHERE id_classe = %s AND upper(code_groupe) = upper(%s)",
                    (id_classe, v["code_groupe"])).fetchone()
            if row is None:
                raise PropositionRefusee(f"Groupe « {v['code_groupe']} » de {v['code_classe']} introuvable dans le référentiel")
            id_groupe = row[0]
        x("""INSERT INTO cours (type_cours, volume_horaire, duree_seance, nb_seances_semaine, heures_semaine_max,
                                id_matiere, id_classe, id_groupe, id_enseignant, id_type_salle, id_semestre)
             VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
          (v["type_cours"], v["volume_horaire"], v.get("duree_seance", 2), v.get("nb_seances_semaine", 1),
           v.get("heures_semaine_max", 15), _matiere(conn, v["code_matiere"]), id_classe, id_groupe,
           _enseignant(conn, v["matricule"]), _type_salle(conn, v["type_salle"]) if v.get("type_salle") else None,
           id_semestre))


def libelle(table: str, v: dict) -> str:
    """Ligne lisible, montrée au planificateur sur la carte de la proposition."""
    if table == "classe":
        return f"Classe {v['code_classe']} : {v['libelle']} ({v['niveau']}, filière {v['code_filiere']}, {v.get('effectif', 0)} étudiants)"
    if table == "matiere":
        return f"Matière {v['code_matiere']} : {v['libelle']}"
    if table == "enseignant":
        return f"Enseignant {v['matricule']} : {v['prenom']} {v['nom']} ({v.get('statut', 'permanent')})"
    if table == "salle":
        return f"Salle {v['code_salle']} : {v['nom_salle']}, {v['capacite']} places, {v['type_salle']}, {v['site']}"
    if table == "habilitation":
        return f"Habilitation : {v['matricule']} peut assurer le {v['type_cours']} de {v['code_matiere']}"
    if table == "programme":
        vol = ", ".join(f"{t.upper()} {v[f'volume_{t}']:g} h" for t in ("cm", "td", "tp") if v.get(f"volume_{t}"))
        return f"Programme de {v['code_classe']} : {v['code_matiere']} ({vol})"
    groupe = f" groupe {v['code_groupe']}" if v.get("code_groupe") else ""
    return (f"Cours {v['type_cours']} {v['code_matiere']} pour {v['code_classe']}{groupe} : {v['volume_horaire']:g} h, "
            f"séances de {v.get('duree_seance', 2):g} h, enseignant {v['matricule']}")


def preparer(conn: psycopg.Connection, id_semestre: int, ajouts: list[dict]) -> tuple[list[dict], list[str]]:
    """Contrôle les ajouts demandés ; renvoie (opérations, remarques). Lève ValueError avec
    tous les problèmes trouvés. Ajoute l'habilitation d'un cours quand elle manque."""
    erreurs, remarques, ops = [], [], []
    for n, a in enumerate(ajouts, 1):
        table = a.get("table")
        requis, facultatifs = CHAMPS[table]
        v = {k: (x.strip() if isinstance(x, str) else x) for k, x in (a.get("valeurs") or {}).items() if x not in (None, "")}
        for k in NUMERIQUES & v.keys():  # « 12 » ou « 12,5 » venus d'un fichier
            try:
                v[k] = float(str(v[k]).replace(",", "."))
            except ValueError:
                erreurs.append(f"ajout {n} ({table}) : {k} doit être un nombre (reçu « {v[k]} »)")
        v = {k: (int(x) if k in ENTIERS and isinstance(x, float) and x.is_integer() else x) for k, x in v.items()}
        manquants = [k for k in requis if k not in v]
        en_trop = [k for k in v if k not in requis + facultatifs]
        if manquants:
            erreurs.append(f"ajout {n} ({table}) : il manque {', '.join(manquants)}")
        if en_trop:
            erreurs.append(f"ajout {n} ({table}) : champs sans objet pour cette table : {', '.join(en_trop)}")
        if table == "programme" and not any(v.get(f"volume_{t}") for t in ("cm", "td", "tp")):
            erreurs.append(f"ajout {n} (programme) : donnez au moins un volume (volume_cm, volume_td ou volume_tp)")
        if manquants or en_trop:
            continue
        if existe(conn, table, v, id_semestre):
            remarques.append(f"Déjà dans le référentiel, laissé tel quel : {libelle(table, v)}")
            continue
        ops.append({"action": "ajouter_ligne", "table": table, "valeurs": v, "libelle": libelle(table, v)})
    if erreurs:
        raise ValueError(" ; ".join(erreurs))

    # Un cours exige l'habilitation de son enseignant (CD-06) : ajoutée si elle manque
    cles = {(o["valeurs"]["matricule"].upper(), o["valeurs"]["code_matiere"].upper(), o["valeurs"]["type_cours"])
            for o in ops if o["table"] == "habilitation"}
    for o in [o for o in ops if o["table"] == "cours"]:
        v = o["valeurs"]
        h = {"matricule": v["matricule"], "code_matiere": v["code_matiere"], "type_cours": v["type_cours"]}
        cle = (h["matricule"].upper(), h["code_matiere"].upper(), h["type_cours"])
        if cle not in cles and not existe(conn, "habilitation", h, id_semestre):
            cles.add(cle)
            ops.append({"action": "ajouter_ligne", "table": "habilitation", "valeurs": h, "libelle": libelle("habilitation", h)})
            remarques.append(f"Habilitation ajoutée pour le cours : {libelle('habilitation', h)}")
    ops.sort(key=lambda o: ORDRE.index(o["table"]))
    return ops, remarques


def executer(conn: psycopg.Connection, ops: list[dict], id_edt: int) -> dict:
    """Insère les lignes (dans la transaction de l'appelant), dans l'ordre des dépendances.
    Une ligne apparue entre-temps est laissée telle quelle. Lève PropositionRefusee avec le
    motif de la base."""
    id_semestre = conn.execute("SELECT id_semestre FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()[0]
    ajoutees, deja = 0, 0
    for op in sorted(ops, key=lambda o: ORDRE.index(o["table"])):
        if existe(conn, op["table"], op["valeurs"], id_semestre):
            deja += 1
            continue
        try:
            with conn.transaction():
                _inserer(conn, op["table"], op["valeurs"], id_semestre)
        except (psycopg.errors.IntegrityError, psycopg.errors.RaiseException, psycopg.errors.DataError) as e:
            raise PropositionRefusee(f"Refusée par la base ({op['libelle']}) : {e.diag.message_primary or e}") from e
        ajoutees += 1
    return {"lignes_ajoutees": ajoutees, "lignes_deja_presentes": deja}
