// Host party rituals: pause guest requests, Kids lock (mood + subtle DJ).

import {
  getContentSettings,
  setContentSettings,
  getDjVoiceSettings,
  setDjVoiceSettings,
  loadSettings,
  PARTY_OVER_TTL_MS,
} from "./settings.js";
import { savePickerSelection } from "./autofill.js";

const KIDS_GENRES = ["kids", "soundtrack"];

/**
 * Enable/disable guest request pause.
 * @returns {{ requestsPaused: boolean }}
 */
export function setRequestsPaused(enabled) {
  return {
    requestsPaused: setContentSettings({ requestsPaused: !!enabled })
      .requestsPaused,
  };
}

export const PARTY_OVER_MESSAGE =
  "The party is over — you have to go home now.";

/**
 * "Party's Over" lockdown: the hard end-of-night lock. Closing Time switches
 * it on; the host flips it off from DJ Booth → Guest access.
 * @returns {{ partyOver: boolean, partyOverAt: number }}
 */
export function setPartyOver(enabled) {
  const c = setContentSettings({ partyOver: !!enabled });
  return { partyOver: c.partyOver, partyOverAt: c.partyOverAt };
}

/**
 * Whether the lockdown is active right now. Auto-expires 8 hours after it was
 * switched on (clearing the stored flag) so a forgotten toggle can't block
 * the next event.
 */
export function isPartyOver(now = Date.now()) {
  const c = getContentSettings();
  if (!c.partyOver) return false;
  if (c.partyOverAt && now - c.partyOverAt > PARTY_OVER_TTL_MS) {
    setContentSettings({ partyOver: false });
    // Dynamic import avoids a cycle (party-settings-http reads isPartyOver).
    import("./party-settings-http.js")
      .then((m) => m.nudgePartySettingsStream())
      .catch(() => {});
    return false;
  }
  return true;
}

/**
 * Kids lock: pin Kids mood + subtle DJ intensity + explicit filter.
 * Unlock restores the snapshot taken when lock was first enabled.
 */
export function setKidsLock(enabled) {
  const on = !!enabled;
  const cur = getContentSettings();
  if (on) {
    if (cur.kidsLock) return getRitualState();
    const s = loadSettings();
    const dj = getDjVoiceSettings();
    const snapshot = {
      genres: Array.isArray(s.genres) ? [...s.genres] : null,
      djCharacterIntensity: dj.djCharacterIntensity || "classic",
      sisterStaticIntensity:
        dj.djSisterStatic?.djCharacterIntensity || "classic",
      filterExplicit: cur.filterExplicit,
    };
    setContentSettings({
      kidsLock: true,
      kidsLockSnapshot: snapshot,
      filterExplicit: true,
    });
    setDjVoiceSettings({
      djCharacterIntensity: "subtle",
      djSisterStatic: { djCharacterIntensity: "subtle" },
    });
    savePickerSelection(undefined, [...KIDS_GENRES]);
    return getRitualState();
  }

  // Unlock
  const snap = cur.kidsLockSnapshot;
  setContentSettings({ kidsLock: false, kidsLockSnapshot: null });
  if (snap) {
    if (snap.filterExplicit != null) {
      setContentSettings({ filterExplicit: !!snap.filterExplicit });
    }
    if (snap.djCharacterIntensity) {
      setDjVoiceSettings({ djCharacterIntensity: snap.djCharacterIntensity });
    }
    if (snap.sisterStaticIntensity) {
      setDjVoiceSettings({
        djSisterStatic: { djCharacterIntensity: snap.sisterStaticIntensity },
      });
    }
    if (Array.isArray(snap.genres)) {
      savePickerSelection(undefined, snap.genres);
    }
  }
  return getRitualState();
}

export function getRitualState() {
  const c = getContentSettings();
  const s = loadSettings();
  return {
    requestsPaused: c.requestsPaused,
    partyOver: c.partyOver,
    kidsLock: c.kidsLock,
    filterExplicit: c.filterExplicit,
    genres: Array.isArray(s.genres) ? s.genres : null,
    djCharacterIntensity: getDjVoiceSettings().djCharacterIntensity,
  };
}
