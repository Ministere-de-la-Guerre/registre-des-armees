// Pieces of the planner screen that the live PlannerScreen and the read-only
// PlanExportView (the "Copy image" snapshot) both render, so the image is the same
// markup as the screen and cannot drift from it.

import { MAX_BUILD_COST, MAX_TOTAL_UNIT_CARDS } from "../rules/rules";
import type { UnitCard } from "../domain/types";
import type { ArmyStats, PlanStats } from "../state/planStats";
import { SHARE_LABELS, type PlanPoints, plural, shareSegments, warningText } from "../state/planSummary";
import type { ReactNode } from "react";

/** The POINTS chip. `title` is the live screen's breakdown tooltip. `pending` shows a
 *  dash while the corps index (the source of the ratings) has not loaded: every corps
 *  would otherwise read as unrated. */
export function PlanPointsChip({ points, title, pending }: { points: PlanPoints; title?: string; pending?: boolean }) {
  return (
    <div className="plan-points" title={title}>
      <span className="lbl">Points</span>
      <span className="val">
        {pending ? (
          "–"
        ) : (
          <>
            {points.total}
            {points.unrated.length > 0 && <span className="plan-points-note">*</span>}
          </>
        )}
      </span>
    </div>
  );
}

/** The combined stats across the whole team. */
export function PlanTotals({ stats }: { stats: PlanStats }) {
  const combatCapTotal = stats.perArmy.reduce((t, a) => t + (a?.combatCap ?? 0), 0);
  const totalOver = stats.cost > stats.budget;
  // Over is judged per army: one army past its cap is a problem even when another has
  // room to spare, which the summed totals would hide.
  const overCap = stats.perArmy.flatMap((a, i) => (a && a.combatGens > a.combatCap ? [`Army ${i + 1}`] : []));
  return (
    <div className="plan-stats">
      <div className="hstat">
        <div className="lbl">Men</div>
        <div className="val">{stats.men.toLocaleString()}</div>
      </div>
      <div className="hstat">
        <div className="lbl">Cards</div>
        <div className="val">{stats.cards}</div>
      </div>
      <div className="hstat" title="Total cost against the budget of the armies present">
        <div className="lbl">Cost / budget</div>
        <div className={`val cost${totalOver ? " over" : ""}`}>
          {stats.cost.toLocaleString()}
          <span className="plan-of"> / {stats.budget.toLocaleString()}</span>
        </div>
      </div>
      <div
        className="hstat"
        title={
          overCap.length > 0
            ? `Over the combat-general cap: ${overCap.join(", ")}`
            : "Combat generals against the corps caps, summed over the armies"
        }
      >
        <div className="lbl">Combat gens</div>
        <div className={`val${overCap.length > 0 ? " over" : ""}`}>
          {stats.combatGens}/{combatCapTotal}
        </div>
      </div>
      <div className="hstat" title="Cavalry cards in the whole team">
        <div className="lbl">Cavalry</div>
        <div className="val">{stats.cavalry.totalCards}</div>
      </div>
      <div className="hstat" title="Guns in the whole team (not batteries)">
        <div className="lbl">Guns</div>
        <div className="val">{stats.guns.total}</div>
      </div>
    </div>
  );
}

