// Minimal chrome.* shim so the unmodified extension code (content.js, popup.js)
// runs inside Electron windows. Storage and messaging are backed by the main
// process over IPC; asset URLs resolve to the poke:// app protocol.
const { ipcRenderer } = require("electron");

const changedListeners = [];
const messageListeners = [];

function makeStorageArea(area) {
  return {
    get(keys, cb) {
      ipcRenderer.invoke("vcp1:storage-get", area, keys ?? null)
        .then((res) => { if (typeof cb === "function") cb(res || {}); });
    },
    set(patch, cb) {
      ipcRenderer.invoke("vcp1:storage-set", area, patch || {})
        .then(() => { if (typeof cb === "function") cb(); });
    }
  };
}

window.chrome = {
  runtime: {
    id: "pokefollower-desktop",
    getURL: (rel) => `poke://app/src/${String(rel).replace(/^\/+/, "")}`,
    sendMessage: (msg) => { ipcRenderer.send("vcp1:message", msg); },
    onMessage: {
      addListener: (fn) => { messageListeners.push(fn); }
    }
  },
  storage: {
    sync: makeStorageArea("sync"),
    local: makeStorageArea("local"),
    onChanged: {
      addListener: (fn) => { changedListeners.push(fn); }
    }
  }
};

ipcRenderer.on("vcp1:storage-changed", (_e, area, changes) => {
  for (const fn of changedListeners) {
    try { fn(changes, area); } catch (err) { console.warn("onChanged listener failed", err); }
  }
});

ipcRenderer.on("vcp1:message", (_e, msg) => {
  for (const fn of messageListeners) {
    try { fn(msg); } catch (err) { console.warn("onMessage listener failed", err); }
  }
});

// Multi-display world: main.cjs computes every display's global rect, the
// union of all of them, and this window's own local-origin offset, then
// pushes it here whenever the layout changes (startup, hotplug). content.js
// reads window.__VCP1_WORLD__ (see getWorldInfo()) and falls back to
// window.innerWidth/Height when it's absent — this only matters for the
// desktop app's engine window; the popup/settings window ignores it.
ipcRenderer.invoke("vcp1:world-get").then((world) => {
  window.__VCP1_WORLD__ = world;
  window.dispatchEvent(new Event("vcp1:world-updated"));
});
ipcRenderer.on("vcp1:world", (_e, world) => {
  window.__VCP1_WORLD__ = world;
  window.dispatchEvent(new Event("vcp1:world-updated"));
});

// Engine-only hook: content.js's applyFrame() calls this every frame with a
// snapshot of what it just painted (global position + sprite sheet/frame), so
// main.cjs can relay it to mirror windows on other displays. Harmless/unused
// in the settings window, which never runs content.js.
window.__VCP1_SNAPSHOT_SINK__ = (snap) => { ipcRenderer.send("vcp1:snapshot", snap); };

// Overlay only: turn main-process cursor samples into the mousemove events
// content.js already listens for. Dispatch only when the cursor actually
// moved — a browser fires no mousemove while idle, and content.js relies on
// that for its sleep state and last-facing behavior.
let lastCursor = null;
ipcRenderer.on("vcp1:cursor", (_e, { x, y }) => {
  if (lastCursor && lastCursor.x === x && lastCursor.y === y) return;
  lastCursor = { x, y };
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
});

// On macOS, a click-through (setIgnoreMouseEvents) BrowserWindow can still
// receive genuine native "mousemove" events whenever the real system cursor
// passes over it, even though clicks/hover otherwise fall through to
// whatever's beneath. The overlay's actual cursor signal always arrives via
// the synthetic (untrusted) redispatch above, so a trusted mousemove here
// would be a second, uncoordinated position source — drop it before
// content.js's own listener (registered later, once the page script loads)
// ever sees it.
window.addEventListener("mousemove", (e) => {
  if (e.isTrusted) e.stopImmediatePropagation();
}, true);

// --smoke: report once each window's UI is actually up — the overlay when the
// follower element is animating a sprite sheet, the settings popup when the
// pack list has been populated from index.json.
if (new URLSearchParams(window.location.search).has("smoke")) {
  const isPopup = window.location.pathname.includes("popup");
  const timer = setInterval(() => {
    if (isPopup) {
      const pack = document.getElementById("pack");
      if (pack && pack.options.length > 2) {
        clearInterval(timer);
        ipcRenderer.send("vcp1:smoke-ok", "settings");
        smokeLangProbe();
      }
    } else {
      const el = document.getElementById("__vcp1_follower");
      if (el && el.style.backgroundImage.includes("poke://")) {
        clearInterval(timer);
        ipcRenderer.send("vcp1:smoke-ok", "overlay");
        smokeFacingProbe();
      }
    }
  }, 200);
}

