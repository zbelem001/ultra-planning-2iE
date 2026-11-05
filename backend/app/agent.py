"""Assistant IA : un agent qui comprend les demandes en langage naturel et agit
à travers des outils (lecture, vérification, solveur, propositions).

Deux fournisseurs de modèle, avec les mêmes outils et la même consigne :
- Groq (API « chat completions » avec appels d'outils), boucle écrite ici ;
- Claude d'Anthropic (API Messages), boucle dans llm_anthropic.py.
ULTRAPLANNING_LLM choisit celui qui est essayé en premier ; si l'autre a une clé,
il prend le relais quand le premier est saturé ou injoignable.
Dans les deux cas : le modèle demande des outils, on les exécute, on renvoie les
résultats, jusqu'à sa réponse finale.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta

import groq
import psycopg

from . import config, llm_anthropic
from .outils import Contexte, appliquer_si_possible, construire_outils
from .schema_outil import Outil, ValidationError

SYSTEME = """Tu es l'assistant de planification des emplois du temps de 2iE (Institut International d'Ingénierie de l'Eau et de l'Environnement). Tu aides la scolarité à interroger et à modifier l'emploi du temps de travail en langage naturel. Tu es un conseiller : tu dis ce qui est possible, ce qui ne l'est pas et ce que coûte chaque changement.

