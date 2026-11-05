"""Profil réel de 2iE (chiffres agrégés, aucun nom de personne).

Source : « Renseignements planifications1.xlsx » (feuilles Prom, Groupe, Salles),
réponses du planificateur et propriétaire du projet, novembre 2026.
Chaque site de promotion est marqué « c » (confirmé) ou « s » (supposé).

Heures : colonne d'heures de l'Excel. `commun` = heures de la promotion entière,
`td` = heures de chaque groupe de TD, `options` = heures propres à chaque option.
Une valeur absente de l'Excel vaut None (le générateur prend alors une valeur type).
"""

K, O = "Kamboinsé", "Ouaga"

# code, site, statut du site, heures communes, [heures par groupe de TD], [heures par option]
PROMOTIONS = [
    ("BT EMEL S1", O, "c", 400, [], []),
    ("BT EMIH-EREE S1", K, "c", 268, [], [146, 138]),
    ("BT EMIH-EREE S2", K, "s", 311, [], []),
    ("BT EMIH-EREE S3", K, "s", 179, [], [123, 9]),
    ("BT EMIH-EREE S4", K, "s", 156, [], [None, 104]),
    ("BT EMIH-EREE S5", K, "s", None, [], [59, None]),
    ("BT EMIH-EREE S6", K, "s", 73, [], []),
    ("BT TOPO SIG S6", K, "s", 813, [], []),
    ("CENTRALE-2iE A1", K, "s", None, [], []),
    ("CENTRALE-2iE A2", K, "s", 106, [], []),
    ("S1", K, "c", 263, [190, 190, 190, 190, 190, 184, 190], []),
    ("S2", K, "c", 259, [203, 206, 196, 138], []),
    ("S3", K, "c", 248, [137, 134, 131, 134, 131, 137], []),
    ("S4", K, "c", 294, [149, 149, 149], []),
    ("S5 D", K, "c", 266, [], [261, 272, 299]),
    ("S6 D", K, "s", 144, [], [431, 449, 285]),
    ("S5 S", K, "s", 233, [], [308, 300, 340]),
    ("S6 S", K, "s", 98, [], [275, 274, 186]),
    ("CPGE 1", O, "c", 200, [74, 74], []),
    ("CPGE 2", O, "c", 260, [], []),
    ("S5D IAA", O, "c", 415, [], []),
    ("S7 IAA", O, "c", 389, [], []),
    ("S9 IAA", O, "c", 266, [], []),
    ("MSP ANC", O, "s", 330, [], []),
    ("MSP WASH", O, "c", None, [], []),
    ("S7", K, "s", 186, [], [239, 262, 246]),
    ("S8", K, "s", 120, [], [331, 397, 313]),
    ("S9 GC-BTP", K, "s", 344, [], [None, 54]),
    ("S9 GEAAH", K, "s", 236, [], [136, 136, 137]),
    ("S9 GEE", K, "s", 277, [], [None, 86]),
    ("MISE A NIVEAU", K, "s", 126, [234, 282], []),
]

# Promotions qui partagent des cours magistraux (supposé : même niveau, même site).
MUTUALISEES = [("S5 D", "S5 S"), ("S6 D", "S6 S"), ("S7 IAA", "S9 IAA")]

# Salles : site, type, capacité (None = absente de l'Excel). Les noms ne sont pas repris.
SALLES = (
    [(K, "AMPHI", c) for c in (140, 252, 252)]
    + [(K, "STD", c) for c in [20, 20] + [30] * 8 + [60] * 14 + [80] * 3]
    + [(K, "LABO", c) for c in (None, None, 15, 15, 15, 15, 15, 30, 30)]
    + [(K, "INFO", c) for c in (30, 30)]
    + [(K, "AUTRE", c) for c in (None, 20)]
    + [(O, "AMPHI", c) for c in (190, 300)]
    + [(O, "STD", c) for c in (None, 30, 30, 36, 36, 36, 36, 40, 40, 40, 40, 50, 64, 64, 80, 80)]
    + [(O, "LABO", None)]
    + [(O, "INFO", c) for c in (20, 20)]
    + [(O, "AUTRE", c) for c in (10, 10, 15, 40)]
)
CAPACITE_DEFAUT = {"AMPHI": 150, "STD": 40, "LABO": 15, "INFO": 20, "AUTRE": 10}

# Salles réservées (supposé : quelles salles exactement n'est pas connu).
# (code promotion préfixe, site, type, nombre de salles réservées)
RESERVATIONS = [("BT EMEL", O, "STD", 1), ("CPGE", O, "STD", 2), ("BT EMIH-EREE", K, "STD", 1)]

# Enseignants (Excel) : 231 avec des heures, 16 210 h au total, médiane 48 h.
ENSEIGNANTS_MEDIANE_H = 48
STATUTS = {"permanent": 0.35, "externe_resident": 0.40, "externe_non_resident": 0.25}

# Calendrier du semestre 1 (supposé : dates exactes non reçues).
SEMESTRE = {
    "debut": "2026-09-14",
    "fin": "2027-01-16",
    "conges": [["2026-12-21", "2027-01-02"]],
    "jours_feries": ["2026-10-31", "2026-11-01", "2026-12-11", "2026-12-25", "2027-01-01"],
}
# Livret § 9.1 (confirmé) : 7h-12h et 13h-16h, samedi matin seulement.
PLAGES = {j: [[7, 12], [13, 16]] for j in ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"]}
PLAGES["Samedi"] = [[7, 12]]
TRAJET_MIN = 60  # Kamboinsé <-> Ouaga, au moins 1 h (confirmé)
