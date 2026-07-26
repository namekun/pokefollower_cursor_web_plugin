// PokéFollower desktop (macOS): transparent click-through overlay that reuses
// the extension's content.js, plus the extension popup as a settings window.
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, protocol, shell, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const SMOKE = process.argv.includes("--smoke");
// Smoke runs force real settings (pack/mode/lang, see below) and must never
// touch the developer's actual userData — otherwise every `npm run app:smoke`
// clobbers the real settings.json with smoke-test values. Redirect userData
// to a throwaway tmp dir before anything reads app.getPath("userData")
// (must happen before app.whenReady()). Best-effort cleanup on exit; harmless
// to skip since it's already under the OS tmp dir.
let smokeUserDataDir = null;
if (SMOKE) {
  smokeUserDataDir = path.join(os.tmpdir(), `pokefollower-smoke-${process.pid}`);
  app.setPath("userData", smokeUserDataDir);
  process.on("exit", () => {
    try { fs.rmSync(smokeUserDataDir, { recursive: true, force: true }); } catch (_) {}
  });
}
// Dev/test-only: skip the real OS cursor feed so a CDP harness can drive the
// overlay with synthetic mousemoves without the actual system cursor
// injecting unrelated motion mid-test. No effect on `npm run app`/`app:smoke`.
const NO_CURSOR_FEED = process.argv.includes("--no-cursor-feed");
// Dev/test-only: open the Settings window immediately at boot instead of
// waiting for a tray click, so a CDP harness gets a target for it without
// having to drive the native tray menu. No effect on `npm run app`/`app:smoke`.
const OPEN_SETTINGS_ON_BOOT = process.argv.includes("--open-settings");

// serve repo files over poke://app/<path> so fetch() works (file:// blocks fetch)
protocol.registerSchemesAsPrivileged([
  { scheme: "poke", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".css": "text/css",
  ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".xml": "application/xml", ".txt": "text/plain"
};

// --- settings store (same keys as chrome.storage; kept per area like sync/local) ---
const storePath = () => path.join(app.getPath("userData"), "settings.json");
let store = { sync: {}, local: {} };
function loadStore() {
  try { store = { sync: {}, local: {}, ...JSON.parse(fs.readFileSync(storePath(), "utf8")) }; } catch (_) {}
}
function saveStore() {
  try { fs.writeFileSync(storePath(), JSON.stringify(store, null, 2)); } catch (e) { console.warn("settings save failed", e); }
}
function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}
function storageSet(area, patch) {
  const changes = {};
  for (const [k, v] of Object.entries(patch)) {
    changes[k] = { oldValue: store[area][k], newValue: v };
    store[area][k] = v;
  }
  saveStore();
  broadcast("vcp1:storage-changed", area, changes);
  if (area === "sync" && "vcp1_enabled" in patch) refreshTray();
}

// One overlay window per display: the display running the "engine" role
// loads overlay.html (the real src/content.js follow/wander FSM, in global
// desktop coordinates); every other display loads mirror.html, a dumb
// render-only window that repaints whatever sprite snapshot the engine
// broadcasts. This lets the sprite walk across a display boundary instead of
// the old single-overlay design, which teleported the whole window to
// whichever display the cursor was on.
let winsByDisplayId = new Map(); // displayId -> BrowserWindow (role tagged via win.__vcp1Role)
let settingsWin = null;
let tray = null;
let cursorTimer = null;
let engineDisplayId = null;

function unionOfDisplays(displays) {
  const rects = displays.map((d) => ({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }));
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { rects, union: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
}

function worldPayloadForDisplayId(displayId) {
  const displays = screen.getAllDisplays();
  const { rects, union } = unionOfDisplays(displays);
  const target = displays.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  return {
    displays: rects,
    union,
    origin: { x: target.bounds.x, y: target.bounds.y },
    isEngine: displayId === engineDisplayId
  };
}

function broadcastWorld() {
  for (const [id, win] of winsByDisplayId) {
    if (win.isDestroyed()) continue;
    win.webContents.send("vcp1:world", worldPayloadForDisplayId(id));
  }
}

function createDisplayWindow(display, isEngine) {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, isEngine ? "shim-preload.cjs" : "mirror-preload.cjs"),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.__vcp1Role = isEngine ? "engine" : "mirror";
  win.__vcp1DisplayId = display.id;
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const page = isEngine ? "overlay.html" : "mirror.html";
  win.loadURL(`poke://app/desktop/${page}${SMOKE ? "?smoke=1" : ""}`);
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => {
    if (winsByDisplayId.get(display.id) === win) winsByDisplayId.delete(display.id);
  });
  return win;
}

