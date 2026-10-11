// Electron main process for the Registre des Armées desktop app.
//
// It serves the built Vite SPA (web/dist) over a private `app://` scheme so the
// renderer's relative `fetch("./data/…")` / `fetch("./assets/…")` calls work with
// web security on, and wires electron-updater to the GitHub Releases of the repo
// so the installed app auto-checks for newer versions on launch.

const { app, BrowserWindow, protocol, shell, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

const DIST = path.join(__dirname, "..", "dist");
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

// electron-builder's portable target sets these for the unpacked app it runs.
// The portable .exe is built from the same win-unpacked dir as the installer, so
// it carries the same app-update.yml — but it must never auto-install: that
// would silently run the NSIS SETUP on quit and turn a portable copy into an
// installed one. See setupAutoUpdates.
const IS_PORTABLE = !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE);

// Minimal MIME map for the assets the SPA serves. fs reads are asar-aware, so this
// works whether the app is packaged (app.asar) or run from an unpacked dir.
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  // The build optimiser's HiGHS solver; WebAssembly streaming compile requires this type.
  ".wasm": "application/wasm",
};

// Must run before `app` is ready. `standard` makes relative URLs resolve like
// http(s); `supportFetchAPI` lets the renderer fetch JSON data files.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/** True for URLs inside the app: the app:// bundle, or the dev server in dev. */
function isAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "app:" && u.host === "bundle") return true;
    return !!DEV_SERVER_URL && u.origin === new URL(DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
}

/** The GitHub releases page this build updates from, read from the bundled
 *  app-update.yml (so stable and beta each point at their own repo). */
function releasesPageUrl() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const field = (name) => new RegExp(`^${name}:\\s*['"]?([^'"\\s]+)`, "m").exec(yml)?.[1];
    const owner = field("owner");
    const repo = field("repo");
    if (owner && repo) return `https://github.com/${owner}/${repo}/releases/latest`;
  } catch {
    /* fall through */
  }
  return null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0f1318",
    title: "Registre des Armées",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Open external (http/https) links in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // Never navigate the window away from the app itself. A file dropped outside
  // the replay screen, or a plain link, would otherwise replace the SPA (e.g.
  // with file://…) and leave no way back short of restarting. Reloads don't
  // raise will-navigate, so they are unaffected.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
  } else {
    win.loadURL("app://bundle/index.html");
  }

  // Headless self-check (SMOKE_TEST=1): confirm the SPA mounts and can fetch its
  // data over the app:// scheme, write the result to a file (GUI exes don't attach
  // to the parent console on Windows), then exit. Used for verification.
  if (process.env.SMOKE_TEST) {
    const out = (line) => {
      try {
        fs.writeFileSync(process.env.SMOKE_TEST, line);
      } catch {
        /* ignore */
      }
    };
    win.webContents.on("did-finish-load", async () => {
      try {
        const ok = await win.webContents.executeJavaScript(
          "fetch('./data/data-version.json').then(r => r.ok).catch(() => false)",
        );
        const root = await win.webContents.executeJavaScript(
          "!!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0",
        );
        out(`SMOKE_RESULT data_fetch=${ok} app_mounted=${root}`);
      } catch (err) {
        out(`SMOKE_RESULT error=${err && err.message}`);
      }
      app.exit(0);
    });
    win.webContents.on("did-fail-load", (_e, code, desc) => {
      out(`SMOKE_RESULT did_fail_load code=${code} desc=${desc}`);
      app.exit(1);
    });
  }

  return win;
}

