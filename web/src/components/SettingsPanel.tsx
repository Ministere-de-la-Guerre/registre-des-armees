// Settings: display preferences. Today that is the colour palette only.
import { useState } from "react";
import { THEMES, loadTheme, saveTheme, type ThemeId } from "../state/theme";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<ThemeId>(loadTheme);

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
            Saved on this device only. The installed-app (home screen) icon is red whichever palette you pick; the
            browser tab icon follows the palette.
          </p>
        </div>
      </div>
    </div>
  );
}
