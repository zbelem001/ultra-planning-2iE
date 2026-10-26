"""Générations en tâche de fond (BF-15, BF-30).

Une génération peut durer de quelques secondes à plusieurs minutes : elle
tourne dans un fil séparé et l'interface interroge son état. Le résultat est
gardé en mémoire jusqu'à son application. En production, remplacer ce
gestionnaire par la file Celery + Redis prévue au cahier des charges ; l'API
ne change pas.
"""

from __future__ import annotations

import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime

import psycopg

from ultraplanning_solver import Demande, Perimetre, Resultat, generer
from ultraplanning_solver.base import charger, enregistrer

from . import config
from .db import entrer_ecole


@dataclass
class Tache:
    id: str
    id_edt: int
    id_ecole: int
    demande: Demande
    statut: str = "en_attente"  # en_attente, en_cours, terminee, appliquee, erreur
    cree_le: datetime = field(default_factory=datetime.now)
    resultat: Resultat | None = None
    erreur: str | None = None


_taches: dict[str, Tache] = {}
_verrou = threading.Lock()
_executeur = ThreadPoolExecutor(max_workers=1)  # une génération à la fois


def lancer(id_edt: int, id_ecole: int, demande: Demande) -> Tache:
    t = Tache(uuid.uuid4().hex[:12], id_edt, id_ecole, demande)
    with _verrou:
        _taches[t.id] = t
    _executeur.submit(_executer, t)
    return t


def _executer(t: Tache) -> None:
    t.statut = "en_cours"
    try:
        with psycopg.connect(config.DATABASE_URL) as conn:
            entrer_ecole(conn, t.id_ecole)  # le fil ne lit que l'école du compte qui a lancé la génération
            d = charger(conn, t.id_edt)
        t.resultat = generer(d, t.demande)
        t.statut = "terminee"
    except Exception as e:  # noqa: BLE001 - l'erreur est rapportée à l'interface
        t.erreur = f"{type(e).__name__} : {e}"
        t.statut = "erreur"
        traceback.print_exc()


def obtenir(id_tache: str, id_ecole: int) -> Tache | None:
    """Tâche d'une génération, seulement pour un compte de la même école."""
    t = _taches.get(id_tache)
    return t if t is not None and t.id_ecole == id_ecole else None


def appliquer(conn: psycopg.Connection, t: Tache) -> int:
    if t.statut != "terminee" or t.resultat is None:
        raise ValueError(f"Génération {t.statut} : rien à appliquer")
    n = enregistrer(conn, t.id_edt, t.resultat)
    t.statut = "appliquee"
    return n


def construire_demande(filieres: set[int], classes: set[int], du: date | None, au: date | None,
                       minimiser_changements: bool, garder_verrouillees: bool = True, completer: bool = False) -> Demande:
    return Demande(
        perimetre=Perimetre(frozenset(filieres), frozenset(classes)),
        du=du, au=au, minimiser_changements=minimiser_changements, garder_verrouillees=garder_verrouillees, completer=completer,
        temps_max_placement=5,
    )
