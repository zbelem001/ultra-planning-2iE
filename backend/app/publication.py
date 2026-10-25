"""Publication d'un emploi du temps et notification des enseignants (BF-19, BF-20).

La publication rend la version visible dans l'espace invités ; la version publiée
précédente est archivée. Les enseignants dont les séances changent par rapport à
cette version précédente (toutes leurs séances pour une première publication)
reçoivent un e-mail : séances ajoutées, retirées ou modifiées, et le lien vers leur
emploi du temps. Les étudiants n'ont pas d'adresse dans la base : ils consultent
l'espace invités.

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
from pydantic import BaseModel

from . import config
from .auth import Utilisateur, utilisateur_courant
from .db import connexion

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


def _seances(conn: psycopg.Connection, id_edt: int | None) -> dict[tuple, dict]:
    if id_edt is None:
        return {}
    rows = conn.execute(
        """SELECT s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle, s.statut,
                  c.type_cours, c.id_enseignant, m.libelle, cl.code_classe || coalesce(' · ' || g.code_groupe, ''), sa.nom_salle
           FROM seance s JOIN cours c USING (id_cours, id_ecole) JOIN matiere m USING (id_matiere, id_ecole)
           JOIN classe cl ON cl.id_classe = c.id_classe JOIN salle sa ON sa.id_salle = s.id_salle
           LEFT JOIN groupe g ON g.id_groupe = c.id_groupe
           WHERE s.id_edt = %s ORDER BY s.date_seance, s.heure_debut""", (id_edt,),
    ).fetchall()
    cles = ("id_cours", "date_seance", "heure_debut", "heure_fin", "id_salle", "statut",
            "type_cours", "id_enseignant", "matiere", "classe", "salle")
    return {(r[0], r[1], r[2]): dict(zip(cles, r)) for r in rows}


def messages_de_publication(conn: psycopg.Connection, id_edt: int, id_precedent: int | None) -> list[Message]:
    """Un message par enseignant dont les séances changent (avec une adresse e-mail)."""
    avant, apres = _seances(conn, id_precedent), _seances(conn, id_edt)
    changements: dict[int, list[str]] = defaultdict(list)
    for k, s in apres.items():
        a = avant.get(k)
        if a is None:
            changements[s["id_enseignant"]].append(f"+ Ajoutée : {_ligne(s)}")
        elif (a["id_salle"], a["heure_fin"], a["statut"] == "annulee") != (s["id_salle"], s["heure_fin"], s["statut"] == "annulee"):
            quoi = "Annulée" if s["statut"] == "annulee" else "Modifiée"
            changements[s["id_enseignant"]].append(f"~ {quoi} : {_ligne(s)}")
    for k, a in avant.items():
        if k not in apres:
            changements[a["id_enseignant"]].append(f"- Retirée : {_ligne(a)}")
    if not changements:
        return []

    ecole, semestre, version = conn.execute(
        "SELECT ec.code_ecole, s.libelle || ' ' || s.annee_academique, e.version FROM emploi_du_temps e "
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
            f"L'emploi du temps {semestre} a été publié (version {version}). "
            + ("Vos séances :" if id_precedent is None else "Changements dans vos séances :"),
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
    return out


class Publication(BaseModel):
    notifier: bool = True


@routeur.post("/api/emplois-du-temps/{id_edt}/publier")
def publier(id_edt: int, p: Publication, conn: psycopg.Connection = Depends(connexion),
            _: Utilisateur = Depends(utilisateur_courant)) -> dict:
    row = conn.execute("SELECT statut, id_semestre FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise HTTPException(404, "Emploi du temps introuvable")
    if row[0] == "publie":
        raise HTTPException(409, "Cette version est déjà publiée")
    precedent = conn.execute(
        "SELECT id_edt FROM emploi_du_temps WHERE statut = 'publie' ORDER BY version DESC LIMIT 1"
    ).fetchone()
    id_precedent = precedent[0] if precedent else None
    with conn.transaction():
        conn.execute("UPDATE emploi_du_temps SET statut = 'archive' WHERE statut = 'publie'")
        conn.execute("UPDATE emploi_du_temps SET statut = 'publie', date_publication = now() WHERE id_edt = %s", (id_edt,))

    notification: dict = {"statut": "desactivee"}
    if p.notifier:
        messages = messages_de_publication(conn, id_edt, id_precedent)
        if not messages:
            notification = {"statut": "personne", "destinataires": 0}
        elif not smtp_configure():
            notification = {"statut": "smtp_non_configure", "destinataires": len(messages)}
        else:
            conn.commit()  # la publication est acquise avant l'envoi
            planifier(messages)
            notification = {"statut": "en_cours", "destinataires": len(messages)}
    return {"id_edt": id_edt, "archive": id_precedent, "notification": notification}
