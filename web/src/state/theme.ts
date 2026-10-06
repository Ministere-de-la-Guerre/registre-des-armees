// Palette choice. Red is the default; "slate" (the original blue look) is the
// opt-in alternative. Slate is the unattributed `:root` in styles.css and red is the
// `:root[data-theme="red"]` block, so the default has to be applied explicitly. The choice lives in
// localStorage only: it is a per-device display preference, not part of a build.
export type ThemeId = "slate" | "red";

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  /** Browser-chrome colour (meta theme-color). */
  chrome: string;
  /** Icon files in public/, relative to the page. */
  icon: string;
  touchIcon: string;
  /** Swatches for the picker card: background, panel, accent. */
  swatch: [string, string, string];
}

export const THEMES: ThemeInfo[] = [
  {
    id: "slate",
    label: "Slate blue",
    chrome: "#15223f",
    icon: "./pwa-192x192.png",
    touchIcon: "./apple-touch-icon.png",
    swatch: ["#0f1216", "#1b2029", "#d8b44a"],
  },
  {
    id: "red",
    label: "Red",
    chrome: "#221313",
    icon: "./pwa-192x192-red.png",
    touchIcon: "./apple-touch-icon-red.png",
    swatch: ["#1a0e0e", "#2c1918", "#d8b44a"],
  },
];

const KEY = "registre.theme";

export function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === v)) return v as ThemeId;
  } catch {
    /* storage blocked: fall through to the default */
  }
  return "red";
}

function setLink(rel: string, href: string): void {
  document.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`).forEach((l) => (l.href = href));
}

export function applyTheme(id: ThemeId): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  const root = document.documentElement;
  if (t.id === "slate") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t.id);
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = t.chrome;
  setLink("icon", t.icon);
  setLink("apple-touch-icon", t.touchIcon);
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* the palette still applies for this session */
  }
  applyTheme(id);
}
