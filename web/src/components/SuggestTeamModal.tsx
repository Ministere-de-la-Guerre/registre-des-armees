import { useEffect, useMemo, useRef, useState } from "react";
import type { CorpsEntry, CorpsIndex, FactionRoster, ValueMode } from "../domain/types";
import { type TeamKey, teamAnchor } from "../domain/teamRule";
import { MAX_TOTAL_UNIT_CARDS } from "../rules/rules";
import { MODE_NAME_NOTE } from "./OptimiseModal";
import { DEFAULT_OPTIMISE_SETTINGS } from "../state/optimiser";
import { type Plan, type TeamPlaceholder, applySuggestedTeam } from "../state/plan";
import { corpsPoints } from "../state/planSummary";
import type { SavedBuild } from "../state/saves";
import { SolveCancelled, cancelSolves, workerSolver } from "../state/solveLp";
import { type ArmyResult, cachedArmy, liveArmyResults } from "../state/teamBuild";
import {
  type SuggestedTeam,
  type TeamCandidate,
  type TeamCriterion,
  TEAM_SIZE,
  candidatesOf,
  needsLiveValues,
  poolsFor,
  precomputedValue,
  reachableTotals,
  suggestTeams,
  teamModes,
  teamOptimiseSettings,
  teamPools,
} from "../state/teamSuggest";

// Army Corps show their size-band mode as "Quality" (see OptimiseModal).
const MODE_LABELS: Record<ValueMode, string> = { quantity: "Quantity", quality: "Quality", sizeBands: "Quality" };

interface Kept {
  slotId: string;
  entry: CorpsEntry;
  build: SavedBuild;
}

type LiveState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number; name: string }
  | { status: "ready"; values: Map<string, number>; failed: string[] };

/** "Suggest a team" for the Ordre de Bataille planner (state/teamSuggest.ts): the best armies
 *  for a points total within one legal pool. The planner only opens it when its armies form a
 *  legal team (teamRule.ts planTeamConflict). "Use this team" puts the team in the plan
 *  (onApply, which keeps an undo) and builds each army with the optimiser (onFill). */
