# Release & update channels

How the desktop app is packaged, versioned, and shipped, and the stable/beta
auto-update design. Split out of `HANDOFF.md` because it's only needed when
cutting a release. For packaging internals see also `web/DESKTOP.md`. The
**web/PWA channel** (a third target, independent of the two desktop channels) is
documented in its own section below.

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

## Web channel (PWA on GitHub Pages)

A third target alongside stable/beta desktop: the same Vite build served as an
installable, offline-capable PWA. **Fully decoupled from the desktop pipeline** —
it touches none of the `desktop:*` scripts, electron-builder configs, or
`_github_assets*` staging.

- **Hosting: GitHub Pages** (Phase 0 decision). Free + HTTPS for this public
  repo; `base: "./"` in `vite.config.ts` makes the build work from the
  `…github.io/registre-des-armees/` sub-path. The SW scope (`./`) and manifest
  `start_url` (`.`) are relative for the same reason.
  - *One-time setup:* repo **Settings → Pages → Source = "GitHub Actions"**.
    Until this is set, the workflow builds but the deploy step has nowhere to go.
- **Deploy:** `.github/workflows/deploy-web.yml` runs on push to `main` and on
  manual dispatch. It regenerates `web/public/{data,assets}` with the Python
  pipeline (`python tools/build_web_data.py`, needs Pillow), runs
  `typecheck + lint + test`, `npm run build`, and publishes `web/dist` to Pages.
  `web/public/{data,assets}` are gitignored, so regenerating them in CI is
  mandatory — the build won't have data otherwise.
- **Versioning: continuous** (tracks `main`, no per-release tags). The in-app SW
  "new version" toast makes rolling updates safe; runtime data caches are keyed
  by `web/public/data/data-version.json`, so a data rebuild drops stale caches
  automatically (no manual cache-busting).
- **Service worker / caching** (`web/src/sw.ts`, `web/vite.config.ts`): precache
  the shell + corps picker + `assets/ui` + data stamps (~5 MB); the 297 faction
  JSONs and 13.6k unit icons are runtime cache-first (never precached). Users pull
  a faction fully offline with the topbar **"Save offline"** button
  (`web/src/state/offline.ts`). Registration is Electron-guarded
  (`web/src/pwa.ts`) so the desktop app never runs the SW.
- **Player install UX (pure PWA, Phase 0 decision):**
  - *iPhone/iPad (Safari):* Share → **Add to Home Screen** (iOS has no install
    prompt). Launches standalone, works offline.
  - *Android (Chrome):* use the **Install app** prompt / menu entry.
- **Regenerating PWA icons:** `web/build/make_pwa_icons.mjs` (see its header;
  `sharp` is an on-demand tool, not a committed dependency). Outputs live in
  `web/public/` and are committed.

## Release workflow (manual-draft, the default)

> **The build needs the Windows toolchain.** electron-builder can't cross-build
> the NSIS `.exe` from a Linux runtime (no wine), so running the `desktop*`
> scripts under WSL's *Linux* Node fails and `_github_assets*/` can't be
> populated. Two ways to get a real Windows build:
>
> - **A native Windows terminal** — run the `desktop*` scripts there directly.
> - **From WSL via Windows interop** — invoke the *Windows* Node toolchain from
>   the WSL shell so electron-builder runs as a real Windows process (the repo
>   lives on `/mnt/c`, so it writes straight into `web/release/`). This is what
>   the `desktop:beta` / `stage:beta` run below uses.
>
> The staging step alone (`npm run stage[:beta]`) is genuinely cross-platform —
> it just copies files — so it can run under either Node once the artifacts sit
> in `web/release/`.

### Building from WSL via Windows interop

WSL can launch Windows executables directly, so you don't need a separate
Windows terminal — drive the Windows Node toolchain from the WSL shell:

```bash
# sanity check: this is the WINDOWS node, reachable via interop
cmd.exe /c "node --version && npm --version"

cd "web"                                  # WSL cwd is inherited by cmd.exe
cmd.exe /c "npm install"                  # ONE-TIME per checkout: adds the
                                          #   win32-native optional deps
                                          #   (@rollup/rollup-win32-x64-msvc,
                                          #   esbuild, the Windows Electron
                                          #   binary). Coexists with the Linux
                                          #   deps; WSL vitest still runs.
cmd.exe /c "npm run desktop:beta"         # build (Windows electron-builder)
npm run stage:beta                        # stage (cross-platform, either Node)
```