// Switch the settings popup to Korean through the real user path — a click on
// the "한글" language button — then confirm the pack list actually relabels to
// Hangul. Poll up to 3s because relabeling waits on the Korean names fetch.
function smokeLangProbe() {
  const HANGUL = /[가-힣]/;
  const pack = document.getElementById("pack");
  const koBtn = document.querySelector('#lang .langOpt[data-lang="ko"]');
  if (!pack || !koBtn) {
    ipcRenderer.send("vcp1:smoke-lang", "fail:no-control");
    return;
  }
  koBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const deadline = Date.now() + 3000;
  const poll = setInterval(() => {
    const labels = Array.from(pack.options).map((o) => o.textContent || "");
    if (labels.some((t) => HANGUL.test(t))) {
      clearInterval(poll);
      ipcRenderer.send("vcp1:smoke-lang", "ok");
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      ipcRenderer.send("vcp1:smoke-lang", `fail:${labels[0] || ""}`);
    }
  }, 100);
}

// Sample background-position-y a few times (~50ms apart) and require them to
// all agree with `expected` before accepting — a single-instant style read
// can catch a torn/mid-render frame, so this confirms the row is genuinely
// settled rather than a one-frame blip, without loosening what's required.
function sampleRowSettled(expected, cb) {
  const SAMPLE_COUNT = 4;
  const samples = [];
  const poll = setInterval(() => {
    const el = document.getElementById("__vcp1_follower");
    samples.push(el ? (el.style.backgroundPosition.split(" ")[1] || "") : "");
    if (samples.length >= SAMPLE_COUNT) {
      clearInterval(poll);
      cb(samples.every((s) => s === expected), samples);
    }
  }, 50);
}

// Drive a steady upward cursor motion and check the sprite actually uses the
// "back" row (default pack: row 4, 40px frames → background-position-y -160px),
// then stop feeding and confirm it settles back to "front" (row 0 → "0px")
// once velAvg decays and the follower arrives at its perch. Only one final
// result is sent — main.cjs gates on a single "facing" outcome.
function smokeFacingProbe() {
  // Prime: the follower starts wherever it booted (e.g. 0,0, well off-screen
  // from our test point), and facing while walking now tracks the actual
  // pos→target travel vector. Measuring immediately would catch it mid
  // catch-up toward (600,800) — a real but unrelated direction — so park the
  // cursor there first and let it arrive before starting the timed up-feed.
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600, clientY: 800 }));
  setTimeout(() => {
    let y = 800;
    const feed = setInterval(() => {
      y -= 8;
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 600, clientY: y }));
    }, 16);
    setTimeout(() => {
      clearInterval(feed);
      sampleRowSettled("-160px", (ok, samples) => {
        if (!ok) {
          const el = document.getElementById("__vcp1_follower");
          const diag = el ? { bg: el.style.backgroundPosition, img: el.style.backgroundImage, w: el.style.width, h: el.style.height } : "no-el";
          ipcRenderer.send("vcp1:smoke-facing", `fail:back:${samples.join(",")}:${JSON.stringify(diag)}`);
          return;
        }
        // Feed stopped; wait for velAvg decay + arrival at the idle perch,
        // then confirm the sprite faces front again instead of staying
        // frozen on back.
        setTimeout(() => {
          sampleRowSettled("0px", (ok2, samples2) => {
            if (!ok2) {
              const el2 = document.getElementById("__vcp1_follower");
              const diag2 = el2 ? { bg: el2.style.backgroundPosition, img: el2.style.backgroundImage, w: el2.style.width, h: el2.style.height } : "no-el";
              ipcRenderer.send("vcp1:smoke-facing", `fail:front:${samples2.join(",")}:${JSON.stringify(diag2)}`);
              return;
            }
            ipcRenderer.send("vcp1:smoke-facing", "ok");
            smokeWanderProbe();
          });
        }, 2500);
      });
    }, 900);
  }, 4500);
}