export function SuggestTeamModal({
  corpsIndex,
  teamKeys,
  plan,
  loadRoster,
  onApply,
  onFill,
  onClose,
}: {
  corpsIndex: CorpsIndex;
  teamKeys: ReadonlyMap<string, TeamKey>;
  plan: Plan;
  loadRoster: (factionKey: string) => Promise<FactionRoster>;
  onApply: (next: Plan) => void;
  onFill: (placeholder: TeamPlaceholder, build: SavedBuild) => void;
  onClose: () => void;
}) {
  const entryByKey = useMemo(() => {
    const map = new Map<string, CorpsEntry>();
    for (const s of corpsIndex.sides) for (const t of s.theatres) for (const c of t.corps) map.set(c.factionKey, c);
    return map;
  }, [corpsIndex]);
  const planArmies: Kept[] = useMemo(() => plan.slots.flatMap((s) => {
    const entry = s.build ? entryByKey.get(s.build.factionKey) : undefined;
    return s.build && entry ? [{ slotId: s.id, entry, build: s.build }] : [];
  }), [plan.slots, entryByKey]);

  const [remainder, setRemainder] = useState(planArmies.length > 0 && planArmies.length < TEAM_SIZE);
  const kept = remainder ? planArmies : [];
  const anchor = teamAnchor(kept.map((k) => teamKeys.get(k.entry.factionKey) ?? null));
  const allPools = useMemo(() => teamPools(corpsIndex, teamKeys), [corpsIndex, teamKeys]);
  const pools = poolsFor(allPools, anchor);
  const [poolId, setPoolId] = useState<string | null>(null);
  const pool = pools.find((p) => p.id === poolId) ?? pools[0] ?? null;
  const [mode, setMode] = useState<ValueMode>("quantity");
  const modes = pool ? teamModes(pool.kind) : ["quantity" as ValueMode];
  const valueMode = modes.includes(mode) ? mode : "quantity";
  const [criterion, setCriterion] = useState<TeamCriterion>("total");
  const [maxCards, setMaxCards] = useState(DEFAULT_OPTIMISE_SETTINGS.maxCards);
  const [allowNoStaff, setAllowNoStaff] = useState(false);
  const [singleRoll, setSingleRoll] = useState(true);
  const [repeats, setRepeats] = useState(false);
  const base = { maxCards, allowNoStaff, singleRoll };
  const keptWithUnits = kept.filter((k) => k.build.instances.length > 0 || k.build.staffSlotUnitKey);
  const live = needsLiveValues(base, keptWithUnits.length);
  const [liveState, setLiveState] = useState<LiveState>({ status: "idle" });
  const [building, setBuilding] = useState<{ done: number; total: number; name: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const signal = useRef({ cancelled: false });

  // Live values belong to one question: any change of pool, mode or settings asks it again.
  const liveKey = [pool?.id, valueMode, maxCards, allowNoStaff, singleRoll, remainder].join("|");
  useEffect(() => setLiveState({ status: "idle" }), [liveKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !building && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, building]);

  const valueOf = (entry: CorpsEntry): number | null =>
    live ? (liveState.status === "ready" ? liveState.values.get(entry.factionKey) ?? null : null) : precomputedValue(entry, valueMode);
  const keptKeys = new Set(kept.map((k) => k.entry.factionKey));
  const candidates: TeamCandidate[] = pool
    ? candidatesOf(pool.members.filter((m) => repeats || !keptKeys.has(m.factionKey)), valueOf) : [];
  const fixed: TeamCandidate[] = candidatesOf(kept.map((k) => k.entry), valueOf);
  const valuesKnown = !live || liveState.status === "ready";
  const allowRepeats = pool?.kind === "tow" && repeats;
  // At most ~36k teams per pool: cheap enough to enumerate on every render.
  const totals = valuesKnown ? reachableTotals(candidates, { fixed, repeats: allowRepeats }) : new Map<number, number>();
  const sortedTotals = [...totals.keys()].sort((a, b) => a - b);
  const planTotal = planArmies.reduce((s, k) => s + (corpsPoints(k.entry) ?? 0), 0);
  const [total, setTotal] = useState<number | null>(planArmies.length === TEAM_SIZE ? planTotal : null);
  const target = total ?? (sortedTotals.length ? sortedTotals[Math.floor(sortedTotals.length / 2)] : 0);
  const result = valuesKnown && fixed.length === kept.length
    ? suggestTeams(candidates, { total: target, criterion, fixed, repeats: allowRepeats, limit: 5 })
    : { teams: [] as SuggestedTeam[], nearestTotals: [] as number[] };

  const keptTarget = (k: Kept) => ({ entry: k.entry, kept: k.build });

  const findLive = async () => {
    if (!pool) return;
    signal.current = { cancelled: false };
    setErrors([]);
    const fresh = teamOptimiseSettings(base, valueMode, false);
    const withKept = teamOptimiseSettings(base, valueMode, true);
    const deps = { loadRoster, solver: workerSolver, signal: signal.current };
    const members = pool.members.filter((m) => !keptKeys.has(m.factionKey) || repeats);
    const n = members.length + kept.length;
    try {
      const results = new Map<string, ArmyResult>();
      for (const [k, r] of await liveArmyResults(kept.map(keptTarget), withKept,
        { ...deps, onProgress: (i, _t, name) => setLiveState({ status: "running", done: i, total: n, name }) })) results.set(k, r);
      for (const [k, r] of await liveArmyResults(members.map((entry) => ({ entry, kept: null })), fresh,
        { ...deps, onProgress: (i, _t, name) => setLiveState({ status: "running", done: kept.length + i, total: n, name }) })) {
        if (!results.has(k)) results.set(k, r);
      }
      const values = new Map<string, number>();
      const failed: string[] = [];
      for (const [k, r] of results) {
        if (r.ok) values.set(k, r.summary.value);
        else failed.push(r.error);
      }
      setLiveState({ status: "ready", values, failed });
    } catch (e) {
      setLiveState({ status: "idle" });
      if (!(e instanceof SolveCancelled)) setErrors([e instanceof Error ? e.message : String(e)]);
    }
  };

  const applyTeam = async (team: SuggestedTeam) => {
    const added = team.armies.filter((a) => !a.fixed).map((a) => ({ factionKey: a.candidate.factionKey, name: a.candidate.name }));
    const keepIds = new Set(kept.map((k) => k.slotId));
    const { plan: next, placeholders } = applySuggestedTeam(plan, remainder ? added : team.armies.map((a) =>
      ({ factionKey: a.candidate.factionKey, name: a.candidate.name })), remainder ? keepIds : new Set());
    onApply(next);
    // Kept armies are built too: an empty one from scratch, one with units by optimising the rest.
    const targets = [
      ...kept.map((k) => ({ placeholder: { slotId: k.slotId, buildId: k.build.id, factionKey: k.entry.factionKey },
                            entry: k.entry, kept: k.build })),
      ...placeholders.map((p) => ({ placeholder: p, entry: entryByKey.get(p.factionKey)!, kept: null })),
    ];
    signal.current = { cancelled: false };
    const failures: string[] = [];
    for (const [i, t] of targets.entries()) {
      if (signal.current.cancelled) break;
      setBuilding({ done: i, total: targets.length, name: t.entry.name });
      const hasUnits = !!t.kept && (t.kept.instances.length > 0 || !!t.kept.staffSlotUnitKey);
      try {
        const r = await cachedArmy(t.entry, t.kept, teamOptimiseSettings(base, valueMode, hasUnits),
                                   { loadRoster, solver: workerSolver });
        if (r.ok) onFill(t.placeholder, r.build);
        else failures.push(r.error);
      } catch (e) {
        if (e instanceof SolveCancelled) break;
        failures.push(`${t.entry.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBuilding(null);
    setErrors(failures);
    if (!failures.length) onClose();
  };

  const cancel = () => {
    signal.current.cancelled = true;
    cancelSolves();
  };

  const busy = building !== null || liveState.status === "running";

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal opt-modal" role="dialog" aria-modal="true" aria-label="Suggest a team" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>Suggest a team</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              The {TEAM_SIZE} armies with the most value at a team points total (the sum of their corps numbers)
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose} disabled={busy} aria-label="Close team suggestion">✕</button>
        </div>

        <div className="modal-body">
          {planArmies.length > 0 && (
            <label className="opt-check">
              <input type="checkbox" checked={remainder} disabled={busy} onChange={(e) => setRemainder(e.target.checked)} />
              <span>
                Optimise remainder
                <span className="opt-hint">
                  Keep the plan's {planArmies.length === 1 ? "army" : `${planArmies.length} armies`} (and their units) and fill the rest;
                  off replaces the whole team.
                </span>
              </span>
            </label>
          )}

          <label className="opt-field">
            <span className="opt-label">Armies from</span>
            <select value={pool?.id ?? ""} disabled={busy || pools.length < 2} onChange={(e) => setPoolId(e.target.value)}>
              {pools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            {!pools.length && <span className="opt-hint">No pool has {TEAM_SIZE} armies with optimiser data for this team.</span>}
          </label>

          <label className="opt-field">
            <span className="opt-label">
              Team points <b>{target}</b>
              {sortedTotals.length > 0 && <span className="opt-sub"> (this pool reaches {sortedTotals[0]}–{sortedTotals[sortedTotals.length - 1]})</span>}
            </span>
            <input type="number" min={1} max={60} value={target} disabled={busy}
                   onChange={(e) => setTotal(Number(e.target.value) || null)} />
          </label>

          <div className="opt-field">
            <div className="tri">
              <span className="opt-label">Best by</span>
              <span className="seg" role="group" aria-label="Rank teams by">
                {(["total", "weakest"] as const).map((c) => (
                  <button key={c} className={criterion === c ? "on" : ""} aria-pressed={criterion === c} onClick={() => setCriterion(c)}>
                    {c === "total" ? "Total value" : "Strongest weakest army"}
                  </button>
                ))}
              </span>
            </div>
            <div className="tri">
              <span className="opt-label">Unit value</span>
              <span className="seg" role="group" aria-label="Unit value">
                {modes.map((m) => (
                  <button key={m} className={valueMode === m ? "on" : ""} aria-pressed={valueMode === m} disabled={busy} onClick={() => setMode(m)}>
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </span>
            </div>
            <span className="opt-hint">{MODE_NAME_NOTE}</span>
          </div>

          <details className="opt-field">
            <summary className="opt-label">Build settings{live ? " (computed live)" : ""}</summary>
            <label className="opt-field">
              <span className="opt-label">Max unit cards per army <b>{maxCards}</b></span>
              <input type="range" min={2} max={MAX_TOTAL_UNIT_CARDS} value={maxCards} disabled={busy}
                     onChange={(e) => setMaxCards(Number(e.target.value))} />
            </label>
            <label className="opt-check">
              <input type="checkbox" checked={allowNoStaff} disabled={busy} onChange={(e) => setAllowNoStaff(e.target.checked)} />
              <span>Allow no staff general</span>
            </label>
            {pool?.kind === "tow" && (
              <>
                <label className="opt-check">
                  <input type="checkbox" checked={singleRoll} disabled={busy} onChange={(e) => setSingleRoll(e.target.checked)} />
                  <span>Single roll (≤ 4 source corps per army)</span>
                </label>
                <label className="opt-check">
                  <input type="checkbox" checked={repeats} disabled={busy} onChange={(e) => setRepeats(e.target.checked)} />
                  <span>
                    The same army more than once
                    <span className="opt-hint">The game allows it for Theatres of War and Custom armies.</span>
                  </span>
                </label>
              </>
            )}
            <span className="opt-hint">
              {live
                ? "These settings (or the units of kept armies) change what each army can build, so every army is optimised live."
                : "At the default settings each army's best build is already known: suggestions are instant."}
            </span>
          </details>

          {live && liveState.status !== "ready" && (
            <div className="modal-actions opt-actions">
              <button className="btn" onClick={() => void findLive()} disabled={busy || !pool}>
                {liveState.status === "running" ? `Optimising ${liveState.done + 1} of ${liveState.total}: ${liveState.name}…` : "Find teams"}
              </button>
              {liveState.status === "running" && <button className="btn" onClick={cancel}>Cancel</button>}
            </div>
          )}
          {liveState.status === "ready" && liveState.failed.length > 0 && (
            <div className="tow-warning" role="status">Left out: {liveState.failed.join(" · ")}</div>
          )}

          {valuesKnown && (
            <div className="opt-result" role="status">
              {result.teams.length === 0 ? (
                result.nearestTotals.length
                  ? `No team reaches exactly ${target} points; nearest: ${result.nearestTotals.join(" or ")}.`
                  : "No team fits."
              ) : (
                <ol className="team-suggestions">
                  {result.teams.map((team, i) => (
                    <li key={i}>
                      <div>
                        {team.armies.map((a, j) => (
                          <span key={j}>
                            {j > 0 && " + "}
                            {a.candidate.name}{a.fixed ? " (kept)" : ""}
                          </span>
                        ))}
                      </div>
                      <div className="opt-hint">
                        value {Math.round(team.total).toLocaleString()} · weakest {Math.round(team.weakest).toLocaleString()}
                        {live ? " · computed live" : ""}
                      </div>
                      <button className="btn small" disabled={busy} onClick={() => void applyTeam(team)}>Use this team</button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {building && (
            <div className="modal-actions opt-actions">
              <span>Building army {building.done + 1} of {building.total}: {building.name}…</span>
              <button className="btn" onClick={cancel}>Cancel</button>
            </div>
          )}
          {errors.length > 0 && (
            <div className="tow-warning" role="status">{errors.join(" · ")}</div>
          )}
          <div className="opt-hint opt-foot">
            Value is what the game's average pricing rule charges for the stats each army's best build fields
            (Registre des Armées analysis), not battle power. Builds use every card of each army; re-optimise
            one in the builder with "Offered now" to match the current rotation.
          </div>
        </div>
      </div>
    </div>
  );
}
