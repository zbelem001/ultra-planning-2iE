"""Moteur de génération d'emplois du temps (v2).

Utilisation depuis l'API :
    from moteur_v2 import generer, valider, placement_rapide
    resultat = generer(donnees)            # glouton + OR-Tools (nécessite ortools)
    resultat = placement_rapide(donnees)   # glouton seul, sans ortools, < 1 s
    violations = valider(donnees, resultat)
"""


def generer(data, **options):
    from .solver import solve
    return solve(data, **options)


def placement_rapide(data):
    from .greedy import meilleur_placement
    return meilleur_placement(data)


def valider(data, result):
    from .validate import validate
    return validate(data, result)
