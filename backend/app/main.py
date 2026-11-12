"""API REST d'UltraPlanning 2iE (FastAPI, documentation OpenAPI sur /docs).

Le frontend lit les données directement dans Supabase (RLS). Cette API porte
ce qui demande la clé secrète ou du calcul : génération par le solveur,
vérification d'une séance, assistant IA et application de ses propositions.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
from datetime import date, time

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ultraplanning_solver.base import verifier
from ultraplanning_solver.donnees import Seance

from . import agent, config, generations, outils, perimetre, pieces_jointes, propositions
from .base_api import routeur as routeur_base
from .comptes import routeur as routeur_comptes
from .historique import routeur as routeur_historique
from .publication import routeur as routeur_publication
from .superadmin_api import routeur as routeur_superadmin
from .auth import Utilisateur, utilisateur_courant
from .db import connexion, entrer_ecole, origine, ouvrir

journal = logging.getLogger("ultraplanning.api")

app = FastAPI(title="UltraPlanning 2iE", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=config.ORIGINES, allow_methods=["*"], allow_headers=["*"],
    expose_headers=["ETag"],  # l'espace invités compare l'étiquette pour savoir si l'emploi du temps a changé
)
# Réponses compressées (JSON : environ 10 fois moins de données), pour les connexions lentes
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)
app.include_router(routeur_base)
app.include_router(routeur_superadmin)
app.include_router(routeur_comptes)
app.include_router(routeur_publication)
app.include_router(routeur_historique)


def _edt(conn: psycopg.Connection, id_edt: int) -> str:
    """Statut d'un emploi du temps de l'école du compte (celui d'une autre école est invisible)."""
    row = conn.execute("SELECT statut FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise HTTPException(404, "Emploi du temps introuvable")
    return row[0]


def _edt_modifiable(conn: psycopg.Connection, id_edt: int) -> None:
    if _edt(conn, id_edt) in ("publie", "archive"):
        raise HTTPException(409, "La version publiée ne se modifie pas : modifiez la version à jour, puis publiez-la")


@app.get("/api/sante")
def sante(conn: psycopg.Connection = Depends(connexion)) -> dict:
    conn.execute("SELECT 1")
    modeles = {"groq": config.MODELE, "anthropic": config.ANTHROPIC_MODEL}
    ordre = agent.fournisseurs()
    # « modele » : celui qui répond en premier ; « assistant » : l'ordre d'essai (relais en cas d'échec)
    return {"statut": "ok", "modele": modeles[ordre[0]] if ordre else None,
            "assistant": [{"fournisseur": f, "modele": modeles[f]} for f in ordre]}


# --- génération -------------------------------------------------------------------

class DemandeGeneration(BaseModel):
    id_edt: int
    filieres: list[str] = Field(default_factory=list, description="Codes de filières ; vide = tout l'établissement")
    classes: list[str] = Field(default_factory=list, description="Codes de classes")
    matieres: list[str] = Field(default_factory=list, description="Codes ou noms de matières : seulement ces modules")
    du: date | None = None
    au: date | None = None
    minimiser_changements: bool = False
    # Pas de « garder les séances verrouillées » à choisir : une séance verrouillée n'est jamais remplacée ni
    # supprimée par une génération (le champ envoyé par une ancienne console est ignoré)
    # Compléter seulement : les séances existantes restent en place, seules les heures manquantes sont placées
    completer: bool = False


def _tache_json(t: generations.Tache) -> dict:
    out = {"id": t.id, "id_edt": t.id_edt, "statut": t.statut, "erreur": t.erreur, "avertissements": t.avertissements}
    if t.resultat is not None:
        r = t.resultat
        out |= {
            "statistiques": r.statistiques,
            "non_places": [
                {"id_cours": n.id_cours, "heures": n.heures, "code": n.code, "raison": n.raison} for n in r.non_places
            ],
            "seances": [
                {"id_cours": s.id_cours, "date_seance": s.date_seance, "heure_debut": s.heure_debut.strftime("%H:%M"),
                 "heure_fin": s.heure_fin.strftime("%H:%M"), "id_salle": s.id_salle, "id_enseignant": s.id_enseignant}
                for s in r.seances
            ],
            "seances_remplacees": len(r.remplacees),
        }
    return out


@app.post("/api/generations", status_code=202)
def lancer_generation(d: DemandeGeneration, conn: psycopg.Connection = Depends(connexion),
                      u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    _edt_modifiable(conn, d.id_edt)
    if d.matieres and not (d.classes or d.filieres):
        raise HTTPException(422, "Choisissez la classe ou la filière des matières à programmer")
    try:
        selection = perimetre.resoudre(conn, d.id_edt, d.classes, d.filieres, d.matieres)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if selection.vide:
        raise HTTPException(422, "Rien à générer : " + " ".join(selection.avertissements))
    t = generations.lancer(d.id_edt, u.id_ecole, generations.construire_demande(
        selection.perimetre, d.du, d.au, d.minimiser_changements, garder_verrouillees=True, completer=d.completer))
    t.avertissements = selection.avertissements
    return _tache_json(t)


@app.get("/api/generations/{id_tache}")
def etat_generation(id_tache: str, u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    t = generations.obtenir(id_tache, u.id_ecole)
    if t is None:
        raise HTTPException(404, "Génération introuvable")
    return _tache_json(t)


@app.post("/api/generations/{id_tache}/appliquer")
def appliquer_generation(id_tache: str, conn: psycopg.Connection = Depends(connexion),
                         u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    t = generations.obtenir(id_tache, u.id_ecole)
    if t is None:
        raise HTTPException(404, "Génération introuvable")
    _edt_modifiable(conn, t.id_edt)
    try:
        origine(conn, "generation")
        n = generations.appliquer(conn, t)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    except (psycopg.errors.CheckViolation, psycopg.errors.ExclusionViolation) as e:
        raise HTTPException(409, f"Refusée par la base : {e.diag.message_primary}") from e
    return {"seances_enregistrees": n}


# --- vérification d'une séance (BF-12) ---------------------------------------------

class SeanceAVerifier(BaseModel):
    id_edt: int
    id_cours: int
    date_seance: date
    heure_debut: time
    heure_fin: time
    id_salle: int
    id_seance: int | None = None


@app.post("/api/verifications")
def verifier_seance(s: SeanceAVerifier, conn: psycopg.Connection = Depends(connexion),
                    _: Utilisateur = Depends(utilisateur_courant)) -> dict:
    try:
        motif = verifier(conn, s.id_edt, Seance(s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle, s.id_seance))
    except ValueError as e:
        motif = str(e)
    return {"acceptee": motif is None, "motif": motif}


# --- assistant IA (BF-29) ------------------------------------------------------------

class PieceJointe(BaseModel):
    nom: str = Field(min_length=1, max_length=200)
    contenu: str = Field(max_length=7_100_000)  # base64 d'un fichier de 5 Mo au plus


class Message(BaseModel):
    id_edt: int
    texte: str = Field(min_length=1, max_length=4000)
    id_conversation: int | None = None
    piece_jointe: PieceJointe | None = None


@app.post("/api/assistant/messages")
def message_assistant(m: Message, conn: psycopg.Connection = Depends(connexion),
                      u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    return _traiter_message(conn, u, m)


@app.post("/api/assistant/messages/flux")
def message_assistant_flux(m: Message, u: Utilisateur = Depends(utilisateur_courant)) -> StreamingResponse:
    """Même traitement, envoyé au fur et à mesure (Server-Sent Events) : « etape » quand un outil
    travaille (lecture, vérification, solveur), « texte » pendant que la réponse s'écrit, « efface »
    si ce texte n'était pas la réponse ; puis « fin » avec la réponse (mêmes champs que
    /api/assistant/messages) ou « erreur »."""
    file: queue.Queue = queue.Queue()

    def travail() -> None:
        try:
            # Connexion propre au fil, cantonnée à l'école du compte comme celle des requêtes
            with ouvrir() as c:
                entrer_ecole(c, u.id_ecole, u.id_utilisateur)
                fin = _traiter_message(c, u, m, lambda etape, detail: file.put({"type": "etape", "etape": etape, "detail": detail}),
                                       lambda morceau: file.put({"type": "efface"} if morceau is None else {"type": "texte", "morceau": morceau}))
            file.put({"type": "fin", **fin})
        except HTTPException as e:
            file.put({"type": "erreur", "detail": e.detail})
        except Exception:  # noqa: BLE001 - l'erreur est rapportée à l'interface
            journal.exception("assistant : échec du traitement")
            file.put({"type": "erreur", "detail": "Erreur interne de l'assistant"})
        finally:
            file.put(None)

    threading.Thread(target=travail, daemon=True).start()

    def evenements():
        while (ev := file.get()) is not None:
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(evenements(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _traiter_message(conn: psycopg.Connection, u: Utilisateur, m: Message, progres=None, sur_texte=None) -> dict:
    _edt_modifiable(conn, m.id_edt)  # l'assistant ne travaille que sur la version à jour
    fichier = None
    if m.piece_jointe:  # contrôlé avant d'enregistrer quoi que ce soit
        try:
            type_mime = pieces_jointes.type_de(m.piece_jointe.nom)
            contenu = pieces_jointes.decoder(m.piece_jointe.contenu)
            fichier = (m.piece_jointe.nom, type_mime, contenu, pieces_jointes.lire(type_mime, contenu))
        except pieces_jointes.FichierRefuse as e:
            raise HTTPException(422, str(e)) from e
    if m.id_conversation is None:
        titre = m.texte if len(m.texte) <= 48 else m.texte[:47].rstrip() + "…"
        id_conv = conn.execute(
            "INSERT INTO conversation (titre, id_utilisateur, id_edt) VALUES (%s, %s, %s) RETURNING id_conversation",
            (titre, u.id_utilisateur, m.id_edt),
        ).fetchone()[0]
        historique: list[tuple[str, str | None]] = []
    else:
        row = conn.execute(
            "SELECT id_edt, id_utilisateur FROM conversation WHERE id_conversation = %s", (m.id_conversation,)
        ).fetchone()
        if row is None or row[1] != u.id_utilisateur:
            raise HTTPException(404, "Discussion introuvable")
        if row[0] != m.id_edt:
            raise HTTPException(409, "Cette discussion porte sur un autre emploi du temps")
        id_conv = m.id_conversation
        historique = conn.execute(
            "SELECT texte, reponse FROM prompt WHERE id_conversation = %s ORDER BY date_prompt, id_prompt", (id_conv,)
        ).fetchall()

    texte = m.texte + (f"\n[Pièce jointe : {fichier[0]}]" if fichier else "")
    id_prompt = conn.execute(
        "INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES (%s, %s, %s, %s) RETURNING id_prompt",
        (texte, u.id_utilisateur, m.id_edt, id_conv),
    ).fetchone()[0]
    demande, visuels = m.texte, None
    if fichier:
        nom, type_mime, contenu, lecture = fichier
        id_piece = conn.execute(
            "INSERT INTO piece_jointe (nom, type_mime, taille, contenu, id_prompt) VALUES (%s, %s, %s, %s, %s) RETURNING id_piece",
            (nom, type_mime, len(contenu), contenu, id_prompt),
        ).fetchone()[0]
        claude = "anthropic" in agent.fournisseurs()
        demande += "\n\n" + pieces_jointes.annonce(id_piece, nom, lecture, claude)
        if lecture.visuel and claude:
            visuels = [pieces_jointes.bloc_claude(type_mime, contenu)]
    conn.commit()  # le message reste enregistré même si l'assistant échoue

    try:
        r = agent.repondre(conn, m.id_edt, id_prompt, historique, demande, progres=progres, visuels=visuels, sur_texte=sur_texte)
    except agent.AgentIndisponible as e:
        conn.rollback()
        r = agent.Reponse(str(e), "erreur", [])
    conn.execute("UPDATE prompt SET reponse = %s, statut = %s WHERE id_prompt = %s", (r.texte, r.statut, id_prompt))
    return {
        "id_conversation": id_conv,
        "id_prompt": id_prompt,
        "statut": r.statut,
        "reponse": r.texte,
        "propositions": r.propositions,
        "modele": r.modele,
    }


# --- propositions ----------------------------------------------------------------------

@app.get("/api/propositions")
def lister_propositions(id_edt: int, statut: str = "en_attente", conn: psycopg.Connection = Depends(connexion),
                        _: Utilisateur = Depends(utilisateur_courant)) -> list[dict]:
    rows = conn.execute(
        "SELECT id_proposition, description, modifications, impact, statut, date_creation, id_prompt FROM proposition "
        "WHERE id_edt = %s AND statut = %s ORDER BY date_creation DESC",
        (id_edt, statut),
    ).fetchall()
    return [
        {"id_proposition": r[0], "description": r[1], "modifications": r[2], "impact": r[3], "statut": r[4],
         "date_creation": r[5], "id_prompt": r[6]}
        for r in rows
    ]


@app.post("/api/propositions/{id_proposition}/appliquer")
def appliquer_proposition(id_proposition: int, conn: psycopg.Connection = Depends(connexion),
                          u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    try:
        origine(conn, "assistant")
        r = propositions.appliquer(conn, id_proposition, u.id_utilisateur)
    except propositions.PropositionRefusee as e:
        raise HTTPException(409, str(e)) from e
    suite = None
    if r["suite"]:
        # Changements du référentiel validés : la génération (ou la replanification) demandée est lancée. Son
        # résultat est une nouvelle proposition, sous le même message de la discussion : le planificateur la
        # valide à son tour avant que les séances ne s'écrivent dans la version à jour.
        conn.commit()  # les changements restent acquis même si le calcul échoue
        ctx = outils.Contexte(conn, r["id_edt"], r["id_prompt"], [])
        s = r["suite"]
        try:
            if s.get("mode") == "replanifier":
                texte = outils.proposer_replanification(ctx, s["description"], s["du"], s["au"],
                                                        s.get("classes"), s.get("filieres"))
            else:
                texte = outils.proposer_generation(ctx, s["description"], s.get("classes"), s.get("filieres"),
                                                   s.get("du"), s.get("au"), s.get("matieres"))
        except (ValueError, psycopg.Error) as e:
            conn.rollback()
            texte = f"Génération impossible : {e}"
        id_suite = ctx.propositions_creees[0] if ctx.propositions_creees else None
        suite = {"id_proposition": id_suite,
                 "message": f"Proposition {id_suite} calculée : à valider sur sa carte, dans la discussion." if id_suite
                 else texte.splitlines()[0]}
    return {k: v for k, v in r.items() if k not in ("suite", "id_prompt")} | {"suite": suite}


@app.post("/api/propositions/{id_proposition}/rejeter")
def rejeter_proposition(id_proposition: int, conn: psycopg.Connection = Depends(connexion),
                        u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    try:
        propositions.rejeter(conn, id_proposition, u.id_utilisateur)
    except propositions.PropositionRefusee as e:
        raise HTTPException(409, str(e)) from e
    return {"id_proposition": id_proposition, "statut": "rejetee"}
