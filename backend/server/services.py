"""Services de l'API : configuration, accès à la base, authentification,
logique de planification et branchement du moteur OR-Tools.

Toutes les contraintes dures sont vérifiées par la base (contrainte EXCLUDE
et déclencheur verifier_seance). L'API se contente de traduire leurs
messages en réponses HTTP lisibles (BF-12 : afficher le motif du refus).
"""

import importlib
import re
import threading
import traceback
from collections.abc import Iterator
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from psycopg import Connection, errors, sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic_settings import BaseSettings, SettingsConfigDict


# =====================================================================
#  CONFIGURATION (variables d'environnement ou fichier .env)
# =====================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Chaîne de connexion PostgreSQL du projet Supabase
    # (Supabase > Connect > Connection string). Fournie par l'équipe 5 ;
    # ne jamais la versionner.
    database_url: str = "postgresql://postgres:postgres@localhost:5432/postgres"

    # Signature des jetons JWT émis par /auth/connexion
    jwt_secret: str = "a-changer-en-production"
    jwt_expiration_minutes: int = 8 * 60

    # false = toutes les routes sont ouvertes (pratique pour l'intégration
    # avec le front) ; true = contrôle d'accès par rôle (BNF-07).
    auth_enabled: bool = False

    # Module Python du moteur OR-Tools (tâche 2), voir la section MOTEUR
    moteur_module: str = "moteur_ortools"

    # Origines autorisées pour le front (séparées par des virgules)
    cors_origins: str = "*"


settings = Settings()


# =====================================================================
#  BASE DE DONNÉES
# =====================================================================

pool = ConnectionPool(
    settings.database_url,
    min_size=1,
    max_size=10,
    open=False,
    kwargs={"row_factory": dict_row, "autocommit": False},
)


def get_conn() -> Iterator[Connection]:
    """Dépendance FastAPI : une connexion par requête, une transaction par requête."""
    with pool.connection() as conn:
        yield conn


def fetch_all(conn: Connection, requete, params=None) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(requete, params)
        return cur.fetchall()


def fetch_one(conn: Connection, requete, params=None) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(requete, params)
        return cur.fetchone()


def fetch_or_404(conn: Connection, requete, params, objet: str) -> dict:
    ligne = fetch_one(conn, requete, params)
    if ligne is None:
        raise HTTPException(404, f"{objet} introuvable")
    return ligne


def inserer(conn: Connection, table: str, valeurs: dict) -> dict:
    requete = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(map(sql.Identifier, valeurs)),
        sql.SQL(", ").join(sql.Placeholder() * len(valeurs)),
    )
    return fetch_one(conn, requete, list(valeurs.values()))


def modifier(conn: Connection, table: str, cle: str, id_, valeurs: dict, objet: str) -> dict:
    if not valeurs:
        raise HTTPException(422, "Aucun champ à modifier")
    requete = sql.SQL("UPDATE {} SET {} WHERE {} = %s RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(c)) for c in valeurs),
        sql.Identifier(cle),
    )
    return fetch_or_404(conn, requete, [*valeurs.values(), id_], objet)


_CODE_CONTRAINTE = re.compile(r"^(CD-\d+)\s*:")

ERREURS_METIER = (
    errors.IntegrityError,          # unicité, clés étrangères, CHECK, EXCLUDE
    errors.RaiseException,          # RAISE sans ERRCODE explicite
    errors.InvalidTextRepresentation,
    errors.InvalidDatetimeFormat,
)


def motif_refus(exc: errors.Error) -> dict:
    """Transforme une erreur PostgreSQL en motif lisible {code, message}."""
    message = (exc.diag.message_primary or str(exc)).strip()
    if isinstance(exc, errors.ExclusionViolation):
        return {"code": "CD-01", "message": "CD-01 : la salle a déjà une séance qui chevauche cette plage horaire"}
    trouve = _CODE_CONTRAINTE.match(message)
    if trouve:
        return {"code": trouve.group(1), "message": message}
    if isinstance(exc, errors.UniqueViolation):
        return {"code": "unicite", "message": f"Valeur déjà utilisée : {exc.diag.message_detail or message}"}
    if isinstance(exc, errors.ForeignKeyViolation):
        return {"code": "reference", "message": f"Référence invalide ou encore utilisée : {exc.diag.message_detail or message}"}
    if isinstance(exc, errors.CheckViolation):
        return {"code": "verification", "message": message}
    if isinstance(exc, errors.NotNullViolation):
        return {"code": "obligatoire", "message": message}
    return {"code": "base", "message": message}


