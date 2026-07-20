// Host party rituals: pause guest requests, Kids lock (mood + subtle DJ).

import {
  getContentSettings,
  setContentSettings,
  getDjVoiceSettings,
  setDjVoiceSettings,
  loadSettings,
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
      filterExplicit: cur.filterExplicit,
    };
    setContentSettings({
      kidsLock: true,
      kidsLockSnapshot: snapshot,
      filterExplicit: true,
    });
    setDjVoiceSettings({ djCharacterIntensity: "subtle" });
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
    kidsLock: c.kidsLock,
    filterExplicit: c.filterExplicit,
    genres: Array.isArray(s.genres) ? s.genres : null,
    djCharacterIntensity: getDjVoiceSettings().djCharacterIntensity,
  };
}