// (Re)build one overlay window per connected display. Runs at startup and on
// every hotplug (display-added/removed/metrics-changed). The engine role
// stays pinned to whichever display it's already on; it's only reselected
// (preferring the primary display) if that display disconnects — so a window
// unrelated to the engine reshuffle is left alone (just re-bounded in case its
// resolution/position changed) rather than torn down and rebuilt every time.
function rebuildWindows() {
  const displays = screen.getAllDisplays();
  const currentIds = new Set(displays.map((d) => d.id));

  if (engineDisplayId == null || !currentIds.has(engineDisplayId)) {
    const primary = screen.getPrimaryDisplay();
    engineDisplayId = currentIds.has(primary.id) ? primary.id : (displays[0] ? displays[0].id : null);
  }

  for (const [id, win] of winsByDisplayId) {
    if (!currentIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      winsByDisplayId.delete(id);
    }
  }

  for (const display of displays) {
    const wantEngine = display.id === engineDisplayId;
    const existing = winsByDisplayId.get(display.id);
    if (existing && !existing.isDestroyed() && existing.__vcp1Role === (wantEngine ? "engine" : "mirror")) {
      existing.setBounds(display.bounds);
      continue;
    }
    if (existing && !existing.isDestroyed()) existing.destroy();
    winsByDisplayId.set(display.id, createDisplayWindow(display, wantEngine));
  }

  broadcastWorld();
}

// Feed the engine window the raw global cursor position (~60Hz) — no more
// window-hopping: the engine's own content.js walks the follower across
// display boundaries using this same global coordinate space (see
// applyFrame()'s origin-offset render step).
function startCursorFeed() {
  cursorTimer = setInterval(() => {
    const win = winsByDisplayId.get(engineDisplayId);
    if (!win || win.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    win.webContents.send("vcp1:cursor", { x: pt.x, y: pt.y });
  }, 16); // ~60Hz
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 400,
    height: 600,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    title: "PokéFollower Settings",
    webPreferences: {
      preload: path.join(__dirname, "shim-preload.cjs"),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  });
  settingsWin.loadURL(`poke://app/src/popup/index.html${SMOKE ? "?smoke=1" : ""}`);
  // popup links (credits, GitHub) open in the default browser
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  settingsWin.on("closed", () => { settingsWin = null; });
}

function refreshTray() {
  if (!tray) return;
  const enabled = !!store.sync.vcp1_enabled;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: enabled ? "Disable Follower" : "Enable Follower",
      click: () => storageSet("sync", { vcp1_enabled: !store.sync.vcp1_enabled })
    },
    { label: "Settings…", click: openSettings },
    { type: "separator" },
    // Same storageSet() path vcp1_enabled uses above -- writes a fresh
    // Date.now() each click (so storage.onChanged always fires) and
    // broadcasts to every window. content.js's chrome.storage.onChanged
    // listener (the "vcp1_feed_trigger" branch) picks it up exactly like the
    // popup's Feed button does (see popup.js) -- both real Chrome storage
    // writes, not chrome.runtime.sendMessage (which doesn't reach a content
    // script without a background-page relay in a real, non-Electron extension).
    { label: "밥 주기 / Feed", click: () => storageSet("sync", { vcp1_feed_trigger: Date.now() }) },
    { type: "separator" },
    { label: "Quit PokéFollower", click: () => app.quit() }
  ]));
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(ROOT, "src/assets/icons/pokeball-32.png"))
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("PokéFollower");
  refreshTray();
}

// --- IPC: chrome.* shim backend ---
ipcMain.handle("vcp1:storage-get", (_e, area, keys) => {
  const src = store[area] || {};
  if (keys == null) return { ...src };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in src) out[k] = src[k];
  return out;
});
ipcMain.handle("vcp1:storage-set", (_e, area, patch) => { storageSet(area, patch); });
ipcMain.on("vcp1:message", (e, msg) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents.id !== e.sender.id) {
      win.webContents.send("vcp1:message", msg);
    }
  }
});

// --- IPC: multi-display world + sprite-snapshot relay (engine -> mirrors) ---
ipcMain.handle("vcp1:world-get", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const displayId = win && win.__vcp1DisplayId != null ? win.__vcp1DisplayId : engineDisplayId;
  return worldPayloadForDisplayId(displayId);
});
ipcMain.on("vcp1:snapshot", (_e, snap) => {
  for (const [id, win] of winsByDisplayId) {
    if (id === engineDisplayId || win.isDestroyed()) continue;
    win.webContents.send("vcp1:snapshot", snap);
  }
});

