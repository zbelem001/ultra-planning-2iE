"""Déclaration d'un outil d'agent à partir d'une fonction Python typée.

Le schéma JSON (format « function calling » compatible OpenAI, utilisé par
Groq) est déduit de la signature et de la section « Args: » de la docstring ;
les arguments renvoyés par le modèle sont validés par pydantic avant l'appel.
"""

from __future__ import annotations

import inspect
import re
import typing
from collections.abc import Callable
from typing import Any

from pydantic import ConfigDict, Field, ValidationError, create_model


def _docstring(fn: Callable) -> tuple[str, dict[str, str]]:
    doc = inspect.getdoc(fn) or ""
    corps, _, args = doc.partition("Args:")
    descriptions: dict[str, str] = {}
    courant = None
    for ligne in args.splitlines():
        m = re.match(r"\s*(\w+):\s*(.*)", ligne)
        if m and not ligne.startswith(" " * 8):
            courant = m.group(1)
            descriptions[courant] = m.group(2).strip()
        elif courant and ligne.strip():
            descriptions[courant] += " " + ligne.strip()
    return " ".join(corps.split()), descriptions


def _sans_refs(schema: dict) -> dict:
    """Remplace les $ref par leur définition et retire les titres (schéma plus
    simple pour les modèles ouverts)."""
    defs = schema.pop("$defs", {})

    def visiter(n: Any) -> Any:
        if isinstance(n, dict):
            if "$ref" in n:
                return visiter(defs[n["$ref"].split("/")[-1]])
            return {k: visiter(v) for k, v in n.items() if k != "title"}
        if isinstance(n, list):
            return [visiter(x) for x in n]
        return n

    return visiter(schema)


class Outil:
    def __init__(self, fn: Callable[..., str], nom: str):
        self.fn = fn
        self.nom = nom
        self.description, args = _docstring(fn)
        types = typing.get_type_hints(fn)
        champs = {}
        for nom_param, p in inspect.signature(fn).parameters.items():
            defaut = ... if p.default is inspect.Parameter.empty else p.default
            champs[nom_param] = (types[nom_param], Field(defaut, description=args.get(nom_param)))
        self.modele = create_model(f"Arguments_{nom}", __config__=ConfigDict(extra="forbid"), **champs)

    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.nom,
                "description": self.description,
                "parameters": _sans_refs(self.modele.model_json_schema()),
            },
        }

    def appeler(self, arguments: dict) -> str:
        """Valide les arguments puis appelle la fonction. Lève ValidationError si invalides."""
        valides = self.modele.model_validate(arguments)
        return self.fn(**{k: getattr(valides, k) for k in self.modele.model_fields})


def outil(nom: str) -> Callable[[Callable[..., str]], Outil]:
    return lambda fn: Outil(fn, nom)


__all__ = ["Outil", "ValidationError", "outil"]
