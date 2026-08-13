// Replay build checker: open a Napoleon: Total War .replay and inspect the exact
// army every player fielded, using the same medallions and pricing as the
// builder. Any army can be saved into the user's own saved builds or opened in
// the builder to edit.
//
// Everything happens locally — the file is read in the browser and never leaves
// the device.

import { useEffect, useMemo, useRef, useState } from "react";
import { assetUrl } from "../data/assets";
import { loadFaction } from "../data/load";
import { type ReplayArmy, parseReplay } from "../domain/replay";
import type { CorpsEntry, CorpsIndex, FactionRoster, UnitCard } from "../domain/types";
import { type BuildState, type RosterIndex, indexRoster, summarize } from "../state/build";
import { BuildRepository, type SavedBuild } from "../state/saves";
import {
  type ReplaySession,
  emptyReplaySession,
  replayArmyIssues,
  replayBuildName,
  resolveReplayArmy,
  savedBuildFromReplayArmy,
} from "../state/replayBuild";
import { MAX_BUILD_COST } from "../rules/rules";
import { Medallion } from "./Medallion";

/** Replays are a couple of MB; anything this large is not one, and we would
 *  rather say so than lock the tab up decoding it. */
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;

const VICTORY_LABELS: Record<string, string> = {
  BATTLE_SETUP_VICTORY_CONDITION_KILL_OR_ROUT_ENEMY: "Kill or rout the enemy",
};

function prettyVictory(key: string): string {
  if (!key) return "";
  return VICTORY_LABELS[key] ?? key.replace(/^BATTLE_SETUP_VICTORY_CONDITION_/, "").replace(/_/g, " ").toLowerCase();
}

function prettyWind(key: string): string {
  const n = /wind_level_(\d+)/.exec(key)?.[1];
  return n ? `Wind ${n}` : key;
}

interface ArmyView {
  army: ReplayArmy;
  entry: CorpsEntry | null;
  roster: FactionRoster | null;
  index: RosterIndex | null;
  build: BuildState;
  missingKeys: string[];
}

