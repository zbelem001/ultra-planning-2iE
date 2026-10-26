from collections import defaultdict
from datetime import date, time, timedelta

from ultraplanning_solver import ContrainteAjoutee, Demande, Perimetre, generer
from ultraplanning_solver.donnees import Enseignant, Seance, lundi_de, minutes
from ultraplanning_solver.placement import decouper

from .jeu import AMPHI, LABO, LUNDI, STANDARD, cours, donnees, sejour, violations

RAPIDE = dict(temps_max_semaines=5, temps_max_placement=3)


def test_decouper_respecte_les_durees():
    for h in range(2, 31):
        for prefs in [(2,), (3,), (4,), (2, 3), (3, 4)]:
            parts = decouper(h, prefs)
            assert sum(parts) == h, (h, prefs, parts)
            assert all(2 <= p <= 4 for p in parts), (h, prefs, parts)


def test_generation_complete_sans_violation():
    d = donnees([
        cours(1, "CM", 20, 1, 1, 1, AMPHI, priorite=2),
        cours(2, "TD", 12, 1, 1, 2, STANDARD, id_groupe=10),
        cours(3, "TD", 12, 1, 1, 2, STANDARD, id_groupe=11),
        cours(4, "CM", 16, 2, 1, 3, AMPHI),
        cours(5, "CM", 18, 3, 2, 1, STANDARD),
    ])
    r = generer(d, Demande(**RAPIDE))
    assert r.non_places == []
    assert r.heures_placees == 20 + 12 + 12 + 16 + 18
    assert violations(d, r.seances) == []


def test_groupes_du_meme_type_en_parallele():
    # Une semaine : 12 h de CM + 2 × 18 h de TP = 48 h en série, plus que les
    # 38 h que l'étage 1 s'autorise (85 % de 45 h) ; en parallèle, 30 h suffisent.
    d = donnees([
        cours(1, "TP", 18, 1, 1, 1, LABO, id_groupe=20, hmax=18, durees=(3,)),
        cours(2, "TP", 18, 1, 1, 2, LABO, id_groupe=21, hmax=18, durees=(3,)),
        cours(3, "CM", 12, 2, 1, 3, AMPHI, hmax=12),
    ], semaines=1)
    r = generer(d, Demande(**RAPIDE))
    assert r.non_places == []
    assert violations(d, r.seances) == []
    tp = [s for s in r.seances if s.id_cours in (1, 2)]
    assert any(
        a.id_cours != b.id_cours and a.date_seance == b.date_seance and a.heure_debut == b.heure_debut
        for a in tp for b in tp
    ), "les deux groupes de TP auraient dû être en parallèle"


def test_cd13_trois_matieres_par_semaine():
    d = donnees([cours(i, "CM", 6, i, 1, i, AMPHI) for i in range(1, 6)], semaines=2)
    r = generer(d, Demande(**RAPIDE))
    assert r.non_places == []
    assert violations(d, r.seances) == []
    par_semaine = defaultdict(set)
    for s in r.seances:
        par_semaine[lundi_de(s.date_seance)].add(d.cours[s.id_cours].id_matiere)
    assert max(len(m) for m in par_semaine.values()) <= 3


def test_externe_enseigne_pendant_son_sejour_et_ramasse():
    debut, fin = LUNDI + timedelta(days=14), LUNDI + timedelta(days=19)
    ens = {1: Enseignant(1, "Externe", "externe", 30), 2: Enseignant(2, "Local", "permanent", 30)}
    d = donnees(
        [cours(1, "CM", 14, 1, 1, 1, AMPHI), cours(2, "CM", 14, 2, 1, 2, AMPHI)],
        semaines=4, enseignants=ens, sejours={1: sejour(debut, fin)},
    )
    r = generer(d, Demande(**RAPIDE))
    assert r.non_places == []
    assert violations(d, r.seances) == []
    externe = [s for s in r.seances if s.id_cours == 1]
    assert all(debut <= s.date_seance <= fin for s in externe)
    assert len({lundi_de(s.date_seance) for s in externe}) == 1


def test_externe_sans_sejour_signale_non_place():
    ens = {1: Enseignant(1, "Externe", "externe", 30)}
    d = donnees([cours(1, "CM", 10, 1, 1, 1, AMPHI)], enseignants=ens)
    r = generer(d, Demande(**RAPIDE))
    assert r.seances == []
    assert r.non_places and r.non_places[0].heures == 10


