// Settings: the colour palette, and the opt-out for anonymous usage counting.
import { useState } from "react";
import { hasPrivacySignal, isOptedOut, setOptedOut, siteCode } from "../analytics";
import { THEMES, loadTheme, saveTheme, type ThemeId } from "../state/theme";

/** README "Privacy" — opens in the browser (Electron hands it to shell.openExternal). */
const PRIVACY_URL = "https://github.com/Ministere-de-la-Guerre/registre-des-armees#privacy";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [counting, setCounting] = useState(() => !isOptedOut());
  const [countingUnsaved, setCountingUnsaved] = useState(false);
  const privacySignal = hasPrivacySignal();

  const toggleCounting = (on: boolean) => {
    setCounting(on);
    setCountingUnsaved(!setOptedOut(!on));
  };

  const pick = (id: ThemeId) => {
    setTheme(id);
    saveTheme(id);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ color: "var(--gold-bright)" }}>Settings</h3>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="section-title">Palette</div>
          <div className="theme-grid" role="radiogroup" aria-label="Palette">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={theme === t.id}
                className={`theme-card${theme === t.id ? " active" : ""}`}
                onClick={() => pick(t.id)}
              >
                <span className="theme-swatch" style={{ background: t.swatch[0] }}>
                  <span style={{ background: t.swatch[1] }} />
                  <span style={{ background: t.swatch[2] }} />
                </span>
                <span className="theme-name">{t.label}</span>
              </button>
            ))}
          </div>
          <p className="rot-note">
            Saved on this device only. The installed-app (home screen) icon is blue whichever palette you pick; the
            browser tab icon follows the palette.
          </p>
          {siteCode() && (
            <>
              <div className="section-title">Usage statistics</div>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={counting && !privacySignal}
                  disabled={privacySignal}
                  onChange={(e) => toggleCounting(e.target.checked)}
                />
                Count my visits anonymously
              </label>
              <p className="rot-note">
                {privacySignal
                  ? "Your browser sends a Global Privacy Control signal, so nothing is counted."
                  : countingUnsaved
                    ? "This browser is blocking storage, so your choice could not be saved — it will reset the next time the app opens."
                    : "When the app opens it sends one anonymous ping to GoatCounter, so we can see roughly how many people use it. No cookies, no ID, nothing about your builds. Your choice is saved on this device and applies from the next launch."}{" "}
                <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                  Privacy details
                </a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