// Switch to wander mode the same way the popup's mode toggle would (a
// storage write — there's no mode-toggle UI in the overlay window itself),
// then feed NO cursor input at all and confirm the follower (a) moves on its
// own and (b) never strays outside the viewport. The wander FSM always starts
// in "roam" (see content.js's WANDER.state lazy-init), so movement begins
// immediately — poll with early-exit instead of a fixed sample-then-evaluate
// window so a stray PAUSE right after an unlucky near-instant waypoint arrival
// can't make an otherwise-passing run look stalled.
function smokeWanderProbe() {
  window.chrome.storage.sync.set({ vcp1_mode: "wander" }, () => {
    setTimeout(() => {
      const start = Date.now();
      const deadline = start + 10000; // covers a worst-case 8s PAUSE backstop
      const MOVE_THRESHOLD_PX = 15;
      let last = readFollowerPos();
      let moved = 0;
      const poll = setInterval(() => {
        // readFollowerPos() returns this window's LOCAL transform coords
        // (applyFrame() subtracts this engine window's own origin — see
        // content.js). In the multi-display app the follower is meant to
        // wander across every display, so it will legitimately go outside
        // this one window's own local viewport; convert back to global via
        // the world's origin and bound-check against the union of every
        // display instead of window.innerWidth/Height. No world provider
        // (or single-display) means union collapses to this viewport, same
        // as the original single-window check.
        const world = window.__VCP1_WORLD__;
        const origin = world?.origin || { x: 0, y: 0 };
        const bounds = world?.union || { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
        const p = readFollowerPos();
        if (p) {
          const gx = p.x + origin.x, gy = p.y + origin.y;
          if (gx < bounds.x - 1 || gx > bounds.x + bounds.w + 1 || gy < bounds.y - 1 || gy > bounds.y + bounds.h + 1) {
            clearInterval(poll);
            ipcRenderer.send("vcp1:smoke-wander", `fail:oob:${JSON.stringify({ gx, gy, bounds })}`);
            return;
          }
          if (last) moved += Math.hypot(p.x - last.x, p.y - last.y);
          last = p;
          if (moved >= MOVE_THRESHOLD_PX) {
            clearInterval(poll);
            ipcRenderer.send("vcp1:smoke-wander", "ok");
            smokeSleepProbe();
            return;
          }
        }
        if (Date.now() >= deadline) {
          clearInterval(poll);
          ipcRenderer.send("vcp1:smoke-wander", `fail:no-movement:${moved.toFixed(2)}`);
        }
      }, 100);
    }, 250);
  });
}

function readFollowerPos() {
  const el = document.getElementById("__vcp1_follower");
  const m = el && /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || "");
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
}

// The follower's on-screen box in this window's LOCAL coords. applyFrame()
// paints `translate(x,y) translate(-50%,-50%) scale(s)` with width/height set
// to the unscaled frame size, so the translate pair is the sprite's centre and
// the visible half-extents are (size * scale) / 2 — the same box updateHover()
// tests the cursor against in content.js.
function readFollowerBox() {
  const el = document.getElementById("__vcp1_follower");
  if (!el) return null;
  const t = el.style.transform || "";
  const pos = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(t);
  if (!pos) return null;
  const sc = /scale\(\s*([\d.]+)\s*\)/.exec(t);
  const scale = sc ? parseFloat(sc[1]) : 1;
  return {
    cx: parseFloat(pos[1]),
    cy: parseFloat(pos[2]),
    halfW: ((parseFloat(el.style.width) || 0) * scale) / 2,
    halfH: ((parseFloat(el.style.height) || 0) * scale) / 2
  };
}

function readSheetName() {
  const el = document.getElementById("__vcp1_follower");
  const m = el && /([A-Za-z]+)-Anim\.webp/.exec(el.style.backgroundImage || "");
  return m ? m[1] : "";
}

function globalOrigin() {
  return (window.__VCP1_WORLD__ && window.__VCP1_WORLD__.origin) || { x: 0, y: 0 };
}

