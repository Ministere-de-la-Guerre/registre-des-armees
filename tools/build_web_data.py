"""Build browser-friendly normalized JSON + PNG assets for the web army builder.

This is the *raw data import / adapter* layer of the app's data architecture. It
reads the existing source-of-truth files in the repository root:

  - data/generated/ntw3_army_builder_units.csv   (all allowed unit + army-corps combinations)
  - data/generated/army_corps_catalog.json       (theatre-grouped corps index with flags)

and produces, under ``web/public/``:

  - data/data-version.json        (schema + build version + counts)
  - data/corps-index.json         (theatre-grouped, incl. Theatres of War)
  - data/factions/<faction>.json  (one normalized roster per selectable corps)
  - assets/icons/**/*.png         (unit icons converted from .tga)
  - assets/army_corps_by_theatre/**/flag.png + post_selection_flag.png (copied)
  - assets/ui/**                  (command stars + guerrilla badge, copied)

Design goals (see README "Data refresh"):
  * Unknown CSV columns are ignored, never fatal.
  * Malformed *required* data is collected into a validation report rather than
    crashing the whole build.
  * ToW factions and unit variants are included; a TOW corps drops its (inert)
    ACDV division/brigade tags so the web layer lays it out as one long list.
  * Re-runnable: PNG conversion / copies are skipped when already up to date.

Run from anywhere:  python tools/build_web_data.py
or via the app:      npm run build:data
"""

from __future__ import annotations

import csv
import json
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    print("Pillow is required: python -m pip install Pillow", file=sys.stderr)
    raise

# --- Schema / versioning -------------------------------------------------------
# Bump SCHEMA_VERSION when the *shape* of the normalized JSON changes so the app
# can refuse or migrate stale generated data.
SCHEMA_VERSION = 1

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GENERATED_DATA = PROJECT_ROOT / "data" / "generated"
UNITS_CSV = GENERATED_DATA / "ntw3_army_builder_units.csv"
CATALOG_JSON = GENERATED_DATA / "army_corps_catalog.json"
WEB_PUBLIC = PROJECT_ROOT / "web" / "public"
OUT_DATA = WEB_PUBLIC / "data"
OUT_ASSETS = WEB_PUBLIC / "assets"

COMMANDER_SUFFIX = "_com_"


# --- small parsing helpers -----------------------------------------------------
def _s(row: dict, key: str) -> str:
    return (row.get(key) or "").strip()


def _int_or_none(value: str):
    value = (value or "").strip()
    if value == "":
        return None
    try:
        return int(value)
    except ValueError:
        try:
            f = float(value)
        except ValueError:
            return None
        return int(f) if f.is_integer() else f


def _bool(value: str) -> bool:
    return (value or "").strip().casefold() == "true"


def _is_tow_faction(faction_key: str) -> bool:
    return faction_key.startswith("ntw3_tow_")


def cap_group_key(unit_key: str) -> str:
    """Underlying unit key used for shared cap accounting (strip _com_<digits>)."""
    idx = unit_key.rfind(COMMANDER_SUFFIX)
    if idx == -1:
        return unit_key
    tail = unit_key[idx + len(COMMANDER_SUFFIX):]
    return unit_key[:idx] if tail.isdigit() else unit_key


def classify_general(is_general: bool, men_raw):
    """Mirror tools/army_builder_rules.classify_general for precomputed display."""
    if not is_general:
        return None
    if men_raw in (32, 122):
        return "staff"
    return "combat"


def final_men_count(is_general: bool, unit_key: str, men_display):
    """Mirror UnitCard.final_men_count: staff generals always show 16."""
    if is_general and "_gen_staff_" in unit_key:
        return 16
    return men_display


