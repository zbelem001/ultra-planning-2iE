"""Outils de l'assistant IA.

Chaque outil est une fonction ordinaire (testable sans modèle) qui renvoie un
texte lisible par le modèle. `construire_outils` les déclare comme outils
d'agent (schéma JSON déduit de la signature), liés à une conversation :
connexion, emploi du temps et message en cours.

L'agent ne modifie jamais les séances ni le référentiel (calendrier et enseignants
compris) : il lit (y compris les fichiers joints), vérifie, demande au solveur une
replanification, et enregistre le résultat comme PROPOSITION. Seule exception : les
priorités suggérées, qui ne sont que des suggestions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal, NotRequired, TypedDict

import psycopg

from ultraplanning_solver import ContrainteAjoutee, Demande, Perimetre, Resultat, generer
from ultraplanning_solver.base import charger, verifier
from ultraplanning_solver.donnees import Donnees, Seance, lundi_de

from . import impact, pieces_jointes, propositions
from .db import origine
from . import referentiel_changements as referentiel
from . import perimetre as perimetre_mod
from .publication import JOURS, MOIS
from .referentiel_changements import Changement
from .schema_outil import Outil, outil

MAX_LIGNES = 120  # au-delà, on tronque en le signalant (le modèle peut affiner sa requête)


@dataclass
class Contexte:
    conn: psycopg.Connection
    id_edt: int
    id_prompt: int
    propositions_creees: list[int]


def _h(t: time) -> str:
    return f"{t.hour}h{t.minute:02d}" if t.minute else f"{t.hour}h"


def _tronquer(lignes: list[str]) -> str:
    if not lignes:
        return "Aucun résultat."
    if len(lignes) > MAX_LIGNES:
        return "\n".join(lignes[:MAX_LIGNES]) + f"\n… {len(lignes) - MAX_LIGNES} lignes de plus : précisez la période ou la ressource."
    return "\n".join(lignes)


# --- lecture -----------------------------------------------------------------

_SEANCES = """FROM seance s JOIN cours c USING (id_cours) JOIN matiere m USING (id_matiere)
            JOIN classe cl ON cl.id_classe = c.id_classe LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
            LEFT JOIN enseignant e ON e.id_enseignant = s.id_enseignant JOIN salle sa ON sa.id_salle = s.id_salle"""


def _filtres_ressource(code_classe: str | None, matricule: str | None, code_salle: str | None,
                       code_matiere: str | None) -> tuple[list[str], list]:
    """Conditions sur l'emploi du temps visé. Celui d'une classe comprend ses cours mutualisés."""
    filtres, params = [], []
    if code_classe:
        filtres.append("EXISTS (SELECT 1 FROM publics_du_cours(c.id_cours) p JOIN classe x ON x.id_classe = p.id_classe "
                       "WHERE upper(x.code_classe) = upper(%s))")
        params.append(code_classe)
    if matricule:
        filtres.append("upper(e.matricule) = upper(%s)")
        params.append(matricule)
    if code_salle:
        filtres.append("upper(sa.code_salle) = upper(%s)")
        params.append(code_salle)
    if code_matiere:
        filtres.append("(upper(m.code_matiere) = upper(%s) OR lower(m.libelle) = lower(%s))")
        params += [code_matiere, code_matiere]
    return filtres, params


def lire_emploi_du_temps(ctx: Contexte, du: str, au: str, code_classe: str | None = None,
                         matricule: str | None = None, code_salle: str | None = None, code_matiere: str | None = None) -> str:
    filtres, params = _filtres_ressource(code_classe, matricule, code_salle, code_matiere)
    rows = ctx.conn.execute(
        f"""SELECT s.id_seance, s.date_seance, s.heure_debut, s.heure_fin, s.statut, s.est_verrouillee,
                   c.id_cours, m.libelle, c.type_cours, cl.code_classe, g.code_groupe,
                   e.matricule, e.nom, sa.id_salle, sa.code_salle, s.nature
            {_SEANCES}
            WHERE {' AND '.join(["s.id_edt = %s", "s.date_seance BETWEEN %s AND %s", *filtres])} ORDER BY s.date_seance, s.heure_debut""",
        [ctx.id_edt, du, au, *params],
    ).fetchall()
    jours = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
    return _tronquer([
        f"séance {r[0]} | {jours[r[1].weekday()]} {r[1]} {_h(r[2])}-{_h(r[3])} | {r[7]} {r[15].upper() if r[15] != 'cours' else r[8]} "
        f"| {r[9]}{' · ' + r[10] if r[10] and r[15] == 'cours' else ''} | "
        f"{f'{r[12]} ({r[11]})' if r[11] else ('sans enseignant' if r[15] != 'cours' else 'enseignant à désigner')} | salle {r[14]} (id {r[13]}) "
        f"| cours {r[6]}{' | annulée' if r[4] == 'annulee' else ''}{' | verrouillée' if r[5] else ''}"
        for r in rows
    ])


SUJETS = Literal["cours", "classes", "matieres", "enseignants", "salles", "programme", "calendrier"]


def lire_referentiel(ctx: Contexte, sujet: str) -> str:
    q = ctx.conn.execute
    if sujet == "cours":
        rows = q(
            """SELECT c.id_cours, m.code_matiere, m.libelle, c.type_cours, cl.code_classe, g.code_groupe,
                      e.matricule, e.nom, e.statut, c.volume_horaire, c.heures_semaine_min, c.heures_semaine_max,
                      c.priorite, c.priorite_suggeree,
                      COALESCE((SELECT sum(EXTRACT(EPOCH FROM s.heure_fin - s.heure_debut)) / 3600 FROM seance s
                                WHERE s.id_cours = c.id_cours AND s.id_edt = %s AND s.statut <> 'annulee' AND s.nature = 'cours'), 0)
               FROM cours c JOIN matiere m USING (id_matiere) JOIN classe cl ON cl.id_classe = c.id_classe
               LEFT JOIN groupe g ON g.id_groupe = c.id_groupe LEFT JOIN enseignant e ON e.id_enseignant = c.id_enseignant
               JOIN emploi_du_temps t ON t.id_edt = %s AND t.id_semestre = c.id_semestre
               ORDER BY c.id_cours""",
            (ctx.id_edt, ctx.id_edt),
        ).fetchall()
        return _tronquer([
            f"cours {r[0]} | {r[2]} ({r[1]}) {r[3]} | {r[4]}{' · ' + r[5] if r[5] else ''} "
            f"| {f'enseignant prévu {r[7]} ({r[6]}, {r[8]})' if r[6] else 'enseignant à désigner'} "
            f"| {float(r[14]):g}/{float(r[9]):g} h planifiées | rythme {float(r[10]):g}–{float(r[11]):g} h/sem "
            f"| priorité {r[12]}{f' (suggérée {r[13]})' if r[13] is not None else ''}"
            for r in rows
        ])
    if sujet == "classes":
        rows = q(
            """SELECT cl.code_classe, cl.libelle, cl.niveau, cl.effectif, f.code_filiere,
                      string_agg(g.code_groupe || ' ' || g.type_groupe || ' (' || g.effectif || ')'
                                 || coalesce(' dans ' || p.code_groupe, ''), ', ' ORDER BY g.code_groupe),
                      si.nom_site
               FROM classe cl JOIN filiere f USING (id_filiere) LEFT JOIN groupe g ON g.id_classe = cl.id_classe
               LEFT JOIN groupe p ON p.id_groupe = g.id_groupe_parent LEFT JOIN site si ON si.id_site = cl.id_site
               GROUP BY cl.id_classe, f.code_filiere, si.nom_site ORDER BY cl.code_classe"""
        ).fetchall()
        filieres = q("SELECT code_filiere, libelle FROM filiere ORDER BY code_filiere").fetchall()
        return _tronquer([f"{r[0]} | {r[1]} ({r[2]}) | filière {r[4]} | {r[3]} étudiants | site : {r[6] or 'non fixé'} "
                          f"| groupes : {r[5] or 'aucun'}" for r in rows]
                         + ["Filières : " + ", ".join(f"{f[0]} ({f[1]})" for f in filieres)])
    if sujet == "matieres":
        rows = q("SELECT code_matiere, libelle, coefficient FROM matiere ORDER BY libelle").fetchall()
        return _tronquer([f"{r[0]} | {r[1]} | coefficient {float(r[2]):g}" for r in rows])
    if sujet == "enseignants":
        rows = q(
            """SELECT e.matricule, e.prenom, e.nom, e.statut, e.nb_heures_max_semaine,
                      (SELECT string_agg(c.jour || ' ' || to_char(c.heure_debut, 'HH24"h"')
                                         || CASE WHEN d.niveau = 'preference' THEN ' (préférence)' ELSE '' END, ', ' ORDER BY c.id_creneau)
                       FROM disponibilite d JOIN creneau c USING (id_creneau)
                       WHERE d.id_enseignant = e.id_enseignant AND d.niveau <> 'disponible'),
                      (SELECT string_agg(a.date_debut || ' → ' || a.date_fin || coalesce(' (' || a.motif || ')', ''), '; ')
                       FROM absence_enseignant a WHERE a.id_enseignant = e.id_enseignant),
                      (SELECT string_agg(j.date_debut || ' → ' || j.date_fin, '; ')
                       FROM sejour_enseignant j WHERE j.id_enseignant = e.id_enseignant),
                      e.email, e.grade, si.nom_site
               FROM enseignant e LEFT JOIN site si ON si.id_site = e.id_site ORDER BY e.nom"""
        ).fetchall()
        return _tronquer([
            f"{r[0]} | {r[1]} {r[2]} | {r[3]} | max {r[4] or '–'} h/sem | indisponible : {r[5] or 'jamais'} "
            f"| absences : {r[6] or 'aucune'}{f' | séjours : {r[7]}' if r[7] else ''}"
            f"{f' | {r[8]}' if r[8] else ''}{f' | {r[9]}' if r[9] else ''}{f' | site {r[10]}' if r[10] else ''}"
            for r in rows
        ])
    if sujet == "salles":
        rows = q(
            """SELECT sa.id_salle, sa.code_salle, sa.nom_salle, sa.capacite, t.libelle, si.nom_site, sa.batiment, sa.est_disponible
               FROM salle sa JOIN type_salle t USING (id_type_salle) JOIN site si USING (id_site) ORDER BY sa.id_salle"""
        ).fetchall()
        return _tronquer([
            f"salle {r[0]} | {r[1]} {r[2]} | {r[3]} places | {r[4]} | {r[5]}{' · ' + r[6] if r[6] else ''}"
            f"{'' if r[7] else ' | INDISPONIBLE'}" for r in rows
        ] + ["Types de salles : " + ", ".join(t[0] for t in q("SELECT libelle FROM type_salle ORDER BY 1").fetchall()),
             "Sites : " + ", ".join(f"{s[0]} ({s[1]})" for s in q("SELECT code_site, nom_site FROM site ORDER BY 1").fetchall())])
    if sujet == "programme":
        rows = q(
            """SELECT cl.code_classe, m.libelle, p.volume_cm, p.volume_td, p.volume_tp
               FROM programme p JOIN classe cl USING (id_classe) JOIN matiere m USING (id_matiere)
               JOIN emploi_du_temps t ON t.id_edt = %s AND t.id_semestre = p.id_semestre ORDER BY cl.code_classe, m.libelle""",
            (ctx.id_edt,),
        ).fetchall()
        return _tronquer([f"{r[0]} | {r[1]} | CM {float(r[2]):g} h, TD {float(r[3]):g} h, TP {float(r[4]):g} h (par groupe)" for r in rows])
    if sujet == "calendrier":
        sem = q(
            "SELECT s.libelle, s.date_debut, s.date_fin FROM emploi_du_temps e "
            "JOIN semestre s USING (id_semestre) WHERE e.id_edt = %s", (ctx.id_edt,)
        ).fetchone()
        feries = q("SELECT date_ferie, libelle FROM jour_ferie ORDER BY 1").fetchall()
        conges = q("SELECT g.libelle, g.date_debut, g.date_fin, g.type_conge, c.code_classe FROM conge g "
                   "LEFT JOIN classe c ON c.id_classe = g.id_classe ORDER BY 2").fetchall()
        creneaux = q("SELECT jour, heure_debut, heure_fin FROM creneau ORDER BY array_position("
                     "ARRAY['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'], jour), heure_debut").fetchall()
        grille: dict[str, list[list[time]]] = {}
        for jour, debut, fin in creneaux:  # créneaux consécutifs regroupés en plages
            plages = grille.setdefault(jour, [])
            if plages and plages[-1][1] == debut:
                plages[-1][1] = fin
            else:
                plages.append([debut, fin])
        pauses = q("SELECT libelle, heure_debut, heure_fin FROM pause").fetchall()
        mat = q("SELECT valeur FROM contrainte WHERE id_edt = %s AND type_contrainte = 'CD-13' AND est_active", (ctx.id_edt,)).fetchone()
        return "\n".join([
            f"{sem[0]} : du {sem[1]} au {sem[2]} ; emploi du temps : version à jour",
            "Grille (créneaux) : " + "; ".join(f"{j} " + ", ".join(f"{_h(a)}–{_h(b)}" for a, b in p) for j, p in grille.items()),
            "Pauses : " + ", ".join(f"{p[0]} {_h(p[1])}–{_h(p[2])}" for p in pauses),
            f"Au plus {int(mat[0]) if mat and mat[0] else 3} matières par classe et par semaine (CD-13).",
            "Jours fériés : " + ", ".join(f"{f[0]} ({f[1]})" for f in feries),
            "Congés : " + ("; ".join(f"{c[0]} du {c[1]} au {c[2]} ({c[3]}, {c[4] or 'toutes les classes'})" for c in conges)
                           or "aucun"),
        ])
    return f"Sujet inconnu : {sujet}. Sujets possibles : cours, classes, matieres, enseignants, salles, programme, calendrier."


# --- vérification et replanification -------------------------------------------

def verifier_seance(ctx: Contexte, id_cours: int, date_seance: str, heure_debut: str, heure_fin: str,
                    id_salle: int, id_seance: int | None = None) -> str:
    s = Seance(id_cours, date.fromisoformat(date_seance), time.fromisoformat(heure_debut),
               time.fromisoformat(heure_fin), id_salle, id_seance)
    try:
        motif = verifier(ctx.conn, ctx.id_edt, s)
    except ValueError as e:
        return f"Refusée : {e}"
    return "Acceptée par toutes les règles (rien n'a été enregistré)." if motif is None else f"Refusée : {motif}"


class Fenetre(TypedDict):
    type: Literal["imposer", "interdire"]
    id_cours: NotRequired[int]
    code_classe: NotRequired[str]
    matricule: NotRequired[str]
    jours: NotRequired[list[Literal["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]]]
    heure_min: NotRequired[str]
    heure_max: NotRequired[str]
    date_debut: NotRequired[str]
    date_fin: NotRequired[str]


def _ids(conn: psycopg.Connection, table: str, colonne_code: str, codes: list[str]) -> set[int]:
    if not codes:
        return set()
    rows = conn.execute(f"SELECT id_{table}, {colonne_code} FROM {table} WHERE {colonne_code} = ANY(%s)", (codes,)).fetchall()
    inconnus = set(codes) - {r[1] for r in rows}
    if inconnus:
        raise ValueError(f"Codes inconnus ({table}) : {', '.join(sorted(inconnus))}")
    return {r[0] for r in rows}


def proposer_replanification(ctx: Contexte, description: str, du: str, au: str,
                             classes: list[str] | None = None, filieres: list[str] | None = None,
                             id_cours: list[int] | None = None, contraintes: list[Fenetre] | None = None,
                             ramener: bool = False) -> str:
    demain = date.today() + timedelta(days=1)
    try:
        perimetre = Perimetre(
            id_filieres=frozenset(_ids(ctx.conn, "filiere", "code_filiere", filieres or [])),
            id_classes=frozenset(_ids(ctx.conn, "classe", "code_classe", classes or [])),
            id_cours=frozenset(id_cours or []),
        )
        ajoutees = []
        for k in contraintes or []:
            ajoutees.append(ContrainteAjoutee(
                type=k["type"],
                id_cours=k.get("id_cours"),
                id_classe=next(iter(_ids(ctx.conn, "classe", "code_classe", [k["code_classe"]]))) if k.get("code_classe") else None,
                id_enseignant=ctx.conn.execute(
                    "SELECT id_enseignant FROM enseignant WHERE matricule = %s", (k["matricule"],)
                ).fetchone()[0] if k.get("matricule") else None,
                jours=tuple(k.get("jours", ())),
                heure_min=time.fromisoformat(k["heure_min"]) if k.get("heure_min") else None,
                heure_max=time.fromisoformat(k["heure_max"]) if k.get("heure_max") else None,
                date_debut=date.fromisoformat(k["date_debut"]) if k.get("date_debut") else None,
                date_fin=date.fromisoformat(k["date_fin"]) if k.get("date_fin") else None,
            ))

        # Semaines entières (lundi–samedi) : le solveur a la place de reprogrammer
        debut = lundi_de(date.fromisoformat(du))
        fin = lundi_de(date.fromisoformat(au)) + timedelta(days=5)
        if ramener:  # les séances ramenées ne vont jamais dans le passé
            debut = max(debut, demain)
    except (ValueError, TypeError) as e:
        return f"Demande invalide : {e}"
    if fin < debut:
        return "Demande invalide : la date de fin précède la date de début."

    return _proposer(ctx, description, Demande(perimetre=perimetre, du=debut, au=fin, contraintes=ajoutees,
                                               minimiser_changements=True, ramener_depuis=demain if ramener else None,
                                               temps_max_placement=4),
                     f"Période replanifiée : semaines entières du {debut} au {fin}.")


def proposer_reprogrammation_cours(ctx: Contexte, description: str, id_cours: list[int], du: str, au: str) -> str:
    """Toutes les séances à venir de ces cours, avant ou après la période, y sont ramenées."""
    connus = {r[0] for r in ctx.conn.execute("SELECT id_cours FROM cours WHERE id_cours = ANY(%s)", (id_cours,)).fetchall()}
    if not id_cours or set(id_cours) - connus:
        return f"Demande invalide : cours {', '.join(map(str, sorted(set(id_cours) - connus))) or 'à préciser'} introuvable. Lis le référentiel."
    return proposer_replanification(ctx, description, du, au, id_cours=id_cours, ramener=True)


def proposer_generation(ctx: Contexte, description: str, classes: list[str] | None = None,
                        filieres: list[str] | None = None, du: str | None = None, au: str | None = None,
                        matieres: list[str] | None = None) -> str:
    """Génération d'une classe ou d'une filière, sur tout le reste du semestre ou sur une période
    courte (une ou deux semaines) : les séances non verrouillées du périmètre et de la période sont
    recalculées. Sur une période courte, le solveur répartit le volume restant jusqu'à la fin du
    semestre selon le rythme des cours et ne place que la période ; le reste est reporté.
    `matieres` : seulement les cours de ces matières (modules) dans ces classes ; les autres cours
    restent en place et comptent dans les contraintes (salles, enseignants, 3 matières par semaine)."""
    if not classes and not filieres:
        return "Demande invalide : précisez au moins une classe ou une filière (pas tout l'établissement)."
    try:
        selection = perimetre_mod.resoudre(ctx.conn, ctx.id_edt, classes, filieres, matieres)
        if selection.vide:
            return "Rien à générer, aucune proposition créée :\n- " + "\n- ".join(selection.avertissements)
        perimetre = selection.perimetre
        sem_debut, sem_fin = ctx.conn.execute(
            "SELECT s.date_debut, s.date_fin FROM emploi_du_temps e JOIN semestre s USING (id_semestre) WHERE e.id_edt = %s",
            (ctx.id_edt,),
        ).fetchone()
        # Par défaut : à partir de la semaine prochaine (on ne programme pas le passé), jusqu'à la fin du semestre
        debut = lundi_de(date.fromisoformat(du)) if du else lundi_de(date.today()) + timedelta(days=7)
        debut = max(debut, sem_debut, date.today() + timedelta(days=1))  # jamais dans le passé
        # Semaines entières (jusqu'au samedi)
        fin = min(lundi_de(date.fromisoformat(au)) + timedelta(days=5), sem_fin) if au else sem_fin
    except (ValueError, TypeError) as e:
        return f"Demande invalide : {e}"
    if fin < debut:
        return "Demande invalide : la date de fin précède la date de début."
    texte = _proposer(ctx, description, Demande(perimetre=perimetre, du=debut, au=fin, temps_max_placement=5),
                      f"Période générée : du {debut} au {fin}.")
    if selection.avertissements:
        texte += "\nModules non programmés (à préparer dans le référentiel) :\n- " + "\n- ".join(selection.avertissements)
    return texte


def a_valider(ctx: Contexte) -> str | None:
    """Rien de ce que propose l'assistant ne s'écrit sans le planificateur : une proposition de séances (ajout,
    déplacement, suppression, épreuve, résultat du solveur) attend qu'il la valide sur sa carte. Validée, elle
    s'écrit dans la version à jour (grille de Planification) ; les invités ne la voient qu'après Publier, depuis
    la page Planification. Renvoie une phrase pour le modèle, ou None s'il n'y a rien en attente."""
    if not ctx.propositions_creees:
        return None
    row = ctx.conn.execute(
        "SELECT id_proposition FROM proposition WHERE id_proposition = ANY(%s) AND statut = 'en_attente' AND nature = 'seances'",
        (ctx.propositions_creees,)).fetchone()
    if row is None:
        return None
    return (f"En attente de validation : la proposition {row[0]} n'est pas appliquée, rien n'est encore écrit. Le planificateur "
            "la valide (bouton Valider de sa carte) ou la rejette. Validée, elle s'écrit dans la version à jour, visible dans la "
            "page Planification ; les invités ne la voient qu'après le bouton Publier de cette page.")


def _non_placees(r: Resultat) -> list[str]:
    if not r.non_places:
        return []
    return ["Heures non placées :", *(f"  cours {n.id_cours} : {n.heures} h ({n.code}) {n.raison}" for n in r.non_places[:10])]


def _hors_du_calcul(d: Donnees, demande: Demande) -> list[str]:
    """Ce que le calcul de cours précis n'a pas regardé, pour que « ce qui reste du cours » ne se
    confonde pas avec ce qui est dans la période."""
    vises = demande.perimetre.id_cours
    lignes = []
    apres = sorted((s for s in d.seances if s.id_cours in vises and demande.au and s.date_seance > demande.au),
                   key=lambda s: s.date_seance)
    if apres and demande.ramener_depuis is None:
        lignes.append(f"Non concernées : {len(apres)} autre(s) séance(s) de ces cours ({sum(s.duree for s in apres)} h) sont prévues "
                      f"après la période, du {apres[0].date_seance} au {apres[-1].date_seance}. Si la demande vise tout ce qui reste "
                      "de ces cours, appelle proposer_reprogrammation_cours.")
    if demande.minimiser_changements:
        for k in sorted(vises & d.cours.keys()):
            manque = d.cours[k].volume_horaire - sum(s.duree for s in d.seances if s.id_cours == k)
            if manque > 0:
                lignes.append(f"Jamais programmées : {manque} h du cours {k} (volume {d.cours[k].volume_horaire} h), ni dans l'emploi "
                              "du temps ni dans ce calcul. Pour les placer, utilise proposer_generation avec matieres.")
    return lignes


def _proposer(ctx: Contexte, description: str, demande: Demande, periode: str) -> str:
    """Calcule la demande avec le solveur et l'enregistre comme proposition, avec son impact."""
    d = charger(ctx.conn, ctx.id_edt)
    r = generer(d, demande)
    ops = r.modifications()
    noms = dict(ctx.conn.execute("SELECT id_matiere, libelle FROM matiere").fetchall())
    consequences = impact.analyser(d, r, noms)
    if not ops:  # rien à appliquer
        return "\n".join([
            "Rien n'a changé : le calcul ne trouve aucune séance à déplacer dans la version à jour.", periode,
            f"{len(r.seances)} séance(s) du périmètre dans la période, déjà valides à leur place." if r.seances
            else "Aucune heure à placer pour ce périmètre dans cette période.",
            *_non_placees(r), *impact.lignes_restees(consequences), *_hors_du_calcul(d, demande),
        ])
    if len(ops) <= LIGNES_MAX_RESULTAT:  # le détail sur la carte, sauf pour une génération entière
        consequences |= {"seances_retirees": _libelles_seances(ctx, [o["avant"] for o in ops if o["action"] == "supprimer"]),
                         "seances_ajoutees": _libelles_seances(ctx, [o["apres"] for o in ops if o["action"] == "creer"])}
    # Une seule proposition par message : une nouvelle tentative remplace la précédente
    remplacees = propositions.remplacer(ctx.conn, ctx.propositions_creees)
    id_prop = propositions.creer(ctx.conn, ctx.id_prompt, ctx.id_edt, description, ops, consequences)
    ctx.propositions_creees[:] = [id_prop]

    if demande.minimiser_changements:
        bougent = sum(_duree(o["apres"]) for o in ops if o["action"] == "creer")
        heures = f"{bougent:g} h changent de place, {r.heures_placees - bougent:g} h déjà valides ne bougent pas."
    else:
        heures = f"{r.heures_placees} h placées sur {r.statistiques['heures_demandees']} h à programmer dans le périmètre."
    lignes = [
        f"Proposition {id_prop} calculée"
        + (f", elle remplace la proposition {', '.join(map(str, remplacees))}." if remplacees else "."),
        periode,
        f"{sum(1 for o in ops if o['action'] == 'supprimer')} séance(s) retirée(s), "
        f"{sum(1 for o in ops if o['action'] == 'creer')} séance(s) créée(s) ; {heures}",
    ]
    dates = sorted(s.date_seance for s in r.seances)
    if dates and not demande.minimiser_changements:
        lignes.append(f"Séances calculées : du {dates[0]} au {dates[-1]} (le cours est terminé quand son volume est épuisé).")
    lignes += _non_placees(r)
    lignes += impact.resume(consequences)
    lignes += _hors_du_calcul(d, demande)
    lignes.append("Détail des opérations :")
    for o in ops[:15]:
        s = o.get("apres") or o.get("avant")
        lignes.append(f"  {o['action']} : cours {s['id_cours']} le {s['date_seance']} {s['heure_debut']}–{s['heure_fin']} salle {s['id_salle']}")
    if len(ops) > 15:
        lignes.append(f"  … et {len(ops) - 15} autres opérations")
    return "\n".join(lignes)


