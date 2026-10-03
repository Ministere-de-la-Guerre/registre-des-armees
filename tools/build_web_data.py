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
  * Re-runnable: PNG conversion / copies are skipped when already up to date, and
    anything under web/public/{data,assets} this run did not produce (e.g. files of
    a removed faction) is pruned, so the output always mirrors the current source.
  * Exits non-zero on fatal conditions (missing inputs, no factions produced).

Run from anywhere:  python tools/build_web_data.py
or via the app:      npm run build:data
"""

from __future__ import annotations

import csv
import hashlib
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
PICK_RATES_SRC = PROJECT_ROOT / "data" / "pick_rates"

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
        # Every web/public-relative path this run produced (written or up to date).
        self.produced: set[str] = set()

    def convert_tga_to_png(self, rel_tga: str) -> str | None:
        """Convert assets/.../x.tga -> web/public/assets/.../x.png. Returns rel png path."""
        src = PROJECT_ROOT / rel_tga
        rel_png = str(Path(rel_tga).with_suffix(".png")).replace("\\", "/")
        dst = WEB_PUBLIC / rel_png
        if not src.is_file():
            self.missing.append(rel_tga)
            return None
        self.produced.add(rel_png)
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
        self.produced.add(rel)
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


# --- output bookkeeping --------------------------------------------------------
def write_data_file(path: Path, payload: object, written: dict[str, bytes]) -> None:
    """Write compact JSON as exact bytes (platform-independent) and remember them."""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    written[path.relative_to(WEB_PUBLIC).as_posix()] = data


def content_hash(files: dict[str, bytes]) -> str:
    """sha256 hex identifying the runtime-cached data set.

    Files are fed in sorted web/public-relative path order; each contributes its
    UTF-8 path, a NUL byte, its length as 8 big-endian bytes, then its bytes as
    written — so renames, additions and removals all change the hash too.
    """
    digest = hashlib.sha256()
    for rel in sorted(files):
        data = files[rel]
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def prune_stale(root: Path, keep: set[str]) -> int:
    """Delete files under ``root`` whose web/public-relative path is not in
    ``keep`` (left over from a removed faction, icon, flag or season), then any
    directories that became empty. Returns the number of files removed."""
    if not root.is_dir():
        return 0
    removed = 0
    # Reverse lexicographic order visits a directory's contents before the directory.
    for path in sorted(root.rglob("*"), reverse=True):
        if path.is_dir() and not path.is_symlink():
            if not any(path.iterdir()):
                path.rmdir()
        elif path.relative_to(WEB_PUBLIC).as_posix() not in keep:
            path.unlink()
            removed += 1
    return removed


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
    division_brigade_code = _s(row, "division_brigade_code") or None
    if _is_tow_faction(faction_key):
        # A TOW corps ignores the ACDV division/brigade tags — the web layer lays
        # it out as one long list of arm/class brigades (docs/TOW_ARMY_BUILDS.md
        # §3/§5). Dropping placement also keeps the AC-only Division/Brigade filter
        # chips out of the TOW filter panel and earns no (TOW-forbidden) discounts.
        division = None
        brigade = None
        division_brigade_code = None

    icon_src = _s(row, "icon_path")
    icon = assets.convert_tga_to_png(icon_src) if icon_src else None

    star_strip = assets.copy_asset(_s(row, "command_star_strip_path"))
    badge = assets.copy_asset(_s(row, "guerrilla_badge_path")) if _bool(_s(row, "has_guerrilla_deployment")) else None

    guns = _int_or_none(_s(row, "guns"))
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
        "divisionBrigadeCode": division_brigade_code,
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
        # Set only for batteries (and the combat generals leading them); the CSV
        # leaves guns blank for everything else.
        "guns": guns,
        "gunType": (_s(row, "weapon_key") or None) if guns is not None else None,
        "placementSource": _s(row, "placement_source") or None,
        "icon": icon,
        "commandStarStrip": star_strip,
        "guerrillaBadge": badge,
        "stats": {
            "accuracy": _int_or_none(_s(row, "accuracy")),
            "reloadSkill": _int_or_none(_s(row, "reload_skill")),
            "ammo": _int_or_none(_s(row, "ammo")),
            # Display name of the small arm the unit fires (None for artillery / melee).
            "firearm": _s(row, "firearm") or None,
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


def fatal(message: str) -> int:
    print(f"ERROR: {message}", file=sys.stderr)
    return 1


def main() -> int:
    for required in (UNITS_CSV, CATALOG_JSON):
        if not required.is_file():
            return fatal(f"missing required input {required}")

    OUT_DATA.mkdir(parents=True, exist_ok=True)

    assets = AssetCopier()
    errors: list[str] = []
    # web/public-relative path -> bytes of every data file the client runtime-caches.
    cached_data: dict[str, bytes] = {}
    # Every other web/public/data file this run produced (kept by the prune step).
    other_data: set[str] = set()

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
    if not by_faction:
        return fatal(f"no faction rosters could be built from {UNITS_CSV}")

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
        write_data_file(OUT_DATA / "factions" / f"{faction_key}.json", {
            "schemaVersion": SCHEMA_VERSION,
            "factionKey": faction_key,
            "armyCorpsName": cards[0].get("armyCorpsName", ""),
            "cards": cards,
        }, cached_data)

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

    if listed == 0:
        return fatal(f"the corps index lists no corps (check {CATALOG_JSON})")
    indexed = {
        corps["factionKey"]
        for side in index_sides for theatre in side["theatres"] for corps in theatre["corps"]
    }
    unrostered = sorted(indexed - set(by_faction))
    unindexed = sorted(set(by_faction) - indexed)

    write_data_file(
        OUT_DATA / "corps-index.json",
        {"schemaVersion": SCHEMA_VERSION, "sides": index_sides}, cached_data,
    )

    # 4. Copy shared UI assets (command-star strips + the guerrilla badge).
    for n in range(1, 10):
        assets.copy_asset(f"assets/ui/command_stars/vertical/command_stars_{n}.png")
    assets.copy_asset("assets/ui/command_stars/star_gold.png")
    assets.copy_asset("assets/ui/command_stars/star_silver.png")
    assets.copy_asset("assets/ui/guerrilla_badge/guerrilla_badge.png")

    # 5. Version manifest. contentHash changes whenever any runtime-cached data
    #    file does (even when every count stays the same), keying the PWA caches.
    (OUT_DATA / "data-version.json").write_bytes(json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "factionCount": len(by_faction),
        "corpsListed": listed,
        "totalSourceRows": total_rows,
        "towRows": tow_rows,
        "contentHash": content_hash(cached_data),
    }, ensure_ascii=False, indent=2).encode("utf-8"))
    other_data.add("data/data-version.json")

    # 5b. Pick-rate datasets (optional feature data; see docs/PICK_RATES.md).
    # These are a committed source artifact rather than something derived here — the
    # replay corpus they come from is never in the repo — so this step is a straight
    # copy, and silently does nothing when no season has been built.
    pick_rates_copied = 0
    if PICK_RATES_SRC.is_dir():
        out_pick_rates = OUT_DATA / "pick-rates"
        out_pick_rates.mkdir(parents=True, exist_ok=True)
        for season_file in sorted(PICK_RATES_SRC.glob("*.json")):
            shutil.copy2(season_file, out_pick_rates / season_file.name)
            other_data.add(f"data/pick-rates/{season_file.name}")
            pick_rates_copied += 1

    # 5c. Drop anything a previous run left behind (removed factions, icons,
    #     flags, seasons) so local/desktop builds never ship stale files.
    other_data.add("data/build-report.txt")
    pruned = prune_stale(OUT_DATA, set(cached_data) | other_data)
    pruned += prune_stale(OUT_ASSETS, assets.produced)

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
        f"pick_rate_seasons={pick_rates_copied}",
        f"stale_files_pruned={pruned}",
        f"indexed_corps_without_roster={len(unrostered)}",
        f"rosters_not_in_index={len(unindexed)}",
    ]
    if unrostered:
        lines.append("--- indexed corps without a roster (first 20) ---")
        lines += unrostered[:20]
    if unindexed:
        lines.append("--- rosters not in the corps index (first 20) ---")
        lines += unindexed[:20]
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
