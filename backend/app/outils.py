"""Outils de l'assistant IA.

Chaque outil est une fonction ordinaire (testable sans modèle) qui renvoie un
texte lisible par le modèle. `construire_outils` les déclare comme outils
d'agent (schéma JSON déduit de la signature), liés à une conversation :
connexion, emploi du temps et message en cours.

L'agent ne modifie jamais les séances : il lit, vérifie, demande au solveur
une replanification, et enregistre le résultat comme PROPOSITION. Seule
exception : les priorités suggérées, qui ne sont que des suggestions.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time, timedelta
from typing import Literal, NotRequired, TypedDict

import psycopg

from ultraplanning_solver import ContrainteAjoutee, Demande, Perimetre, generer
from ultraplanning_solver.base import charger, verifier
from ultraplanning_solver.donnees import Seance, lundi_de

from . import impact, propositions
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

def lire_emploi_du_temps(ctx: Contexte, du: str, au: str, code_classe: str | None = None,
                         matricule: str | None = None, code_salle: str | None = None) -> str:
    filtres, params = ["s.id_edt = %s", "s.date_seance BETWEEN %s AND %s"], [ctx.id_edt, du, au]
    if code_classe:
        filtres.append("cl.code_classe = %s")
        params.append(code_classe)
    if matricule:
        filtres.append("e.matricule = %s")
        params.append(matricule)
    if code_salle:
        filtres.append("sa.code_salle = %s")
        params.append(code_salle)
    rows = ctx.conn.execute(
        f"""SELECT s.id_seance, s.date_seance, s.heure_debut, s.heure_fin, s.statut, s.est_verrouillee,
                   c.id_cours, m.libelle, c.type_cours, cl.code_classe, g.code_groupe,
                   e.matricule, e.nom, sa.id_salle, sa.code_salle
            FROM seance s JOIN cours c USING (id_cours) JOIN matiere m USING (id_matiere)
            JOIN classe cl ON cl.id_classe = c.id_classe LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
            JOIN enseignant e ON e.id_enseignant = c.id_enseignant JOIN salle sa ON sa.id_salle = s.id_salle
            WHERE {' AND '.join(filtres)} ORDER BY s.date_seance, s.heure_debut""",
        params,
    ).fetchall()
    jours = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
    return _tronquer([
        f"séance {r[0]} | {jours[r[1].weekday()]} {r[1]} {_h(r[2])}-{_h(r[3])} | {r[7]} {r[8]} "
        f"| {r[9]}{' · ' + r[10] if r[10] else ''} | {r[12]} ({r[11]}) | salle {r[14]} (id {r[13]}) "
        f"| cours {r[6]}{' | annulée' if r[4] == 'annulee' else ''}{' | verrouillée' if r[5] else ''}"
        for r in rows
    ])


SUJETS = Literal["cours", "classes", "enseignants", "salles", "programme", "calendrier"]


def lire_referentiel(ctx: Contexte, sujet: str) -> str:
    q = ctx.conn.execute
    if sujet == "cours":
        rows = q(
            """SELECT c.id_cours, m.code_matiere, m.libelle, c.type_cours, cl.code_classe, g.code_groupe,
                      e.matricule, e.nom, e.statut, c.volume_horaire, c.heures_semaine_min, c.heures_semaine_max,
                      c.priorite, c.priorite_suggeree,
                      COALESCE((SELECT sum(EXTRACT(EPOCH FROM s.heure_fin - s.heure_debut)) / 3600 FROM seance s
                                WHERE s.id_cours = c.id_cours AND s.id_edt = %s AND s.statut <> 'annulee'), 0)
               FROM cours c JOIN matiere m USING (id_matiere) JOIN classe cl ON cl.id_classe = c.id_classe
               LEFT JOIN groupe g ON g.id_groupe = c.id_groupe JOIN enseignant e ON e.id_enseignant = c.id_enseignant
               JOIN emploi_du_temps t ON t.id_edt = %s AND t.id_semestre = c.id_semestre
               ORDER BY c.id_cours""",
            (ctx.id_edt, ctx.id_edt),
        ).fetchall()
        return _tronquer([
            f"cours {r[0]} | {r[2]} ({r[1]}) {r[3]} | {r[4]}{' · ' + r[5] if r[5] else ''} | {r[7]} ({r[6]}, {r[8]}) "
            f"| {float(r[14]):g}/{float(r[9]):g} h planifiées | rythme {float(r[10]):g}–{float(r[11]):g} h/sem "
            f"| priorité {r[12]}{f' (suggérée {r[13]})' if r[13] is not None else ''}"
            for r in rows
        ])
    if sujet == "classes":
        rows = q(
            """SELECT cl.code_classe, cl.libelle, cl.niveau, cl.effectif, f.code_filiere,
                      string_agg(g.code_groupe || ' ' || g.type_groupe || ' (' || g.effectif || ')', ', ' ORDER BY g.code_groupe)
               FROM classe cl JOIN filiere f USING (id_filiere) LEFT JOIN groupe g ON g.id_classe = cl.id_classe
               GROUP BY cl.id_classe, f.code_filiere ORDER BY cl.code_classe"""
        ).fetchall()
        return _tronquer([f"{r[0]} | {r[1]} ({r[2]}) | filière {r[4]} | {r[3]} étudiants | groupes : {r[5] or 'aucun'}" for r in rows])
    if sujet == "enseignants":
        rows = q(
            """SELECT e.matricule, e.prenom, e.nom, e.statut, e.nb_heures_max_semaine,
                      (SELECT string_agg(c.jour || ' ' || to_char(c.heure_debut, 'HH24"h"'), ', ' ORDER BY c.id_creneau)
                       FROM disponibilite d JOIN creneau c USING (id_creneau)
                       WHERE d.id_enseignant = e.id_enseignant AND d.niveau = 'indisponible'),
                      (SELECT string_agg(a.date_debut || ' → ' || a.date_fin || coalesce(' (' || a.motif || ')', ''), '; ')
                       FROM absence_enseignant a WHERE a.id_enseignant = e.id_enseignant),
                      (SELECT string_agg(j.date_debut || ' → ' || j.date_fin, '; ')
                       FROM sejour_enseignant j WHERE j.id_enseignant = e.id_enseignant)
               FROM enseignant e ORDER BY e.nom"""
        ).fetchall()
        return _tronquer([
            f"{r[0]} | {r[1]} {r[2]} | {r[3]} | max {r[4] or '–'} h/sem | indisponible : {r[5] or 'jamais'} "
            f"| absences : {r[6] or 'aucune'}{f' | séjours : {r[7]}' if r[7] else ''}"
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
        ])
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
            "SELECT s.libelle, s.date_debut, s.date_fin, e.version, e.statut FROM emploi_du_temps e "
            "JOIN semestre s USING (id_semestre) WHERE e.id_edt = %s", (ctx.id_edt,)
        ).fetchone()
        feries = q("SELECT date_ferie, libelle FROM jour_ferie ORDER BY 1").fetchall()
        conges = q("SELECT libelle, date_debut, date_fin FROM conge ORDER BY 2").fetchall()
        pauses = q("SELECT libelle, heure_debut, heure_fin FROM pause").fetchall()
        mat = q("SELECT valeur FROM contrainte WHERE id_edt = %s AND type_contrainte = 'CD-13' AND est_active", (ctx.id_edt,)).fetchone()
        return "\n".join([
            f"{sem[0]} : du {sem[1]} au {sem[2]} ; emploi du temps version {sem[3]} ({sem[4]})",
            "Grille : créneaux de 1 h, 7h–12h et 13h–16h du lundi au vendredi, 7h–12h le samedi.",
            "Pauses : " + ", ".join(f"{p[0]} {_h(p[1])}–{_h(p[2])}" for p in pauses),
            f"Au plus {int(mat[0]) if mat and mat[0] else 3} matières par classe et par semaine (CD-13).",
            "Jours fériés : " + ", ".join(f"{f[0]} ({f[1]})" for f in feries),
            "Congés : " + ("; ".join(f"{c[0]} du {c[1]} au {c[2]}" for c in conges) or "aucun"),
        ])
    return f"Sujet inconnu : {sujet}. Sujets possibles : cours, classes, enseignants, salles, programme, calendrier."


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
                             id_cours: list[int] | None = None, contraintes: list[Fenetre] | None = None) -> str:
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
    except (ValueError, TypeError) as e:
        return f"Demande invalide : {e}"
    if fin < debut:
        return "Demande invalide : la date de fin précède la date de début."

    return _proposer(ctx, description, Demande(perimetre=perimetre, du=debut, au=fin, contraintes=ajoutees,
                                               minimiser_changements=True, temps_max_placement=4),
                     f"Période replanifiée : semaines entières du {debut} au {fin}.")


def proposer_generation(ctx: Contexte, description: str, classes: list[str] | None = None,
                        filieres: list[str] | None = None, du: str | None = None, au: str | None = None) -> str:
    """Génération d'une classe ou d'une filière, sur tout le reste du semestre ou sur une période
    courte (une ou deux semaines) : les séances non verrouillées du périmètre et de la période sont
    recalculées. Sur une période courte, le solveur répartit le volume restant jusqu'à la fin du
    semestre selon le rythme des cours et ne place que la période ; le reste est reporté."""
    if not classes and not filieres:
        return "Demande invalide : précisez au moins une classe ou une filière (pas tout l'établissement)."
    try:
        perimetre = Perimetre(
            id_filieres=frozenset(_ids(ctx.conn, "filiere", "code_filiere", filieres or [])),
            id_classes=frozenset(_ids(ctx.conn, "classe", "code_classe", classes or [])),
        )
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
    return _proposer(ctx, description, Demande(perimetre=perimetre, du=debut, au=fin, temps_max_placement=5),
                     f"Période générée : du {debut} au {fin}.")


def _proposer(ctx: Contexte, description: str, demande: Demande, periode: str) -> str:
    """Calcule la demande avec le solveur et l'enregistre comme proposition en attente, avec son impact."""
    d = charger(ctx.conn, ctx.id_edt)
    r = generer(d, demande)
    ops = r.modifications()
    noms = dict(ctx.conn.execute("SELECT id_matiere, libelle FROM matiere").fetchall())
    consequences = impact.analyser(d, r, noms)
    # Une seule proposition par message : une nouvelle tentative remplace la précédente
    remplacees = propositions.remplacer(ctx.conn, ctx.propositions_creees)
    id_prop = propositions.creer(ctx.conn, ctx.id_prompt, ctx.id_edt, description, ops, consequences)
    ctx.propositions_creees[:] = [id_prop]

    lignes = [
        f"Proposition {id_prop} enregistrée (en attente de validation par un planificateur)"
        + (f", elle remplace la proposition {', '.join(map(str, remplacees))}." if remplacees else "."),
        periode,
        f"{sum(1 for o in ops if o['action'] == 'supprimer')} séance(s) retirée(s), "
        f"{sum(1 for o in ops if o['action'] == 'creer')} séance(s) créée(s) ; "
        f"{r.heures_placees} h placées sur {r.statistiques['heures_demandees']} h à programmer dans le périmètre.",
    ]
    dates = sorted(s.date_seance for s in r.seances)
    if dates:
        lignes.append(f"Séances calculées : du {dates[0]} au {dates[-1]} (le cours est terminé quand son volume est épuisé).")
    if r.non_places:
        lignes.append("Heures non placées :")
        lignes += [f"  cours {n.id_cours} : {n.heures} h ({n.code}) {n.raison}" for n in r.non_places[:10]]
    lignes += impact.resume(consequences)
    lignes.append("Détail des opérations :")
    for o in ops[:15]:
        s = o.get("apres") or o.get("avant")
        lignes.append(f"  {o['action']} : cours {s['id_cours']} le {s['date_seance']} {s['heure_debut']}–{s['heure_fin']} salle {s['id_salle']}")
    if len(ops) > 15:
        lignes.append(f"  … et {len(ops) - 15} autres opérations")
    return "\n".join(lignes)


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
    def lire_emploi_du_temps_outil(du: str, au: str, code_classe: str | None = None,
                                   matricule: str | None = None, code_salle: str | None = None) -> str:
        """Liste les séances de l'emploi du temps de travail sur une période, avec leurs identifiants
        (séance, cours, salle). Filtrer par classe, enseignant ou salle quand c'est possible.

        Args:
            du: Première date incluse, AAAA-MM-JJ.
            au: Dernière date incluse, AAAA-MM-JJ.
            code_classe: Code de classe, par exemple L2INFO.
            matricule: Matricule d'enseignant, par exemple ENS-001.
            code_salle: Code de salle, par exemple K-A101.
        """
        return lire_emploi_du_temps(ctx, du, au, code_classe, matricule, code_salle)

    @outil("lire_referentiel")
    def lire_referentiel_outil(sujet: SUJETS) -> str:
        """Lit le référentiel : cours (identifiants, volumes, heures déjà planifiées, rythme, priorités),
        classes et groupes, enseignants (statut, indisponibilités, absences, séjours), salles,
        programme des classes, ou calendrier (semestre, grille, pauses, jours fériés, congés).

        Args:
            sujet: Partie du référentiel à lire.
        """
        return lire_referentiel(ctx, sujet)

    @outil("verifier_seance")
    def verifier_seance_outil(id_cours: int, date_seance: str, heure_debut: str, heure_fin: str,
                              id_salle: int, id_seance: int | None = None) -> str:
        """Teste une séance (nouvelle, ou déplacement d'une séance existante si id_seance est donné)
        contre toutes les règles de la base, sans rien enregistrer. Renvoie « Acceptée » ou le motif
        du refus avec son code (CD-01 à CD-14).

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
        d'heures et de dates pour un cours, une classe ou un enseignant). Le résultat est enregistré
        comme proposition en attente : rien n'est appliqué tant qu'un planificateur ne l'a pas validé.
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

    @outil("proposer_generation")
    def proposer_generation_outil(description: str, classes: list[str] | None = None,
                                  filieres: list[str] | None = None, du: str | None = None,
                                  au: str | None = None) -> str:
        """Demande au solveur de générer l'emploi du temps d'une ou plusieurs classes ou filières :
        tout le reste du semestre (« le programme du semestre »), ou seulement une ou deux semaines
        (« planifie la semaine du 2 novembre »). Les séances non verrouillées du périmètre sur la
        période sont recalculées, en respectant les règles dures et au mieux les bonnes pratiques.
        Sur une période courte, chaque cours reçoit sa part du volume restant selon son rythme
        (heures par semaine), ses contraintes et les disponibilités ; le reste est reporté aux
        semaines suivantes. Pour un changement ponctuel de séances existantes, utiliser
        proposer_replanification. Le résultat est une proposition en attente de validation.

        Args:
            description: Résumé en une phrase de la demande, pour le planificateur.
            classes: Codes des classes, par exemple M1IA.
            filieres: Codes des filières, par exemple IA.
            du: Début, AAAA-MM-JJ (défaut : lundi de la semaine prochaine ; jamais dans le passé).
            au: Fin, AAAA-MM-JJ, étendue au samedi de sa semaine (défaut : fin du semestre).
        """
        return proposer_generation(ctx, description, classes, filieres, du, au)

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
            proposer_replanification_outil, proposer_generation_outil, proposer_priorites_outil]
