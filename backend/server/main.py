"""API REST du système de planification des cours (tâche 1).

Lancement (depuis le dossier backend/) :
    uvicorn server.main:app --reload
Documentation interactive : http://localhost:8000/docs

Une séance refusée par la base renvoie 409 avec le motif :
{"detail": "CD-04 : capacité de la salle (30) inférieure ...", "code": "CD-04"}
"""

import inspect
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg import Connection, sql
from pydantic import BaseModel, Field

from server import services as sv
from server.services import fetch_all, fetch_one, fetch_or_404, gestion, get_conn
from server.schemas import (
    ClasseCreation,
    Connexion,
    ContrainteCreation,
    CoursCreation,
    CreneauCreation,
    Disponibilite,
    DuplicationSemaine,
    EmploiDuTempsCreation,
    EmploiDuTempsModification,
    EnseignantCreation,
    Entree,
    FiliereCreation,
    Generation,
    GroupeCreation,
    Jour,
    JourFerieCreation,
    MatiereCreation,
    PauseCreation,
    PromptCreation,
    PromptReponse,
    SalleCreation,
    SeanceCreation,
    SeanceModele,
    SeanceModification,
    SemaineType,
    SemestreCreation,
    TypeSalleCreation,
    UtilisateurCreation,
    modification,
)


@asynccontextmanager
async def cycle_de_vie(app: FastAPI):
    sv.pool.open()
    yield
    sv.pool.close()


