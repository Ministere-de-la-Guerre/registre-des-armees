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

### Optimise a build
The **Optimise** button builds the army that gets the most stats for 10 000 funds,
as the game's own average pricing rule values them. All of the game's limits
apply. For Army Corps it also completes brigades and divisions where the
formation discounts pay off, adding the cards in an order the game accepts, so
an Army Corps can field well over 10 000 of list value. You choose:

- **a cap on the number of cards**, since fewer units are easier to control;
- **how units are valued**: Quantity keeps the discount on very small and very
  large units; Quality takes it out (for Army Corps it uses the size-band pricing
  model); and **Formation discount only** (Army Corps) ignores stats and fields
  the most list value the discounts allow. Quantity and Quality are just names
  for how sizes are valued: a Quantity build won't necessarily have more cards or
  more extreme-sized units, and a Quality build won't necessarily have fewer;
- **whether to rebuild from scratch or fill what's left** of your current build;
- **whether to stick to the units your filters show**;
- **whether a build without a staff general is allowed**;
- **for Theatres of War, whether to stay within one roll** (4 corps).

The result replaces your build straight away, and **Undo optimise** brings the old
one back.

### Suggest a team
In the Ordre de Bataille planner, **Suggest team** finds the four armies with the
most value at the team points total you agree on (the sum of the corps numbers):
Army Corps of one theatre, or Theatres of War and Custom Armies of one side. Rank
by total value or by the strongest weakest army (for Army Corps also by
**Formation discount only**: how much list value each army's brigade and division
discounts let it field, weighted by its corps number), keep the armies you already
picked and fill the rest, and build the whole team with the optimiser in one
click (**Undo suggestion** brings the old plan back). A plan that mixes Army Corps
with Theatres of War, two theatres or two sides gets a warning instead.

### Know when a general is available — the "Generate times" feature
In NTW3, the generals a corps offers **rotate roughly every three hours**, so the
combat and staff generals you want aren't always on the menu. Registre des Armées
reproduces that rotation exactly and tells you, for each general in your build,
**the nearest local time you can recruit them** — whether that's right now, later
today, or a window that just passed.

For Theatres-of-War corps, "Generate times" instead times the **whole build you
made**: it finds the nearest window whose roll offers every corps your selected
units come from *and* the combat generals you used — so you can land the exact
army you designed.

It's calibrated against real in-game timings, so the times it shows match what
the game will actually offer. (The rotation runs on your PC's clock, just like
the game, and repeats every year.)

### Save, load, filter, search
Save builds and reload them later, search by name, and filter the roster by class,
cost, men, stars, speed, abilities, and division/brigade to find what you need.

---

## Getting it

Registre des Armées runs two ways — pick whichever suits you.

### On your phone or in a browser (no install needed)

Open the web app at
**https://ministere-de-la-guerre.github.io/registre-des-armees/**. It works in
any modern browser and can be installed as an app that runs **offline**:

- **iPhone / iPad (Safari):** tap **Share → Add to Home Screen**.
- **Android (Chrome):** tap the **Install app** prompt (or the ⋮ menu → *Install app*).

Once installed it launches full-screen like a native app. To use it without a
connection, open a corps and tap **⤓ Save offline** — that downloads everything
that faction needs. Your saved builds live on the device; use **⤓ Offline →
Export saves** to back them up or move them to another device.

### On Windows (desktop app)

Download the latest installer from the [Releases page](../../releases), run it,
and you're set — it updates itself when a new version ships.

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