/** The gold-weighted share bar (segments sized by gold spent per arm) with its legend. */
export function PlanShare({ stats }: { stats: PlanStats }) {
  const segments = shareSegments(stats.share);
  return (
    <div className="plan-share" title="Share of the gold spent (listed prices), by arm">
      <div className="plan-share-bar" role="img" aria-label={segments.map((s) => `${SHARE_LABELS[s.arm]} ${s.goldPct}%`).join(", ")}>
        {segments
          .filter((s) => s.gold > 0)
          .map((s) => (
            <span
              key={s.arm}
              className={`seg ${s.arm}`}
              style={{ flexGrow: s.gold }}
              title={`${SHARE_LABELS[s.arm]}: ${s.gold.toLocaleString()} gold (${s.goldPct}%) · ${plural(s.cards, "card")} · ${s.men.toLocaleString()} men`}
            />
          ))}
      </div>
      <div className="plan-share-legend">
        {segments.map((s) => (
          <span key={s.arm} title={`${s.gold.toLocaleString()} gold · ${plural(s.cards, "card")} · ${s.men.toLocaleString()} men`}>
            <i className={`sw ${s.arm}`} />
            {SHARE_LABELS[s.arm]} {s.goldPct}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** The rolled-up warnings (first two, then "+N more"); nothing when there are none. */
export function PlanWarnings({ stats }: { stats: PlanStats }) {
  const shown = stats.warnings.slice(0, 2);
  if (shown.length === 0) return null;
  return (
    <span className="plan-warn" title={stats.warnings.map(warningText).join("\n")}>
      ⚠ {shown.map(warningText).join(" · ")}
      {stats.warnings.length > shown.length && ` · +${stats.warnings.length - shown.length} more`}
    </span>
  );
}

/** One army's title-bar stats. */
export function ArmyStatsGrid({ stats }: { stats: ArmyStats }) {
  const summary = stats.summary;
  const overCards = summary.totalCards > MAX_TOTAL_UNIT_CARDS;
  const overCost = summary.price.finalCost > MAX_BUILD_COST;
  return (
    <div className="plan-stats">
      <div className="hstat">
        <div className="lbl">Cards</div>
        <div className={`val${overCards ? " over" : ""}`}>
          {summary.totalCards}/{MAX_TOTAL_UNIT_CARDS}
        </div>
      </div>
      <div className="hstat">
        <div className="lbl">Total men</div>
        <div className="val">{summary.totalMen.toLocaleString()}</div>
      </div>
      <div className="hstat" title="Combat generals selected against the corps cap">
        <div className="lbl">Combat gens</div>
        <div className={`val${stats.combatGens > stats.combatCap ? " over" : ""}`}>
          {stats.combatGens}/{stats.combatCap}
        </div>
      </div>
      {stats.towCorps && (
        <div className="hstat" title="Distinct army corps your selected units draw from. The game rolls only 4 corps together.">
          <div className="lbl">Corps</div>
          <div className={`val${stats.towCorps.over ? " over" : ""}`}>
            {stats.towCorps.count}/{stats.towCorps.max}
          </div>
        </div>
      )}
      <div className="hstat" title="Selected unit cards able to form square, out of your total infantry (skirmishers excluded)">
        <div className="lbl">Squares</div>
        <div className="val">
          {summary.totalSquares}/{summary.totalInfantry}
        </div>
      </div>
      <div className="hstat">
        <div className="lbl">Cost / {MAX_BUILD_COST.toLocaleString()}</div>
        <div className={`val cost${overCost ? " over" : ""}`}>{summary.price.finalCost.toLocaleString()}</div>
      </div>
      <div className="hstat" title="Gold still available before the cost limit">
        <div className="lbl">Gold left</div>
        <div className={`val cost${overCost ? " over" : ""}`}>{Math.max(0, MAX_BUILD_COST - summary.price.finalCost).toLocaleString()}</div>
      </div>
    </div>
  );
}

/** The army's violation and missing-unit notices. */
export function ArmyNotices({ violations, missing }: { violations: readonly string[]; missing: number }) {
  return (
    <>
      {violations.length > 0 && <div className="error-box notice plan-notice">⚠ {violations.join(" · ")}</div>}
      {missing > 0 && (
        <div className="error-box notice plan-notice">
          ⚠ {plural(missing, "unit")} {missing === 1 ? "isn't" : "aren't"} in the current game data and will be removed when you next
          edit this army in the builder.
        </div>
      )}
    </>
  );
}

/** One medallion per fielded copy, the commander (staff general) first. `empty` is the
 *  live screen's hint for an army with no units yet. */
export function ArmyUnits({
  staffCard,
  cards,
  medallion,
  empty,
}: {
  staffCard: UnitCard | undefined;
  cards: readonly UnitCard[];
  medallion: (card: UnitCard, staff: boolean) => ReactNode;
  empty?: ReactNode;
}) {
  return (
    <div className="plan-units">
      {staffCard && <div className="plan-unit">{medallion(staffCard, true)}</div>}
      {cards.map((card, i) => (
        <div className="plan-unit" key={`${card.unitKey}-${i}`}>
          {medallion(card, false)}
        </div>
      ))}
      {!staffCard && cards.length === 0 && empty}
    </div>
  );
}