class OperationSeance(TypedDict):
    action: Literal["deplacer", "annuler", "retablir", "ajouter", "supprimer", "changer_enseignant"]
    id_seance: NotRequired[int]
    matricule: NotRequired[str]
    id_cours: NotRequired[int]
    date_seance: NotRequired[str]
    heure_debut: NotRequired[str]
    heure_fin: NotRequired[str]
    id_salle: NotRequired[int]


class _Annuler(Exception):
    pass


def proposer_modifications(ctx: Contexte, description: str, operations: list[OperationSeance]) -> str:
    """Changements ponctuels de séances précises, vérifiés ensemble dans la base avant d'être proposés."""
    if not operations:
        return "Demande invalide : aucune opération."
    ids = [o["id_seance"] for o in operations if o.get("id_seance") is not None]
    actuelles = {
        r[0]: {"id_cours": r[1], "date_seance": r[2].isoformat(), "heure_debut": r[3].strftime("%H:%M"),
               "heure_fin": r[4].strftime("%H:%M"), "id_salle": r[5], "statut": r[6], "id_enseignant": r[7]}
        for r in ctx.conn.execute(
            "SELECT id_seance, id_cours, date_seance, heure_debut, heure_fin, id_salle, statut, id_enseignant FROM seance "
            "WHERE id_seance = ANY(%s) AND id_edt = %s", (ids, ctx.id_edt)).fetchall()
    }
    verrouillees = {r[0] for r in ctx.conn.execute(
        "SELECT id_seance FROM seance WHERE id_seance = ANY(%s) AND id_edt = %s AND est_verrouillee", (ids, ctx.id_edt)).fetchall()}
    epreuves = {r[0] for r in ctx.conn.execute(
        "SELECT id_seance FROM seance WHERE id_seance = ANY(%s) AND id_edt = %s AND nature <> 'cours'", (ids, ctx.id_edt)).fetchall()}

    def enseignant(matricule: str) -> int | None:
        """Matricule -> identifiant ; chaîne vide : pas d'enseignant (à désigner)."""
        if not matricule.strip():
            return None
        row = ctx.conn.execute("SELECT id_enseignant FROM enseignant WHERE upper(matricule) = upper(%s)",
                               (matricule.strip(),)).fetchone()
        if row is None:
            raise ValueError(f"enseignant {matricule} introuvable")
        return row[0]

    ops: list[dict] = []
    try:
        for n, o in enumerate(operations, 1):
            action = o["action"]
            if action == "ajouter":
                manquants = [k for k in ("id_cours", "date_seance", "heure_debut", "heure_fin", "id_salle") if o.get(k) is None]
                if manquants:
                    raise ValueError(f"opération {n} (ajouter) : il manque {', '.join(manquants)}")
                ops.append({"action": "creer", "apres": {
                    "id_cours": o["id_cours"], "date_seance": date.fromisoformat(o["date_seance"]).isoformat(),
                    "heure_debut": time.fromisoformat(o["heure_debut"]).strftime("%H:%M"),
                    "heure_fin": time.fromisoformat(o["heure_fin"]).strftime("%H:%M"),
                    "id_salle": o["id_salle"], "statut": "planifiee",
                    **({"id_enseignant": enseignant(o["matricule"])} if o.get("matricule") is not None else {})}})
                continue
            avant = actuelles.get(o.get("id_seance"))
            if avant is None:
                raise ValueError(f"opération {n} ({action}) : séance {o.get('id_seance')} introuvable dans cet emploi du temps")
            if action == "supprimer":
                if o["id_seance"] in verrouillees:
                    raise ValueError(f"opération {n} : la séance {o['id_seance']} est verrouillée. Fais confirmer sa suppression "
                                     "au planificateur, puis utilise la suppression de séances avec inclure_verrouillees")
                ops.append({"action": "supprimer", "id_seance": o["id_seance"], "avant": avant})
                continue
            apres = dict(avant)
            if action == "annuler":
                apres["statut"] = "annulee"
            elif action == "retablir":
                apres["statut"] = "planifiee"
            elif action == "changer_enseignant":
                if o["id_seance"] in epreuves:
                    raise ValueError(f"opération {n} : la séance {o['id_seance']} est une épreuve, elle n'a pas d'enseignant")
                if o.get("matricule") is None:
                    raise ValueError(f"opération {n} (changer_enseignant) : donnez matricule (vide pour retirer l'enseignant)")
                apres["id_enseignant"] = enseignant(o["matricule"])
                if apres == avant:
                    raise ValueError(f"opération {n} : la séance {o['id_seance']} a déjà cet enseignant")
            else:  # deplacer : nouvelle date, nouvelles heures (même durée par défaut), autre salle
                if o.get("date_seance"):
                    apres["date_seance"] = date.fromisoformat(o["date_seance"]).isoformat()
                if o.get("heure_debut"):
                    debut = time.fromisoformat(o["heure_debut"])
                    duree = (datetime.combine(date.min, time.fromisoformat(avant["heure_fin"]))
                             - datetime.combine(date.min, time.fromisoformat(avant["heure_debut"])))
                    apres["heure_debut"] = debut.strftime("%H:%M")
                    apres["heure_fin"] = (time.fromisoformat(o["heure_fin"]) if o.get("heure_fin")
                                          else (datetime.combine(date.min, debut) + duree).time()).strftime("%H:%M")
                elif o.get("heure_fin"):
                    apres["heure_fin"] = time.fromisoformat(o["heure_fin"]).strftime("%H:%M")
                if o.get("id_salle"):
                    apres["id_salle"] = o["id_salle"]
                if o.get("matricule") is not None:
                    apres["id_enseignant"] = enseignant(o["matricule"])
                if apres == avant:
                    raise ValueError(f"opération {n} (deplacer) : rien ne change pour la séance {o['id_seance']}")
            ops.append({"action": "modifier", "id_seance": o["id_seance"], "avant": avant, "apres": apres})
    except (ValueError, TypeError) as e:
        return f"Demande invalide : {e}"
    return _proposer_operations(ctx, description, ops)


