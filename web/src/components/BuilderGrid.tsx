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
  staffBlocked: (card: UnitCard) => boolean;
  qtyOf: (key: string) => number;
  groupQtyOf: (card: UnitCard) => number;
  atCapOf: (card: UnitCard) => boolean;
  onAdd: (card: UnitCard) => void;
  onDetails: (card: UnitCard) => void;
  onHover: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd: () => void;
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
      dimmed={h.isDimmed(card)}
      blocked={blocked}
      atCap={h.atCapOf(card)}
      onClick={() => h.onAdd(card)}
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
  handlers,
  onStaffToggle,
}: {
  staffGenerals: UnitCard[];
  divisions: DivisionGroup[];
  divisionMeta: Map<number, GroupMeta>;
  brigadeMeta: Map<string, GroupMeta>;
  handlers: MedallionHandlers;
  onStaffToggle: (card: UnitCard) => void;
}) {
  return (
    <>
      {/* Row 1: staff generals (left-click sets the corps commander). */}
      {staffGenerals.length > 0 && (
        <div className="gens-row" aria-label="Staff generals">
          <span className="gens-tag">Staff</span>
          {sortStaffGenerals(staffGenerals).map((g) => (
            <Medallion
              key={g.unitKey}
              card={g}
              selected={handlers.inStaffSlot(g.unitKey)}
              inStaffSlot={handlers.inStaffSlot(g.unitKey)}
              dimmed={handlers.isDimmed(g)}
              blocked={!handlers.inStaffSlot(g.unitKey) && handlers.staffBlocked(g)}
              onClick={() => onStaffToggle(g)}
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
              <span className="dn">{roman(dv.division)}</span>
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
                    {orderBrigadeCards(br.cards).map((card) => (
                      <UnitMedallion key={card.unitKey} card={card} h={handlers} />
                    ))}
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