app = FastAPI(
    title="Planification des cours — API",
    description=(
        "API REST de planification des cours et de génération automatique des emplois du temps. "
        "Les contraintes dures (CD-01 à CD-11) sont contrôlées par la base : une séance refusée "
        "renvoie **409** avec le code de la contrainte violée et son motif."
    ),
    version="1.0.0",
    lifespan=cycle_de_vie,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in sv.settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def refus_metier(request: Request, exc: Exception) -> JSONResponse:
    """Traduit un refus de la base (contrainte, unicité, clé étrangère) en 409 lisible."""
    motif = sv.motif_refus(exc)
    return JSONResponse(status_code=409, content={"detail": motif["message"], "code": motif["code"]})


for erreur in sv.ERREURS_METIER:
    app.add_exception_handler(erreur, refus_metier)


@app.get("/sante", tags=["Système"], summary="État de l'API et de la base")
def sante(conn: Connection = Depends(get_conn)) -> dict:
    fetch_one(conn, "SELECT 1")
    return {"api": "ok", "base": "ok", "authentification": sv.settings.auth_enabled}


# =====================================================================
#  CRUD GÉNÉRIQUE (tables simples du référentiel)
# =====================================================================

def routeur_crud(
    *,
    table: str,
    cle: str,
    creation: type[BaseModel],
    objet: str,
    tri: str,
    filtres: tuple[str, ...] = (),
    type_cle: type = int,
    lecture_publique: bool = True,
) -> APIRouter:
    """Crée GET (liste), GET /{id}, POST, PATCH /{id} et DELETE /{id} pour une table.

    Lecture : tout utilisateur, et le mode invité si `lecture_publique` ;
    écriture : administrateur ou planificateur. `filtres` liste les colonnes
    filtrables en paramètre de requête (ex. /classes?id_filiere=1).
    """
    routeur = APIRouter()
    Modification = modification(creation)
    lecteur = sv.utilisateur_facultatif if lecture_publique else sv.utilisateur_courant
    ident = sql.Identifier(table)
    col_cle = sql.Identifier(cle)

    @routeur.get("", summary=f"Lister : {objet}")
    def lister(conn: Connection = Depends(get_conn), _=Depends(lecteur), **criteres) -> list[dict]:
        actifs = {c: v for c, v in criteres.items() if v is not None}
        where = sql.SQL("")
        if actifs:
            where = sql.SQL(" WHERE ") + sql.SQL(" AND ").join(
                sql.SQL("{} = %s").format(sql.Identifier(c)) for c in actifs
            )
        requete = sql.SQL("SELECT * FROM {}{} ORDER BY {}").format(ident, where, sql.SQL(tri))
        return fetch_all(conn, requete, list(actifs.values()))

    # Expose les filtres comme paramètres de requête typés dans OpenAPI
    signature = inspect.signature(lister)
    parametres = [p for p in signature.parameters.values() if p.kind != p.VAR_KEYWORD]
    parametres += [
        inspect.Parameter(f, inspect.Parameter.KEYWORD_ONLY, default=None, annotation=int | None)
        for f in filtres
    ]
    lister.__signature__ = signature.replace(parameters=parametres)

    @routeur.get("/{id_}", summary=f"Détail : {objet}")
    def detail(id_: type_cle, conn: Connection = Depends(get_conn), _=Depends(lecteur)) -> dict:
        requete = sql.SQL("SELECT * FROM {} WHERE {} = %s").format(ident, col_cle)
        return fetch_or_404(conn, requete, [id_], objet)

    @routeur.post("", status_code=201, summary=f"Créer : {objet}", dependencies=[gestion])
    def creer(donnees: creation, conn: Connection = Depends(get_conn)) -> dict:
        return sv.inserer(conn, table, donnees.model_dump())

    @routeur.patch("/{id_}", summary=f"Modifier : {objet}", dependencies=[gestion])
    def maj(id_: type_cle, donnees: Modification, conn: Connection = Depends(get_conn)) -> dict:
        return sv.modifier(conn, table, cle, id_, donnees.model_dump(exclude_unset=True), objet)

    @routeur.delete("/{id_}", status_code=204, summary=f"Supprimer : {objet}", dependencies=[gestion])
    def supprimer(id_: type_cle, conn: Connection = Depends(get_conn)) -> Response:
        requete = sql.SQL("DELETE FROM {} WHERE {} = %s RETURNING {}").format(ident, col_cle, col_cle)
        fetch_or_404(conn, requete, [id_], objet)
        return Response(status_code=204)

    return routeur


# =====================================================================
#  AUTHENTIFICATION ET UTILISATEURS (BF-25)
# =====================================================================

COLONNES_UTILISATEUR = "id_utilisateur, login, email, role"   # jamais le mot de passe
UtilisateurModification = modification(UtilisateurCreation)

auth = APIRouter(prefix="/auth", tags=["Authentification"])
utilisateurs = APIRouter(
    prefix="/utilisateurs", tags=["Utilisateurs"], dependencies=[Depends(sv.exiger_roles("administrateur"))]
)


@auth.post("/connexion", summary="Se connecter (renvoie un jeton JWT)")
def connexion(identifiants: Connexion, conn: Connection = Depends(get_conn)) -> dict:
    utilisateur = fetch_one(conn, "SELECT * FROM utilisateur WHERE login = %s", [identifiants.login])
    if (
        utilisateur is None
        or not utilisateur["mot_de_passe"]
        or not sv.verifier_mot_de_passe(identifiants.mot_de_passe, utilisateur["mot_de_passe"])
    ):
        raise HTTPException(401, "Identifiant ou mot de passe incorrect")
    return {
        "access_token": sv.creer_jeton(utilisateur),
        "token_type": "bearer",
        "utilisateur": {k: utilisateur[k] for k in ("id_utilisateur", "login", "email", "role")},
    }


@auth.get("/moi", summary="Utilisateur connecté")
def moi(utilisateur: dict | None = Depends(sv.utilisateur_courant)) -> dict | None:
    return utilisateur


def _hacher(valeurs: dict) -> dict:
    if valeurs.get("mot_de_passe"):
        valeurs["mot_de_passe"] = sv.hacher_mot_de_passe(valeurs["mot_de_passe"])
    return valeurs


def _sans_secret(ligne: dict) -> dict:
    return {k: v for k, v in ligne.items() if k != "mot_de_passe"}


@utilisateurs.get("", summary="Lister les utilisateurs")
def lister_utilisateurs(conn: Connection = Depends(get_conn)) -> list[dict]:
    return fetch_all(conn, f"SELECT {COLONNES_UTILISATEUR} FROM utilisateur ORDER BY login")


@utilisateurs.get("/{id_}", summary="Détail d'un utilisateur")
def detail_utilisateur(id_: int, conn: Connection = Depends(get_conn)) -> dict:
    return fetch_or_404(
        conn, f"SELECT {COLONNES_UTILISATEUR} FROM utilisateur WHERE id_utilisateur = %s", [id_], "Utilisateur"
    )


@utilisateurs.post("", status_code=201, summary="Créer un utilisateur")
def creer_utilisateur(donnees: UtilisateurCreation, conn: Connection = Depends(get_conn)) -> dict:
    return _sans_secret(sv.inserer(conn, "utilisateur", _hacher(donnees.model_dump())))


@utilisateurs.patch("/{id_}", summary="Modifier un utilisateur (rôle, e-mail, mot de passe)")
def modifier_utilisateur(
    id_: int, donnees: UtilisateurModification, conn: Connection = Depends(get_conn)
) -> dict:
    valeurs = _hacher(donnees.model_dump(exclude_unset=True))
    return _sans_secret(sv.modifier(conn, "utilisateur", "id_utilisateur", id_, valeurs, "Utilisateur"))


@utilisateurs.delete("/{id_}", status_code=204, summary="Supprimer un utilisateur")
def supprimer_utilisateur(id_: int, conn: Connection = Depends(get_conn)) -> Response:
    fetch_or_404(
        conn, "DELETE FROM utilisateur WHERE id_utilisateur = %s RETURNING id_utilisateur", [id_], "Utilisateur"
    )
    return Response(status_code=204)


# =====================================================================
#  RÉFÉRENTIEL (BF-01 à BF-06, BF-26)
# =====================================================================

referentiel = APIRouter(tags=["Référentiel"])

for prefixe, table, cle, modele, objet, tri, filtres in [
    ("filieres", "filiere", "id_filiere", FiliereCreation, "Filière", "code_filiere", ()),
    ("classes", "classe", "id_classe", ClasseCreation, "Classe", "code_classe", ("id_filiere",)),
    ("groupes", "groupe", "id_groupe", GroupeCreation, "Groupe", "id_classe, code_groupe", ("id_classe",)),
    ("matieres", "matiere", "id_matiere", MatiereCreation, "Matière", "code_matiere", ()),
    ("types-salle", "type_salle", "id_type_salle", TypeSalleCreation, "Type de salle", "libelle", ()),
    ("salles", "salle", "id_salle", SalleCreation, "Salle", "code_salle", ("id_type_salle",)),
    ("semestres", "semestre", "id_semestre", SemestreCreation, "Semestre", "date_debut DESC", ()),
    ("pauses", "pause", "id_pause", PauseCreation, "Pause", "heure_debut", ()),
]:
    referentiel.include_router(
        routeur_crud(table=table, cle=cle, creation=modele, objet=objet, tri=tri, filtres=filtres),
        prefix=f"/{prefixe}",
    )

referentiel.include_router(
    routeur_crud(
        table="jour_ferie", cle="date_ferie", creation=JourFerieCreation,
        objet="Jour férié", tri="date_ferie", type_cle=date,
    ),
    prefix="/jours-feries",
)

ORDRE_JOURS = "array_position(ARRAY['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'], jour)"
creneaux = routeur_crud(
    table="creneau", cle="id_creneau", creation=CreneauCreation, objet="Créneau",
    tri=f"{ORDRE_JOURS}, heure_debut",
)


class Grille(Entree):
    jours: list[Jour] = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"]
    heure_debut: time = time(8, 0)
    heure_fin: time = time(18, 0)
    pas_minutes: int = Field(60, ge=15, le=240)


@creneaux.post("/grille", status_code=201, summary="Générer une grille de créneaux (BF-05)", dependencies=[gestion])
def generer_grille(grille: Grille, conn: Connection = Depends(get_conn)) -> list[dict]:
    """Crée les créneaux réguliers manquants (les créneaux existants sont conservés)."""
    lignes = []
    for jour in grille.jours:
        debut = datetime.combine(date.min, grille.heure_debut)
        fin_journee = datetime.combine(date.min, grille.heure_fin)
        while debut + timedelta(minutes=grille.pas_minutes) <= fin_journee:
            fin = debut + timedelta(minutes=grille.pas_minutes)
            lignes.append((jour, debut.time(), fin.time()))
            debut = fin
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO creneau (jour, heure_debut, heure_fin) VALUES (%s, %s, %s) "
            "ON CONFLICT (jour, heure_debut, heure_fin) DO NOTHING",
            lignes,
        )
    return fetch_all(conn, f"SELECT * FROM creneau ORDER BY {ORDRE_JOURS}, heure_debut")


