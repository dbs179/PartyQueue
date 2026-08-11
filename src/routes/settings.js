// Host settings routes: the combined settings read/write plus the
// Settings → Danger Zone reset actions (history, stats, DJ memory,
// reactions, karaoke, suggestions).

import {
  RANDOMNESS_DEFAULTS,
  DISCOVERY_DEFAULTS,
  REQUEST_FAIRNESS_DEFAULTS,
  SET_REQUEST_FAIRNESS_DEFAULTS,
  CONTENT_DEFAULTS,
  BRANDING_DEFAULTS,
  ROTATION_DEFAULTS,
  NEVER_ENDING_DEFAULT,
  getRandomnessSettings,
  setRandomnessSettings,
  getRotationSettings,
  setRotationSettings,
  getDiscoverySettings,
  setDiscoverySettings,
  getRequestFairnessSettings,
  setRequestFairnessSettings,
  getSetRequestFairnessSettings,
  setSetRequestFairnessSettings,
  resetFairnessQuotas,
  getContentSettings,
  setContentSettings,
  getBrandingSettings,
  setBrandingSettings,
  getDjVoiceSettings,
  setDjVoiceSettings,
  DJ_VOICE_DEFAULTS,
} from "../settings.js";
import {
  isHostPinConfigured,
  requireHost,
  requireHostStrict,
} from "../host-auth.js";
import {
  setRequestsPaused,
  setKidsLock,
  getRitualState,
  isPartyOver,
} from "../party-rituals.js";
import { clearHistory } from "../play-history.js";
import { clearRequests } from "../request-log.js";
import { clearDjNightMemory } from "../dj-night-memory.js";
import { clearReactionSetMemory } from "../reaction-sets.js";
import {
  clearMoodReactions,
  clearKaraokeReactions,
} from "../reactions.js";
import { clearSuggestions } from "../suggestion-box.js";
import { nudgeNowPlayingStream } from "../now-playing-http.js";
import { nudgePartySettingsStream } from "../party-settings-http.js";

