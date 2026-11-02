# Moteur v3 : séances datées sur le semestre

Successeur de `moteur_v2/` (semaine type). Reprend le glouton et le validateur de `moteur_v2`, les séances datées et la répartition hebdomadaire du solveur de Zakaria, et ajoute ce qu'aucun des deux ne gérait : site imposé par promotion, options et sous-groupes, cours mutualisés, salles réservées, règles du planificateur stockées comme données.

## Utilisation

```
pip install -r requirements.txt
python moteur/generateur.py --out data/instance_2ie.json          # données fictives calées sur 2iE
python -m moteur data/instance_2ie.json --out data/resultat.json   # génération complète
python -m moteur data/instance_2ie.json --amelioration 0           # glouton seul (~10 s)
python tests/test_moteur.py
```

Depuis Python (l'API) :

```python
from moteur import generer
res = generer(data)   # res["seances"], res["non_programmes"], res["statistiques"], res["violations"]
```

## Chaîne de traitement

1. **Préparation** (`instance.py`) : jours ouverts du semestre (fériés et congés retirés), arbre des groupes, salles possibles de chaque cours (site de la promotion, type, capacité, réservation), présence des enseignants.
2. **Placement chronologique** (`planif.py`), semaine après semaine. Chaque cours demande « reste ÷ semaines encore utilisables par son enseignant ». Les externes de passage sont servis d'abord. Une séance non placée reste due la semaine suivante. Une passe de rattrapage finale remet les heures restantes là où il reste de la place. Plusieurs essais tournent en parallèle et on garde le meilleur.
3. **Amélioration CP-SAT** (`ameliore.py`), facultative. Pour chaque promotion incomplète, une semaine à la fois, ses séances sont libérées puis replacées par CP-SAT avec les heures manquantes en plus. Les séances libérées doivent être replacées, donc le résultat ne régresse jamais.
4. **Validation indépendante** (`valide.py`) : elle recompte toutes les règles dures à partir des données brutes, sans réutiliser le code du placement.
5. **Qualité** (`qualite.py`) : trous, enseignant sur deux sites, préférences, samedi, étalement.

## Replanification (mise à jour quotidienne)

```python
from moteur import replanifier
res = replanifier(data, perimetre={"id_classes": [3]}, du="2026-11-02", au="2026-11-30", completer=False)
```

`data["seances_existantes"]` contient l'emploi du temps en cours (`est_verrouillee` facultatif).
- Les séances verrouillées, hors périmètre ou hors période ne bougent jamais.
- Chaque séance du périmètre est revérifiée à sa place avec les données du jour (absence, nouvelle règle…). Si elle est encore valide, elle reste. Si seule sa salle ne va plus, on change de salle.
- Les séances devenues impossibles sont replacées dans la période, la même semaine d'abord.
- `completer=True` programme en plus les heures encore dues dans la période.
- `res["modifications"]` donne, pour chaque séance touchée, l'avant, l'après et la raison, pour validation par le planificateur.

Mesuré sur l'instance 2iE : un enseignant absent une semaine donne 2 076 séances inchangées sur 2 086 et 10 touchées, en 0,5 s. Une nouvelle règle « S1 : pas de cours le jeudi après-midi » donne 465 séances inchangées sur 492 et 27 touchées. Aucune violation dans les deux cas.

## Lien avec la base (`base.py`)

```python
import os, psycopg
from moteur import generer
from moteur.base import charger, enregistrer
with psycopg.connect(os.environ["DATABASE_URL"]) as conn:     # clé jamais dans le code
    data = charger(conn, id_edt)          # chargeur de Zakaria + compléments v3
    res = generer(data)
    bilan = enregistrer(conn, data, res)  # n'écrit que les différences
```

- `charger` réutilise `ultraplanning_solver.base.charger` (schéma v8, isolation par école), puis lit les colonnes et tables de `propositions/009_moteur_v3.sql` si elles existent. Sinon le site des promotions est déduit, et c'est signalé dans `meta.avertissements`.
- `enregistrer` supprime les séances qui ont bougé et insère les nouvelles, en une transaction. Une séance inchangée garde son identifiant, et les déclencheurs revalident chaque séance écrite.
- Testé sans base (`tests/test_base.py`, variable `ZAK_SOLVER`) avec les données des tests de Zakaria. Le résultat passe **notre validateur et le sien**.
- Pas encore testé sur une vraie base PostgreSQL.

## Format d'entrée v3 (JSON)

| Clé | Contenu |
|---|---|
| `calendrier` | `debut`, `fin`, `jours_feries`, `conges` (`[[du, au]]`), `plages` par jour (`{"Lundi": [[7,12],[13,16]], "Samedi": [[7,12]]}`) |
| `sites`, `trajet_min` | sites et durée du trajet entre eux : écart minimal imposé entre deux séances d'un enseignant sur deux sites le même jour |
| `salles` | `id_salle`, `id_site`, `id_type_salle`, `capacite`, `reservee_a` (promotions ayants droit, vide = libre) |
| `classes` | promotions : `id_classe`, `id_site`, `effectif` |
| `groupes` | `id_groupe`, `id_classe`, `parent` (groupe parent ou `null`), `type_groupe` (TD, TP, OPTION), `effectif` |
| `cours` | `publics` (`[{id_classe, id_groupe}]`, plusieurs = cours mutualisé), `id_enseignant`, `types_salle` (types acceptés, sinon `id_type_salle`), `volume`, `durees` (découpage préféré), `h_sem_min`, `h_sem_max` |
| `enseignants` | `statut` (permanent, externe_resident, externe_non_resident ; ou les valeurs de la base vacataire_local, externe), `nb_heures_max_semaine`, `sejours`, `absences` (`[[du, au]]`), `indisponibilites` et `preferences` (`{jour, demi}`) |
| `seances_existantes` | emploi du temps en cours, pour la replanification : `id_cours`, `date`, `heure_debut`, `heure_fin`, `id_salle`, `est_verrouillee` |
| `regles` | règles du planificateur, voir ci-dessous |
| `parametres` | `essais`, `plafond_jour_dur`, `poids` |

**Groupes.** Chaque promotion est un arbre : promotion → groupes de TD ou options → demi-groupes de TP ou sous-options. Deux publics de la même promotion sont en conflit si l'un contient l'autre, ou s'ils sont dans deux branches de types différents. Deux frères du même type (TD1 et TD2, ou GC et GEE) peuvent avoir cours en même temps. Deux frères de types différents (un TD et un TP sans parent, comme dans le schéma actuel de la base) sont deux découpages croisés : ils ne vont jamais en parallèle.

## Règles du planificateur (table `regles`)

Une règle est une ligne de données. En ajouter une ne demande aucun changement de code.

| `type` | Champs | Effet |
|---|---|---|
| `interdire` | `cible` (`id_classe`, `id_enseignant` ou `id_cours`), `jours`, `demi`, `du`, `au` | aucune séance de la cible dans cette fenêtre (sur la période `du`–`au` si donnée) |
| `precede` | `matiere_avant`, `matiere_apres` | la seconde matière ne commence qu'après la fin de la première |
| `plafond_jour` | `heures`, `dure` | dure : plafond strict ; souple : pénalité au-delà (`poids`) |
| `cm_avant_td` | `poids` | le CM d'une matière commence avant ses TD (souple) |
| `enseignant_site_unique_jour` | `dure` | interdit (au lieu de pénaliser) un enseignant sur deux sites le même jour |
| `site_unique_jour` | | garanti par construction : une promotion a un site |

Un type inconnu est ignoré et signalé dans `statistiques.avertissements`.

## Sortie

- `seances` : `id_cours`, `date`, `heure_debut`, `heure_fin`, `id_salle`.
- `non_programmes` : `id_cours`, `heures`, `raison` (séjour de l'enseignant, semaine pleine, règle « precede », aucune salle libre…).
- `statistiques` : taux, durées, gain de l'amélioration, `qualite`.
- `violations` : vide si tout va bien.

## Limites connues

- Données fictives seulement. Les effectifs, le découpage en matières et les enseignants sont inventés (voir `generateur.py`), seuls les chiffres de `profil_2ie.py` sont réels.
- L'arbre des groupes suppose qu'une promotion n'a pas à la fois des groupes de TD et des options indépendants.