referentiel.include_router(creneaux, prefix="/creneaux")


# --- Enseignants et disponibilités (BF-08, BF-09) ----------------------------------

enseignants = routeur_crud(
    table="enseignant", cle="id_enseignant", creation=EnseignantCreation,
    objet="Enseignant", tri="nom, prenom", lecture_publique=False,   # données personnelles (BNF-09)
)


@enseignants.get("/{id_}/disponibilites", summary="Disponibilités d'un enseignant")
def lister_disponibilites(
    id_: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_courant)
) -> list[dict]:
    """Seuls les créneaux renseignés sont renvoyés ; les autres valent « disponible »."""
    return fetch_all(
        conn,
        f"""SELECT d.id_creneau, c.jour, c.heure_debut, c.heure_fin, d.niveau, d.motif
            FROM disponibilite d JOIN creneau c USING (id_creneau)
            WHERE d.id_enseignant = %s
            ORDER BY {ORDRE_JOURS.replace('jour', 'c.jour')}, c.heure_debut""",
        [id_],
    )


@enseignants.put("/{id_}/disponibilites", summary="Remplacer les disponibilités d'un enseignant")
def remplacer_disponibilites(
    id_: int,
    disponibilites: list[Disponibilite],
    conn: Connection = Depends(get_conn),
    utilisateur: dict | None = Depends(sv.utilisateur_courant),
) -> list[dict]:
    """Remplace toute la saisie. Un enseignant ne modifie que la sienne (rapprochement par e-mail)."""
    enseignant = fetch_or_404(
        conn, "SELECT email FROM enseignant WHERE id_enseignant = %s", [id_], "Enseignant"
    )
    if sv.settings.auth_enabled and utilisateur["role"] not in sv.GESTION and not (
        utilisateur["role"] == "enseignant" and enseignant["email"] == utilisateur["email"]
    ):
        raise HTTPException(403, "Vous ne pouvez modifier que vos propres disponibilités")
    with conn.cursor() as cur:
        cur.execute("DELETE FROM disponibilite WHERE id_enseignant = %s", [id_])
        cur.executemany(
            "INSERT INTO disponibilite (id_enseignant, id_creneau, niveau, motif) VALUES (%s, %s, %s, %s)",
            [(id_, d.id_creneau, d.niveau, d.motif) for d in disponibilites if d.niveau != "disponible"],
        )
    return lister_disponibilites(id_, conn)


@enseignants.get("/{id_}/cours", summary="Cours assurés par un enseignant")
def cours_enseignant(
    id_: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_courant)
) -> list[dict]:
    return fetch_all(conn, "SELECT * FROM cours WHERE id_enseignant = %s ORDER BY id_cours", [id_])


# --- Cours et découpage hebdomadaire (BF-02, BF-03) -----------------------------------

cours = routeur_crud(
    table="cours", cle="id_cours", creation=CoursCreation, objet="Cours", tri="id_cours",
    filtres=("id_classe", "id_groupe", "id_enseignant", "id_semestre", "id_matiere"),
)


@cours.get("/{id_}/decoupage", summary="Découpage hebdomadaire d'un cours")
def lire_decoupage(
    id_: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_facultatif)
) -> list[dict]:
    """Vide = le cours est placé en une séance de `duree_seance` heures."""
    fetch_or_404(conn, "SELECT 1 FROM cours WHERE id_cours = %s", [id_], "Cours")
    return fetch_all(conn, "SELECT * FROM cours_seance_modele WHERE id_cours = %s ORDER BY rang", [id_])


@cours.put("/{id_}/decoupage", summary="Remplacer le découpage d'un cours", dependencies=[gestion])
def remplacer_decoupage(id_: int, seances: list[SeanceModele], conn: Connection = Depends(get_conn)) -> list[dict]:
    """Exemple : [{"rang": 1, "duree_heures": 2}, {"rang": 2, "duree_heures": 3}]."""
    fetch_or_404(conn, "SELECT 1 FROM cours WHERE id_cours = %s", [id_], "Cours")
    rangs = [s.rang for s in seances]
    if len(rangs) != len(set(rangs)):
        raise HTTPException(422, "Chaque rang doit être unique")
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cours_seance_modele WHERE id_cours = %s", [id_])
        cur.executemany(
            "INSERT INTO cours_seance_modele (id_cours, rang, duree_heures) VALUES (%s, %s, %s)",
            [(id_, s.rang, s.duree_heures) for s in seances],
        )
    return lire_decoupage(id_, conn)


# =====================================================================
#  EMPLOIS DU TEMPS : versions et publication (BF-19), contraintes (BF-16),
#  semaine type et duplication (BF-14), génération (BF-15 à BF-18), prompts
# =====================================================================

edts = APIRouter(prefix="/emplois-du-temps", tags=["Emplois du temps"])
contraintes = APIRouter(prefix="/contraintes", tags=["Contraintes"])
prompts = APIRouter(prefix="/prompts", tags=["Prompts"])

ContrainteModification = modification(ContrainteCreation)

