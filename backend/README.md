# API — Planification des cours (tâche 1)

API REST en **FastAPI** au-dessus de la base Supabase décrite dans `projet/schema_supabase.sql`.
Toutes les contraintes dures (CD-01 à CD-11) sont contrôlées par la base ; l'API traduit chaque refus en réponse **409** avec son motif.

## Lancer l'API

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # puis renseigner DATABASE_URL (fourni par l'équipe 5)
.venv/bin/uvicorn server.main:app --reload
```

- Documentation interactive : <http://localhost:8000/docs>
- Schéma OpenAPI (pour le front) : <http://localhost:8000/openapi.json>
- Vérifier la connexion à la base : `GET /sante`

## Pour l'équipe front (tâches 3 et 4)

| Besoin | Route |
|---|---|
| Référentiel (lecture libre, écriture planificateur) | `/filieres`, `/classes?id_filiere=`, `/groupes?id_classe=`, `/matieres`, `/salles`, `/types-salle`, `/creneaux`, `/pauses`, `/jours-feries`, `/semestres`, `/cours`, `/enseignants` |
| Grille de créneaux | `POST /creneaux/grille` |
| Disponibilités d'un enseignant | `GET` / `PUT /enseignants/{id}/disponibilites` |
| Découpage d'un cours | `GET` / `PUT /cours/{id}/decoupage` |
| Emplois du temps | `/emplois-du-temps`, puis `/valider`, `/publier`, `/archiver`, `/nouvelle-version` |
| Grille de planification | `GET /seances?id_edt=&du=&au=` |
| Glisser-déposer | `POST /seances/{id}/verifier` (contrôle sans enregistrer), puis `PATCH /seances/{id}` |
| Nouvelle séance | `POST /seances/verifier`, puis `POST /seances` |
| Salles / créneaux possibles | `GET /seances/propositions?id_edt=&id_cours=&date_seance=` |
| Dupliquer une semaine | `POST /emplois-du-temps/{id}/dupliquer-semaine` |
| Vue invité / étudiant | `GET /consultation/{groupes\|classes\|enseignants\|salles\|filieres}/{id}?du=&au=` |
| Abonnement agenda | `GET /consultation/{vue}/{id}/ical` |
| Tableaux de bord | `/tableaux-de-bord/volumes-horaires`, `/occupation-salles`, `/charge-enseignants` (`?id_edt=`) |

**Refus d'une séance** — exemple de réponse 409 :

```json
{ "detail": "CD-04 : capacité de la salle (30) inférieure à l'effectif à accueillir (45)", "code": "CD-04" }
```

**Authentification** — `POST /auth/connexion` renvoie un jeton à envoyer dans `Authorization: Bearer <jeton>`.
Avec `AUTH_ENABLED=false` (par défaut), aucune route n'exige de jeton. La consultation et le référentiel restent ouverts aux invités même quand l'authentification est activée.
Pour donner un mot de passe à un compte (tant que `AUTH_ENABLED=false`) : `PATCH /utilisateurs/{id}` avec `{"mot_de_passe": "..."}` (stocké haché).

Règle : seul un emploi du temps **brouillon** peut être modifié. Pour changer un emploi du temps publié, on crée une nouvelle version.

## Pour l'équipe moteur (tâche 2)

Le contrat est décrit dans `server/services.py` (section MOTEUR). En résumé, un module `moteur_ortools` placé dans `backend/` expose :

```python
def generer(id_edt: int, database_url: str, duree_max_secondes: int) -> dict:
    return {
        "placements": [{"id_cours": 3, "id_salle": 5, "id_creneau": 12, "duree_heures": 2}],
        "non_places": [{"id_cours": 7, "rang": 2, "motif": "aucune salle de TP libre"}],
    }
```

`POST /emplois-du-temps/{id}/generer` appelle le moteur en tâche de fond. L'API écrit ensuite les séances datées sur tout le semestre en sautant les jours fériés. Le rapport est disponible sur `GET /emplois-du-temps/{id}/generation`.
Une semaine type peut aussi être envoyée directement, sans moteur : `POST /emplois-du-temps/{id}/semaine-type`.

## Organisation du code

```
server/
  main.py       application et toutes les routes (une section par module du cahier des charges)
  services.py   configuration, base de données, authentification, planification, moteur
  schemas.py    modèles d'entrée (validation, OpenAPI)
```