# =====================================================================
#  AUTHENTIFICATION ET RÔLES (BF-25, BNF-07)
#  Le SSO de l'université (BNF-06) remplacera à terme /auth/connexion ;
#  les routes restent protégées de la même façon.
# =====================================================================

# Rôles autorisés à modifier le référentiel et les emplois du temps
GESTION = ("administrateur", "planificateur")

_bearer = HTTPBearer(auto_error=False)


def hacher_mot_de_passe(mot_de_passe: str) -> str:
    return bcrypt.hashpw(mot_de_passe.encode(), bcrypt.gensalt()).decode()


def verifier_mot_de_passe(mot_de_passe: str, hache: str) -> bool:
    try:
        return bcrypt.checkpw(mot_de_passe.encode(), hache.encode())
    except ValueError:
        return False


def creer_jeton(utilisateur: dict) -> str:
    expiration = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expiration_minutes)
    charge = {
        "sub": str(utilisateur["id_utilisateur"]),
        "login": utilisateur["login"],
        "email": utilisateur["email"],
        "role": utilisateur["role"],
        "exp": expiration,
    }
    return jwt.encode(charge, settings.jwt_secret, algorithm="HS256")


def utilisateur_courant(
    identifiants: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict | None:
    """Renvoie l'utilisateur du jeton, ou None si l'authentification est désactivée."""
    if identifiants is None:
        if settings.auth_enabled:
            raise HTTPException(401, "Authentification requise")
        return None
    try:
        charge = jwt.decode(identifiants.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Jeton invalide ou expiré")
    return {
        "id_utilisateur": int(charge["sub"]),
        "login": charge["login"],
        "email": charge["email"],
        "role": charge["role"],
    }


def utilisateur_facultatif(
    identifiants: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict | None:
    """Comme utilisateur_courant, mais accepte toujours les invités (consultation)."""
    if identifiants is None:
        return None
    return utilisateur_courant(identifiants)


def exiger_roles(*roles: str):
    """Dépendance : refuse l'accès si l'utilisateur n'a pas l'un des rôles donnés."""

    def verifier(utilisateur: dict | None = Depends(utilisateur_courant)) -> dict | None:
        if not settings.auth_enabled:
            return utilisateur
        if utilisateur is None or utilisateur["role"] not in roles:
            raise HTTPException(403, "Droits insuffisants pour cette action")
        return utilisateur

    return verifier


gestion = Depends(exiger_roles(*GESTION))


# =====================================================================
#  PLANIFICATION
#  - création / déplacement d'une séance à partir d'un créneau de début
#    et d'une durée (la base contrôle ensuite les contraintes dures) ;
#  - vérification « à blanc » (BF-12) et propositions (BF-13) ;
#  - semaine type → séances datées sur tout le semestre (BF-14, §7.7).
# =====================================================================

# Colonnes renvoyées pour une séance (« plage » est un TSRANGE interne)
COLONNES_SEANCE = (
    "id_seance, date_seance, heure_debut, heure_fin, statut, est_verrouillee, "
    "id_cours, id_salle, id_creneau, id_edt"
)

JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]

# Contraintes qui ne dépendent pas de la salle : si l'une d'elles refuse un
# créneau, inutile d'essayer les autres salles sur ce créneau.
CONTRAINTES_HORS_SALLE = {"CD-02", "CD-03", "CD-06", "CD-08", "CD-09", "CD-10", "CD-11"}


def ajouter_heures(debut: time, duree: Decimal | float) -> time:
    return (datetime.combine(date.min, debut) + timedelta(hours=float(duree))).time()


def duree_heures(debut: time, fin: time) -> Decimal:
    secondes = (datetime.combine(date.min, fin) - datetime.combine(date.min, debut)).seconds
    return Decimal(secondes) / 3600


def lundi(jour: date) -> date:
    return jour - timedelta(days=jour.weekday())


def edt_modifiable(conn: Connection, id_edt: int) -> dict:
    """Seul un emploi du temps en brouillon peut être modifié (BF-19)."""
    edt = fetch_or_404(conn, "SELECT * FROM emploi_du_temps WHERE id_edt = %s", [id_edt], "Emploi du temps")
    if edt["statut"] != "brouillon":
        raise HTTPException(
            409,
            f"L'emploi du temps est « {edt['statut']} » : créez une nouvelle version pour le modifier",
        )
    return edt


def inserer_seance(
    conn: Connection,
    *,
    id_edt: int,
    id_cours: int,
    id_salle: int,
    id_creneau: int,
    date_seance: date,
    duree: Decimal | None = None,
    est_verrouillee: bool = False,
) -> dict:
    """Insère une séance ; lève une erreur psycopg si une contrainte dure est violée."""
    creneau = fetch_or_404(conn, "SELECT heure_debut FROM creneau WHERE id_creneau = %s", [id_creneau], "Créneau")
    if duree is None:
        cours = fetch_or_404(conn, "SELECT duree_seance FROM cours WHERE id_cours = %s", [id_cours], "Cours")
        duree = cours["duree_seance"]
    return fetch_one(
        conn,
        f"""INSERT INTO seance (date_seance, heure_debut, heure_fin, est_verrouillee,
                                id_cours, id_salle, id_creneau, id_edt)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING {COLONNES_SEANCE}""",
        [
            date_seance,
            creneau["heure_debut"],
            ajouter_heures(creneau["heure_debut"], duree),
            est_verrouillee,
            id_cours,
            id_salle,
            id_creneau,
            id_edt,
        ],
    )


def modifier_seance(conn: Connection, seance: dict, changements: dict) -> dict:
    """Applique un déplacement / changement à une séance existante."""
    id_creneau = changements.get("id_creneau") or seance["id_creneau"]
    duree = changements.get("duree_heures") or duree_heures(seance["heure_debut"], seance["heure_fin"])
    creneau = fetch_or_404(conn, "SELECT heure_debut FROM creneau WHERE id_creneau = %s", [id_creneau], "Créneau")
    valeurs = {
        "id_salle": changements.get("id_salle") or seance["id_salle"],
        "id_creneau": id_creneau,
        "date_seance": changements.get("date_seance") or seance["date_seance"],
        "heure_debut": creneau["heure_debut"],
        "heure_fin": ajouter_heures(creneau["heure_debut"], duree),
        "statut": changements.get("statut") or seance["statut"],
        "est_verrouillee": (
            changements["est_verrouillee"]
            if changements.get("est_verrouillee") is not None
            else seance["est_verrouillee"]
        ),
    }
    return fetch_one(
        conn,
        f"""UPDATE seance SET id_salle = %(id_salle)s, id_creneau = %(id_creneau)s,
                   date_seance = %(date_seance)s, heure_debut = %(heure_debut)s,
                   heure_fin = %(heure_fin)s, statut = %(statut)s,
                   est_verrouillee = %(est_verrouillee)s
            WHERE id_seance = %(id_seance)s
            RETURNING {COLONNES_SEANCE}""",
        {**valeurs, "id_seance": seance["id_seance"]},
    )


def a_blanc(conn: Connection, operation) -> dict:
    """Exécute `operation` puis annule tout : renvoie {valide, motif} (BF-12)."""
    try:
        with conn.transaction(force_rollback=True):
            operation()
    except ERREURS_METIER as exc:
        return {"valide": False, "motif": motif_refus(exc)}
    return {"valide": True, "motif": None}


def proposer(
    conn: Connection,
    *,
    id_edt: int,
    id_cours: int,
    date_seance: date,
    duree: Decimal | None,
    limite: int,
) -> list[dict]:
    """Salles et créneaux compatibles pour un cours à une date donnée (BF-13)."""
    cours = fetch_or_404(conn, "SELECT * FROM cours WHERE id_cours = %s", [id_cours], "Cours")
    if date_seance.weekday() >= len(JOURS):
        return []
    salles = fetch_all(
        conn,
        """SELECT s.id_salle, s.code_salle, s.nom_salle, s.capacite, s.batiment
           FROM salle s
           WHERE s.est_disponible
             AND (%(type)s::bigint IS NULL OR s.id_type_salle = %(type)s)
             AND s.capacite >= COALESCE(
                   (SELECT g.effectif FROM groupe g WHERE g.id_groupe = %(groupe)s),
                   (SELECT c.effectif FROM classe c WHERE c.id_classe = %(classe)s))
           ORDER BY s.capacite, s.code_salle""",
        {"type": cours["id_type_salle"], "groupe": cours["id_groupe"], "classe": cours["id_classe"]},
    )
    creneaux = fetch_all(
        conn,
        "SELECT * FROM creneau WHERE jour = %s ORDER BY heure_debut",
        [JOURS[date_seance.weekday()]],
    )
    duree = duree or cours["duree_seance"]
    preferences = {
        r["id_creneau"]
        for r in fetch_all(
            conn,
            "SELECT id_creneau FROM disponibilite WHERE id_enseignant = %s AND niveau = 'preference'",
            [cours["id_enseignant"]],
        )
    }

    propositions = []
    for creneau in creneaux:
        for salle in salles:
            resultat = a_blanc(
                conn,
                lambda: inserer_seance(
                    conn,
                    id_edt=id_edt,
                    id_cours=id_cours,
                    id_salle=salle["id_salle"],
                    id_creneau=creneau["id_creneau"],
                    date_seance=date_seance,
                    duree=duree,
                ),
            )
            if resultat["valide"]:
                propositions.append(
                    {
                        "id_creneau": creneau["id_creneau"],
                        "jour": creneau["jour"],
                        "heure_debut": creneau["heure_debut"],
                        "heure_fin": ajouter_heures(creneau["heure_debut"], duree),
                        "preference_enseignant": creneau["id_creneau"] in preferences,
                        **salle,
                    }
                )
                if len(propositions) >= limite:
                    return propositions
            elif resultat["motif"]["code"] in CONTRAINTES_HORS_SALLE:
                break  # ce créneau est impossible, quelle que soit la salle
    return propositions


def appliquer_semaine_type(
    conn: Connection,
    id_edt: int,
    placements: list[dict],
    *,
    remplacer: bool,
    semaine_exclue: date | None = None,
) -> dict:
    """Répète une semaine type sur toutes les semaines du semestre (BF-14, §7.7).

    Chaque séance est insérée dans un SAVEPOINT : une séance refusée n'annule
    pas les autres. Quand le volume horaire d'un cours est atteint (CD-08),
    ce cours n'est plus placé les semaines suivantes.
    """
    edt = edt_modifiable(conn, id_edt)
    semestre = fetch_one(conn, "SELECT * FROM semestre WHERE id_semestre = %s", [edt["id_semestre"]])
    feries = {r["date_ferie"] for r in fetch_all(conn, "SELECT date_ferie FROM jour_ferie")}
    jours_creneaux = {
        r["id_creneau"]: r["jour"] for r in fetch_all(conn, "SELECT id_creneau, jour FROM creneau")
    }

    if remplacer:
        requete = "DELETE FROM seance WHERE id_edt = %s AND NOT est_verrouillee"
        params: list = [id_edt]
        if semaine_exclue:
            requete += " AND date_seance NOT BETWEEN %s AND %s"
            params += [semaine_exclue, semaine_exclue + timedelta(days=6)]
        conn.execute(requete, params)

    rapport = {"seances_creees": 0, "jours_feries_sautes": 0, "volumes_atteints": [], "refus": []}
    cours_complets: set[int] = set()
    semaine = lundi(semestre["date_debut"])

    while semaine <= semestre["date_fin"]:
        if semaine != semaine_exclue:
            for p in placements:
                if p["id_cours"] in cours_complets:
                    continue
                jour = jours_creneaux.get(p["id_creneau"])
                if jour is None:
                    raise HTTPException(422, f"Créneau {p['id_creneau']} introuvable")
                jour_seance = semaine + timedelta(days=JOURS.index(jour))
                if not semestre["date_debut"] <= jour_seance <= semestre["date_fin"]:
                    continue
                if jour_seance in feries:
                    rapport["jours_feries_sautes"] += 1
                    continue
                try:
                    with conn.transaction():
                        inserer_seance(
                            conn,
                            id_edt=id_edt,
                            id_cours=p["id_cours"],
                            id_salle=p["id_salle"],
                            id_creneau=p["id_creneau"],
                            date_seance=jour_seance,
                            duree=p["duree_heures"],
                            est_verrouillee=p.get("est_verrouillee", False),
                        )
                    rapport["seances_creees"] += 1
                except ERREURS_METIER as exc:
                    motif = motif_refus(exc)
                    if motif["code"] == "CD-08":
                        cours_complets.add(p["id_cours"])
                        rapport["volumes_atteints"].append(p["id_cours"])
                    else:
                        rapport["refus"].append(
                            {"date_seance": jour_seance, "id_cours": p["id_cours"],
                             "id_creneau": p["id_creneau"], "id_salle": p["id_salle"], "motif": motif}
                        )
        semaine += timedelta(days=7)

    rapport["volumes_atteints"] = sorted(set(rapport["volumes_atteints"]))
    return rapport


def seances_de_la_semaine(conn: Connection, id_edt: int, jour: date) -> list[dict]:
    """Séances d'une semaine, sous forme de placements réutilisables (BF-14)."""
    debut = lundi(jour)
    lignes = fetch_all(
        conn,
        f"""SELECT {COLONNES_SEANCE} FROM seance
            WHERE id_edt = %s AND statut <> 'annulee'
              AND date_seance BETWEEN %s AND %s""",
        [id_edt, debut, debut + timedelta(days=6)],
    )
    return [
        {
            "id_cours": s["id_cours"],
            "id_salle": s["id_salle"],
            "id_creneau": s["id_creneau"],
            "duree_heures": duree_heures(s["heure_debut"], s["heure_fin"]),
            "est_verrouillee": s["est_verrouillee"],
        }
        for s in lignes
    ]


# =====================================================================
#  MOTEUR DE GÉNÉRATION (tâche 2) — CONTRAT AVEC L'ÉQUIPE MOTEUR
#
#  Le moteur est un module Python (nom réglable par MOTEUR_MODULE, par
#  défaut `moteur_ortools`) placé dans backend/, qui expose :
#
#      def generer(id_edt: int, database_url: str, duree_max_secondes: int) -> dict
#
#  Il lit lui-même la base (cours, découpage COURS_SEANCE_MODELE, salles,
#  créneaux, disponibilités, pauses, contraintes et poids de l'emploi du
#  temps, séances verrouillées) et renvoie une SEMAINE TYPE :
#
#      {
#          "placements": [{"id_cours": 3, "id_salle": 5, "id_creneau": 12, "duree_heures": 2}],
#          "non_places": [{"id_cours": 7, "rang": 2, "motif": "aucune salle de TP libre"}],  # BF-18
#      }
#
#  L'API écrit ensuite les séances datées sur tout le semestre
#  (appliquer_semaine_type) ; la base revérifie chaque séance.
# =====================================================================

# Suivi des générations (en mémoire : une seule instance d'API).
# À remplacer par Celery + Redis si l'API tourne sur plusieurs processus.
generations: dict[int, dict] = {}
_verrou = threading.Lock()


def charger_moteur():
    try:
        module = importlib.import_module(settings.moteur_module)
    except ModuleNotFoundError:
        return None
    return getattr(module, "generer", None)


def demarrer_generation(id_edt: int) -> bool:
    """Réserve l'emploi du temps ; False si une génération est déjà en cours."""
    with _verrou:
        if generations.get(id_edt, {}).get("etat") == "en_cours":
            return False
        generations[id_edt] = {
            "etat": "en_cours",
            "debut": datetime.now(timezone.utc),
            "fin": None,
            "rapport": None,
            "non_places": [],
            "erreur": None,
        }
        return True


def executer_generation(id_edt: int, duree_max_secondes: int) -> None:
    """Tâche de fond : appelle le moteur puis écrit les séances datées."""
    suivi = generations[id_edt]
    try:
        generer = charger_moteur()
        if generer is None:
            raise RuntimeError(
                f"Moteur indisponible : le module « {settings.moteur_module} » "
                "ou sa fonction generer() est introuvable"
            )
        resultat = generer(id_edt, settings.database_url, duree_max_secondes)
        suivi["non_places"] = resultat.get("non_places", [])
        with pool.connection() as conn:
            suivi["rapport"] = appliquer_semaine_type(
                conn, id_edt, resultat.get("placements", []), remplacer=True
            )
            conn.execute(
                "UPDATE emploi_du_temps SET mode_generation = 'automatique' WHERE id_edt = %s",
                [id_edt],
            )
        suivi["etat"] = "terminee"
    except Exception as exc:  # le suivi doit toujours sortir de l'état « en_cours »
        suivi["etat"] = "erreur"
        suivi["erreur"] = getattr(exc, "detail", None) or str(exc)
        traceback.print_exc()
    finally:
        suivi["fin"] = datetime.now(timezone.utc)
