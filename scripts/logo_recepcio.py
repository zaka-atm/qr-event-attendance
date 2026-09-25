"""Descarrega el logo d'Entre Joves de Drive i en genera les icones de l'app de recepció.

S'executa a GitHub Actions abans de publicar (vegeu .github/workflows/demo-pages.yml):
  recepcio/icons/logo.png       el logo tal qual (es mostra dins de l'app)
  recepcio/icons/logo-32.png    favicon
  recepcio/icons/logo-180.png   icona d'iPhone
  recepcio/icons/logo-192.png   icona d'Android
  recepcio/icons/logo-512.png   icona d'Android (gran)
  recepcio/icons/logo-og.png    vista prèvia en compartir l'enllaç (WhatsApp, Telegram…), 1200×630

Si no es pot descarregar, deixa les icones per defecte i acaba sense error.
Ús: python3 scripts/logo_recepcio.py [fitxer_local_opcional]
"""
import io
import sys
import urllib.request
from pathlib import Path

from PIL import Image

ID = "1ysPCFM3gV7qLsTEhkTgAF6mnVWLuE4FK"
URLS = [
    f"https://drive.google.com/uc?export=download&id={ID}",
    f"https://drive.google.com/thumbnail?id={ID}&sz=w1600",
    f"https://lh3.googleusercontent.com/d/{ID}=w1600",
]
DIR = Path(__file__).resolve().parent.parent / "recepcio" / "icons"
FONS = (255, 255, 255)


def descarregar() -> Image.Image | None:
    for url in URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                dades = r.read()
            img = Image.open(io.BytesIO(dades))
            img.load()
            print(f"Logo descarregat de {url} ({img.width}×{img.height})")
            return img
        except Exception as e:  # noqa: BLE001 — provem la següent adreça
            print(f"No s'ha pogut fer servir {url}: {e}")
    return None


def sobre_fons(img: Image.Image) -> Image.Image:
    """Aplana la transparència sobre blanc."""
    img = img.convert("RGBA")
    fons = Image.new("RGBA", img.size, FONS + (255,))
    fons.alpha_composite(img)
    return fons.convert("RGB")


def encaixar(img: Image.Image, amplada: int, alcada: int, marge: float) -> Image.Image:
    """Redueix el logo perquè hi càpiga amb marge i el centra sobre fons blanc."""
    lienzo = Image.new("RGB", (amplada, alcada), FONS)
    maxw, maxh = int(amplada * (1 - 2 * marge)), int(alcada * (1 - 2 * marge))
    copia = img.copy()
    copia.thumbnail((maxw, maxh), Image.LANCZOS)
    lienzo.paste(copia, ((amplada - copia.width) // 2, (alcada - copia.height) // 2))
    return lienzo


def main() -> None:
    if len(sys.argv) > 1:
        img = Image.open(sys.argv[1])
        img.load()
    else:
        img = descarregar()
    if img is None:
        print("::warning::No s'ha pogut descarregar el logo: es mantenen les icones per defecte.")
        return

    DIR.mkdir(parents=True, exist_ok=True)
    img.save(DIR / "logo.png", optimize=True)
    pla = sobre_fons(img)
    for mida in (32, 180, 192, 512):
        encaixar(pla, mida, mida, 0.08).save(DIR / f"logo-{mida}.png", optimize=True)
    encaixar(pla, 1200, 630, 0.1).save(DIR / "logo-og.png", optimize=True)
    print("Icones generades a", DIR)


if __name__ == "__main__":
    main()
