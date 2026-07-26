// === VCP1 content script: load pack JSON + animate idle/walk with left/right flip ===
const DEFAULT_PACK = "retro/gen-1/009-blastoise";
const GENERATION_DIRS = ["gen-1","gen-2","gen-3","gen-4","gen-5","gen-6","gen-7","gen-8","gen-9"];

const STATE = {
  enabled: false,
  pack: DEFAULT_PACK,  // default
  facingLeft: false,
  mode: "follow"       // "follow" | "wander"
};

let followerEl = null;
let rafId = null;
let running = false;

const RUNTIME = {
  meta: null,                 // loaded JSON pack
  images: {},                 // { idle: Image, walk: Image }
  anim: { name: "idle", frame: 0, row: 0, accMs: 0 },
  lastMoveTs: 0,
  // Both default to Infinity (not 0) so the hover gates in updateHover() —
  // which read "small" as good — can't trivially pass before any real
  // mousemove has ever fired; RUNTIME.pos and RUNTIME.lastMouse both start at
  // (0,0), which is already "inside" the box by coincidence, so a default of
  // 0 here would let that boot-time coincidence alone pass both gates.
  lastMoveGapMs: Infinity,        // ms since the *previous* mousemove, as of the latest one (see onMouseMove)
  lastMoveInstantSpeed: Infinity, // raw px/s of the latest single mousemove, unsmoothed (see onMouseMove)
  lastMouse: { x: 0, y: 0, t: 0 },

  // position/target and smoothed velocity
  pos:       { x: 0, y: 0 },
  target:    { x: 0, y: 0 },
  offsetDir:    { x: 0, y: -1 }, // lerped unit vector for idle→walk glide (perch placement)
  isWalking:    false,           // true while the follower is actively walking toward its target
  pendingState: null,             // { name, queuedAt } — deferred state switch
  velAvg:    { x: 0, y: 0 },
  speedAvg:  0
};

// --- wander mode: autonomous roam/pause/sleep/attack FSM (mode === "wander") ---
const WANDER = {
  state: null,                 // "roam" | "pause" | "sleep" | "attack" (null = not yet started)
  until: 0,                    // performance.now() deadline for timed states (pause)
  sleepEnteredAt: 0,            // performance.now() when idle-triggered "sleep" was entered
  attackCyclesLeft: 0,
  lastDir: { x: 0, y: 0 }       // last travel vector; keeps facing during stationary states
};

// --- behavior thresholds ---
const SLEEP_TIMEOUT_MS = 30000; // 30s of no movement -> sleep (production value, follow mode only -- see sleepTimeoutMs())
// Wander mode's own idle-sleep timeout. Kept as a separate constant (with its
// own test hook) so the two modes can diverge again without re-plumbing, but
// deliberately set to the same 30s as follow: sleeping must mean "the user
// really stopped touching the mouse", and one threshold across both modes is
// what that reads as. This was 5min for a while so that merely *watching* the
// sprite roam wouldn't put it to sleep -- raise it here if that comes back.
const WANDER_SLEEP_TIMEOUT_MS = 30000; // 30s of no cursor movement -> wander sleeps (tune here)
const ARRIVE_RADIUS_PX = 6;     // close enough to target to call it "arrived" and settle into idle
const SLOW_RADIUS_PX   = 60;    // ease walking speed down within this distance for a soft landing
const VEL_DECAY_DELAY_MS = 80;  // no mousemove for this long -> start decaying velAvg toward zero
const VEL_DECAY_TAU_MS   = 120; // exponential decay time constant once decaying

// Test-only override: lets an automated harness (CDP) dial the idle-sleep
// timeout down from its 30s production value for fast, deterministic tests.
// Inert unless a test explicitly calls setSleepTimeoutMs() — normal browser
// extension and desktop use never touch this, so production behavior is
// always the full SLEEP_TIMEOUT_MS.
let TEST_SLEEP_TIMEOUT_MS = null;
function sleepTimeoutMs() { return TEST_SLEEP_TIMEOUT_MS ?? SLEEP_TIMEOUT_MS; }
// Same pattern, for wander's own idle-sleep timeout above -- lets a CDP
// harness dial WANDER_SLEEP_TIMEOUT_MS down to something it can wait out.
let TEST_WANDER_SLEEP_TIMEOUT_MS = null;
function wanderSleepTimeoutMs() { return TEST_WANDER_SLEEP_TIMEOUT_MS ?? WANDER_SLEEP_TIMEOUT_MS; }
// Test-only: records whichever reaction pickHoverReaction() last chose, so a
// harness can assert the hover pool's actual contents rather than infer them
// from whatever sprite sheet happens to be painted -- wander's own
// spontaneous attack roll paints "attack" too, so the sheet alone can't tell
// a hover-triggered reaction from a coincidental one. Read-and-clear, so each
// probe only ever sees its own trigger.
let TEST_LAST_HOVER_REACTION = null;
window.__VCP1_TEST_HOOKS__ = {
  setSleepTimeoutMs(ms) { TEST_SLEEP_TIMEOUT_MS = (typeof ms === "number" && ms > 0) ? ms : null; },
  setWanderSleepTimeoutMs(ms) { TEST_WANDER_SLEEP_TIMEOUT_MS = (typeof ms === "number" && ms > 0) ? ms : null; },
  takeLastHoverReaction() { const r = TEST_LAST_HOVER_REACTION; TEST_LAST_HOVER_REACTION = null; return r; },
  // The *production* thresholds, ignoring any override the two setters above
  // installed -- a harness has to dial those down to run at all, which would
  // otherwise leave the shipped values themselves untested.
  productionSleepTimeouts() { return { follow: SLEEP_TIMEOUT_MS, wander: WANDER_SLEEP_TIMEOUT_MS }; },
  // Test-only entry points for the XP/evolution engine below (see "evolution
  // / growth (XP) engine" section) -- lets an automated harness grant XP
  // directly instead of waiting real-time for activity/distance to accrue it.
  grantXP(amount) { awardXP(Number(amount) || 0); },
  getGrowthSnapshot() {
    const dex3 = currentGrowthDex();
    const xp = (GROWTH[dex3] && GROWTH[dex3].xp) || 0;
    return {
      pack: STATE.pack,
      dex: dex3,
      xp,
      level: levelForXp(xp),
      unlocked: Array.from(UNLOCKED),
      pendingEvolution: PENDING_EVOLUTION,
      evolveFlashActive: EVOLVE.active,
      hunger: (GROWTH[dex3] && GROWTH[dex3].hunger) || 0,
      lastFedAt: (GROWTH[dex3] && GROWTH[dex3].lastFedAt) || 0
    };
  },
  flushGrowthNow() { growthDirty = true; flushGrowth(); },
  // Test-only entry point for the mood-bubble system (see "mood bubble"
  // section below) -- lets an automated harness force a bubble on demand
  // instead of waiting for a real evolution/hover-attack/sleep/idle event.
  forceMood(emotion) { triggerMood(String(emotion || "Normal")); },
  getMoodSnapshot() {
    return { active: MOOD.active, url: MOOD.url, startedAt: MOOD.startedAt };
  },
  // Test-only entry points for the feeding system (see "feeding" section) --
  // lets an automated harness drive the same real trigger a tray click/popup
  // button would (triggerFeed), and force hunger to a specific value instead
  // of waiting real-time for it to accrue.
  triggerFeed() { triggerFeed(); },
  setHunger(value) {
    const dex3 = currentGrowthDex();
    if (!dex3) return;
    const rec = ensureGrowthRecord(dex3);
    rec.hunger = Math.max(0, Math.min(HUNGER_MAX, Number(value) || 0));
    growthDirty = true;
  },
  getFeedingSnapshot() {
    return {
      active: FEEDING.active,
      phase: FEEDING.phase,
      applePos: FEEDING.applePos ? { x: FEEDING.applePos.x, y: FEEDING.applePos.y } : null
    };
  },
  setHungerSadCooldownMs(ms) { TEST_HUNGER_SAD_COOLDOWN_MS = (typeof ms === "number" && ms > 0) ? ms : null; }
};

function hasState(name) {
  return !!(RUNTIME.meta && RUNTIME.meta.states && RUNTIME.meta.states[name]);
}

// --- multi-display world (desktop app only) ---
// The desktop shim injects window.__VCP1_WORLD__ = { displays: [{x,y,w,h}...],
// union: {x,y,w,h}, origin: {x,y} } describing the full macOS desktop in
// global coordinates and this window's own local-origin offset. When absent
// (the Chrome extension, or before the desktop app's first IPC round trip),
// every call site below falls back to the existing window.innerWidth/Height
// viewport-only behavior — browser semantics are untouched.
function getWorldInfo() {
  const w = window.__VCP1_WORLD__;
  return (w && Array.isArray(w.displays) && w.displays.length) ? w : null;
}
// --- UI-configurable tuning (persisted in chrome.storage.sync) ---
const CONFIG = {
  scale: 1.25,   // visual scale multiplier
  offset: 30,    // px distance from cursor (trail/perch)
  lerp: 0.20     // follow smoothing (0..1), lower = floatier
};
function applyConfigPatch(obj = {}) {
  if (typeof obj.vcp1_scale  === "number" && !Number.isNaN(obj.vcp1_scale))  CONFIG.scale  = obj.vcp1_scale;
  if (typeof obj.vcp1_offset === "number" && !Number.isNaN(obj.vcp1_offset)) CONFIG.offset = obj.vcp1_offset;
  if (typeof obj.vcp1_lerp   === "number" && !Number.isNaN(obj.vcp1_lerp))   CONFIG.lerp   = obj.vcp1_lerp;
}

// Map the popup's "SPEED" slider (stored/transmitted as vcp1_lerp, internal range ~0.05–0.50)
// onto a walking speed in px/s, so the follower travels at a steady, natural pace
// instead of being eased toward a moving point (which is what produced the "leash" drag).
const WALK_SPEED_MIN_PXPS = 80;   // px/s at the slowest "speed" setting
const WALK_SPEED_MAX_PXPS = 640;  // px/s at the fastest "speed" setting
const SPEED_CONFIG_MIN = 0.05;
const SPEED_CONFIG_MAX = 0.50;
function walkSpeedFromConfig() {
  const t = (CONFIG.lerp - SPEED_CONFIG_MIN) / (SPEED_CONFIG_MAX - SPEED_CONFIG_MIN);
  const clamped = Math.min(1, Math.max(0, t));
  return WALK_SPEED_MIN_PXPS + clamped * (WALK_SPEED_MAX_PXPS - WALK_SPEED_MIN_PXPS);
}

// --- Live poller for smooth slider updates during popup drag ---
let LIVE = { dragging: false, pollId: null };

function startLocalPoll() {
  if (LIVE.pollId) return; // already polling
  // Poll at ~30Hz to decouple rendering from popup focus/message cadence
  LIVE.pollId = setInterval(() => {
    chrome.storage.local.get(["vcp1_scale","vcp1_offset","vcp1_lerp"], (res) => {
      // Only apply present numeric values
      const patch = {};
      if (typeof res.vcp1_scale  === "number")  patch.vcp1_scale  = res.vcp1_scale;
      if (typeof res.vcp1_offset === "number")  patch.vcp1_offset = res.vcp1_offset;
      if (typeof res.vcp1_lerp   === "number")  patch.vcp1_lerp   = res.vcp1_lerp;
      if (Object.keys(patch).length) {
        applyConfigPatch(patch);
        if (followerEl && RUNTIME.meta) applyFrame();
      }
    });
  }, 33); // ~30fps
}