def test_perimetre_garde_les_autres_classes():
    # La classe B a déjà ses séances ; on ne programme que la classe A, dont
    # l'enseignant 1 est aussi celui de la classe B (20 h figées, plafond 30 h :
    # il lui reste 10 h).
    fixes = [Seance(9, LUNDI + timedelta(days=i), time(7), time(11), 2, id_seance=100 + i) for i in range(5)]
    d = donnees(
        [cours(1, "CM", 10, 1, 1, 1, AMPHI), cours(9, "CM", 20, 3, 2, 1, STANDARD, hmax=20)],
        semaines=1, seances=fixes,
    )
    r = generer(d, Demande(perimetre=Perimetre(id_classes=frozenset({1})), **RAPIDE))
    assert r.non_places == []
    assert all(s.id_cours == 1 for s in r.seances)
    assert r.remplacees == []
    assert violations(d, r.seances + fixes) == []


def test_replanification_avec_contrainte_imposee():
    d = donnees([
        cours(1, "CM", 12, 1, 1, 1, AMPHI),
        cours(2, "CM", 10, 2, 1, 2, AMPHI),  # 2 mercredis matin de 5 h
        cours(3, "TD", 8, 1, 1, 3, STANDARD, id_groupe=10),
    ], semaines=2)
    initial = generer(d, Demande(**RAPIDE))
    assert initial.non_places == []
    d.seances = [Seance(s.id_cours, s.date_seance, s.heure_debut, s.heure_fin, s.id_salle, id_seance=i)
                 for i, s in enumerate(initial.seances)]

    mercredi_matin = ContrainteAjoutee("imposer", id_cours=2, jours=("Mercredi",), heure_max=time(12))
    r = generer(d, Demande(contraintes=[mercredi_matin], minimiser_changements=True, **RAPIDE))
    assert r.non_places == []
    assert violations(d, r.seances) == []
    for s in r.seances:
        if s.id_cours == 2:
            assert s.date_seance.weekday() == 2 and minutes(s.heure_fin) <= 12 * 60
    # Les cours non concernés bougent peu
    avant = {(s.id_cours, s.date_seance, s.heure_debut) for s in initial.seances if s.id_cours != 2}
    apres = {(s.id_cours, s.date_seance, s.heure_debut) for s in r.seances if s.id_cours != 2}
    assert len(avant & apres) >= len(avant) // 2


def test_interdire_une_fenetre():
    d = donnees([cours(1, "CM", 10, 1, 1, 1, AMPHI)], semaines=1)
    pas_le_lundi = ContrainteAjoutee("interdire", id_classe=1, jours=("Lundi",))
    r = generer(d, Demande(contraintes=[pas_le_lundi], **RAPIDE))
    assert r.non_places == []
    assert all(s.date_seance.weekday() != 0 for s in r.seances)


def test_indisponibilite_respectee():
    dispo = {(1, "Mardi", time(h)): "indisponible" for h in (7, 8, 9, 10, 11, 13, 14, 15)}
    d = donnees([cours(1, "CM", 12, 1, 1, 1, AMPHI)], semaines=1, disponibilites=dispo)
    r = generer(d, Demande(**RAPIDE))
    assert r.non_places == []
    assert all(s.date_seance != date(2026, 10, 13) for s in r.seances)


def test_manque_signale_quand_la_fenetre_est_trop_etroite():
    # 12 h à placer uniquement le mercredi matin (5 h) sur 2 semaines : 2 h manquent
    d = donnees([cours(1, "CM", 12, 1, 1, 1, AMPHI)], semaines=2)
    k = ContrainteAjoutee("imposer", id_cours=1, jours=("Mercredi",), heure_max=time(12))
    r = generer(d, Demande(contraintes=[k], **RAPIDE))
    assert r.heures_placees == 10
    assert [(n.id_cours, n.heures) for n in r.non_places] == [(1, 2)]


def test_modifications_distinguent_les_durees():
    from ultraplanning_solver import Resultat

    avant = Seance(1, LUNDI, time(8), time(10), 1, id_seance=7)
    apres = Seance(1, LUNDI, time(8), time(11), 1)
    ops = Resultat([apres], [], [avant], []).modifications()
    assert [o["action"] for o in ops] == ["supprimer", "creer"]
    assert Resultat([avant], [], [avant], []).modifications() == []


