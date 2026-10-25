"""Appels à l'API d'administration de Supabase Auth (clé secrète, côté serveur).

- inviter : crée le compte Auth et envoie l'e-mail d'invitation ; la personne
  choisit son mot de passe en suivant le lien.
- reinitialiser : envoie un lien de nouveau mot de passe (compte déjà activé).
- etat : invitation acceptée ou non.
- bloquer : empêche (ou rétablit) la connexion d'un compte désactivé.
- changer_email, supprimer : changement d'adresse d'un compte.

Supabase n'envoie les e-mails qu'avec un serveur SMTP configuré dans le projet
(le service par défaut est très limité).
"""

from __future__ import annotations

import httpx

from . import config


class ErreurSupabase(Exception):
    pass


def _appel(methode: str, chemin: str, **kwargs) -> dict:
    if not (config.SUPABASE_URL and config.SUPABASE_CLE_SECRETE):
        raise ErreurSupabase("Supabase Auth n'est pas configuré (SUPABASE_URL, SUPABASE_SECRET_KEY)")
    cle = config.SUPABASE_CLE_SECRETE
    try:
        r = httpx.request(methode, f"{config.SUPABASE_URL}/auth/v1{chemin}", timeout=15,
                          headers={"apikey": cle, "Authorization": f"Bearer {cle}"}, **kwargs)
    except httpx.HTTPError as e:
        raise ErreurSupabase("Supabase Auth est injoignable") from e
    if r.status_code >= 400:
        try:
            corps = r.json()
            message = corps.get("msg") or corps.get("message") or corps.get("error_description") or r.text
        except ValueError:
            message = r.text
        if "already been registered" in message:
            message = "Cette adresse e-mail a déjà un compte Supabase"
        elif r.status_code == 429:
            message = "Trop d'e-mails envoyés : limite de Supabase atteinte, réessayez plus tard"
        raise ErreurSupabase(message)
    return r.json() if r.content else {}


def inviter(email: str, redirection: str, donnees: dict | None = None) -> str:
    """Envoie l'invitation et renvoie l'identifiant du compte Auth."""
    u = _appel("POST", "/invite", params={"redirect_to": redirection}, json={"email": email, "data": donnees or {}})
    return u["id"]


def reinitialiser(email: str, redirection: str) -> None:
    _appel("POST", "/recover", params={"redirect_to": redirection}, json={"email": email})


def etat(auth_id: str) -> str:
    """'acceptee' si la personne a déjà validé son adresse, sinon 'en_attente'."""
    u = _appel("GET", f"/admin/users/{auth_id}")
    return "acceptee" if u.get("email_confirmed_at") or u.get("last_sign_in_at") else "en_attente"


def bloquer(auth_id: str, bloque: bool) -> None:
    _appel("PUT", f"/admin/users/{auth_id}", json={"ban_duration": "876000h" if bloque else "none"})


def changer_email(auth_id: str, email: str) -> None:
    """Nouvelle adresse d'un compte déjà activé : confirmée d'office (décision du super admin),
    le mot de passe ne change pas."""
    _appel("PUT", f"/admin/users/{auth_id}", json={"email": email, "email_confirm": True})


def supprimer(auth_id: str) -> None:
    _appel("DELETE", f"/admin/users/{auth_id}")