/** @param {import('express').Express} app */
export function registerSettingsRoutes(app) {
  // Randomness knobs (song memory + per-artist budget) for the random picker.
  // Also returns the defaults so the UI can offer a "reset to defaults" action.
  function publicContentSettings() {
    // Reading through isPartyOver() applies the 8-hour auto-expiry, so a
    // stale lockdown clears before the booth toggle renders it.
    isPartyOver();
    const { kidsLockSnapshot: _snap, ...rest } = getContentSettings();
    return rest;
  }

  app.get("/api/settings", requireHost, (_req, res) => {
    res.json({
      ...getRandomnessSettings(),
      ...getDiscoverySettings(),
      ...getRequestFairnessSettings(),
      ...getSetRequestFairnessSettings(),
      ...getRotationSettings(),
      ...publicContentSettings(),
      ...getDjVoiceSettings(),
      ...getBrandingSettings(),
      ...getRitualState(),
      defaults: {
        ...RANDOMNESS_DEFAULTS,
        ...DISCOVERY_DEFAULTS,
        ...REQUEST_FAIRNESS_DEFAULTS,
        ...SET_REQUEST_FAIRNESS_DEFAULTS,
        ...ROTATION_DEFAULTS,
        ...CONTENT_DEFAULTS,
        ...DJ_VOICE_DEFAULTS,
        ...BRANDING_DEFAULTS,
        neverEnding: NEVER_ENDING_DEFAULT,
      },
    });
  });

  app.post("/api/settings", requireHost, (req, res) => {
    try {
      const body = { ...(req.body ?? {}) };
      if (body.hostControlsOnly === true && !isHostPinConfigured()) {
        return res.status(400).json({
          error: "Set a host PIN before enabling host-only controls.",
        });
      }
      // Rituals apply side effects (Kids mood / subtle DJ); don't treat them as
      // plain content booleans.
      if (body.kidsLock != null) {
        setKidsLock(!!body.kidsLock);
        delete body.kidsLock;
      }
      if (body.requestsPaused != null) {
        setRequestsPaused(!!body.requestsPaused);
        delete body.requestsPaused;
      }
      delete body.kidsLockSnapshot;
      setRandomnessSettings(body);
      setDiscoverySettings(body);
      setRequestFairnessSettings(body);
      setSetRequestFairnessSettings(body);
      setRotationSettings(body);
      setContentSettings(body);
      setDjVoiceSettings(body);
      setBrandingSettings(body);
      // Party-wide toggles/mix live on /api/party — not Now Playing.
      nudgePartySettingsStream();
      res.json({
        ok: true,
        ...getRandomnessSettings(),
        ...getDiscoverySettings(),
        ...getRequestFairnessSettings(),
        ...getSetRequestFairnessSettings(),
        ...getRotationSettings(),
        ...publicContentSettings(),
        ...getDjVoiceSettings(),
        ...getBrandingSettings(),
        ...getRitualState(),
        defaults: {
          ...RANDOMNESS_DEFAULTS,
          ...DISCOVERY_DEFAULTS,
          ...REQUEST_FAIRNESS_DEFAULTS,
          ...SET_REQUEST_FAIRNESS_DEFAULTS,
          ...ROTATION_DEFAULTS,
          ...CONTENT_DEFAULTS,
          ...DJ_VOICE_DEFAULTS,
          ...BRANDING_DEFAULTS,
          neverEnding: NEVER_ENDING_DEFAULT,
        },
      });
    } catch (err) {
      console.error("[settings]", err.message);
      res.status(400).json({ error: err.message || "Could not save settings." });
    }
  });

  // Forget the recently-played history so the picker starts fresh.
  app.post("/api/settings/clear-history", requireHostStrict, (_req, res) => {
    try {
      clearHistory();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-history]", err.message);
      res.status(500).json({ error: err.message || "Could not clear history." });
    }
  });

  // Forget all guest request stats (top songs/artists/requesters, dedications).
  // DJ shout memory is separate — use /api/settings/clear-dj-memory.
  app.post("/api/settings/clear-stats", requireHostStrict, (_req, res) => {
    try {
      clearRequests();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-stats]", err.message);
      res.status(500).json({ error: err.message || "Could not clear stats." });
    }
  });

  // Clear rolling song-request + Set Request fairness windows without wiping Stats.
  app.post("/api/settings/clear-fairness", requireHostStrict, (_req, res) => {
    try {
      const fairnessResetAt = resetFairnessQuotas();
      res.json({ ok: true, fairnessResetAt });
    } catch (err) {
      console.error("[settings/clear-fairness]", err.message);
      res.status(500).json({ error: err.message || "Could not reset fairness." });
    }
  });

  // Forget DJ night memory only (first-shout + birthday-once + used blurbs).
  app.post("/api/settings/clear-dj-memory", requireHostStrict, (_req, res) => {
    try {
      clearDjNightMemory();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-dj-memory]", err.message);
      res.status(500).json({ error: err.message || "Could not clear DJ memory." });
    }
  });

  // One-tap between parties: DJ shout memory + fairness + Loved/Hated
  // already-played-this-party memory. Keeps song memory, reactions, karaoke,
  // stats, suggestions, and the queue.
  app.post("/api/settings/new-party", requireHostStrict, (_req, res) => {
    try {
      clearDjNightMemory();
      clearReactionSetMemory();
      const fairnessResetAt = resetFairnessQuotas();
      res.json({
        ok: true,
        fairnessResetAt,
        cleared: ["djMemory", "fairness", "reactionSetMemory"],
      });
    } catch (err) {
      console.error("[settings/new-party]", err.message);
      res.status(500).json({ error: err.message || "Could not start a new party." });
    }
  });

  // Forget Now Playing mood reactions (keeps Karaoke mic list).
  app.post("/api/settings/clear-reactions", requireHostStrict, (_req, res) => {
    try {
      clearMoodReactions();
      nudgeNowPlayingStream();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-reactions]", err.message);
      res.status(500).json({
        error: err.message || "Could not clear reactions.",
      });
    }
  });

  // Forget Karaoke mic tags only (keeps mood reactions).
  app.post("/api/settings/clear-karaoke", requireHostStrict, (_req, res) => {
    try {
      clearKaraokeReactions();
      nudgeNowPlayingStream();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-karaoke]", err.message);
      res.status(500).json({
        error: err.message || "Could not clear Karaoke list.",
      });
    }
  });

  app.post("/api/settings/clear-suggestions", requireHostStrict, (_req, res) => {
    try {
      clearSuggestions();
      res.json({ ok: true });
    } catch (err) {
      console.error("[settings/clear-suggestions]", err.message);
      res.status(500).json({ error: err.message || "Could not clear suggestions." });
    }
  });
}
