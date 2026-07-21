/**
 * PartyQueue UI entry. Cache-bust query on this URL is forwarded to every
 * dynamic import so phones pick up submodule changes after a deploy.
 */
const bust = new URL(import.meta.url).search || "";
await import(`./app.js${bust}`);
