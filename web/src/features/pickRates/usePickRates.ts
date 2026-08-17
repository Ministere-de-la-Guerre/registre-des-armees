/** Owns the pick-rate dataset for one builder session.
 *
 *  Nothing is fetched until the user turns the feature on, so a build that ships the
 *  data still costs nothing to anyone who never opens it. When PICK_RATES_ENABLED is
 *  false the hook is inert and no network call can happen at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PICK_RATES_ENABLED } from "./flag";
import { loadPickRateIndex, loadPickRateSeason, loadUnitDataVersion } from "./load";
import { cardPickRate, corpsPickRates, regimentRollup, rosterMatches } from "./pickRates";
import type { CorpsPickRates, PickRateIndex, PickRateSeason, RegimentRollup, UnitPickRate } from "./types";

const SEASON_STORAGE_KEY = "rda.pickRates.season";
const SHOW_STORAGE_KEY = "rda.pickRates.show";

export interface PickRatesApi {
  /** Whether the feature exists in this build AND a dataset was found. */
  available: boolean;
  show: boolean;
  setShow: (on: boolean) => void;
  loading: boolean;
  index: PickRateIndex | null;
  season: PickRateSeason | null;
  seasonId: string | null;
  setSeasonId: (id: string) => void;
  /** Resolved state for the corps currently open (null when off / not loaded). */
  corps: CorpsPickRates | null;
  /** What this card's medallion should show, honouring `combineVariants`. */
  rateOf: (unitKey: string, baseUnitKey: string) => UnitPickRate | null;
  /** True when combat-general tiles are hidden, so their builds are folded into the
   *  plain unit's number. Drives the wording in the details panel. */
  combineVariants: boolean;
  /** The regiment behind a card, across all its variants; null when unavailable. */
  regimentOf: (baseUnitKey: string) => RegimentRollup | null;
}

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the preference simply won't persist */
  }
};

export function usePickRates(factionKey: string, combineVariants = false): PickRatesApi {
  const [show, setShowState] = useState(() => PICK_RATES_ENABLED && readStored(SHOW_STORAGE_KEY) === "1");
  const [index, setIndex] = useState<PickRateIndex | null>(null);
  const [season, setSeason] = useState<PickRateSeason | null>(null);
  const [seasonId, setSeasonIdState] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [triedIndex, setTriedIndex] = useState(false);

  // Index + version stamp: fetched once, the first time the feature is switched on.
  useEffect(() => {
    if (!PICK_RATES_ENABLED || !show || triedIndex) return;
    setTriedIndex(true);
    setLoading(true);
    Promise.all([loadPickRateIndex(), loadUnitDataVersion()])
      .then(([idx, version]) => {
        setIndex(idx);
        setAppVersion(version);
        if (idx) {
          const stored = readStored(SEASON_STORAGE_KEY);
          const valid = idx.seasons.some((s) => s.id === stored) ? stored : idx.defaultSeason;
          setSeasonIdState(valid);
        }
      })
      .finally(() => setLoading(false));
  }, [show, triedIndex]);

  // Season payload: refetched whenever the chosen season changes.
  useEffect(() => {
    if (!PICK_RATES_ENABLED || !index || !seasonId) return;
    const summary = index.seasons.find((s) => s.id === seasonId);
    if (!summary) return;
    let cancelled = false;
    setLoading(true);
    loadPickRateSeason(summary)
      .then((data) => {
        if (!cancelled) setSeason(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [index, seasonId]);

  const setShow = useCallback((on: boolean) => {
    setShowState(on);
    writeStored(SHOW_STORAGE_KEY, on ? "1" : "0");
  }, []);

  const setSeasonId = useCallback((id: string) => {
    setSeasonIdState(id);
    writeStored(SEASON_STORAGE_KEY, id);
  }, []);

  const corps = useMemo(
    () => (show ? corpsPickRates(season, factionKey) : null),
    [show, season, factionKey],
  );
  const matches = useMemo(() => rosterMatches(season, appVersion), [season, appVersion]);
  const minSample = season?.thresholds.minSampleForPercent ?? 5;

  const rateOf = useCallback(
    (unitKey: string, baseUnitKey: string) =>
      show
        ? cardPickRate(corps, { unitKey, baseUnitKey }, {
            rosterMatches: matches,
            minSampleForPercent: minSample,
            combineVariants,
          })
        : null,
    [show, corps, matches, minSample, combineVariants],
  );

  const regimentOf = useCallback(
    (baseUnitKey: string) => (show ? regimentRollup(corps, baseUnitKey) : null),
    [show, corps],
  );

  return {
    available: PICK_RATES_ENABLED && (!triedIndex || index !== null),
    show,
    setShow,
    loading,
    index,
    season,
    seasonId,
    setSeasonId,
    corps,
    rateOf,
    regimentOf,
    combineVariants,
  };
}
