"""Crée le compte du super administrateur et lui envoie l'invitation Supabase.

    .venv/bin/python -m app.creer_superadmin --email vous@exemple.org --login superadmin

Le lien de l'e-mail mène à la console super admin (ULTRAPLANNING_URL_SUPERADMIN),
où la personne choisit son mot de passe.
"""

import argparse

import psycopg

from . import config, supabase_admin


def main() -> None:
    p = argparse.ArgumentParser(prog="creer_superadmin", description=__doc__.splitlines()[0])
    p.add_argument("--email", required=True)
    p.add_argument("--login", default="superadmin")
    a = p.parse_args()
    email = a.email.strip().lower()
    with psycopg.connect(config.DATABASE_URL) as conn, conn.transaction():
        if conn.execute("SELECT 1 FROM utilisateur WHERE email = %s", (email,)).fetchone():
            raise SystemExit(f"Un compte existe déjà pour {email}.")
        id_u = conn.execute(
            "INSERT INTO utilisateur (login, email, role) VALUES (%s, %s, 'superadmin') RETURNING id_utilisateur",
            (a.login, email),
        ).fetchone()[0]
        try:
            auth_id = supabase_admin.inviter(email, config.URL_SUPERADMIN, {"role": "superadmin"})
        except supabase_admin.ErreurSupabase as e:
            raise SystemExit(f"Invitation non envoyée : {e}") from e
        conn.execute("UPDATE utilisateur SET auth_id = %s WHERE id_utilisateur = %s", (auth_id, id_u))
    print(f"Super admin {a.login} créé (compte {id_u}). Invitation envoyée à {email}.")


if __name__ == "__main__":
    main()
