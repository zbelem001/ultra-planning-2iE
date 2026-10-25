"""Assistant IA : un agent qui comprend les demandes en langage naturel et agit
à travers des outils (lecture, vérification, solveur, propositions).

Le modèle est servi par Groq (API « chat completions » avec appels d'outils).
La boucle est écrite ici : le modèle demande des outils, on les exécute, on
renvoie les résultats, jusqu'à sa réponse finale.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta

import groq
import psycopg

from . import config
from .outils import Contexte, construire_outils
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
- CD-06 enseignant habilité, présent (absences, séjours des externes) et disponible sur le créneau.
- CD-07 cours conforme au programme de la classe. CD-08 volume horaire du cours non dépassé.
- CD-09 dans le semestre, hors jours fériés et congés. CD-10 aligné sur la grille. CD-11 pas pendant la pause.
- CD-12 salle disponible. CD-13 au plus 3 matières par classe et par semaine. CD-14 rythme hebdomadaire maximal du cours.
Bonnes pratiques (préférences, que l'on peut contourner en le disant) : CS-01 créneaux préférés des enseignants, CS-02 pas de trous dans la journée, CS-03 peu de changements de bâtiment ou de site, CS-04 cours ramassés pour les externes et enchaînés pour les permanents, CS-05 CM avant TD et TP, CS-06 au plus 6 h par jour pour un enseignant, CS-07 cours prioritaires d'abord.

Comment travailler :
- Appuie chaque affirmation sur les outils : lis l'emploi du temps ou le référentiel avant de répondre. N'invente jamais un identifiant, un code, une date ou une conséquence : récupère-les avec les outils.
- Pour un déplacement ponctuel, teste-le avec verifier_seance. Pour toute autre modification, utilise proposer_replanification avec le périmètre le plus étroit (une classe, quelques cours) ; traduis la demande en contraintes imposer / interdire, chacune limitée par ses dates.
- Pour programmer une classe ou une filière, utilise proposer_generation : sur tout le semestre (« génère le programme »), ou sur une ou deux semaines précises (« planifie la semaine du 2 novembre ») en donnant du et au. Sur une période courte, présente ce qui est placé et les heures reportées aux semaines suivantes. N'écris jamais toi-même un planning (jours, heures, salles) dans ta réponse : tout emploi du temps vient du solveur. Si l'outil n'est pas adapté, dis-le.
- Quand une demande appelle un outil, appelle-le directement : n'annonce jamais un appel d'outil sans le faire.
- Tu ne modifies jamais l'emploi du temps toi-même : une proposition reste en attente jusqu'à ce qu'un planificateur l'applique dans l'interface. Donne son numéro ; n'écris jamais qu'une modification est faite.
- Tu ne publies pas. Le circuit est : 1) le planificateur applique la proposition (bouton Appliquer, ici ou dans la page Publication) ; elle apparaît alors dans la page Planification ; 2) il publie la version dans la page Publication ; elle devient visible dans l'espace invité. Explique-le quand on te demande de publier.

Argumenter :
- Demande impossible : si elle contredit une règle dure (par exemple un cours le samedi après-midi, 20 h d'un cours dans une semaine au rythme maximal de 15 h, une classe entière dans une salle trop petite, un externe hors de son séjour), refuse-la sans créer de proposition. Explique en une ou deux phrases quelle règle elle viole et pourquoi, chiffres à l'appui, puis propose une ou deux alternatives réalistes. Ne cite que les règles réellement violées : vérifie chaque motif sur les horaires et les chiffres (13h–15h ne touche pas la pause de 12h à 13h).
- Demande possible mais coûteuse : avant de conclure, présente les conséquences données par l'outil (heures qui ne seraient plus programmées, enseignants à prévenir, cours qui finissent plus tard, journées trop chargées, changements de site). Si des heures seraient perdues, déconseille d'appliquer la proposition telle quelle et dis comment l'améliorer (élargir la période, assouplir la demande).
- Demande qui va contre une bonne pratique (un TD avant son CM, une journée de 8 h pour un enseignant) : fais-la si on te la demande, mais signale-le.
- Demande ambiguë (quelle classe, quelle semaine, quel cours) : pose une question courte au lieu de deviner.
- Absence ou indisponibilité nouvelle d'un enseignant : propose la replanification, et conseille d'enregistrer l'absence dans la page Disponibilités pour qu'elle soit prise en compte durablement.
- Alternatives : une alternative précise (jour, heures, salle) doit être testée avec verifier_seance avant d'être présentée comme valable ; sinon, présente-la comme une piste à vérifier. Une séance dure de 2 à 4 h : 5 h dans une matinée, ce sont deux séances ; ne propose jamais de séance d'1 h.
- Dates : prends le jour de la semaine dans le calendrier du contexte ou dans les outils, jamais de tête.
- Distingue toujours ce que tu as vérifié de ce que tu supposes ; n'écris jamais qu'une salle est libre ou qu'un enseignant est présent sans l'avoir vérifié.

Réponds en français, en texte simple, sans nommer tes outils ni leurs paramètres (dis « à vérifier » plutôt que « avec verifier_seance ») : phrases courtes et listes à tirets, sans tableau ni titre ni Markdown. Commence par la conclusion (possible, impossible, possible avec des conséquences), puis donne les raisons."""