function stopLocalPoll() {
  if (LIVE.pollId) {
    clearInterval(LIVE.pollId);
    LIVE.pollId = null;
  }
}
// --- follow targeting: trail the cursor when moving; perch above when idle
function computeTarget() {
  const speed = RUNTIME.speedAvg || 0;
  const hasDir = speed > 40;
  const OFFSET = CONFIG.offset;

  // Desired offset direction (unit vector)
  let desiredX, desiredY;
  if (hasDir) {
    desiredX = -(RUNTIME.velAvg.x / (speed || 1));
    desiredY = -(RUNTIME.velAvg.y / (speed || 1));
  } else {
    desiredX = 0;
    desiredY = -1; // idle: above cursor
  }

  // Lerp offset direction so idle→walk transition glides instead of snapping
  const OD_LERP = 0.08;
  RUNTIME.offsetDir.x += (desiredX - RUNTIME.offsetDir.x) * OD_LERP;
  RUNTIME.offsetDir.y += (desiredY - RUNTIME.offsetDir.y) * OD_LERP;

  RUNTIME.target.x = (RUNTIME.lastMouse?.x || 0) + RUNTIME.offsetDir.x * OFFSET;
  RUNTIME.target.y = (RUNTIME.lastMouse?.y || 0) + RUNTIME.offsetDir.y * OFFSET;
}

// --- 8-way facing from a direction vector (octants) ---
// clockwise from right
const DIR8_KEYS = [
  "right",      // 0
  "frontRight", // 1
  "front",      // 2
  "frontLeft",  // 3
  "left",       // 4
  "backLeft",   // 5
  "back",       // 6
  "backRight"   // 7
];
const DIR8_HYSTERESIS = 8 * Math.PI / 180; // extra angle needed to leave the current octant
let dir8Idx = 2; // "front"

function pickDir8FromVector(vx, vy) {
  const dead = 0.3; // small deadzone to reduce jitter
  if (Math.abs(vx) <= dead && Math.abs(vy) <= dead) return "front";
  // DOM coords: +y is downward => vy>0 means "front"
  const angle = Math.atan2(vy, vx);                  // -PI..PI, 0 = right
  const norm  = (angle + 2 * Math.PI) % (2 * Math.PI); // 0..2PI
  // Sticky octants: only switch once the angle clearly exits the current
  // sector, so facing doesn't flap at diagonal boundaries (22.5°) when the
  // velocity estimate wobbles.
  let diff = norm - dir8Idx * (Math.PI / 4);
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) > Math.PI / 8 + DIR8_HYSTERESIS) {
    dir8Idx = Math.floor((norm + Math.PI / 8) / (Math.PI / 4)) % 8;
  }
  return DIR8_KEYS[dir8Idx];
}

// Map that direction to a row index using the pack's rows table for the given state
function pickRowForState(stateName, dx, dy) {
  const st = RUNTIME.meta?.states?.[stateName];
  if (!st) return 0;
  const rows = st.rows || { front: 0 };

  // Prefer 8-way if present, else fall back to nearest cardinal.
  // While walking, face the direction the follower is actually travelling —
  // the pos→target vector recomputed every frame in tick() — since that's
  // what's visibly happening on screen (cursor velocity can go stale the
  // moment the cursor stops, while the follower is still catching up).
  // At rest (idle/sleep) there's no travel direction, so always show front.
  // "hop"/"rotate" (hover reactions), "attack" (wander's spontaneous roll)
  // and "eat" (feeding, either mode) all play in place —
  // target is pinned to pos, so dx/dy read ~0 — so face whichever direction
  // it was last moving instead (WANDER.lastDir is updated by any actual
  // movement toward a target, not just in wander mode -- see tick()).
  let dir8;
  if (stateName === "walk") dir8 = pickDir8FromVector(dx, dy);
  else if (stateName === "attack" || stateName === "eat" || stateName === "hop" || stateName === "rotate") {
    dir8 = pickDir8FromVector(WANDER.lastDir.x, WANDER.lastDir.y);
  }
  else dir8 = "front";
  if (dir8 in rows) return rows[dir8];

  // Map diagonal to nearest cardinal if diagonal key missing
  const fallbackMap = {
    frontRight: "front",
    frontLeft:  "front",
    backRight:  "back",
    backLeft:   "back"
  };
  const fallback = fallbackMap[dir8] || dir8; // if already cardinal, keep it
  return (fallback in rows) ? rows[fallback] : (rows.front ?? 0);
}

// Once the extension is reloaded/updated, tabs that already had this content
// script injected lose their connection to it — chrome.runtime.id becomes
// undefined and any chrome.* call throws "Extension context invalidated".
// Checking this lets us shut down quietly instead of throwing on every frame.
function isExtensionContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

function extUrl(rel) { return chrome.runtime.getURL(rel); }

function createFollower() {
  if (followerEl) return;
  followerEl = document.createElement("div");
  followerEl.id = "__vcp1_follower";
  Object.assign(followerEl.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "40px",
    height: "40px",
    pointerEvents: "none",
    zIndex: "2147483647",
    willChange: "transform, background-position, background-image",
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated", // crisp for retro sheets
    // Only `transform` transitions (smooths scale/position changes). width/height
    // must snap instantly with background-position/-image on every state switch —
    // states can have differently-sized frames (e.g. attack vs idle), and easing
    // the box size while the sprite crop snaps produces a torn/ghosted frame for
    // the duration of the transition.
    transition: "transform 120ms linear"
  });
  document.documentElement.appendChild(followerEl);
}