// --- auto-update against the GitHub repository's Releases ---------------------
function setupAutoUpdates() {
  // Portable: only look, never download or install (see IS_PORTABLE).
  autoUpdater.autoDownload = !IS_PORTABLE;
  autoUpdater.autoInstallOnAppQuit = !IS_PORTABLE;

  // Stable and beta are SEPARATE apps that publish to SEPARATE GitHub repos
  // (stable -> registre-des-armees, beta -> registre-des-armees-beta). Each build
  // bundles its own `app-update.yml` pointing at its own repo, so channel
  // separation is already total: a build only ever sees the releases in its own
  // repo. That means neither channel needs GitHub's "Pre-release" flag to stay
  // apart — so we DON'T use it. Every release (stable and beta) is published as a
  // NORMAL "latest" release, and both apps follow the simplest, most robust path:
  //   allowPrerelease=false -> the GitHub provider asks for /releases/latest and
  //   fetches its `latest.yml`. It compares by semver, so a beta client on
  //   1.4.0-beta.1 still updates to a normal release tagged 1.4.0-beta.2 (the
  //   `-beta` suffix is cosmetic here; GitHub's /releases/latest excludes only
  //   releases whose "Pre-release" CHECKBOX is ticked, not versions with a hyphen).
  // Publishing rule: never tick GitHub's "Pre-release" box. The beta publish
  // config sets releaseType:"release" so `desktop:beta:release` does this for you.
  //
  // allowPrerelease=false is MANDATORY here — do NOT revert to the old
  // `/-/.test(app.getVersion())` formula that set it true for `-beta.N` builds.
  // The reason is a trap in electron-updater's GitHubProvider: with
  // allowPrerelease=TRUE it does NOT pick the highest release. It walks the
  // `/releases.atom` feed and takes the FIRST entry whose channel matches, and
  // that feed is NOT sorted by semver (GitHub orders it by the tag's commit date,
  // which put `v1.4.0-beta.1` AHEAD of `v1.4.0-beta.2`). So a beta.1 client with
  // allowPrerelease=true selects beta.1 — itself — and forever reports "up to
  // date." With allowPrerelease=FALSE the provider instead hits `/releases/latest`
  // (GitHub's real "Latest" pointer) and reads that release's `latest.yml`, which
  // correctly resolves to the newest beta regardless of atom-feed ordering.
  // Consequence: the already-shipped v1.4.0-beta.1 clients (which hardcoded
  // allowPrerelease=true, before this line existed) are permanently stuck on the
  // atom-order bug and can only reach beta.2+ via a one-time MANUAL reinstall.
  // Every build from beta.2 onward auto-updates fine.
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Registre des Armées ${info.version} has been downloaded.`,
      detail: "Restart the app to apply the update.",
    });
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  if (IS_PORTABLE) {
    autoUpdater.on("update-available", async (info) => {
      const url = releasesPageUrl();
      const { response } = await dialog.showMessageBox({
        type: "info",
        buttons: url ? ["Open download page", "Later"] : ["OK"],
        defaultId: 0,
        cancelId: url ? 1 : 0,
        title: "Update available",
        message: `Registre des Armées ${info.version} is available.`,
        detail: "This portable copy can't update itself. Download the new portable .exe (or the installer) from the releases page.",
      });
      if (url && response === 0) shell.openExternal(url);
    });
  }

  autoUpdater.on("error", (err) => {
    // Never let an update check crash the app (offline, no releases yet, etc.).
    console.warn("auto-update check failed:", err == null ? "unknown" : err.message);
  });

  // Packaged builds only — dev runs have no real version to compare.
  if (app.isPackaged) {
    // checkForUpdatesAndNotify's "downloaded" OS notification means nothing
    // when nothing is downloaded; the portable dialog above covers it instead.
    (IS_PORTABLE ? autoUpdater.checkForUpdates() : autoUpdater.checkForUpdatesAndNotify()).catch(() => {});
  }
}

// Single-instance: focus the existing window instead of opening a second one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle("app", async (request) => {
      let rel = decodeURIComponent(new URL(request.url).pathname);
      if (rel === "/" || rel === "") rel = "/index.html";
      // Resolve inside DIST and refuse to escape it. Use path.relative containment
      // (separator-aware) rather than a bare startsWith(DIST): the latter would let
      // a future sibling dir named dist* (e.g. dist-legacy) through, and it doesn't
      // guard the drive-root / parent-escape cases. decodeURIComponent above has
      // already turned any %2e%2e into ".." before normalize collapses it here.
      const filePath = path.normalize(path.join(DIST, rel));
      const relToDist = path.relative(DIST, filePath);
      if (relToDist === ".." || relToDist.startsWith(".." + path.sep) || path.isAbsolute(relToDist)) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const body = await fs.promises.readFile(filePath);
        const mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        return new Response(body, { headers: { "content-type": mime } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    });

    createWindow();
    setupAutoUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
