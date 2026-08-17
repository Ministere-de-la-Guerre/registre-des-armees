/** Fetch the pick-rate dataset.
 *
 *  Same contract as data/load.ts: the JSON is treated as untrusted, so a missing or
 *  malformed file degrades to "no dataset" (the feature simply shows nothing) rather
 *  than throwing into the UI. That matters here because the payload is optional — a
 *  build with the feature enabled but no season staged must still run.
 */
import { dataUrl } from "../../data/assets";
import type { PickRateIndex, PickRateSeason, SeasonSummary } from "./types";

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(dataUrl(path), { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function normalizeSummary(raw: unknown): SeasonSummary | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const file = str(raw.file);
  if (!id || !file) return null;
  return {
    id,
    file,
    label: str(raw.label, id),
    patch: str(raw.patch),
    battles: num(raw.battles),
    armies: num(raw.armies),
    players: num(raw.players),
    corpsWithData: num(raw.corpsWithData),
    corpsInScope: num(raw.corpsInScope),
    recorded: str(raw.recorded),
  };
}

/** The season list, or null when no dataset is present in this build. */
export async function loadPickRateIndex(): Promise<PickRateIndex | null> {
  try {
    const raw = await getJson("pick-rates/index.json");
    if (!isObj(raw) || !Array.isArray(raw.seasons)) return null;
    const seasons = raw.seasons.map(normalizeSummary).filter((s): s is SeasonSummary => s !== null);
    if (!seasons.length) return null;
    const requested = typeof raw.defaultSeason === "string" ? raw.defaultSeason : null;
    return {
      schemaVersion: num(raw.schemaVersion, 1),
      // Never point at a season that isn't in the list.
      defaultSeason: seasons.some((s) => s.id === requested) ? requested : seasons[seasons.length - 1].id,
      seasons,
    };
  } catch {
    return null;
  }
}

export async function loadPickRateSeason(summary: SeasonSummary): Promise<PickRateSeason | null> {
  try {
    const raw = await getJson(`pick-rates/${summary.file}`);
    if (!isObj(raw) || !isObj(raw.corps)) return null;
    const thresholds = isObj(raw.thresholds) ? raw.thresholds : {};
    const scope = isObj(raw.scope) ? raw.scope : {};
    const corpus = isObj(raw.corpus) ? raw.corpus : {};
    return {
      schemaVersion: num(raw.schemaVersion, 1),
      id: str(raw.id, summary.id),
      label: str(raw.label, summary.label),
      patch: str(raw.patch, summary.patch),
      corpus: {
        battles: num(corpus.battles, summary.battles),
        armies: num(corpus.armies, summary.armies),
        players: num(corpus.players, summary.players),
        recorded: str(corpus.recorded, summary.recorded),
      },
      scope: {
        corpsTypes: Array.isArray(scope.corpsTypes) ? scope.corpsTypes.filter((t): t is string => typeof t === "string") : [],
        note: str(scope.note),
      },
      unitDataVersion: isObj(raw.unitDataVersion)
        ? Object.fromEntries(
            Object.entries(raw.unitDataVersion).filter((e): e is [string, number] => typeof e[1] === "number"),
          )
        : {},
      thresholds: {
        // A missing threshold must not become 0 — that would let a 1-build corps
        // print a percentage. Fall back to the documented defaults.
        minSampleForPercent: num(thresholds.minSampleForPercent, 5),
        autoInclude: num(thresholds.autoInclude, 85),
        contested: num(thresholds.contested, 25),
        rare: num(thresholds.rare, 5),
      },
      corps: raw.corps as PickRateSeason["corps"],
    };
  } catch {
    return null;
  }
}

/** The app's own unit-DB stamp, used to decide whether an absent unit means
 *  "never picked" or merely "newer than the corpus". */
export async function loadUnitDataVersion(): Promise<Record<string, number> | null> {
  try {
    const raw = await getJson("data-version.json");
    if (!isObj(raw)) return null;
    return Object.fromEntries(
      Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"),
    );
  } catch {
    return null;
  }
}
