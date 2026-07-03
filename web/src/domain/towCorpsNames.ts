import type { UnitCard } from "./types";
import { towSourceCorpsIdOf } from "./tow";

/** Source-corps id of a card, tolerating un-normalized cards by parsing the key
 *  (mirrors towRoll's helper) so this works before/after load.ts normalization. */
function idOf(card: Pick<UnitCard, "unitKey" | "towSourceCorpsId">): string | null {
  return card.towSourceCorpsId ?? towSourceCorpsIdOf(card.unitKey);
}

// Nobiliary particles kept attached to a surname for display ("von Essen",
// "de Tolly"). Lowercase; matched case-insensitively.
const NOBILIARY = new Set([
  "de", "von", "van", "der", "den", "di", "du", "del", "della", "la", "le", "af", "zu", "ten", "ter", "dos", "das",
]);

/** Display surname for a historical general name.
 *
 *  Names carry decorations that must be stripped first: a space-delimited quoted
 *  nickname ("Louis Nicolas Davout 'le Maréchal de Fer'" → Davout), which may
 *  itself contain elided apostrophes ("'l'Enfant chéri de la Victoire'"), and/or
 *  a bracketed code ("Joachim Murat … [C4]" → Murat). The nickname strip anchors
 *  on space+quote so genuine name-internal apostrophes survive ("d'Erlon",
 *  "da'Woud", "von L'Estocq").
 *
 *  From the cleaned name the surname is the last word, absorbing leading
 *  nobiliary particles: "von Essen", "de Beauharnais". Compound surnames such as
 *  "Barclay de Tolly" render from the particle on ("de Tolly") — good enough for
 *  a label; the full name stays available. */
/** Full display name with only the bracketed [code] stripped — the given names,
 *  surname, and quoted nickname are all kept (e.g. "Louis Nicolas Davout 'le
 *  Maréchal de Fer' [C4]" → "Louis Nicolas Davout 'le Maréchal de Fer'"). */
export function fullNameWithNickname(fullName: string): string {
  return fullName
    .replace(/\s*\[[^\]]*\]/g, " ") // [C4]-style codes
    .replace(/\s+/g, " ")
    .trim();
}

/** Cleaned full display name: the general's given names + surname with the quoted
 *  nickname and any bracketed [code] stripped (e.g. "Louis Nicolas Davout 'le
 *  Maréchal de Fer' [C4]" → "Louis Nicolas Davout"). */
export function cleanFullName(fullName: string): string {
  return fullNameWithNickname(fullName)
    .replace(/\s+['’].*['’]/, " ") // greedy: first space-quote to the last quote
    .replace(/\s+/g, " ")
    .trim();
}

export function surnameOf(fullName: string): string {
  const cleaned = cleanFullName(fullName);
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return fullName.trim();
  if (parts.length === 1) return parts[0];
  let i = parts.length - 1;
  while (i > 1 && NOBILIARY.has(parts[i - 1].toLowerCase())) i--;
  return parts.slice(i).join(" ");
}

/** The commander of a TOW source corps: its highest-star staff general (a corps
 *  can hold several), tie-broken by cost then roster order. A source corps is
 *  named after this general — that is the army-corps name. */
export function corpsCommanderCard(cards: readonly UnitCard[], sourceCorpsId: string): UnitCard | null {
  let best: UnitCard | null = null;
  for (const c of cards) {
    if (idOf(c) !== sourceCorpsId) continue;
    if (!c.isGeneral || c.generalKind !== "staff") continue;
    const stars = c.commandStars ?? 0;
    const bestStars = best ? best.commandStars ?? 0 : -1;
    if (
      !best ||
      stars > bestStars ||
      (stars === bestStars && (c.cost > best.cost || (c.cost === best.cost && c.rosterIndex < best.rosterIndex)))
    ) {
      best = c;
    }
  }
  return best;
}

/** Maps every source-corps id in a roster to its commander's name, rendered by
 *  `render` (surname for compact grid labels, full name for the corps-roll list). */
function towCorpsNameMapWith(
  cards: readonly UnitCard[],
  render: (name: string) => string,
): Map<string, string> {
  const ids = new Set<string>();
  for (const c of cards) {
    const id = idOf(c);
    if (id) ids.add(id);
  }
  const out = new Map<string, string>();
  for (const id of ids) {
    const cmd = corpsCommanderCard(cards, id);
    if (cmd) out.set(id, render(cmd.name));
  }
  return out;
}

/** Maps every source-corps id in a roster to its commander's display surname. */
export function towCorpsNameMap(cards: readonly UnitCard[]): Map<string, string> {
  return towCorpsNameMapWith(cards, surnameOf);
}

/** Maps every source-corps id in a roster to its commander's full name, including
 *  any quoted nickname (only the bracketed [code] is stripped). */
export function towCorpsFullNameMap(cards: readonly UnitCard[]): Map<string, string> {
  return towCorpsNameMapWith(cards, fullNameWithNickname);
}