LIGNES_MAX_RESULTAT = 30  # au-delà, le modèle n'a pas besoin du détail : la carte de la proposition le montre


def _proposer_operations(ctx: Contexte, description: str, ops: list[dict], remarques: tuple[str, ...] = ()) -> str:
    """Vérifie les opérations ensemble dans la base, puis les enregistre comme proposition."""
    # Toutes les opérations ensemble, dans la base, puis annulation : rien n'est écrit
    ecole = ctx.conn.execute("SELECT id_ecole FROM emploi_du_temps WHERE id_edt = %s", (ctx.id_edt,)).fetchone()[0]
    try:
        with ctx.conn.transaction():
            propositions.executer_operations(ctx.conn, ops, ctx.id_edt, ecole)
            raise _Annuler
    except _Annuler:
        pass
    except propositions.PropositionRefusee as e:
        return f"{e}. Aucune proposition créée."

    consequences = _impact_operations(ctx, ops)
    remplacees = propositions.remplacer(ctx.conn, ctx.propositions_creees)
    id_prop = propositions.creer(ctx.conn, ctx.id_prompt, ctx.id_edt, description, ops, consequences)
    ctx.propositions_creees[:] = [id_prop]
    lignes = [
        f"Proposition {id_prop} calculée"
        + (f", elle remplace la proposition {', '.join(map(str, remplacees))}." if remplacees else "."),
        "Toutes les opérations ont été vérifiées ensemble par la base (règles CD-01 à CD-13).",
        *remarques,
    ]
    ids_ens = [x.get("id_enseignant") for o in ops for x in (o.get("avant"), o.get("apres")) if x and x.get("id_enseignant")]
    noms_ens = dict(ctx.conn.execute("SELECT id_enseignant, prenom || ' ' || nom FROM enseignant WHERE id_enseignant = ANY(%s)",
                                     (ids_ens,)).fetchall())
    for o in ops[:LIGNES_MAX_RESULTAT]:
        a, b = o.get("avant"), o.get("apres")
        if o["action"] == "creer":
            lignes.append(f"  ajout : cours {b['id_cours']} le {b['date_seance']} {b['heure_debut']}–{b['heure_fin']} salle {b['id_salle']}")
        elif o["action"] == "supprimer":
            lignes.append(f"  suppression : séance {o['id_seance']} du {a['date_seance']} {a['heure_debut']}–{a['heure_fin']}")
        elif b["statut"] != a["statut"]:
            lignes.append(f"  {'annulation' if b['statut'] == 'annulee' else 'rétablissement'} : séance {o['id_seance']} du {a['date_seance']} {a['heure_debut']}–{a['heure_fin']}")
        elif (b["date_seance"], b["heure_debut"], b["heure_fin"], b["id_salle"]) == (a["date_seance"], a["heure_debut"], a["heure_fin"], a["id_salle"]):
            lignes.append(f"  changement d'enseignant : séance {o['id_seance']} du {a['date_seance']} {a['heure_debut']}–{a['heure_fin']}"
                          f" ({noms_ens.get(a['id_enseignant'], 'à désigner')} → {noms_ens.get(b['id_enseignant'], 'à désigner')})")
        else:
            lignes.append(f"  déplacement : séance {o['id_seance']} du {a['date_seance']} {a['heure_debut']}–{a['heure_fin']} salle {a['id_salle']}"
                          f" vers le {b['date_seance']} {b['heure_debut']}–{b['heure_fin']} salle {b['id_salle']}")
    if len(ops) > LIGNES_MAX_RESULTAT:
        lignes.append(f"  … et {len(ops) - LIGNES_MAX_RESULTAT} autre(s) opération(s), détaillée(s) sur la carte de la proposition.")
    lignes += impact.resume(consequences)
    return "\n".join(lignes)