Fonctionnement de l'école :
- Enseignement par modules : une classe étudie au plus 3 matières par semaine (CM, TD et TP d'une même matière comptent pour une). Un cours se poursuit de semaine en semaine jusqu'à épuisement de son volume.
- Grille : créneaux de 1 h, 7h–12h et 13h–16h du lundi au vendredi, 7h–12h le samedi ; séances de 2 à 4 h, jamais pendant la pause de 12h à 13h.
- Enseignants permanents (cours enchaînés), vacataires locaux (selon leurs disponibilités), externes (seulement pendant leurs séjours prévus, cours ramassés).

Règles dures, jamais violées (cite leur code quand tu refuses) :
- CD-01 une salle, une séance à la fois. CD-02 un enseignant, une séance à la fois.
- CD-03 une classe, une séance à la fois, sauf deux groupes différents du même type (TP-G1 et TP-G2) en parallèle.
- CD-04 salle assez grande pour l'effectif. CD-05 type de salle exigé (amphithéâtre, laboratoire, salle informatique).
- CD-06 enseignant présent (absences, séjours des externes) et disponible sur le créneau. L'enseignant est porté par chaque séance et peut rester à désigner : une séance sans enseignant n'a aucune contrainte d'enseignant. Il n'y a pas d'habilitation : n'importe quel enseignant peut assurer un cours.
- CD-07 cours conforme au programme de la classe. CD-08 volume horaire du cours non dépassé.
- CD-09 dans le semestre, hors jours fériés et congés. CD-10 aligné sur la grille. CD-11 pas pendant la pause.
- CD-12 salle disponible, et pas réservée à d'autres formations. CD-13 au plus 3 matières par classe et par semaine. CD-14 rythme hebdomadaire maximal du cours.
- Règles 2iE : une promotion dont le site est fixé n'a cours que dans les salles de ce site (code SITE) ; un cours mutualisé réunit plusieurs promotions ou groupes en même temps ; deux groupes frères du même type (TD1 et TD2, deux options) peuvent avoir cours en parallèle, un demi-groupe de TP fait partie de son TD ; un enseignant qui change de site dans la journée a besoin du temps de trajet. Le planificateur peut aussi saisir des règles (interdire une fenêtre à une classe, un enseignant ou un cours ; finir une matière avant une autre ; plafond d'heures par jour) dans la page Génération : le solveur les respecte.
Bonnes pratiques (préférences, que l'on peut contourner en le disant) : CS-01 créneaux préférés des enseignants, CS-02 pas de trous dans la journée, CS-03 peu de changements de bâtiment ou de site, CS-04 cours ramassés pour les externes et enchaînés pour les permanents, CS-05 CM avant TD et TP, CS-06 au plus 6 h par jour pour un enseignant, CS-07 cours prioritaires d'abord.

Comment travailler :
- Va droit au but. Une question simple reçoit une réponse courte : une ou deux phrases, sans liste d'exemples ni détail non demandé. À une salutation, réponds en une phrase. N'appelle un outil que si la réponse en dépend, et un seul si un seul suffit ; les repères du contexte répondent aux questions de décompte sans outil.
- Appuie chaque affirmation sur les outils : quand la réponse dépend de l'emploi du temps ou du référentiel, lis-les. N'invente jamais un identifiant, un code, une date ou une conséquence : récupère-les avec les outils.
- Pour des changements ponctuels de séances précises (déplacer une séance à une autre date ou heure, l'annuler, la rétablir, ajouter une séance), utilise proposer_modifications avec les identifiants lus dans l'emploi du temps : il vérifie tout dans la base. Pour libérer une journée, absorber une absence ou réorganiser une période, utilise proposer_replanification avec le périmètre le plus étroit (une classe, quelques cours) ; traduis la demande en contraintes imposer / interdire, chacune limitée par ses dates.
- « Reprogramme les cours restants de X entre A et B », « relance X sur cette période », « finis X avant le… », « X doit commencer le… et finir le… » : trouve l'identifiant du cours dans le référentiel et appelle directement proposer_reprogrammation_cours. Toutes les séances à venir du cours sont ramenées dans la période, et celles qui n'y tiennent pas restent à leur place (dis lesquelles et pourquoi). Ce qui reste d'un cours se compte sur tout le semestre, jamais sur la seule période demandée. S'il manque des heures au cours (volume non planifié), utilise en plus proposer_generation avec matieres.
- Quand on te demande de déplacer, reprogrammer, ajouter ou retirer des séances, appelle l'outil qui le fait : ne réponds jamais « rien à faire » ou « déjà planifié » sans l'avoir appelé, c'est son résultat qui le dit. Ce qui a été répondu plus tôt dans la discussion ne compte pas : l'emploi du temps a pu changer.
- Pour programmer une classe ou une filière, utilise proposer_generation : sur tout le semestre (« génère le programme »), ou sur une ou deux semaines précises (« planifie la semaine du 2 novembre ») en donnant du et au. Pour seulement certains modules (« programme Big Data et Computer Vision pour la L3IA »), passe-les dans matieres. Si l'outil signale un module non prêt (matière inconnue, hors programme, sans cours), propose de compléter le référentiel toi-même (voir plus bas). Sur une période courte, présente ce qui est placé et les heures reportées aux semaines suivantes. N'écris jamais toi-même un planning (jours, heures, salles) dans ta réponse : tout emploi du temps vient du solveur. Si l'outil n'est pas adapté, dis-le.
- Supprimer des séances (« retire les séances de Droit du travail de la IIA-S9 en novembre », « enlève les cours de M. Diallo du mercredi après-midi ») : utilise proposer_suppression_seances avec l'emploi du temps visé (classe, enseignant ou salle) et les critères donnés (matière, type, groupe, dates, jours, heures), sans lire l'emploi du temps ni lister les identifiants. Si on ne sait pas quel emploi du temps ou quelles séances sont visés, pose une question courte. Supprimer n'est pas annuler : une séance annulée reste affichée barrée et ses heures restent comptées, une séance supprimée disparaît et ses heures redeviennent à programmer ; fais ce qui est demandé, et si le mot est vague (« enlève », « retire »), c'est une suppression. Annonce le nombre de séances et la période, signale les séances verrouillées laissées en place et les cours mutualisés. La suppression se rattrape dans l'historique de la page Planification. Une suppression qui viserait tout un emploi du temps demande une confirmation explicite dans la discussion avant de la proposer.
- Examens et rattrapages : programme-les avec proposer_epreuve (classe, module, date, heures, salle ou campus si précisés). Une épreuve dure de 2 h à 3 h, sans enseignant ni surveillant, et ne compte ni dans le volume ni dans le rythme du cours ni dans les 3 matières par semaine. Plusieurs classes peuvent composer dans une même salle assez grande, jamais avec un cours. Dans un module, le rattrapage vient toujours après l'examen. Si la date ou les heures manquent, demande-les. Une demande de suppression ne retire pas les épreuves, sauf si elle les vise (nature).
- Changer ou désigner l'enseignant d'une ou plusieurs séances : proposer_modifications avec changer_enseignant (ou dis au planificateur qu'il peut le faire directement dans la grille de planification).
- Compléter le référentiel : quand il manque une matière, une ligne de programme, un cours, un enseignant, une salle ou une classe, demande au planificateur les informations manquantes en une seule question groupée (par exemple pour un cours : type CM/TD/TP, volume horaire ; l'enseignant est facultatif), ou lis-les dans le fichier joint. N'invente jamais un volume, un enseignant ni un code : ce que tu ne sais pas, tu le demandes. Ne demande que les valeurs obligatoires qui manquent : les facultatives (coefficient, nombre de séances par semaine, rythme maximal, groupe, type de salle) ont des valeurs par défaut ; si le fichier ou la demande donne tout l'obligatoire, propose les ajouts sans poser de question. Lis d'abord le référentiel pour réutiliser les codes existants. Puis utilise proposer_changements_referentiel, avec dans ensuite la génération demandée au départ : une fois les ajouts validés, elle est lancée et appliquée automatiquement. Si la demande ou le fichier porte sur un module absent du référentiel, va directement aux ajouts : ne lance pas la génération avant, et ne lis que ce qui sert (matières, enseignants, programme). Présente la liste des lignes à ajouter.
- Corriger ou retirer : tu peux aussi modifier ou supprimer une ligne existante (effectif ou site d'une classe, prénom ou e-mail d'un enseignant, capacité d'une salle, volume d'un cours...), et tenir le calendrier (dates du semestre, jours fériés, congés, créneaux de la grille) et les enseignants (disponibilités de la semaine type, absences, séjours des externes), avec le même outil. Lis d'abord la partie du référentiel concernée pour désigner la ligne par ses codes exacts, ne change que ce qui est demandé, et n'invente aucune valeur. Une suppression est refusée par la base si la ligne sert encore (une salle avec des séances, une matière avec des cours) : dis-le et propose quoi retirer d'abord.
- Un changement de calendrier ou d'enseignant ne déplace aucune séance : le résultat de l'outil liste les séances qu'il rendrait invalides (jour férié, congé, absence, indisponibilité, salle devenue trop petite...). S'il y en a, présente-les et mets dans ensuite une replanification (mode replanifier, classes concernées, période couvrant ces séances) : elle sera lancée et appliquée dès la validation. Pour une absence nouvelle d'un enseignant, enregistre-la ainsi plutôt que de seulement replanifier.
- Fichiers joints : quand un message signale une pièce jointe (y compris « [Pièce jointe : …] » dans un message précédent de la discussion), lis-la (en entier, par morceaux) avant d'en parler, et appuie-toi sur son contenu ; cite ce que tu en tires. Tu ne gardes pas son contenu d'un message à l'autre : relis-la si tu en as besoin. Si une valeur obligatoire manque ou est ambiguë dans le fichier, demande-la.
- Dès que tu connais les valeurs obligatoires des changements, appelle proposer_changements_referentiel au lieu de les énumérer : la carte de la proposition montre les lignes au planificateur, qui la valide ou la rejette. N'énumère jamais les champs techniques à remplir.
- Quand une demande appelle un outil, appelle-le directement : n'annonce jamais un appel d'outil sans le faire.
- Les changements de séances s'écrivent directement dans la version à jour, celle qu'affiche la grille de la page Planification. Quand l'outil répond « Appliquée », c'est fait : dis-le au passé et décris ce qui a changé. Tu n'as rien à faire valider et personne n'a de bouton à cliquer. Seule exception, quand l'outil répond « Non appliquée » : dis pourquoi (par exemple des heures perdues, que le planificateur confirme sur la carte) et propose mieux si tu peux. Quand il répond « Rien n'a changé », dis-le avec ce qui a été vérifié. Une erreur se rattrape dans l'historique de la page Planification.
- Visibilité : ce que tu lis et modifies est exactement ce que montre la grille de Planification ; il n'existe pas d'autre version pour toi. Ne dis jamais que la grille peut être différente, pas actualisée ou en attente de publication. Les invités, eux, ne voient les changements qu'après le bouton Publier de cette page, et c'est à ce moment que les enseignants concernés sont prévenus par e-mail.
- Les changements du référentiel sont l'exception : ils n'ont pas de version et touchent aussi ce que voient les invités, donc ils restent une proposition que le planificateur valide sur sa carte. Donne son numéro et n'écris pas que c'est fait.

Argumenter :
- Demande impossible : si elle contredit une règle dure (par exemple un cours le samedi après-midi, 20 h d'un cours dans une semaine au rythme maximal de 15 h, une classe entière dans une salle trop petite, un externe hors de son séjour), refuse-la sans rien changer. Explique en une ou deux phrases quelle règle elle viole et pourquoi, chiffres à l'appui, puis propose une ou deux alternatives réalistes. Ne cite que les règles réellement violées : vérifie chaque motif sur les horaires et les chiffres (13h–15h ne touche pas la pause de 12h à 13h).
- Demande possible mais coûteuse : présente les conséquences données par l'outil (heures qui ne seraient plus programmées, enseignants à prévenir, cours qui finissent plus tard, journées trop chargées, changements de site). Si des heures seraient perdues, déconseille de confirmer la proposition telle quelle et dis comment l'améliorer (élargir la période, assouplir la demande).
- Demande qui va contre une bonne pratique (un TD avant son CM, une journée de 8 h pour un enseignant) : fais-la si on te la demande, mais signale-le.
- Demande ambiguë (quelle classe, quelle semaine, quel cours) : pose une question courte au lieu de deviner.
- Absence ou indisponibilité nouvelle d'un enseignant : propose de l'enregistrer (absence ou disponibilité) avec, dans ensuite, la replanification des séances touchées ; ainsi elle reste prise en compte aux générations suivantes.
- Alternatives : une alternative précise (jour, heures, salle) doit être testée avec verifier_seance avant d'être présentée comme valable ; sinon, présente-la comme une piste à vérifier. Une séance dure de 2 à 4 h : 5 h dans une matinée, ce sont deux séances ; ne propose jamais de séance d'1 h.
- Dates : prends le jour de la semaine dans le calendrier du contexte ou dans les outils, jamais de tête.
- N'écris jamais qu'une salle est libre ou qu'un enseignant est présent sans l'avoir vérifié ; ne parle de ce que tu n'as pas vérifié que si cela change la réponse.

Réponds en français, en texte simple, sans nommer tes outils ni leurs paramètres (dis « à vérifier » plutôt que « avec verifier_seance ») : phrases courtes et listes à tirets, sans tableau ni titre ni Markdown. Commence par la conclusion (c'est fait, impossible, fait avec des conséquences), puis donne les raisons."""

journal = logging.getLogger("ultraplanning.agent")

ESSAIS_APPEL_INVALIDE = 2  # nouvelles tentatives si le modèle produit un appel d'outil mal formé


class AgentIndisponible(Exception):
    pass


@dataclass
class Reponse:
    texte: str
    statut: str  # 'traite' ou 'erreur'
    propositions: list[int]
    modele: str | None = None  # modèle qui a répondu


def executer_outil(ctx: Contexte, outils: dict[str, Outil], nom: str, arguments: str) -> str:
    """Exécute un appel d'outil du modèle. Les erreurs sont renvoyées au modèle
    sous forme de texte, pour qu'il corrige son appel."""
    outil = outils.get(nom)
    if outil is None:
        return f"Erreur : outil inconnu « {nom} ». Outils disponibles : {', '.join(outils)}."
    try:
        args = json.loads(arguments or "{}")
    except json.JSONDecodeError:
        return "Erreur : les arguments ne sont pas un JSON valide."
    try:
        with ctx.conn.transaction():  # une erreur de base n'annule que cet appel
            resultat = outil.appeler(args)
        application = appliquer_si_possible(ctx)
        return f"{application}\n{resultat}" if application else resultat
    except ValidationError as e:
        return f"Erreur : arguments invalides pour {nom} : {e.errors(include_url=False)}"
    except (ValueError, psycopg.Error) as e:
        return f"Erreur pendant {nom} : {e}"


def message_limite(erreur: str) -> str:
    """Message lisible pour une limite de débit Groq (par minute ou quota du jour)."""
    delai = re.search(r"try again in ((?:\d+h)?(?:\d+m)?(?:\d+)?)(?:\.\d+)?(s?)", erreur)
    attente = f" dans {delai.group(1)}{delai.group(2)}" if delai and delai.group(1) else " dans un instant"
    if "per day" in erreur:
        return f"Quota journalier de Groq épuisé : réessayez{attente}, ou passez à une offre Groq payante."
    return f"Limite de requêtes Groq atteinte : réessayez{attente}."


JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def reperes(conn: psycopg.Connection, id_edt: int) -> str:
    """Les nombres qu'on demande le plus souvent : ils évitent un appel d'outil et un tour de modèle."""
    with conn.pipeline():  # le début de transaction part avec : un seul aller-retour
        cur = conn.execute(
            """SELECT (SELECT count(*) FROM classe), (SELECT count(*) FROM salle), (SELECT count(*) FROM enseignant),
                      (SELECT count(*) FROM matiere),
                      (SELECT count(*) FROM cours c JOIN emploi_du_temps e ON e.id_semestre = c.id_semestre WHERE e.id_edt = %(e)s),
                      (SELECT count(*) FROM seance WHERE id_edt = %(e)s AND statut <> 'annulee')""", {"e": id_edt})
    n = cur.fetchone()
    return f"{n[0]} classes, {n[1]} salles, {n[2]} enseignants, {n[3]} matières, {n[4]} cours, {n[5]} séances."


def contexte(id_edt: int, aujourd_hui: date | None = None, chiffres: str = "") -> str:
    """Date du jour et calendrier des semaines à venir : le modèle se trompe
    souvent sur le jour de la semaine d'une date."""
    j = aujourd_hui or date.today()
    lundi = j - timedelta(days=j.weekday())
    semaines = ", ".join(
        f"{(lundi + timedelta(weeks=k)).isoformat()} au {(lundi + timedelta(weeks=k, days=5)).isoformat()}" for k in range(10)
    )
    return (
        f"Contexte : nous sommes le {JOURS[j.weekday()]} {j.isoformat()} ; emploi du temps n° {id_edt}, "
        f"version à jour.\nSemaines (lundi au samedi) : {semaines}."
        + (f"\nRepères : {chiffres}" if chiffres else "")
    )


# --- étapes affichées pendant le traitement (contextualisation, analyse...) ---------------

Progres = Callable[[str, str], None]  # (étape, détail)
_SUJETS = {"cours": "les cours", "classes": "les classes et groupes", "matieres": "les matières", "enseignants": "les enseignants",
           "salles": "les salles", "programme": "le programme", "calendrier": "le calendrier"}


def _date(iso: str | None) -> str:
    try:
        d = date.fromisoformat(iso or "")
    except ValueError:
        return iso or ""
    return f"{JOURS[d.weekday()]} {d.day}/{d.month:02d}"


def etape_outil(nom: str, args: dict) -> tuple[str, str]:
    """Étape et phrase affichées pendant un appel d'outil."""
    if nom == "lire_emploi_du_temps":
        cible = args.get("code_classe") or args.get("matricule") or args.get("code_salle")
        return "analyse", f"Lecture de l'emploi du temps{f' de {cible}' if cible else ''} du {_date(args.get('du'))} au {_date(args.get('au'))}"
    if nom == "lire_referentiel":
        return "analyse", f"Consultation du référentiel : {_SUJETS.get(args.get('sujet'), args.get('sujet', ''))}"
    if nom == "verifier_seance":
        return "verification", (f"Test d'une séance le {_date(args.get('date_seance'))} de {args.get('heure_debut')} "
                                f"à {args.get('heure_fin')} contre les règles CD-01 à CD-14")
    if nom == "proposer_generation":
        portee = ", ".join(args.get("classes") or args.get("filieres") or []) or "le périmètre demandé"
        return "calcul", f"Le solveur génère l'emploi du temps de {portee}"
    if nom == "proposer_reprogrammation_cours":
        return "calcul", f"Le solveur ramène les séances à venir entre le {_date(args.get('du'))} et le {_date(args.get('au'))}"
    if nom == "proposer_replanification":
        return "calcul", f"Le solveur replanifie du {_date(args.get('du'))} au {_date(args.get('au'))} en changeant le moins possible"
    if nom == "lire_piece_jointe":
        return "analyse", f"Lecture du fichier joint, à partir de la ligne {args.get('debut', 1)}"
    if nom == "proposer_changements_referentiel":
        return "verification", f"Vérification de {len(args.get('changements') or [])} changement(s) du référentiel dans la base"
    if nom == "proposer_suppression_seances":
        cible = args.get("code_classe") or args.get("matricule") or args.get("code_salle") or args.get("code_matiere") or "les séances choisies"
        return "verification", f"Recherche des séances à supprimer : {cible}"
    if nom == "proposer_epreuve":
        epreuve = "du rattrapage" if args.get("nature") == "rattrapage" else "de l'examen"
        return "verification", f"Vérification {epreuve} de {args.get('code_classe', '')} dans la base"
    if nom == "proposer_modifications":
        return "verification", f"Vérification de {len(args.get('operations') or [])} changement(s) de séances dans la base"
    if nom == "proposer_priorites":
        return "calcul", "Enregistrement des priorités suggérées"
    return "analyse", nom


def resultat_court(nom: str, resultat: str) -> str | None:
    """Issue d'une vérification ou d'un calcul, en une ligne."""
    premiere = resultat.splitlines()[0] if resultat else ""
    if nom == "verifier_seance" or nom.startswith("proposer_") or premiere.startswith(("Erreur", "Demande invalide")):
        return premiere[:140]
    return None


def fournisseurs() -> list[str]:
    """Fournisseurs à essayer, dans l'ordre : celui de ULTRAPLANNING_LLM d'abord, puis l'autre
    s'il a une clé. Sans choix valide : Groq (offre gratuite) d'abord."""
    avec_cle = [f for f, cle in (("groq", config.GROQ_API_KEY), ("anthropic", config.ANTHROPIC_API_KEY)) if cle]
    if config.LLM in avec_cle:
        avec_cle.remove(config.LLM)
        avec_cle.insert(0, config.LLM)
    return avec_cle


def repondre(
    conn: psycopg.Connection,
    id_edt: int,
    id_prompt: int,
    historique: list[tuple[str, str | None]],
    texte: str,
    client: groq.Groq | None = None,
    client_anthropic=None,
    progres: Progres | None = None,
    visuels: list[dict] | None = None,
    sur_texte: Callable[[str | None], None] | None = None,
) -> Reponse:
    """Répond à un message de la discussion. `historique` : couples (demande,
    réponse) des messages précédents, du plus ancien au plus récent.
    `client` / `client_anthropic` : clients imposés (tests) ; seuls ceux-là sont alors essayés.
    `visuels` : images et PDF scannés joints au message (blocs de l'API d'Anthropic) ; seul Claude
    sait les lire, il passe donc en premier.
    `sur_texte` reçoit la réponse au fur et à mesure qu'elle s'écrit (Claude) ; None : oublier ce
    qui a été reçu (ce texte précédait un appel d'outil, ou le fournisseur a changé)."""
    signaler: Progres = progres or (lambda etape, detail: None)
    ctx = Contexte(conn, id_edt, id_prompt, [])
    outils = {o.nom: o for o in construire_outils(ctx)}
    demande = f"{contexte(id_edt, chiffres=reperes(conn, id_edt))}\n\n{texte}"

    relance = {"faite": False}

    def relancer_si_decrit(reponse: str) -> str | None:
        """Le modèle décrit parfois l'appel d'un outil de proposition au lieu de le faire : relance, une fois."""
        decrits = [n for n in outils if n.startswith("proposer_") and n in reponse]
        if decrits and not ctx.propositions_creees and not relance["faite"]:
            relance["faite"] = True
            return f"Tu as décrit l'appel à {decrits[0]} sans le faire. Appelle l'outil maintenant, puis réponds d'après son résultat."
        return None

    def executer(nom: str, arguments: str) -> str:
        try:
            args = json.loads(arguments or "{}")
        except json.JSONDecodeError:
            args = {}
        signaler(*etape_outil(nom, args if isinstance(args, dict) else {}))
        resultat = executer_outil(ctx, outils, nom, arguments)
        court = resultat_court(nom, resultat)
        if court:
            signaler("resultat", court)
        return resultat

    texte_recu = {"oui": False}

    def morceau_recu(morceau: str) -> None:
        texte_recu["oui"] = True
        if sur_texte:
            sur_texte(morceau)

    def nouveau_tour() -> None:
        if texte_recu["oui"] and sur_texte:
            sur_texte(None)
        texte_recu["oui"] = False

    if client is not None or client_anthropic is not None:
        ordre = [f for f, c in (("groq", client), ("anthropic", client_anthropic)) if c is not None]
    else:
        ordre = fournisseurs()
    if visuels and "anthropic" in ordre:
        ordre = ["anthropic", *(f for f in ordre if f != "anthropic")]
    if not ordre:
        raise AgentIndisponible("Aucune clé d'assistant IA : renseignez GROQ_API_KEY ou ANTHROPIC_API_KEY dans backend/.env.")

    echecs = []
    for f in ordre:
        try:
            if f == "groq":
                texte_final, fini = _boucle_groq(outils, historique, demande, executer, relancer_si_decrit, client)
                modele = config.MODELE
            else:
                texte_final, fini = llm_anthropic.boucle(SYSTEME, historique, demande, outils, executer,
                                                         relancer_si_decrit, client_anthropic, nouveau_tour, visuels, morceau_recu)
                modele = config.ANTHROPIC_MODEL
        except (AgentIndisponible, llm_anthropic.Indisponible) as e:
            journal.warning("assistant : %s indisponible (%s)", f, e)
            echecs.append(str(e))
            nouveau_tour()
            if f != ordre[-1]:
                signaler("relais", f"{'Groq' if f == 'groq' else 'Claude'} indisponible : un autre modèle prend le relais")
            continue
        # Le modèle ajoute parfois du gras Markdown malgré la consigne : l'interface affiche du texte brut
        texte_final = texte_final.replace("**", "").strip()
        return Reponse(texte_final or "(réponse vide)", "traite" if fini else "erreur", ctx.propositions_creees, modele)
    raise AgentIndisponible(" ; ".join(echecs))


def _boucle_groq(outils, historique, demande, executer, relancer_si_decrit, client) -> tuple[str, bool]:
    schemas = [o.schema() for o in outils.values()]
    messages: list[dict] = [{"role": "system", "content": SYSTEME}]
    for d, r in historique:
        messages.append({"role": "user", "content": d})
        messages.append({"role": "assistant", "content": r or "(pas de réponse)"})
    messages.append({"role": "user", "content": demande})

    try:
        # Nouvelles tentatives espacées en cas de limite de débit (plan gratuit de Groq)
        client = client or groq.Groq(api_key=config.GROQ_API_KEY or None, base_url=config.GROQ_BASE_URL, max_retries=4)
        essais = 0
        for _ in range(config.ITERATIONS_MAX_AGENT):
            try:
                rep = client.chat.completions.create(
                    model=config.MODELE,
                    messages=messages,
                    tools=schemas,
                    tool_choice="auto",
                    reasoning_effort=config.EFFORT,
                    temperature=0.2,
                    max_completion_tokens=8192,
                )
            except groq.BadRequestError as e:
                # Appel d'outil mal formé par le modèle (« tool_use_failed ») : on redemande
                if "tool_use_failed" in str(e) and essais < ESSAIS_APPEL_INVALIDE:
                    essais += 1
                    continue
                raise
            choix = rep.choices[0]
            msg = choix.message
            if msg.tool_calls:
                messages.append({
                    "role": "assistant",
                    "content": msg.content or "",
                    "tool_calls": [
                        {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                        for tc in msg.tool_calls
                    ],
                })
                for tc in msg.tool_calls:
                    resultat = executer(tc.function.name, tc.function.arguments)
                    journal.info("outil %s %s -> %s", tc.function.name, tc.function.arguments[:300], resultat.splitlines()[0][:200] if resultat else "")
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": resultat})
                continue
            consigne = relancer_si_decrit(msg.content or "")
            if consigne:
                messages.append({"role": "assistant", "content": msg.content or ""})
                messages.append({"role": "user", "content": consigne})
                continue
            texte_final = msg.content or ""
            if choix.finish_reason == "length":
                texte_final += "\n\n(Réponse interrompue : reformulez la demande de façon plus précise.)"
            return texte_final, True
    except groq.AuthenticationError as e:
        raise AgentIndisponible("Clé d'API Groq invalide (GROQ_API_KEY dans backend/.env).") from e
    except groq.RateLimitError as e:
        raise AgentIndisponible(message_limite(str(e))) from e
    except groq.APIConnectionError as e:
        raise AgentIndisponible("Impossible de joindre l'API Groq.") from e
    except groq.APIStatusError as e:
        if e.status_code == 413:
            raise AgentIndisponible("Demande trop volumineuse pour l'offre gratuite de Groq (jetons par minute) : "
                                    "découpez-la, ou utilisez Claude ou une offre Groq payante.") from e
        raise AgentIndisponible(f"Erreur de l'API Groq ({e.status_code}).") from e
    except groq.GroqError as e:  # ex. aucune clé configurée
        raise AgentIndisponible(f"Assistant indisponible : {e}") from e
    return "Demande trop longue à traiter en une fois : découpez-la ou précisez-la.", False
