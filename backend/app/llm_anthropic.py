"""Boucle de l'assistant IA avec Claude (API Messages d'Anthropic, SDK officiel).

Mêmes outils, même consigne et même historique que la boucle Groq (agent.py) ; seul
le format des échanges change : les outils ont un `input_schema`, les appels arrivent
en blocs `tool_use` et leurs résultats repartent en blocs `tool_result`.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable

import anthropic

from . import config
from .schema_outil import Outil

journal = logging.getLogger("ultraplanning.agent")


class Indisponible(Exception):
    """Claude ne peut pas répondre (clé, quota, réseau) : l'agent essaie l'autre fournisseur."""


def outils_claude(outils: dict[str, Outil]) -> list[dict]:
    return [
        {"name": f["name"], "description": f["description"], "input_schema": f["parameters"]}
        for f in (o.schema()["function"] for o in outils.values())
    ]


def boucle(
    systeme: str,
    historique: list[tuple[str, str | None]],
    demande: str,
    outils: dict[str, Outil],
    executer: Callable[[str, str], str],
    relancer_si_decrit: Callable[[str], str | None],
    client: anthropic.Anthropic | None = None,
    reflechir: Callable[[], None] = lambda: None,
    visuels: list[dict] | None = None,
) -> tuple[str, bool]:
    """Fait répondre Claude ; renvoie (texte final, terminé). `terminé` est faux si la limite
    d'étapes d'outils est atteinte ou si la demande est refusée par le modèle. `visuels` : blocs
    image ou document (fichiers joints sans texte), placés avant la demande."""
    client = client or anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=3)
    # La consigne et les outils ne changent pas d'un message à l'autre : mis en cache
    systeme_bloc = [{"type": "text", "text": systeme, "cache_control": {"type": "ephemeral"}}]
    messages: list = []
    for d, r in historique:
        messages.append({"role": "user", "content": d})
        messages.append({"role": "assistant", "content": r or "(pas de réponse)"})
    messages.append({"role": "user", "content": [*visuels, {"type": "text", "text": demande}] if visuels else demande})

    try:
        for _ in range(config.ITERATIONS_MAX_AGENT):
            reflechir()
            rep = client.messages.create(
                model=config.ANTHROPIC_MODEL,
                max_tokens=16000,
                system=systeme_bloc,
                tools=outils_claude(outils),
                messages=messages,
                output_config={"effort": config.EFFORT},
            )
            if rep.stop_reason == "refusal":
                return "Demande refusée par le modèle : reformulez-la en vous en tenant à la planification.", False
            appels = [b for b in rep.content if b.type == "tool_use"]
            if appels:
                # Le contenu complet (réflexion comprise) repart tel quel avant les résultats
                messages.append({"role": "assistant", "content": rep.content})
                resultats = []
                for b in appels:
                    resultat = executer(b.name, json.dumps(b.input))
                    journal.info("outil %s %s -> %s (claude)", b.name, json.dumps(b.input)[:300],
                                 resultat.splitlines()[0][:200] if resultat else "")
                    resultats.append({"type": "tool_result", "tool_use_id": b.id, "content": resultat,
                                      "is_error": resultat.startswith(("Erreur", "Demande invalide"))})
                messages.append({"role": "user", "content": resultats})  # tous les résultats en un message
                continue
            texte = "\n".join(b.text for b in rep.content if b.type == "text").strip()
            consigne = relancer_si_decrit(texte)
            if consigne:
                messages.append({"role": "assistant", "content": rep.content})
                messages.append({"role": "user", "content": consigne})
                continue
            if rep.stop_reason == "max_tokens":
                texte += "\n\n(Réponse interrompue : reformulez la demande de façon plus précise.)"
            return texte, True
    except anthropic.AuthenticationError as e:
        raise Indisponible("clé d'API Anthropic invalide (ANTHROPIC_API_KEY)") from e
    except anthropic.RateLimitError as e:
        raise Indisponible("limite de requêtes Anthropic atteinte") from e
    except anthropic.APIConnectionError as e:
        raise Indisponible("API Anthropic injoignable") from e
    except anthropic.APIStatusError as e:
        raise Indisponible(f"erreur de l'API Anthropic ({e.status_code} : {e.message})") from e
    return "Demande trop longue à traiter en une fois : découpez-la ou précisez-la.", False
