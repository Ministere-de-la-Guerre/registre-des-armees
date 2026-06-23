# Registre des Armées

**A desktop army builder for Napoleonic Total War 3 (NTW3).**

Registre des Armées lets you plan a multiplayer army corps outside the game:
pick a corps, browse every unit it can recruit, assemble a build, and watch the
cost, discounts, and limits update live — exactly the way the in-game lobby
does. It also tells you **when** the game will offer each general you want.

> Made for NTW3 multiplayer players who want to plan and price a corps before
> they sit down in the lobby.

---

## What it does

### Pick your corps
Browse every army corps in the game, grouped the way the lobby presents them —
**Empire**, **Coalition**, **Theatres of War**, and **Custom Armies** — each with
its historical theatre, year, rating, and flag.

### See every unit
For the corps you choose, you get the full roster of recruitable cards: line and
light infantry, grenadiers, cavalry, artillery, skirmishers, plus its staff and
combat generals. Each card shows its cost, men, speed, command stars, special
abilities (square, stamina, guerrilla deployment, stakes, and more), and full
stats — accuracy, morale, melee, charge, range.

### Build and price an army, live
Add units to your build and everything updates instantly:

- **Running cost** against the 10,000 budget, with the gold you have left.
- **Formation discounts** — completing a brigade or a full division earns the
  same brigade/division discount the game gives you, shown as you fill them in.
- **Limits** enforced like the game: 31 cards, artillery and heavy-cavalry caps,
  one combat general per unit, and the corps' combat-general cap.
- **Totals** for men and squares, so you can read the army at a glance.

### Auto combat generals
One click finds the **cheapest** way to add combat generals to the units you've
already picked — taking the discounts that lower your total and skipping the ones
that would make it dearer. A second click resets them.

### Know when a general is available — the "⏱ General times" feature
In NTW3, the generals a corps offers **rotate roughly every three hours**, so the
combat and staff generals you want aren't always on the menu. Registre des Armées
reproduces that rotation exactly and tells you, for each general in your build,
**the nearest local time you can recruit them** — whether that's right now, later
today, or a window that just passed.

It's calibrated against real in-game timings, so the times it shows match what
the game will actually offer. (The rotation runs on your PC's clock, just like
the game, and repeats every year.)

### Save, load, filter, search
Save builds and reload them later, search by name, and filter the roster by class,
cost, men, stars, speed, abilities, and division/brigade to find what you need.

---

## Getting it

Registre des Armées is a **Windows desktop app**. Download the latest installer
from the [Releases page](../../releases), run it, and you're set — it updates
itself when a new version ships.

Because the app isn't code-signed yet, Windows SmartScreen may show a
"Windows protected your PC" prompt on first run. Click **More info → Run anyway**
to continue.

---

## A note on the data

All the unit stats, costs, generals, flags, and abilities come straight from the
game's own data tables, so what you see in the builder matches the game. Unlike
the in-game lobby, the builder deliberately shows you **every** general a corps
can field at once (the rotation feature then tells you when each is offered) — so
you can plan around who you actually want.

---

## For developers

This repository also contains the data-build pipeline (Python tools that turn the
exported game tables into the app's data) and the React/TypeScript/Electron app
source under `web/`. If you want to build, modify, or extend it, start with
[`docs/HANDOFF.md`](docs/HANDOFF.md) — it documents the architecture, data
pipeline, rules math, the general-rotation engine, and the release workflow.

---

## Credits

The application icon features **"Napoleonic Eagle" by Sodacan**
([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Napoleonic_Eagle.svg)),
licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The eagle is unmodified, composited onto a coloured background; the resulting icon
is distributed under CC BY-SA 3.0. See `web/build/ICON_CREDIT.txt`.