def _duree(s: dict) -> float:
    debut, fin = time.fromisoformat(s["heure_debut"]), time.fromisoformat(s["heure_fin"])
    return (fin.hour * 60 + fin.minute - debut.hour * 60 - debut.minute) / 60


def _libelles_seances(ctx: Contexte, seances: list[dict]) -> list[str]:
    """Une ligne par séance, dans l'ordre chronologique, pour la carte de la proposition."""
    if not seances:
        return []
    cours = dict(ctx.conn.execute(
        """SELECT c.id_cours, m.libelle || ' ' || c.type_cours || ' · ' || cl.code_classe || coalesce(' · ' || g.code_groupe, '')
           FROM cours c JOIN matiere m USING (id_matiere) JOIN classe cl ON cl.id_classe = c.id_classe
           LEFT JOIN groupe g ON g.id_groupe = c.id_groupe WHERE c.id_cours = ANY(%s)""",
        (list({s["id_cours"] for s in seances}),)).fetchall())
    salles = dict(ctx.conn.execute("SELECT id_salle, nom_salle FROM salle WHERE id_salle = ANY(%s)",
                                   (list({s["id_salle"] for s in seances}),)).fetchall())
    enseignants = dict(ctx.conn.execute("SELECT id_enseignant, prenom || ' ' || nom FROM enseignant WHERE id_enseignant = ANY(%s)",
                                        (list({s["id_enseignant"] for s in seances if s.get("id_enseignant")}),)).fetchall())
    lignes = []
    for s in sorted(seances, key=lambda x: (x["date_seance"], x["heure_debut"])):
        d = date.fromisoformat(s["date_seance"])
        nature = s.get("nature", "cours")
        lignes.append(f"{JOURS[d.weekday()]} {d.day} {MOIS[d.month - 1]}, {s['heure_debut']}–{s['heure_fin']} · "
                      + (f"{nature.capitalize()} · " if nature != "cours" else "") + f"{cours.get(s['id_cours'], 'Cours')} · {salles.get(s['id_salle'], 'salle')}"
                      + ("" if nature != "cours" else f" · {enseignants.get(s.get('id_enseignant'), 'enseignant à désigner')}")
                      + (" (annulée)" if s.get("statut") == "annulee" else ""))
    return lignes


_NUMERO_JOUR = {"Lundi": 1, "Mardi": 2, "Mercredi": 3, "Jeudi": 4, "Vendredi": 5, "Samedi": 6}