function removeFollower() {
  if (followerEl?.parentNode) followerEl.parentNode.removeChild(followerEl);
  followerEl = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function packSlug() {
  // STATE.pack like "retro/gen-1/009-blastoise" -> "009-blastoise"
  const parts = STATE.pack.split("/");
  return parts[parts.length - 1];
}

function dexFromSlug(slug) {
  const dex = parseInt((slug || "").split("-")[0], 10);
  return Number.isFinite(dex) ? dex : null;
}

function generationForDex(dex) {
  if (!Number.isFinite(dex)) return null;
  if (dex >= 1 && dex <= 151) return "gen-1";
  if (dex <= 251) return "gen-2";
  if (dex <= 386) return "gen-3";
  if (dex <= 493) return "gen-4";
  if (dex <= 649) return "gen-5";
  if (dex <= 721) return "gen-6";
  if (dex <= 809) return "gen-7";
  if (dex <= 905) return "gen-8";
  return "gen-9";
}

function buildPackCandidates(packKey) {
  const clean = typeof packKey === "string" ? packKey.trim().replace(/^\/+|\/+$/g, "") : "";
  if (!clean) return [DEFAULT_PACK];
  const candidates = [clean];
  if (!clean.includes("/gen-")) {
    const parts = clean.split("/");
    const slug = parts.pop();
    const prefix = parts.join("/");
    const dex = dexFromSlug(slug);
    const inferred = generationForDex(dex);
    const pushCandidate = (gen) => {
      const candidate = `${prefix}/${gen}/${slug}`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    };
    if (inferred) pushCandidate(inferred);
    GENERATION_DIRS.forEach(pushCandidate);
  }
  return candidates;
}

async function fetchPackMeta(packKey) {
  const jsonPath = `assets/packs/${packKey}.json`;
  const res = await fetch(extUrl(jsonPath));
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} for ${jsonPath}`);
    error.status = res.status;
    throw error;
  }
  const meta = await res.json();
  if (!meta || !meta.states || !meta.states.idle || !meta.states.walk) {
    throw new Error("Pack schema invalid: missing states.idle or states.walk");
  }
  return meta;
}

function sheetUrlFor(stateName) {
  const st = RUNTIME.meta && RUNTIME.meta.states ? RUNTIME.meta.states[stateName] : null;
  const sheetFilename = st && st.sheet ? st.sheet : "";
  const metaPath = typeof RUNTIME.meta?.rawPath === "string" ? RUNTIME.meta.rawPath.trim() : "";
  const slug = metaPath ? metaPath.replace(/^\/+|\/+$/g, "") : packSlug();
  const rawFolder = `assets/raw/${slug}/`;
  return extUrl(rawFolder + sheetFilename);
}

function ensureImagesLoaded(meta) {
  const tasks = [];
  Object.keys(meta.states).forEach((k) => {
    const img = new Image();
    img.src = sheetUrlFor(k);
    RUNTIME.images[k] = img;
    tasks.push(new Promise((resolve) => {
      img.onload = resolve; img.onerror = resolve;
    }));
  });
  return Promise.all(tasks);
}
function resetAnimationForNewPack() {
  // Start from idle; row will be resolved in tick() via pickRowForState
  RUNTIME.anim = { name: "idle", frame: 0, row: 0, accMs: 0 };
  // A new pack may not have every state the old one did (e.g. no states.attack)
  // — restart the wander FSM fresh rather than leaving it stuck expecting an
  // animation name that no longer exists.
  WANDER.state = null;
  // Same reasoning for hover-to-attack: drop any in-progress attack/cooldown
  // bookkeeping tied to the old pack's sheet.
  HOVER.active = false;
  HOVER.reaction = null;
  HOVER.inside = false;
  HOVER.exitedSinceLastAttack = true;
  HOVER.cooldownUntil = 0;
  // A pack switch (manual, while an evolution flash happened to be mid-way)
  // should not leave the flash filter stuck applied to the new sprite.
  EVOLVE.active = false;
  // A mood bubble mid-display would otherwise keep showing the OLD pack's
  // portrait after switching -- the next renderMoodBubble() call (within one
  // frame) hides the DOM element once it sees this flag cleared.
  MOOD.active = false;
  // A feed mid-walk/eat targeting the OLD pack's states.eat (which the new
  // pack may not have) must not carry over -- cancel it and remove the apple
  // rather than leaving either stuck.
  resetFeeding();
}

// --- evolution / growth (XP) engine ---
// Hybrid XP: activity time + actual sprite movement distance + interaction
// (hover-attack), weighted interaction > distance > time per constant size
// below. These are a rough estimate -- there's no real usage telemetry to
// calibrate against yet -- grouped here so pacing can be retuned in one
// place. Target pace: a typical user who leaves the follower enabled and
// occasionally triggers a hover-attack reaches the first evolution threshold
// (level 16, e.g. Bulbasaur->Ivysaur) in roughly half a day of use.
const XP_PER_ACTIVE_MINUTE = 0.5;    // time: awarded once per full minute the engine ticks (STATE.enabled)
const XP_PER_PIXEL_MOVED   = 0.0015; // distance: per px of actual sprite movement (RUNTIME.pos delta in tick())
const XP_PER_HOVER_ATTACK  = 20;     // interaction: flat bonus per user-triggered hover attack (see triggerHoverAttack)
const LEVEL_XP_BASE = 5; // xpForLevel(L) = LEVEL_XP_BASE * (L-1)^2 -- cumulative XP required to BE level L

// --- hunger (Phase 3 feeding) ---
// Rises continuously with active engine time (same "engine is ticking" signal
// XP_PER_ACTIVE_MINUTE uses), reaching HUNGER_MAX after about 4 active hours
// with no feeding -- see the per-tick update in tick(). Feeding (see
// endFeeding() above) always resets it to 0.
const HUNGER_MAX = 100;
const HUNGER_FULL_MS = 4 * 60 * 60 * 1000; // ~4 active hours: 0 (full) -> HUNGER_MAX (hungry)
// "Sad" (hungry) trigger: same MOOD cooldown pattern as the idle-based Sad
// below (SAD_IDLE_MS/SAD_COOLDOWN_MS), just gated on hunger instead of idle
// time, and tracked with its own cooldown timestamp so the two triggers
// don't interfere with each other's rate limit.
const HUNGER_SAD_THRESHOLD = 70;
const HUNGER_SAD_COOLDOWN_MS = 30 * 60 * 1000;
let lastHungrySadShownAt = 0;
// Test-only override, same pattern/purpose as TEST_SLEEP_TIMEOUT_MS above:
// lastHungrySadShownAt starts at 0, so the real 30-minute cooldown otherwise
// blocks the very first hungry-Sad trigger until the engine has been running
// for 30 real minutes -- lets a CDP harness dial that down to something it
// can actually wait out. Inert unless a test explicitly calls it.
let TEST_HUNGER_SAD_COOLDOWN_MS = null;
function hungerSadCooldownMs() { return TEST_HUNGER_SAD_COOLDOWN_MS ?? HUNGER_SAD_COOLDOWN_MS; }

function xpForLevel(level) {
  const n = Math.max(1, level) - 1;
  return LEVEL_XP_BASE * n * n;
}
function levelForXp(xp) {
  return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL_XP_BASE));
}

// In-memory growth ledger, hydrated from chrome.storage.sync once at boot.
// { [dex3]: { xp } }, dex3 always keyed to whatever pack is CURRENTLY
// selected -- on evolution this same record moves (not resets) to the
// evolved form's dex, since it's the same creature growing (see evolveTo()).
const GROWTH = {};
let growthDirty = false;
let growthLoaded = false;
// dex3 keys removed from GROWTH (see evolveTo()) that must also be removed
// from storage on the next flush -- flushGrowth()'s merge only ever raises
// an existing key's xp, so without this the old pre-evolution dex would
// silently resurrect from storage instead of actually moving.
const growthDeletions = new Set();
// flushGrowth() does an async read-modify-write (storage.get then storage.set);
// without serializing, two flushes fired close together (e.g. a level-up
// flush racing the 30s interval) can both read the same stale "stored"
// value before either write lands, and the second write clobbers the
// first's result (lost update). See flushGrowth() for how these are used.
let flushInFlight = false;
let flushPending = false;
let xpTimeAccMs = 0; // minutes-of-activity accumulator for the time-based XP source

// { [dex3]: { to: [{ dex, level }] } } from evolutions.json (build:evolutions).
let EVOLUTIONS = {};
// { [dex3]: packId } from index.json -- resolves an evolution target's bare
// dex number into a loadable pack path (evolutions.json only carries dex+level).
let PACK_INDEX_BY_DEX = {};

// { [rawPath]: string[] } from assets/portraits/index.json -- which emotion
// portraits actually exist for a given pack (see the "mood bubble" section
// below). Coverage varies per-Pokémon since it was downloaded from PMD
// SpriteCollab, which doesn't have every emotion drawn for every species.
let PORTRAIT_COVERAGE = {};

let UNLOCKED = new Set(); // dex3 strings the user has unlocked (evolved into, or grandfathered in)
// { dex, choices: [{dex, level}] } | null -- a branch evolution (e.g. Eevee)
// awaiting a user choice in Settings. Persisted so it survives a restart.
let PENDING_EVOLUTION = null;

const EVOLVE_FLASH_MS = 1400; // silhouette-flash duration before the pack actually switches
const EVOLVE = { active: false, startedAt: 0 }; // drives the flash filter in applyFrame()

function currentGrowthDex() {
  const dex = dexFromSlug(packSlug());
  return Number.isFinite(dex) ? String(dex).padStart(3, "0") : "";
}

// Get-or-create a dex3's growth record, backfilling hunger/lastFedAt (Phase 3
// fields) onto an older record that only ever had `xp` -- returns the SAME
// object stored in GROWTH so callers mutate it in place rather than replacing
// the record wholesale (see awardXP() below, which used to do exactly that
// and would have silently wiped these fields on every single XP grant).
function ensureGrowthRecord(dex3) {
  if (!GROWTH[dex3]) GROWTH[dex3] = { xp: 0, hunger: 0, lastFedAt: 0 };
  const rec = GROWTH[dex3];
  if (typeof rec.xp !== "number") rec.xp = 0;
  if (typeof rec.hunger !== "number") rec.hunger = 0;
  if (typeof rec.lastFedAt !== "number") rec.lastFedAt = 0;
  return rec;
}

async function fetchJsonAsset(rel, fallback) {
  try {
    const res = await fetch(extUrl(rel));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    // Silent fallback (same pattern as popup.js's Korean-name lookup): a
    // missing/broken asset must not block pack loading or leave everything
    // permanently locked.
    console.warn(`PokeFollower: ${rel} unavailable`, e);
    return fallback;
  }
}

async function loadEvolutionData() {
  const [evolutions, index] = await Promise.all([
    fetchJsonAsset("assets/packs/evolutions.json", {}),
    fetchJsonAsset("assets/packs/index.json", { retro: [] })
  ]);
  EVOLUTIONS = evolutions || {};
  const byDex = {};
  for (const entry of (index && index.retro) || []) {
    const dex = dexFromSlug((entry.id || "").split("/").pop());
    if (Number.isFinite(dex)) byDex[String(dex).padStart(3, "0")] = entry.id;
  }
  PACK_INDEX_BY_DEX = byDex;
}

// Best-effort fetch of the portrait coverage map; silent empty-map fallback
// on failure -- same pattern as loadEvolutionData() above. An empty/missing
// map just means portraitUrlForEmotion() always returns null, so the mood
// bubble quietly never appears rather than blocking pack loading.
async function loadPortraitCoverage() {
  PORTRAIT_COVERAGE = await fetchJsonAsset("assets/portraits/index.json", {});
}

// A dex is locked iff *some non-baby* source evolves into it -- a baby's own
// immediate evolution (e.g. Pichu -> Pikachu) is exempt: nobody starts with
// a baby (it only appears via breeding), so its result is selectable from
// the start. The baby's own further evolution (e.g. Pikachu -> Raichu)
// still locks normally, since that source isn't itself a baby.
function isLockedDex(dex3) {
  return Object.values(EVOLUTIONS).some((e) => !e.baby && e.to.some((t) => t.dex === dex3));
}

function hydrateGrowthState(res) {
  Object.assign(GROWTH, res.vcp1_growth || {});
  UNLOCKED = new Set(res.vcp1_unlocked || []);
  PENDING_EVOLUTION = res.vcp1_pending_evolution || null;
  growthLoaded = true;

  // Migration: an existing user's currently-selected pack may itself be a
  // locked evolution result (e.g. this build's own default, Blastoise) --
  // grandfather it in rather than leaving an existing selection unselectable.
  const dex3 = currentGrowthDex();
  if (dex3 && isLockedDex(dex3) && !UNLOCKED.has(dex3)) {
    UNLOCKED.add(dex3);
    persistUnlocked();
  }
}

// Union with whatever's already stored (rather than overwrite) so two tabs
// each unlocking something at nearly the same time can't clobber each other.
function persistUnlocked() {
  try {
    chrome.storage.sync.get(["vcp1_unlocked"], (res) => {
      const stored = new Set(res.vcp1_unlocked || []);
      for (const d of UNLOCKED) stored.add(d);
      chrome.storage.sync.set({ vcp1_unlocked: Array.from(stored) });
    });
  } catch (_) {}
}
function persistPendingEvolution() {
  try { chrome.storage.sync.set({ vcp1_pending_evolution: PENDING_EVOLUTION }); } catch (_) {}
}

// Flush at most every 30s (see the interval below) plus around important
// events (level-up, evolution, beforeunload) -- never on every tick. Reads
// the currently-stored value first and keeps whichever xp is higher: the
// Chrome extension runs one of these engines per open tab, all sharing this
// same storage but each with its own independent in-memory GROWTH, so a
// stale tab flushing last must not roll a dex's xp backward.
function flushGrowth() {
  if (!growthDirty || !growthLoaded) return;
  // Serialize: if a flush is already mid-flight, don't start a second
  // overlapping read-modify-write -- just note that another flush is needed
  // and let the in-flight one's completion callback pick it up with
  // whatever GROWTH/growthDeletions look like by then.
  if (flushInFlight) { flushPending = true; return; }
  growthDirty = false;
  flushInFlight = true;
  const toWrite = { ...GROWTH };
  const toDelete = new Set(growthDeletions);
  growthDeletions.clear();
  const done = () => {
    flushInFlight = false;
    if (flushPending) {
      flushPending = false;
      growthDirty = true; // guarantee the deferred flush actually runs
      flushGrowth();
    }
  };
  try {
    chrome.storage.sync.get(["vcp1_growth"], (res) => {
      const stored = res.vcp1_growth || {};
      const merged = { ...stored };
      for (const dex of Object.keys(toWrite)) {
        const storedXp = (stored[dex] && stored[dex].xp) || 0;
        const localXp = toWrite[dex].xp || 0;
        // hunger: not monotonic like xp (feeding resets it), so the flushing
        // tab's own value simply wins rather than taking a max -- correct for
        // the common single-engine case (desktop's one engine window; the
        // extension's usual one active tab) this app is actually built for.
        const storedHunger = (stored[dex] && stored[dex].hunger) || 0;
        const localHunger = (typeof toWrite[dex].hunger === "number") ? toWrite[dex].hunger : storedHunger;
        // lastFedAt IS monotonic (a feed timestamp only ever moves forward),
        // so max is safe/correct here same as xp.
        const storedFedAt = (stored[dex] && stored[dex].lastFedAt) || 0;
        const localFedAt = (typeof toWrite[dex].lastFedAt === "number") ? toWrite[dex].lastFedAt : 0;
        merged[dex] = { xp: Math.max(storedXp, localXp), hunger: localHunger, lastFedAt: Math.max(storedFedAt, localFedAt) };
      }
      // Only actually remove a deleted dex if nothing re-added it in the same
      // flush (defensive; in-memory GROWTH never does this today).
      for (const dex of toDelete) {
        if (!(dex in toWrite)) delete merged[dex];
      }
      chrome.storage.sync.set({ vcp1_growth: merged }, done);
    });
  } catch (_) {
    done();
  }
}
setInterval(flushGrowth, 30000);

function awardXP(amount) {
  // EVOLVE.active also guards the async gap inside evolveTo() below (it now
  // stays true until the pack switch has actually landed, not just for the
  // flash) -- see evolveTo() for why: currentGrowthDex() would otherwise
  // still resolve to the just-evolved-away-from dex during that gap, and
  // awarding XP there would resurrect its already-deleted GROWTH record.
  if (!growthLoaded || !(amount > 0) || EVOLVE.active) return;
  const dex3 = currentGrowthDex();
  if (!dex3) return;
  const rec = ensureGrowthRecord(dex3);
  const prevXp = rec.xp || 0;
  const prevLevel = levelForXp(prevXp);
  const nextXp = prevXp + amount;
  rec.xp = nextXp; // mutate in place -- preserves hunger/lastFedAt on the same record
  growthDirty = true;
  const nextLevel = levelForXp(nextXp);
  if (nextLevel > prevLevel) {
    flushGrowth(); // persist promptly around a level-up rather than waiting for the timer
    checkEvolution(dex3, nextLevel);
  }
}

// Simplification: only one evolution decision is tracked at a time (Phase 1
// has a single active pack, not a roster), so a pending choice for ANY dex
// blocks new checks globally until it's resolved.
function checkEvolution(dex3, level) {
  if (EVOLVE.active || PENDING_EVOLUTION) return;
  const entry = EVOLUTIONS[dex3];
  if (!entry || !entry.to || !entry.to.length) return;
  if (entry.to.length === 1) {
    if (level >= entry.to[0].level) evolveTo(dex3, entry.to[0].dex);
    return;
  }
  // Branch (e.g. Eevee): Phase 1 has no per-method state (stone/trade/
  // friendship) to prefer one branch over another, so becoming eligible for
  // the *lowest* threshold among the branches offers every option at once.
  const minLevel = Math.min(...entry.to.map((t) => t.level));
  if (level >= minLevel) {
    PENDING_EVOLUTION = { dex: dex3, choices: entry.to };
    persistPendingEvolution();
  }
}

// Executes an evolution: white-silhouette flash, then the pack switch. Used
// both for an automatic single-path evolution and a user-chosen branch pick
// (from Settings, via the "vcp1_evolve_trigger" storage.onChanged listener below).
function evolveTo(fromDex3, toDex3) {
  // Reentrancy guard: a second trigger while a flash is already in progress
  // (e.g. a double-clicked branch-choice button, both messages landing
  // before PENDING_EVOLUTION clears at the end of the first flash) must not
  // schedule a second pack-switch -- two overlapping setTimeout callbacks
  // would race on GROWTH[fromDex3]/[toDex3], and the second one reads it
  // *after* the first has already deleted it, silently zeroing the XP that
  // was just moved.
  if (EVOLVE.active) return;
  const targetId = PACK_INDEX_BY_DEX[toDex3];
  if (!targetId) return; // build:evolutions asserts every target exists in index.json; defensive no-op otherwise
  EVOLVE.active = true;
  EVOLVE.startedAt = performance.now();
  setTimeout(async () => {
    // NOTE: EVOLVE.active is deliberately *not* cleared here -- see below.
    // Move the growth record: same creature, new dex, XP carries over as-is.
    const record = GROWTH[fromDex3] || { xp: 0 };
    delete GROWTH[fromDex3];
    growthDeletions.add(fromDex3);
    GROWTH[toDex3] = record;
    growthDirty = true;
    UNLOCKED.add(toDex3);
    persistUnlocked();
    if (PENDING_EVOLUTION && PENDING_EVOLUTION.dex === fromDex3) {
      PENDING_EVOLUTION = null;
      persistPendingEvolution();
    }
    flushGrowth();
    try {
      // loadPack() is async (awaits a fetch before it sets STATE.pack) --
      // currentGrowthDex() reads STATE.pack, so between the record move just
      // above and STATE.pack actually landing on toDex3, it would otherwise
      // still resolve to fromDex3, which GROWTH no longer has a record for.
      // Any XP/hunger accrual that ran a tick() during that gap used to
      // call ensureGrowthRecord(fromDex3) and silently resurrect it as
      // { xp: 0, hunger: 0, lastFedAt: 0 } -- a zombie that then got
      // persisted on the next flush. Keeping EVOLVE.active true across this
      // whole await (awardXP() and the hunger accrual in tick() both now
      // check it) closes that gap; resetAnimationForNewPack() -- called from
      // inside loadPack() right after STATE.pack switches -- is what finally
      // clears it, so accrual only resumes once currentGrowthDex() is
      // already correctly pointing at toDex3.
      await loadPack(targetId);
      chrome.storage.sync.set({ vcp1_pack: targetId });
      triggerMood("Joyous"); // evolution complete -- portrait is for the newly-evolved pack, loadPack() already switched
      // A single big XP grant can cross more than one threshold at once
      // (e.g. 001->002->003) -- re-check from the new dex so growth chains
      // through every step it has already earned, one flash at a time.
      checkEvolution(toDex3, levelForXp(record.xp));
    } catch (e) {
      // loadPack() failed before reaching resetAnimationForNewPack(), so
      // EVOLVE.active would otherwise be stuck true forever -- freezing all
      // future XP/hunger accrual. Clear it manually so the (still-old) pack
      // keeps growing normally even though this evolution attempt failed.
      EVOLVE.active = false;
      console.warn("evolution pack load failed", e);
    }
  }, EVOLVE_FLASH_MS);
}

function applyFrame() {
  const st = RUNTIME.meta && RUNTIME.meta.states && RUNTIME.meta.states[RUNTIME.anim.name];
  if (!st || !st.frame || typeof st.frames !== "number" || !Number.isFinite(st.frames)) {
    // Defensive: if pack schema is missing or wrong, skip this frame rather than crash
    return;
  }
  const { w, h } = st.frame;
  const frame = RUNTIME.anim.frame % st.frames;
  const rowIndex = RUNTIME.anim.row || 0;
  const bpx = -(frame * w);
  const bpy = -(rowIndex * h);

  const sheetUrl = sheetUrlFor(RUNTIME.anim.name);
  followerEl.style.width  = `${w}px`;
  followerEl.style.height = `${h}px`;
  followerEl.style.backgroundImage = `url("${sheetUrl}")`;
  // Keep sheet at natural size so backgroundPosition aligns to frame pixels
  const img = RUNTIME.images[RUNTIME.anim.name];
  if (img?.naturalWidth && img?.naturalHeight) {
    followerEl.style.backgroundSize = `${img.naturalWidth}px ${img.naturalHeight}px`;
  }
  followerEl.style.backgroundRepeat = "no-repeat";
  followerEl.style.imageRendering = "pixelated";
  followerEl.style.backgroundPosition = `${bpx}px ${bpy}px`;

  // RUNTIME.pos is in global desktop coordinates when a world provider is
  // present (see getWorldInfo); this window's own DOM viewport only spans its
  // one display, so translate global -> local by subtracting this window's
  // origin before painting. Origin is {0,0} in the browser (no provider) or
  // before the desktop app's first world round trip, leaving pos unchanged.
  const world = getWorldInfo();
  const originX = world ? world.origin.x : 0;
  const originY = world ? world.origin.y : 0;
  const localX = RUNTIME.pos.x - originX;
  const localY = RUNTIME.pos.y - originY;

  const SCALE_VAL = CONFIG.scale;
  // CSS-bounce fallback for feeding on packs with no states.eat (see
  // startEatPhase()): a small vertical hop, cycling continuously for the
  // phase's duration. Folded directly into the same y used below (both for
  // this window's own transform AND the value relayed to mirrors), so mirror
  // windows reproduce the hop with zero extra code on their side.
  let feedBounceY = 0;
  if (FEEDING.active && FEEDING.phase === "bounce") {
    const bt = ((performance.now() - FEEDING.phaseStartedAt) % FEED_BOUNCE_MS) / FEED_BOUNCE_MS;
    feedBounceY = -Math.abs(Math.sin(bt * Math.PI)) * FEED_BOUNCE_HEIGHT_PX;
  }
  followerEl.style.transform =
    `translate(${Math.round(localX)}px, ${Math.round(localY + feedBounceY)}px) ` +
    `translate(-50%, -50%) ` +
    `scale(${SCALE_VAL})`;
  followerEl.style.transformOrigin = "center center";

  // Evolution silhouette: blink between a flat white cutout and the normal
  // sprite while EVOLVE.active (see evolveTo()) — a lightweight stand-in for
  // a real evolution animation using only CSS filters on the existing sheet.
  const evolveFilter = EVOLVE.active && Math.floor((performance.now() - EVOLVE.startedAt) / 150) % 2 === 0
    ? "brightness(0) invert(1)"
    : "";
  followerEl.style.filter = evolveFilter;

  // Mood bubble: positions/fades this window's own bubble element (if a mood
  // is active) and hands back the payload to relay to mirrors below.
  const moodPayload = renderMoodBubble();

  // Apple: positions this window's own apple element (drop-in fall animation)
  // while a feed is in progress, and hands back the payload to relay to
  // mirrors below -- same pattern as the mood bubble above.
  const applePayload = renderApple();

  // Desktop app only: hand a snapshot of what was just painted to any mirror
  // windows on other displays, so they can render the same sprite without
  // running this engine themselves. Undefined (and this whole block skipped)
  // in the Chrome extension and in the desktop app's own engine-less windows.
  if (window.__VCP1_SNAPSHOT_SINK__) {
    window.__VCP1_SNAPSHOT_SINK__({
      x: RUNTIME.pos.x, y: RUNTIME.pos.y + feedBounceY,
      w, h, bgImage: sheetUrl, bpx, bpy,
      bgSizeW: img?.naturalWidth || 0, bgSizeH: img?.naturalHeight || 0,
      scale: SCALE_VAL, filter: evolveFilter,
      mood: moodPayload,
      apple: applePayload
    });
  }
}

function pickStateBySpeed() {
  const now = performance.now();
  // If the pack has a 'sleep' state and we've been inactive long enough, sleep.
  if (hasState("sleep") && (now - RUNTIME.lastMoveTs) > sleepTimeoutMs()) {
    return "sleep";
  }
  // Otherwise mirror the follower's own motion: walking while it's actually
  // travelling toward its target, idle once it arrives — so the animation
  // always matches what's happening on screen rather than the cursor's speed.
  return RUNTIME.isWalking ? "walk" : "idle";
}

// --- wander mode: autonomous roam/pause/attack FSM ---
// Viewport-only (window.innerWidth/Height), so it behaves identically in the
// browser extension and the fullscreen desktop overlay.
const WANDER_MARGIN_EXTRA = 20;                 // px, added to sprite size for edge clearance
const ROAM_PAUSE_MIN_MS = 2000, ROAM_PAUSE_MAX_MS = 8000;
const ATTACK_CHANCE = 0.15; // only rolled when the pack has a states.attack sheet

function randRange(min, max) { return min + Math.random() * (max - min); }

function getSpriteMargin() {
  const st = RUNTIME.meta?.states?.walk;
  const w = st?.frame?.w || 40;
  const h = st?.frame?.h || 40;
  return Math.max(w, h) * CONFIG.scale + WANDER_MARGIN_EXTRA;
}

function clampToViewport(pt) {
  const margin = getSpriteMargin();
  const world = getWorldInfo();
  if (world) {
    // Clamp into the bounding box of every display combined. Not perfect for
    // gaps between non-adjacent monitors, but this only runs as a safety net
    // on world changes (resize/hotplug) — normal roam waypoints are sampled
    // per-display below, which avoids the dead space this box can contain.
    const { x, y, w, h } = world.union;
    const maxX = Math.max(x + margin, x + w - margin);
    const maxY = Math.max(y + margin, y + h - margin);
    pt.x = Math.min(Math.max(pt.x, x + margin), maxX);
    pt.y = Math.min(Math.max(pt.y, y + margin), maxY);
    return;
  }
  const maxX = Math.max(margin, window.innerWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - margin);
  pt.x = Math.min(Math.max(pt.x, margin), maxX);
  pt.y = Math.min(Math.max(pt.y, margin), maxY);
}

function pickRoamWaypoint() {
  const margin = getSpriteMargin();
  const world = getWorldInfo();
  if (world) {
    // Sample a real display rect (area-weighted) rather than the union
    // bounding box, so waypoints never land in the dead space between
    // non-aligned monitors.
    const rects = world.displays;
    const weights = rects.map((r) => Math.max(1, r.w * r.h));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let chosen = rects[rects.length - 1];
    for (let i = 0; i < rects.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = rects[i]; break; }
    }
    const loX = chosen.x + margin, hiX = Math.max(loX, chosen.x + chosen.w - margin);
    const loY = chosen.y + margin, hiY = Math.max(loY, chosen.y + chosen.h - margin);
    return { x: randRange(loX, hiX), y: randRange(loY, hiY) };
  }
  const maxX = Math.max(margin, window.innerWidth - margin);
  const maxY = Math.max(margin, window.innerHeight - margin);
  return { x: randRange(margin, maxX), y: randRange(margin, maxY) };
}

function enterRoam() {
  WANDER.state = "roam";
  const wp = pickRoamWaypoint();
  RUNTIME.target.x = wp.x;
  RUNTIME.target.y = wp.y;
}

function enterPause() {
  WANDER.state = "pause";
  WANDER.until = performance.now() + randRange(ROAM_PAUSE_MIN_MS, ROAM_PAUSE_MAX_MS);
  RUNTIME.target.x = RUNTIME.pos.x; // stand still — no drift while paused
  RUNTIME.target.y = RUNTIME.pos.y;
}

function enterAttack() {
  WANDER.state = "attack";
  WANDER.attackCyclesLeft = 1 + Math.floor(Math.random() * 2); // 1 or 2 full cycles
  // Wall-clock backstop alongside the frame-cycle counting in tick(): if that
  // counting never fires (e.g. the sheet/fps disappear out from under it), this
  // still forces an exit instead of leaving the FSM stuck on "attack" forever.
  const st = RUNTIME.meta?.states?.attack;
  const cycleMs = (st && st.fps) ? (st.frames / st.fps) * 1000 : 1000;
  WANDER.until = performance.now() + WANDER.attackCyclesLeft * cycleMs + 1000;
  RUNTIME.target.x = RUNTIME.pos.x;
  RUNTIME.target.y = RUNTIME.pos.y;
}

// Decide what happens once a PAUSE's idle timer runs out. Sleep is
// deliberately *not* rolled here: the sprite only ever falls asleep from real
// cursor inactivity (see tickWander's idle-sleep below), never spontaneously.
function choosePostPause() {
  // Skip the self-rolled attack while a hover reaction is already playing (see
  // the hover reaction section below) — avoids two independent in-place
  // animation cycles racing each other.
  if (!HOVER.active && hasState("attack") && Math.random() < ATTACK_CHANCE) { enterAttack(); return; }
  enterRoam();
}

function enterIdleSleep(now) {
  WANDER.state = "sleep";
  WANDER.sleepEnteredAt = now;
  RUNTIME.target.x = RUNTIME.pos.x;
  RUNTIME.target.y = RUNTIME.pos.y;
}

// Advance the FSM's own timers/arrivals. "attack" is advanced separately, by
// frame-cycle counting in tick()'s animation stepper below (it needs to count
// sprite-sheet loops, not wall-clock time).
function tickWander(now) {
  // Idle-triggered sleep: falls asleep from wherever it currently is once the
  // cursor has been stationary for wanderSleepTimeoutMs(), and wakes the
  // instant it moves again. This is the *only* way the sprite sleeps —
  // choosePostPause() no longer rolls a spontaneous nap, so sleep always means
  // "the user actually stopped moving the mouse". Never interrupts an
  // in-progress attack.
  if (hasState("sleep") && WANDER.state !== "sleep" && WANDER.state !== "attack" &&
      (now - RUNTIME.lastMoveTs) > wanderSleepTimeoutMs()) {
    enterIdleSleep(now);
    return;
  }

  if (!WANDER.state) { enterRoam(); return; }
  if (WANDER.state === "sleep") {
    if (RUNTIME.lastMoveTs > WANDER.sleepEnteredAt) enterRoam(); // cursor moved -> wake up
  } else if (WANDER.state === "roam") {
    if (!RUNTIME.isWalking) enterPause(); // arrived at the waypoint last frame
  } else if (WANDER.state === "pause") {
    if (now >= WANDER.until) choosePostPause();
  } else if (WANDER.state === "attack") {
    // Normally the frame-cycle counter in tick() ends attack first; this only
    // fires if that counting never got a chance to run.
    if (now >= WANDER.until) enterPause();
  }
}

function wanderDesiredState() {
  switch (WANDER.state) {
    case "roam":   return RUNTIME.isWalking ? "walk" : "idle";
    case "sleep":  return hasState("sleep") ? "sleep" : "idle";
    case "attack": return hasState("attack") ? "attack" : "idle";
    case "pause":
    default:       return "idle";
  }
}

// Keep the roam waypoint (and the follower itself, if it's standing still in
// pause/sleep/attack) inside a viewport that just got resized.
function onViewportResize() {
  if (STATE.mode !== "wander") return;
  clampToViewport(RUNTIME.pos);
  clampToViewport(RUNTIME.target);
}
window.addEventListener("resize", onViewportResize, { passive: true });
// Desktop app only: displays connect/disconnect/rearrange independently of any
// window resize. The shim dispatches this whenever window.__VCP1_WORLD__ is
// (re)pushed, so wander's clamp reruns against the new layout. No listener
// ever fires in the Chrome extension since nothing dispatches this event there.
window.addEventListener("vcp1:world-updated", onViewportResize, { passive: true });

// --- hover-to-attack: cursor-over-sprite trigger, independent of the
// follow/wander FSM above so it behaves identically in both modes. This
// section only owns containment/cooldown bookkeeping and start/end; tick()
// applies the actual freeze + forced "attack" animation using HOVER.active.
const HOVER_COOLDOWN_MS = 2000; // floor before a new attack can start, on top of the exit+re-entry requirement below
// Containment alone isn't enough to mean "the user placed the cursor on the
// sprite": a fast cursor motion can pass straight through the box (e.g. the
// follow-mode perch sits just ~30px above the cursor, so any quick upward
// flick clips it), and the sprite itself can walk up to a cursor that's been
// sitting still for a while (ordinary follow-mode perching). Both read as a
// same-frame "entering" edge but aren't a deliberate hover, so two more
// signals gate the trigger alongside containment/exit-reentry/cooldown:
const HOVER_MAX_SPEED_PXPS = 120; // cursor must be moving slowly — "placed and staying", not "passing through"
const HOVER_RECENCY_MS = 150;     // cursor itself must have moved recently — not the sprite walking up to a parked cursor
// The speed check above deliberately reads RUNTIME.lastMoveInstantSpeed (each
// mousemove's own raw, unsmoothed px/s), not the EMA'd RUNTIME.speedAvg used
// elsewhere (offsetDir/facing) — the EMA blends every new sample with
// whatever it was on the *previous* event, so right after a long still
// period a fast, steady cursor feed's first couple of ticks still read as
// slow: tick 1's own delta gets divided by the huge gap since the last real
// event (reads as if it crawled), and tick 2 — despite its own gap and speed
// both being genuinely fast — blends in a large weighted share of tick 1's
// still-tiny carried-over average, understating the true rate for another
// tick. This was reproduced concretely: the real facing smoke probe's 500px/s
// feed, ~1 tick after the cursor had been still for seconds, transiently
// read as ~118px/s on the EMA — just under this gate — long enough for a
// spurious trigger. Reading the instantaneous per-event value sidesteps the
// carryover entirely. HOVER_WARM_GAP_MS below still separately guards against
// trusting a single isolated movement's own delta when its *own* preceding
// gap was itself huge (the same stale-gap arithmetic, one level up).
const HOVER_WARM_GAP_MS = 150;
const HOVER = {
  inside: false,                // cursor is within the current frame's rendered box
  exitedSinceLastAttack: true,  // must go true (cursor left the box) before retriggering
  cooldownUntil: 0,             // performance.now() floor before a new attack can start
  active: false,                // a reaction cycle triggered by hover is currently playing
  reaction: null,               // which state is playing this time -- "hop" | "rotate" (see pickHoverReaction())
  cyclesLeft: 0,
  until: 0                      // wall-clock backstop, mirrors enterAttack()'s pattern
};

// Reaction variety: each hover trigger rolls among whichever of these states
// the current pack actually has (see pickHoverReaction()). Deliberately only
// the *pleased* reactions -- "attack" used to be in this pool but reads as the
// sprite lashing out at the cursor rather than reacting happily to being
// played with, which is what a hover means (triggerHoverAttack() also fires
// triggerMood("Happy")). Wander mode's own spontaneous 15% attack roll
// (ATTACK_CHANCE/enterAttack() above) is separate and unaffected.
const HOVER_REACTION_WEIGHTS = { hop: 1, rotate: 1 };

function hasHoverReactionAvailable() {
  return Object.keys(HOVER_REACTION_WEIGHTS).some(hasState);
}

// Weighted random pick among only the reaction states this pack's loaded
// meta actually has. updateHover() already gates on hasHoverReactionAvailable()
// before ever calling this, so the pool is never empty in practice; the
// "hop" fallback below is defensive only.
function pickHoverReaction() {
  const pool = Object.keys(HOVER_REACTION_WEIGHTS).filter(hasState);
  if (!pool.length) return "hop";
  const total = pool.reduce((sum, name) => sum + HOVER_REACTION_WEIGHTS[name], 0);
  let roll = Math.random() * total;
  for (const name of pool) {
    roll -= HOVER_REACTION_WEIGHTS[name];
    if (roll <= 0) return name;
  }
  return pool[pool.length - 1];
}

function updateHover(now) {
  if (FEEDING.active) { HOVER.inside = false; return; } // never layer hover-attack on top of an in-progress feed
  if (!hasHoverReactionAvailable()) { HOVER.inside = false; return; } // no hop/rotate sheet -> ignore hover entirely
  const st = RUNTIME.meta.states[RUNTIME.anim.name] || RUNTIME.meta.states.idle;
  const halfW = (st.frame.w * CONFIG.scale) / 2;
  const halfH = (st.frame.h * CONFIG.scale) / 2;
  const inside = Math.abs(RUNTIME.lastMouse.x - RUNTIME.pos.x) <= halfW &&
                 Math.abs(RUNTIME.lastMouse.y - RUNTIME.pos.y) <= halfH;

  if (!inside) HOVER.exitedSinceLastAttack = true;

  const enteringNow = inside && !HOVER.inside;
  const movingSlowEnough = RUNTIME.lastMoveInstantSpeed < HOVER_MAX_SPEED_PXPS && RUNTIME.lastMoveGapMs < HOVER_WARM_GAP_MS;
  const cursorRecentlyMoved = (now - RUNTIME.lastMoveTs) < HOVER_RECENCY_MS;
  if (!HOVER.active && enteringNow && HOVER.exitedSinceLastAttack && now >= HOVER.cooldownUntil &&
      movingSlowEnough && cursorRecentlyMoved) {
    triggerHoverAttack(now);
  }

  // Wall-clock backstop: end even if frame-cycle counting in tick() never
  // gets a chance to run (e.g. the sheet/fps disappear out from under it).
  if (HOVER.active && now >= HOVER.until) endHoverAttack(now);

  HOVER.inside = inside;
}

function triggerHoverAttack(now) {
  HOVER.active = true;
  HOVER.reaction = pickHoverReaction();
  TEST_LAST_HOVER_REACTION = HOVER.reaction;
  HOVER.exitedSinceLastAttack = false;
  HOVER.cyclesLeft = 1;
  const st = RUNTIME.meta.states[HOVER.reaction];
  const cycleMs = (st && st.fps) ? (st.frames / st.fps) * 1000 : 1000;
  HOVER.until = now + cycleMs + 1000;
  // Interaction bonus: a deliberate user-triggered hover reaction, not the
  // wander FSM's own random attack roll (enterAttack()) -- that one isn't
  // user interaction, so it earns no XP.
  awardXP(XP_PER_HOVER_ATTACK);
  triggerMood("Happy"); // being played with -- same "deliberate user interaction" distinction as the XP bonus above
}

function endHoverAttack(now) {
  HOVER.active = false;
  HOVER.reaction = null;
  HOVER.cooldownUntil = now + HOVER_COOLDOWN_MS;
  // No wake-up handling needed here: "sleep" is now the only sleeping state
  // and it wakes on its own in tickWander(), since the hover that triggered
  // this reaction necessarily refreshed RUNTIME.lastMoveTs.
}

// --- feeding: apple-drop + walk-to-eat sequence, triggered by the tray menu
// (desktop) or a Settings button (popup/extension) -- both land on the same
// "vcp1_feed_trigger" storage write (see the chrome.storage.onChanged
// listener near the bottom of this file). Interrupts whichever mode is
// active (follow or wander) the same way HOVER's attack freeze does: pins
// the travel target and overrides the desired animation state (see tick()),
// then hands control back to
// whatever the underlying FSM was doing once the sequence completes -- no
// explicit "resume" bookkeeping needed since wander's own state/timers are
// simply frozen (not reset) for the duration.
const FEED_XP_BONUS = 30;
const FEED_COOLDOWN_MS = 30 * 60 * 1000;        // 30 min between XP-granting feeds (spam guard)
const FEED_DROP_MIN_PX = 100, FEED_DROP_MAX_PX = 200; // apple lands 100-200px from the sprite
const FEED_ARRIVE_RADIUS_PX = 10;
const FEED_FALL_MS = 400;            // apple's drop-in CSS animation duration
const FEED_WALK_BACKSTOP_MS = 10000; // wall-clock backstop for the whole walk-to-apple leg
const FEED_BOUNCE_CYCLES = 3;        // CSS-bounce fallback repeat count (packs with no states.eat)
const FEED_BOUNCE_MS = 260;          // one bounce up-down cycle duration
const FEED_BOUNCE_HEIGHT_PX = 10;    // peak height of the CSS bounce hop

const FEEDING = {
  active: false,        // true for the whole walk-to-apple + eat/bounce sequence
  phase: null,          // "walk" | "eat" | "bounce"
  applePos: null,       // { x, y } global coords of the dropped apple, or null
  appleDroppedAt: 0,    // performance.now() when the apple appeared (drives its fall-in animation)
  phaseStartedAt: 0,    // performance.now() when the current phase (eat/bounce) began
  eatCyclesLeft: 0,
  until: 0              // wall-clock backstop for the whole sequence, mirrors enterAttack()'s pattern
};

// Small original 16x16 pixel-art apple (hand-authored geometry, not sourced
// from PMD SpriteCollab or any other third-party asset -- unlike the sprite
// sheets, this is art this project owns outright, so a plain data: URI needs
// no extension manifest entry or poke:// path plumbing in either environment).
const APPLE_SIZE_PX = 16;
const APPLE_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAApklEQVR42mNgGNQgxkrxPwMDA4PPArf/enl6/7GpYSLWMDkjCQZchhDlCpLBYgkJuMYPKVE4DWHEpdFUSIhBwsoAQ4PAnGWMOA1YLCHx31RIiEF9SgMDAwMDw8dlG7DaimwIPBBvaGn9NxUSgiu6mdNAlPcYkQ0gJmxOv3vHwMDAwBD74gUjSdGIrJmsdIBNM9EG4NJMMBqxaYb5HacB2EIam0aqAQDmajk2Ztb5vAAAAABJRU5ErkJggg==";

let appleEl = null;
function createAppleElement() {
  if (appleEl) return;
  appleEl = document.createElement("div");
  appleEl.id = "__vcp1_apple";
  Object.assign(appleEl.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${APPLE_SIZE_PX}px`,
    height: `${APPLE_SIZE_PX}px`,
    backgroundImage: `url("${APPLE_DATA_URI}")`,
    backgroundSize: "contain",
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
    pointerEvents: "none",
    zIndex: "2147483646", // just under the follower sprite (2147483647)
    willChange: "transform"
  });
  document.documentElement.appendChild(appleEl);
}
function removeAppleElement() {
  if (appleEl?.parentNode) appleEl.parentNode.removeChild(appleEl);
  appleEl = null;
}

