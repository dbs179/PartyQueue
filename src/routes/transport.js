// Speaker transport routes: rooms/groups discovery and selection, playback
// controls, volume, and grouping. Open by default; hosts can optionally
// require their PIN for these controls (requireHostControls), and rate
// limits still blunt spam.

import { asyncHandler } from "../http/async-handler.js";
import { requireHostControls } from "../http/host-controls.js";
import { isDjVolumeHandoffActive } from "../dj-volume-handoff.js";
import { nudgeAutoFill } from "../autofill.js";
import {
  groupAll,
  joinSpeakerToTarget,
  leaveSpeakerGroup,
  listGroups,
  listRooms,
  selectGroup,
  ungroupAll,
  next,
  pause,
  play,
  previous,
  toggleMute,
  toggleShuffle,
  volumeDown,
  volumeUp,
  getGroupVolume,
} from "../sonos.js";
import {
  nudgeNowPlayingTransition,
  nowPlayingMonitor,
} from "../now-playing-http.js";

/** @param {import('express').Express} app @param {import('./api.js').ApiCtx} ctx */
export function registerTransportRoutes(app, ctx) {
  const { destructiveLimit, transportLimit } = ctx;

  // Optional helper: see which rooms PartyQueue can see (useful for setup).
  app.get("/api/rooms", asyncHandler(async (_req, res) => {
    try {
      res.json({ rooms: await listRooms() });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  }));

  // Current Sonos zone groups for the target picker (which group's queue to use).
  app.get("/api/groups", asyncHandler(async (_req, res) => {
    try {
      res.json(await listGroups());
    } catch (err) {
      console.error("[groups]", err.message);
      res.status(503).json({ error: err.message });
    }
  }));

  app.post("/api/groups/select", requireHostControls, asyncHandler(async (req, res) => {
    const { room } = req.body ?? {};
    if (!room) {
      return res.status(400).json({ error: "Missing room." });
    }
    try {
      res.json({ ok: true, ...(await selectGroup(String(room))) });
    } catch (err) {
      console.error("[groups/select]", err.message);
      res.status(400).json({ error: err.message || "Could not select group." });
    }
  }));

  // Transport / volume / queue editing and grouping are open by default. Hosts
  // can optionally require their PIN for these controls; rate limits still blunt
  // spam and Clear Queue keeps a double confirmation in the UI.
  app.post("/api/play", transportLimit, requireHostControls, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await play()) });
    } catch (err) {
      console.error("[play]", err.message);
      res.status(502).json({ error: err.message || "Could not start playback." });
    }
  }));

  app.post("/api/pause", transportLimit, requireHostControls, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await pause()) });
    } catch (err) {
      console.error("[pause]", err.message);
      res.status(502).json({ error: err.message || "Could not pause playback." });
    }
  }));

  app.post("/api/next", transportLimit, requireHostControls, asyncHandler(async (_req, res) => {
    const transitionFrom = nowPlayingMonitor.latest;
    try {
      const result = await next();
      // Never-Ending can lag behind rapid skips; re-check queue depth soon.
      nudgeAutoFill();
      nudgeNowPlayingTransition(transitionFrom);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[next]", err.message);
      res.status(502).json({ error: err.message || "Could not skip track." });
    }
  }));

  app.post("/api/previous", transportLimit, requireHostControls, asyncHandler(async (_req, res) => {
    const transitionFrom = nowPlayingMonitor.latest;
    try {
      const result = await previous();
      nudgeNowPlayingTransition(transitionFrom);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[previous]", err.message);
      res.status(502).json({ error: err.message || "Could not go to previous track." });
    }
  }));

  function blockVolumeDuringDj(_req, res, next) {
    if (isDjVolumeHandoffActive()) {
      return res.status(423).json({
        error: "DJ volume handoff in progress — volume will return automatically.",
      });
    }
    return next();
  }

  app.post("/api/mute", transportLimit, requireHostControls, blockVolumeDuringDj, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await toggleMute()) });
    } catch (err) {
      console.error("[mute]", err.message);
      res
        .status(err.statusCode || 502)
        .json({ error: err.message || "Could not toggle mute." });
    }
  }));

  app.post("/api/shuffle", transportLimit, requireHostControls, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await toggleShuffle()) });
    } catch (err) {
      console.error("[shuffle]", err.message);
      res.status(502).json({ error: err.message || "Could not toggle shuffle." });
    }
  }));

  // Clamp an optional ?step to a sane whole number (1..100), defaulting to 1.
  function parseStep(raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(100, n);
  }

  app.post("/api/volume/up", transportLimit, requireHostControls, blockVolumeDuringDj, asyncHandler(async (req, res) => {
    try {
      res.json({ ok: true, ...(await volumeUp(parseStep(req.query.step))) });
    } catch (err) {
      console.error("[volume/up]", err.message);
      res
        .status(err.statusCode || 502)
        .json({ error: err.message || "Could not change volume." });
    }
  }));

  app.post("/api/volume/down", transportLimit, requireHostControls, blockVolumeDuringDj, asyncHandler(async (req, res) => {
    try {
      res.json({ ok: true, ...(await volumeDown(parseStep(req.query.step))) });
    } catch (err) {
      console.error("[volume/down]", err.message);
      res
        .status(err.statusCode || 502)
        .json({ error: err.message || "Could not change volume." });
    }
  }));

  // Read current target-group volume (max across members) — used for DJ boost monitoring.
  app.get("/api/volume", asyncHandler(async (_req, res) => {
    try {
      const volume = await getGroupVolume();
      res.json({ ok: true, volume });
    } catch (err) {
      console.error("[volume]", err.message);
      res.status(502).json({ error: err.message || "Could not read volume." });
    }
  }));

  app.post("/api/group-all", destructiveLimit, requireHostControls, blockVolumeDuringDj, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await groupAll()) });
    } catch (err) {
      console.error("[group-all]", err.message);
      res
        .status(err.statusCode || 502)
        .json({ error: err.message || "Could not group speakers." });
    }
  }));

  app.post("/api/groups/join", destructiveLimit, requireHostControls, asyncHandler(async (req, res) => {
    try {
      const room = req.body?.room;
      res.json({ ok: true, ...(await joinSpeakerToTarget(room)) });
    } catch (err) {
      console.error("[groups/join]", err.message);
      res.status(400).json({ error: err.message || "Could not join speaker." });
    }
  }));

  app.post("/api/groups/leave", destructiveLimit, requireHostControls, asyncHandler(async (req, res) => {
    try {
      const room = req.body?.room;
      res.json({ ok: true, ...(await leaveSpeakerGroup(room)) });
    } catch (err) {
      console.error("[groups/leave]", err.message);
      res.status(400).json({ error: err.message || "Could not ungroup speaker." });
    }
  }));

  app.post("/api/groups/ungroup-all", destructiveLimit, requireHostControls, asyncHandler(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await ungroupAll()) });
    } catch (err) {
      console.error("[groups/ungroup-all]", err.message);
      res.status(502).json({ error: err.message || "Could not ungroup speakers." });
    }
  }));
}
