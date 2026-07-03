# Desktop app (Windows)

The army builder ships as a Windows desktop app via **Electron**, packaged with
**electron-builder**. The same React/Vite SPA in `src/` runs inside Electron; the
main process (`electron/main.cjs`) serves the built `dist/` over a private `app://`
scheme and wires **electron-updater** to this repo's GitHub Releases for auto-update.

## Prerequisites

- Node.js on PATH, then `npm install` (downloads the Electron binary).
- `npm run build:data` must have populated `public/data` + `public/assets`
  (these are bundled into the app so it runs fully offline).

## Build the installer + portable .exe

```sh
npm run desktop
```

This runs `npm run build` (typecheck + Vite build) then `electron-builder --win`,
producing two artifacts in `release/`:

| File | What it is |
| --- | --- |
| `RegistreDesArmees-Setup-<version>.exe` | **Installer** — installs the app, adds Start-menu/desktop shortcuts, and registers the auto-updater. |
| `RegistreDesArmees-Portable-<version>.exe` | **Portable** — a single .exe that runs the app locally with no installation. |

electron-builder also emits `latest.yml` + `.blockmap` files in `release/` — these
are required by the auto-updater (publish them with each release, see below).

Other scripts:

- `npm run desktop:dir` — fast unpacked build (`release/win-unpacked/`), no installer.
- `npm run electron` — run the built `dist/` in Electron without packaging.

## Auto-update

On launch, a **packaged** build calls `autoUpdater.checkForUpdatesAndNotify()`,
which compares the running version (`package.json` `version`) against the latest
**GitHub Release** of `Ministere-de-la-Guerre/registre-des-armees`. If a newer
release exists, the new installer is downloaded in the background and the user is
prompted to restart to apply it. Failures (offline, no releases yet) are ignored.

### Releasing a new version

1. Bump `version` in `package.json`.
2. Build **and publish** to a GitHub Release in one step:
   ```sh
   # needs a GitHub token with repo scope:  setx GH_TOKEN <token>
   npm run desktop:release
   ```
   This uploads the installer, `latest.yml`, and `.blockmap` to a draft Release
   tagged `v<version>`. Publish the draft on GitHub.

   Or build with `npm run desktop` and manually attach **all** of
   `RegistreDesArmees-Setup-<version>.exe`, `latest.yml`, and the `.blockmap`
   to a Release tagged `v<version>`.

Installed clients then pick up the update automatically on their next launch.

## Notes

- **Icon:** drop a `build/icon.ico` (256×256 multi-res) to brand the app and
  installer; without it the default Electron icon is used.
- **Code signing:** builds are unsigned, so Windows SmartScreen shows a
  "Windows protected your PC" prompt on first run (click *More info → Run anyway*).
  To remove it, sign with a code-signing certificate (set `CSC_LINK`/`CSC_KEY_PASSWORD`).
- The auto-updater only runs in packaged builds, and the source repo must be public
  (or supply a token) for the GitHub provider to read releases.

## Troubleshooting

**`Cannot create symbolic link : A required privilege is not held by the client`**
during the build. electron-builder downloads `winCodeSign-2.6.0.7z`, which contains
two macOS symlinks; extracting them on Windows needs the *Create symbolic links*
privilege. Fix it with **either**:

1. **Enable Developer Mode** (Settings → Privacy & security → For developers), or run
   the build from an **Administrator** terminal — both grant the privilege so the
   extraction succeeds. *(Simplest; do this once.)*
2. **Use the bundled 7-Zip wrapper** (`electron/7za-wrapper.cs`) when you can't get
   the privilege. It forwards to the real 7-Zip but treats the benign "2 macOS
   symlink" warning as success:
   ```powershell
   # compile once
   & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /out:7za-wrapper.exe electron\7za-wrapper.cs
   # swap it in (the wrapper calls 7za-real.exe next to it)
   $d = "node_modules\7zip-bin\win\x64"
   Copy-Item "$d\7za.exe" "$d\7za-real.exe" -Force
   Copy-Item 7za-wrapper.exe "$d\7za.exe" -Force
   ```
   `npm install` restores the original 7-Zip, so re-apply after reinstalling deps.

**Flaky network.** electron-builder caches the Electron binary and the
winCodeSign/nsis tools under `%LOCALAPPDATA%\electron-builder\Cache` and
`%LOCALAPPDATA%\electron\Cache`. Once a tool is cached, later builds reuse it and
need no network, so a build interrupted mid-download just needs to be re-run.
