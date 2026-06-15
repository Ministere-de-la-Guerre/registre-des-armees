"""Build the app icon: the Napoleonic eagle on the app's navy tile.

Eagle artwork: "Napoleonic Eagle" by Sodacan (Wikimedia Commons),
licensed CC BY-SA 3.0 — https://commons.wikimedia.org/wiki/File:Napoleonic_Eagle.svg
The eagle is unchanged; it is only composited onto a coloured rounded-square
background. See ICON_CREDIT.txt. This icon is therefore distributed CC BY-SA 3.0.
"""
from pathlib import Path
import urllib.request
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
SRC = OUT / "eagle_source.png"
NAVY, BORDER = (21, 34, 63, 255), (95, 90, 68, 255)
N = 1024
UA = "RegistreDesArmeesIconTool/1.0 (napoleonic army builder)"
THUMB = ("https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/"
         "Napoleonic_Eagle.svg/1280px-Napoleonic_Eagle.svg.png")

if not SRC.exists():
    req = urllib.request.Request(THUMB, headers={"User-Agent": UA})
    SRC.write_bytes(urllib.request.urlopen(req, timeout=30).read())

base = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(base)
d.rounded_rectangle([0, 0, N - 1, N - 1], 180, fill=NAVY)
d.rounded_rectangle([34, 34, N - 35, N - 35], 150, outline=BORDER, width=6)

eagle = Image.open(SRC).convert("RGBA")
box = 862
s = min(box / eagle.width, box / eagle.height)
eagle = eagle.resize((round(eagle.width * s), round(eagle.height * s)), Image.LANCZOS)
base.alpha_composite(eagle, ((N - eagle.width) // 2, (N - eagle.height) // 2))

base.save(OUT / "icon_1024.png")
for sz in (512, 256, 128):
    base.resize((sz, sz), Image.LANCZOS).save(OUT / f"icon_{sz}.png")
base.resize((256, 256), Image.LANCZOS).save(
    OUT / "icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("wrote icon_1024.png (+512/256/128) and icon.ico")
