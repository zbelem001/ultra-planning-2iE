"""API REST d'UltraPlanning 2iE (FastAPI, documentation OpenAPI sur /docs).

Le frontend lit les données directement dans Supabase (RLS). Cette API porte
ce qui demande la clé secrète ou du calcul : génération par le solveur,
vérification d'une séance, assistant IA et application de ses propositions.
"""

from __future__ import annotations

from datetime import date, time

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from ultraplanning_solver.base import verifier
from ultraplanning_solver.donnees import Seance

from . import agent, config, generations, propositions
from .base_api import routeur as routeur_base
from .comptes import routeur as routeur_comptes
from .publication import routeur as routeur_publication
from .superadmin_api import routeur as routeur_superadmin
from .auth import Utilisateur, utilisateur_courant
from .db import connexion, origine

app = FastAPI(title="UltraPlanning 2iE", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=config.ORIGINES, allow_methods=["*"], allow_headers=["*"],
)
# Réponses compressées (JSON : environ 10 fois moins de données), pour les connexions lentes
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6)
app.include_router(routeur_base)
app.include_router(routeur_superadmin)
app.include_router(routeur_comptes)
app.include_router(routeur_publication)


def _edt(conn: psycopg.Connection, id_edt: int) -> str:
    """Statut d'un emploi du temps de l'école du compte (celui d'une autre école est invisible)."""
    row = conn.execute("SELECT statut FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    if row is None:
        raise HTTPException(404, "Emploi du temps introuvable")
    return row[0]


def _edt_modifiable(conn: psycopg.Connection, id_edt: int) -> None:
    if _edt(conn, id_edt) in ("publie", "archive"):
        raise HTTPException(409, "Emploi du temps publié : créez une nouvelle version pour le modifier")


@app.get("/api/sante")
def sante(conn: psycopg.Connection = Depends(connexion)) -> dict:
    conn.execute("SELECT 1")
    return {"statut": "ok", "modele": config.MODELE}


# --- génération -------------------------------------------------------------------

class DemandeGeneration(BaseModel):
    id_edt: int
    filieres: list[str] = Field(default_factory=list, description="Codes de filières ; vide = tout l'établissement")
    classes: list[str] = Field(default_factory=list, description="Codes de classes")
    du: date | None = None
    au: date | None = None
    minimiser_changements: bool = False
    garder_verrouillees: bool = True
    # Compléter seulement : les séances existantes restent en place, seules les heures manquantes sont placées
    completer: bool = False


def _tache_json(t: generations.Tache) -> dict:
    out = {"id": t.id, "id_edt": t.id_edt, "statut": t.statut, "erreur": t.erreur}
    if t.resultat is not None:
        r = t.resultat
        out |= {
            "statistiques": r.statistiques,
            "non_places": [
                {"id_cours": n.id_cours, "heures": n.heures, "code": n.code, "raison": n.raison} for n in r.non_places
            ],
            "seances": [
                {"id_cours": s.id_cours, "date_seance": s.date_seance, "heure_debut": s.heure_debut.strftime("%H:%M"),
                 "heure_fin": s.heure_fin.strftime("%H:%M"), "id_salle": s.id_salle}
                for s in r.seances
            ],
            "seances_remplacees": len(r.remplacees),
        }
    return out


@app.post("/api/generations", status_code=202)
def lancer_generation(d: DemandeGeneration, conn: psycopg.Connection = Depends(connexion),
                      u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    _edt_modifiable(conn, d.id_edt)
    filieres = {r[0] for r in conn.execute("SELECT id_filiere FROM filiere WHERE code_filiere = ANY(%s)", (d.filieres,))}
    classes = {r[0] for r in conn.execute("SELECT id_classe FROM classe WHERE code_classe = ANY(%s)", (d.classes,))}
    if len(filieres) != len(set(d.filieres)) or len(classes) != len(set(d.classes)):
        raise HTTPException(422, "Code de filière ou de classe inconnu")
    t = generations.lancer(d.id_edt, u.id_ecole, generations.construire_demande(filieres, classes, d.du, d.au, d.minimiser_changements,
                                                                   d.garder_verrouillees, d.completer))
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

class Message(BaseModel):
    id_edt: int
    texte: str = Field(min_length=1, max_length=4000)
    id_conversation: int | None = None


@app.post("/api/assistant/messages")
def message_assistant(m: Message, conn: psycopg.Connection = Depends(connexion),
                      u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    _edt(conn, m.id_edt)
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

    id_prompt = conn.execute(
        "INSERT INTO prompt (texte, id_utilisateur, id_edt, id_conversation) VALUES (%s, %s, %s, %s) RETURNING id_prompt",
        (m.texte, u.id_utilisateur, m.id_edt, id_conv),
    ).fetchone()[0]
    conn.commit()  # le message reste enregistré même si l'assistant échoue

    try:
        r = agent.repondre(conn, m.id_edt, id_prompt, historique, m.texte)
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
        return propositions.appliquer(conn, id_proposition, u.id_utilisateur)
    except propositions.PropositionRefusee as e:
        raise HTTPException(409, str(e)) from e


@app.post("/api/propositions/{id_proposition}/rejeter")
def rejeter_proposition(id_proposition: int, conn: psycopg.Connection = Depends(connexion),
                        u: Utilisateur = Depends(utilisateur_courant)) -> dict:
    try:
        propositions.rejeter(conn, id_proposition, u.id_utilisateur)
    except propositions.PropositionRefusee as e:
        raise HTTPException(409, str(e)) from e
    return {"id_proposition": id_proposition, "statut": "rejetee"}
