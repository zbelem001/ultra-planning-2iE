"""Configuration lue dans l'environnement et dans backend/.env (jamais de
secret dans le dépôt : .env est ignoré par git)."""

import os
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

# Les variables déjà définies dans l'environnement restent prioritaires
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

# PostgreSQL / Supabase. Côté serveur seulement : la connexion passe outre la RLS.
# SUPABASE_POOLER_URL : URI du « Session pooler » de Supabase (la connexion
# directe exige l'IPv6).
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_POOLER_URL", "")

# Assistant IA : modèle servi par Groq (API compatible OpenAI)
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
_url = urlsplit(os.environ.get("GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions"))
GROQ_BASE_URL = f"{_url.scheme}://{_url.netloc}"  # le SDK Groq ajoute lui-même /openai/v1/…
MODELE = os.environ.get("MODEL", "openai/gpt-oss-120b")
EFFORT = os.environ.get("ULTRAPLANNING_EFFORT", "medium")  # raisonnement : low, medium, high
ITERATIONS_MAX_AGENT = int(os.environ.get("ULTRAPLANNING_ITERATIONS_AGENT", "12"))

# Origines autorisées : console des écoles (5173) et console super admin (5174)
ORIGINES = os.environ.get(
    "ULTRAPLANNING_ORIGINES", "http://localhost:5173,http://localhost:5174,http://localhost:5179"
).split(",")

# Supabase Auth : vérification des jetons (clés publiques JWKS) et invitations
# (API d'administration, clé secrète)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_JWKS_URL = os.environ.get("SUPABASE_JWKS_URL") or (
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else "")
SUPABASE_CLE_SECRETE = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
# Pages où arrivent les liens d'invitation (à déclarer dans Supabase > Authentication > URL Configuration)
URL_CONSOLE = os.environ.get("ULTRAPLANNING_URL_CONSOLE", "http://localhost:5173/admin/connexion")
URL_SUPERADMIN = os.environ.get("ULTRAPLANNING_URL_SUPERADMIN", "http://localhost:5174/connexion")

# Envoi des notifications de publication (BF-20) : serveur SMTP de l'école ou d'un service
# (Gmail avec mot de passe d'application, Brevo...). Sans SMTP_HOST, rien n'est envoyé.
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))  # 587 : STARTTLS ; 465 : SSL
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM") or SMTP_USER
# Espace invités, pour le lien « voir mon emploi du temps » des e-mails
URL_INVITES = os.environ.get("ULTRAPLANNING_URL_INVITES", "http://localhost:5173/").rstrip("/") + "/"

# Développement seulement : accepte l'en-tête X-Utilisateur (identifiant du compte)
# sans jeton. Jamais en production.
AUTH_DEV = os.environ.get("ULTRAPLANNING_AUTH_DEV", "") == "1"