// Ends the whole feeding sequence unconditionally (natural completion OR the
// wall-clock backstop) -- always tears down the apple element so a timed-out
// sequence can never leave a stuck ghost apple on screen.
function resetFeeding() {
  FEEDING.active = false;
  FEEDING.phase = null;
  FEEDING.applePos = null;
  removeAppleElement();
}

// Pick a point 100-200px from the sprite's current position, clamped inside
// the viewport/world bounds (reuses the same world-aware bounds getWorldInfo()
// already gives clampToViewport() above). A handful of random polar attempts
// avoids biasing toward any one direction; if every attempt lands out of
// bounds (e.g. a tiny viewport), fall back to a straight clamp.
function pickAppleDropPoint() {
  const margin = 16;
  const world = getWorldInfo();
  const bounds = world ? world.union : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = randRange(FEED_DROP_MIN_PX, FEED_DROP_MAX_PX);
    const x = RUNTIME.pos.x + Math.cos(angle) * dist;
    const y = RUNTIME.pos.y + Math.sin(angle) * dist;
    if (x >= bounds.x + margin && x <= bounds.x + bounds.w - margin &&
        y >= bounds.y + margin && y <= bounds.y + bounds.h - margin) {
      return { x, y };
    }
  }
  const pt = {
    x: RUNTIME.pos.x + randRange(-FEED_DROP_MAX_PX, FEED_DROP_MAX_PX),
    y: RUNTIME.pos.y + randRange(-FEED_DROP_MAX_PX, FEED_DROP_MAX_PX)
  };
  const maxX = Math.max(bounds.x + margin, bounds.x + bounds.w - margin);
  const maxY = Math.max(bounds.y + margin, bounds.y + bounds.h - margin);
  pt.x = Math.min(Math.max(pt.x, bounds.x + margin), maxX);
  pt.y = Math.min(Math.max(pt.y, bounds.y + margin), maxY);
  return pt;
}

