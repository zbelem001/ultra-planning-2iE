"""Fichiers joints aux messages de l'assistant IA (maquette, liste d'enseignants, programme...).

Le fichier est gardé dans la base (PIECE_JOINTE) et lu ici, sur le serveur, sans IA :
- CSV et Excel : une ligne de texte par ligne du tableau, feuille par feuille ;
- PDF avec du texte, texte brut : le texte, page par page ;
- image, PDF scanné : rien à extraire ; Claude les lit directement (blocs image et
  document de l'API Messages), Groq ne sait pas les lire.
L'assistant lit le texte par morceaux (outil lire_piece_jointe) au lieu de tout recevoir
d'un coup : un gros tableur viderait vite le quota de jetons.
"""

from __future__ import annotations

import base64
import csv
import io
from dataclasses import dataclass
from datetime import date, datetime

import psycopg

TAILLE_MAX = 5 * 1024 * 1024
IMAGES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
PDF = "application/pdf"
TYPES = {
    ".csv": "text/csv", ".txt": "text/plain", ".md": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pdf": PDF, ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif",
}
FORMATS = "CSV, Excel (.xlsx), PDF, texte, image (PNG, JPEG, WebP)"


class FichierRefuse(ValueError):
    pass


@dataclass
class Lecture:
    lignes: list[str] | None  # None : rien à extraire (image, PDF scanné)
    visuel: bool  # à montrer tel quel au modèle (image ou PDF sans texte)


def type_de(nom: str) -> str:
    """Type d'après l'extension (le navigateur annonce parfois un type vide ou générique)."""
    ext = "." + nom.rsplit(".", 1)[-1].lower() if "." in nom else ""
    if ext == ".xls":
        raise FichierRefuse("Ancien format Excel (.xls) : enregistrez le fichier en .xlsx ou en CSV.")
    if ext in TYPES:
        return TYPES[ext]
    raise FichierRefuse(f"Format non pris en charge ({nom}). Formats acceptés : {FORMATS}.")


def decoder(contenu_base64: str) -> bytes:
    try:
        contenu = base64.b64decode(contenu_base64, validate=True)
    except ValueError as e:
        raise FichierRefuse("Fichier illisible (encodage).") from e
    if not contenu:
        raise FichierRefuse("Fichier vide.")
    if len(contenu) > TAILLE_MAX:
        raise FichierRefuse(f"Fichier trop lourd ({len(contenu) / 1e6:.1f} Mo) : 5 Mo au plus.")
    return contenu