export function ReplayScreen({
  corpsIndex,
  session,
  onSessionChange,
  onBack,
  onOpenInBuilder,
}: {
  corpsIndex: CorpsIndex | null;
  session: ReplaySession;
  onSessionChange: (session: ReplaySession) => void;
  onBack: () => void;
  onOpenInBuilder: (entry: CorpsEntry, saved: SavedBuild) => void;
}) {
  const { battle, fileName, rosters, activeKey } = session;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const repo = useMemo(() => new BuildRepository(), []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3200);
    return () => clearTimeout(t);
  }, [message]);

  // factionKey → corps-index entry, for flags and the canonical corps name.
  const entryByKey = useMemo(() => {
    const map = new Map<string, CorpsEntry>();
    for (const side of corpsIndex?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) map.set(corps.factionKey, corps);
    return map;
  }, [corpsIndex]);

  const openFile = async (file: File) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (file.size > MAX_REPLAY_BYTES) throw new Error(`${file.name} is too large to be a replay.`);
      const parsed = parseReplay(new Uint8Array(await file.arrayBuffer()));
      if (parsed.armies.length === 0) {
        onSessionChange(emptyReplaySession());
        setError(`No armies found in ${file.name}. Is it a Napoleon: Total War .replay?`);
        return;
      }
      const base: ReplaySession = {
        battle: parsed,
        fileName: file.name,
        rosters: new Map(),
        activeKey: parsed.armies[0].factionKey,
      };
      onSessionChange(base); // show the armies straight away, price them as rosters arrive

      // Every army's roster, in parallel — the list shows each one's cost, and a
      // corps missing from this dataset just renders without pricing.
      const loaded = await Promise.all(
        [...new Set(parsed.armies.map((a) => a.factionKey))].map(async (key) => {
          try {
            return [key, await loadFaction(key)] as const;
          } catch {
            return null;
          }
        }),
      );
      onSessionChange({
        ...base,
        rosters: new Map(loaded.filter((e): e is [string, FactionRoster] => e !== null)),
      });
    } catch (e) {
      onSessionChange(emptyReplaySession());
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const views: ArmyView[] = useMemo(() => {
    return (battle?.armies ?? []).map((army) => {
      const roster = rosters.get(army.factionKey) ?? null;
      const resolved = roster ? resolveReplayArmy(army, roster) : null;
      return {
        army,
        entry: entryByKey.get(army.factionKey) ?? null,
        roster,
        index: roster ? indexRoster(roster) : null,
        build: resolved?.build ?? { instances: [], staffSlotUnitKey: null },
        missingKeys: resolved?.missingKeys ?? [],
      };
    });
  }, [battle, rosters, entryByKey]);

  const active = views.find((v) => v.army.factionKey === activeKey) ?? views[0] ?? null;

  const save = (view: ArmyView) => {
    const suggested = replayBuildName(view.army);
    const name = window.prompt("Save this build as:", suggested);
    if (name === null) return;
    const saved = savedBuildFromReplayArmy(view.army, name);
    const clash = repo.findByName(saved.name, saved.factionKey);
    if (clash && !window.confirm(`“${saved.name}” already exists for this corps. Overwrite it?`)) return;
    const result = repo.save(clash ? { ...saved, id: clash.id, createdAt: clash.createdAt } : saved);
    setMessage(result.ok ? `Saved “${saved.name}” to your builds.` : (result.error ?? "Could not save."));
  };

  const openInBuilder = (view: ArmyView) => {
    const entry: CorpsEntry = view.entry ?? {
      factionKey: view.army.factionKey,
      name: view.army.corpsName || view.army.factionKey,
      displayYear: "",
      displayRating: "",
      order: 0,
      flag: null,
      postSelectionFlag: null,
      isArmyCorps: true,
      cardCount: 0,
    };
    onOpenInBuilder(entry, savedBuildFromReplayArmy(view.army));
  };

  return (
    <div
      className={`corps-screen replay-screen${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void openFile(file);
      }}
    >
      <div className="corps-toolbar">
        <button className="btn small" onClick={onBack}>
          ‹ Back
        </button>
        <strong style={{ color: "var(--gold-bright)" }}>Replay build checker</strong>
        <input
          ref={fileRef}
          type="file"
          accept=".replay"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openFile(file);
            e.target.value = ""; // let the same file be re-opened
          }}
        />
        <button className="btn small primary" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Reading…" : "Open .replay…"}
        </button>
        {fileName && <span className="match-count">{fileName}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        {battle && (
          <span className="replay-meta">
            {[battle.map, prettyVictory(battle.victoryCondition), prettyWind(battle.wind)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>

      {error && <div className="error-box">⚠ {error}</div>}
      {battle?.warnings.map((w) => (
        <div className="error-box" key={w}>
          ⚠ {w}
        </div>
      ))}

      {!battle && !busy && (
        <div className="replay-drop">
          <div className="replay-drop-inner">
            <div className="replay-drop-icon">⚔</div>
            <h3>Drop a .replay here</h3>
            <p>
              Reads the exact army every player fielded — regiments, attached generals and cost — straight out of a
              Napoleon: Total War replay. The file is read on this device and never uploaded.
            </p>
            <p className="replay-drop-hint">
              Replays live in <code>…\Napoleon Total War\data\replays</code>
            </p>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              Choose a replay…
            </button>
          </div>
        </div>
      )}

      {busy && <div className="loading">Reading replay…</div>}

      {battle && views.length > 0 && (
        <div className="replay-body">
          <div className="replay-armies">
            {views.map((v) => (
              <ArmyCard
                key={v.army.factionKey}
                view={v}
                active={v.army.factionKey === active?.army.factionKey}
                onClick={() => onSessionChange({ ...session, activeKey: v.army.factionKey })}
              />
            ))}
          </div>
          {active && <ArmyDetail view={active} onSave={() => save(active)} onOpen={() => openInBuilder(active)} />}
        </div>
      )}

      {message && <div className="toast">{message}</div>}
    </div>
  );
}

function costOf(view: ArmyView): number | null {
  if (!view.index) return null;
  return summarize(view.index, view.build).price.finalCost;
}

const OVER_TITLE = `Over the ${MAX_BUILD_COST.toLocaleString()} MP limit this builder allows`;

function ArmyCard({ view, active, onClick }: { view: ArmyView; active: boolean; onClick: () => void }) {
  const { army, entry } = view;
  const flag = assetUrl(entry?.flag ?? null);
  const cost = costOf(view);
  // Count the staff general like the builder does, so this reads the same as the
  // detail panel's Cards stat rather than one short.
  const cards = army.units.length + (army.staffKey ? 1 : 0);
  return (
    <button className={`corps-card replay-army${active ? " active" : ""}`} onClick={onClick} aria-pressed={active}>
      {flag ? <img className="flag" src={flag} alt="" /> : <span className="flag missing">—</span>}
      <span style={{ minWidth: 0 }}>
        <span className="corps-name">{army.player || "AI / unassigned"}</span>
        <span className="corps-meta">{entry?.name ?? army.corpsName ?? army.factionKey}</span>
        <span className="corps-meta">
          {cards} cards
          {cost !== null && (
            <>
              {" · "}
              <span className={cost > MAX_BUILD_COST ? "over" : undefined} title={cost > MAX_BUILD_COST ? OVER_TITLE : undefined}>
                {cost.toLocaleString()} MP
              </span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

function ArmyDetail({ view, onSave, onOpen }: { view: ArmyView; onSave: () => void; onOpen: () => void }) {
  const { army, entry, index, build, missingKeys } = view;
  const summary = index ? summarize(index, build) : null;
  const issues = summary ? replayArmyIssues(summary) : [];
  const overCost = !!summary && summary.price.finalCost > MAX_BUILD_COST;
  const postFlag = assetUrl(entry?.postSelectionFlag ?? entry?.flag ?? null);

  // One medallion per fielded copy, in the order the replay lists them — the same
  // order the game's unit bar showed the player.
  const copies = index
    ? build.instances
        .map((i) => index.byKey.get(i.unitKey))
        .filter((c): c is UnitCard => Boolean(c))
    : [];
  const staffCard = index && build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) : undefined;

  return (
    <div className="replay-detail">
      <div className="corps-header">
        {postFlag && <img className="post-flag" src={postFlag} alt="" />}
        <div className="titles">
          <h2>{entry?.name ?? army.corpsName ?? army.factionKey}</h2>
          <div className="sub">
            {army.general}
            {army.player && ` — played by ${army.player}`}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {summary && (
          <>
            <div className="hstat">
              <div className="lbl">Cost / {MAX_BUILD_COST.toLocaleString()}</div>
              <div className={`val${overCost ? " over" : ""}`}>{summary.price.finalCost.toLocaleString()}</div>
            </div>
            <div className="hstat">
              <div className="lbl">Cards</div>
              <div className="val">{summary.totalCards}</div>
            </div>
            <div className="hstat">
              <div className="lbl">Men</div>
              <div className="val">{summary.totalMen.toLocaleString()}</div>
            </div>
            <div className="hstat">
              <div className="lbl">Squares</div>
              <div className="val">
                {summary.totalSquares}/{summary.totalInfantry}
              </div>
            </div>
          </>
        )}
        <div className="replay-actions">
          <button className="btn small" onClick={onSave}>
            ★ Save to my builds
          </button>
          <button className="btn small primary" onClick={onOpen}>
            Open in builder ›
          </button>
        </div>
      </div>

      {issues.map((issue) => (
        <div className="error-box" key={issue}>
          ⚠ {issue}
        </div>
      ))}
      {!index && (
        <div className="error-box">
          ⚠ No roster data for <code>{army.factionKey}</code> — showing the replay’s own unit names.
        </div>
      )}
      {missingKeys.length > 0 && (
        <div className="error-box">
          ⚠ {missingKeys.length} unit{missingKeys.length === 1 ? "" : "s"} in this replay are not in the current
          dataset and were dropped: {missingKeys.join(", ")}
        </div>
      )}

      <div className="replay-units">
        {staffCard && (
          <div className="replay-unit">
            <Medallion card={staffCard} qty={1} inStaffSlot showSpeed />
          </div>
        )}
        {index
          ? copies.map((card, i) => (
              <div className="replay-unit" key={`${card.unitKey}-${i}`}>
                {/* One medallion per fielded copy, so qty stays 1 — a "×2" badge on
                    each of two identical medallions would just say it twice. */}
                <Medallion card={card} qty={1} selected showSpeed />
              </div>
            ))
          : army.units.map((u, i) => (
              <div className="replay-unit fallback" key={`${u.key}-${i}`}>
                <span className="replay-fallback-name">{u.regiment || u.key}</span>
                {u.officer && <span className="replay-fallback-officer">{u.officer}</span>}
                {u.tier && <span className="tag">{u.tier}</span>}
              </div>
            ))}
      </div>
    </div>
  );
}
