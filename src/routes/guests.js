// Guest-facing social routes: guest profiles (host-edited notes/birthdays),
// Party Stats, play-history memory, Now Playing reactions, the suggestion
// box, and lyrics lookup.

import { asyncHandler } from "../http/async-handler.js";
import { softRateLimit } from "../rate-limit.js";
import {
  requireHost,
  requireHostStrict,
} from "../host-auth.js";
import {
  listGuestProfiles,
  addGuestNote,
  removeGuestNote,
  deleteGuestProfile,
  setGuestBirthday,
  renameGuestProfile,
} from "../guest-profiles.js";
import { forgetBirthdayShout } from "../dj-night-memory.js";
import {
  resolveGuestIdentity,
  sanitizeDisplayName,
} from "../display-name.js";
import { getHistory } from "../play-history.js";
import { originOf, moodOf, requestedByOf } from "../queue-origin.js";
import {
  getReactions,
  setReaction,
} from "../reactions.js";
import { getPartyStatsPayload } from "../party-stats.js";
import {
  addSuggestion,
  getSuggestions,
  setSuggestionDone,
  suggestionCounts,
  SUGGESTION_TEXT_MAX,
} from "../suggestion-box.js";
import { LyricsUnavailableError, lookupLyrics } from "../lyrics.js";
import { nudgeNowPlayingStream } from "../now-playing-http.js";

