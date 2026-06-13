from __future__ import annotations

import json
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SOURCE_ROOT = PROJECT_ROOT / "source" / "original_game_command_star_assets" / "ui" / "frontend ui" / "skins"
OUTPUT_ROOT = PROJECT_ROOT / "assets" / "ui" / "command_stars"

SILVER_SOURCE = SOURCE_ROOT / "army_card_star.tga"
GOLD_SOURCE = SOURCE_ROOT / "spanish_skin" / "army_card_star.tga"

COMPACT_SIZE = (10, 10)
VERTICAL_STEP = 9
MAX_STARS = 9


def load_cropped(path: Path) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    alpha_bbox = image.getchannel("A").getbbox()
    if alpha_bbox is None:
        raise ValueError(f"Star asset has no visible pixels: {path}")
    return image.crop(alpha_bbox)


def main() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    vertical_dir = OUTPUT_ROOT / "vertical"
    vertical_dir.mkdir(parents=True, exist_ok=True)

    silver = load_cropped(SILVER_SOURCE)
    gold = load_cropped(GOLD_SOURCE)
    silver.save(OUTPUT_ROOT / "star_silver_original.png")
    gold.save(OUTPUT_ROOT / "star_gold_original.png")

    compact_silver = silver.resize(COMPACT_SIZE, Image.Resampling.LANCZOS)
    compact_gold = gold.resize(COMPACT_SIZE, Image.Resampling.LANCZOS)
    compact_silver.save(OUTPUT_ROOT / "star_silver.png")
    compact_gold.save(OUTPUT_ROOT / "star_gold.png")

    for count in range(1, MAX_STARS + 1):
        height = COMPACT_SIZE[1] + VERTICAL_STEP * (count - 1)
        strip = Image.new("RGBA", (COMPACT_SIZE[0], height), (0, 0, 0, 0))
        for index in range(count):
            strip.alpha_composite(compact_gold, (0, index * VERTICAL_STEP))
        strip.save(vertical_dir / f"command_stars_{count}.png")

    metadata = {
        "rating_source": "db/mp_general_command_ratings_tables/mp_general_command_ratings.command_stars",
        "original_pack": "Napoleon Total War/data/data.pack",
        "silver_internal_path": "ui/frontend ui/skins/army_card_star.tga",
        "gold_internal_path": "ui/frontend ui/skins/spanish_skin/army_card_star.tga",
        "preferred_app_asset": "assets/ui/command_stars/star_gold.png",
        "strip_pattern": "assets/ui/command_stars/vertical/command_stars_{command_stars}.png",
        "layout": "vertical_left",
        "compact_star_width": COMPACT_SIZE[0],
        "compact_star_height": COMPACT_SIZE[1],
        "vertical_step": VERTICAL_STEP,
        "supported_counts": list(range(1, MAX_STARS + 1)),
    }
    (OUTPUT_ROOT / "metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )

    print(f"Generated command-star assets in {OUTPUT_ROOT.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
