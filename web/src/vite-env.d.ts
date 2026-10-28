/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** "1" ships the optional pick-rate feature; anything else leaves it out of the
   *  build entirely. See src/features/pickRates/flag.ts. */
  readonly VITE_PICK_RATES?: string;
  /** GoatCounter site code; empty turns usage counting off. See src/analytics.ts. */
  readonly VITE_GOATCOUNTER_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
