/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** "1" ships the optional pick-rate feature; anything else leaves it out of the
   *  build entirely. See src/features/pickRates/flag.ts. */
  readonly VITE_PICK_RATES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
