// Replay build checker: open a Napoleon: Total War .replay and inspect the exact
// army every player fielded, using the same medallions and pricing as the
// builder. Any army can be saved into the user's own saved builds or opened in
// the builder to edit.
//
// Everything happens locally — the file is read in the browser and never leaves
// the device.

import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assetUrl } from "../data/assets";
import { loadFaction } from "../data/load";
import { type ReplayArmy, parseReplay } from "../domain/replay";
import type { CorpsEntry, CorpsIndex, FactionRoster, UnitCard } from "../domain/types";
import { type BuildState, type RosterIndex, indexRoster, summarize } from "../state/build";
import { type CurrentPlan, MAX_PLAN_ARMIES } from "../state/plan";
import { BuildRepository, type SavedBuild } from "../state/saves";
import {
  type ReplaySession,
  emptyReplaySession,
  replayArmyIssues,
  replayBuildName,
  resolveReplayArmy,
  savedBuildFromReplayArmy,
} from "../state/replayBuild";
import { defaultTickedArmies, planFromReplayArmies } from "../state/replayPlan";
import { MAX_BUILD_COST } from "../rules/rules";
import { useConfirm } from "./useConfirm";
import { Medallion } from "./Medallion";
import { NamePromptModal } from "./NamePromptModal";
import { isTabletTouch, useCoarsePointer } from "./useCoarsePointer";

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
  planIsEmpty,
  onSendToPlanner,
}: {
  corpsIndex: CorpsIndex | null;
  session: ReplaySession;
  onSessionChange: Dispatch<SetStateAction<ReplaySession>>;
  onBack: () => void;
  onOpenInBuilder: (entry: CorpsEntry, saved: SavedBuild) => void;
  /** Whether the working plan holds nothing, so sending a team over it needs no warning. */
  planIsEmpty: boolean;
  /** Install a new working plan built from the replay and show the planner. */
  onSendToPlanner: (plan: CurrentPlan) => void;
}) {
  const { battle, fileName, rosters, activeIndex } = session;
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savingView, setSavingView] = useState<ArmyView | null>(null);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Bumped per opened file; a slower earlier file must not land over a newer one.
  const requestRef = useRef(0);
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
    const request = ++requestRef.current;
    const current = () => request === requestRef.current;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      // A drop bypasses the picker's accept=".replay", so check the name here.
      if (!/\.replay$/i.test(file.name)) throw new Error(`${file.name} is not a .replay file.`);
      if (file.size > MAX_REPLAY_BYTES) throw new Error(`${file.name} is too large to be a replay.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!current()) return;
      const parsed = parseReplay(bytes);
      if (parsed.armies.length === 0) {
        onSessionChange(emptyReplaySession());
        setError(`No armies found in ${file.name}. Is it a Napoleon: Total War .replay?`);
        return;
      }
      const base: ReplaySession = {
        battle: parsed,
        fileName: file.name,
        rosters: new Map(),
        activeIndex: 0,
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
      // Merge only the rosters, into whatever the session is now — the user may
      // have picked another army meanwhile — and only if it is still this file.
      const rosters = new Map(loaded.filter((e): e is [string, FactionRoster] => e !== null));
      onSessionChange((s) => (s.battle === parsed ? { ...s, rosters } : s));
    } catch (e) {
      if (!current()) return;
      onSessionChange(emptyReplaySession());
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) setBusy(false);
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

  const active = activeIndex === null ? (views[0] ?? null) : (views[activeIndex] ?? views[0] ?? null);

  // Named through an in-app modal: Electron does not support window.prompt().
  const save = async (view: ArmyView, name: string) => {
    const saved = savedBuildFromReplayArmy(view.army, name);
    if (
      repo.findByName(saved.name, saved.factionKey) &&
      !(await confirm({ message: `“${saved.name}” already exists for this corps. Overwrite it?`, confirmLabel: "Overwrite", danger: true }))
    )
      return;
    // Look again: the library may have changed while the dialog was open.
    const clash = repo.findByName(saved.name, saved.factionKey);
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
        <button
          className="btn small"
          onClick={() => setSending(true)}
          disabled={!battle || views.length === 0}
          title="Plan a team from this replay's armies"
        >
          ⚑ Send to Ordre de Bataille <span className="tag beta">Beta</span>
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
        <div className="error-box notice" key={w}>
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
            {views.map((v, i) => (
              <ArmyCard
                key={`${v.army.factionKey}-${i}`}
                view={v}
                active={v === active}
                onClick={() => onSessionChange((s) => ({ ...s, activeIndex: i }))}
              />
            ))}
          </div>
          {active && <ArmyDetail view={active} onSave={() => setSavingView(active)} onOpen={() => openInBuilder(active)} />}
        </div>
      )}

      {savingView && (
        <NamePromptModal
          title="Save to my builds"
          initial={replayBuildName(savingView.army)}
          submitLabel="Save"
          onSubmit={(name) => save(savingView, name)}
          onClose={() => setSavingView(null)}
        />
      )}
      {sending && battle && (
        <SendToPlannerModal
          views={views}
          planIsEmpty={planIsEmpty}
          onClose={() => setSending(false)}
          onConfirm={(picked) => {
            setSending(false);
            onSendToPlanner(planFromReplayArmies(battle, picked, fileName));
          }}
        />
      )}

      {message && <div className="toast">{message}</div>}
    </div>
  );
}

function SendToPlannerModal({
  views,
  planIsEmpty,
  onClose,
  onConfirm,
}: {
  views: ArmyView[];
  planIsEmpty: boolean;
  onClose: () => void;
  onConfirm: (picked: number[]) => void;
}) {
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(defaultTickedArmies(views.length)));
  const full = ticked.size >= MAX_PLAN_ARMIES;
  const coarse = useCoarsePointer();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Take focus on open so Escape works straight away (the dialog itself is the target).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const toggle = (i: number) =>
    setTicked((t) => {
      const next = new Set(t);
      if (!next.delete(i) && next.size < MAX_PLAN_ARMIES) next.add(i);
      return next;
    });

  const modal = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        style={{ maxWidth: 460 }}
        role="dialog"
        aria-modal="true"
        aria-label="Send to Ordre de Bataille"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <strong>Send to Ordre de Bataille</strong>
        </div>
        <div className="modal-body">
          <p className="replay-send-note">
            Replays don't record teams. Tick the armies you want. (Up to {MAX_PLAN_ARMIES}.)
          </p>
          <div className="replay-send-list">
            {views.map((v, i) => {
              const cost = costOf(v);
              const disabled = full && !ticked.has(i);
              return (
                <label className={`replay-send-row${disabled ? " disabled" : ""}`} key={`${v.army.factionKey}-${i}`}>
                  <input
                    type="checkbox"
                    checked={ticked.has(i)}
                    disabled={disabled}
                    onChange={() => toggle(i)}
                  />
                  <span className="replay-send-who">{v.army.player || "AI / unassigned"}</span>
                  <span className="replay-send-corps">{v.entry?.name || v.army.corpsName || v.army.factionKey}</span>
                  {cost !== null && (
                    <span className={cost > MAX_BUILD_COST ? "over" : undefined}>{cost.toLocaleString()} MP</span>
                  )}
                </label>
              );
            })}
          </div>
          {!planIsEmpty && (
            <p className="replay-send-note">
              Your current plan will be replaced. Plans you saved by name are not touched.
            </p>
          )}
          <div className="modal-actions" style={{ marginTop: 12, marginBottom: 0, justifyContent: "flex-end" }}>
            <button className="btn small" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn small primary"
              disabled={ticked.size === 0}
              onClick={() => onConfirm([...ticked])}
            >
              {planIsEmpty ? "Send" : "Replace plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  // Same iOS fixed-position clipping workaround as NamePromptModal.
  return coarse || isTabletTouch() ? createPortal(modal, document.body) : modal;
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
        <span className="corps-meta">{entry?.name || army.corpsName || army.factionKey}</span>
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
          <h2>{entry?.name || army.corpsName || army.factionKey}</h2>
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
        <div className="error-box notice" key={issue}>
          ⚠ {issue}
        </div>
      ))}
      {!index && (
        <div className="error-box notice">
          ⚠ No roster data for <code>{army.factionKey}</code> — showing the replay’s own unit names.
        </div>
      )}
      {missingKeys.length > 0 && (
        <div className="error-box notice">
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
