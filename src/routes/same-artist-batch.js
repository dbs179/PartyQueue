// Same-artist showcase: list pool artists, arm/clear next-set, read state.

import { asyncHandler } from "../http/async-handler.js";
import { requireHost } from "../host-auth.js";
import { loadSettings } from "../settings.js";
import {
  armSameArtistBatch,
  artistKeyFromName,
  buildSameArtistPool,
  clearSameArtistBatch,
  getSameArtistBatchState,
} from "../same-artist-batch.js";

/** @param {import('express').Express} app */
export function registerSameArtistBatchRoutes(app) {
  app.get(
    "/api/same-artist-batch",
    requireHost,
    (_req, res) => {
      res.json({ ok: true, ...getSameArtistBatchState() });
    }
  );

  app.get(
    "/api/same-artist-batch/artists",
    requireHost,
    asyncHandler(async (_req, res) => {
      try {
        const filterExplicit = !!loadSettings().filterExplicit;
        const { artists, pool } = await buildSameArtistPool({ filterExplicit });
        res.json({ ok: true, artists, pool });
      } catch (err) {
        console.error("[same-artist-batch/artists]", err.message);
        res.status(502).json({
          error: err.message || "Could not list artists.",
          ...getSameArtistBatchState(),
        });
      }
    })
  );

  app.post(
    "/api/same-artist-batch",
    requireHost,
    asyncHandler(async (req, res) => {
      try {
        const raw = String(req.body?.artist || "").trim();
        if (!raw) {
          return res.status(400).json({
            error: "Pick an artist for the next same-artist set.",
            ...getSameArtistBatchState(),
          });
        }
        const key = artistKeyFromName(raw);
        const filterExplicit = !!loadSettings().filterExplicit;
        const { artists } = await buildSameArtistPool({ filterExplicit });
        const match =
          artists.find((a) => a.key === key) ||
          artists.find(
            (a) => a.name.toLowerCase() === raw.toLowerCase()
          );
        if (!match) {
          return res.status(400).json({
            error: `"${raw}" is not in the current Mood/Genre pool.`,
            ...getSameArtistBatchState(),
          });
        }
        const state = armSameArtistBatch({
          artistKey: match.key,
          artistName: match.name,
        });
        res.json({ ok: true, ...state });
      } catch (err) {
        res.status(err.statusCode || 400).json({
          error: err.message || "Could not arm same-artist set.",
          ...getSameArtistBatchState(),
        });
      }
    })
  );

  app.delete("/api/same-artist-batch", requireHost, (_req, res) => {
    res.json({ ok: true, ...clearSameArtistBatch() });
  });
}
