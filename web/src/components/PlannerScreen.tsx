// Ordre de Bataille (team planner): plan 1-4 armies at once, one army per row, with
// a combined strip that totals the whole team. Every slot holds a *copy* of a saved
// build (state/plan.ts), so nothing here rewrites the player's build library.
//
// The working plan, and the rosters its corps need, live in App so they survive a
// visit to the builder (which unmounts this screen); edits made in the builder flow
// back into the slot through Builder's onBuildChange.

import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { assetUrl } from "../data/assets";
import type { CorpsEntry, CorpsIndex, FactionRoster, UnitCard } from "../domain/types";
import { type BuildState, type RosterIndex, indexRoster } from "../state/build";
import {
  type CurrentPlan,
  MAX_PLAN_ARMIES,
  type Plan,
  type PlanSlot,
  PlanRepository,
  addSlot,
  clearSlot,
  copySavedBuildIntoSlot,
  emptyPlan,
  exportPlanJson,
  importPlanJson,
  isPlanDirty,
  isPlanEmpty,
  makePlanId,
  rawPlanSlotCount,
  moveSlot,
  removeSlot,
  renamePlan,
  setSlotBuild,
  setSlotPlayer,
} from "../state/plan";
import { type ArmyStats, planStats } from "../state/planStats";
import { planPoints, plural, pointsTooltip } from "../state/planSummary";
import { BuildRepository, type SavedBuild, buildToSaved, makeId, resolveSavedBuild } from "../state/saves";
import type { StorageResult } from "../state/storage";
import { CorpsPickerModal } from "./CorpsPickerModal";
import { DetailsPanel } from "./DetailsPanel";
import { Medallion } from "./Medallion";
import { NamePromptModal } from "./NamePromptModal";
import { PlanDetailsModal } from "./PlanDetailsModal";
import type { ExportRow } from "./PlanExportView";
import { ArmyNotices, ArmyStatsGrid, ArmyUnits, PlanPointsChip, PlanShare, PlanTotals, PlanWarnings } from "./PlanParts";
import { renderPlanImage } from "./renderPlanImage";
import { SavedBuildPicker } from "./SavedBuildPicker";
import { Tooltip } from "./Tooltip";
import { type DeliverResult, deliverImage, shareImageFile } from "./exportBuildImage";
import { isCoarsePointer, isTabletTouch, useCoarsePointer } from "./useCoarsePointer";
import type { RosterLoad } from "./usePlanRosters";

/** What a slot currently shows. `ready` is the only state that has stats. */
type SlotView =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; roster: FactionRoster; index: RosterIndex; build: BuildState; missingKeys: string[] };

const CORPS_LOADING_TIP = "Corps list is still loading";

const EMPTY_VIEW: SlotView = { kind: "empty" };
const LOADING_VIEW: SlotView = { kind: "loading" };

/** Resolved ready views, per slot build and roster. Resolving and summarising a build
 *  is the costly part, and a Player-label edit or a move leaves the build object
 *  itself untouched, so those hit this cache instead of redoing the work. */
const readyViews = new WeakMap<SavedBuild, { roster: FactionRoster; view: SlotView }>();

/** indexRoster output per roster object: building the lookup maps is the costly part,
 *  and a roster never changes once loaded, so a `loads` update (another corps arriving
 *  or retrying) must not re-index the rosters that were already ready. */
const rosterIndexes = new WeakMap<FactionRoster, RosterIndex>();
const indexFor = (roster: FactionRoster): RosterIndex => {
  let index = rosterIndexes.get(roster);
  if (!index) {
    index = indexRoster(roster);
    rosterIndexes.set(roster, index);
  }
  return index;
};

const sameView = (a: SlotView, b: SlotView) => a === b || (a.kind === "error" && b.kind === "error" && a.error === b.error);

interface NamePrompt {
  title: string;
  initial: string;
  submitLabel: string;
  onSubmit: (value: string) => void;
}