// Entry point for both the tray menu (desktop) and the Settings "Feed"
// button (popup/extension) -- see the "vcp1_feed_trigger" storage.onChanged
// listener near the bottom of this file. Guarded the same way other interrupts guard
// themselves: never during an evolution flash, never re-entrant while
// already feeding, never layered on top of an in-progress hover-attack or a
// self-rolled wander attack (avoids two animation states fighting over the
// same sprite).
function triggerFeed() {
  if (!running || !followerEl || !RUNTIME.meta) return;
  if (EVOLVE.active || FEEDING.active || HOVER.active) return;
  if (STATE.mode === "wander" && WANDER.state === "attack") return;
  const wp = pickAppleDropPoint();
  const now = performance.now();
  FEEDING.active = true;
  FEEDING.phase = "walk";
  FEEDING.applePos = wp;
  FEEDING.appleDroppedAt = now;
  // Wall-clock backstop covering the whole walk leg -- if the sprite somehow
  // never arrives (e.g. an extreme edge case in target clamping), this still
  // forces a clean exit instead of leaving FEEDING stuck forever.
  FEEDING.until = now + FEED_WALK_BACKSTOP_MS;
  createAppleElement();
}

// Called once the walk leg arrives at the apple (see tickFeeding()). Picks
// the real Eat-Anim cycle (states.eat, mirroring enterAttack()'s 1-2 cycle
// budget) when the current pack has one, else the CSS-bounce fallback that
// works for every pack regardless of asset coverage.
function startEatPhase(now) {
  FEEDING.phaseStartedAt = now;
  if (hasState("eat")) {
    FEEDING.phase = "eat";
    FEEDING.eatCyclesLeft = 1 + Math.floor(Math.random() * 2); // 1 or 2 full cycles
    const st = RUNTIME.meta.states.eat;
    const cycleMs = (st && st.fps) ? (st.frames / st.fps) * 1000 : 1000;
    FEEDING.until = now + FEEDING.eatCyclesLeft * cycleMs + 1000;
  } else {
    FEEDING.phase = "bounce";
    FEEDING.until = now + FEED_BOUNCE_CYCLES * FEED_BOUNCE_MS + 1000;
  }
}