const smokePassed = new Set();
function requiredSmokeChecks() {
  const base = ["overlay", "settings", "facing", "lang", "wander", "sleep", "hover"];
  // A mirror window only exists (and only ever will broadcast "mirror") when
  // more than one display is connected — gating on it unconditionally would
  // hang single-display CI/dev runs forever.
  if (screen.getAllDisplays().length > 1) base.push("mirror");
  return base;
}
function smokeCheckDone() {
  if (requiredSmokeChecks().every((k) => smokePassed.has(k))) {
    console.log("SMOKE_OK");
    app.exit(0);
  }
}
ipcMain.on("vcp1:smoke-ok", (_e, which) => {
  if (!SMOKE) return;
  smokePassed.add(which);
  console.log(`SMOKE_${String(which).toUpperCase()}_OK`);
  if (which === "overlay") openSettings();
  smokeCheckDone();
});
ipcMain.on("vcp1:smoke-facing", (_e, result) => {
  if (!SMOKE) return;
  if (result === "ok") {
    smokePassed.add("facing");
    console.log("SMOKE_FACING_OK");
    smokeCheckDone();
  } else {
    console.error(`SMOKE_FACING_${result}`);
    app.exit(1);
  }
});
ipcMain.on("vcp1:smoke-lang", (_e, result) => {
  if (!SMOKE) return;
  if (result === "ok") {
    smokePassed.add("lang");
    console.log("SMOKE_LANG_OK");
    smokeCheckDone();
  } else {
    console.error(`SMOKE_LANG_${result}`);
    app.exit(1);
  }
});
ipcMain.on("vcp1:smoke-wander", (_e, result) => {
  if (!SMOKE) return;
  if (result === "ok") {
    smokePassed.add("wander");
    console.log("SMOKE_WANDER_OK");
    smokeCheckDone();
  } else {
    console.error(`SMOKE_WANDER_${result}`);
    app.exit(1);
  }
});
ipcMain.on("vcp1:smoke-sleep", (_e, result) => {
  if (!SMOKE) return;
  if (result === "ok") {
    smokePassed.add("sleep");
    console.log("SMOKE_SLEEP_OK");
    smokeCheckDone();
  } else {
    console.error(`SMOKE_SLEEP_${result}`);
    app.exit(1);
  }
});
ipcMain.on("vcp1:smoke-hover", (_e, result) => {
  if (!SMOKE) return;
  if (result === "ok") {
    smokePassed.add("hover");
    console.log("SMOKE_HOVER_OK");
    smokeCheckDone();
  } else {
    console.error(`SMOKE_HOVER_${result}`);
    app.exit(1);
  }
});

app.whenReady().then(() => {
  protocol.handle("poke", async (req) => {
    const { pathname } = new URL(req.url);
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    const fp = path.join(ROOT, rel);
    if (!fp.startsWith(ROOT)) return new Response("forbidden", { status: 403 });
    try {
      const body = await fs.promises.readFile(fp);
      return new Response(body, { headers: { "content-type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream" } });
    } catch (_) {
      return new Response("not found", { status: 404 });
    }
  });

  loadStore();
  if (store.sync.vcp1_enabled === undefined || SMOKE) store.sync.vcp1_enabled = true;
  if (SMOKE) store.sync.vcp1_pack = "retro/gen-1/009-blastoise"; // facing probe expects this pack's row layout
  if (SMOKE) store.sync.vcp1_lang = "en"; // lang probe must start from English so its switch to Korean is real
  // facing probe's timing assumes default walk speed/offset — reset in case a
  // developer's own settings.json (persisted from manual runs) left different values
  if (SMOKE) { store.sync.vcp1_offset = 30; store.sync.vcp1_lerp = 0.20; }
  // facing probe requires follow-mode behavior; wander probe switches this on
  // its own once facing passes — reset in case a prior manual run left it wander
  if (SMOKE) store.sync.vcp1_mode = "follow";

  if (app.dock) app.dock.hide(); // menu-bar utility; no Dock icon
  createTray();
  rebuildWindows();
  if (OPEN_SETTINGS_ON_BOOT) openSettings();
  screen.on("display-added", rebuildWindows);
  screen.on("display-removed", rebuildWindows);
  screen.on("display-metrics-changed", rebuildWindows);
  // Smoke probes drive their own synthetic mousemove feed; the real OS cursor
  // (which may keep moving on the developer's machine during the run) would
  // otherwise inject unrelated motion into the same overlay and corrupt it.
  if (!SMOKE && !NO_CURSOR_FEED) startCursorFeed();

  if (SMOKE) {
    // facing (~8s) -> wander (up to 10s backstop) -> sleep (~23s worst case:
    // a 16s cursor-active leg sized to outlast a full roam+pause cycle, then
    // the idle and wake legs) -> hover (60s deadline; each of its 3 reactions
    // waits for the sprite to stand still, which costs a roam traversal plus
    // part of a 2-8s pause, then a 2.6s hover cooldown). These run
    // back-to-back in the overlay window, with settings/lang in parallel.
    // Budget generously — this is the whole chain's ceiling, not its
    // expectation, which is nearer a minute.
    setTimeout(() => { console.error("SMOKE_TIMEOUT"); app.exit(1); }, 150000);
  }
});

app.on("window-all-closed", () => { /* keep running from the tray */ });
app.on("before-quit", () => { if (cursorTimer) clearInterval(cursorTimer); });
