"""Publication de l'emploi du temps et notification des enseignants (BF-19, BF-20).

Chaque semestre a une version à jour, seule modifiable, et une copie publiée, celle que
voient les invités. Publier reporte sur cette copie les différences avec la version à jour.
Seuls les enseignants concernés par un changement reçoivent un e-mail : leurs séances
ajoutées, annulées, retirées ou mises à jour, et le lien vers leur emploi du temps (toutes
leurs séances pour une première publication). Les étudiants n'ont pas d'adresse dans la
base : ils consultent l'espace invités.

Les e-mails partent en tâche de fond par le serveur SMTP configuré (config.SMTP_*),
après la validation de la publication.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from email.message import EmailMessage

import psycopg
from fastapi import APIRouter, Depends, HTTPException

from . import config
from .auth import Utilisateur, utilisateur_courant
from .db import connexion, origine

routeur = APIRouter()
journal = logging.getLogger("ultraplanning.notifications")
_executeur = ThreadPoolExecutor(max_workers=1)

JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]
MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]


@dataclass(frozen=True)
class Message:
    destinataire: str
    sujet: str
    texte: str


def smtp_configure() -> bool:
    return bool(config.SMTP_HOST and config.SMTP_FROM)


def envoyer(messages: list[Message]) -> tuple[int, list[str]]:
    """Envoie les messages sur une seule connexion SMTP ; renvoie (envoyés, adresses en échec)."""
    envoyes, echecs = 0, []
    contexte = ssl.create_default_context()
    smtp = (smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, context=contexte, timeout=30)
            if config.SMTP_PORT == 465 else smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30))
    with smtp:
        if config.SMTP_PORT != 465:
            smtp.starttls(context=contexte)
        if config.SMTP_USER:
            smtp.login(config.SMTP_USER, config.SMTP_PASSWORD)
        for m in messages:
            e = EmailMessage()
            e["From"], e["To"], e["Subject"] = config.SMTP_FROM, m.destinataire, m.sujet
            e.set_content(m.texte)
            try:
                smtp.send_message(e)
                envoyes += 1
            except smtplib.SMTPException:
                echecs.append(m.destinataire)
    return envoyes, echecs


def _envoyer_en_fond(messages: list[Message]) -> None:
    try:
        envoyes, echecs = envoyer(messages)
        journal.info("notifications : %d envoyées, échecs : %s", envoyes, ", ".join(echecs) or "aucun")
    except (OSError, smtplib.SMTPException):
        journal.exception("notifications : envoi impossible")


def planifier(messages: list[Message]) -> None:
    """Envoi en tâche de fond (la publication n'attend pas le serveur SMTP)."""
    _executeur.submit(_envoyer_en_fond, messages)


def _ligne(s) -> str:
    d = s["date_seance"]
    return (f"{JOURS[d.weekday()]} {d.day} {MOIS[d.month - 1]} {s['heure_debut']:%H:%M}–{s['heure_fin']:%H:%M} · "
            f"{s['matiere']} ({s['type_cours']}) · {s['classe']} · {s['salle']}")


def _seances(conn: psycopg.Connection, id_edt: int | None) -> list[dict]:
    """Séances d'un emploi du temps, avec ce qu'il faut pour les comparer et les décrire."""
    if id_edt is None:
        return []
    rows = conn.execute(
        """SELECT s.id_seance, s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle, s.statut,
                  c.type_cours, s.id_enseignant, m.libelle, cl.code_classe || coalesce(' · ' || g.code_groupe, ''), sa.nom_salle, s.nature
           FROM seance s JOIN cours c USING (id_cours, id_ecole) JOIN matiere m USING (id_matiere, id_ecole)
           JOIN classe cl ON cl.id_classe = c.id_classe JOIN salle sa ON sa.id_salle = s.id_salle
           LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
           WHERE s.id_edt = %s ORDER BY s.date_seance, s.heure_debut, s.id_seance""", (id_edt,),
    ).fetchall()
    cles = ("id_seance", "id_cours", "date_seance", "heure_debut", "heure_fin", "id_salle", "statut",
            "type_cours", "id_enseignant", "matiere", "classe", "salle", "nature")
    return [dict(zip(cles, r)) for r in rows]


# Ce que voient les invités : le verrouillage, propre au travail de planification, n'en fait pas partie
_VISIBLE = ("id_cours", "date_seance", "heure_debut", "heure_fin", "statut", "id_enseignant", "id_salle", "nature")
_ENDROIT = ("date_seance", "heure_debut", "heure_fin", "id_salle")


@dataclass
class Differences:
    ajoutees: list[dict]
    retirees: list[dict]
    modifiees: list[tuple[dict, dict]]  # (avant, après)

    @property
    def vide(self) -> bool:
        return not (self.ajoutees or self.retirees or self.modifiees)


def comparer(avant: list[dict], apres: list[dict]) -> Differences:
    """Ce qui change entre deux états. Une séance retirée et une séance ajoutée du même cours sont
    une même séance modifiée : d'abord celles du même créneau, puis dans l'ordre chronologique."""
    identiques: dict[tuple, list[dict]] = defaultdict(list)
    for s in avant:
        identiques[tuple(s[k] for k in _VISIBLE)].append(s)
    ajoutees = []
    for s in apres:
        pareilles = identiques.get(tuple(s[k] for k in _VISIBLE))
        if pareilles:
            pareilles.pop()
        else:
            ajoutees.append(s)
    retirees = [s for reste in identiques.values() for s in reste]

    modifiees = []
    for par_creneau in (True, False):
        for b in list(ajoutees):
            a = next((x for x in retirees if x["id_cours"] == b["id_cours"] and x["nature"] == b["nature"] and (
                not par_creneau or (x["date_seance"], x["heure_debut"]) == (b["date_seance"], b["heure_debut"]))), None)
            if a is not None:
                modifiees.append((a, b))
                retirees.remove(a)
                ajoutees.remove(b)
    return Differences(ajoutees, retirees, modifiees)


def _changements_par_enseignant(d: Differences) -> dict[int, list[str]]:
    """Pour chaque enseignant concerné : ses séances ajoutées, annulées, retirées ou mises à jour."""
    changements: dict[int, list[str]] = defaultdict(list)
    annulee = lambda s: s["statut"] == "annulee"  # noqa: E731
    for s in d.ajoutees:
        if not annulee(s):
            changements[s["id_enseignant"]].append(f"+ Ajoutée : {_ligne(s)}")
    for a in d.retirees:
        if not annulee(a):
            changements[a["id_enseignant"]].append(f"- Retirée : {_ligne(a)}")
    for a, b in d.modifiees:
        if a["id_enseignant"] != b["id_enseignant"]:  # l'ancien et le nouvel enseignant sont prévenus
            if not annulee(a):
                changements[a["id_enseignant"]].append(f"- Retirée : {_ligne(a)}")
            if not annulee(b):
                changements[b["id_enseignant"]].append(f"+ Ajoutée : {_ligne(b)}")
        elif annulee(b) and not annulee(a):
            changements[b["id_enseignant"]].append(f"× Annulée : {_ligne(a)}")
        elif annulee(a) and not annulee(b):
            changements[b["id_enseignant"]].append(f"+ Rétablie : {_ligne(b)}")
        elif not annulee(b) and any(a[k] != b[k] for k in _ENDROIT):
            changements[b["id_enseignant"]].append(f"→ Modifiée : {_ligne(a)}\n    devient : {_ligne(b)}")
    changements.pop(None, None)  # séances sans enseignant : personne à prévenir
    return changements


def messages_de_publication(conn: psycopg.Connection, id_edt: int, d: Differences, premiere: bool) -> tuple[list[Message], int]:
    """Un message par enseignant concerné par un changement ; renvoie aussi le nombre de ceux qui
    n'ont pas d'adresse e-mail."""
    changements = _changements_par_enseignant(d)
    if not changements:
        return [], 0
    ecole, semestre = conn.execute(
        "SELECT ec.code_ecole, s.libelle || ' ' || s.annee_academique FROM emploi_du_temps e "
        "JOIN semestre s USING (id_semestre, id_ecole) JOIN ecole ec USING (id_ecole) WHERE e.id_edt = %s", (id_edt,),
    ).fetchone()
    enseignants = conn.execute(
        "SELECT id_enseignant, prenom || ' ' || nom, email FROM enseignant WHERE id_enseignant = ANY(%s)",
        (list(changements),),
    ).fetchall()
    out = []
    for id_ens, nom, email in enseignants:
        if not email:
            continue
        lignes = changements[id_ens]
        texte = "\n".join([
            f"Bonjour {nom},",
            "",
            f"L'emploi du temps {semestre} a été publié. Vos séances :" if premiere
            else f"L'emploi du temps {semestre} a été mis à jour. Changements dans vos séances :",
            "",
            *lignes[:40],
            *([f"… et {len(lignes) - 40} autre(s)"] if len(lignes) > 40 else []),
            "",
            f"Votre emploi du temps : {config.URL_INVITES}?ecole={ecole}&r=enseignant&id={id_ens}",
            "(abonnement à votre agenda : bouton iCalendar sur cette page)",
            "",
            "La scolarité",
        ])
        out.append(Message(email, f"Emploi du temps {semestre} : {len(lignes)} séance(s) vous concernent", texte))
    return out, len(enseignants) - len(out)


_INSERER_COPIE = (
    "INSERT INTO seance (date_seance, heure_debut, heure_fin, statut, est_verrouillee, id_cours, id_enseignant, "
    "id_salle, id_creneau, nature, id_edt) "
    "SELECT date_seance, heure_debut, heure_fin, statut, FALSE, id_cours, id_enseignant, id_salle, id_creneau, nature, %s "
    "FROM seance WHERE id_seance = ANY(%s) ORDER BY date_seance, heure_debut"
)
_REFUS = (psycopg.errors.IntegrityError, psycopg.errors.RaiseException, psycopg.errors.DataError)


def _motif(e: psycopg.Error) -> str:
    if isinstance(e, psycopg.errors.ExclusionViolation):
        return "CD-01 : la salle est déjà occupée sur cette plage horaire"
    return e.diag.message_primary or str(e)


def _copier_seances(conn: psycopg.Connection, id_copie: int, ajoutees: list[dict]) -> None:
    """Toutes d'un coup (la base revalide chacune) ; en cas de refus, une par une pour nommer la
    séance en cause."""
    ids = [s["id_seance"] for s in ajoutees]
    try:
        with conn.transaction():
            conn.execute(_INSERER_COPIE, (id_copie, ids))
        return
    except _REFUS as e:
        motif = _motif(e)
    for s in ajoutees:
        try:
            with conn.transaction():
                conn.execute(_INSERER_COPIE, (id_copie, [s["id_seance"]]))
        except _REFUS as e:
            raise HTTPException(409, f"Publication refusée, {_ligne(s)} : {_motif(e)}") from e
    raise HTTPException(409, f"Publication refusée : {motif}")


@routeur.post("/api/emplois-du-temps/{id_edt}/publier")
def publier(id_edt: int, conn: psycopg.Connection = Depends(connexion), u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    """Publie la version à jour : sa copie publiée, celle que lisent les invités, reçoit ses
    différences en une seule transaction. Tout ou rien : un refus de la base ne change rien pour
    les invités. Seuls les enseignants concernés par un changement sont prévenus."""
    row = conn.execute("SELECT statut, id_semestre, libelle, mode_generation FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise HTTPException(404, "Emploi du temps introuvable")
    statut, id_semestre, libelle, mode = row
    if statut not in ("brouillon", "valide"):
        raise HTTPException(409, "Seule la version à jour se publie")
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (id_edt,))
        copie = conn.execute(
            "SELECT id_edt, statut FROM emploi_du_temps WHERE id_semestre = %s AND statut IN ('publie', 'archive') "
            "ORDER BY statut = 'publie' DESC, version DESC LIMIT 1", (id_semestre,),
        ).fetchone()
        avant = _seances(conn, copie[0] if copie else None)
        d = comparer(avant, _seances(conn, id_edt))
        if d.vide and (copie is None or copie[1] == "publie"):
            raise HTTPException(409, "Rien à publier : les invités voient déjà cette version")

        origine(conn, "publication")  # seule une publication peut changer la copie publiée
        if copie is None:
            id_copie = conn.execute(
                "INSERT INTO emploi_du_temps (libelle, version, mode_generation, id_semestre, id_utilisateur) "
                "SELECT %s, max(version) + 1, %s, %s, %s FROM emploi_du_temps WHERE id_semestre = %s RETURNING id_edt",
                (libelle, mode, id_semestre, u.id_utilisateur, id_semestre),
            ).fetchone()[0]
        else:
            id_copie = copie[0]
        # Les contraintes de la version à jour valent pour la copie (la base s'en sert pour la contrôler)
        conn.execute("DELETE FROM contrainte WHERE id_edt = %s", (id_copie,))
        conn.execute(
            "INSERT INTO contrainte (libelle, type_contrainte, nature, poids, valeur, est_active, parametres, date_debut, "
            "date_fin, id_edt) "
            "SELECT libelle, type_contrainte, nature, poids, valeur, est_active, parametres, date_debut, date_fin, %s "
            "FROM contrainte WHERE id_edt = %s ORDER BY id_contrainte", (id_copie, id_edt),
        )
        a_retirer = [s["id_seance"] for s in d.retirees] + [a["id_seance"] for a, _ in d.modifiees]
        conn.execute("DELETE FROM seance WHERE id_seance = ANY(%s)", (a_retirer,))
        _copier_seances(conn, id_copie, sorted(d.ajoutees + [b for _, b in d.modifiees],
                                               key=lambda s: (s["date_seance"], s["heure_debut"], s["id_seance"])))
        conn.execute("UPDATE emploi_du_temps SET statut = 'archive' WHERE statut = 'publie' AND id_edt <> %s", (id_copie,))
        conn.execute("UPDATE emploi_du_temps SET statut = 'publie', date_publication = now() WHERE id_edt = %s", (id_copie,))
        conn.execute(
            "INSERT INTO publication_edt (id_edt, date_version, ajoutees, retirees, modifiees, id_utilisateur) "
            "SELECT %s, (SELECT max(date_version) FROM versions_edt(%s)), %s, %s, %s, %s",
            (id_edt, id_edt, len(d.ajoutees), len(d.retirees), len(d.modifiees), u.id_utilisateur),
        )
    origine(conn, "console")

    messages, sans_adresse = messages_de_publication(conn, id_edt, d, not avant)
    if not messages:
        notification = {"statut": "personne", "destinataires": 0, "sans_adresse": sans_adresse}
    elif not smtp_configure():
        notification = {"statut": "smtp_non_configure", "destinataires": len(messages), "sans_adresse": sans_adresse}
    else:
        conn.commit()  # la publication est acquise avant l'envoi
        planifier(messages)
        notification = {"statut": "en_cours", "destinataires": len(messages), "sans_adresse": sans_adresse}
    return {"id_edt": id_edt, "id_publie": id_copie, "ajoutees": len(d.ajoutees), "retirees": len(d.retirees),
            "modifiees": len(d.modifiees), "notification": notification}