Gotcha: don't chain `cd /d "…" && …` *inside* `cmd.exe /c` from WSL — its path
parser chokes. Set the directory in the WSL shell (`cd "web"`) and let
`cmd.exe` inherit it. If a build errors with `Cannot find module
@rollup/rollup-win32-x64-msvc` (or the equivalent for esbuild/electron), the
tree is still Linux-only — rerun the `cmd.exe /c "npm install"` step.

The intended flow leaves everything staged so the only hand step is the GitHub draft:

1. Bump `version` in `web/package.json` and commit (`Release v<version>`). Source + docs commits (including the bump) always go to **`origin`** (the code repo, `registre-des-armees`) — that's independent of the release channel.
2. **Build the artifacts with electron-builder** (Windows toolchain — native terminal or WSL-interop per above). This is what produces the files a release needs:
   - Beta: `npm run desktop:beta` → `npm run build` (tsc + Vite) then `electron-builder --win --config electron-builder.beta.cjs --publish never`.
   - Stable: `npm run desktop` → same, minus the beta config.

   electron-builder builds the `nsis` + `portable` Windows targets and writes them all into `web/release/`: `RegistreDesArmees[Beta]-Setup-<version>.exe`, its `.blockmap`, `RegistreDesArmees[Beta]-Portable-<version>.exe`, and the `latest.yml` channel file. Build prerequisites and the "Cannot create symbolic link" / 7za-wrapper workaround are in [`web/DESKTOP.md`](../web/DESKTOP.md).
3. **Stage the needed files**: `npm run stage:beta` (or `npm run stage`) runs `scripts/stage-release.mjs`, which copies exactly the Setup `.exe` + `.blockmap` + `latest.yml` (+ portable) for the current version into a freshly-cleaned `_github_assets_beta/` (or `_github_assets/`). It refuses to stage a `latest.yml` whose version doesn't match `package.json`, so a stale channel file can't slip through. These folders are gitignored (large local binaries).

   Steps 2–3 are chained by `npm run desktop:beta:stage` (or `npm run desktop:stage`) — one command that builds then stages.

   The staging folder (`_github_assets_beta/` at the repo root) is the single source of truth for the upload. A convenience mirror is also kept at `web/release/_github_assets_beta/`; when you re-stage a new version, refresh that mirror too (copy the same four files in) so it never holds a stale version.
4. **Push the git tag to the channel's repo.** The version tag lives on the repo that channel releases from — **beta tags → `registre-des-armees-beta`** (remote `beta`), **stable tags → `registre-des-armees`** (`origin`). Tag the `Release v<version>` commit and push, e.g. for beta:

   ```bash
   git remote add beta https://github.com/Ministere-de-la-Guerre/registre-des-armees-beta.git  # one-time
   git tag -a v<version> <Release-commit> -m "Release v<version>"
   git push beta v<version>          # stable: git push origin v<version>
   ```

   The tag's parent already exists in the beta repo, so this pushes just the one release commit. Pre-pushing means the GitHub draft (next step) selects the existing tag instead of creating one.
5. On GitHub → the correct repo (**beta → `registre-des-armees-beta`**, stable → `registre-des-armees`) → **Draft a new release** → select the existing tag `v<version>` (or **Create new tag** if you skipped step 4) → drag in every file from the staged folder → **Publish**. Never tick "Pre-release".

The Setup `.exe` + `.blockmap` + `latest.yml` are all **required** for auto-update; the portable `.exe` is a manual-download convenience the updater never uses.

`:release` (`npm run desktop:beta:release`) is the fully-automated alternative — it builds, creates the tag, and uploads the three required files in one step (needs `GH_TOKEN` for the target repo). Use `:stage` when you want to draft + attach the files yourself; `:release` when you want it hands-off.

Each `desktop*` run overwrites `web/release/`; copy/stage artifacts before building the other channel.

## Before release

1. `web/package.json` version correct.
2. `npm test` green.
3. `npm run build` clean.
4. `npm run desktop:beta:stage` / `npm run desktop:stage` emits installer/portable/latest/blockmap **and** stages them.
5. The curated `_github_assets*/` folder (and the `web/release/_github_assets_beta/` mirror) holds only the intended version.
6. Git tag `v<version>` pushed to the channel's repo (beta → `beta`, stable → `origin`). Automated — the only manual step left after this is #7.
7. Draft + upload on GitHub per the workflow above. **Manual** — the human drafts the release and uploads the staged files.

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
