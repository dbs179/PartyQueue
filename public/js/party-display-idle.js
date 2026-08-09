/**
 * Low-power idle for Party Display on Fully Kiosk TV.
 *
 * When the display view is in kiosk mode and playback has been quiet long
 * enough, dim / start Fully's screensaver. Wake when music plays again or
 * someone taps the screen.
 *
 * Fully: Advanced Web Settings → Enable JavaScript Interface.
 */

export const PARTY_DISPLAY_IDLE_AFTER_MS = 5 * 60_000;
const IDLE_BRIGHTNESS = 1;
const IDLE_CLASS = "party-display-idle";

/**
 * Pure decision helper for tests.
 * @param {{
 *   displayActive?: boolean,
 *   kiosk?: boolean,
 *   isPlaying?: boolean,
 *   hasTrack?: boolean,
 *   quietSince?: number|null,
 *   now?: number,
 *   idleAfterMs?: number,
 * }} opts
 */
export function partyDisplayShouldBeIdle({
  displayActive = false,
  kiosk = false,
  isPlaying = false,
  hasTrack = false,
  quietSince = null,
  now = Date.now(),
  idleAfterMs = PARTY_DISPLAY_IDLE_AFTER_MS,
} = {}) {
  if (!displayActive || !kiosk) return false;
  if (isPlaying && hasTrack) return false;
  const since = Number(quietSince) || 0;
  if (!since) return false;
  return now - since >= Math.max(0, Number(idleAfterMs) || 0);
}

function getFullyBridge(getFully) {
  try {
    const f = typeof getFully === "function" ? getFully() : null;
    return f && typeof f === "object" ? f : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   idleAfterMs?: number,
 *   getFully?: () => object|null|undefined,
 *   documentRef?: Document,
 *   now?: () => number,
 * }} [opts]
 */
export function createPartyDisplayIdle(opts = {}) {
  const idleAfterMs = opts.idleAfterMs ?? PARTY_DISPLAY_IDLE_AFTER_MS;
  const getFully = opts.getFully || (() => globalThis.fully);
  const doc = opts.documentRef || (typeof document !== "undefined" ? document : null);
  const nowFn = opts.now || Date.now;

  let displayActive = false;
  let kiosk = false;
  let isPlaying = false;
  let hasTrack = false;
  /** @type {number|null} */
  let quietSince = null;
  let idle = false;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {number|null} */
  let savedBrightness = null;
  let listenersBound = false;

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function paintIdleClass(on) {
    if (!doc?.body) return;
    doc.body.classList.toggle(IDLE_CLASS, !!on);
  }

  function enterHardwareIdle() {
    const fully = getFullyBridge(getFully);
    if (!fully) return;
    try {
      if (typeof fully.getScreenBrightness === "function") {
        const level = Number(fully.getScreenBrightness());
        if (Number.isFinite(level) && level > IDLE_BRIGHTNESS) {
          savedBrightness = level;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof fully.startScreensaver === "function") {
        fully.startScreensaver();
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      if (typeof fully.setScreenBrightness === "function") {
        fully.setScreenBrightness(IDLE_BRIGHTNESS);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      if (typeof fully.turnScreenOff === "function") {
        // keepAlive=true so Fully (and this page) stay running while blanked.
        fully.turnScreenOff(true);
      }
    } catch {
      /* ignore */
    }
  }

  function exitHardwareIdle() {
    const fully = getFullyBridge(getFully);
    if (!fully) return;
    try {
      if (typeof fully.stopScreensaver === "function") fully.stopScreensaver();
    } catch {
      /* ignore */
    }
    try {
      if (typeof fully.turnScreenOn === "function") fully.turnScreenOn();
    } catch {
      /* ignore */
    }
    try {
      if (
        typeof fully.setScreenBrightness === "function" &&
        savedBrightness != null
      ) {
        fully.setScreenBrightness(savedBrightness);
      }
    } catch {
      /* ignore */
    }
    savedBrightness = null;
  }

  function setIdle(next) {
    const want = !!next;
    if (want === idle) {
      paintIdleClass(want);
      return;
    }
    idle = want;
    paintIdleClass(want);
    if (want) enterHardwareIdle();
    else exitHardwareIdle();
  }

  function evaluate() {
    const should = partyDisplayShouldBeIdle({
      displayActive,
      kiosk,
      isPlaying,
      hasTrack,
      quietSince,
      now: nowFn(),
      idleAfterMs,
    });
    setIdle(should);
    clearTimer();
    if (!displayActive || !kiosk || should || (isPlaying && hasTrack)) return;
    const since = Number(quietSince) || 0;
    if (!since) return;
    const remaining = idleAfterMs - (nowFn() - since);
    timer = setTimeout(
      () => {
        timer = null;
        evaluate();
      },
      remaining > 0 ? remaining + 25 : 0
    );
  }

  function noteQuietOrPlaying() {
    if (isPlaying && hasTrack) {
      quietSince = null;
      setIdle(false);
      clearTimer();
      return;
    }
    if (quietSince == null) quietSince = nowFn();
    evaluate();
  }

  function onUserActivity() {
    if (!displayActive || !kiosk) return;
    if (idle) setIdle(false);
    // Re-arm the quiet timer so a tap doesn't permanently block idle.
    if (!(isPlaying && hasTrack)) {
      quietSince = nowFn();
      evaluate();
    }
  }

  function bindListeners() {
    if (!doc || listenersBound) return;
    listenersBound = true;
    doc.addEventListener("pointerdown", onUserActivity, { passive: true });
    doc.addEventListener("keydown", onUserActivity);
  }

  function unbindListeners() {
    if (!doc || !listenersBound) return;
    listenersBound = false;
    doc.removeEventListener("pointerdown", onUserActivity);
    doc.removeEventListener("keydown", onUserActivity);
  }

  return {
    /**
     * @param {{ active: boolean, kiosk: boolean }} state
     */
    setDisplayState({ active, kiosk: isKiosk }) {
      displayActive = !!active;
      kiosk = !!isKiosk;
      if (!displayActive || !kiosk) {
        clearTimer();
        unbindListeners();
        quietSince = null;
        setIdle(false);
        return;
      }
      bindListeners();
      noteQuietOrPlaying();
    },

    /**
     * @param {{ isPlaying?: boolean, hasTrack?: boolean }} playback
     */
    syncPlayback({ isPlaying: playing = false, hasTrack: track = false } = {}) {
      isPlaying = !!playing;
      hasTrack = !!track;
      if (!displayActive || !kiosk) return;
      noteQuietOrPlaying();
    },

    /** Test / debug */
    isIdle() {
      return idle;
    },

    destroy() {
      clearTimer();
      unbindListeners();
      setIdle(false);
      displayActive = false;
      kiosk = false;
      quietSince = null;
    },
  };
}