journal = logging.getLogger("ultraplanning.agent")

ESSAIS_APPEL_INVALIDE = 2  # nouvelles tentatives si le modèle produit un appel d'outil mal formé


class AgentIndisponible(Exception):
    pass


@dataclass
class Reponse:
    texte: str
    statut: str  # 'traite' ou 'erreur'
    propositions: list[int]


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
            return outil.appeler(args)
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


def contexte(id_edt: int, version: tuple, aujourd_hui: date | None = None) -> str:
    """Date du jour et calendrier des semaines à venir : le modèle se trompe
    souvent sur le jour de la semaine d'une date."""
    j = aujourd_hui or date.today()
    lundi = j - timedelta(days=j.weekday())
    semaines = ", ".join(
        f"{(lundi + timedelta(weeks=k)).isoformat()} au {(lundi + timedelta(weeks=k, days=5)).isoformat()}" for k in range(10)
    )
    return (
        f"Contexte : nous sommes le {JOURS[j.weekday()]} {j.isoformat()} ; emploi du temps de travail n° {id_edt}, "
        f"version {version[0]} ({version[1]}).\nSemaines (lundi au samedi) : {semaines}."
    )


def repondre(
    conn: psycopg.Connection,
    id_edt: int,
    id_prompt: int,
    historique: list[tuple[str, str | None]],
    texte: str,
    client: groq.Groq | None = None,
) -> Reponse:
    """Répond à un message de la discussion. `historique` : couples (demande,
    réponse) des messages précédents, du plus ancien au plus récent."""
    ctx = Contexte(conn, id_edt, id_prompt, [])
    version = conn.execute("SELECT version, statut FROM emploi_du_temps WHERE id_edt = %s", (id_edt,)).fetchone()
    outils = {o.nom: o for o in construire_outils(ctx)}
    schemas = [o.schema() for o in outils.values()]

    messages: list[dict] = [{"role": "system", "content": SYSTEME}]
    for demande, reponse in historique:
        messages.append({"role": "user", "content": demande})
        messages.append({"role": "assistant", "content": reponse or "(pas de réponse)"})
    messages.append({"role": "user", "content": f"{contexte(id_edt, version)}\n\n{texte}"})

    try:
        # Nouvelles tentatives espacées en cas de limite de débit (plan gratuit de Groq)
        client = client or groq.Groq(api_key=config.GROQ_API_KEY or None, base_url=config.GROQ_BASE_URL, max_retries=4)
        essais = 0
        relance = False
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
                    resultat = executer_outil(ctx, outils, tc.function.name, tc.function.arguments)
                    journal.info("outil %s %s -> %s", tc.function.name, tc.function.arguments[:300], resultat.splitlines()[0][:200] if resultat else "")
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": resultat})
                continue
            # Le modèle décrit parfois l'appel d'un outil de proposition au lieu de le faire : on le relance une fois
            decrits = [n for n in outils if n.startswith("proposer_") and n in (msg.content or "")]
            if decrits and not ctx.propositions_creees and not relance:
                relance = True
                messages.append({"role": "assistant", "content": msg.content or ""})
                messages.append({"role": "user", "content": f"Tu as décrit l'appel à {decrits[0]} sans le faire. "
                                 "Appelle l'outil maintenant, puis réponds d'après son résultat."})
                continue
            # Le modèle ajoute parfois du gras Markdown malgré la consigne : l'interface affiche du texte brut
            texte_final = (msg.content or "").replace("**", "").strip()
            if choix.finish_reason == "length":
                texte_final += "\n\n(Réponse interrompue : reformulez la demande de façon plus précise.)"
            return Reponse(texte_final or "(réponse vide)", "traite", ctx.propositions_creees)
    except groq.AuthenticationError as e:
        raise AgentIndisponible("Clé d'API Groq invalide (GROQ_API_KEY dans backend/.env).") from e
    except groq.RateLimitError as e:
        raise AgentIndisponible(message_limite(str(e))) from e
    except groq.APIConnectionError as e:
        raise AgentIndisponible("Impossible de joindre l'API Groq.") from e
    except groq.APIStatusError as e:
        raise AgentIndisponible(f"Erreur de l'API Groq ({e.status_code}).") from e
    except groq.GroqError as e:  # ex. aucune clé configurée
        raise AgentIndisponible(f"Assistant indisponible : {e}") from e

    return Reponse(
        "Demande trop longue à traiter en une fois : découpez-la ou précisez-la.", "erreur", ctx.propositions_creees
    )
