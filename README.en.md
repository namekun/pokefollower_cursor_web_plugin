# PokéFollower

> 🇺🇸 English (this document) &nbsp;·&nbsp; 🇰🇷 [한국어](README.md)

A little nostalgic companion for your screen: a retro 2D Pokémon sprite that
follows your cursor around, idling, walking, and facing whichever way you move.

This is a fork of [ThinkrDoer/pokefollower_cursor_web_plugin](https://github.com/ThinkrDoer/pokefollower_cursor_web_plugin),
originally created by **Ali Hamad**. The original is a Chrome extension that adds
the follower to web pages. This fork keeps that extension and adds a native
**macOS desktop app** so the same Pokémon can follow your cursor across your
whole desktop — over every app, not just the browser.

---

## Features

- **Follow mode** — the sprite follows your cursor. It faces whichever of the
  8 directions it's travelling in, settles on top of the cursor once it
  arrives, and falls asleep after 30 seconds of no cursor movement (for packs
  that include a sleep animation).
- **Wander mode** — the sprite roams the screen on its own, independent of the
  cursor. It walks to a random point, then rests for 2–8 seconds; during that
  rest it has a 15% chance to play an attack motion in place (packs with an
  attack state only). It never naps at random — in both modes the sprite only
  falls asleep after the cursor has genuinely sat still for 30 seconds (packs
  with a sleep animation only), and wakes the instant the cursor moves again.
- **Hover reactions** — hold the cursor still over the sprite and it plays one
  of two reactions at random: a little hop or an in-place spin (whichever of
  those the pack actually has). It's a delighted reaction to being played
  with, so no attack motion. Passing over it quickly is deliberately
  ignored, so a stray brush of the cursor never sets one off by accident.
  After a reaction there's about a 2-second cooldown, and the cursor has to
  leave the sprite and come back before it can trigger again. Hovering over
  it while it's asleep wakes it up and it reacts right back.
- **Growth & evolution** — every Pokémon grows by earning its own XP.
  - Time spent together, actual distance travelled, and interactions like
    hover reactions all contribute XP, tracked separately per Pokémon.
  - Evolution levels match the games (e.g. Bulbasaur evolves into Ivysaur at
    Lv.16). Pokémon that evolve by stone, trade, or friendship in the games
    get an equivalent level threshold in this system instead.
  - Reaching the level triggers an automatic evolution with a brief flash
    effect. Branching Pokémon like Eevee don't evolve automatically —
    instead Settings waits for you to pick which evolution you want.
  - Evolved forms you haven't unlocked yet show up 🔒-locked in the list and
    are excluded from search and shuffle — you have to actually evolve into
    them to be able to pick them. The one exception: a baby Pokémon's own
    first evolution (like Pikachu or Jigglypuff) is selectable from the
    start, since nobody begins with a baby Pokémon in the first place —
    they only ever show up through breeding.
- **Mood bubble** — a small portrait bubble pops up above the sprite's head
  to show its current mood. It's happy right after evolving, delighted when
  you play with it via a hover reaction, calm right after waking up, and
  startled when the cursor whips past it quickly (cooldown-gated so it
  doesn't show up too often). Leave the cursor completely still for over an
  hour and it can look bored, too. Portraits come from the same PMD
  SpriteCollab source as the sprites, and since not every Pokémon has every
  expression drawn, an unsupported mood is simply skipped. Settings also
  shows a small default-mood portrait for the current Pokémon next to the
  level label.
- **Feeding** — pick **Feed** (밥 주기 / Feed) from the tray menu or the
  Feed button in Settings, and an apple drops nearby for the sprite to walk
  over and eat. The 130 of 493 Pokémon with an Eat animation actually chow
  down; the rest hop in place instead. Finishing a meal pops a happy mood
  bubble, and once every 30 minutes it also earns a +30 XP bonus (satisfying
  hunger itself has no cooldown — that always works). Hunger builds up
  gradually with active time (full after roughly 4 hours), and once it's
  built up enough the Pokémon can occasionally look sad — feeding clears it
  right away.
- **Multi-display** — one overlay per connected display, and the sprite
  actually walks across display boundaries instead of teleporting.
- **493 Pokémon** (generations 1–4, national dex #001 Bulbasaur through #493
  Arceus) — with SCALE / DISTANCE / SPEED controls and a name-language switch
  (EN / Korean).
- The macOS app is a **menu-bar-only app with no Dock icon**. The Pokéball
  icon in the menu bar is the *only* entry point, so if your menu bar is
  crowded with other icons it can end up hidden — a real gotcha to be aware
  of. (Reordering or trimming menu-bar icons in macOS settings brings it back
  into view.)

---

## Install (macOS App)

### Requirements

- **macOS 11 (Big Sur) or later** — the minimum supported by the Electron 33
  runtime this app uses.
- **Node.js 20 or later**

### One-command setup

```bash
npm run setup:mac
```

This checks your environment, installs dependencies, verifies the Electron
binary (auto-repairing it if corrupted), runs the smoke test, builds the app,
installs it to `/Applications`, and launches it — all in one go.

### Apple Silicon and Intel are both supported

There are no native modules involved, so the same command builds cleanly on
either architecture. `electron-builder` produces a binary matching whatever
machine you build on, so on an Intel Mac you can clone the repo and run
`npm run setup:mac` exactly the same way — no code changes needed.

### Manual steps

If you'd rather run each step yourself:

```bash
npm install        # install dependencies
npm run app        # run the app in development (Electron)
npm run dist       # build a standalone .app (unsigned)
```

`npm run dist` outputs an unsigned `PokeFollower.app` under `dist/`.

### First launch (unsigned app)

The built app is not code-signed, so on first launch macOS Gatekeeper will
refuse to open it directly. To get past this once:

1. In Finder, **right-click** (or Control-click) `PokeFollower.app`.
2. Choose **Open**.
3. Confirm **Open** in the dialog.

After that first time, it opens normally.

---

## Install (Chrome Extension)

To run the original extension in Chrome (or any Chromium browser):

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `src/` folder.

The follower then appears on web pages, using the same settings popup as the
macOS app.

---

## Usage

Clicking the Pokéball icon in the menu bar opens:

- **Enable / Disable** the follower
- Open **Settings…**
- **Feed** (밥 주기) — drops an apple for the Pokémon to eat
- **Quit**

The **Settings…** window shows the same UI as the browser extension popup:

- **Pick a Pokémon** — select from the list, **search** by name or Pokédex
  number, or **shuffle** for a random one. Evolved forms you haven't unlocked
  yet show up 🔒-locked and are left out of search and shuffle.
- **Level / XP** — shows the current Pokémon's level, its XP progress toward
  the next level (the XP bar), and what it takes to evolve next. A small
  default-mood portrait for the current Pokémon sits next to the level
  label. If a branching Pokémon like Eevee becomes eligible, buttons appear
  for picking which evolution you want.
- **Hunger / Feed** — shows hunger as a percentage plus a mood emoji, with a
  **Feed** button that drops an apple for the Pokémon to go eat.
- **Mode (Follow / Wander)** — switch between Follow, which trails your
  cursor, and Wander, which roams the screen on its own.
- **SCALE** — how large the sprite is drawn.
- **DISTANCE** — how far it perches from the cursor (Follow mode).
- **SPEED** — how quickly it catches up as you move (Follow mode).
- **Language (EN / 한글)** — show Pokémon names and search suggestions in
  Korean (new in this fork).

Settings are stored at:

```
~/Library/Application Support/pokefollower_cursor_web_plugin/settings.json
```

---

## Development

The desktop app deliberately **reuses the extension's `src/` code unmodified**.
A thin Electron layer stands in for the parts of Chrome the extension expects.

Structure overview:

- **`src/content.js`** — the shared sprite engine. The Follow/Wander state
  machine, 8-way facing, and animation-frame handling all live here.
- **`src/popup/`** — the settings UI. Used identically by the extension and
  the desktop app.
- **`desktop/`** — the Electron wrapper. `main.cjs` creates one overlay window
  per display, feeds the engine window the raw cursor position, and manages
  the tray menu and the Settings window. `shim-preload.cjs` is a small shim
  implementing `chrome.storage`/`chrome.runtime`, so `src/popup` and
  `src/content.js` run without any changes. `mirror.html` /
  `mirror-preload.cjs` / `mirror-render.js` handle every display that isn't
  running the engine — they just repaint the engine's per-frame snapshot in
  their own local coordinates (only one physics simulation ever runs; the
  rest are passive views of it).
- **`src/assets/`** — the per-generation sprite packs and pack index.

### Run in development

```bash
npm run app
```

### Smoke test

```bash
npm run app:smoke
```

Boots the app headlessly and automatically verifies the core paths end to
end: overlay rendering, the Settings window loading a pack, 8-way facing, and
the language switch. On success it prints `SMOKE_OK` and exits `0`.

### Build only

```bash
npm run dist
```

Builds an unsigned `.app` with `electron-builder` without installing or
launching it.

### Regenerate Korean names

```bash
npm run build:ko-names
```

Regenerates `src/assets/packs/names-ko.json`, the lookup of Korean Pokémon
names (keyed by Pokédex number) used by the language switch. It fetches names
from PokéAPI based on `src/assets/packs/index.json`.

---

## Credits & License

- **Code** — MIT License, © Ali Hamad and contributors. See
  [CREDITS.txt](CREDITS.txt).
- **Sprites & emotion portraits** — from the [PMD Sprite Collab](https://sprites.pmdcollab.org)
  community, used under **Creative Commons BY-NC 4.0**. Non-commercial use
  only, attribution required.
- **Pokémon** — Pokémon and all related names and imagery are the intellectual
  property of **Nintendo / Game Freak / The Pokémon Company**.

This project is a fan-made, **personal and non-commercial** work. It is not
affiliated with or endorsed by Nintendo, Game Freak, or The Pokémon Company.

Full attributions are in [CREDITS.txt](CREDITS.txt).
