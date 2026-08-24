/**
 * Party Display viewport scale for PC + Fully Kiosk TV.
 *
 * Fully start URL:
 *   http://10.10.1.30:8088/#/display?kiosk=1
 *   http://10.10.1.30:8088/#/karaoke?kiosk=1
 *
 * Host TV preview (Booth Look):
 *   #/display?preview=1  — letterboxed 16:9 stage on this device
 *   #/karaoke?preview=1  — Karaoke Display preview
 *
 * Fully settings for PC parity:
 *   - Web Content → Enable JavaScript interface (for window.fully)
 *   - Fullscreen / Immersive mode on; hide system UI
 *   - Page zoom 100%
 *   - Desktop mode OFF (or leave consistent after first good load)
 *   - Disable auto-zoom on input / force desktop width overrides
 *
 * Idle (screensaver / dim after quiet playback) also needs the JS interface;
 * see party-display-idle.js.
 */

const PD_VW = "--pd-vw";
const PD_VH = "--pd-vh";
const KIOSK_CLASS = "party-display-kiosk";
const PREVIEW_CLASS = "party-display-preview";
const REMEASURE_MS = [0, 100, 350, 1000];

let listening = false;
let onResize = null;
let remeasureTimers = [];

function parseHashQuery() {
  const raw = String(location.hash || "").replace(/^#\/?/, "");
  const cut = raw.search(/[?&]/);
  if (cut < 0) return new URLSearchParams();
  const q = raw.slice(cut + 1).replace(/^[?&]/, "");
  return new URLSearchParams(q);
}

function truthyParam(value) {
  return value === "1" || value === "true";
}

function hashOrSearchHasFlag(names) {
  const hashQ = parseHashQuery();
  for (const name of names) {
    if (truthyParam(hashQ.get(name))) return true;
  }
  try {
    const sp = new URLSearchParams(location.search || "");
    for (const name of names) {
      if (truthyParam(sp.get(name))) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** View name from a hash string, stripping `?kiosk=1` style query. */
export function viewNameFromHash(hash) {
  let h = String(hash || "").replace(/^#\/?/, "");
  const cut = h.search(/[?&]/);
  if (cut >= 0) h = h.slice(0, cut);
  return h;
}

/** View name from location.hash, stripping `?kiosk=1` style query. */
export function partyDisplayHashView() {
  return viewNameFromHash(location.hash);
}

export function isPartyDisplayKiosk() {
  try {
    if (globalThis.fully && typeof globalThis.fully === "object") return true;
  } catch {
    /* ignore */
  }
  if (/Fully/i.test(navigator.userAgent || "")) return true;
  return hashOrSearchHasFlag(["kiosk"]);
}

/** Host Booth “Preview as TV” — not a real Fully kiosk session. */
export function isPartyDisplayPreview() {
  return hashOrSearchHasFlag(["preview", "tv"]);
}

/**
 * Largest 16:9 stage that fits inside a CSS-px box.
 * @param {number} boxW
 * @param {number} boxH
 * @returns {{ w: number, h: number }}
 */
export function fit16x9Stage(boxW, boxH) {
  const w = Number(boxW) || 0;
  const h = Number(boxH) || 0;
  if (!(w > 0 && h > 0)) return { w: 1920, h: 1080 };
  if (w / h >= 16 / 9) {
    const stageH = h;
    return { w: stageH * (16 / 9), h: stageH };
  }
  const stageW = w;
  return { w: stageW, h: stageW * (9 / 16) };
}

/** Party Display and Karaoke Display share --pd / kiosk / preview plumbing. */
export function isTvStageView(name) {
  return name === "display" || name === "karaoke";
}

/**
 * Fully Kiosk start URL from a Join / public base URL.
 * @param {string} [baseUrl]
 * @param {"display"|"karaoke"} [view]
 */
export function tvFullyStartUrl(baseUrl, view = "display") {
  const name = view === "karaoke" ? "karaoke" : "display";
  const raw = String(baseUrl || "").trim();
  let origin = "";
  try {
    if (raw) origin = new URL(raw).origin;
  } catch {
    /* ignore */
  }
  if (!origin && typeof location !== "undefined" && location?.origin) {
    origin = location.origin;
  }
  if (!origin) return `#/${name}?kiosk=1`;
  return `${origin.replace(/\/$/, "")}/#/${name}?kiosk=1`;
}

/**
 * Fully Kiosk start URL from a Join / public base URL.
 * @param {string} [baseUrl]
 */
export function partyDisplayFullyStartUrl(baseUrl) {
  return tvFullyStartUrl(baseUrl, "display");
}

/**
 * Fully Kiosk start URL for Karaoke Display.
 * @param {string} [baseUrl]
 */
export function karaokeDisplayFullyStartUrl(baseUrl) {
  return tvFullyStartUrl(baseUrl, "karaoke");
}

function measureFromFullyCssPx() {
  try {
    const f = globalThis.fully;
    if (!f || typeof f !== "object") return null;
    const rawW = Number(
      typeof f.getDisplayWidth === "function"
        ? f.getDisplayWidth()
        : typeof f.getScreenWidth === "function"
          ? f.getScreenWidth()
          : NaN
    );
    const rawH = Number(
      typeof f.getDisplayHeight === "function"
        ? f.getDisplayHeight()
        : typeof f.getScreenHeight === "function"
          ? f.getScreenHeight()
          : NaN
    );
    if (!(rawW > 0 && rawH > 0)) return null;
    // Fully often reports device pixels; CSS layout uses CSS pixels.
    const dpr = Number(window.devicePixelRatio) || 1;
    const scale = dpr > 0 ? dpr : 1;
    return { w: rawW / scale, h: rawH / scale };
  } catch {
    return null;
  }
}

function measureFromVisualViewport() {
  const vv = window.visualViewport;
  if (vv && vv.width > 0 && vv.height > 0) {
    return { w: vv.width, h: vv.height };
  }
  const w = Number(window.innerWidth) || 0;
  const h = Number(window.innerHeight) || 0;
  if (w > 0 && h > 0) return { w, h };
  return null;
}

/** Visible CSS-px box for --pd (smaller of visualViewport and Fully when both). */
export function measurePartyDisplayViewport() {
  const css = measureFromVisualViewport();
  const fully = measureFromFullyCssPx();
  if (css && fully) {
    return { w: Math.min(css.w, fully.w), h: Math.min(css.h, fully.h) };
  }
  return css || fully || { w: 1920, h: 1080 };
}

export function applyPartyDisplayViewport() {
  const preview = isPartyDisplayPreview();
  const live = measurePartyDisplayViewport();
  const stage = preview ? fit16x9Stage(live.w, live.h) : live;
  const body = document.body;
  body.style.setProperty(PD_VW, `${Math.round(stage.w * 100) / 100}px`);
  body.style.setProperty(PD_VH, `${Math.round(stage.h * 100) / 100}px`);
  body.classList.toggle(KIOSK_CLASS, isPartyDisplayKiosk());
  body.classList.toggle(PREVIEW_CLASS, preview);
}

function clearPartyDisplayViewport() {
  const body = document.body;
  body.style.removeProperty(PD_VW);
  body.style.removeProperty(PD_VH);
  body.classList.remove(KIOSK_CLASS);
  body.classList.remove(PREVIEW_CLASS);
}

function clearRemeasureTimers() {
  for (const id of remeasureTimers) clearTimeout(id);
  remeasureTimers = [];
}

/** Fully fullscreen / system UI often changes the box after first paint. */
function scheduleKioskRemeasure() {
  clearRemeasureTimers();
  if (!isPartyDisplayKiosk() && !isPartyDisplayPreview()) return;
  for (const ms of REMEASURE_MS) {
    remeasureTimers.push(setTimeout(() => applyPartyDisplayViewport(), ms));
  }
}

function bindListeners() {
  if (listening) return;
  listening = true;
  onResize = () => applyPartyDisplayViewport();
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("scroll", onResize);
  document.addEventListener("visibilitychange", onResize);
}

function unbindListeners() {
  if (!listening) return;
  listening = false;
  if (onResize) {
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("scroll", onResize);
    document.removeEventListener("visibilitychange", onResize);
  }
  onResize = null;
}

/** Call when Party Display is shown or hidden. */
export function syncPartyDisplayViewport(active) {
  if (active) {
    applyPartyDisplayViewport();
    bindListeners();
    scheduleKioskRemeasure();
  } else {
    clearRemeasureTimers();
    unbindListeners();
    clearPartyDisplayViewport();
  }
}