def _cellule(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat() if v.time() == datetime.min.time() else v.isoformat(" ", "minutes")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _texte(contenu: bytes) -> str:
    for codage in ("utf-8-sig", "cp1252"):
        try:
            return contenu.decode(codage)
        except UnicodeDecodeError:
            continue
    return contenu.decode("latin-1")


def _csv(contenu: bytes) -> list[str]:
    texte = _texte(contenu)
    try:
        dialecte = csv.Sniffer().sniff(texte[:4096], delimiters=";,\t|")
    except csv.Error:
        dialecte = csv.excel
    lignes = []
    for ligne in csv.reader(io.StringIO(texte), dialecte):
        cellules = [c.strip() for c in ligne]
        if any(cellules):
            lignes.append(" ; ".join(cellules))
    return lignes


def _excel(contenu: bytes) -> list[str]:
    import openpyxl  # chargé seulement quand un tableur arrive

    try:
        classeur = openpyxl.load_workbook(io.BytesIO(contenu), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001 - fichier corrompu ou protégé
        raise FichierRefuse("Classeur Excel illisible (fichier abîmé ou protégé par mot de passe ?).") from e
    lignes = []
    for feuille in classeur.worksheets:
        lignes.append(f"[feuille « {feuille.title} »]")
        for ligne in feuille.iter_rows(values_only=True):
            cellules = [_cellule(v) for v in ligne]
            while cellules and not cellules[-1]:
                cellules.pop()
            if cellules:
                lignes.append(" ; ".join(cellules))
    classeur.close()
    return lignes


def _pdf(contenu: bytes) -> list[str] | None:
    from pypdf import PdfReader

    try:
        pages = PdfReader(io.BytesIO(contenu)).pages
        textes = [p.extract_text() or "" for p in pages]
    except Exception as e:  # noqa: BLE001
        raise FichierRefuse("PDF illisible (fichier abîmé ou protégé par mot de passe ?).") from e
    if sum(len(t.strip()) for t in textes) < 10 * max(1, len(textes)):
        return None  # PDF scanné : des images, pas de texte
    lignes = []
    for n, t in enumerate(textes, 1):
        lignes.append(f"[page {n}]")
        lignes += [x.strip() for x in t.splitlines() if x.strip()]
    return lignes


def lire(type_mime: str, contenu: bytes) -> Lecture:
    if type_mime in IMAGES:
        return Lecture(None, True)
    if type_mime == PDF:
        lignes = _pdf(contenu)
        return Lecture(lignes, lignes is None)
    if type_mime == "text/csv":
        return Lecture(_csv(contenu), False)
    if type_mime.startswith("application/vnd.openxmlformats"):
        return Lecture(_excel(contenu), False)
    return Lecture([x.rstrip() for x in _texte(contenu).splitlines() if x.strip()], False)


def annonce(id_piece: int, nom: str, lecture: Lecture, visuel_lisible: bool) -> str:
    """Ligne ajoutée à la demande pour signaler le fichier au modèle."""
    if lecture.lignes is not None:
        return (f"Pièce jointe n° {id_piece} : « {nom} », {len(lecture.lignes)} lignes de texte. "
                "Lis-la par morceaux avec lire_piece_jointe avant d'en parler.")
    if visuel_lisible:
        return f"Pièce jointe n° {id_piece} : « {nom} » (image ou PDF scanné), jointe ci-dessus."
    return (f"Pièce jointe n° {id_piece} : « {nom} » (image ou PDF scanné). Ce modèle ne peut pas la lire : "
            "dis-le et demande un CSV, un Excel ou un PDF avec du texte.")


def bloc_claude(type_mime: str, contenu: bytes) -> dict:
    """Bloc image ou document de l'API Messages d'Anthropic."""
    source = {"type": "base64", "media_type": type_mime, "data": base64.b64encode(contenu).decode()}
    return {"type": "document" if type_mime == PDF else "image", "source": source}


def extrait(conn: psycopg.Connection, id_prompt: int, id_piece: int | None, debut: int, nombre: int) -> str:
    """Lignes debut..debut+nombre-1 d'une pièce jointe de la discussion du message en cours."""
    pieces = conn.execute(
        """SELECT pj.id_piece, pj.nom, pj.type_mime, pj.contenu FROM piece_jointe pj JOIN prompt p USING (id_prompt)
           WHERE p.id_conversation = (SELECT id_conversation FROM prompt WHERE id_prompt = %s)
           ORDER BY pj.id_piece""",
        (id_prompt,),
    ).fetchall()
    if not pieces:
        return "Aucune pièce jointe dans cette discussion."
    choisie = next((p for p in pieces if p[0] == id_piece), None) if id_piece else pieces[-1]
    if choisie is None:
        return f"Pièce jointe {id_piece} introuvable. Pièces de la discussion : " + ", ".join(f"n° {p[0]} « {p[1]} »" for p in pieces)
    lecture = lire(choisie[2], bytes(choisie[3]))
    if lecture.lignes is None:
        return (f"« {choisie[1]} » est une image ou un PDF scanné : pas de texte à lire. Son contenu n'est visible "
                "que dans le message où elle a été jointe, avec Claude ; sinon, demande un CSV, un Excel ou un PDF avec du texte.")
    debut = max(1, debut)
    morceau = lecture.lignes[debut - 1:debut - 1 + max(1, min(nombre, 200))]
    fin = debut + len(morceau) - 1
    tete = f"« {choisie[1]} » (pièce n° {choisie[0]}), lignes {debut} à {fin} sur {len(lecture.lignes)} :"
    suite = f"\n… lignes {fin + 1} à {len(lecture.lignes)} : relis avec debut={fin + 1}." if fin < len(lecture.lignes) else ""
    return tete + "\n" + "\n".join(f"{debut + i}: {x[:400]}" for i, x in enumerate(morceau)) + suite
