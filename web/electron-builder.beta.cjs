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
// stable line. Because the repos are fully separate, the beta does NOT use
// GitHub's "Pre-release" flag: every beta release is published as a NORMAL
// "latest" release, and both apps auto-update via allowPrerelease=false ->
// /releases/latest -> latest.yml (see web/electron/main.cjs). The stable build
// keeps using the package.json "build" field unchanged.
//
// Build it with:  npm run desktop:beta            (local, no publish)
//                 npm run desktop:beta:release    (publish to the beta repo)
// The `releaseType: "release"` below makes :release create a normal, published
// release (not a draft, not a pre-release) with the Setup .exe + .blockmap +
// latest.yml auto-uploaded, so beta clients auto-update with no manual GitHub
// step. The version stays a `-beta.N` prerelease string purely so users can SEE
// they are on the beta line; it no longer drives the update channel.

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
  // releaseType "release" -> publish directly as a normal (non-draft,
  // non-prerelease) GitHub release, which GitHub then marks "latest". This is
  // what lets allowPrerelease=false clients find the beta via /releases/latest.
  publish: [{ ...base.publish[0], repo: BETA_REPO, releaseType: "release" }],
};