def proposer_suppression_seances(ctx: Contexte, description: str, code_classe: str | None = None, matricule: str | None = None,
                                 code_salle: str | None = None, code_matiere: str | None = None, code_groupe: str | None = None,
                                 type_cours: str | None = None, du: str | None = None, au: str | None = None,
                                 jours: list[str] | None = None, heure_min: str | None = None, heure_max: str | None = None,
                                 id_seances: list[int] | None = None, inclure_verrouillees: bool = False,
                                 nature: str | None = None) -> str:
    """Séances de l'emploi du temps d'une classe, d'un enseignant ou d'une salle à supprimer, trouvées
    par critères et proposées ensemble. Sans date de début : à partir d'aujourd'hui, le passé reste.
    `nature` : cours (défaut) ; examen ou rattrapage pour retirer une épreuve."""
    if not (code_classe or matricule or code_salle or code_matiere or id_seances):
        return ("Demande invalide : précisez l'emploi du temps visé (classe, enseignant, salle ou matière), "
                "ou les séances par leurs identifiants.")
    q = ctx.conn.execute
    try:
        for valeur, sql_existe, quoi in (
                (code_classe, "SELECT 1 FROM classe WHERE upper(code_classe) = upper(%(v)s)", "Classe"),
                (matricule, "SELECT 1 FROM enseignant WHERE upper(matricule) = upper(%(v)s)", "Enseignant"),
                (code_salle, "SELECT 1 FROM salle WHERE upper(code_salle) = upper(%(v)s)", "Salle"),
                (code_groupe, "SELECT 1 FROM groupe WHERE upper(code_groupe) = upper(%(v)s)", "Groupe"),
                (code_matiere, "SELECT 1 FROM matiere WHERE upper(code_matiere) = upper(%(v)s) OR lower(libelle) = lower(%(v)s)", "Matière")):
            if valeur and q(sql_existe, {"v": valeur}).fetchone() is None:
                raise ValueError(f"{quoi} « {valeur} » introuvable : lis le référentiel pour avoir son code")
        filtres, params = _filtres_ressource(code_classe, matricule, code_salle, code_matiere)
        if code_groupe:
            filtres.append("upper(g.code_groupe) = upper(%s)")
            params.append(code_groupe)
        if type_cours:
            filtres.append("c.type_cours = %s")
            params.append(type_cours.upper())
        # Sans date de début, le passé reste : ce qui a eu lieu ne se retire pas par mégarde
        debut = du or (None if id_seances else date.today().isoformat())
        if debut:
            filtres.append("s.date_seance >= %s")
            params.append(date.fromisoformat(debut))
        if au:
            filtres.append("s.date_seance <= %s")
            params.append(date.fromisoformat(au))
        if jours:
            filtres.append("EXTRACT(ISODOW FROM s.date_seance)::int = ANY(%s)")
            params.append([_NUMERO_JOUR[j] for j in jours])
        if heure_min:
            filtres.append("s.heure_fin > %s")
            params.append(time.fromisoformat(heure_min))
        if heure_max:
            filtres.append("s.heure_debut < %s")
            params.append(time.fromisoformat(heure_max))
        if id_seances:
            filtres.append("s.id_seance = ANY(%s)")
            params.append(id_seances)
        epreuves_gardees = 0
        if nature:
            filtres.append("s.nature = %s")
            params.append(nature)
        elif not id_seances:  # une demande générale de suppression ne retire pas les épreuves
            conditions = " AND ".join(["s.id_edt = %s", *filtres, "s.nature <> 'cours'"])
            epreuves_gardees = q(f"SELECT count(*) {_SEANCES} WHERE {conditions}", [ctx.id_edt, *params]).fetchone()[0]
            filtres.append("s.nature = 'cours'")
    except (ValueError, KeyError) as e:
        return f"Demande invalide : {e}"

    rows = q(
        f"""SELECT s.id_seance, s.id_cours, s.date_seance, to_char(s.heure_debut, 'HH24:MI'), to_char(s.heure_fin, 'HH24:MI'),
                   s.id_salle, s.statut, s.id_enseignant, s.est_verrouillee,
                   (SELECT count(*) FROM publics_du_cours(c.id_cours)) > 1, s.nature
            {_SEANCES}
            WHERE {' AND '.join(["s.id_edt = %s", *filtres])} ORDER BY s.date_seance, s.heure_debut""",
        [ctx.id_edt, *params],
    ).fetchall()
    if id_seances:
        absentes = set(id_seances) - {r[0] for r in rows}
        if absentes:
            return f"Demande invalide : séance(s) {', '.join(map(str, sorted(absentes)))} introuvable(s) avec ces critères dans cet emploi du temps."
    if not rows:
        return ("Aucune séance de cours ne correspond à ces critères, aucune proposition créée."
                + (f" {epreuves_gardees} examen(s) ou rattrapage(s) correspondent, laissés en place : pour les retirer, précise la nature." if epreuves_gardees else "")
                + ("" if du or id_seances else " La recherche part d'aujourd'hui : pour inclure les séances passées, donne du."))
    gardees = [r for r in rows if r[8] and not inclure_verrouillees]
    choisies = [r for r in rows if inclure_verrouillees or not r[8]]
    if not choisies:
        return (f"Ces critères ne désignent que {len(gardees)} séance(s) verrouillée(s), aucune proposition créée. "
                "Fais confirmer leur suppression au planificateur, puis redemande avec inclure_verrouillees.")
    ops = [{"action": "supprimer", "id_seance": r[0],
            "avant": {"id_cours": r[1], "date_seance": r[2].isoformat(), "heure_debut": r[3], "heure_fin": r[4],
                      "id_salle": r[5], "statut": r[6], "id_enseignant": r[7], "nature": r[10]}} for r in choisies]
    remarques = [f"{len(ops)} séance(s) à supprimer, du {choisies[0][2]} au {choisies[-1][2]}."]
    if gardees:
        remarques.append(f"{len(gardees)} séance(s) verrouillée(s) laissée(s) en place : signale-le, et ne les inclus que si le planificateur le confirme.")
    mutualisees = sum(1 for r in choisies if r[9])
    if epreuves_gardees:
        remarques.append(f"{epreuves_gardees} examen(s) ou rattrapage(s) laissé(s) en place : pour en retirer, précise la nature.")
    if mutualisees:
        remarques.append(f"{mutualisees} séance(s) de cours mutualisés : elles disparaissent aussi pour les autres promotions du cours. Signale-le.")
    return _proposer_operations(ctx, description, ops, tuple(remarques))


def proposer_epreuve(ctx: Contexte, description: str, code_classe: str, code_matiere: str, date_seance: str, heure_debut: str,
                     heure_fin: str, nature: str = "examen", code_salle: str | None = None, site: str | None = None) -> str:
    """Examen ou rattrapage d'un module pour une classe, vérifié dans la base avant d'être proposé.
    Sans salle : la plus ajustée qui reste libre (d'autres épreuves peuvent déjà s'y tenir)."""
    if nature not in ("examen", "rattrapage"):
        return "Demande invalide : nature examen ou rattrapage."
    try:
        jour = date.fromisoformat(date_seance)
        debut, fin = time.fromisoformat(heure_debut), time.fromisoformat(heure_fin)
    except ValueError as e:
        return f"Demande invalide : {e}"
    duree = (fin.hour * 60 + fin.minute - debut.hour * 60 - debut.minute) / 60
    if not 2 <= duree <= 3:
        return f"Demande invalide : une épreuve dure de 2 h à 3 h (ici {duree:g} h)."
    q = ctx.conn.execute
    # La classe entière compose : on rattache l'épreuve au cours de classe entière s'il y en a un
    cours = q(
        """SELECT c.id_cours, m.libelle FROM cours c JOIN classe cl ON cl.id_classe = c.id_classe JOIN matiere m USING (id_matiere)
           JOIN emploi_du_temps e ON e.id_edt = %(edt)s AND e.id_semestre = c.id_semestre
           WHERE upper(cl.code_classe) = upper(%(c)s) AND (upper(m.code_matiere) = upper(%(m)s) OR lower(m.libelle) = lower(%(m)s))
           ORDER BY c.id_groupe IS NOT NULL, c.type_cours <> 'CM', c.id_cours LIMIT 1""",
        {"edt": ctx.id_edt, "c": code_classe, "m": code_matiere}).fetchone()
    if cours is None:
        return f"Demande invalide : aucun cours de « {code_matiere} » pour la classe « {code_classe} » ce semestre. Lis le référentiel, ou ajoute d'abord ce cours."
    id_cours = cours[0]
    if code_salle:
        salle = q("SELECT id_salle FROM salle WHERE upper(code_salle) = upper(%s)", (code_salle,)).fetchone()
        if salle is None:
            return f"Demande invalide : salle « {code_salle} » introuvable."
    else:
        id_site = None
        if site:
            row = q("SELECT id_site FROM site WHERE upper(code_site) = upper(%(s)s) OR lower(nom_site) = lower(%(s)s)", {"s": site}).fetchone()
            if row is None:
                return f"Demande invalide : campus « {site} » introuvable."
            id_site = row[0]
        salle = q(
            """WITH places AS (
                   SELECT coalesce(sum(cl.effectif), 0) AS n FROM publics_seance(%(k)s, %(nat)s) p JOIN classe cl ON cl.id_classe = p.id_classe
               ), plage AS (SELECT tsrange(%(j)s::date + %(d)s::time, %(j)s::date + %(f)s::time) AS p)
               SELECT sa.id_salle FROM salle sa, places, plage
               WHERE sa.est_disponible
                 AND (%(site)s::bigint IS NULL OR sa.id_site = %(site)s)
                 AND NOT EXISTS (SELECT 1 FROM seance o WHERE o.id_edt = %(edt)s AND o.id_salle = sa.id_salle AND o.statut <> 'annulee'
                                 AND o.nature = 'cours' AND o.plage && plage.p)
                 AND (NOT EXISTS (SELECT 1 FROM salle_reservation r WHERE r.id_salle = sa.id_salle)
                      OR EXISTS (SELECT 1 FROM salle_reservation r JOIN publics_du_cours(%(k)s) x ON x.id_classe = r.id_classe WHERE r.id_salle = sa.id_salle))
                 AND sa.capacite >= places.n + (
                     SELECT coalesce(sum(cl.effectif), 0)
                     FROM seance o CROSS JOIN LATERAL publics_seance(o.id_cours, o.nature) x JOIN classe cl ON cl.id_classe = x.id_classe
                     WHERE o.id_edt = %(edt)s AND o.id_salle = sa.id_salle AND o.statut <> 'annulee' AND o.nature <> 'cours' AND o.plage && plage.p)
               ORDER BY sa.capacite, sa.id_salle LIMIT 1""",
            {"k": id_cours, "nat": nature, "j": jour, "d": debut, "f": fin, "site": id_site, "edt": ctx.id_edt}).fetchone()
        if salle is None:
            return "Aucune salle libre assez grande sur cette plage" + (" sur ce campus" if id_site else "") + ", aucune proposition créée."
    ops = [{"action": "creer", "apres": {
        "id_cours": id_cours, "date_seance": jour.isoformat(), "heure_debut": debut.strftime("%H:%M"), "heure_fin": fin.strftime("%H:%M"),
        "id_salle": salle[0], "statut": "planifiee", "id_enseignant": None, "nature": nature}}]
    return _proposer_operations(ctx, description, ops)


