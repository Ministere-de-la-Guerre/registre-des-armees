// Service-worker registration + update flow for the web/mobile PWA.
//
// Guarded so the desktop app is byte-identical: the Electron build serves the
// SPA over the app:// scheme, so registration is skipped for any non-http(s)
// protocol (app://, file://). registerSW comes from vite-plugin-pwa and drives
// workbox-window under the hood; `registerType: "prompt"` means a waiting worker
// never activates on its own — the UI shows a toast and calls applyUpdate().
import { registerSW } from "virtual:pwa-register";

let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;

export interface PwaCallbacks {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
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
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: callbacks.onNeedRefresh,
    onOfflineReady: callbacks.onOfflineReady,
    onRegisterError(error) {
      // Never let a failed registration break the app (private mode, etc.).
      console.warn("Service worker registration failed:", error);
    },
  });
}

/** Activate the waiting worker and reload — wired to the update toast. */
export function applyUpdate(): void {
  void updateSW?.(true);
}
