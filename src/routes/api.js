// API route orchestrator. Each domain registers its own routes; this module
// only fans out the shared context. Route inventory (method + path +
// middleware chain) is contract-tested against test/fixtures/route-table.json.

import { registerSystemRoutes } from "./system.js";
import { registerQueueRoutes } from "./queue.js";
import { registerTransportRoutes } from "./transport.js";
import { registerSpotifyRoutes } from "./spotify.js";
import { registerConnectionRoutes } from "./connections.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerHostPinRoutes } from "./host-pin.js";
import { registerGuestRoutes } from "./guests.js";
import { registerMediaRoutes } from "./media.js";
import { registerDjRoutes } from "./dj.js";

/**
 * Shared route context from server.js.
 *
 * @typedef {{
 *   VERSION: string,
 *   isListening: () => boolean,
 *   isShuttingDown: () => boolean,
 *   queueBurstLimit: import('express').RequestHandler,
 *   queueSustainedLimit: import('express').RequestHandler,
 *   destructiveLimit: import('express').RequestHandler,
 *   transportLimit: import('express').RequestHandler,
 *   requestShutdown: (opts?: object) => void,
 *   sonos?: object,
 * }} ApiCtx
 */

/**
 * @param {import('express').Express} app
 * @param {ApiCtx} ctx
 */
export function registerApiRoutes(app, ctx) {
  registerSystemRoutes(app, ctx);
  registerQueueRoutes(app, ctx);
  registerTransportRoutes(app, ctx);
  registerSpotifyRoutes(app);
  registerConnectionRoutes(app);
  registerSettingsRoutes(app);
  registerHostPinRoutes(app);
  registerGuestRoutes(app);
  registerMediaRoutes(app);
  registerDjRoutes(app);
}
