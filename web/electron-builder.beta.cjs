// electron-builder config for the BETA channel.
//
// This builds the beta as a *separate application* from the stable release: a
// distinct appId, product name, install directory, Start-menu/desktop shortcut,
// and (because Electron derives userData from the product name) its own saved
// data. So the beta installs ALONGSIDE the stable release and neither one
// downgrades or overwrites the other.
//
// It also publishes/auto-updates from a DEDICATED beta releases repo, so the
// beta only ever sees beta releases and never cross-updates to (or from) the
// stable line. electron-updater's GitHub provider deliberately rolls a
// prerelease client forward onto a newer *stable* release when they share one
// repo, so true channel separation requires separate repos — this config is the
// beta half of that split. The stable build keeps using the package.json
// "build" field unchanged.
//
// Build it with:  npm run desktop:beta            (local, no publish)
//                 npm run desktop:beta:release    (publish to the beta repo)
// The version in package.json must be a prerelease (e.g. 1.3.5-beta.1) so the
// app's allowPrerelease (= /-/.test(version)) is true on the beta channel.

const base = require("./package.json").build;

/** Beta releases live in this repo, separate from the stable `registre-des-armees`. */
const BETA_REPO = "registre-des-armees-beta";

module.exports = {
  ...base,
  appId: `${base.appId}.beta`,
  productName: `${base.productName} Beta`,
  // Override the bundled package.json "name" so the beta gets its OWN runtime
  // app name. That name drives both Electron's userData folder (app.getName(),
  // which falls back to "name" since there is no top-level productName) and
  // electron-builder's updaterCacheDirName ("<name>-updater"). Without this the
  // beta would share saved builds AND the update-download cache with the stable
  // app — defeating the separation. Stable keeps the base "registre-des-armees".
  extraMetadata: { name: "registre-des-armees-beta" },
  nsis: {
    ...base.nsis,
    shortcutName: `${base.nsis.shortcutName} Beta`,
    artifactName: "RegistreDesArmeesBeta-Setup-${version}.${ext}",
  },
  portable: {
    ...base.portable,
    artifactName: "RegistreDesArmeesBeta-Portable-${version}.${ext}",
  },
  publish: [{ ...base.publish[0], repo: BETA_REPO }],
};