# --- icon / asset conversion ---------------------------------------------------
class AssetCopier:
    def __init__(self) -> None:
        self.converted = 0
        self.copied = 0
        self.skipped = 0
        self.missing: list[str] = []

    def convert_tga_to_png(self, rel_tga: str) -> str | None:
        """Convert assets/.../x.tga -> web/public/assets/.../x.png. Returns rel png path."""
        src = PROJECT_ROOT / rel_tga
        rel_png = str(Path(rel_tga).with_suffix(".png")).replace("\\", "/")
        dst = WEB_PUBLIC / rel_png
        if not src.is_file():
            self.missing.append(rel_tga)
            return None
        if dst.is_file() and dst.stat().st_mtime >= src.stat().st_mtime:
            self.skipped += 1
            return rel_png
        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im.convert("RGBA").save(dst, "PNG")
        self.converted += 1
        return rel_png

    def copy_asset(self, rel_path: str, white_key: bool = False) -> str | None:
        """Copy an already-browser-friendly asset (png) into web/public/.

        When ``white_key`` is set, near-white pixels connected to the image border
        are flooded to transparent (a reproducible, narrowly-scoped conversion for
        source flags that use white as a transparency key). It preserves interior
        white details because only the border-connected background is keyed.
        """
        if not rel_path:
            return None
        src = PROJECT_ROOT / rel_path
        rel = rel_path.replace("\\", "/")
        dst = WEB_PUBLIC / rel
        if not src.is_file():
            self.missing.append(rel_path)
            return None
        if dst.is_file() and dst.stat().st_mtime >= src.stat().st_mtime:
            self.skipped += 1
            return rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if white_key:
            _flood_white_to_transparent(src, dst)
        else:
            shutil.copy2(src, dst)
        self.copied += 1
        return rel


# Flags whose *source* uses an opaque white background as a transparency key.
# Investigation (reports/_flag_debug.png) showed Denmark, Mamluk (Mourad) and
# Nauendorf already ship correct alpha — their previously-"white" look came from a
# white CSS backdrop, now fixed. This set is therefore intentionally empty; add a
# faction_key here only if a genuinely white-keyed flag is ever imported.
FLAG_WHITE_KEY_FACTIONS: set[str] = set()


def _flood_white_to_transparent(src: Path, dst: Path, threshold: int = 240) -> None:
    """Make border-connected near-white pixels transparent; keep interior white."""
    from collections import deque

    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size

    def is_white(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 0 and r >= threshold and g >= threshold and b >= threshold

    seen = [[False] * w for _ in range(h)]
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_white(x, y):
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_white(x, y):
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        if seen[y][x] or not is_white(x, y):
            continue
        seen[y][x] = True
        px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx]:
                queue.append((nx, ny))
    im.save(dst, "PNG")


# --- normalization -------------------------------------------------------------
def normalize_unit(row: dict, assets: AssetCopier, errors: list[str]) -> dict | None:
    unit_key = _s(row, "unit_key")
    faction_key = _s(row, "faction_key")
    if not unit_key or not faction_key:
        errors.append(f"row missing unit_key/faction_key: {row.get('unit_key')!r}")
        return None

    unit_class = _s(row, "unit_class")
    is_general = _bool(_s(row, "is_general"))
    men_raw = _int_or_none(_s(row, "men_raw"))
    men_display = _int_or_none(_s(row, "men_display"))

    # required numeric fields for the rules engine
    cost = _int_or_none(_s(row, "base_mp_cost"))
    cap = _int_or_none(_s(row, "unit_cap"))
    if cost is None or cap is None:
        errors.append(f"{faction_key}/{unit_key}: missing base_mp_cost or unit_cap")
        return None

    division = _int_or_none(_s(row, "division_id"))
    brigade = _int_or_none(_s(row, "brigade_id"))
    if _is_tow_faction(faction_key):
        # A TOW corps ignores the ACDV division/brigade tags — the web layer lays
        # it out as one long list of arm/class brigades (docs/TOW_ARMY_BUILDS.md
        # §3/§5). Dropping placement also keeps the AC-only Division/Brigade filter
        # chips out of the TOW filter panel and earns no (TOW-forbidden) discounts.
        division = None
        brigade = None

    icon_src = _s(row, "icon_path")
    icon = assets.convert_tga_to_png(icon_src) if icon_src else None

    star_strip = assets.copy_asset(_s(row, "command_star_strip_path"))
    badge = assets.copy_asset(_s(row, "guerrilla_badge_path")) if _bool(_s(row, "has_guerrilla_deployment")) else None

    return {
        "unitKey": unit_key,
        "factionKey": faction_key,
        "armyCorpsName": _s(row, "army_corps_name"),
        "name": _s(row, "unit_name"),
        "unitClass": unit_class,
        "menRaw": men_raw,
        "menDisplay": men_display,
        "finalMen": final_men_count(is_general, unit_key, men_display),
        "speedCode": _s(row, "speed_code") or None,
        "division": division,
        "brigade": brigade,
        "divisionBrigadeCode": _s(row, "division_brigade_code") or None,
        "cost": cost,
        "cap": cap,
        "range": _int_or_none(_s(row, "range")),
        "commandStars": _int_or_none(_s(row, "command_stars")),
        "isGeneral": is_general,
        "isCommanderVariant": _bool(_s(row, "is_commander_variant")),
        "generalKind": classify_general(is_general, men_raw),
        "capGroupKey": cap_group_key(unit_key),
        "baseUnitKey": cap_group_key(unit_key),
        # groupCap + underlyingUnitClass are filled in a second pass once the
        # whole faction (and each base unit) is known.
        "groupCap": cap,
        "underlyingUnitClass": unit_class,
        "placementSource": _s(row, "placement_source") or None,
        "icon": icon,
        "commandStarStrip": star_strip,
        "guerrillaBadge": badge,
        "stats": {
            "accuracy": _int_or_none(_s(row, "accuracy")),
            "reloadSkill": _int_or_none(_s(row, "reload_skill")),
            "morale": _int_or_none(_s(row, "morale")),
            "meleeAttack": _int_or_none(_s(row, "melee_attack")),
            "meleeDefense": _int_or_none(_s(row, "melee_defense")),
            "chargeBonus": _int_or_none(_s(row, "charge_bonus")),
        },
        "abilities": {
            "canFormSquare": _bool(_s(row, "can_form_square")),
            "hasStamina": _bool(_s(row, "has_stamina")),
            "isShockResistant": _bool(_s(row, "is_shock_resistant")),
            "canInspire": _bool(_s(row, "can_inspire")),
            "hasGuerrillaDeployment": _bool(_s(row, "has_guerrilla_deployment")),
            "canPlaceStakes": _bool(_s(row, "can_place_stakes")),
            "canPlaceMines": _bool(_s(row, "can_place_mines")),
            "scaresEnemies": _bool(_s(row, "scares_enemies")),
            "canBuildBarricades": _bool(_s(row, "can_build_barricades")),
        },
    }


