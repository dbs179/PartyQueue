import { requireHost } from "../host-auth.js";
import { getContentSettings } from "../settings.js";

/**
 * When hostControlsOnly is on, gate transport/clear/edit/group APIs behind the
 * host session. Open-party (default) leaves these routes public on the LAN.
 */
export function requireHostControls(req, res, next) {
  if (!getContentSettings().hostControlsOnly) return next();
  return requireHost(req, res, next);
}
