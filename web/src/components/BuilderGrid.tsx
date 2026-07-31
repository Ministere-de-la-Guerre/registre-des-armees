import type { UnitCard } from "../domain/types";
import { orderBrigadeCards, sortStaffGenerals } from "../state/ordering";
import { Medallion } from "./Medallion";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n: number) => ROMAN[n] ?? String(n);

export interface GroupMeta {
  required: number;
  selected: number;
  complete: boolean;
  discount: number;
}

export interface DivisionGroup {
  division: number;
  brigades: { brigade: number; cards: UnitCard[] }[];
}

export interface MedallionHandlers {
  isSelected: (key: string) => boolean;
  inStaffSlot: (key: string) => boolean;
  isDimmed: (card: UnitCard) => boolean;
  isBlocked: (card: UnitCard) => boolean;
  /** True when selecting the card would push the build past the 10,000 ceiling. */
  isOverBudget: (card: UnitCard) => boolean;
  /** True when the card is from a source corps beyond the 4-corps roll limit (TOW). */
  isOverCorps: (card: UnitCard) => boolean;
  qtyOf: (key: string) => number;
  groupQtyOf: (card: UnitCard) => number;
  atCapOf: (card: UnitCard) => boolean;
  /** Grid tap. Desktop: add immediately. Touch: first tap primes + peeks, a second
   *  tap on the same unit adds (see Builder's primeOrAct). */
  onAdd: (card: UnitCard, anchor?: DOMRect) => void;
  /** Grid secondary. Desktop: right-click → full details. Touch: long-press →
   *  remove one copy from the bar (deselect). */
  onDetails: (card: UnitCard) => void;
  onHover: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd: () => void;
  /** True when this unit is the touch-"primed" one: the next tap runs its action
   *  (add / set commander) instead of re-showing its stat card. Always false on
   *  desktop; drives the primed ring. */
  isPrimed: (key: string) => boolean;
}

function UnitMedallion({ card, h }: { card: UnitCard; h: MedallionHandlers }) {
  // Dim anything that can no longer be added (cap reached, unaffordable, limit hit),
  // even when already selected — there is no separate "selected" highlight any more.
  const blocked = h.isBlocked(card);
  return (
    <Medallion
      card={card}
      qty={h.qtyOf(card.unitKey)}
      capCount={h.groupQtyOf(card)}
      selected={h.isSelected(card.unitKey)}
      inStaffSlot={h.inStaffSlot(card.unitKey)}
      primed={h.isPrimed(card.unitKey)}
      dimmed={h.isDimmed(card)}
      blocked={blocked}
      overBudget={h.isOverBudget(card)}
      overCorps={h.isOverCorps(card)}
      atCap={h.atCapOf(card)}
      onClick={(anchor) => h.onAdd(card, anchor)}
      onContextMenu={() => h.onDetails(card)}
      onHover={h.onHover}
      onHoverEnd={h.onHoverEnd}
    />
  );
}

export function BuilderGrid({
  staffGenerals,
  divisions,
  divisionMeta,
  brigadeMeta,
  divisionNames,
  handlers,
  onStaffToggle,
}: {
  /** Army-corps staff generals rendered as a top "Staff" row (left-click sets the
   *  corps commander). Empty for Theatres-of-War, where staff generals instead sit
   *  inside their source-corps division (Command brigade). */
  staffGenerals: UnitCard[];
  divisions: DivisionGroup[];
  divisionMeta: Map<number, GroupMeta>;
  brigadeMeta: Map<string, GroupMeta>;
  /** Optional per-division display name (TOW: the corps commander's surname).
   *  When present it replaces the Roman-numeral division label. */
  divisionNames?: Map<number, string>;
  handlers: MedallionHandlers;
  onStaffToggle: (card: UnitCard, anchor?: DOMRect) => void;
}) {
  return (
    <>
      {/* Row 1: staff generals (left-click sets the corps commander). Army-corps
          only — TOW passes none here and shows staff inside their division. */}
      {staffGenerals.length > 0 && (
        <div className="gens-row" aria-label="Staff generals">
          <span className="gens-tag">Staff</span>
          {sortStaffGenerals(staffGenerals).map((g) => (
            <Medallion
              key={g.unitKey}
              card={g}
              selected={handlers.inStaffSlot(g.unitKey)}
              inStaffSlot={handlers.inStaffSlot(g.unitKey)}
              primed={handlers.isPrimed(g.unitKey)}
              dimmed={handlers.isDimmed(g)}
              overBudget={handlers.isOverBudget(g)}
              overCorps={handlers.isOverCorps(g)}
              onClick={(anchor) => onStaffToggle(g, anchor)}
              onContextMenu={() => handlers.onDetails(g)}
              onHover={handlers.onHover}
              onHoverEnd={handlers.onHoverEnd}
            />
          ))}
        </div>
      )}

      {/* One explicit container per division (they always stack vertically);
          brigades wrap internally and are separated by gaps + a thin divider. */}
      {divisions.map((dv) => {
        const meta = divisionMeta.get(dv.division);
        const divComplete = meta?.complete ?? false;
        return (
          <section className={`division${divComplete ? " complete" : ""}`} key={dv.division} aria-label={`Division ${dv.division}`}>
            <div className="division-tag">
              <span className="dn">{divisionNames?.get(dv.division) ?? roman(dv.division)}</span>
              {divComplete && <span className="row-disc">−{meta!.discount.toLocaleString()}</span>}
            </div>
            <div className="div-row">
              {dv.brigades.map((br, bi) => {
                const bmeta = brigadeMeta.get(`${dv.division}:${br.brigade}`);
                const brComplete = bmeta?.complete ?? false;
                return (
                  <div
                    className={`brig-group${brComplete ? " complete" : ""}`}
                    key={br.brigade}
                    aria-label={`Brigade ${br.brigade}`}
                  >
                    {bi > 0 && <span className="brig-sep" aria-hidden />}
                    {orderBrigadeCards(br.cards).map((card) =>
                      card.isGeneral && card.generalKind === "staff" ? (
                        <Medallion
                          key={card.unitKey}
                          card={card}
                          selected={handlers.inStaffSlot(card.unitKey)}
                          inStaffSlot={handlers.inStaffSlot(card.unitKey)}
                          primed={handlers.isPrimed(card.unitKey)}
                          dimmed={handlers.isDimmed(card)}
                          overBudget={handlers.isOverBudget(card)}
                          overCorps={handlers.isOverCorps(card)}
                          onClick={(anchor) => onStaffToggle(card, anchor)}
                          onContextMenu={() => handlers.onDetails(card)}
                          onHover={handlers.onHover}
                          onHoverEnd={handlers.onHoverEnd}
                        />
                      ) : (
                        <UnitMedallion key={card.unitKey} card={card} h={handlers} />
                      ),
                    )}
                    {brComplete && !divComplete && (
                      <span className="brig-disc">−{bmeta!.discount.toLocaleString()}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
