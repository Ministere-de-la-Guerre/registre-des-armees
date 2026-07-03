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
};

// Must run before `app` is ready. `standard` makes relative URLs resolve like
// http(s); `supportFetchAPI` lets the renderer fetch JSON data files.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

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
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

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

  autoUpdater.on("error", (err) => {
    // Never let an update check crash the app (offline, no releases yet, etc.).
    console.warn("auto-update check failed:", err == null ? "unknown" : err.message);
  });

  // Packaged builds only — dev runs have no real version to compare.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
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
      // Resolve inside DIST and refuse to escape it (path-traversal guard).
      const filePath = path.normalize(path.join(DIST, rel));
      if (!filePath.startsWith(DIST)) {
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
