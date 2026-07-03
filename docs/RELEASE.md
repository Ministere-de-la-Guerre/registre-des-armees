# Release & update channels

How the desktop app is packaged, versioned, and shipped, and the stable/beta
auto-update design. Split out of `HANDOFF.md` because it's only needed when
cutting a release. For packaging internals see also `web/DESKTOP.md`.

## Channels: stable vs beta

**Stable and beta are separate apps updating from separate repos** — they
install side-by-side and never cross-update. Separation is achieved by the
separate repos alone (each app bundles its own `app-update.yml`), NOT by
GitHub's "Pre-release" flag, so **both channels publish NORMAL "latest"
releases** and both run `allowPrerelease=false`. A beta client on
`1.4.0-beta.1` still updates to a normal release tagged `1.4.0-beta.2` because
the provider resolves `/releases/latest` → `latest.yml`; GitHub's
`/releases/latest` excludes only releases whose Pre-release CHECKBOX is ticked,
not versions whose string contains a hyphen. The `-beta.N` suffix is cosmetic
(lets users see they're on beta) and does not drive the channel.

- **Stable:** `package.json` "build". appId `fr.ministeredelaguerre.registredesarmees`, product "Registre des Armées", name `registre-des-armees`, repo `registre-des-armees`. `npm run desktop[:release|:stage]`. Artifacts `RegistreDesArmees-Setup/Portable-<v>.exe`.
- **Beta:** `electron-builder.beta.cjs` spreads "build" and overrides `appId+".beta"`, `product+" Beta"`, `extraMetadata.name=registre-des-armees-beta`, `publish.repo=registre-des-armees-beta`, `publish.releaseType="release"` (publish directly as a normal release, never draft/pre-release). Version is a `-beta.N` string (e.g. `1.4.0-beta.3`). `npm run desktop:beta[:release|:stage]` (release needs `GH_TOKEN` for the beta repo). Artifacts `RegistreDesArmeesBeta-*`.
- **`extraMetadata.name` is essential:** `userData` (`app.getName()` → package name) and `updaterCacheDirName` (`<name>-updater`) both derive from the package name, so overriding it gives beta its own saved builds + update cache; without it the two collide despite different appIds.
- Runtime channel: `allowPrerelease = false` (both apps). Each app bundles `app-update.yml` for its own repo; the update path is `/releases/latest` → `latest.yml` on that repo.
- **Publishing rule: never tick GitHub's "Pre-release" box** for either channel. If a release is (or was) marked Pre-release, `allowPrerelease=false` clients won't see it via `/releases/latest` — untick it and Set as latest. `desktop:beta:release` already publishes as a normal release automatically.

## Release workflow (manual-draft, the default)

> **Windows only.** The build must run on **Windows**. electron-builder can't
> cross-build the NSIS `.exe` from Linux/WSL (no wine), so from WSL the build
> step fails and `_github_assets*/` can't be populated — run it from a Windows
> terminal. The staging step alone (`npm run stage[:beta]`) is cross-platform if
> the artifacts already sit in `web/release/`.

The intended flow leaves everything staged so the only hand step is the GitHub draft:

1. Bump `version` in `web/package.json` and commit (`Release v<version>`).
2. On **Windows**: `npm run desktop:beta:stage` (beta) or `npm run desktop:stage` (stable). This builds, then runs `scripts/stage-release.mjs`, which copies exactly the Setup `.exe` + `.blockmap` + `latest.yml` (+ portable) for the current version into a freshly-cleaned `_github_assets_beta/` (or `_github_assets/`). It refuses to stage a `latest.yml` whose version doesn't match `package.json`, so a stale channel file can't slip through. These folders are gitignored (large local binaries).
3. On GitHub → the correct repo (**beta → `registre-des-armees-beta`**, stable → `registre-des-armees`) → **Draft a new release** → **Create new tag** `v<version>` → drag in every file from the staged folder → **Publish**. Never tick "Pre-release".

The Setup `.exe` + `.blockmap` + `latest.yml` are all **required** for auto-update; the portable `.exe` is a manual-download convenience the updater never uses.

`:release` (`npm run desktop:beta:release`) is the fully-automated alternative — it builds, creates the tag, and uploads the three required files in one step (needs `GH_TOKEN` for the target repo). Use `:stage` when you want to draft + attach the files yourself; `:release` when you want it hands-off.

Each `desktop*` run overwrites `web/release/`; copy/stage artifacts before building the other channel.

## Before release

1. `web/package.json` version correct.
2. `npm test` green.
3. `npm run build` clean.
4. `npm run desktop:beta:stage` / `npm run desktop:stage` emits installer/portable/latest/blockmap **and** stages them.
5. The curated `_github_assets*/` folder holds only the intended version.
6. Draft + upload on GitHub per the workflow above.

## Beta-updater caveat (stuck clients)

Clients shipped under the OLD single-repo/shared-appId scheme (≤ v1.3.4 stable,
v1.3.3-beta.1) can't be retro-fixed. **`1.4.0-beta.1` clients are also
permanently stuck** and can only reach beta.2+ via a one-time MANUAL reinstall:
they hardcoded `allowPrerelease=true`, and electron-updater's GitHubProvider
with `allowPrerelease=true` does NOT choose the highest version — it walks
`/releases.atom` and takes the first channel-matching entry. That feed is
ordered by tag commit-date, not semver, and lists `v1.4.0-beta.1` ahead of
`v1.4.0-beta.2`, so a beta.1 client re-selects itself and reports "up to date".
This is exactly why `main.cjs` pins `allowPrerelease=false`
(→ `/releases/latest` → `latest.yml`, which honors GitHub's real "Latest"
pointer). Every build from `1.4.0-beta.2` onward carries the fix and
auto-updates normally.