function downloadJson(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Append and defer the revoke, like SaveLoadBar.doExport.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const fileSafe = (name: string, fallback: string) => name.replace(/[^\w-]+/g, "_").slice(0, 60) || fallback;

export function PlannerScreen({
  corpsIndex,
  current,
  onChange,
  loads,
  onRetryRoster,
  onBack,
  onOpenInBuilder,
}: {
  corpsIndex: CorpsIndex | null;
  current: CurrentPlan;
  onChange: Dispatch<SetStateAction<CurrentPlan>>;
  /** Roster load state per factionKey, owned by App. */
  loads: ReadonlyMap<string, RosterLoad>;
  onRetryRoster: (factionKey: string) => void;
  onBack: () => void;
  onOpenInBuilder: (slotId: string, entry: CorpsEntry, build: SavedBuild) => void;
}) {
  const { plan } = current;
  const planRepo = useMemo(() => new PlanRepository(), []);
  const buildRepo = useMemo(() => new BuildRepository(), []);
  const coarse = useCoarsePointer();
  // Same reason as SaveLoadBar: the toolbar is a momentum scroller on touch, which
  // clips fixed descendants on iOS, so its overlays go to <body> there.
  const overlaysPortal = coarse || isTabletTouch();
  const renderOverlay = (node: ReactNode) => (overlaysPortal ? createPortal(node, document.body) : node);

  // Read up front: an empty first render would call a loaded plan "unsaved" and send
  // Save to Save As until an effect filled the list.
  const [savedPlans, setSavedPlans] = useState<Plan[]>(() => planRepo.list());
  const [menuOpen, setMenuOpen] = useState(false);
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [pickerSlot, setPickerSlot] = useState<string | null>(null);
  const [corpsSlot, setCorpsSlot] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingShare, setPendingShare] = useState<File | null>(null);
  const [hovered, setHovered] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  const [peek, setPeek] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  const [detail, setDetail] = useState<UnitCard | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);

  // The corps picker needs the index; never leave a slot "picking" with no modal up.
  useEffect(() => {
    if (!corpsIndex) setCorpsSlot(null);
  }, [corpsIndex]);

  const refresh = () => setSavedPlans(planRepo.list());

  // The latest working plan, for async callbacks (the import's FileReader).
  const planRef = useRef(plan);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  // Dismiss the Load menu on an outside tap or Escape (see SaveLoadBar).
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  // factionKey → corps-index entry, for flags and the canonical corps name.
  const entryByKey = useMemo(() => {
    const map = new Map<string, CorpsEntry>();
    for (const side of corpsIndex?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) map.set(corps.factionKey, corps);
    return map;
  }, [corpsIndex]);
  const points = useMemo(() => planPoints(plan.slots, entryByKey), [plan.slots, entryByKey]);
  const corpsNameOf = useCallback(
    (b: SavedBuild) => entryByKey.get(b.factionKey)?.name || b.armyCorpsName || b.factionKey,
    [entryByKey],
  );

  // --- the slots, resolved against their rosters --------------------------------
  const nextViews: SlotView[] = useMemo(
    () =>
      plan.slots.map((slot): SlotView => {
        if (!slot.build) return EMPTY_VIEW;
        const load = loads.get(slot.build.factionKey);
        if (!load || load.status === "loading") return LOADING_VIEW;
        if (load.status === "error") return { kind: "error", error: load.error };
        const cached = readyViews.get(slot.build);
        if (cached && cached.roster === load.roster) return cached.view;
        const resolved = resolveSavedBuild(slot.build, load.roster);
        const view: SlotView = {
          kind: "ready",
          roster: load.roster,
          index: indexFor(load.roster),
          build: resolved.build,
          missingKeys: resolved.missingKeys,
        };
        readyViews.set(slot.build, { roster: load.roster, view });
        return view;
      }),
    [plan.slots, loads],
  );
  // Keep the same array while every view is unchanged, so the team stats below are
  // not recomputed for a Player-label edit.
  const [views, setViews] = useState(nextViews);
  if (views !== nextViews && (views.length !== nextViews.length || nextViews.some((v, i) => !sameView(v, views[i])))) {
    setViews(nextViews);
  }

  const stats = useMemo(
    () => planStats(views.map((v) => (v.kind === "ready" ? { index: v.index, build: v.build } : null))),
    [views],
  );

  // --- plan editing ---------------------------------------------------------------
  const edit = (fn: (p: Plan) => Plan) => onChange((cp) => ({ ...cp, plan: fn(cp.plan) }));

  const savedPlan = current.loadedPlanId ? (savedPlans.find((p) => p.id === current.loadedPlanId) ?? null) : null;
  const dirty = isPlanDirty(plan, savedPlan);

  const report = (result: StorageResult, okMsg: string) => {
    refresh();
    setMessage(result.ok ? (result.warning ? `${okMsg} ${result.warning}` : okMsg) : `Not saved: ${result.error ?? "storage error"}.`);
    return result.ok;
  };

  const storeAs = (target: Plan, okMsg: string) => {
    const saved: Plan = { ...target, updatedAt: new Date().toISOString() };
    if (report(planRepo.save(saved), okMsg)) onChange({ plan: saved, loadedPlanId: saved.id });
  };

  const doSave = () => {
    if (!savedPlan) return doSaveAs();
    storeAs({ ...plan, id: savedPlan.id }, `Saved “${plan.name}”.`);
  };

  const doSaveAs = () =>
    setNamePrompt({
      title: "Save plan as",
      initial: savedPlan ? `${plan.name} (copy)` : plan.name,
      submitLabel: "Save",
      onSubmit: (name) => {
        const existing = planRepo.findByName(name);
        if (existing) {
          if (!window.confirm(`A plan named “${name}” already exists. Overwrite it?`)) return;
          storeAs({ ...plan, id: existing.id, name: existing.name, createdAt: existing.createdAt }, `Overwrote “${existing.name}”.`);
          return;
        }
        storeAs({ ...plan, id: makePlanId(), name, createdAt: new Date().toISOString() }, `Saved “${name}”.`);
      },
    });

  const doLoad = (p: Plan) => {
    if (dirty && !window.confirm("Discard unsaved changes and load this plan?")) return;
    onChange({ plan: p, loadedPlanId: p.id });
    setMenuOpen(false);
  };

  const doNew = () => {
    if (!isPlanEmpty(plan) && !window.confirm("Start a new plan? The current plan's armies will be cleared.")) return;
    onChange({ plan: emptyPlan(), loadedPlanId: null });
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onerror = () => setMessage("Import failed: couldn't read the file.");
    reader.onload = () => {
      const text = String(reader.result);
      const imported = importPlanJson(text);
      if (!imported) {
        setMessage("Import failed: not a valid plan file.");
        return;
      }
      // Read the plan now, not when the button was clicked: it may have changed.
      if (!isPlanEmpty(planRef.current) && !window.confirm("Replace the current plan with the imported one?")) return;
      onChange({ plan: imported, loadedPlanId: null });
      const dropped = rawPlanSlotCount(text) > MAX_PLAN_ARMIES;
      setMessage(`Imported “${imported.name}”${dropped ? `; kept the first ${MAX_PLAN_ARMIES} armies` : ""}.`);
    };
    reader.readAsText(file);
  };

  const renameWorkingPlan = () =>
    setNamePrompt({
      title: "Rename plan",
      initial: plan.name,
      submitLabel: "Rename",
      onSubmit: (name) => edit((p) => renamePlan(p, name)),
    });

  // --- per-army actions -------------------------------------------------------------
  const entryFor = (build: SavedBuild): CorpsEntry =>
    entryByKey.get(build.factionKey) ?? {
      factionKey: build.factionKey,
      name: build.armyCorpsName || build.factionKey,
      displayYear: "",
      displayRating: "",
      order: 0,
      flag: null,
      postSelectionFlag: null,
      isArmyCorps: true,
      cardCount: 0,
    };

  const saveToMyBuilds = (build: SavedBuild) =>
    setNamePrompt({
      title: "Save to my builds",
      initial: build.name,
      submitLabel: "Save",
      onSubmit: (name) => {
        const clash = buildRepo.findByName(name, build.factionKey);
        if (clash && !window.confirm(`“${name}” already exists for this corps. Overwrite it?`)) return;
        const now = new Date().toISOString();
        // The library gets its own record (fresh id unless overwriting), so the slot
        // stays a copy and later edits to it never touch the saved build.
        const saved: SavedBuild = { ...build, id: clash?.id ?? makeId(), name, createdAt: clash?.createdAt ?? now, updatedAt: now };
        const result = buildRepo.save(saved);
        setMessage(result.ok ? `Saved “${name}” to your builds.` : (result.error ?? "Could not save."));
      },
    });

  const pickSaved = (slotId: string, saved: SavedBuild) => {
    edit((p) => setSlotBuild(p, slotId, copySavedBuildIntoSlot(saved)));
    setPickerSlot(null);
    setMessage(`Loaded “${saved.name}” into army ${plan.slots.findIndex((s) => s.id === slotId) + 1}.`);
  };

  // Assigning a corps leaves the slot with an empty build for it, so the row shows the
  // corps and its zeroed stats; the units are added in the builder.
  const chooseCorps = (slotId: string, entry: CorpsEntry) => {
    setCorpsSlot(null);
    const slot = plan.slots.find((s) => s.id === slotId);
    if (!slot || slot.build?.factionKey === entry.factionKey) return;
    const empty = buildToSaved(
      {
        build: { instances: [], staffSlotUnitKey: null },
        config: { density: "comfortable", showCombatGenerals: true },
        factionKey: entry.factionKey,
        armyCorpsName: entry.name,
      },
      { name: entry.name },
    );
    edit((p) => setSlotBuild(p, slotId, empty));
  };

  // Units belong to their corps, so changing it drops them; ask first when there are any.
  const askChangeCorps = (slot: PlanSlot, number: number) => {
    const b = slot.build;
    if (b && (b.instances.length > 0 || b.staffSlotUnitKey)) {
      const from = entryByKey.get(b.factionKey)?.name || b.armyCorpsName || b.factionKey;
      if (!window.confirm(`Army ${number}'s units belong to ${from} and will be removed. Change corps?`)) return;
    }
    setCorpsSlot(slot.id);
  };

  // --- image export (mirrors Builder.exportImage; the image is PlanExportView) --------
  const reportDelivery = (result: DeliverResult) => {
    if (result === "copied") setMessage("Plan image copied to clipboard.");
    else if (result === "downloaded") setMessage("Plan image download started.");
  };
  const exportImage = async () => {
    // An army that is still loading (or failed) would silently vanish from the picture
    // and the image would pass for the whole team: say so and export nothing.
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      if (v.kind === "loading") return setMessage(`Army ${i + 1} isn't loaded yet; try again in a moment.`);
      if (v.kind === "error") return setMessage(`Army ${i + 1} couldn't be loaded; Retry it first.`);
    }
    if (!corpsIndex) return setMessage("The corps list isn't loaded yet; try again in a moment.");
    // Only armies with units to show: empty slots, and armies with a corps but no
    // cards and no commander, stay out of the image.
    const rows = views.flatMap((v, i): ExportRow[] => {
      const slot = plan.slots[i];
      const s = stats.perArmy[i];
      if (v.kind !== "ready" || !slot.build || !s) return [];
      if (v.build.instances.length === 0 && !v.build.staffSlotUnitKey) return [];
      const entry = entryByKey.get(slot.build.factionKey);
      const corpsName = entry?.name || v.roster.armyCorpsName || slot.build.factionKey;
      return [
        {
          number: i + 1,
          corpsName,
          buildName: slot.build.name === corpsName ? "" : slot.build.name,
          flag: assetUrl(entry?.flag ?? null),
          player: slot.player.trim(),
          stats: s,
          violations: s.summary.violationMessages,
          missing: v.missingKeys.length,
          ...unitsOf(v),
        },
      ];
    });
    if (rows.length === 0) return;
    setPendingShare(null);
    try {
      // Hand the pending image to deliverImage at once: the clipboard write must
      // begin inside this click, not after the render.
      const render = renderPlanImage({ name: plan.name, points, stats, rows });
      const result = await deliverImage(render, `${fileSafe(plan.name, "plan")}.png`, isCoarsePointer());
      if (typeof result === "object") setPendingShare(result.retryShare);
      else reportDelivery(result);
    } catch {
      setMessage("Couldn't export the plan image.");
    }
  };
  const sharePending = async () => {
    const file = pendingShare;
    if (!file) return;
    setPendingShare(null);
    try {
      reportDelivery(await shareImageFile(file));
    } catch {
      setMessage("Couldn't share the plan image.");
    }
  };

  const shown = detail || detailsOpen || pickerSlot || (corpsSlot && corpsIndex) ? null : { hovered, peek };

  return (
    <div className="corps-screen plan-screen">
      <div className="plan-top">
        <div className="plan-toolbar">
          <button className="btn small" onClick={onBack}>
            ‹ Back
          </button>
          <div className="plan-titles">
            <strong>
              ⚑ Ordre de Bataille <span className="tag beta">Beta</span>
            </strong>
            <button className="plan-name" onClick={renameWorkingPlan} title="Rename this plan">
              {plan.name}
              {dirty && <span className="plan-dirty"> • unsaved changes</span>} ✎
            </button>
          </div>
          <PlanPointsChip points={points} title={pointsTooltip(points, plan.slots)} pending={!corpsIndex} />
          <span className="spacer" style={{ flex: 1 }} />
          <div ref={rootRef} className="plan-saves">
            <button className={`btn small ${dirty ? "primary" : ""}`} onClick={doSave} title={savedPlan ? "Save changes" : "Save"}>
              {dirty ? "Save*" : "Save"}
            </button>
            <button className="btn small" onClick={doSaveAs}>
              Save As
            </button>
            <button
              className="btn small"
              onClick={() => {
                refresh();
                setMenuOpen((o) => !o);
              }}
            >
              Load ▾
            </button>
            {menuOpen &&
              renderOverlay(
                <div className="saves-menu" ref={menuRef}>
                  {!planRepo.persistent && (
                    <div className="saves-warning">Storage unavailable — saves will not persist this session.</div>
                  )}
                  {savedPlans.length === 0 ? (
                    <div style={{ padding: 10, fontSize: 13, color: "var(--text-soft)" }}>No saved plans yet.</div>
                  ) : (
                    savedPlans.map((p) => (
                      <div className="saves-row" key={p.id}>
                        <div style={{ flex: 1, fontSize: 13 }}>
                          <strong>{p.name}</strong>
                          <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
                            {p.slots.filter((s) => s.build).length} of {plural(p.slots.length, "army", "armies")} · {new Date(p.updatedAt).toLocaleString()}
                          </div>
                        </div>
                        <button className="btn small" onClick={() => doLoad(p)}>
                          Load
                        </button>
                        <button
                          className="btn small"
                          onClick={() =>
                            setNamePrompt({
                              title: "Rename plan",
                              initial: p.name,
                              submitLabel: "Rename",
                              onSubmit: (n) => {
                                const clash = planRepo.findByName(n);
                                if (clash && clash.id !== p.id && !window.confirm(`Another plan named “${n}” already exists. Keep both with the same name?`)) return;
                                // Only follow into the working plan if the storage rename took,
                                // and not over a rename still pending there.
                                const renamed = report(planRepo.rename(p.id, n), `Renamed to “${n}”.`);
                                if (renamed && current.loadedPlanId === p.id)
                                  edit((pl) => (pl.name === p.name ? renamePlan(pl, n) : pl));
                              },
                            })
                          }
                        >
                          Rename
                        </button>
                        <button
                          className="btn small"
                          onClick={() => {
                            const { result } = planRepo.duplicate(p.id);
                            report(result, `Duplicated “${p.name}”.`);
                          }}
                        >
                          Duplicate
                        </button>
                        <button
                          className="btn small"
                          onClick={() => {
                            if (!window.confirm(`Delete “${p.name}”?`)) return;
                            if (report(planRepo.remove(p.id), `Deleted “${p.name}”.`) && current.loadedPlanId === p.id)
                              onChange((cp) => ({ ...cp, loadedPlanId: null }));
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>,
              )}
          </div>
          <button className="btn small" onClick={doNew}>
            New plan
          </button>
          <button className="btn small" onClick={() => downloadJson(exportPlanJson(plan), `${fileSafe(plan.name, "plan")}.json`)}>
            Export JSON
          </button>
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
              e.target.value = "";
            }}
          />
          <button className="btn small" onClick={exportImage} disabled={stats.armies === 0} title="Copy the whole team as one image">
            Copy image
          </button>
          {plan.slots.length < MAX_PLAN_ARMIES && (
            <button className="btn small primary" onClick={() => edit(addSlot)}>
              + Add army
            </button>
          )}
        </div>

        <div className="plan-strip">
          <PlanTotals stats={stats} />

          <PlanShare stats={stats} />

          <div className="plan-strip-end">
            <PlanWarnings stats={stats} />
            <button className="btn small" onClick={() => setDetailsOpen(true)}>
              Details
            </button>
          </div>
        </div>
      </div>

      <div className="plan-armies">
        {plan.slots.map((slot, i) => (
          <ArmyRow
            key={slot.id}
            number={i + 1}
            slot={slot}
            view={views[i]}
            stats={stats.perArmy[i]}
            entry={slot.build ? entryByKey.get(slot.build.factionKey) : undefined}
            isFirst={i === 0}
            isLast={i === plan.slots.length - 1}
            canRemove={plan.slots.length > 1}
            corpsReady={Boolean(corpsIndex)}
            onPlayer={(player) => edit((p) => setSlotPlayer(p, slot.id, player))}
            onOpen={() => slot.build && onOpenInBuilder(slot.id, entryFor(slot.build), slot.build)}
            onChooseCorps={() => setCorpsSlot(slot.id)}
            onChangeCorps={() => askChangeCorps(slot, i + 1)}
            onLoad={() => setPickerSlot(slot.id)}
            onSave={() => slot.build && saveToMyBuilds(slot.build)}
            onClear={() => edit((p) => clearSlot(p, slot.id))}
            onMove={(delta) => edit((p) => moveSlot(p, slot.id, delta))}
            onRemove={() => edit((p) => removeSlot(p, slot.id))}
            onRetry={() => slot.build && onRetryRoster(slot.build.factionKey)}
            onHover={(card, anchor) => setHovered({ card, anchor })}
            onHoverEnd={() => setHovered(null)}
            onPeek={(card, anchor) => setPeek({ card, anchor })}
            onDetails={(card) => {
              setPeek(null);
              setHovered(null);
              setDetail(card);
            }}
          />
        ))}
      </div>

      {pickerSlot && (
        <SavedBuildPicker corpsName={corpsNameOf} onPick={(b) => pickSaved(pickerSlot, b)} onClose={() => setPickerSlot(null)} />
      )}
      {corpsSlot && corpsIndex && (
        <CorpsPickerModal
          index={corpsIndex}
          title={`Choose a corps for army ${plan.slots.findIndex((s) => s.id === corpsSlot) + 1}`}
          onPick={(entry) => chooseCorps(corpsSlot, entry)}
          onClose={() => setCorpsSlot(null)}
        />
      )}
      {detailsOpen && <PlanDetailsModal stats={stats} onClose={() => setDetailsOpen(false)} />}
      {namePrompt && <NamePromptModal {...namePrompt} onClose={() => setNamePrompt(null)} />}
      {shown?.hovered && !shown.peek && <Tooltip card={shown.hovered.card} anchor={shown.hovered.anchor} />}
      {shown?.peek && (
        <Tooltip
          card={shown.peek.card}
          anchor={shown.peek.anchor}
          variant="peek"
          onFullDetails={() => {
            setDetail(shown.peek!.card);
            setPeek(null);
          }}
          onDismiss={() => setPeek(null)}
        />
      )}
      {detail && <DetailsPanel card={detail} onClose={() => setDetail(null)} />}
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
      {pendingShare && (
        <div className="toast share-ready" role="dialog" aria-label="Share plan image">
          <span>Plan image ready.</span>
          <button type="button" className="btn small primary" onClick={sharePending}>
            Share
          </button>
          <button type="button" className="btn small" onClick={() => setPendingShare(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** One medallion per fielded copy, commander first (the order the image uses too). */
function unitsOf(view: SlotView): { cards: UnitCard[]; staffCard: UnitCard | undefined } {
  if (view.kind !== "ready") return { cards: [], staffCard: undefined };
  return {
    cards: view.build.instances.map((i) => view.index.byKey.get(i.unitKey)).filter((c): c is UnitCard => Boolean(c)),
    staffCard: view.build.staffSlotUnitKey ? view.index.byKey.get(view.build.staffSlotUnitKey) : undefined,
  };
}

function ArmyRow({
  number,
  slot,
  view,
  stats,
  entry,
  isFirst,
  isLast,
  canRemove,
  corpsReady,
  onPlayer,
  onOpen,
  onChooseCorps,
  onChangeCorps,
  onLoad,
  onSave,
  onClear,
  onMove,
  onRemove,
  onRetry,
  onHover,
  onHoverEnd,
  onPeek,
  onDetails,
}: {
  number: number;
  slot: PlanSlot;
  view: SlotView;
  stats: ArmyStats | null;
  entry: CorpsEntry | undefined;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  /** False while the corps index is loading or failed: the corps picker can't open. */
  corpsReady: boolean;
  onPlayer: (player: string) => void;
  onOpen: () => void;
  onChooseCorps: () => void;
  onChangeCorps: () => void;
  onLoad: () => void;
  onSave: () => void;
  onClear: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onRetry: () => void;
  onHover: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd: () => void;
  onPeek: (card: UnitCard, anchor: DOMRect) => void;
  onDetails: (card: UnitCard) => void;
}) {
  const build = slot.build;
  const corpsName = build ? entry?.name || build.armyCorpsName || build.factionKey : "";
  const flag = assetUrl(entry?.flag ?? null);
  const summary = stats?.summary;
  const { cards, staffCard } = unitsOf(view);
  const medallion = (card: UnitCard, staff: boolean) => (
    <Medallion
      card={card}
      qty={1}
      selected={!staff}
      inStaffSlot={staff}
      showSpeed
      activateLabel="show details"
      onClick={() => onDetails(card)}
      onContextMenu={() => onDetails(card)}
      onDetails={() => onDetails(card)}
      onHover={onHover}
      onHoverEnd={onHoverEnd}
      onPeek={onPeek}
      peekOn="tap"
    />
  );

  return (
    <section className="plan-army" aria-label={`Army ${number}`}>
      <div className="plan-army-head">
        <span className="plan-num">{number}</span>
        {flag && <img className="plan-flag" src={flag} alt="" />}
        <div className="titles">
          <h2>{build ? corpsName : "Empty slot"}</h2>
          {build && build.name !== corpsName && <div className="sub">{build.name}</div>}
        </div>
        <input
          className="plan-player"
          type="text"
          placeholder="Player"
          aria-label={`Player for army ${number}`}
          value={slot.player}
          maxLength={40}
          onChange={(e) => onPlayer(e.target.value)}
        />
        {stats && <ArmyStatsGrid stats={stats} />}
        <div className="plan-actions">
          {build ? (
            <>
              <button className="btn small primary" onClick={onOpen} disabled={view.kind === "loading"}>
                Open in builder ›
              </button>
              <button className="btn small" onClick={onChangeCorps} disabled={!corpsReady} title={corpsReady ? undefined : CORPS_LOADING_TIP}>
                Change corps
              </button>
              <button className="btn small" onClick={onLoad}>
                Load saved build
              </button>
              <button className="btn small" onClick={onSave}>
                ★ Save to my builds
              </button>
              <button className="btn small" onClick={onClear}>
                Clear
              </button>
            </>
          ) : (
            <>
              <button className="btn small primary" onClick={onChooseCorps} disabled={!corpsReady} title={corpsReady ? undefined : CORPS_LOADING_TIP}>
                Choose corps
              </button>
              <button className="btn small" onClick={onLoad}>
                Load saved build
              </button>
            </>
          )}
          <button className="btn small" onClick={() => onMove(-1)} disabled={isFirst} aria-label="Move army up" title="Move up">
            ↑
          </button>
          <button className="btn small" onClick={() => onMove(1)} disabled={isLast} aria-label="Move army down" title="Move down">
            ↓
          </button>
          {canRemove && (
            <button className="btn small" onClick={onRemove} aria-label="Remove army" title="Remove this army from the plan">
              ✕
            </button>
          )}
        </div>
      </div>

      {view.kind === "empty" && <div className="plan-empty-note">No build in this slot yet.</div>}
      {view.kind === "loading" && <div className="plan-empty-note">Loading {corpsName}…</div>}
      {view.kind === "error" && (
        <div className="error-box notice plan-notice">
          ⚠ Couldn’t load {corpsName}: {view.error}{" "}
          <button className="btn small" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {view.kind === "ready" && (
        <>
          <ArmyNotices violations={summary?.violationMessages ?? []} missing={view.missingKeys.length} />
          <ArmyUnits
            staffCard={staffCard}
            cards={cards}
            medallion={medallion}
            empty={<div className="plan-empty-note">No units yet. Open in builder to build this army.</div>}
          />
        </>
      )}
    </section>
  );
}