# Contraintes souples du cahier des charges (§4.2), créées avec chaque emploi du
# temps. Poids : élevé = 10, moyen = 5, faible = 2 ; modifiables avant génération.
CONTRAINTES_PAR_DEFAUT = [
    ("CS-01", "Placer les séances sur les créneaux préférés de l'enseignant", 10),
    ("CS-02", "Éviter les trous dans la journée d'un groupe", 5),
    ("CS-03", "Limiter les changements de bâtiment entre deux séances consécutives", 5),
    ("CS-04", "Répartir les heures d'un cours régulièrement sur le semestre", 5),
    ("CS-05", "Placer le CM d'un cours avant ses TD et TP dans la semaine", 2),
    ("CS-06", "Ne pas dépasser un nombre maximal d'heures par jour pour un enseignant", 2),
]


def _edt(conn: Connection, id_edt: int) -> dict:
    return fetch_or_404(conn, "SELECT * FROM emploi_du_temps WHERE id_edt = %s", [id_edt], "Emploi du temps")


def _auteur(id_utilisateur: int | None, utilisateur: dict | None) -> int:
    if id_utilisateur is not None:
        return id_utilisateur
    if utilisateur is not None:
        return utilisateur["id_utilisateur"]
    raise HTTPException(422, "id_utilisateur est obligatoire quand personne n'est connecté")


def _changer_statut(conn: Connection, id_edt: int, depuis: tuple[str, ...], vers: str) -> dict:
    edt = _edt(conn, id_edt)
    if edt["statut"] not in depuis:
        raise HTTPException(409, f"Impossible de passer de « {edt['statut']} » à « {vers} »")
    return fetch_one(
        conn,
        """UPDATE emploi_du_temps SET statut = %s,
                  date_publication = CASE WHEN %s::text = 'publie' THEN now() ELSE date_publication END
           WHERE id_edt = %s RETURNING *""",
        [vers, vers, id_edt],
    )


@edts.get("", summary="Lister les emplois du temps")
def lister_edts(
    id_semestre: int | None = None,
    statut: str | None = None,
    conn: Connection = Depends(get_conn),
    _=Depends(sv.utilisateur_facultatif),
) -> list[dict]:
    return fetch_all(
        conn,
        """SELECT e.*,
                  (SELECT count(*) FROM seance s
                   WHERE s.id_edt = e.id_edt AND s.statut <> 'annulee') AS nb_seances
           FROM emploi_du_temps e
           WHERE (%(sem)s::bigint IS NULL OR e.id_semestre = %(sem)s)
             AND (%(statut)s::text IS NULL OR e.statut = %(statut)s)
           ORDER BY e.date_creation DESC""",
        {"sem": id_semestre, "statut": statut},
    )


@edts.post("", status_code=201, summary="Créer un emploi du temps (brouillon)")
def creer_edt(
    donnees: EmploiDuTempsCreation, conn: Connection = Depends(get_conn), utilisateur: dict | None = gestion
) -> dict:
    edt = sv.inserer(
        conn,
        "emploi_du_temps",
        {
            "libelle": donnees.libelle,
            "id_semestre": donnees.id_semestre,
            "mode_generation": donnees.mode_generation,
            "id_utilisateur": _auteur(donnees.id_utilisateur, utilisateur),
        },
    )
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO contrainte (libelle, type_contrainte, nature, poids, id_edt)
               VALUES (%s, %s, 'souple', %s, %s)""",
            [(libelle, code, poids, edt["id_edt"]) for code, libelle, poids in CONTRAINTES_PAR_DEFAUT],
        )
    return edt


@edts.get("/{id_edt}", summary="Détail d'un emploi du temps")
def detail_edt(id_edt: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_facultatif)) -> dict:
    return _edt(conn, id_edt)


@edts.patch("/{id_edt}", summary="Renommer un emploi du temps")
def modifier_edt(
    id_edt: int, donnees: EmploiDuTempsModification, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    sv.edt_modifiable(conn, id_edt)
    valeurs = donnees.model_dump(exclude_unset=True)
    return sv.modifier(conn, "emploi_du_temps", "id_edt", id_edt, valeurs, "Emploi du temps")


@edts.delete("/{id_edt}", status_code=204, summary="Supprimer un brouillon")
def supprimer_edt(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> Response:
    sv.edt_modifiable(conn, id_edt)
    conn.execute("DELETE FROM emploi_du_temps WHERE id_edt = %s", [id_edt])
    return Response(status_code=204)


@edts.post("/{id_edt}/valider", summary="Valider (brouillon → valide)")
def valider_edt(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    return _changer_statut(conn, id_edt, ("brouillon",), "valide")


@edts.post("/{id_edt}/repasser-en-brouillon", summary="Revenir en brouillon (valide → brouillon)")
def repasser_en_brouillon(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    return _changer_statut(conn, id_edt, ("valide",), "brouillon")


@edts.post("/{id_edt}/publier", summary="Publier (valide → publie)")
def publier_edt(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    """L'emploi du temps publié précédemment pour le même semestre est archivé."""
    edt = _changer_statut(conn, id_edt, ("valide",), "publie")
    conn.execute(
        """UPDATE emploi_du_temps SET statut = 'archive'
           WHERE id_semestre = %s AND statut = 'publie' AND id_edt <> %s""",
        [edt["id_semestre"], id_edt],
    )
    return edt


