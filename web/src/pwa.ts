// Service-worker registration + update flow for the web/mobile PWA.
//
// Guarded so the desktop app is byte-identical: the Electron build serves the
// SPA over the app:// scheme, so registration is skipped for any non-http(s)
// protocol (app://, file://). registerSW comes from vite-plugin-pwa and drives
// workbox-window under the hood; `registerType: "prompt"` means a waiting worker
// never activates on its own — the UI shows a toast and calls applyUpdate().
import { registerSW } from "virtual:pwa-register";

// Set once THIS tab asks for the update. The new worker claims every open tab
// when it activates, and vite-plugin-pwa's default reaction is to reload each of
// them — which would throw away an unsaved build in a tab the user wasn't even
// looking at. Only the tab that asked reloads; the others are told instead.
let reloadRequested = false;

export interface PwaCallbacks {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  /** Another tab applied the update and the new worker now controls this one.
   *  This tab keeps running the old code until it reloads. */
  onUpdatedElsewhere?: () => void;
}

/** True on the plain-browser / installed-PWA targets; false inside Electron.
 *  Guarded two ways: the desktop app serves over the app:// scheme (so any
 *  non-http(s) protocol is excluded), and the Electron user agent is excluded so
 *  even an Electron dev window pointed at the http dev server stays SW-free. */
export function isWebTarget(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const proto = window.location.protocol;
  if (proto !== "http:" && proto !== "https:") return false;
  if (/\bElectron\//.test(navigator.userAgent)) return false;
  return true;
}

export function registerPwa(callbacks: PwaCallbacks = {}): void {
  if (!isWebTarget()) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  registerSW({
    immediate: true,
    onNeedRefresh: callbacks.onNeedRefresh,
    onOfflineReady: callbacks.onOfflineReady,
    // Replaces the plugin's unconditional window.location.reload() on takeover.
    onNeedReload() {
      if (reloadRequested) window.location.reload();
      else callbacks.onUpdatedElsewhere?.();
    },
    onRegisterError(error) {
      // Never let a failed registration break the app (private mode, etc.).
      console.warn("Service worker registration failed:", error);
    },
  });
}

/** Reload this tab, first activating a waiting service worker if there is one —
 *  wired to the update toast and the error screen's Reload button. A plain
 *  reload does NOT activate a waiting worker under registerType "prompt", so the
 *  page would come back on the same old version. Talks to the registration
 *  directly rather than through registerSW so it also works when the error
 *  screen replaced the app before registerPwa ran. */
export function applyUpdate(): void {
  reloadRequested = true;
  void (async () => {
    try {
      const reg = isWebTarget() && "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
      const waiting = reg?.waiting;
      if (waiting) {
        // The SW's activate handler claims this tab, firing controllerchange.
        navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload());
        waiting.postMessage({ type: "SKIP_WAITING" });
        // Backstop in case activation stalls: a reload still recovers the page.
        setTimeout(() => window.location.reload(), 5000);
        return;
      }
    } catch {
      /* fall through to a plain reload */
    }
    window.location.reload();
  })();
}