def test_replanification_ne_complete_pas_le_programme():
    # 20 h de volume, 4 h déjà prévues en semaine 1 et 4 h en semaine 2 ; il en
    # reste 12 à programmer. Replanifier la semaine 2 déplace ses 4 h, sans plus.
    deux_lundis = [LUNDI, LUNDI + timedelta(days=7)]
    existantes = [
        Seance(1, lundi + timedelta(days=j), time(8), time(10), 1, id_seance=10 * i + j)
        for i, lundi in enumerate(deux_lundis) for j in (0, 1)
    ]
    d = donnees([cours(1, "CM", 20, 1, 1, 1, AMPHI)], semaines=3, seances=existantes)
    lundi_interdit = ContrainteAjoutee("interdire", id_cours=1, jours=("Lundi",))
    r = generer(d, Demande(du=deux_lundis[1], au=deux_lundis[1] + timedelta(days=5),
                           contraintes=[lundi_interdit], minimiser_changements=True, **RAPIDE))
    assert r.non_places == []
    assert r.heures_placees == 4
    assert all(s.date_seance.weekday() != 0 for s in r.seances)


def test_periode_partielle_de_semaine():
    # La semaine est pleine du jeudi au samedi (séances figées) ; replanifier
    # seulement lundi–mercredi doit rester possible.
    figees = [Seance(9, LUNDI + timedelta(days=j), time(h), time(h + 2), 1, id_seance=100 + 10 * j + h)
              for j in (3, 4) for h in (7, 9, 13)] + \
             [Seance(9, LUNDI + timedelta(days=5), time(h), time(h + 2), 1, id_seance=150 + h) for h in (7, 9)]
    a_deplacer = [Seance(1, LUNDI + timedelta(days=j), time(8), time(10), 1, id_seance=200 + j) for j in (0, 1)]
    d = donnees([cours(1, "CM", 10, 1, 1, 1, AMPHI), cours(9, "CM", 16, 2, 1, 2, AMPHI, hmax=16)],
                semaines=1, seances=figees + a_deplacer)
    pas_le_mardi = ContrainteAjoutee("interdire", id_classe=1, jours=("Mardi",))
    r = generer(d, Demande(du=LUNDI, au=LUNDI + timedelta(days=2), contraintes=[pas_le_mardi],
                           minimiser_changements=True, **RAPIDE))
    assert r.non_places == [] and r.heures_placees == 4
    assert all(s.date_seance.weekday() in (0, 2) for s in r.seances)
    assert violations(d, r.seances + r.conservees) == []


def test_generation_d_une_seule_semaine_garde_le_rythme():
    # 12 h par cours, 6 h au plus par semaine, 4 semaines. Générer seulement la
    # 2e semaine : elle reçoit sa part du volume (selon le rythme), le reste est
    # reporté sur les semaines suivantes, pas signalé comme perdu.
    d = donnees([cours(1, "CM", 12, 1, 1, 1, AMPHI, hmax=6), cours(2, "CM", 12, 2, 1, 2, AMPHI, hmax=6)], semaines=4)
    semaine = LUNDI + timedelta(days=7)
    r = generer(d, Demande(du=semaine, au=semaine + timedelta(days=5), **RAPIDE))
    assert r.non_places == []
    assert r.seances and all(semaine <= s.date_seance <= semaine + timedelta(days=5) for s in r.seances)
    for k in (1, 2):
        place = sum(s.duree for s in r.seances if s.id_cours == k)
        assert 2 <= place <= 6 and place + r.reportees.get(k, 0) == 12
    assert r.statistiques["heures_reportees"] == sum(r.reportees.values())
    assert violations(d, r.seances) == []

    # Au-delà de ce que le semestre peut contenir (3 semaines × 6 h < 24 h), le manque est signalé
    d = donnees([cours(1, "CM", 24, 1, 1, 1, AMPHI, hmax=6)], semaines=4)
    r = generer(d, Demande(du=semaine, au=semaine + timedelta(days=5), **RAPIDE))
    assert [(n.id_cours, n.heures) for n in r.non_places] == [(1, 6)]


def test_completer_garde_toutes_les_seances_existantes():
    # 12 h de volume, 4 h déjà placées (non verrouillées) : compléter place les 8 h restantes
    # sans toucher aux séances existantes
    existantes = [Seance(1, LUNDI + timedelta(days=j), time(8), time(10), 1, id_seance=10 + j) for j in (0, 1)]
    d = donnees([cours(1, "CM", 12, 1, 1, 1, AMPHI, hmax=6)], semaines=3, seances=existantes)
    r = generer(d, Demande(completer=True, **RAPIDE))
    assert r.remplacees == [] and r.non_places == []
    assert r.heures_placees == 8
    assert violations(d, r.seances + r.conservees) == []