// Advances the walk/bounce legs of the sequence (the "eat" leg's natural
// completion is instead driven by frame-cycle counting in tick()'s animation
// stepper, exactly mirroring WANDER.attackCyclesLeft -- see there). `completed`
// distinguishes a real finish (awards XP/mood) from the wall-clock backstop
// firing on a stuck sequence (silent cleanup only).
function tickFeeding(now) {
  if (!FEEDING.active) return;
  if (now >= FEEDING.until) { endFeeding(now, false); return; }
  if (FEEDING.phase === "walk") {
    const dx = FEEDING.applePos.x - RUNTIME.pos.x;
    const dy = FEEDING.applePos.y - RUNTIME.pos.y;
    if (Math.hypot(dx, dy) <= FEED_ARRIVE_RADIUS_PX) startEatPhase(now);
  } else if (FEEDING.phase === "bounce") {
    if (now - FEEDING.phaseStartedAt >= FEED_BOUNCE_CYCLES * FEED_BOUNCE_MS) endFeeding(now, true);
  }
}

function endFeeding(now, completed) {
  removeAppleElement();
  FEEDING.active = false;
  FEEDING.phase = null;
  FEEDING.applePos = null;
  if (completed) {
    const dex3 = currentGrowthDex();
    if (dex3) {
      const rec = ensureGrowthRecord(dex3);
      // Wall-clock (Date.now()), not performance.now(): this must survive a
      // restart, unlike every other timestamp in this file.
      const wallNow = Date.now();
      const cooledDown = (wallNow - (rec.lastFedAt || 0)) >= FEED_COOLDOWN_MS;
      rec.hunger = 0; // feeding always satisfies hunger, cooldown or not
      growthDirty = true;
      if (cooledDown) {
        rec.lastFedAt = wallNow; // only the *rewarded* feed resets the cooldown clock
        awardXP(FEED_XP_BONUS);
      }
      flushGrowth(); // persist promptly, mirrors the evolution/level-up flush-now pattern
    }
    triggerMood("Joyous");
  }
}

// Positions the apple element (drop-in fall animation) and returns the
// payload to relay to mirror windows, same shape/spirit as
// renderMoodBubble(). Returns null once no apple is showing.
function renderApple() {
  if (!FEEDING.active || !FEEDING.applePos) {
    if (appleEl) appleEl.style.display = "none";
    return null;
  }
  if (!appleEl) createAppleElement();
  appleEl.style.display = "block";
  const elapsed = performance.now() - FEEDING.appleDroppedAt;
  const fallT = Math.min(1, elapsed / FEED_FALL_MS);
  const eased = 1 - Math.pow(1 - fallT, 3); // ease-out cubic settle
  const dropOffsetPx = (1 - eased) * -40;   // starts 40px above, eases down to 0

  const world = getWorldInfo();
  const originX = world ? world.origin.x : 0;
  const originY = world ? world.origin.y : 0;
  const gx = FEEDING.applePos.x;
  const gy = FEEDING.applePos.y + dropOffsetPx;
  appleEl.style.transform = `translate(${Math.round(gx - originX)}px, ${Math.round(gy - originY)}px) translate(-50%, -50%)`;
  return { x: FEEDING.applePos.x, y: FEEDING.applePos.y, dropOffsetPx };
}

// --- mood bubble: a small floating portrait that pops up above the sprite's
// head for a few seconds after a notable event (evolving, being played with
// via hover-attack, waking up, or being left idle too long). Portraits come
// from the same PMD SpriteCollab source as the sprite sheets (see
// assets/portraits/, populated by a one-off download script -- not every
// Pokémon has every emotion drawn, so coverage is looked up from a generated
// index.json rather than probed live: a live fetch() 404 wouldn't itself log
// to the console, but assigning an unverified 404 URL straight to
// backgroundImage/img.src would (the browser's resource loader logs failed
// image loads regardless of how the URL was obtained) -- the index avoids
// that entirely.
const MOOD_DISPLAY_MS = 2500; // fully-opaque hold time before the fade begins
const MOOD_FADE_MS = 400;     // opacity transition duration, in and out
const MOOD_BUBBLE_PX = 44;    // outer white circle -- fixed size, independent of CONFIG.scale
const MOOD_PORTRAIT_PX = 30;  // inner portrait image size, centered in the bubble
const MOOD_GAP_PX = 6;        // px gap between the sprite's top edge and the bubble's bottom edge

// "Sad" (bored) trigger: no cursor movement at all for this long, at most
// once per cooldown window -- reuses RUNTIME.lastMoveTs, the same idle
// signal pickStateBySpeed()/tickWander() already use for the (much shorter)
// sleep timeout, since "no cursor movement" is the closest available proxy
// for "the user isn't interacting with the page" in both follow and wander
// modes.
const SAD_IDLE_MS = 60 * 60 * 1000;
const SAD_COOLDOWN_MS = 60 * 60 * 1000;

// "Surprised" trigger: a fast cursor passing very close to (or through) the
// sprite -- deliberately the mirror image of the hover-attack gate above
// (HOVER_MAX_SPEED_PXPS requires *slow*, this requires *fast*), so the two
// can never both fire off the same cursor motion. A long cooldown keeps it
// rare, per the "don't overuse it" design note.
const SURPRISE_MARGIN_PX = 60; // extra box margin beyond the sprite itself -- a "near miss" zone, not containment
const SURPRISE_MIN_SPEED_PXPS = 900;
const SURPRISE_COOLDOWN_MS = 15000;

let lastSadShownAt = 0;
let lastSurprisedAt = 0;

const MOOD = { active: false, url: null, startedAt: 0 };
let moodBubbleEl = null;

// Resolve which portrait file (if any) to show for `emotion` under the
// currently-loaded pack, falling back to "Normal" and finally to nothing --
// per spec, a pack with zero portrait coverage must silently skip the
// bubble rather than show a wrong/missing image.
function portraitUrlForEmotion(emotion) {
  const rawPath = typeof RUNTIME.meta?.rawPath === "string" ? RUNTIME.meta.rawPath.trim() : "";
  if (!rawPath) return null;
  const available = PORTRAIT_COVERAGE[rawPath];
  if (!available || !available.length) return null;
  const pick = available.includes(emotion) ? emotion : (available.includes("Normal") ? "Normal" : null);
  if (!pick) return null;
  return extUrl(`assets/portraits/${rawPath}/${pick}.webp`);
}

function ensureMoodBubble() {
  if (moodBubbleEl) return moodBubbleEl;
  moodBubbleEl = document.createElement("div");
  moodBubbleEl.id = "__vcp1_mood_bubble";
  Object.assign(moodBubbleEl.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: `${MOOD_BUBBLE_PX}px`,
    height: `${MOOD_BUBBLE_PX}px`,
    borderRadius: "50%",
    background: "#fff",
    border: "2px solid rgba(0,0,0,0.15)",
    boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
    backgroundSize: `${MOOD_PORTRAIT_PX}px ${MOOD_PORTRAIT_PX}px`,
    imageRendering: "pixelated",
    pointerEvents: "none",
    zIndex: "2147483647",
    display: "none",
    opacity: "0",
    transition: `opacity ${MOOD_FADE_MS}ms ease-out`
  });
  document.documentElement.appendChild(moodBubbleEl);
  return moodBubbleEl;
}

function removeMoodBubble() {
  if (moodBubbleEl?.parentNode) moodBubbleEl.parentNode.removeChild(moodBubbleEl);
  moodBubbleEl = null;
}

