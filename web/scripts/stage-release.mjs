// Stage the built desktop artifacts for a MANUAL GitHub release.
//
// electron-builder writes everything into web/release/ (and each build
// overwrites it). This copies only the files a release actually needs, for the
// requested channel + the current package.json version, into a clean curated
// folder at the repo root:
//
//   stable -> _github_assets/        beta -> _github_assets_beta/
//
// After running this the folder holds exactly the intended version and nothing
// else, so releasing is: go to GitHub -> Draft a new release -> create tag
// v<version> -> drag in every file from this folder -> Publish (never tick
// "Pre-release"). See docs/HANDOFF.md "Release workflow".
//
// Usage:  node scripts/stage-release.mjs <stable|beta>
// Normally invoked via `npm run desktop:stage` / `npm run desktop:beta:stage`,
// which build first and then stage.

import { readFileSync, rmSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webDir = join(scriptDir, "..");
const repoRoot = join(webDir, "..");
const releaseDir = join(webDir, "release");

const channel = process.argv[2];
if (channel !== "stable" && channel !== "beta") {
  console.error(`Usage: node scripts/stage-release.mjs <stable|beta>  (got: ${channel ?? "nothing"})`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
const prefix = channel === "beta" ? "RegistreDesArmeesBeta" : "RegistreDesArmees";
const destDir = join(repoRoot, channel === "beta" ? "_github_assets_beta" : "_github_assets");

// Setup .exe + its .blockmap + latest.yml are the three the auto-updater needs;
// without any one of them installed clients won't see the update. The portable
// .exe is a convenience download only (never used by the updater).
const required = [
  `${prefix}-Setup-${version}.exe`,
  `${prefix}-Setup-${version}.exe.blockmap`,
  "latest.yml",
];
const optional = [`${prefix}-Portable-${version}.exe`];

if (!existsSync(releaseDir)) {
  console.error(`No build output at ${releaseDir}. Run the desktop build first (npm run desktop${channel === "beta" ? ":beta" : ""}).`);
  process.exit(1);
}

// Start clean so the folder only ever holds the intended version.
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });

// latest.yml is not version-stamped in its filename, so an old one can linger in
// web/release from a previous build. Refuse to stage a mismatched channel file —
// shipping a stale latest.yml would point the updater at the wrong version.
const latestYmlPath = join(releaseDir, "latest.yml");
if (existsSync(latestYmlPath)) {
  const stampedVersion = /^version:\s*(.+)$/m.exec(readFileSync(latestYmlPath, "utf8"))?.[1]?.trim();
  if (stampedVersion !== version) {
    console.error(`web/release/latest.yml is version ${stampedVersion ?? "(unreadable)"}, not ${version}.`);
    console.error(`It is stale from an earlier build. Re-run the ${channel} build for ${version} first.`);
    process.exit(1);
  }
}

const missing = [];
for (const name of required) {
  const src = join(releaseDir, name);
  if (existsSync(src)) {
    copyFileSync(src, join(destDir, name));
    console.log(`  staged   ${name}`);
  } else {
    missing.push(name);
  }
}
for (const name of optional) {
  const src = join(releaseDir, name);
  if (existsSync(src)) {
    copyFileSync(src, join(destDir, name));
    console.log(`  staged   ${name}  (optional)`);
  } else {
    console.warn(`  skipped  ${name}  (optional, not built)`);
  }
}

if (missing.length > 0) {
  console.error(`\nMissing required artifact(s) for ${version}: ${missing.join(", ")}`);
  console.error(`Did the ${channel} build for this version run? Each build overwrites web/release/.`);
  process.exit(1);
}

console.log(`\nStaged ${channel} v${version} -> ${destDir}`);
console.log(`Next: GitHub -> Draft a new release -> tag v${version} -> upload every file above -> Publish (do NOT tick "Pre-release").`);