def _impact_operations(ctx: Contexte, ops: list[dict]) -> dict:
    """Conséquences d'opérations ponctuelles, au format de l'analyse d'impact (impact.py)."""
    ids_cours = {(o.get("apres") or o.get("avant"))["id_cours"] for o in ops}
    infos = {r[0]: r[1:] for r in ctx.conn.execute(
        """SELECT c.id_cours, cl.code_classe, c.id_enseignant FROM cours c JOIN classe cl ON cl.id_classe = c.id_classe
           WHERE c.id_cours = ANY(%s)""", (list(ids_cours),)).fetchall()}
    # Enseignants des séances, avant et après (un changement d'enseignant en concerne deux)
    touches: dict[int, int] = {}
    for o in ops:
        concernes = {s.get("id_enseignant", infos[s["id_cours"]][1]) for s in (o.get("avant"), o.get("apres")) if s}
        for e in concernes - {None}:
            touches[e] = touches.get(e, 0) + 1
    par_enseignant = {(r[1], r[2]): touches[r[0]] for r in ctx.conn.execute(
        "SELECT id_enseignant, prenom || ' ' || nom, statut FROM enseignant WHERE id_enseignant = ANY(%s)", (list(touches),)).fetchall()}
    deplacements = [o for o in ops if o["action"] == "modifier" and o["avant"]["statut"] == o["apres"]["statut"]
                    and any(o["avant"][k] != o["apres"][k] for k in ("date_seance", "heure_debut", "heure_fin", "id_salle"))]
    retirees = [o["avant"] for o in ops if o["action"] == "supprimer"]
    ajoutees = [o["apres"] for o in ops if o["action"] == "creer"]
    annulations = [o for o in ops if o["action"] == "modifier" and o["apres"]["statut"] == "annulee" != o["avant"]["statut"]]
    retablissements = [o for o in ops if o["action"] == "modifier" and o["avant"]["statut"] == "annulee" != o["apres"]["statut"]]
    return {
        "au_dela_du_rythme": _au_dela_du_rythme(ctx, ops, ids_cours),
        "seances_deplacees": len(deplacements),
        "seances_supprimees": sum(o["action"] == "supprimer" for o in ops) + len(annulations),
        "seances_creees": sum(o["action"] == "creer" for o in ops) + len(retablissements),
        "seances_retirees": _libelles_seances(ctx, retirees),
        "heures_retirees": sum(_duree(a) for a in retirees if a["statut"] != "annulee" and a.get("nature", "cours") == "cours"),
        "seances_ajoutees": _libelles_seances(ctx, ajoutees),
        "heures_perdues": [],
        "enseignants_a_prevenir": [{"enseignant": n, "statut": st, "seances_modifiees": k}
                                   for (n, st), k in sorted(par_enseignant.items())],
        "classes_concernees": sorted({infos[(o.get("apres") or o.get("avant"))["id_cours"]][0] for o in ops}),
        "fins_decalees": [],
        "journees_chargees": [],
        "changements_de_site": [],
    }


def _au_dela_du_rythme(ctx: Contexte, ops: list[dict], ids_cours: set[int]) -> list[dict]:
    """Semaines où un cours touché dépasserait son rythme souhaité (CS-08, souple), et plus qu'avant : permis,
    mais signalé au planificateur."""
    def lundi(x) -> date:
        x = date.fromisoformat(x) if isinstance(x, str) else x
        return x - timedelta(days=x.weekday())

    cours = {r[0]: (float(r[1]), f"{r[2]} {r[3]} ({r[4]})") for r in ctx.conn.execute(
        """SELECT c.id_cours, c.heures_semaine_max, m.libelle, c.type_cours, cl.code_classe FROM cours c
           JOIN matiere m USING (id_matiere) JOIN classe cl ON cl.id_classe = c.id_classe WHERE c.id_cours = ANY(%s)""",
        (list(ids_cours),)).fetchall()}
    touchees = {o["id_seance"] for o in ops if o["action"] in ("modifier", "supprimer")}
    avant: dict[tuple[int, date], float] = {}
    apres: dict[tuple[int, date], float] = {}
    for id_seance, k, jour, h in ctx.conn.execute(
            """SELECT id_seance, id_cours, date_seance, EXTRACT(EPOCH FROM heure_fin - heure_debut) / 3600 FROM seance
               WHERE id_edt = %s AND id_cours = ANY(%s) AND statut <> 'annulee' AND nature = 'cours'""",
            (ctx.id_edt, list(ids_cours))).fetchall():
        cle = (k, lundi(jour))
        avant[cle] = avant.get(cle, 0) + float(h)
        if id_seance not in touchees:
            apres[cle] = apres.get(cle, 0) + float(h)
    for o in ops:
        b = o.get("apres")
        if b and o["action"] != "supprimer" and b.get("statut") != "annulee" and b.get("nature", "cours") == "cours":
            cle = (b["id_cours"], lundi(b["date_seance"]))
            apres[cle] = apres.get(cle, 0) + _duree(b)
    return [{"cours": cours[k][1], "semaine": l.isoformat(), "heures": round(h, 2), "rythme": cours[k][0]}
            for (k, l), h in sorted(apres.items(), key=lambda x: (x[0][1], x[0][0]))
            if k in cours and h > cours[k][0] and h > avant.get((k, l), 0)]


class Suite(TypedDict):
    description: str
    mode: NotRequired[Literal["generer", "replanifier"]]
    classes: NotRequired[list[str]]
    filieres: NotRequired[list[str]]
    matieres: NotRequired[list[str]]
    du: NotRequired[str]
    au: NotRequired[str]


def proposer_changements_referentiel(ctx: Contexte, description: str, changements: list[Changement],
                                     ensuite: Suite | None = None) -> str:
    """Lignes du référentiel, du calendrier ou des enseignants à ajouter, modifier ou supprimer,
    vérifiées dans la base (écrites puis annulées) avant d'être proposées, avec les séances
    qu'elles rendraient invalides ; `ensuite` : génération ou replanification lancée une fois
    les changements validés."""
    if not changements:
        return "Demande invalide : aucun changement."
    id_semestre = ctx.conn.execute("SELECT id_semestre FROM emploi_du_temps WHERE id_edt = %s", (ctx.id_edt,)).fetchone()[0]
    try:
        ops, remarques = referentiel.preparer(ctx.conn, id_semestre, [dict(a) for a in changements])
        if ensuite:
            for cle in ("du", "au"):
                if ensuite.get(cle):
                    date.fromisoformat(ensuite[cle])
            if not ensuite.get("classes") and not ensuite.get("filieres"):
                raise ValueError("ensuite : précisez les classes ou les filières à programmer")
            if ensuite.get("mode") == "replanifier" and not (ensuite.get("du") and ensuite.get("au")):
                raise ValueError("ensuite : une replanification demande sa période (du, au)")
    except ValueError as e:
        return f"Demande invalide : {e}"
    if not ops:
        return ("Rien à changer, aucune proposition créée : le référentiel est déjà à jour.\n- " + "\n- ".join(remarques)
                + ("\nLance directement la génération demandée." if ensuite else ""))
    # Tout ensemble dans la base, puis annulation ; les séances devenues invalides sont relevées avant
    try:
        with ctx.conn.transaction():
            avant = referentiel.conflits(ctx.conn, ctx.id_edt)
            compte = referentiel.executer(ctx.conn, ops, ctx.id_edt)
            conflits = referentiel.nouveaux_conflits(avant, referentiel.conflits(ctx.conn, ctx.id_edt))
            raise _Annuler
    except _Annuler:
        pass
    except propositions.PropositionRefusee as e:
        return f"{e}. Aucune proposition créée."

    suite = dict(ensuite) if ensuite else None
    remplacees = propositions.remplacer(ctx.conn, ctx.propositions_creees)
    id_prop = propositions.creer(ctx.conn, ctx.id_prompt, ctx.id_edt, description, ops,
                                 {"lignes": len(ops), **{k: v for k, v in compte.items() if v}, "conflits": conflits},
                                 nature="referentiel", suite=suite)
    ctx.propositions_creees[:] = [id_prop]
    signe = {"ajouter_ligne": "+", "modifier_ligne": "~", "supprimer_ligne": "-"}
    lignes = [
        f"Proposition {id_prop} enregistrée : changements du référentiel, en attente de validation par un planificateur"
        + (f" (elle remplace la proposition {', '.join(map(str, remplacees))})." if remplacees else "."),
        "Tous les changements ont été vérifiés ensemble par la base ; rien n'est écrit avant validation.",
        *[f"  {signe.get(o['action'], '~')} {o['libelle']}" for o in ops],
        *remarques,
    ]
    if conflits:
        n = sum(c["nombre"] for c in conflits)
        lignes.append(f"Attention : une fois appliqués, ces changements laisseraient {n} séance(s) ou cours hors des règles "
                      "(rien n'est déplacé automatiquement) :")
        for c in conflits:
            periode = (f" le {c['du']}" if c["du"] == c["au"] else f" du {c['du']} au {c['au']}") if c["du"] else ""
            lignes.append(f"  {c['regle']} : {c['nombre']}{periode}, par exemple " + " ; ".join(c["exemples"][:3]))
        if not suite:
            lignes.append("Propose de les replanifier : refais la proposition avec ensuite (mode replanifier, classes concernées, "
                          "période du/au), ou propose une replanification séparée une fois les changements validés.")
    if suite:
        quoi = "la replanification" if suite.get("mode") == "replanifier" else "la génération"
        lignes.append(f"Une fois les changements validés, {quoi} sera lancée automatiquement : {suite['description']}. "
                      "Son résultat sera une nouvelle proposition, à valider à son tour.")
    return "\n".join(lignes)


