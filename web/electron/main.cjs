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

  // Two independent update channels on the GitHub provider. electron-builder's
  // GitHub provider ALWAYS writes `latest.yml` (it has no per-channel update file
  // — `detectUpdateChannel`/`beta.yml` only apply to the generic/S3 providers),
  // so both channels ship a `latest.yml`. They stay separate because each lives
  // in a different GitHub release and each build only looks at the releases it is
  // allowed to, decided from its own version string:
  //   • Stable build  (e.g. 1.4.0)        -> allowPrerelease=false. The provider
  //     asks GitHub for /releases/latest, which never returns a "Pre-release", so
  //     a stable client only ever sees full releases.
  //   • Pre-release    (e.g. 1.4.0-beta.1) -> allowPrerelease=true. The provider
  //     walks the full releases feed incl. "Pre-release"-flagged ones, so a beta
  //     client follows the beta line (and onto a newer stable if one ships).
  // Publish accordingly: tick GitHub's "Pre-release" box for beta releases; leave
  // it unticked + "Set as latest" for stable. That GitHub flag is the real switch
  // — the build's -tag just decides which lane this client belongs to.
  // Bootstrap caveat: a client only gets this behaviour once running a build that
  // contains it. Pre-1.3.3 clients hardcoded allowPrerelease=true; ship the next
  // full release as "Latest" so they migrate onto the stable line before betas.
  autoUpdater.allowPrerelease = /-/.test(app.getVersion());

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
