import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countLaunch,
  countUrl,
  detectChannel,
  isOptedOut,
  markNoticeSeen,
  setOptedOut,
  shouldShowNotice,
  siteCode,
} from "./analytics";

const loc = (url: string) => {
  const u = new URL(url);
  return { protocol: u.protocol, hostname: u.hostname, pathname: u.pathname, search: u.search };
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("detectChannel", () => {
  it("tells the stable and beta web sites apart by path", () => {
    expect(detectChannel(loc("https://ministere-de-la-guerre.github.io/registre-des-armees/"))).toBe("web");
    expect(detectChannel(loc("https://ministere-de-la-guerre.github.io/registre-des-armees/index.html"))).toBe("web");
    expect(detectChannel(loc("https://ministere-de-la-guerre.github.io/registre-des-armees-beta/"))).toBe("web-beta");
    expect(detectChannel(loc("https://ministere-de-la-guerre.github.io/registre-des-armees-beta"))).toBe("web-beta");
  });

  it("reads the desktop channel from the query main.cjs adds", () => {
    expect(detectChannel(loc("app://bundle/index.html?channel=desktop"))).toBe("desktop");
    expect(detectChannel(loc("app://bundle/index.html?channel=desktop-beta"))).toBe("desktop-beta");
  });

  it("never counts an unpackaged or smoke-test desktop run (no channel) or an unknown channel", () => {
    expect(detectChannel(loc("app://bundle/index.html"))).toBeNull();
    expect(detectChannel(loc("app://bundle/index.html?channel=web"))).toBeNull();
    expect(detectChannel(loc("app://bundle/index.html?channel="))).toBeNull();
  });

  it("counts only the published site — never dev servers, LAN hosts, forks, mirrors or local files", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:4173/",
      "http://[::1]:5173/",
      "http://registre.localhost:5173/",
      "http://192.168.1.20:5173/",
      "http://mypc.local:5173/",
      "http://[fe80::1]:5173/",
      "https://someone-else.github.io/registre-des-armees/",
      "https://mirror.example.com/registre-des-armees/",
      "http://ministere-de-la-guerre.github.io/registre-des-armees/",
      "file:///C:/dist/index.html",
    ]) {
      expect(detectChannel(loc(url)), url).toBeNull();
    }
  });
});

describe("siteCode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off when the env value is empty or blank", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "");
    expect(siteCode()).toBeNull();
    expect(siteCode("")).toBeNull();
    expect(siteCode("   ")).toBeNull();
  });

  it("reads the code from the env by default", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    expect(siteCode()).toBe("registre");
  });

  it("accepts only a bare subdomain label", () => {
    expect(siteCode("registre")).toBe("registre");
    expect(siteCode(" Registre-RDA ")).toBe("registre-rda");
    expect(siteCode("evil.example.com/x")).toBeNull();
    expect(siteCode("-bad")).toBeNull();
  });
});

describe("countUrl", () => {
  it("sends the channel as the only parameter", () => {
    expect(countUrl("registre", "desktop-beta")).toBe("https://registre.goatcounter.com/count?p=%2Fdesktop-beta");
  });
});

describe("opt-out", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to counting and round-trips the choice", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(isOptedOut()).toBe(false);
    expect(setOptedOut(true)).toBe(true);
    expect(isOptedOut()).toBe(true);
    expect(setOptedOut(false)).toBe(true);
    expect(isOptedOut()).toBe(false);
  });

  it("survives blocked storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(isOptedOut()).toBe(false);
    // Reported, not thrown, so Settings can say the choice won't be kept.
    expect(setOptedOut(true)).toBe(false);
  });
});

describe("countLaunch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stage(url: string, nav: Partial<Navigator> = {}) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("window", { location: loc(url) });
    vi.stubGlobal("navigator", { webdriver: false, ...nav });
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends one anonymous, referrer-less request for a counted launch", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    const fetchMock = stage("app://bundle/index.html?channel=desktop-beta");
    countLaunch();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://registre.goatcounter.com/count?p=%2Fdesktop-beta", {
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      keepalive: true,
    });
  });

  it("sends nothing without a site code, after opting out, under GPC, or under automation", () => {
    const site = "https://ministere-de-la-guerre.github.io/registre-des-armees/";

    vi.stubEnv("VITE_GOATCOUNTER_CODE", "");
    let fetchMock = stage(site);
    countLaunch();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    fetchMock = stage(site);
    setOptedOut(true);
    countLaunch();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock = stage(site, { globalPrivacyControl: true } as Partial<Navigator>);
    countLaunch();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock = stage(site, { webdriver: true });
    countLaunch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a failed request", async () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    const fetchMock = stage("https://ministere-de-la-guerre.github.io/registre-des-armees/");
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(() => countLaunch()).not.toThrow();
    await Promise.resolve();
  });
});

describe("first-launch notice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const site = "https://ministere-de-la-guerre.github.io/registre-des-armees/";

  function stage(url: string, nav: Partial<Navigator> = {}) {
    vi.stubGlobal("window", { location: loc(url) });
    vi.stubGlobal("navigator", { webdriver: false, ...nav });
    vi.stubGlobal("localStorage", memoryStorage());
  }

  it("shows once on a counted launch, then stays dismissed", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    stage(site);
    expect(shouldShowNotice()).toBe(true);
    markNoticeSeen();
    expect(shouldShowNotice()).toBe(false);
  });

  it("never shows where nothing is counted", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "");
    stage(site);
    expect(shouldShowNotice()).toBe(false);

    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    stage("app://bundle/index.html"); // unpackaged desktop run
    expect(shouldShowNotice()).toBe(false);

    stage(site);
    setOptedOut(true);
    expect(shouldShowNotice()).toBe(false);

    stage(site, { globalPrivacyControl: true } as Partial<Navigator>);
    expect(shouldShowNotice()).toBe(false);
  });

  it("previews on a dev server only when asked", () => {
    vi.stubEnv("VITE_GOATCOUNTER_CODE", "registre");
    stage("http://127.0.0.1:5173/");
    expect(shouldShowNotice()).toBe(false);
    stage("http://127.0.0.1:5173/?preview-usage-notice");
    expect(shouldShowNotice()).toBe(true);
  });
});
