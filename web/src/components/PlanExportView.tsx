// The planner as a still picture: the header, the combined strip and every army that
// has a build, rendered with the live screen's own components and classes but with no
// buttons, inputs, empty slots, hints or medallion handlers. It is only ever mounted
// offscreen by renderPlanImage, which snapshots it for "Copy image".

import type { UnitCard } from "../domain/types";
import type { ArmyStats, PlanStats } from "../state/planStats";
import type { PlanPoints } from "../state/planSummary";
import { Medallion } from "./Medallion";
import { ArmyNotices, ArmyStatsGrid, ArmyUnits, PlanPointsChip, PlanShare, PlanTotals, PlanWarnings } from "./PlanParts";

export interface ExportRow {
  number: number;
  corpsName: string;
  /** The build's name when it differs from the corps name (shown as the subtitle). */
  buildName: string;
  flag: string | null;
  /** Trimmed player label; empty when unset. */
  player: string;
  stats: ArmyStats;
  violations: readonly string[];
  missing: number;
  cards: readonly UnitCard[];
  staffCard: UnitCard | undefined;
}

export interface PlanExportProps {
  name: string;
  points: PlanPoints;
  stats: PlanStats;
  rows: readonly ExportRow[];
}

// No onClick / hover / peek: the picture has nothing to act on, and the touch
// branches inside Medallion only ever wire those handlers.
const inertMedallion = (card: UnitCard, staff: boolean) => (
  <Medallion card={card} qty={1} selected={!staff} inStaffSlot={staff} showSpeed />
);

export function PlanExportView({ name, points, stats, rows }: PlanExportProps) {
  return (
    <div className="corps-screen plan-screen plan-export">
      <div className="plan-top">
        <div className="plan-toolbar">
          <div className="plan-titles">
            <strong>⚑ Ordre de Bataille</strong>
            <span className="plan-name">{name}</span>
          </div>
          <PlanPointsChip points={points} />
        </div>
        <div className="plan-strip">
          <PlanTotals stats={stats} />
          <PlanShare stats={stats} />
          <div className="plan-strip-end">
            <PlanWarnings stats={stats} />
          </div>
        </div>
        {points.unrated.length > 0 && (
          <div className="plan-export-note">* Not counted in points (no rating): {points.unrated.join(", ")}</div>
        )}
      </div>

      <div className="plan-armies">
        {rows.map((row) => (
          <section className="plan-army" aria-label={`Army ${row.number}`} key={row.number}>
            <div className="plan-army-head">
              <span className="plan-num">{row.number}</span>
              {row.flag && <img className="plan-flag" src={row.flag} alt="" />}
              <div className="titles">
                <h2>{row.corpsName}</h2>
                {row.buildName && <div className="sub">{row.buildName}</div>}
              </div>
              {row.player && <span className="plan-player-text">{row.player}</span>}
              <ArmyStatsGrid stats={row.stats} />
            </div>
            <ArmyNotices violations={row.violations} missing={row.missing} />
            <ArmyUnits staffCard={row.staffCard} cards={row.cards} medallion={inertMedallion} />
          </section>
        ))}
      </div>
    </div>
  );
}
