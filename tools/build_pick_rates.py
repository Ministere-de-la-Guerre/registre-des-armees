"""Turn the replay-corpus CSVs into the app-facing pick-rate dataset.

Reads reports/replay_stats/*.csv (written by the local replay-corpus analyzer) plus the
app's own corps index and data-version stamp, and writes a season index + one file per
season to data/pick_rates/ (committed), then publishes a copy into
web/public/data/pick-rates/ for the app to fetch.

Multi-season by construction: each run produces (or replaces) one season file and
re-writes the index, so building the next patch's dataset is another run with a
different --season-id. Nothing else changes.

    python3 tools/build_pick_rates.py --season-id season-10 --label "Season 10"

See docs/PICK_RATES.md for the schema and the absence states this file has to keep
distinguishable.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATS = ROOT / "reports" / "replay_stats"
PUBLIC = ROOT / "web" / "public" / "data"
#: Committed source artifact. The replay corpus itself is never in the repo, so the
#: derived season files ARE the source of truth for this feature and must be checked in
#: — build_web_data.py copies them into web/public/data/pick-rates/ at build time.
OUT_DIR = ROOT / "data" / "pick_rates"

#: Corps types this dataset speaks about. Custom Armies (non-ac/non-tow rosters) and TOW
#: are deliberately excluded for now; widening it is a data change, not a code change.
SCOPE = ["ac"]

#: Kept in parity with the buckets analyze_replays.py assigns, so the app and the CSVs
#: label a unit the same way.
THRESHOLDS = {"minSampleForPercent": 5, "autoInclude": 85, "contested": 25, "rare": 5}

#: `Napoleon: Total War 1.3.0 (Final Release; Build 2081 (Curator); …` -> "1.3.0 (Build 2081)"
BUILD_RE = re.compile(r"Total War\s+([\d.]+).*?Build\s+(\d+)")


def load(name: str) -> list[dict]:
    path = STATS / name
    if not path.exists() or not path.stat().st_size:
        return []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def corps_type(faction_key: str) -> str:
    """`ntw3_ac_b09_x4_163` -> 'ac'; `ntw3_tow_…` -> 'tow'; anything else -> 'custom'."""
    parts = faction_key.split("_")
    if len(parts) > 2 and parts[0] == "ntw3" and parts[1] in {"ac", "tow"}:
        return parts[1]
    return "custom"


def in_scope(faction_key: str) -> bool:
    return corps_type(faction_key) in SCOPE


def all_corps() -> dict[str, str]:
    """Every corps the app knows, factionKey -> display name, from the app's own index.

    Corps that were never played still have to appear in the season file (state 2, "in
    scope but no battles recorded"), and only the app index knows their names.
    """
    index = json.loads((PUBLIC / "corps-index.json").read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for side in index.get("sides", []):
        for theatre in side.get("theatres", []):
            for corps in theatre.get("corps", []):
                key = corps.get("factionKey", "")
                if key:
                    out[key] = corps.get("name", "")
    return out


def patch_label(battles: list[dict]) -> str:
    builds = {r["game_build"] for r in battles if r.get("game_build")}
    if len(builds) != 1:
        # More than one patch in one corpus makes the season's patch label a lie; say so
        # rather than silently picking one.
        return f"mixed ({len(builds)} game builds)"
    m = BUILD_RE.search(next(iter(builds)))
    return f"NTW3 {m.group(1)} (Build {m.group(2)})" if m else "unknown"


def build_season(season_id: str, label: str, recorded: str) -> dict:
    battles = load("battles.csv")
    armies = load("armies.csv")
    players = load("players.csv")
    popularity = load("corps_popularity.csv")
    names = all_corps()

    # appearances per corps, from the corpus
    appearances = {r["army_key"]: int(r["appearances"]) for r in popularity}
    distinct_players = {r["army_key"]: int(r["distinct_players"]) for r in popularity}

    corps: dict[str, dict] = {}
    skipped_out_of_scope = 0
    for key, name in sorted(names.items()):
        if not in_scope(key):
            skipped_out_of_scope += 1
            continue
        corps[key] = {"name": name, "n": appearances.get(key, 0)}
        if distinct_players.get(key):
            corps[key]["players"] = distinct_players[key]

    # Corps that appear in the corpus but not in the app index would otherwise vanish.
    for key in appearances:
        if in_scope(key) and key not in corps:
            corps[key] = {"name": "", "n": appearances[key], "players": distinct_players.get(key, 0)}

    # Rates are per EXACT unit key, not per regiment: the builder draws one medallion
    # per card, and "84e de ligne" and "Macdonald (Grenadiers du 84e)" are two different
    # picks that deserve two different numbers. A regiment-level rollup is emitted
    # alongside, for the details panel ("this regiment, across all its variants").
    #
    # Computed straight from the per-slot fact table so staff generals and every
    # commander variant are covered by the same code path.
    builds_with: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    copies: dict[str, Counter[str]] = defaultdict(Counter)
    reg_builds: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    reg_copies: dict[str, Counter[str]] = defaultdict(Counter)
    reg_officer_builds: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for row in load("army_units.csv"):
        key = row["army_key"]
        if not in_scope(key) or row["resolved"] != "True":
            continue
        battle, unit_key, base = row["battle_id"], row["unit_key"], row["base_unit_key"]
        builds_with[key][unit_key].add(battle)
        copies[key][unit_key] += 1
        reg_builds[key][base].add(battle)
        reg_copies[key][base] += 1
        if row["is_commander"] == "True":
            reg_officer_builds[key][base].add(battle)

    for key, per_unit in builds_with.items():
        if key not in corps:
            continue
        # Zero-pick cards are omitted; the reader infers "never picked" from the corps
        # having a sample plus a matching roster stamp.
        corps[key]["units"] = {
            unit_key: {"b": len(battles), "t": copies[key][unit_key]}
            for unit_key, battles in sorted(per_unit.items())
        }
        corps[key]["regiments"] = {
            base: {
                "b": len(battles),
                "t": reg_copies[key][base],
                "c": len(reg_officer_builds[key].get(base, ())),
            }
            for base, battles in sorted(reg_builds[key].items())
        }

    in_scope_armies = [r for r in armies if in_scope(r["army_key"])]
    return {
        "schemaVersion": 2,
        "id": season_id,
        "label": label,
        "patch": patch_label(battles),
        "corpus": {
            "battles": len({r["battle_id"] for r in in_scope_armies}),
            "armies": len(in_scope_armies),
            "players": len(players),
            "recorded": recorded,
        },
        "scope": {
            "corpsTypes": SCOPE,
            "note": "Army Corps only; Theatres-of-War and Custom Armies are not covered.",
        },
        "unitDataVersion": json.loads((PUBLIC / "data-version.json").read_text(encoding="utf-8")),
        "thresholds": THRESHOLDS,
        "corps": corps,
        "_skippedOutOfScope": skipped_out_of_scope,
    }


def write_index(seasons_dir: Path) -> dict:
    """Rebuild the index from whatever season files are present, newest label last."""
    seasons = []
    for path in sorted(seasons_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        with_data = sum(1 for c in data["corps"].values() if c["n"] > 0)
        seasons.append({
            "id": data["id"],
            "label": data["label"],
            "patch": data["patch"],
            "battles": data["corpus"]["battles"],
            "armies": data["corpus"]["armies"],
            "players": data["corpus"]["players"],
            "corpsWithData": with_data,
            "corpsInScope": len(data["corps"]),
            "recorded": data["corpus"]["recorded"],
            "file": path.name,
        })
    index = {
        "schemaVersion": 1,
        "defaultSeason": seasons[-1]["id"] if seasons else None,
        "seasons": seasons,
    }
    (seasons_dir / "index.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return index


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season-id", default="season-10", help="stable id, e.g. season-10")
    ap.add_argument("--label", default="Season 10", help="display label")
    ap.add_argument("--recorded", default="2026-08", help="when the replays were collected")
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--no-publish", dest="publish", action="store_false",
                    help="write only the committed source copy, not web/public")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    season = build_season(args.season_id, args.label, args.recorded)
    skipped = season.pop("_skippedOutOfScope")
    path = out_dir / f"{args.season_id}.json"
    path.write_text(json.dumps(season, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    with_data = sum(1 for c in season["corps"].values() if c["n"] > 0)
    unit_rows = sum(len(c.get("units", {})) for c in season["corps"].values())
    reg_rows = sum(len(c.get("regiments", {})) for c in season["corps"].values())
    print(f"{path.name}  {path.stat().st_size / 1024:.0f} KB")
    print(f"  patch          {season['patch']}")
    print(f"  corpus         {season['corpus']['battles']} battles, {season['corpus']['armies']} armies")
    print(f"  corps in scope {len(season['corps'])}  ({with_data} with data, "
          f"{len(season['corps']) - with_data} in scope but never played)")
    print(f"  out of scope   {skipped} corps (TOW / Custom Armies)")
    print(f"  card rows      {unit_rows} (exact unit keys)")
    print(f"  regiment rows  {reg_rows}")

    index = write_index(out_dir)
    print(f"index.json  {len(index['seasons'])} season(s), default {index['defaultSeason']}")

    # Publish the browser copy too. build_web_data.py does this as part of a full
    # rebuild, but that needs Pillow and takes minutes; a season update should not.
    if args.publish:
        published = PUBLIC / "pick-rates"
        published.mkdir(parents=True, exist_ok=True)
        for src in sorted(out_dir.glob("*.json")):
            shutil.copy2(src, published / src.name)
        print(f"published -> {published.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