// Called from any trigger site (evolution, hover-attack, wake-up, idle-sad,
// surprised) below and from the CDP test hook. Re-triggering while a bubble
// is already fading resets the clock and reverses the transition cleanly --
// no special-case needed, since setting opacity back to "1" mid-transition
// just animates from wherever it currently is.
function triggerMood(emotion) {
  const url = portraitUrlForEmotion(emotion);
  if (!url) return;
  MOOD.active = true;
  MOOD.url = url;
  MOOD.startedAt = performance.now();
}

// Keeps this window's own bubble element positioned/faded, and returns the
// payload to relay to mirror windows (or null once hidden/never shown) --
// called once per applyFrame(). Mirrors receive only the already-computed
// `phase` + global center point, never a timestamp: each Electron renderer's
// performance.now() has its own independent epoch, so a mirror comparing its
// own clock against a timestamp computed in the engine window's clock would
// be comparing unrelated numbers. Instead the mirror just flips its own
// local CSS transition off the same phase signal (see mirror-render.js) --
// visually equivalent since both fades start within one relayed frame
// (~16ms) of each other.
function renderMoodBubble() {
  if (!MOOD.active) {
    if (moodBubbleEl) moodBubbleEl.style.display = "none";
    return null;
  }
  const elapsed = performance.now() - MOOD.startedAt;
  if (elapsed >= MOOD_DISPLAY_MS + MOOD_FADE_MS) {
    MOOD.active = false;
    if (moodBubbleEl) moodBubbleEl.style.display = "none";
    return null;
  }
  const phase = elapsed >= MOOD_DISPLAY_MS ? "fading" : "visible";
  const el = ensureMoodBubble();
  el.style.display = "block";
  el.style.backgroundImage = `url("${MOOD.url}")`;
  el.style.opacity = phase === "fading" ? "0" : "1";

  // Position centered above the sprite's current top edge, in the same
  // global-to-local space applyFrame() itself uses for the follower.
  const st = RUNTIME.meta?.states?.[RUNTIME.anim.name];
  const halfH = st?.frame?.h ? (st.frame.h * CONFIG.scale) / 2 : 20;
  const gx = RUNTIME.pos.x;
  const gy = RUNTIME.pos.y - halfH - MOOD_GAP_PX - MOOD_BUBBLE_PX / 2;
  const world = getWorldInfo();
  const originX = world ? world.origin.x : 0;
  const originY = world ? world.origin.y : 0;
  el.style.transform =
    `translate(${Math.round(gx - originX)}px, ${Math.round(gy - originY)}px) translate(-50%, -50%)`;

  return { url: MOOD.url, phase, gx, gy };
}

// "Surprised": a fast cursor passing through a near-miss zone around the
// sprite (see SURPRISE_* constants above for why this can never collide
// with the hover-attack trigger).
//
// Code review fix: RUNTIME.lastMoveInstantSpeed is a per-mousemove-event
// value that never decays on its own (unlike RUNTIME.speedAvg, which tick()
// exponentially decays toward zero once movement stops -- see the
// VEL_DECAY_* logic above). Without a recency check, a fast cursor that
// stops while still parked inside the near-miss zone leaves
// lastMoveInstantSpeed stuck at its last (high) value forever, so this
// would re-fire Surprised every SURPRISE_COOLDOWN_MS indefinitely even
// though the cursor is no longer moving. Gated the same way updateHover()
// already gates its own speed check, with the same HOVER_RECENCY_MS window:
// a cursor that's genuinely passing through right now is by definition
// recent, so legitimate Surprised triggers are unaffected.
function updateSurprise(now) {
  if (!RUNTIME.meta?.states || HOVER.active || FEEDING.active) return; // don't layer Surprised on top of an in-progress attack or feed
  if (now - lastSurprisedAt < SURPRISE_COOLDOWN_MS) return;
  if (now - RUNTIME.lastMoveTs >= HOVER_RECENCY_MS) return; // stale instant-speed reading -- cursor isn't actually moving right now
  const st = RUNTIME.meta.states[RUNTIME.anim.name] || RUNTIME.meta.states.idle;
  const halfW = (st.frame.w * CONFIG.scale) / 2 + SURPRISE_MARGIN_PX;
  const halfH = (st.frame.h * CONFIG.scale) / 2 + SURPRISE_MARGIN_PX;
  const inside = Math.abs(RUNTIME.lastMouse.x - RUNTIME.pos.x) <= halfW &&
                 Math.abs(RUNTIME.lastMouse.y - RUNTIME.pos.y) <= halfH;
  if (inside && RUNTIME.lastMoveInstantSpeed > SURPRISE_MIN_SPEED_PXPS) {
    lastSurprisedAt = now;
    triggerMood("Surprised");
  }
}

function tick(dtMs) {
  const now = performance.now();

  // Time-based XP: awarded once per full minute this engine is actively
  // ticking (i.e. STATE.enabled) -- tick() only ever runs while that's true.
  xpTimeAccMs += dtMs;
  while (xpTimeAccMs >= 60000) {
    xpTimeAccMs -= 60000;
    awardXP(XP_PER_ACTIVE_MINUTE);
  }

  // Hunger: rises continuously with active engine time (same "engine is
  // ticking" signal as the XP-per-minute source above), reaching HUNGER_MAX
  // after HUNGER_FULL_MS with no feeding. Feeding resets it in endFeeding().
  // Suspended during EVOLVE.active for the same reason awardXP() checks it
  // (see there): currentGrowthDex() would otherwise resurrect the just-
  // deleted pre-evolution dex's GROWTH record during evolveTo()'s async gap.
  if (growthLoaded && !EVOLVE.active) {
    const hungerDex3 = currentGrowthDex();
    if (hungerDex3) {
      const rec = ensureGrowthRecord(hungerDex3);
      const nextHunger = Math.min(HUNGER_MAX, rec.hunger + dtMs * (HUNGER_MAX / HUNGER_FULL_MS));
      if (nextHunger !== rec.hunger) { rec.hunger = nextHunger; growthDirty = true; }
      // "Sad" (hungry): same cooldown-gated MOOD pattern as the idle-based Sad
      // below, just on hunger instead of idle time, with its own cooldown
      // timestamp so the two triggers rate-limit independently.
      if (rec.hunger > HUNGER_SAD_THRESHOLD && now - lastHungrySadShownAt > hungerSadCooldownMs()) {
        lastHungrySadShownAt = now;
        triggerMood("Sad");
      }
    }
  }

  updateHover(now);
  updateSurprise(now);
  tickFeeding(now);

  // "Sad" (bored): the cursor hasn't moved at all in a long while -- rate
  // limited so it can only nag once per cooldown window, not every tick.
  if (now - RUNTIME.lastMoveTs > SAD_IDLE_MS && now - lastSadShownAt > SAD_COOLDOWN_MS) {
    lastSadShownAt = now;
    triggerMood("Sad");
  }

  if (FEEDING.active) {
    // Frozen: neither the wander FSM's own transitions nor follow mode's
    // cursor-retargeting run while a feed is in progress -- see the target
    // override just below, which pins RUNTIME.target for the duration.
  } else if (STATE.mode === "wander") {
    tickWander(now);
  } else {
    // Once mousemove events stop arriving (cursor idle, or the desktop app's
    // 60Hz feed pauses), velAvg would otherwise stay frozen on the last sampled
    // direction forever. Decay it back toward zero so computeTarget's hasDir
    // check naturally drops out (ending the perch-drift) — facing itself no
    // longer reads velAvg (see pickRowForState), so this only affects offset.
    if (now - RUNTIME.lastMoveTs > VEL_DECAY_DELAY_MS) {
      const decay = Math.exp(-dtMs / VEL_DECAY_TAU_MS);
      RUNTIME.velAvg.x *= decay;
      RUNTIME.velAvg.y *= decay;
      RUNTIME.speedAvg = Math.hypot(RUNTIME.velAvg.x, RUNTIME.velAvg.y);
    }

    // follow feel: walk toward the target at a steady pace, like it's actually
    // travelling there on its own — not eased/snapped toward a moving point on a
    // leash. Direction is recomputed every frame, so it turns naturally as the
    // target (cursor) moves, and eases to a stop on arrival instead of overshooting.
    computeTarget();
  }

  // Feeding overrides the travel target regardless of mode, same slot as
  // HOVER's freeze below: walk toward the apple while phase is "walk", stand
  // still once "eat"/"bounce" takes over. Checked first so an in-progress
  // feed always wins (triggerFeed() already refuses to start one while
  // HOVER.active, but this keeps the precedence explicit either way).
  if (FEEDING.active) {
    if (FEEDING.phase === "walk" && FEEDING.applePos) {
      RUNTIME.target.x = FEEDING.applePos.x;
      RUNTIME.target.y = FEEDING.applePos.y;
    } else {
      RUNTIME.target.x = RUNTIME.pos.x;
      RUNTIME.target.y = RUNTIME.pos.y;
    }
  } else if (HOVER.active) {
    // Hover-triggered attack freezes the follower in place, regardless of
    // mode — overriding whatever target the branch above just computed.
    RUNTIME.target.x = RUNTIME.pos.x;
    RUNTIME.target.y = RUNTIME.pos.y;
  }

  const dx = RUNTIME.target.x - RUNTIME.pos.x;
  const dy = RUNTIME.target.y - RUNTIME.pos.y;
  const dist = Math.hypot(dx, dy);

  let desired = STATE.mode === "wander" ? wanderDesiredState() : pickStateBySpeed();
  if (HOVER.active) desired = HOVER.reaction || "hop";
  if (FEEDING.active) {
    if (FEEDING.phase === "walk") desired = "walk";
    else if (FEEDING.phase === "eat") desired = "eat";
    else desired = "idle"; // "bounce" fallback: plain idle sprite, the hop is a CSS offset in applyFrame()
  }
  // Captured before the switch below can change RUNTIME.anim.name -- used
  // after the switch to detect the "sleep" -> anything-else edge (waking
  // up), for the "Normal" mood trigger. Covers follow-mode and wander-mode
  // idle sleep alike, since both play the "sleep" animation state -- there's
  // no need to distinguish them here.
  const wasSleeping = RUNTIME.anim.name === "sleep";
  if (desired !== RUNTIME.anim.name) {
    // Queue the switch; wait for current cycle to finish before committing
    if (!RUNTIME.pendingState || RUNTIME.pendingState.name !== desired) {
      RUNTIME.pendingState = { name: desired, queuedAt: performance.now() };
    }
    const st = RUNTIME.meta.states[RUNTIME.anim.name];
    const atCycleEnd = RUNTIME.anim.frame >= st.frames - 1;
    const timedOut = (performance.now() - RUNTIME.pendingState.queuedAt) > 300;
    if (atCycleEnd || timedOut) {
      // "attack"/"hop"/"rotate" (hover reactions + attack's own wander-mode
      // roll) and "eat" (feeding) are all cycle-counted below via frame
      // wraparound, so each needs a clean start from frame 0.
      const enteringCycleCountedState = ["attack", "eat", "hop", "rotate"].includes(RUNTIME.pendingState.name);
      RUNTIME.anim.name = RUNTIME.pendingState.name;
      RUNTIME.anim.row  = pickRowForState(RUNTIME.anim.name, dx, dy);
      if (enteringCycleCountedState) { RUNTIME.anim.frame = 0; RUNTIME.anim.accMs = 0; }
      RUNTIME.pendingState = null;
    }
  } else {
    RUNTIME.pendingState = null;
  }
  if (wasSleeping && RUNTIME.anim.name !== "sleep") triggerMood("Normal");

  if (dist > ARRIVE_RADIUS_PX) {
    const walkSpeed = walkSpeedFromConfig(); // px/s
    const speed = dist < SLOW_RADIUS_PX ? walkSpeed * (dist / SLOW_RADIUS_PX) : walkSpeed;
    // Clamp the per-frame delta so a long frame gap (e.g. tab was backgrounded)
    // can't teleport the follower — it just keeps walking once frames resume.
    const moveDtMs = Math.min(dtMs, 50);
    const moveDist = Math.min(dist, speed * (moveDtMs / 1000));

    RUNTIME.pos.x += (dx / dist) * moveDist;
    RUNTIME.pos.y += (dy / dist) * moveDist;
    RUNTIME.isWalking = true;
    WANDER.lastDir.x = dx;
    WANDER.lastDir.y = dy;
    // Distance-based XP: actual sprite movement, not raw cursor movement.
    awardXP(moveDist * XP_PER_PIXEL_MOVED);
  } else {
    RUNTIME.isWalking = false;
  }

  const st = RUNTIME.meta.states[RUNTIME.anim.name];
  const msPerFrame = 1000 / st.fps;
  RUNTIME.anim.accMs += dtMs;
  while (RUNTIME.anim.accMs >= msPerFrame) {
    RUNTIME.anim.accMs -= msPerFrame;
    const prevFrame = RUNTIME.anim.frame;
    RUNTIME.anim.frame = (RUNTIME.anim.frame + 1) % st.frames;
    // Count full attack loops by wraparound, then hand control back to idle
    // once the FSM's 1-2 cycle budget is spent (see enterAttack()).
    if (STATE.mode === "wander" && WANDER.state === "attack" && RUNTIME.anim.name === "attack" && RUNTIME.anim.frame < prevFrame) {
      WANDER.attackCyclesLeft -= 1;
      if (WANDER.attackCyclesLeft <= 0) enterPause();
    }
    // Same wraparound counting, generalized to whichever reaction this hover
    // trigger rolled (see pickHoverReaction()) -- not always "attack" anymore.
    if (HOVER.active && RUNTIME.anim.name === HOVER.reaction && RUNTIME.anim.frame < prevFrame) {
      HOVER.cyclesLeft -= 1;
      if (HOVER.cyclesLeft <= 0) endHoverAttack(now);
    }
    // Count full Eat-Anim loops the same way, then hand control back once the
    // 1-2 cycle budget from startEatPhase() is spent (see tickFeeding()).
    if (FEEDING.active && FEEDING.phase === "eat" && RUNTIME.anim.name === "eat" && RUNTIME.anim.frame < prevFrame) {
      FEEDING.eatCyclesLeft -= 1;
      if (FEEDING.eatCyclesLeft <= 0) endFeeding(now, true);
    }
  }

  // Keep the row updated continuously for natural facing
  if (RUNTIME.meta && RUNTIME.meta.states) {
    RUNTIME.anim.row = pickRowForState(RUNTIME.anim.name, dx, dy);
  }
  applyFrame();
}