// --- idle-sleep probe: falling asleep must mean the *user* stopped moving the
// mouse, and nothing else. Runs in wander mode (smokeWanderProbe leaves it
// there) and dials wander's idle-sleep threshold down through the test hook,
// since waiting out the real 30s isn't a smoke test. Asserts all three legs of
// the contract: it stays awake while the cursor is being fed for well past
// that threshold, it does fall asleep once the feed stops, and a single move
// wakes it. The first leg is the regression guard for the removed random-nap
// roll, which used to be able to put it to sleep with no idle time at all.
const SLEEP_PROBE_IDLE_MS = 800;
// How long leg 1 keeps the cursor moving. Sized to outlast a whole
// roam -> pause -> post-pause-decision cycle, not just the dialed-down idle
// threshold: a spontaneous sleep could only ever be rolled at the end of a
// PAUSE, and reaching one costs a full roam traversal first (up to ~7s at the
// default ~267px/s across a large display) plus the 2-8s pause itself. A
// window merely longer than SLEEP_PROBE_IDLE_MS would usually expire mid-roam
// and pass without ever exercising the decision this leg exists to police.
// Backstop only — leg 1 normally ends on evidence (see SLEEP_PROBE_PAUSES).
const SLEEP_PROBE_ACTIVE_MS = 25000;
// How many completed pauses leg 1 waits for before it is satisfied. A
// spontaneous sleep could only ever be rolled by choosePostPause(), which runs
// at the end of a PAUSE, so watching the sprite go still at a waypoint and
// then set off again twice proves that decision really executed. Deliberately
// event-driven rather than a wall-clock window: pickRoamWaypoint() samples
// across every connected display, so one roam traversal is as long as the
// widest whole desktop, not the widest screen — any fixed duration tuned on a
// single monitor would silently expire mid-roam on a multi-monitor machine and
// pass without testing anything.
const SLEEP_PROBE_PAUSES = 2;

function smokeSleepProbe() {
  const hooks = window.__VCP1_TEST_HOOKS__;
  if (!hooks || typeof hooks.setWanderSleepTimeoutMs !== "function") {
    ipcRenderer.send("vcp1:smoke-sleep", "fail:no-test-hook");
    return;
  }
  // The shipped thresholds themselves: the legs below have to dial wander's
  // down to run at all, so assert the real values first or they go untested.
  // Both modes are meant to agree on "30s of no mouse movement".
  const REQUIRED_SLEEP_MS = 30000;
  const prod = hooks.productionSleepTimeouts ? hooks.productionSleepTimeouts() : null;
  if (!prod || prod.follow !== REQUIRED_SLEEP_MS || prod.wander !== REQUIRED_SLEEP_MS) {
    ipcRenderer.send("vcp1:smoke-sleep", `fail:threshold:${JSON.stringify(prod)}`);
    return;
  }
  const restore = () => hooks.setWanderSleepTimeoutMs(0); // 0 -> back to the production threshold
  // Leg 1's watcher can report a failure while leg 2's timer is still pending,
  // so every exit goes through this once-only gate.
  let finished = false;
  const done = (result) => {
    if (finished) return;
    finished = true;
    restore();
    ipcRenderer.send("vcp1:smoke-sleep", result);
    if (result === "ok") smokeHoverProbe();
  };
  hooks.setWanderSleepTimeoutMs(SLEEP_PROBE_IDLE_MS);

  // Leg 1 — cursor active. The sprite roams wherever it likes, so this feed
  // may well drift over it and set off a hover reaction; that plays hop or
  // rotate, never sleep, so it can't turn this leg into a false pass.
  let x = 40;
  const feed = setInterval(() => {
    x = x === 40 ? 46 : 40;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: 40 }));
  }, 60);
  const watchAwake = setInterval(() => {
    if (readSheetName() === "Sleep") {
      clearInterval(feed);
      clearInterval(watchAwake);
      done("fail:slept-while-cursor-active");
    }
  }, 50);

  // End leg 1 once the sprite has completed SLEEP_PROBE_PAUSES pauses — gone
  // still at a waypoint, then set off again. A regression that naps instead of
  // roaming on would stay still rather than setting off, so it never advances
  // this count; watchAwake above is what catches that, and the wall-clock
  // backstop keeps a genuinely stalled FSM from hanging the probe.
  let pausesSeen = 0;
  let wasStill = false;
  let lastBox = readFollowerBox();
  const legOneStart = Date.now();
  const watchRoam = setInterval(() => {
    const cur = readFollowerBox();
    const still = !!(lastBox && cur &&
      Math.abs(cur.cx - lastBox.cx) < 0.6 && Math.abs(cur.cy - lastBox.cy) < 0.6);
    lastBox = cur;
    if (wasStill && !still) pausesSeen++;
    wasStill = still;
    if (pausesSeen < SLEEP_PROBE_PAUSES && Date.now() - legOneStart < SLEEP_PROBE_ACTIVE_MS) return;
    clearInterval(watchRoam);
    clearInterval(feed);
    clearInterval(watchAwake);
    if (finished) return;
    // Leg 2 — cursor idle. Generous deadline: an in-progress attack cycle
    // blocks the sleep transition until it finishes (by design), and the
    // animation switch itself waits out the current sheet cycle.
    const sleepDeadline = Date.now() + SLEEP_PROBE_IDLE_MS + 4000;
    const waitSleep = setInterval(() => {
      if (readSheetName() === "Sleep") {
        clearInterval(waitSleep);
        // Leg 3 — one move must wake it. Restore the production threshold
        // first, so it can't simply doze off again mid-measurement.
        restore();
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
        const wakeDeadline = Date.now() + 2500;
        const waitWake = setInterval(() => {
          if (readSheetName() !== "Sleep") {
            clearInterval(waitWake);
            done("ok");
          } else if (Date.now() > wakeDeadline) {
            clearInterval(waitWake);
            done("fail:no-wake");
          }
        }, 50);
      } else if (Date.now() > sleepDeadline) {
        clearInterval(waitSleep);
        done(`fail:no-sleep:${readSheetName() || "none"}`);
      }
    }, 50);
  }, 120);
}