/** @param {import('express').Express} app */
export function registerGuestRoutes(app) {
  // Host-editable guest notes for DJ shout-outs (Settings → Users).
  app.get("/api/guests", requireHost, (_req, res) => {
    res.json({ guests: listGuestProfiles() });
  });

  app.post("/api/guests", requireHost, (req, res) => {
    const name = req.body?.name;
    const hasBirthday =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "birthday") ||
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "birthdayRole");
    const note =
      req.body?.note ?? (typeof req.body?.notes === "string" ? req.body.notes : null);

    // Birthday-only update (no new note required).
    if (hasBirthday && (note == null || String(note).trim() === "")) {
      const saved = setGuestBirthday(name, req.body?.birthday, req.body?.birthdayRole);
      if (!saved) {
        return res.status(400).json({ error: "Enter a guest name." });
      }
      return res.json({ ok: true, guest: saved, guests: listGuestProfiles() });
    }

    const saved = addGuestNote(name, note);
    if (!saved) {
      return res
        .status(400)
        .json({ error: "Enter a guest name and a short note." });
    }
    // Optional birthday fields can ride along with a new note.
    if (hasBirthday) {
      setGuestBirthday(name, req.body?.birthday, req.body?.birthdayRole);
    }
    if (saved.full) {
      return res.status(400).json({
        error: "That user already has the maximum number of notes.",
        guest: saved,
        guests: listGuestProfiles(),
      });
    }
    res.json({ ok: true, guest: saved, guests: listGuestProfiles() });
  });

  app.delete("/api/guests/:name/notes/:index", requireHostStrict, (req, res) => {
    const removed = removeGuestNote(
      decodeURIComponent(req.params.name || ""),
      req.params.index
    );
    if (!removed) {
      return res.status(404).json({ error: "Note not found." });
    }
    res.json({ ok: true, guest: removed, guests: listGuestProfiles() });
  });

  app.delete("/api/guests/:name", requireHostStrict, (req, res) => {
    const ok = deleteGuestProfile(decodeURIComponent(req.params.name || ""));
    if (!ok) {
      return res.status(404).json({ error: "Guest not found." });
    }
    res.json({ ok: true, guests: listGuestProfiles() });
  });

  // Rename a Users profile (and rewrite that name inside guest notes).
  app.post("/api/guests/rename", requireHostStrict, (req, res) => {
    const from = req.body?.from ?? req.body?.name;
    const to = req.body?.to ?? req.body?.newName;
    const result = renameGuestProfile(from, to);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, guest: result.guest, guests: listGuestProfiles() });
  });

  // Reset tonight's birthday / first-shout flags for one guest (keeps blurbs).
  app.post("/api/guests/:name/forget-birthday-shout", requireHost, (req, res) => {
    const name = decodeURIComponent(req.params.name || "");
    const ok = forgetBirthdayShout(name);
    if (!ok) {
      return res.status(400).json({ error: "Enter a guest name." });
    }
    res.json({ ok: true, name: sanitizeDisplayName(name), guests: listGuestProfiles() });
  });

  // The recently-played "memory" that powers repeat-avoidance, newest first.
  // Entries store a title when available; older ones are backfilled from Spotify
  // (title + album art) best-effort so the list always reads nicely.
  app.get("/api/history", requireHost, asyncHandler(async (_req, res) => {
    try {
      const entries = getHistory();
      const needLookup = entries.filter((e) => !e.name).map((e) => e.id);

      let info = new Map();
      if (needLookup.length) {
        try {
          info = await getTracksByIds(needLookup);
        } catch (err) {
          console.error("[history] track lookup failed:", err.message);
        }
      }

      const tracks = entries.map((e) => {
        const extra = info.get(e.id);
        // Prefer history stamp; fall back to live queue-origin (helps recover
        // Songs Like / Random after a skip that used to overwrite source).
        const source = e.source || originOf(e.id) || null;
        const requestedBy =
          e.requestedBy ||
          (source === "searched" ? requestedByOf(e.id) : null) ||
          null;
        return {
          id: e.id,
          title: e.name || extra?.title || "",
          artist: e.artist || extra?.artist || "",
          image: extra?.image ?? null,
          source,
          // Decade the era hit was added under ("80s", ...). Older entries
          // predate the history stamp — recover it from queue-origin if held.
          mood: source === "mood" ? e.mood || moodOf(e.id) || null : null,
          skipped: !!e.skipped,
          requestedBy: source === "searched" ? requestedBy : null,
        };
      });

      res.json({ count: tracks.length, tracks });
    } catch (err) {
      console.error("[history]", err.message);
      res.status(500).json({ error: err.message || "Could not load memory." });
    }
  }));

  // Party Stats: most-requested songs/artists/requesters from guest search-and-adds,
  // for both "tonight" (a rolling window) and all-time. Lazy-loaded by the UI panel.
  // Short TTL cache in party-stats.js; invalidated on request/reaction writes.
  app.get("/api/stats", asyncHandler(async (_req, res) => {
    try {
      res.json(await getPartyStatsPayload());
    } catch (err) {
      console.error("[stats]", err.message);
      res.status(500).json({ error: err.message || "Could not load stats." });
    }
  }));

  const reactionLimit = softRateLimit({
    windowMs: 1500,
    max: 8,
    message: "Easy on the reactions — try again in a moment.",
  });
  // Lyrics hits LRCLIB / Unison / ovh; keep shared-NAT phones usable while
  // blunting a stuck tab or LAN prank that hammers lookups.
  const lyricsLimit = softRateLimit({
    windowMs: 10_000,
    max: 12,
    message: "Lyrics is cooling down — try again in a moment.",
  });
  lyricsLimit.displayName = "lyricsLimit";

  // Now Playing reactions (mood = one per guest; mic = karaoke, separate).
  app.get("/api/reactions", (req, res) => {
    const id =
      typeof req.query?.id === "string"
        ? req.query.id
        : typeof req.query?.trackId === "string"
          ? req.query.trackId
          : "";
    const guestId =
      typeof req.query?.guestId === "string"
        ? req.query.guestId
        : typeof req.query?.guest === "string"
          ? req.query.guest
          : "";
    res.json(getReactions(id, guestId));
  });

  app.post("/api/reactions", reactionLimit, (req, res) => {
    const id =
      typeof req.body?.id === "string"
        ? req.body.id
        : typeof req.body?.trackId === "string"
          ? req.body.trackId
          : "";
    const kind = req.body?.kind;
    const guestId = req.body?.guestId ?? req.body?.guest;
    const result = setReaction(id, kind, guestId, {
      name: req.body?.name,
      artist: req.body?.artist,
      by: req.body?.by ?? req.body?.requestedBy,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    nudgeNowPlayingStream();
    res.json(result);
  });

  // ---- Suggestion box --------------------------------------------------------
  const SUGGEST_COOLDOWN_MS = 30_000;
  const suggestLastByIp = new Map(); // ip -> last submit ts

  function suggestClientKey(req) {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    // Bound the map: expired cooldowns are useless, and a spoof-heavy LAN
    // must not grow this without limit.
    if (suggestLastByIp.size > 500) {
      const cutoff = Date.now() - SUGGEST_COOLDOWN_MS;
      for (const [ip, last] of suggestLastByIp) {
        if (last < cutoff) suggestLastByIp.delete(ip);
      }
    }
    return key;
  }

  app.get("/api/suggestions", (_req, res) => {
    try {
      const includeDone = String(_req.query.includeDone || "1") !== "0";
      res.json({
        suggestions: getSuggestions({ includeDone }),
        counts: suggestionCounts(),
        textMax: SUGGESTION_TEXT_MAX,
      });
    } catch (err) {
      console.error("[suggestions]", err.message);
      res.status(500).json({ error: err.message || "Could not load suggestions." });
    }
  });

  app.post("/api/suggestions", (req, res) => {
    try {
      const key = suggestClientKey(req);
      const now = Date.now();
      const last = suggestLastByIp.get(key) || 0;
      if (now - last < SUGGEST_COOLDOWN_MS) {
        return res.status(429).json({
          error: "Please wait a few seconds before sending another suggestion.",
          retryMs: SUGGEST_COOLDOWN_MS - (now - last),
        });
      }
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      const { user } = resolveGuestIdentity({
        requestedBy: req.body?.requestedBy,
        requestedByUser: req.body?.requestedByUser,
      });
      if (!user) {
        return res.status(400).json({ error: "Enter your name before sending a suggestion." });
      }
      // Suggestions are host-facing — stamp the stable User, not the queue alias.
      const row = addSuggestion({ text, requestedBy: user });
      if (!row) {
        return res.status(400).json({
          error: `Suggestion must be at least 3 characters (max ${SUGGESTION_TEXT_MAX}).`,
        });
      }
      suggestLastByIp.set(key, now);
      res.json({ ok: true, suggestion: row, counts: suggestionCounts() });
    } catch (err) {
      console.error("[suggestions/add]", err.message);
      res.status(500).json({ error: err.message || "Could not save suggestion." });
    }
  });

  app.post("/api/suggestions/:id/done", requireHost, (req, res) => {
    try {
      const done = req.body?.done !== false && req.body?.done !== "false";
      const row = setSuggestionDone(req.params.id, !!done);
      if (!row) return res.status(404).json({ error: "Suggestion not found." });
      res.json({ ok: true, suggestion: row, counts: suggestionCounts() });
    } catch (err) {
      console.error("[suggestions/done]", err.message);
      res.status(500).json({ error: err.message || "Could not update suggestion." });
    }
  });

  // Lyrics via LRClib with a bounded Unison fallback. Cached server-side so
  // guest phones share one lookup per track.
  app.get("/api/lyrics", lyricsLimit, asyncHandler(async (req, res) => {
    const title = String(req.query.title || "").trim();
    const artist = String(req.query.artist || "").trim();
    if (!title || !artist) {
      return res.status(400).json({ error: "Missing title or artist." });
    }
    const album = String(req.query.album || "").trim();
    const uri = String(req.query.uri || "").trim();
    const durationRaw = req.query.duration;
    const duration =
      durationRaw != null && String(durationRaw).trim() !== ""
        ? Number(durationRaw)
        : null;
    try {
      res.json(
        await lookupLyrics({
          title,
          artist,
          album,
          uri,
          duration: Number.isFinite(duration) ? duration : null,
        })
      );
    } catch (err) {
      console.error("[lyrics]", err.message);
      if (err instanceof LyricsUnavailableError) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil(Number(err.retryAfterMs || 0) / 1000)
        );
        res.setHeader("Retry-After", String(retryAfterSec));
        return res.status(503).json({
          error: "Lyrics service is temporarily busy.",
          retryAfterSec,
        });
      }
      res.status(502).json({ error: err.message || "Could not fetch lyrics." });
    }
  }));
}