// Cleanly stop everything once the extension context has been invalidated
// (e.g. the extension was reloaded/updated while this page stayed open).
// No more chrome.* calls will work here, so just remove our DOM/listeners.
function teardownInvalidatedContext() {
  window.removeEventListener("mousemove", onMouseMove);
  window.removeEventListener("resize", onViewportResize);
  window.removeEventListener("vcp1:world-updated", onViewportResize);
  stopLocalPoll();
  removeFollower();
  removeMoodBubble();
  resetFeeding();
  running = false;
}

function loop() {
  let last = performance.now();
  const step = () => {
    if (!isExtensionContextValid()) {
      teardownInvalidatedContext();
      return;
    }
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (followerEl && RUNTIME.meta) tick(dt);
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

const VEL_SMOOTH_TAU_MS = 60;     // velocity smoothing time constant
const TELEPORT_SPEED_PXPS = 8000; // instantaneous speed treated as a jump, not motion

function onMouseMove(e) {
  const now = performance.now();

  // update last mouse and velocity estimate
  const dt = Math.max(1, now - (RUNTIME.lastMouse.t || now)); // ms
  RUNTIME.lastMoveGapMs = dt;
  const vx = (e.clientX - RUNTIME.lastMouse.x) * (1000 / dt); // px/s
  const vy = (e.clientY - RUNTIME.lastMouse.y) * (1000 / dt); // px/s
  // Unsmoothed, so the hover gate below can read "how fast was this one
  // movement" directly — RUNTIME.speedAvg is an EMA blended with whatever it
  // was on the *previous* event, so a fast movement's second tick (first one
  // with a normal small gap) still reads as a diluted blend of the previous
  // (possibly stale-gap-deflated) value and the new true rate, understating
  // it for a tick or two. This has no such carryover.
  RUNTIME.lastMoveInstantSpeed = Math.hypot(vx, vy);

  // Time-based smoothing so direction/speed behave the same at any event
  // rate (browsers fire mousemove at 60–1000Hz; the desktop app feeds ~60Hz).
  // Teleport-sized deltas (tab switches, display hops) are skipped — they
  // would inject a huge spike into the velocity average and whip the facing.
  if (Math.hypot(vx, vy) < TELEPORT_SPEED_PXPS) {
    const SMOOTH = 1 - Math.exp(-dt / VEL_SMOOTH_TAU_MS);
    RUNTIME.velAvg.x = RUNTIME.velAvg.x * (1 - SMOOTH) + vx * SMOOTH;
    RUNTIME.velAvg.y = RUNTIME.velAvg.y * (1 - SMOOTH) + vy * SMOOTH;
    RUNTIME.speedAvg = Math.hypot(RUNTIME.velAvg.x, RUNTIME.velAvg.y);
  }

  RUNTIME.lastMouse.x = e.clientX;
  RUNTIME.lastMouse.y = e.clientY;
  RUNTIME.lastMouse.t = now;
  RUNTIME.lastMoveTs = now;
}

function start() {
  if (running) return;
  running = true;
  createFollower();
  RUNTIME.lastMoveTs = performance.now();
  // initialize position/target around current mouse (in case no movement yet)
  RUNTIME.pos.x = RUNTIME.lastMouse.x;
  RUNTIME.pos.y = RUNTIME.lastMouse.y;
  RUNTIME.target.x = RUNTIME.lastMouse.x;
  RUNTIME.target.y = RUNTIME.lastMouse.y;

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  loop();
}

function stop() {
  if (!running) return;
  running = false;
  window.removeEventListener("mousemove", onMouseMove);
  removeFollower();
  removeMoodBubble();
  resetFeeding();
}

async function loadPack(packKey) {
  const candidates = buildPackCandidates(packKey);
  let chosen = null;
  let meta = null;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      meta = await fetchPackMeta(candidate);
      chosen = candidate;
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!chosen || !meta) {
    throw lastError || new Error(`Unable to load pack for key "${packKey}"`);
  }

  const migrated = chosen !== packKey;
  if (migrated) {
    try { chrome.storage.sync.set({ vcp1_pack: chosen }); } catch (_) {}
  }
  STATE.pack = chosen;
  RUNTIME.meta = meta;
  // reset animation state for the new pack
  resetAnimationForNewPack();
  await ensureImagesLoaded(meta);
  // Restart animation loop if switching packs while active
  if (followerEl) removeFollower();
  if (running) {
    createFollower();
    loop();
  }
}

function applyState() {
  if (STATE.enabled) start(); else stop();
}

// boot
chrome.storage.sync.get(
  ["vcp1_enabled", "vcp1_pack", "vcp1_scale", "vcp1_offset", "vcp1_lerp", "vcp1_mode",
   "vcp1_growth", "vcp1_unlocked", "vcp1_pending_evolution"],
  async (res) => {
    STATE.enabled = !!res.vcp1_enabled;
    STATE.pack    = res.vcp1_pack || DEFAULT_PACK;
    STATE.mode    = res.vcp1_mode === "wander" ? "wander" : "follow";
    applyConfigPatch(res);
    await Promise.all([loadEvolutionData(), loadPortraitCoverage()]);
    hydrateGrowthState(res);
    try {
      await loadPack(STATE.pack);
    } catch (e) {
      console.warn("pack load failed; reverting to default", e);
      STATE.pack = DEFAULT_PACK;
      try { await loadPack(STATE.pack); } catch (e2) { console.warn("default pack also failed", e2); }
    }
    applyState();
  }
);

// react to popup changes
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes.vcp1_enabled) {
    STATE.enabled = !!changes.vcp1_enabled.newValue;
    applyState();
  }
  if (changes.vcp1_pack) {
    const prev = STATE.pack;
    STATE.pack = changes.vcp1_pack.newValue || DEFAULT_PACK;
    try {
      await loadPack(STATE.pack);
      // If follower exists, immediately apply a frame from the new sheet
      if (followerEl) applyFrame();
    } catch (e) {
      console.warn("pack switch failed; restoring previous pack", e);
      STATE.pack = prev;
      try { await loadPack(STATE.pack); } catch (e2) { console.warn("restore previous pack failed", e2); }
      if (followerEl) applyFrame();
    }
  }
  if (changes.vcp1_scale || changes.vcp1_offset || changes.vcp1_lerp) {
    const patch = {
      vcp1_scale:  changes.vcp1_scale  ? Number(changes.vcp1_scale.newValue)  : undefined,
      vcp1_offset: changes.vcp1_offset ? Number(changes.vcp1_offset.newValue) : undefined,
      vcp1_lerp:   changes.vcp1_lerp   ? Number(changes.vcp1_lerp.newValue)   : undefined,
    };
    applyConfigPatch(patch);
    // no restart needed; next frame uses updated CONFIG
  }
  if (changes.vcp1_mode) {
    const nextMode = changes.vcp1_mode.newValue === "wander" ? "wander" : "follow";
    if (nextMode !== STATE.mode) {
      STATE.mode = nextMode;
      // Force the wander FSM to restart fresh next time wander is (re)entered;
      // switching to follow needs no extra work — computeTarget() just takes
      // over from wherever the follower currently stands.
      if (nextMode === "follow") WANDER.state = null;
    }
  }
  // Feed trigger -- same entry point for the desktop tray's "Feed" item and
  // the popup/extension Settings "Feed" button (see main.cjs/popup.js). Uses
  // a storage write (a fresh Date.now() each time, so onChanged always fires)
  // rather than chrome.runtime.sendMessage: in a real unpacked/published
  // Chrome extension with no background page, runtime.sendMessage from a
  // popup is only delivered to other extension pages, NOT to a content
  // script in a tab (that requires tabs.sendMessage(tabId, ...) from a
  // background context, which this extension doesn't have) -- confirmed by
  // hand against a real loaded extension. storage.onChanged, in contrast,
  // already reliably reaches this listener for vcp1_pack/vcp1_mode/etc.
  // above, so feeding reuses that same proven path instead.
  if (changes.vcp1_feed_trigger) {
    triggerFeed();
  }
  // User's branch-evolution pick from Settings (e.g. which Eevee evolution) --
  // same storage-write pattern as vcp1_feed_trigger above (a fresh {to, ts}
  // object each click, so onChanged always fires), replacing a prior
  // chrome.runtime.sendMessage({type:"vcp1_evolve",...}) implementation: in a
  // real unpacked/published Chrome extension with no background page,
  // runtime.sendMessage from a popup never reaches a content script (only
  // tabs.sendMessage from a background context does) -- confirmed by hand
  // against a real loaded extension, the same gap found and fixed for
  // feeding. Not read at boot (see the chrome.storage.sync.get() list above,
  // which deliberately omits this key) -- only a genuine post-registration
  // onChanged fire can trigger an evolution, so a value already sitting in
  // storage from a previous session can never replay on the next boot.
  if (changes.vcp1_evolve_trigger) {
    const pick = changes.vcp1_evolve_trigger.newValue;
    const dex = pick && pick.to;
    if (dex && PENDING_EVOLUTION && PENDING_EVOLUTION.choices.some((c) => c.dex === dex)) {
      evolveTo(PENDING_EVOLUTION.dex, dex);
    }
  }
});

// listen for live slider updates and drag state from popup.js
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  if (msg.type === "vcp1_config" && msg.patch) {
    applyConfigPatch(msg.patch);
    if (followerEl && RUNTIME.meta) applyFrame();
    return;
  }

  if (msg.type === "vcp1_drag") {
    const on = !!msg.dragging;
    if (on && !LIVE.dragging) {
      LIVE.dragging = true;
      startLocalPoll();
    } else if (!on && LIVE.dragging) {
      LIVE.dragging = false;
      stopLocalPoll();
    }
  }
});

window.addEventListener("beforeunload", () => { stopLocalPoll(); stop(); growthDirty = true; flushGrowth(); });
