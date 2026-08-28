// DJ Voice booth routes: TTS voice preview, effective-prompt preview, and the
// one-shot next-set pack (Node-RED / Home Assistant).

import { asyncHandler } from "../http/async-handler.js";
import { requireHost } from "../host-auth.js";
import {
  previewTtsVoice,
  buildDjEffectivePromptPreview,
} from "../dj-voice.js";
import { normalizeDjPersonaId } from "../settings.js";
import {
  armDjNextSet,
  clearDjNextSet,
  getDjNextSetState,
} from "../dj-set-packs.js";

/** @param {import('express').Express} app */
export function registerDjRoutes(app) {
  // Preview the selected (or requested) HA TTS voice in the browser.
  app.post("/api/dj-voice/preview", requireHost, asyncHandler(async (req, res) => {
    try {
      const result = await previewTtsVoice(
        req.body?.voice ?? null,
        req.body?.speed ?? null,
        req.body?.provider ?? null
      );
      res.json(result);
    } catch (err) {
      console.error("[dj-voice] preview failed:", err.message);
      res.status(400).json({
        error: err.message || "Could not preview that voice.",
      });
    }
  }));

  app.get("/api/dj-voice/prompt-preview", requireHost, (req, res) => {
    const personaId = normalizeDjPersonaId(req.query?.persona);
    res.json({
      prompt: buildDjEffectivePromptPreview(personaId),
      personaId,
      coreRulesLocked: true,
    });
  });

  // One-shot next-set DJ pack (Node-RED / Home Assistant). Consumed by the
  // next refill/set announce, then normal banks resume.
  app.get("/api/dj-voice/next-set", requireHost, (_req, res) => {
    res.json({ ok: true, ...getDjNextSetState() });
  });

  app.post("/api/dj-voice/next-set", requireHost, (req, res) => {
    try {
      const packId = String(req.body?.pack || "").trim();
      if (!packId) {
        return res.status(400).json({
          error: 'Missing "pack" id.',
          ...getDjNextSetState(),
        });
      }
      const state = armDjNextSet(packId);
      res.json({ ok: true, ...state });
    } catch (err) {
      res.status(400).json({
        error: err.message || "Could not arm DJ set pack.",
        ...getDjNextSetState(),
      });
    }
  });

  app.delete("/api/dj-voice/next-set", requireHost, (_req, res) => {
    res.json({ ok: true, ...clearDjNextSet() });
  });
}
