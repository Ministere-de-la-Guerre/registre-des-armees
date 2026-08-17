/** Build-time switch for the pick-rate feature.
 *
 * OFF unless `VITE_PICK_RATES=1` is set for the build, so an ordinary release — a
 * bug-fix beta, say — simply does not contain the feature. Nothing about it is
 * reachable when off: no toggle, no fetch, and vite.config.ts drops the
 * `data/pick-rates/` payload out of `dist/` as well.
 *
 * Ship it with:
 *     VITE_PICK_RATES=1 npm run build          (or the desktop:* / stage scripts)
 *
 * The comparison folds to a literal at build time, so `if (PICK_RATES_ENABLED)`
 * branches are eliminated by the minifier rather than merely skipped at runtime.
 */
export const PICK_RATES_ENABLED = import.meta.env.VITE_PICK_RATES === "1";