// --- hover-reaction probe: placing the cursor on the sprite must produce a
// pleased reaction (hop or rotate) and never the attack motion. Reads the
// reaction the engine actually picked via the test hook rather than guessing
// from the painted sheet — wander's own spontaneous attack roll paints
// "attack" too, and a sheet read alone couldn't tell the two apart. Also
// covers the failure mode that dropping "attack" from the pool could have
// introduced: a pool matching none of the pack's states, leaving hover
// silently doing nothing at all.
const HOVER_PROBE_REACTIONS = 3;

function smokeHoverProbe() {
  const hooks = window.__VCP1_TEST_HOOKS__;
  if (!hooks || typeof hooks.takeLastHoverReaction !== "function") {
    ipcRenderer.send("vcp1:smoke-hover", "fail:no-test-hook");
    return;
  }
  hooks.takeLastHoverReaction(); // drop anything an earlier probe's feed set off
  const seen = [];
  const deadline = Date.now() + 60000;

  // Wait for the sprite to stand still (wander pauses 2-8s after every
  // waypoint) before aiming at it — a roaming target can walk out from under
  // the cursor between reading its box and dispatching the entry move.
  function whenStill(cb) {
    let last = readFollowerBox();
    const stillDeadline = Date.now() + 12000;
    const poll = setInterval(() => {
      const cur = readFollowerBox();
      if (last && cur && Math.abs(cur.cx - last.cx) < 0.6 && Math.abs(cur.cy - last.cy) < 0.6) {
        clearInterval(poll);
        cb(cur);
        return;
      }
      last = cur;
      if (Date.now() > stillDeadline) { clearInterval(poll); cb(null); }
    }, 120);
  }

  function attempt() {
    if (seen.length >= HOVER_PROBE_REACTIONS) {
      ipcRenderer.send("vcp1:smoke-hover", "ok");
      return;
    }
    if (Date.now() > deadline) {
      ipcRenderer.send("vcp1:smoke-hover", `fail:only-${seen.length}-reactions:${seen.join(",") || "none"}`);
      return;
    }
    whenStill((box) => {
      if (!box) { attempt(); return; }
      const origin = globalOrigin();
      const gy = box.cy + origin.y;
      const outside = box.cx + origin.x + box.halfW + 3;
      // Cross the edge in one slow 6px step 100ms later: content.js only
      // accepts an entry made slowly and just-moved (HOVER_MAX_SPEED_PXPS /
      // HOVER_WARM_GAP_MS / HOVER_RECENCY_MS), which is what a deliberate
      // hover looks like and a fast pass-through does not. 6px/100ms = 60px/s.
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: outside, clientY: gy }));
      setTimeout(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: outside - 6, clientY: gy }));
        const readDeadline = Date.now() + 800;
        const poll = setInterval(() => {
          const reaction = hooks.takeLastHoverReaction();
          if (reaction) {
            clearInterval(poll);
            if (reaction !== "hop" && reaction !== "rotate") {
              ipcRenderer.send("vcp1:smoke-hover", `fail:reaction:${reaction}`);
              return;
            }
            seen.push(reaction);
            // Leave the box and wait out the ~2s cooldown — content.js needs
            // an exit and a re-entry on top of it before it will fire again.
            window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
            setTimeout(attempt, 2600);
          } else if (Date.now() > readDeadline) {
            clearInterval(poll);
            window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5, clientY: 5 }));
            setTimeout(attempt, 300);
          }
        }, 25);
      }, 100);
    });
  }
  attempt();
}
