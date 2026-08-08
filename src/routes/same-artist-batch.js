// Same-artist showcase: Spotify artist lookup, arm/clear next-set, read state.

import { asyncHandler } from "../http/async-handler.js";
import { requireHost } from "../host-auth.js";
import {
  armSameArtistBatch,
  artistKeyFromName,
  clearSameArtistBatch,
  getSameArtistBatchState,
} from "../same-artist-batch.js";
import { getArtist, searchArtists } from "../spotify.js";

/** @param {import('express').Express} app */
export function registerSameArtistBatchRoutes(app) {
  app.get(
    "/api/same-artist-batch",
    requireHost,
    (_req, res) => {
      res.json({ ok: true, ...getSameArtistBatchState() });
    }
  );

  // Spotify artist typeahead for Booth “Next artist set”.
  app.get(
    "/api/same-artist-batch/artists",
    requireHost,
    asyncHandler(async (req, res) => {
      const q = String(req.query.q || "").trim();
      if (!q) {
        return res.json({ ok: true, artists: [] });
      }
      try {
        const artists = await searchArtists(q, 10);
        res.json({ ok: true, artists });
      } catch (err) {
        console.error("[same-artist-batch/artists]", err.message);
        res.status(502).json({
          error: err.message || "Spotify artist search failed.",
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
        const artistId = String(req.body?.artistId || "").trim();
        const raw = String(
          req.body?.artist || req.body?.name || ""
        ).trim();
        if (!artistId && !raw) {
          return res.status(400).json({
            error: "Search Spotify and pick an artist for the next set.",
            ...getSameArtistBatchState(),
          });
        }

        let name = raw;
        let spotifyArtistId = artistId || null;

        // Prefer a resolved Spotify match (id from typeahead, or best search hit).
        if (!spotifyArtistId) {
          const hits = await searchArtists(raw, 5);
          const exact = hits.find(
            (a) => a.name.toLowerCase() === raw.toLowerCase()
          );
          const match = exact || hits[0];
          if (!match) {
            return res.status(400).json({
              error: `No Spotify artist found for “${raw}”.`,
              ...getSameArtistBatchState(),
            });
          }
          spotifyArtistId = match.id;
          name = match.name;
        } else if (!name) {
          const resolved = await getArtist(spotifyArtistId);
          if (!resolved) {
            return res.status(400).json({
              error: "Unknown Spotify artist.",
              ...getSameArtistBatchState(),
            });
          }
          name = resolved.name;
        }

        const state = armSameArtistBatch({
          artistKey: artistKeyFromName(name),
          artistName: name,
          spotifyArtistId,
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
