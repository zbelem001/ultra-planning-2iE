# UltraPlanning 2iE · solveur CP-SAT

Génère et replanifie les emplois du temps avec Google OR-Tools (CP-SAT), selon les règles de `../fichier.md` (§4) et le schéma `../migrations/schema_supabase.sql`.

Fonctionnement détaillé (modèles des deux étages, objectifs, exemple, limites) : [`fichier.md`](fichier.md).

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[test]"
```

## Utilisation

En ligne de commande, sur une base chargée avec `schema_supabase.sql` :

```bash
export DATABASE_URL="host=127.0.0.1 port=5432 user=postgres dbname=postgres"
.venv/bin/python -m ultraplanning_solver --edt 1                      # tout le semestre, sans écrire
.venv/bin/python -m ultraplanning_solver --edt 1 --filiere IA --ecrire # une filière, enregistrée
.venv/bin/python -m ultraplanning_solver --edt 1 --classe L2INFO --du 2026-11-02 --au 2026-11-28 --minimiser-changements --json
```

`--ecrire` remplace les séances du périmètre dans une transaction. Chaque séance passe par le déclencheur de la base (CD-01 à CD-14) : si la base en refuse une, rien n'est écrit.

En Python (ce que l'API et l'assistant IA appelleront) :

```python
from ultraplanning_solver import ContrainteAjoutee, Demande, Perimetre, generer
from ultraplanning_solver.base import charger, enregistrer, verifier

d = charger(conn, id_edt)
r = generer(d, Demande(
    perimetre=Perimetre(id_classes=frozenset({2})),
    contraintes=[ContrainteAjoutee("imposer", id_cours=6, jours=("Mercredi",), heure_max=time(12))],
    minimiser_changements=True,          # replanification minimale
))
r.seances, r.non_places, r.modifications()   # résultat, manques expliqués, différence (PROPOSITION)
```

## Fonctionnement

| Étape | Module | Rôle |
|---|---|---|
| Données | `donnees.py`, `base.py` | Image du référentiel et de l'emploi du temps, lue depuis PostgreSQL |
| Étage 1 | `semaines.py` | Plan des semaines : heures de chaque cours par semaine. Volume (CD-08), rythme (CD-14), 3 matières par semaine (CD-13), capacités de l'enseignant, de la classe et des salles. Objectif : CS-04 (selon le statut), CS-05 (CM avant TD/TP), CS-07 (priorités) |
| Étage 2 | `placement.py` | Placement de chaque semaine : jour, créneau et salle de chaque séance. CD-01 à CD-12 ; objectif : CS-01, CS-02, CS-03, CS-05, CS-06 |
| Boucle | `moteur.py` | Si une semaine ne peut pas tout placer, l'étage 1 est relancé pour reporter le manque sur d'autres semaines |

Ce qui n'est pas dans le périmètre de la demande (autres classes, autres dates, séances verrouillées) reste figé et compte comme occupé.

Une **contrainte ajoutée** (`imposer` ou `interdire` une fenêtre de jours, d'heures et de dates, pour un cours, une classe ou un enseignant) traduit une demande en langage naturel.

Les heures qui ne peuvent pas être placées sont renvoyées dans `non_places`, avec la règle qui bloque (BF-18).

## Tests

```bash
.venv/bin/python -m pytest                     # tests du solveur (jeu synthétique)
DATABASE_URL=... .venv/bin/python -m pytest    # + tests d'intégration (vident la table seance !)
```

`tests/jeu.py` contient un vérificateur indépendant qui recontrôle les contraintes dures sur chaque résultat.

## Limites actuelles

- Heures entières et grille de 1 h (une valeur non entière est refusée au chargement).
- CS-02 est approché : on regroupe les séances d'une classe sur moins de jours, on ne mesure pas les trous.
- Les examens ne sont pas modélisés (les semaines d'examens sont des congés).
- Sur le jeu de test (13 cours, 414 h, 19 semaines), une génération complète prend environ 40 s. Les semaines sont résolues l'une après l'autre ; on pourra les paralléliser.