def lire_piece_jointe(ctx: Contexte, id_piece: int | None = None, debut: int = 1, nombre: int = 100) -> str:
    return pieces_jointes.extrait(ctx.conn, ctx.id_prompt, id_piece, debut, nombre)


class Priorite(TypedDict):
    id_cours: int
    priorite: int
    justification: str


def proposer_priorites(ctx: Contexte, suggestions: list[Priorite]) -> str:
    n = 0
    for s in suggestions:
        n += ctx.conn.execute(
            "UPDATE cours SET priorite_suggeree = %s, justification_priorite = %s WHERE id_cours = %s",
            (s["priorite"], s["justification"], s["id_cours"]),
        ).rowcount
    return f"{n} priorité(s) suggérée(s) enregistrée(s). La scolarité les accepte ou non dans le référentiel des cours."


# --- déclaration des outils de l'agent --------------------------------------------

def construire_outils(ctx: Contexte) -> list[Outil]:
    @outil("lire_emploi_du_temps")
    def lire_emploi_du_temps_outil(du: str, au: str, code_classe: str | None = None, matricule: str | None = None,
                                   code_salle: str | None = None, code_matiere: str | None = None) -> str:
        """Liste les séances de l'emploi du temps de travail sur une période, avec leurs identifiants
        (séance, cours, salle). Filtrer par classe, enseignant ou salle quand c'est possible.

        Args:
            du: Première date incluse, AAAA-MM-JJ.
            au: Dernière date incluse, AAAA-MM-JJ.
            code_classe: Code de classe, par exemple L2INFO.
            matricule: Matricule d'enseignant, par exemple ENS-001.
            code_salle: Code de salle, par exemple K-A101.
            code_matiere: Code ou nom de la matière.
        """
        return lire_emploi_du_temps(ctx, du, au, code_classe, matricule, code_salle, code_matiere)

    @outil("lire_referentiel")
    def lire_referentiel_outil(sujet: SUJETS) -> str:
        """Lit le référentiel : cours (identifiants, volumes, heures déjà planifiées, rythme, priorités),
        classes, groupes et filières, matières (codes), enseignants (statut, indisponibilités, absences,
        séjours), salles (avec types de salle et sites), programme des classes, ou calendrier (semestre, grille, pauses, jours fériés, congés).

        Args:
            sujet: Partie du référentiel à lire.
        """
        return lire_referentiel(ctx, sujet)

    @outil("verifier_seance")
    def verifier_seance_outil(id_cours: int, date_seance: str, heure_debut: str, heure_fin: str,
                              id_salle: int, id_seance: int | None = None) -> str:
        """Teste une séance (nouvelle, ou déplacement d'une séance existante si id_seance est donné)
        contre toutes les règles de la base, sans rien enregistrer. Renvoie « Acceptée » ou le motif
        du refus avec son code (CD-01 à CD-13).

        Args:
            id_cours: Identifiant du cours.
            date_seance: Date, AAAA-MM-JJ.
            heure_debut: Heure de début, HH:MM (alignée sur un créneau).
            heure_fin: Heure de fin, HH:MM.
            id_salle: Identifiant de la salle.
            id_seance: Identifiant de la séance à déplacer, si c'est un déplacement.
        """
        return verifier_seance(ctx, id_cours, date_seance, heure_debut, heure_fin, id_salle, id_seance)

    @outil("proposer_replanification")
    def proposer_replanification_outil(description: str, du: str, au: str, classes: list[str] | None = None,
                                       filieres: list[str] | None = None, id_cours: list[int] | None = None,
                                       contraintes: list[Fenetre] | None = None) -> str:
        """Demande au solveur de replanifier un périmètre sur une période en changeant le moins de
        séances possible, avec des contraintes ajoutées (imposer ou interdire une fenêtre de jours,
        d'heures et de dates pour un cours, une classe ou un enseignant). Le résultat est une
        proposition, que le planificateur valide. Seules les séances déjà dans la période sont concernées :
        pour y faire venir les autres séances d'un cours, utiliser proposer_reprogrammation_cours.
        Prendre le périmètre le plus étroit possible (une classe ou quelques cours). La période est
        étendue aux semaines entières (lundi–samedi) ; l'élargir à la semaine suivante si des heures
        restent non placées.

        Args:
            description: Résumé en une phrase de la modification demandée, pour le planificateur.
            du: Début de la période à replanifier, AAAA-MM-JJ (étendu au lundi de sa semaine).
            au: Fin de la période, AAAA-MM-JJ (étendue au samedi de sa semaine).
            classes: Codes des classes du périmètre.
            filieres: Codes des filières du périmètre.
            id_cours: Identifiants des cours du périmètre.
            contraintes: Fenêtres imposées ou interdites ; heures au format HH:MM, dates AAAA-MM-JJ.
        """
        return proposer_replanification(ctx, description, du, au, classes, filieres, id_cours, contraintes)

    @outil("proposer_reprogrammation_cours")
    def proposer_reprogrammation_cours_outil(description: str, id_cours: list[int], du: str, au: str) -> str:
        """Reprogramme des cours dans une période : à appeler directement pour « reprogramme les cours
        restants de X entre A et B », « relance X sur cette période », « finis X avant le… », « X doit
        commencer le… et finir le… ». Toutes leurs séances à venir, prévues avant ou après la période,
        y sont ramenées, au plus près de leur date et dans leur salle si elle est libre ; les séances
        verrouillées ne bougent pas, et celles qui n'y trouvent pas de place restent où elles sont et
        sont signalées avec leur motif. Le résultat est une proposition, que le planificateur valide. C'est
        cet outil qui dit si quelque chose change : ne conclus jamais toi-même que c'est déjà planifié.

        Args:
            description: Résumé en une phrase de la modification demandée, pour le planificateur.
            id_cours: Identifiants des cours à reprogrammer (dans lire_referentiel, sujet cours).
            du: Début de la période, AAAA-MM-JJ (étendu au lundi de sa semaine, jamais dans le passé).
            au: Fin de la période, AAAA-MM-JJ (étendue au samedi de sa semaine).
        """
        return proposer_reprogrammation_cours(ctx, description, id_cours, du, au)

    @outil("proposer_generation")
    def proposer_generation_outil(description: str, classes: list[str] | None = None,
                                  filieres: list[str] | None = None, du: str | None = None,
                                  au: str | None = None, matieres: list[str] | None = None) -> str:
        """Demande au solveur de générer l'emploi du temps d'une ou plusieurs classes ou filières :
        tout le reste du semestre (« le programme du semestre »), ou seulement une ou deux semaines
        (« planifie la semaine du 2 novembre »). Les séances non verrouillées du périmètre sur la
        période sont recalculées, en respectant les règles dures et au mieux les bonnes pratiques.
        Sur une période courte, chaque cours reçoit sa part du volume restant selon son rythme
        (heures par semaine), ses contraintes et les disponibilités ; le reste est reporté aux
        semaines suivantes. Avec `matieres`, seuls les modules nommés sont programmés (« les modules
        Big Data et Computer Vision de la L3IA ») ; si un module n'est pas prêt (matière inconnue,
        hors programme, sans cours), le résultat dit quoi créer dans le référentiel. Pour un
        changement ponctuel de séances existantes, utiliser proposer_replanification. Le résultat
        est une proposition, que le planificateur valide.

        Args:
            description: Résumé en une phrase de la demande, pour le planificateur.
            classes: Codes des classes, par exemple M1IA.
            filieres: Codes des filières, par exemple IA.
            du: Début, AAAA-MM-JJ (défaut : lundi de la semaine prochaine ; jamais dans le passé).
            au: Fin, AAAA-MM-JJ, étendue au samedi de sa semaine (défaut : fin du semestre).
            matieres: Matières (modules) à programmer seulement, par code ou par nom, par exemple ["Big Data", "ML"] ; vide = toutes.
        """
        return proposer_generation(ctx, description, classes, filieres, du, au, matieres)

    @outil("proposer_modifications")
    def proposer_modifications_outil(description: str, operations: list[OperationSeance]) -> str:
        """Fait des changements ponctuels de séances précises : déplacer (nouvelle date, nouvelles
        heures, autre salle), annuler, rétablir une séance annulée, ajouter une séance d'un cours,
        supprimer une séance, changer l'enseignant d'une séance (ou le retirer : à désigner). Toutes les opérations sont vérifiées ensemble dans la base (règles CD-01
        à CD-13) puis enregistrées comme une proposition, que le planificateur valide ; si l'une est
        refusée, aucune proposition n'est créée et le motif est renvoyé. Prendre les identifiants (séance, cours, salle) dans lire_emploi_du_temps. Pour
        libérer une journée ou absorber une absence, préférer proposer_replanification.

        Args:
            description: Résumé en une phrase de la modification, pour le planificateur.
            operations: Opérations, dans l'ordre. deplacer : id_seance et au moins une nouveauté (date_seance AAAA-MM-JJ, heure_debut HH:MM, heure_fin HH:MM ou id_salle ; même durée par défaut). annuler / retablir / supprimer : id_seance. ajouter : id_cours, date_seance, heure_debut, heure_fin, id_salle (matricule facultatif : sinon l'enseignant prévu du cours). changer_enseignant : id_seance, matricule (chaîne vide pour retirer l'enseignant). deplacer accepte aussi matricule.
        """
        return proposer_modifications(ctx, description, operations)

    @outil("proposer_suppression_seances")
    def proposer_suppression_seances_outil(description: str, code_classe: str | None = None, matricule: str | None = None,
                                           code_salle: str | None = None, code_matiere: str | None = None,
                                           code_groupe: str | None = None, type_cours: Literal["CM", "TD", "TP"] | None = None,
                                           du: str | None = None, au: str | None = None,
                                           jours: list[Literal["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]] | None = None,
                                           heure_min: str | None = None, heure_max: str | None = None,
                                           id_seances: list[int] | None = None, inclure_verrouillees: bool = False,
                                           nature: Literal["cours", "examen", "rattrapage"] | None = None) -> str:
        """Supprime des séances de l'emploi du temps d'une classe, d'un enseignant ou d'une
        salle : elles disparaissent de la grille et leurs heures redeviennent à programmer (pour les
        garder barrées à l'écran, c'est une annulation). Les critères se cumulent ; il n'y a pas à lire
        l'emploi du temps ni à lister les identifiants. Le résultat est une proposition : sa carte montre
        chaque séance au planificateur, qui la valide ; l'historique permet ensuite de les récupérer.

        Args:
            description: Résumé en une phrase de la suppression, pour le planificateur.
            code_classe: Emploi du temps de cette classe (cours mutualisés compris).
            matricule: Emploi du temps de cet enseignant.
            code_salle: Emploi du temps de cette salle.
            code_matiere: Seulement cette matière (code ou nom).
            code_groupe: Seulement ce groupe.
            type_cours: Seulement ce type de cours.
            du: Première date incluse, AAAA-MM-JJ. Absente : à partir d'aujourd'hui. Pour inclure des séances passées, la donner.
            au: Dernière date incluse, AAAA-MM-JJ. Absente : jusqu'à la fin du semestre.
            jours: Seulement ces jours de la semaine.
            heure_min: Seulement les séances qui finissent après cette heure, HH:MM (l'après-midi : 13:00).
            heure_max: Seulement les séances qui commencent avant cette heure, HH:MM (le matin : 12:00).
            id_seances: Séances précises, lues dans l'emploi du temps, quand les critères ne suffisent pas.
            inclure_verrouillees: Vrai seulement si le planificateur a confirmé : sinon les séances verrouillées restent en place.
            nature: examen ou rattrapage pour retirer une épreuve. Absente : seulement les cours, les épreuves restent en place.
        """
        return proposer_suppression_seances(ctx, description, code_classe, matricule, code_salle, code_matiere, code_groupe,
                                            type_cours, du, au, jours, heure_min, heure_max, id_seances, inclure_verrouillees, nature)

    @outil("proposer_epreuve")
    def proposer_epreuve_outil(description: str, code_classe: str, code_matiere: str, date_seance: str, heure_debut: str, heure_fin: str,
                               nature: Literal["examen", "rattrapage"] = "examen", code_salle: str | None = None,
                               site: str | None = None) -> str:
        """Propose de programmer un examen ou un rattrapage d'un module pour une classe entière. Une
        épreuve dure de 2 h à 3 h, n'a pas d'enseignant et ne compte ni dans le volume ni dans le rythme
        du cours ni dans les matières de la semaine. Plusieurs classes peuvent composer dans une même
        salle assez grande, jamais avec un cours. Le rattrapage d'un module vient après son examen.
        Vérifié dans la base, puis enregistré comme une proposition, que le planificateur valide.

        Args:
            description: Résumé en une phrase, pour le planificateur.
            code_classe: Classe qui compose.
            code_matiere: Module : code ou nom de la matière.
            date_seance: Date, AAAA-MM-JJ.
            heure_debut: Heure de début, HH:MM.
            heure_fin: Heure de fin, HH:MM.
            nature: examen (défaut) ou rattrapage.
            code_salle: Salle choisie. Absente : la plus petite salle libre assez grande.
            site: Campus (code ou nom), pour choisir la salle sur ce campus quand elle n'est pas donnée.
        """
        return proposer_epreuve(ctx, description, code_classe, code_matiere, date_seance, heure_debut, heure_fin, nature, code_salle, site)

    @outil("lire_piece_jointe")
    def lire_piece_jointe_outil(id_piece: int | None = None, debut: int = 1, nombre: int = 100) -> str:
        """Lit le texte d'un fichier joint à la discussion (CSV, Excel, PDF, texte), par morceaux de
        lignes numérotées. Lire tout le fichier, morceau par morceau, avant d'en tirer des ajouts.

        Args:
            id_piece: Numéro de la pièce jointe (défaut : la dernière jointe à la discussion).
            debut: Première ligne à lire (1 pour le début).
            nombre: Nombre de lignes à lire, 200 au plus.
        """
        return lire_piece_jointe(ctx, id_piece, debut, nombre)

    @outil("proposer_changements_referentiel")
    def proposer_changements_referentiel_outil(description: str, changements: list[Changement],
                                               ensuite: Suite | None = None) -> str:
        """Propose d'ajouter, de modifier ou de supprimer des lignes du référentiel, du calendrier
        et des enseignants. Lignes désignées par leurs codes (jamais d'identifiant), dans
        n'importe quel ordre : une matière ajoutée sert à son programme et à ses cours. Tout est
        vérifié dans la base ; rien n'est écrit avant validation. Le résultat signale les séances
        que les changements rendraient invalides (jour férié, absence...). N'invente aucune
        valeur : demande-la ou lis-la dans le fichier joint.

        Args:
            description: Résumé en une phrase des changements.
            changements: Lignes. ajouter : tous les champs dans valeurs. modifier : la ligne dans cle, seulement les champs qui changent dans valeurs (null pour vider un champ facultatif). supprimer : la ligne dans cle. Champs par table (clé entre crochets, facultatifs entre parenthèses) : classe [code_classe], libelle, niveau L1..M2|CPGE1|CPGE2|BT|MAN|AUTRE, code_filiere (effectif, site, salle_principale : code ou nom de sa salle de cours habituelle, préférée par la génération) ; matiere [code_matiere], libelle (coefficient) ; enseignant [matricule], nom, prenom (email, telephone, grade, statut permanent|vacataire_local|externe, nb_heures_max_semaine, site) ; salle [code_salle], nom_salle, capacite, type_salle, site (batiment, est_disponible) ; programme [code_classe, code_matiere], volume_cm / volume_td / volume_tp en heures (au moins un) ; cours [code_classe, code_matiere, type_cours CM|TD|TP, (code_groupe)], volume_horaire (matricule, duree_seance 2 à 4, nb_seances_semaine, heures_semaine_min, heures_semaine_max, type_salle, priorite) ; semestre (celui de l'emploi du temps, modifier seulement, sans cle) libelle, date_debut, date_fin ; jour_ferie [date_ferie], libelle ; conge [libelle, date_debut, (code_classe)], date_fin (type_conge vacances|examens|stage|autre, code_classe : vide pour toutes les classes) ; creneau [jour, heure_debut, heure_fin] (ajouter ou supprimer) ; disponibilite matricule, jour, heure_debut, heure_fin (plage couvrant un ou plusieurs créneaux), niveau disponible|preference|indisponible (motif) ; supprimer une disponibilité la remet à « disponible » ; absence [matricule, date_debut], date_fin (motif) ; sejour [matricule, date_debut], date_fin (commentaire). Dates AAAA-MM-JJ, heures HH:MM.
            ensuite: Lancé après validation : description, mode generer (défaut) ou replanifier (séances devenues invalides, en changeant le moins possible), classes ou filieres, matieres, du, au (obligatoires pour replanifier).
        """
        return proposer_changements_referentiel(ctx, description, changements, ensuite)

    @outil("proposer_priorites")
    def proposer_priorites_outil(suggestions: list[Priorite]) -> str:
        """Enregistre des priorités suggérées pour des cours (plus haut = commence plus tôt), chacune
        avec une justification courte : prérequis, intervenant externe à placer pendant son séjour,
        volume important… Ce ne sont que des suggestions, que la scolarité accepte ou non.

        Args:
            suggestions: Une entrée par cours.
        """
        return proposer_priorites(ctx, suggestions)

    return [lire_emploi_du_temps_outil, lire_referentiel_outil, verifier_seance_outil,
            proposer_replanification_outil, proposer_reprogrammation_cours_outil, proposer_generation_outil, proposer_modifications_outil,
            proposer_suppression_seances_outil, proposer_epreuve_outil, lire_piece_jointe_outil, proposer_changements_referentiel_outil, proposer_priorites_outil]
