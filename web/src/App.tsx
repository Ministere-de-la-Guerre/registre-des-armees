import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Builder } from "./components/Builder";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { CorpsSelect, type CorpsUiState } from "./components/CorpsSelect";
import { FactionOfflineButton } from "./components/FactionOfflineButton";
import { OfflinePanel } from "./components/OfflinePanel";
import { PlannerScreen } from "./components/PlannerScreen";
import { ReplayScreen } from "./components/ReplayScreen";
import { UpdateToast } from "./components/UpdateToast";
import { usePlanRosters } from "./components/usePlanRosters";
import { loadCorpsIndex, loadFaction } from "./data/load";
import { applyUpdate, isWebTarget, registerPwa } from "./pwa";
import { isCoarsePointer, isTabletTouch, useCoarsePointer } from "./components/useCoarsePointer";
import type { CorpsEntry, CorpsIndex, FactionRoster } from "./domain/types";
import { type CurrentPlan, emptyPlan, isPlanEmpty, loadCurrentPlan, saveCurrentPlan, setSlotBuild } from "./state/plan";
import { slotBuildFromCurrent } from "./state/planSync";
import type { CurrentBuild, SavedBuild } from "./state/saves";
import { type ReplaySession, emptyReplaySession } from "./state/replayBuild";

export default function App() {
  return (
    <ConfirmProvider>
      <AppBody />
    </ConfirmProvider>
  );
}