def main() -> int:
    assert UNITS_CSV.is_file(), f"missing {UNITS_CSV}"
    assert CATALOG_JSON.is_file(), f"missing {CATALOG_JSON}"

    OUT_DATA.mkdir(parents=True, exist_ok=True)
    (OUT_DATA / "factions").mkdir(parents=True, exist_ok=True)

    assets = AssetCopier()
    errors: list[str] = []

    # 1. Load + normalize units, grouped by faction (Theatres of War included).
    by_faction: dict[str, list[dict]] = {}
    total_rows = 0
    tow_rows = 0
    with UNITS_CSV.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            total_rows += 1
            faction_key = _s(row, "faction_key")
            if _is_tow_faction(faction_key) or _bool(_s(row, "is_tow_variant")):
                tow_rows += 1
            card = normalize_unit(row, assets, errors)
            if card is None:
                continue
            by_faction.setdefault(faction_key, []).append(card)

    # 2. Resolve the shared cap group cap = the underlying (base) unit's cap, so
    #    a commander variant counts against its base unit's cap (README), rather
    #    than the minimum across the group.
    for cards in by_faction.values():
        base_cap = {c["capGroupKey"]: c["cap"] for c in cards if c["unitKey"] == c["capGroupKey"]}
        base_class = {
            c["capGroupKey"]: c["unitClass"]
            for c in cards
            if c["unitKey"] == c["capGroupKey"] and c["unitClass"] != "general"
        }
        for c in cards:
            c["groupCap"] = base_cap.get(c["capGroupKey"], c["cap"])
            # Combat generals (commander variants) take their base unit's class so
            # class-specific filters and ordering treat them like the real unit.
            c["underlyingUnitClass"] = base_class.get(c["capGroupKey"], c["unitClass"])

    # 3. Write one roster file per faction.
    for faction_key, cards in by_faction.items():
        # Compact division numbers to sequential display order (I, II, III, ...).
        # The raw ACDV tag numbers have gaps because a corps recruits only a subset of
        # the game's global divisions (e.g. Ney 1812 uses 1, 2, 3, 6 + a support div, so
        # the cavalry's raw "6" displays in-game as Division 4). Remapping is a per-corps
        # bijection, so discount grouping is unchanged; only the visible label moves.
        present = sorted({c["division"] for c in cards if c["division"] is not None})
        # Division 0 is the reserve/support division: the in-game builder lists it
        # after every combat division, so it sorts last despite its low raw number.
        ordered = [d for d in present if d != 0] + [d for d in present if d == 0]
        remap = {raw: i + 1 for i, raw in enumerate(ordered)}
        for c in cards:
            if c["division"] is not None:
                c["division"] = remap[c["division"]]
                if c["brigade"] is not None:
                    c["divisionBrigadeCode"] = f"ACDV{c['division']}B{c['brigade']}"
        # Stamp the source roster order (CSV row order within the faction) BEFORE the
        # display sort below. The in-game combat-general rotation shuffles the faction's
        # general pool in this order, so the rotation predictor (web/src/state/rotation.ts)
        # must reproduce it; the display sort would otherwise destroy it.
        for i, c in enumerate(cards):
            c["rosterIndex"] = i
        cards.sort(key=lambda c: (
            c["division"] if c["division"] is not None else 9999,
            c["brigade"] if c["brigade"] is not None else 9999,
            c["unitClass"],
            c["name"],
            c["unitKey"],
        ))
        out = OUT_DATA / "factions" / f"{faction_key}.json"
        out.write_text(json.dumps({
            "schemaVersion": SCHEMA_VERSION,
            "factionKey": faction_key,
            "armyCorpsName": cards[0].get("armyCorpsName", ""),
            "cards": cards,
        }, ensure_ascii=False), encoding="utf-8")

    # 3. Build the theatre-grouped corps index from the catalog. Theatres of War
    #    are split into Imperial and Coalition sides; TOW corps are not AC, so
    #    isArmyCorps is False.
    catalog = json.loads(CATALOG_JSON.read_text(encoding="utf-8"))
    index_sides: list[dict] = []
    listed = 0
    for side, theatres in catalog.items():
        side_theatres = []
        for theatre_name, corps_list in theatres.items():
            entries = []
            for corps in corps_list:
                fk = corps.get("faction_key", "")
                wk = fk in FLAG_WHITE_KEY_FACTIONS
                flag = assets.copy_asset(corps.get("flag_png_path", ""), white_key=wk) or None
                post_flag = assets.copy_asset(corps.get("post_selection_flag_png_path", ""), white_key=wk) or None
                entries.append({
                    "factionKey": fk,
                    "name": corps.get("army_corps_name", fk),
                    "displayYear": corps.get("display_year", ""),
                    "displayRating": corps.get("display_rating", ""),
                    "order": corps.get("theatre_display_order", 0),
                    "flag": flag,
                    "postSelectionFlag": post_flag,
                    "isArmyCorps": "_ac_" in fk,
                    "cardCount": len(by_faction.get(fk, [])),
                })
                listed += 1
            if entries:
                entries.sort(key=lambda e: e["order"])
                side_theatres.append({"theatre": theatre_name, "corps": entries})
        if side_theatres:
            index_sides.append({"side": side, "theatres": side_theatres})

    (OUT_DATA / "corps-index.json").write_text(
        json.dumps({"schemaVersion": SCHEMA_VERSION, "sides": index_sides}, ensure_ascii=False),
        encoding="utf-8",
    )

    # 4. Copy shared UI assets (command-star strips + the guerrilla badge).
    for n in range(1, 10):
        assets.copy_asset(f"assets/ui/command_stars/vertical/command_stars_{n}.png")
    assets.copy_asset("assets/ui/command_stars/star_gold.png")
    assets.copy_asset("assets/ui/command_stars/star_silver.png")
    assets.copy_asset("assets/ui/guerrilla_badge/guerrilla_badge.png")

    # 5. Version manifest.
    (OUT_DATA / "data-version.json").write_text(json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "factionCount": len(by_faction),
        "corpsListed": listed,
        "totalSourceRows": total_rows,
        "towRows": tow_rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # 6. Validation report.
    report = OUT_DATA / "build-report.txt"
    lines = [
        f"schema_version={SCHEMA_VERSION}",
        f"source_rows={total_rows}",
        f"tow_rows_included={tow_rows}",
        f"factions={len(by_faction)}",
        f"corps_listed={listed}",
        f"icons_converted={assets.converted}",
        f"assets_copied={assets.copied}",
        f"assets_skipped_up_to_date={assets.skipped}",
        f"missing_assets={len(assets.missing)}",
        f"validation_errors={len(errors)}",
    ]
    if assets.missing:
        lines.append("--- missing assets (first 20) ---")
        lines += assets.missing[:20]
    if errors:
        lines.append("--- validation errors (first 20) ---")
        lines += errors[:20]
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print("\n".join(lines))
    print(f"\nWrote: {OUT_DATA}")
    if errors:
        print(f"WARNING: {len(errors)} validation errors (see {report})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
