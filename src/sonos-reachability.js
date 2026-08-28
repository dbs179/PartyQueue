// Classify Sonos SOAP / TCP failures that mean a player is gone or wedged.
// Used to back off tight watchers and skip dead group members.

export function isSonosUnreachableError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err || "");
  return (
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTDOWN" ||
    /EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTDOWN|timed out/i.test(
      msg
    )
  );
}