function AppBody() {
  const [index, setIndex] = useState<CorpsIndex | null>(null);
  const [selected, setSelected] = useState<CorpsEntry | null>(null);
  const [roster, setRoster] = useState<FactionRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  // Corps-selection state persists across builder visits (scroll + filters).
  const [corpsUi, setCorpsUi] = useState<CorpsUiState>({ search: "", side: "all", acOnly: false, towOnly: false });
  const corpsScroll = useRef(0);
  // Which entry screen is showing behind the builder: the corps picker, the replay
  // build checker or the Ordre de Bataille planner. `pendingSaved` seeds the builder
  // when an army is opened from a replay or a plan slot; `returnTo` sends Back to the
  // screen that opened it.
  const [screen, setScreen] = useState<"corps" | "replay" | "planner">("corps");
  const [pendingSaved, setPendingSaved] = useState<SavedBuild | null>(null);
  const [returnTo, setReturnTo] = useState<"corps" | "replay" | "planner">("corps");
  // The plan slot the open builder is bound to; null for a builder opened the ordinary way.
  const [builderSlotId, setBuilderSlotId] = useState<string | null>(null);
  // The loaded replay lives here, not in ReplayScreen, so visiting the builder
  // (which unmounts that screen) does not discard the parsed file.
  const [replaySession, setReplaySession] = useState<ReplaySession>(emptyReplaySession);
  // Likewise the working plan, restored from the last session. Autosaved below.
  const [currentPlan, setCurrentPlan] = useState<CurrentPlan>(
    () => loadCurrentPlan() ?? { plan: emptyPlan(), loadedPlanId: null },
  );
  const restoredPlan = useRef(currentPlan);

  // PWA plumbing (web target only; a no-op inside the Electron desktop app).
  // "waiting": a new version is ready to apply. "elsewhere": another tab applied
  // it, so this tab is still on the old code and should reload when convenient.
  const [pendingUpdate, setPendingUpdate] = useState<"waiting" | "elsewhere" | null>(null);
  const [showOffline, setShowOffline] = useState(false);
  const web = isWebTarget();

  // Touch-only collapsible chrome: a chevron tab hides the top bars (brand +
  // faction controls) so the unit grid can own the viewport, then re-expands them.
  // Never rendered on desktop / Electron (fine pointer). Defaults to collapsed in
  // short landscape (where the bars otherwise eat the screen), expanded in portrait.
  const coarse = useCoarsePointer();
  // iPads report a fine pointer (see isTabletTouch), so `coarse` misses them. This
  // flag is stable per session and only extends the touch header-scroller to iPad;
  // the rest of the mobile chrome deliberately still keys off `coarse`.
  const tabletTouch = useMemo(() => isTabletTouch(), []);
  const [chromeCollapsed, setChromeCollapsed] = useState(
    () => isCoarsePointer() && window.matchMedia("(orientation: landscape) and (max-height: 500px)").matches,
  );

  useEffect(() => {
    loadCorpsIndex()
      .then(setIndex)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    registerPwa({
      onNeedRefresh: () => setPendingUpdate("waiting"),
      onUpdatedElsewhere: () => setPendingUpdate("elsewhere"),
    });
  }, []);

  // factionKey → display name, for the offline panel's downloaded-factions list.
  const factionName = useMemo(() => {
    const map = new Map<string, string>();
    for (const side of index?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) map.set(corps.factionKey, corps.name);
    return (key: string) => map.get(key) ?? key;
  }, [index]);

  // Every distinct faction key in the corps picker — the set the "Download all"
  // offline action loops over.
  const allFactionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const side of index?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) keys.add(corps.factionKey);
    return [...keys];
  }, [index]);

  // Autosave the working plan on every edit (including those flowing back from the
  // builder). Skipped until something changed, so merely visiting the app never
  // writes a plan for someone who doesn't use the planner.
  useEffect(() => {
    if (currentPlan !== restoredPlan.current) saveCurrentPlan(currentPlan);
  }, [currentPlan]);

  // Rosters for the corps in the plan, cached here so they survive visits to the
  // builder. Loaded only while the planner is showing.
  const planFactionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const slot of currentPlan.plan.slots) if (slot.build) keys.add(slot.build.factionKey);
    return [...keys];
  }, [currentPlan.plan.slots]);
  const planRosters = usePlanRosters(planFactionKeys, screen === "planner" && !selected);

  // Bumped per openCorps/back so a slow load that finishes after the user has
  // moved on (Back, or Retry) can't install a roster for the wrong corps.
  const rosterRequest = useRef(0);

  const openCorps = (entry: CorpsEntry, saved: SavedBuild | null = null) => {
    const request = ++rosterRequest.current;
    setSelected(entry);
    setRoster(null);
    setError(null);
    setPendingSaved(saved);
    setLoadingRoster(true);
    loadFaction(entry.factionKey)
      .then((r) => request === rosterRequest.current && setRoster(r))
      .catch((e) => request === rosterRequest.current && setError(String(e)))
      .finally(() => request === rosterRequest.current && setLoadingRoster(false));
  };

  /** Open one army out of a replay in the full builder, then come back here. */
  const openFromReplay = (entry: CorpsEntry, saved: SavedBuild) => {
    setReturnTo("replay");
    openCorps(entry, saved);
  };

  /** Open a plan slot's army in the builder; its edits flow back into the slot and
   *  Back returns to the planner. */
  const openFromPlanner = (slotId: string, entry: CorpsEntry, saved: SavedBuild | null) => {
    setReturnTo("planner");
    setBuilderSlotId(slotId);
    openCorps(entry, saved);
  };

  const onSlotBuildChange = useCallback(
    (build: CurrentBuild) => {
      if (!builderSlotId) return;
      setCurrentPlan((cp) => {
        const slot = cp.plan.slots.find((s) => s.id === builderSlotId);
        return slot ? { ...cp, plan: setSlotBuild(cp.plan, slot.id, slotBuildFromCurrent(slot.build, build)) } : cp;
      });
    },
    [builderSlotId],
  );
  const builderSlotNumber = currentPlan.plan.slots.findIndex((s) => s.id === builderSlotId) + 1;

  const back = () => {
    rosterRequest.current++;
    setSelected(null);
    setRoster(null);
    setError(null);
    setLoadingRoster(false);
    setPendingSaved(null);
    setScreen(returnTo);
    setReturnTo("corps");
    setBuilderSlotId(null);
  };

  const builderActive = !!(selected && roster);
  const collapsed = coarse && builderActive && chromeCollapsed;

  return (
    <div className={`app${collapsed ? " chrome-collapsed" : ""}${tabletTouch ? " tablet-touch" : ""}`}>
      {coarse && builderActive && (
        <button
          type="button"
          className="chrome-toggle"
          aria-expanded={!chromeCollapsed}
          aria-label={chromeCollapsed ? "Show controls" : "Hide controls"}
          onClick={() => setChromeCollapsed((c) => !c)}
        >
          {chromeCollapsed ? "▾ Controls" : "▴ Hide"}
        </button>
      )}
      <div className="topbar">
        <span className="brand">⚜ Registre des Armées</span>
        <span className="topbar-sub" style={{ fontSize: 12, opacity: 0.8 }}>NTW3 Army Builder</span>
        <span className="spacer" />
        {selected && <span style={{ fontSize: 12, opacity: 0.85 }}>{selected.name}</span>}
        {!selected && screen === "corps" && (
          <>
            <button
              className="btn ghost small"
              onClick={() => setScreen("planner")}
              title="Plan up to four armies as a team"
            >
              ⚑ Ordre de Bataille <span className="tag beta">Beta</span>
            </button>
            <button
              className="btn ghost small"
              onClick={() => setScreen("replay")}
              title="Read army builds from a replay"
            >
              ⛊ Replay builds
            </button>
          </>
        )}
        {web && roster && <FactionOfflineButton roster={roster} />}
        {web && (
          <button className="btn ghost small" onClick={() => setShowOffline(true)} title="Offline & storage">
            ⤓ Offline
          </button>
        )}
      </div>

      {error && (
        <div className="error-box">
          ⚠ {error}
          {/* A failed faction load leaves no builder and no picker on screen, so
              the way out has to live here. */}
          {selected && !roster && (
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14 }}>
              <button className="btn small" onClick={() => openCorps(selected, pendingSaved)}>
                Retry
              </button>
              <button className="btn ghost small" onClick={back}>
                ← Back
              </button>
            </div>
          )}
        </div>
      )}

      {!selected && screen === "replay" && (
        <ReplayScreen
          corpsIndex={index}
          session={replaySession}
          onSessionChange={setReplaySession}
          onBack={() => setScreen("corps")}
          onOpenInBuilder={openFromReplay}
          planIsEmpty={isPlanEmpty(currentPlan.plan)}
          onSendToPlanner={(next) => {
            setCurrentPlan(next);
            setScreen("planner");
          }}
        />
      )}

      {!selected && screen === "planner" && (
        <PlannerScreen
          corpsIndex={index}
          current={currentPlan}
          onChange={setCurrentPlan}
          loads={planRosters.loads}
          onRetryRoster={planRosters.retry}
          onBack={() => setScreen("corps")}
          onOpenInBuilder={openFromPlanner}
        />
      )}

      {!selected && screen === "corps" && !error &&
        (index ? (
          <CorpsSelect
            index={index}
            ui={corpsUi}
            onUiChange={setCorpsUi}
            initialScroll={corpsScroll.current}
            onScrollChange={(v) => {
              corpsScroll.current = v;
            }}
            onSelect={(entry) => openCorps(entry)}
          />
        ) : (
          <div className="loading">Loading corps…</div>
        ))}

      {selected && loadingRoster && <div className="loading">Loading {selected.name}…</div>}

      {selected && roster && (
        <Builder
          roster={roster}
          postFlag={selected.postSelectionFlag ?? selected.flag}
          onBack={back}
          initialSaved={pendingSaved}
          onBuildChange={builderSlotId ? onSlotBuildChange : undefined}
          context={
            builderSlotId
              ? { backLabel: "← Ordre de Bataille", label: `Army ${builderSlotNumber} of ${currentPlan.plan.name}` }
              : undefined
          }
        />
      )}

      {showOffline && (
        <OfflinePanel
          onClose={() => setShowOffline(false)}
          factionName={factionName}
          allFactionKeys={allFactionKeys}
        />
      )}
      {pendingUpdate && (
        <UpdateToast
          message={
            pendingUpdate === "elsewhere"
              ? "The app was updated in another tab. Reload to finish updating."
              : undefined
          }
          onReload={applyUpdate}
          onDismiss={() => setPendingUpdate(null)}
        />
      )}
    </div>
  );
}