@edts.post("/{id_edt}/archiver", summary="Archiver")
def archiver_edt(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    return _changer_statut(conn, id_edt, ("brouillon", "valide", "publie"), "archive")


@edts.post("/{id_edt}/nouvelle-version", status_code=201, summary="Copier en nouvelle version (brouillon)")
def nouvelle_version(id_edt: int, conn: Connection = Depends(get_conn), utilisateur: dict | None = gestion) -> dict:
    """Copie l'emploi du temps, ses contraintes et ses séances (hors annulées) : historique BF-19."""
    source = _edt(conn, id_edt)
    copie = fetch_one(
        conn,
        """INSERT INTO emploi_du_temps (libelle, version, mode_generation, id_semestre, id_utilisateur)
           VALUES (%(libelle)s,
                   (SELECT max(version) + 1 FROM emploi_du_temps
                    WHERE id_semestre = %(sem)s AND libelle = %(libelle)s),
                   %(mode)s, %(sem)s, %(auteur)s)
           RETURNING *""",
        {
            "libelle": source["libelle"],
            "sem": source["id_semestre"],
            "mode": source["mode_generation"],
            "auteur": utilisateur["id_utilisateur"] if utilisateur else source["id_utilisateur"],
        },
    )
    conn.execute(
        """INSERT INTO contrainte (libelle, type_contrainte, nature, poids, est_active, id_edt)
           SELECT libelle, type_contrainte, nature, poids, est_active, %s
           FROM contrainte WHERE id_edt = %s""",
        [copie["id_edt"], id_edt],
    )
    conn.execute(
        """INSERT INTO seance (date_seance, heure_debut, heure_fin, statut, est_verrouillee,
                               id_cours, id_salle, id_creneau, id_edt)
           SELECT date_seance, heure_debut, heure_fin, statut, est_verrouillee,
                  id_cours, id_salle, id_creneau, %s
           FROM seance WHERE id_edt = %s AND statut <> 'annulee'
           ORDER BY date_seance, heure_debut""",
        [copie["id_edt"], id_edt],
    )
    return copie


@edts.post("/{id_edt}/semaine-type", summary="Écrire une semaine type sur tout le semestre (§7.7)")
def semaine_type(id_edt: int, donnees: SemaineType, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    """Crée les séances datées de chaque semaine du semestre en sautant les jours fériés.

    Le rapport liste les séances créées, les cours dont le volume horaire est
    atteint (CD-08) et chaque séance refusée avec son motif.
    """
    placements = [p.model_dump() for p in donnees.placements]
    return sv.appliquer_semaine_type(conn, id_edt, placements, remplacer=donnees.remplacer)


@edts.post("/{id_edt}/dupliquer-semaine", summary="Dupliquer une semaine sur tout le semestre (BF-14)")
def dupliquer_semaine(
    id_edt: int, donnees: DuplicationSemaine, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    placements = sv.seances_de_la_semaine(conn, id_edt, donnees.date_semaine)
    if not placements:
        raise HTTPException(422, "La semaine modèle ne contient aucune séance")
    return sv.appliquer_semaine_type(
        conn, id_edt, placements, remplacer=donnees.remplacer, semaine_exclue=sv.lundi(donnees.date_semaine)
    )


@edts.post("/{id_edt}/generer", status_code=202, summary="Lancer la génération automatique (BF-15)")
def generer(
    id_edt: int,
    taches: BackgroundTasks,
    donnees: Generation | None = None,
    conn: Connection = Depends(get_conn),
    _=gestion,
) -> dict:
    """Lance le moteur OR-Tools en tâche de fond. Suivre l'avancement avec GET .../generation.

    Les séances verrouillées (est_verrouillee) sont conservées (BF-17) ;
    les autres sont remplacées par le résultat du moteur.
    """
    sv.edt_modifiable(conn, id_edt)
    if sv.charger_moteur() is None:
        raise HTTPException(503, "Le moteur de génération (tâche 2) n'est pas encore branché")
    if not sv.demarrer_generation(id_edt):
        raise HTTPException(409, "Une génération est déjà en cours pour cet emploi du temps")
    taches.add_task(sv.executer_generation, id_edt, (donnees or Generation()).duree_max_secondes)
    return {"id_edt": id_edt, "etat": "en_cours"}


@edts.get("/{id_edt}/generation", summary="Avancement et rapport de la génération (BF-18)")
def etat_generation(id_edt: int, _=Depends(sv.utilisateur_courant)) -> dict:
    suivi = sv.generations.get(id_edt)
    if suivi is None:
        raise HTTPException(404, "Aucune génération lancée pour cet emploi du temps")
    return {"id_edt": id_edt, **suivi}


# --- Contraintes (BF-16) -----------------------------------------------------------

@edts.get("/{id_edt}/contraintes", summary="Contraintes et poids d'un emploi du temps", tags=["Contraintes"])
def lister_contraintes(id_edt: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_courant)) -> list[dict]:
    return fetch_all(
        conn, "SELECT * FROM contrainte WHERE id_edt = %s ORDER BY type_contrainte, id_contrainte", [id_edt]
    )


@edts.post("/{id_edt}/contraintes", status_code=201, summary="Ajouter une contrainte", tags=["Contraintes"])
def ajouter_contrainte(
    id_edt: int, donnees: ContrainteCreation, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    sv.edt_modifiable(conn, id_edt)
    return sv.inserer(conn, "contrainte", {**donnees.model_dump(), "id_edt": id_edt})


def _contrainte_modifiable(conn: Connection, id_contrainte: int) -> None:
    contrainte = fetch_or_404(
        conn, "SELECT id_edt FROM contrainte WHERE id_contrainte = %s", [id_contrainte], "Contrainte"
    )
    sv.edt_modifiable(conn, contrainte["id_edt"])


@contraintes.patch("/{id_contrainte}", summary="Modifier une contrainte (poids, activation)")
def modifier_contrainte(
    id_contrainte: int, donnees: ContrainteModification, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    _contrainte_modifiable(conn, id_contrainte)
    valeurs = donnees.model_dump(exclude_unset=True)
    return sv.modifier(conn, "contrainte", "id_contrainte", id_contrainte, valeurs, "Contrainte")


@contraintes.delete("/{id_contrainte}", status_code=204, summary="Supprimer une contrainte")
def supprimer_contrainte(id_contrainte: int, conn: Connection = Depends(get_conn), _=gestion) -> Response:
    _contrainte_modifiable(conn, id_contrainte)
    conn.execute("DELETE FROM contrainte WHERE id_contrainte = %s", [id_contrainte])
    return Response(status_code=204)


# --- Prompts ------------------------------------------------------------------------

@edts.get("/{id_edt}/prompts", summary="Historique des prompts d'un emploi du temps", tags=["Prompts"])
def lister_prompts(id_edt: int, conn: Connection = Depends(get_conn), _=gestion) -> list[dict]:
    return fetch_all(conn, "SELECT * FROM prompt WHERE id_edt = %s ORDER BY date_prompt DESC", [id_edt])


@edts.post("/{id_edt}/prompts", status_code=201, summary="Soumettre un prompt", tags=["Prompts"])
def soumettre_prompt(
    id_edt: int, donnees: PromptCreation, conn: Connection = Depends(get_conn), utilisateur: dict | None = gestion
) -> dict:
    """Enregistre la demande (statut « en_attente ») ; le traitement par le LLM la complète."""
    _edt(conn, id_edt)
    return sv.inserer(
        conn,
        "prompt",
        {"texte": donnees.texte, "id_edt": id_edt, "id_utilisateur": _auteur(donnees.id_utilisateur, utilisateur)},
    )


@prompts.patch("/{id_prompt}", summary="Enregistrer la réponse à un prompt")
def repondre_prompt(id_prompt: int, donnees: PromptReponse, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    return sv.modifier(conn, "prompt", "id_prompt", id_prompt, donnees.model_dump(), "Prompt")


# =====================================================================
#  SÉANCES : planification manuelle (BF-11 à BF-13)
# =====================================================================

seances = APIRouter(prefix="/seances", tags=["Séances"])


def _seance(conn: Connection, id_seance: int) -> dict:
    return fetch_or_404(
        conn, f"SELECT {sv.COLONNES_SEANCE} FROM seance WHERE id_seance = %s", [id_seance], "Séance"
    )


def _creer_seance(conn: Connection, donnees: SeanceCreation) -> dict:
    return sv.inserer_seance(
        conn,
        id_edt=donnees.id_edt,
        id_cours=donnees.id_cours,
        id_salle=donnees.id_salle,
        id_creneau=donnees.id_creneau,
        date_seance=donnees.date_seance,
        duree=donnees.duree_heures,
        est_verrouillee=donnees.est_verrouillee,
    )


@seances.get("", summary="Lister les séances d'un emploi du temps")
def lister_seances(
    id_edt: int,
    du: date | None = None,
    au: date | None = None,
    id_cours: int | None = None,
    inclure_annulees: bool = False,
    conn: Connection = Depends(get_conn),
    _=Depends(sv.utilisateur_courant),
) -> list[dict]:
    return fetch_all(
        conn,
        f"""SELECT {sv.COLONNES_SEANCE} FROM seance
            WHERE id_edt = %(id_edt)s
              AND (%(du)s::date IS NULL OR date_seance >= %(du)s)
              AND (%(au)s::date IS NULL OR date_seance <= %(au)s)
              AND (%(cours)s::bigint IS NULL OR id_cours = %(cours)s)
              AND (%(annulees)s OR statut <> 'annulee')
            ORDER BY date_seance, heure_debut""",
        {"id_edt": id_edt, "du": du, "au": au, "cours": id_cours, "annulees": inclure_annulees},
    )


@seances.get("/propositions", summary="Salles et créneaux compatibles (BF-13)")
def propositions(
    id_edt: int,
    id_cours: int,
    date_seance: date,
    duree_heures: Decimal | None = Query(None, ge=2, le=4),
    limite: int = Query(20, ge=1, le=200),
    conn: Connection = Depends(get_conn),
    _=gestion,
) -> list[dict]:
    """Chaque proposition est testée par la base : elle respecte toutes les contraintes dures."""
    return sv.proposer(
        conn, id_edt=id_edt, id_cours=id_cours, date_seance=date_seance, duree=duree_heures, limite=limite
    )


@seances.post("/verifier", summary="Contrôler une séance sans l'enregistrer (BF-12)")
def verifier_seance(donnees: SeanceCreation, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    """Renvoie {"valide": true} ou {"valide": false, "motif": {"code": "CD-02", "message": ...}}."""
    return sv.a_blanc(conn, lambda: _creer_seance(conn, donnees))


@seances.post("", status_code=201, summary="Créer une séance (BF-11)")
def creer_seance(donnees: SeanceCreation, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    sv.edt_modifiable(conn, donnees.id_edt)
    return _creer_seance(conn, donnees)


@seances.get("/{id_seance}", summary="Détail d'une séance")
def detail_seance(id_seance: int, conn: Connection = Depends(get_conn), _=Depends(sv.utilisateur_courant)) -> dict:
    return _seance(conn, id_seance)


@seances.post("/{id_seance}/verifier", summary="Contrôler un déplacement sans l'enregistrer (BF-12)")
def verifier_deplacement(
    id_seance: int, donnees: SeanceModification, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    seance = _seance(conn, id_seance)
    return sv.a_blanc(conn, lambda: sv.modifier_seance(conn, seance, donnees.model_dump(exclude_unset=True)))


@seances.patch("/{id_seance}", summary="Déplacer / modifier une séance (glisser-déposer)")
def deplacer_seance(
    id_seance: int, donnees: SeanceModification, conn: Connection = Depends(get_conn), _=gestion
) -> dict:
    seance = _seance(conn, id_seance)
    sv.edt_modifiable(conn, seance["id_edt"])
    return sv.modifier_seance(conn, seance, donnees.model_dump(exclude_unset=True))


@seances.post("/{id_seance}/annuler", summary="Annuler une séance (conservée dans l'historique)")
def annuler_seance(id_seance: int, conn: Connection = Depends(get_conn), _=gestion) -> dict:
    seance = _seance(conn, id_seance)
    sv.edt_modifiable(conn, seance["id_edt"])
    return sv.modifier_seance(conn, seance, {"statut": "annulee"})


@seances.delete("/{id_seance}", status_code=204, summary="Supprimer une séance")
def supprimer_seance(id_seance: int, conn: Connection = Depends(get_conn), _=gestion) -> Response:
    seance = _seance(conn, id_seance)
    sv.edt_modifiable(conn, seance["id_edt"])
    conn.execute("DELETE FROM seance WHERE id_seance = %s", [id_seance])
    return Response(status_code=204)


# =====================================================================
#  CONSULTATION (BF-21, BF-22)
#  Accessible sans compte (mode invité des étudiants). Sans `id_edt`, seuls
#  les emplois du temps publiés sont montrés ; un brouillon n'est visible
#  que des planificateurs et administrateurs.
# =====================================================================

consultation = APIRouter(prefix="/consultation", tags=["Consultation"])

Vue = Literal["groupes", "classes", "enseignants", "salles", "filieres"]

FILTRES_VUE = {
    # Un groupe suit ses propres cours et les cours de classe entière de sa classe
    "groupes": """(co.id_groupe = %(id)s OR (co.id_groupe IS NULL AND co.id_classe =
                   (SELECT id_classe FROM groupe WHERE id_groupe = %(id)s)))""",
    "classes": "co.id_classe = %(id)s",
    "enseignants": "co.id_enseignant = %(id)s",
    "salles": "s.id_salle = %(id)s",
    "filieres": "cl.id_filiere = %(id)s",
}

REQUETE_CONSULTATION = """
SELECT s.id_seance, s.date_seance, cr.jour, s.heure_debut, s.heure_fin, s.statut,
       s.est_verrouillee, s.id_edt,
       co.id_cours, co.type_cours, m.code_matiere, m.libelle AS matiere,
       e.id_enseignant, e.prenom || ' ' || e.nom AS enseignant,
       sa.id_salle, sa.code_salle, sa.nom_salle, sa.batiment,
       cl.id_classe, cl.code_classe, g.id_groupe, g.code_groupe,
       f.id_filiere, f.code_filiere
FROM seance s
JOIN cours co      ON co.id_cours      = s.id_cours
JOIN matiere m     ON m.id_matiere     = co.id_matiere
JOIN enseignant e  ON e.id_enseignant  = co.id_enseignant
JOIN salle sa      ON sa.id_salle      = s.id_salle
JOIN creneau cr    ON cr.id_creneau    = s.id_creneau
JOIN classe cl     ON cl.id_classe     = co.id_classe
JOIN filiere f     ON f.id_filiere     = cl.id_filiere
LEFT JOIN groupe g ON g.id_groupe      = co.id_groupe
JOIN emploi_du_temps edt ON edt.id_edt = s.id_edt
WHERE {filtre}
  AND (%(id_edt)s::bigint IS NULL AND edt.statut = 'publie' OR s.id_edt = %(id_edt)s)
  AND (%(du)s::date IS NULL OR s.date_seance >= %(du)s)
  AND (%(au)s::date IS NULL OR s.date_seance <= %(au)s)
  AND (%(annulees)s OR s.statut <> 'annulee')
ORDER BY s.date_seance, s.heure_debut
"""


def _seances_vue(
    conn: Connection, vue: Vue, id_: int, id_edt: int | None, du: date | None, au: date | None,
    inclure_annulees: bool, utilisateur: dict | None,
) -> list[dict]:
    if id_edt is not None and sv.settings.auth_enabled and (
        utilisateur is None or utilisateur["role"] not in sv.GESTION
    ):
        edt = fetch_one(conn, "SELECT statut FROM emploi_du_temps WHERE id_edt = %s", [id_edt])
        if edt is None or edt["statut"] != "publie":
            raise HTTPException(403, "Seuls les emplois du temps publiés sont consultables")
    return fetch_all(
        conn,
        REQUETE_CONSULTATION.format(filtre=FILTRES_VUE[vue]),
        {"id": id_, "id_edt": id_edt, "du": du, "au": au, "annulees": inclure_annulees},
    )


@consultation.get("/{vue}/{id_}", summary="Emploi du temps d'un groupe, d'une classe, d'un enseignant, d'une salle ou d'une filière")
def consulter(
    vue: Vue,
    id_: int,
    id_edt: int | None = None,
    du: date | None = None,
    au: date | None = None,
    inclure_annulees: bool = False,
    conn: Connection = Depends(get_conn),
    utilisateur: dict | None = Depends(sv.utilisateur_facultatif),
) -> list[dict]:
    """Vue jour, semaine ou semestre : il suffit de choisir `du` et `au`."""
    return _seances_vue(conn, vue, id_, id_edt, du, au, inclure_annulees, utilisateur)


def _ical_texte(valeur: str) -> str:
    return valeur.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


@consultation.get("/{vue}/{id_}/ical", summary="Abonnement agenda iCalendar (BF-22)")
def ical(
    vue: Vue,
    id_: int,
    id_edt: int | None = None,
    conn: Connection = Depends(get_conn),
    utilisateur: dict | None = Depends(sv.utilisateur_facultatif),
) -> Response:
    lignes = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//2iE//Planification des cours//FR",
        "CALSCALE:GREGORIAN",
        "X-WR-TIMEZONE:Africa/Ouagadougou",
    ]
    horodatage = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for s in _seances_vue(conn, vue, id_, id_edt, None, None, True, utilisateur):
        debut = datetime.combine(s["date_seance"], s["heure_debut"]).strftime("%Y%m%dT%H%M%S")
        fin = datetime.combine(s["date_seance"], s["heure_fin"]).strftime("%Y%m%dT%H%M%S")
        titre = f"{s['type_cours']} {s['matiere']} ({s['code_groupe'] or s['code_classe']})"
        lieu = " - ".join(filter(None, [s["code_salle"], s["batiment"]]))
        lignes += [
            "BEGIN:VEVENT",
            f"UID:seance-{s['id_seance']}@planification-2ie",
            f"DTSTAMP:{horodatage}",
            f"DTSTART;TZID=Africa/Ouagadougou:{debut}",
            f"DTEND;TZID=Africa/Ouagadougou:{fin}",
            f"SUMMARY:{_ical_texte(titre)}",
            f"LOCATION:{_ical_texte(lieu)}",
            f"DESCRIPTION:{_ical_texte('Enseignant : ' + s['enseignant'])}",
            f"STATUS:{'CANCELLED' if s['statut'] == 'annulee' else 'CONFIRMED'}",
            "END:VEVENT",
        ]
    lignes.append("END:VCALENDAR")
    return Response(
        "\r\n".join(lignes) + "\r\n",
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="edt-{vue}-{id_}.ics"'},
    )


# =====================================================================
#  TABLEAUX DE BORD (BF-23, BF-24)
# =====================================================================

tableaux = APIRouter(
    prefix="/tableaux-de-bord", tags=["Tableaux de bord"], dependencies=[Depends(sv.utilisateur_courant)]
)

HEURES = "EXTRACT(EPOCH FROM (s.heure_fin - s.heure_debut)) / 3600"
HEURES_ACTIVES = f"COALESCE(SUM({HEURES}) FILTER (WHERE s.statut <> 'annulee'), 0)"


@tableaux.get("/volumes-horaires", summary="Heures planifiées / prévues par cours (BF-23)")
def volumes_horaires(id_edt: int, conn: Connection = Depends(get_conn)) -> list[dict]:
    edt = _edt(conn, id_edt)
    return fetch_all(
        conn,
        f"""SELECT co.id_cours, co.type_cours, m.code_matiere, m.libelle AS matiere,
                   cl.code_classe, g.code_groupe,
                   e.prenom || ' ' || e.nom AS enseignant,
                   co.volume_horaire AS heures_prevues,
                   {HEURES_ACTIVES} AS heures_planifiees,
                   co.volume_horaire - {HEURES_ACTIVES} AS heures_restantes,
                   ROUND(100 * {HEURES_ACTIVES} / co.volume_horaire, 1) AS taux_realisation
            FROM cours co
            JOIN matiere m     ON m.id_matiere    = co.id_matiere
            JOIN classe cl     ON cl.id_classe    = co.id_classe
            JOIN enseignant e  ON e.id_enseignant = co.id_enseignant
            LEFT JOIN groupe g ON g.id_groupe     = co.id_groupe
            LEFT JOIN seance s ON s.id_cours = co.id_cours AND s.id_edt = %s
            WHERE co.id_semestre = %s
            GROUP BY co.id_cours, m.code_matiere, m.libelle, cl.code_classe, g.code_groupe, e.prenom, e.nom
            ORDER BY cl.code_classe, m.code_matiere, co.type_cours""",
        [id_edt, edt["id_semestre"]],
    )


@tableaux.get("/occupation-salles", summary="Taux d'occupation des salles (BF-24)")
def occupation_salles(id_edt: int, conn: Connection = Depends(get_conn)) -> list[dict]:
    """Taux = heures occupées / heures ouvertes (grille hors pauses × semaines du semestre)."""
    return fetch_all(
        conn,
        f"""WITH periode AS (
                SELECT CEIL((sem.date_fin - sem.date_debut + 1) / 7.0) AS nb_semaines
                FROM emploi_du_temps edt JOIN semestre sem USING (id_semestre)
                WHERE edt.id_edt = %(id_edt)s
            ), grille AS (
                SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (c.heure_fin - c.heure_debut)) / 3600), 0) AS heures
                FROM creneau c
                WHERE NOT EXISTS (SELECT 1 FROM pause p
                                  WHERE c.heure_debut < p.heure_fin AND c.heure_fin > p.heure_debut)
            )
            SELECT sa.id_salle, sa.code_salle, sa.nom_salle, sa.batiment, sa.capacite,
                   COALESCE(SUM({HEURES}), 0) AS heures_occupees,
                   grille.heures * periode.nb_semaines AS heures_ouvertes,
                   ROUND(100 * COALESCE(SUM({HEURES}), 0)
                         / NULLIF(grille.heures * periode.nb_semaines, 0), 1) AS taux_occupation
            FROM salle sa
            CROSS JOIN periode CROSS JOIN grille
            LEFT JOIN seance s ON s.id_salle = sa.id_salle AND s.id_edt = %(id_edt)s
                               AND s.statut <> 'annulee'
            GROUP BY sa.id_salle, grille.heures, periode.nb_semaines
            ORDER BY taux_occupation DESC NULLS LAST, sa.code_salle""",
        {"id_edt": id_edt},
    )


@tableaux.get("/charge-enseignants", summary="Charge hebdomadaire des enseignants (BF-24, CS-06)")
def charge_enseignants(id_edt: int, conn: Connection = Depends(get_conn)) -> list[dict]:
    """Heures totales et semaine la plus chargée, comparées au plafond nb_heures_max_semaine."""
    return fetch_all(
        conn,
        f"""WITH par_semaine AS (
                SELECT co.id_enseignant, date_trunc('week', s.date_seance)::date AS semaine,
                       SUM({HEURES}) AS heures
                FROM seance s JOIN cours co ON co.id_cours = s.id_cours
                WHERE s.id_edt = %s AND s.statut <> 'annulee'
                GROUP BY co.id_enseignant, semaine
            )
            SELECT e.id_enseignant, e.prenom || ' ' || e.nom AS enseignant, e.nb_heures_max_semaine,
                   COALESCE(SUM(ps.heures), 0) AS heures_totales,
                   COALESCE(MAX(ps.heures), 0) AS heures_semaine_max,
                   COALESCE(MAX(ps.heures) > e.nb_heures_max_semaine, FALSE) AS depassement
            FROM enseignant e LEFT JOIN par_semaine ps ON ps.id_enseignant = e.id_enseignant
            GROUP BY e.id_enseignant
            ORDER BY heures_semaine_max DESC, e.nom""",
        [id_edt],
    )


# =====================================================================
#  MONTAGE DES ROUTES
# =====================================================================

app.include_router(auth)
app.include_router(utilisateurs)
app.include_router(referentiel)
app.include_router(enseignants, prefix="/enseignants", tags=["Enseignants"])
app.include_router(cours, prefix="/cours", tags=["Cours"])
app.include_router(edts)
app.include_router(contraintes)
app.include_router(prompts)
app.include_router(seances)
app.include_router(consultation)
app.include_router(tableaux)
