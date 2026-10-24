/** "Builds like yours also took": the suggestions sheet above the build tray (and the
 *  same two rows inside the touch tray's sheet). Pure presentation of a
 *  `Suggestions | SuggestUnavailable` — all the maths is in suggest.ts, and the click
 *  handlers are the builder's own add / swap paths. */
import type { ReactNode } from "react";
import { Medallion } from "../../components/Medallion";
import type { GeneralSuggestion, Suggestions, SuggestUnavailable, UnitSuggestion } from "./suggest";

export type SuggestResult = Suggestions | SuggestUnavailable;

import { basisLine, mp, ordinal, regimentShortName, unavailableMessage } from "./suggestText";

function KBar({ k, K, copy = 1 }: { k: number; K: number; copy?: number }) {
  const pct = K > 0 ? Math.min(100, (100 * k) / K) : 0;
  return (
    <div className="sg-kbar" title={
        copy >= 2
          ? `${k} of the ${K} closest builds took ${copy} or more copies`
          : `${k} of the ${K} closest builds took this`
      }>
      <div className="sg-track">
        <div className="sg-fill" style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <div className="sg-ktext">
        {copy >= 2 ? `${k} of ${K} builds took ${copy}+` : `${k} of ${K} builds`}
      </div>
    </div>
  );
}

function Cost({ delta, over, hint }: { delta: number; over: boolean; hint?: boolean }) {
  return (
    <div className={`sg-cost${delta < 0 ? " down" : ""}`}>
      <span>{mp(delta)}</span>
      {over && <span className="sg-over"> · over budget</span>}
      {hint && delta < 0 && <div className="sg-hint">completes a division</div>}
    </div>
  );
}

function UnitCardView({ s, K, onPick }: { s: UnitSuggestion; K: number; onPick: (s: UnitSuggestion) => void }) {
  const blocked = s.blockedReason !== null;
  return (
    <div className="sg-card" title={blocked ? (s.blockedReason ?? undefined) : undefined}>
      <Medallion
        card={s.card}
        blocked={blocked}
        overBudget={!blocked && s.overBudget}
        onClick={() => onPick(s)}
        activateLabel={s.copy >= 2 ? `add a ${ordinal(s.copy)} copy to your build` : "add it to your build"}
        pickRate={
          <>
            {s.copy >= 2 && <div className="sg-copy">{ordinal(s.copy)} copy</div>}
            <KBar k={s.k} K={K} copy={s.copy} />
            {blocked ? (
              <div className="sg-status bad">{s.blockedReason}</div>
            ) : (
              <Cost delta={s.costDelta} over={s.overBudget} hint />
            )}
          </>
        }
      />
    </div>
  );
}

function GeneralCardView({
  g,
  K,
  onPick,
}: {
  g: GeneralSuggestion;
  K: number;
  onPick: (g: GeneralSuggestion) => void;
}) {
  const blocked = g.blockedReason !== null;
  const have = g.status === "have";
  const reg = regimentShortName(g.regiment);
  let status: ReactNode;
  if (have) status = <div className="sg-status have">✓ In your build</div>;
  else if (blocked) status = <div className="sg-status bad">{g.blockedReason}</div>;
  else
    status = (
      <>
        <div className={`sg-status${g.status === "swap" ? " good" : ""}`}>
          {g.status === "swap" ? `On your ${reg}` : `Adds ${reg}`}
        </div>
        <Cost delta={g.costDelta} over={g.overBudget} />
      </>
    );
  return (
    <div className="sg-card" title={blocked ? (g.blockedReason ?? undefined) : undefined}>
      <Medallion
        card={g.card}
        blocked={blocked}
        overBudget={!blocked && !have && g.overBudget}
        onClick={have ? undefined : () => onPick(g)}
        activateLabel={g.status === "swap" ? "put it in charge of your copy" : "add it to your build"}
        pickRate={
          <>
            <KBar k={g.k} K={K} />
            {status}
          </>
        }
      />
    </div>
  );
}

export function SuggestRows({
  result,
  onPickUnit,
  onPickGeneral,
}: {
  result: Suggestions;
  onPickUnit: (s: UnitSuggestion) => void;
  onPickGeneral: (g: GeneralSuggestion) => void;
}) {
  const full = result.combatUsed >= result.combatCap;
  return (
    <div className="sg-rows">
      <div className="sg-label">Units</div>
      {result.units.length === 0 ? (
        <p className="sg-empty">Nothing more to suggest — builds like yours didn’t take anything else.</p>
      ) : (
        <div className="sg-row">
          {result.units.map((u) => (
            <UnitCardView key={u.card.unitKey} s={u} K={result.K} onPick={onPickUnit} />
          ))}
        </div>
      )}
      <div className="sg-label">
        Combat generals
        <span className={`sg-used${full ? " full" : ""}`}>
          {full
            ? `${result.combatUsed} of ${result.combatCap} used · limit reached`
            : `${result.combatUsed} of ${result.combatCap} used · ${result.combatCap - result.combatUsed} left`}
        </span>
      </div>
      {result.generals.length === 0 ? (
        <p className="sg-empty">No combat generals to suggest.</p>
      ) : (
        <div className="sg-row">
          {result.generals.map((g) => (
            <GeneralCardView key={g.card.unitKey} g={g} K={result.K} onPick={onPickGeneral} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SuggestPanel({
  result,
  seasonLabel,
  onPickUnit,
  onPickGeneral,
  onClose,
}: {
  result: SuggestResult;
  seasonLabel: string;
  onPickUnit: (s: UnitSuggestion) => void;
  onPickGeneral: (g: GeneralSuggestion) => void;
  onClose: () => void;
}) {
  return (
    <section className="sg-sheet" aria-label="Suggested units">
      <div className="sg-head">
        <div className="sg-head-text">
          <h3 className="sg-title">Builds like yours also took</h3>
          <div className="sg-basis">
            {result.kind === "ok" ? basisLine(result, seasonLabel) : unavailableMessage(result)}
          </div>
        </div>
        <button type="button" className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      {result.kind === "ok" && (
        <>
          <SuggestRows result={result} onPickUnit={onPickUnit} onPickGeneral={onPickGeneral} />
          <p className="sg-foot">Click a unit or general to add it. Both rows refresh as your build changes.</p>
        </>
      )}
    </section>
  );
}

/** Touch variant: the same rows (and the basis / reason line) inside the tray sheet. */
export function SuggestInline({
  result,
  seasonLabel,
  onPickUnit,
  onPickGeneral,
}: {
  result: SuggestResult;
  seasonLabel: string;
  onPickUnit: (s: UnitSuggestion) => void;
  onPickGeneral: (g: GeneralSuggestion) => void;
}) {
  return (
    <section className="sg-inline" aria-label="Suggested units">
      <h3 className="sg-title">Builds like yours also took</h3>
      <div className="sg-basis">{result.kind === "ok" ? basisLine(result, seasonLabel) : unavailableMessage(result)}</div>
      {result.kind === "ok" && <SuggestRows result={result} onPickUnit={onPickUnit} onPickGeneral={onPickGeneral} />}
    </section>
  );
}
