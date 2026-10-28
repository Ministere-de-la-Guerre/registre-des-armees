# Usage counting (GoatCounter)

The app counts how many people use it with [GoatCounter](https://www.goatcounter.com):
**one anonymous ping per launch** (per page load on the web), naming only the channel.
No cookie, no ID, no referrer, no screen size, nothing about builds. The user-facing
promise is the **Privacy** section of the root `README.md` — anything changed here
must keep that section true.

This file is identical in both repos: `registre-des-armees` (stable) and
`registre-des-armees-beta` (beta). Make every analytics change in **both**.

## Where things live

| What | Where |
|---|---|
| Site code (`m0obot`) | `web/.env` → `VITE_GOATCOUNTER_CODE`. Empty = counting fully off (no request, Settings section hidden). Not a secret. |
| Logic: channel detection, opt-out, the ping, first-launch notice | `web/src/analytics.ts` |
| Tests | `web/src/analytics.test.ts` |
| Ping on startup | `web/src/main.tsx` (`countLaunch()`) |
| One-time notice bar | `web/src/components/UsageNotice.tsx`, wired in `web/src/App.tsx` |
| Opt-out toggle + "Privacy details" link | `web/src/components/SettingsPanel.tsx` |
| Desktop channel (`?channel=`) | `web/electron/main.cjs`, in `createWindow` |
| Dashboard | https://m0obot.goatcounter.com |

## What gets counted

| Channel (path on the dashboard) | When |
|---|---|
| `/web` | `https://ministere-de-la-guerre.github.io/registre-des-armees/` |
| `/web-beta` | `https://ministere-de-la-guerre.github.io/registre-des-armees-beta/` |
| `/desktop` | Installed or portable stable desktop app |
| `/desktop-beta` | Installed or portable beta desktop app |

Never counted: dev servers, LAN previews, forks/mirrors (any other host), unpackaged
desktop runs (`npm run electron`), `SMOKE_TEST` runs, users who opted out, browsers
sending Global Privacy Control, and automation (`navigator.webdriver`).

On the dashboard, read **Visitors** (unique, de-duplicated over GoatCounter's 8-hour
session), not Pageviews (every reload counts).

If the web app ever moves to a custom domain, update `WEB_HOST` in `analytics.ts`
or the web stops being counted.

## GoatCounter account settings that must stay as they are

Settings → **Data collection**: **User-Agent, Country and Region are OFF**. The
README promises browser, OS and location are not recorded; GoatCounter records them
by default. Sessions stay ON (that is what makes "Visitors" unique).

Never commit a GoatCounter **API token** (Settings → API). The site code is public
by design; an API token grants account access.

## Releasing the desktop app with counting

Counting reaches desktop users only once they update to a build made after
2026-10-27. Build from a checkout whose `web/.env` has the code and whose
`web/src/analytics.ts` exists — check both before releasing.

- **Stable desktop:** from `registre-des-armees` **`main`** → `npm run desktop:release`.
- **Beta desktop:** from `registre-des-armees-beta` **`main`** → `npm run desktop:beta:release`
  (or `desktop:beta:pickrates` / `:stage` variants as usual). Its `main` has both the
  beta features and analytics.
  - The stable repo's `feature/pick-rates` branch does **not** contain analytics.
    If you build beta from it, first `git merge main` into it (a dry run on
    2026-10-27 merged cleanly).

### Verify a desktop build before releasing

1. `cd web && npm run desktop:dir` (stable) or the beta equivalent — this is a
   packaged build, so it counts.
2. Run the `.exe` in `web/release/win-unpacked/`.
3. Within a minute the dashboard shows a hit on `/desktop` (or `/desktop-beta`). If
   your IP is on GoatCounter's ignore list, the hit is dropped — remove it briefly or
   test from another network.

`npm run electron` will **not** produce a hit; that is intended.

## Previewing the notice locally

Dev servers are never counted, so the first-launch notice never appears there on its
own. Open `http://127.0.0.1:5173/?preview-usage-notice` (any dev port). The switch
is compiled out of production builds. In production the notice shows once per
device/browser until the user clicks OK or Settings.

## Changing what is collected

Keep the ping to the channel path. Adding a persistent ID, cookie, screen size,
referrer or similar would break the README's promises and likely require asking
users for consent (EU ePrivacy/GDPR) before counting. Update the README Privacy
section, the Settings note and the notice text together with any such change.
