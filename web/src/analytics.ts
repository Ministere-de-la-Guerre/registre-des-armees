// Anonymous usage counting via GoatCounter: one hit per app launch (on the web,
// per page load).
//
// What is sent is a single path naming the channel ("/web", "/web-beta",
// "/desktop", "/desktop-beta") — no referrer, screen size, query string, cookie or
// identifier. GoatCounter keys an in-memory session on IP + User-Agent (never
// written to its disk, dropped after 8 hours) to count unique visitors. The only
// thing stored on the device is the user's opt-out choice. See README "Privacy".
//
// Only the official builds are counted: the published GitHub Pages site, and the
// packaged desktop app (main.cjs names its channel in `?channel=`). Dev servers,
// LAN previews, forks, mirrors and unpackaged or smoke-test desktop runs never
// match. Nothing is sent either when no site code is configured
// (VITE_GOATCOUNTER_CODE in web/.env), the user opted out in Settings, the browser
// sends Global Privacy Control, or the page is driven by automation.

export type Channel = "web" | "web-beta" | "desktop" | "desktop-beta";

const OPT_OUT_KEY = "registre.analytics"; // "off" = opted out; absent = counting

/** The one host the published web app is served from (stable and beta differ by path). */
const WEB_HOST = "ministere-de-la-guerre.github.io";

/** The configured GoatCounter site code, or null when counting is not set up. Only
 *  a bare subdomain label is accepted, since it is spliced into the host name. */
export function siteCode(raw: string | undefined = import.meta.env.VITE_GOATCOUNTER_CODE): string | null {
  const code = raw?.trim().toLowerCase() ?? "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(code) ? code : null;
}

/** Which official build is running, or null when this launch should not be counted.
 *  Desktop: the app:// bundle, but only when the packaged app named its channel.
 *  Web: the published site; the beta is the one under /registre-des-armees-beta/. */
export function detectChannel(loc: { protocol: string; hostname: string; pathname: string; search: string }): Channel | null {
  if (loc.protocol === "app:") {
    const channel = new URLSearchParams(loc.search).get("channel");
    return channel === "desktop" || channel === "desktop-beta" ? channel : null;
  }
  if (loc.protocol !== "https:" || loc.hostname !== WEB_HOST) return null;
  return /\/registre-des-armees-beta(\/|$)/.test(loc.pathname) ? "web-beta" : "web";
}

/** GoatCounter's documented tracking-pixel endpoint (goatcounter.com/help/pixel). */
export function countUrl(code: string, channel: Channel): string {
  return `https://${code}.goatcounter.com/count?p=${encodeURIComponent("/" + channel)}`;
}

export function isOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "off";
  } catch {
    return false;
  }
}

/** Persist the choice. False when storage is blocked, so the caller can say the
 *  choice will not survive this session. */
export function setOptedOut(off: boolean): boolean {
  try {
    if (off) localStorage.setItem(OPT_OUT_KEY, "off");
    else localStorage.removeItem(OPT_OUT_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The browser is sending Global Privacy Control — treated as an opt-out. */
export function hasPrivacySignal(): boolean {
  return typeof navigator !== "undefined" && (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** The code and channel to count this launch under, or null when it is not counted. */
function countedAs(): { code: string; channel: Channel } | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const code = siteCode();
  const channel = detectChannel(window.location);
  if (!code || !channel || isOptedOut() || hasPrivacySignal() || navigator.webdriver) return null;
  return { code, channel };
}

const NOTICE_KEY = "registre.analytics.notice"; // "seen" once the first-launch notice is acknowledged

/** Whether to show the one-time notice that visits are counted. It informs rather
 *  than asks, and only appears where counting actually happens. With storage
 *  blocked it shows every launch, since the acknowledgement cannot be kept. */
export function shouldShowNotice(): boolean {
  // Dev servers are never counted, so the notice can't appear there on its own;
  // `?preview-usage-notice` shows it for a look. Compiled out of production builds.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview-usage-notice")) return true;
  if (!countedAs()) return false;
  try {
    return localStorage.getItem(NOTICE_KEY) !== "seen";
  } catch {
    return true;
  }
}

export function markNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, "seen");
  } catch {
    /* storage blocked: the notice returns next launch */
  }
}

/** Count this launch. Fire-and-forget: offline, blocked or failed requests are
 *  dropped silently and never affect the app. */
export function countLaunch(): void {
  if (typeof fetch === "undefined") return;
  const counted = countedAs();
  if (!counted) return;
  const { code, channel } = counted;
  fetch(countUrl(code, channel), {
    mode: "no-cors",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    keepalive: true,
  }).catch(() => {
    /* offline or blocked — not counted */
  });
}
