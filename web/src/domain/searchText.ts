// Accent-insensitive, order-independent search matching so English-keyboard users
// can find accented / decorated names without typing the accents, the digraphs, or
// the decorative "[year] N." prefixes and punctuation the names carry.
//
// A name is folded two ways and a query token matches if it is a substring of
// *either* fold, so both common English transliterations of an accented letter work:
//   - digraph expansion  (ä→ae, ö→oe, ü→ue, ß→ss, æ→ae, œ→oe): "oesterreich",
//     "jaeger", "strasse" match "Österreich", "Jäger", "Straße".
//   - plain diacritic drop (ö→o, ü→u, é→e, ñ→n, ç→c, …): "osterreich", "jager",
//     "leger", "espana" match the same names.
// The query is matched token-by-token (whitespace-split), each token independently
// and in any order, so "france allemagne" and "allemagne france" both find
// "[1805] 11. France (Allemagne)" — no need to type the bracketed year or the number.

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Plain diacritic drop: lowercase + strip combining marks (ö→o, é→e, ñ→n, …). */
function foldPlain(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "");
}

/** Digraph-expanded fold: German / Scandinavian / ligature expansion, then plain. */
export function foldForSearch(text: string): string {
  return foldPlain(
    text
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe"),
  );
}

/** True when every whitespace-separated token of `query` appears (in any order,
 *  accent-insensitively) somewhere in `haystack`. An empty query matches everything. */
export function matchesSearch(haystack: string, query: string): boolean {
  const q = foldPlain(query).trim();
  if (!q) return true;
  const expanded = foldForSearch(haystack);
  const plain = foldPlain(haystack);
  return q.split(/\s+/).every((token) => expanded.includes(token) || plain.includes(token));
}
