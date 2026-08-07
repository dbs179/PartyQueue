import "./load-env.js"; // load .env before any module reads process.env
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger, redactString } from "./logger.js";
import { installConsoleBridge } from "./console-bridge.js";
import { hostGuard } from "./http/host-guard.js";
import { asyncHandler } from "./http/async-handler.js";
import { softRateLimit } from "./rate-limit.js";
import {
  nowPlayingMonitor,
  closeNowPlayingStreams,
  registerNowPlayingRoutes,
} from "./now-playing-http.js";
import {
  queueMonitor,
  closeQueueStreams,
  registerQueueStreamRoutes,
} from "./queue-http.js";
import { registerApiRoutes } from "./routes/index.js";
import { getBrandingSettings, setDiscoverySettings } from "./settings.js";
import {
  bannerExists,
  bannerPath,
  seedStarterBanners,
} from "./banners.js";
import { seedStarterDjIcons } from "./dj-icon.js";
import {
  isHostPinConfigured,
  ensureHostBootstrapCode,
  hostBootstrapFileName,
} from "./host-auth.js";
import { warmTrackPool, startPoolRewarmLoop } from "./spotify.js";
import {
  warmGenresFromPool,
  flushGenrePersist,
  stopGenreWarm,
} from "./genres.js";
import { initAutoFill, stopAutoFillMonitor } from "./autofill.js";
import {
  initQueueMaintenance,
  stopQueueMaintenance,
} from "./queue-maintenance.js";
import { flushHistoryPersist } from "./play-history.js";
import { flushLyricsPersist } from "./lyrics.js";
import { flushReactionsPersist } from "./reactions.js";
import { flushOriginPersist } from "./queue-origin.js";
import { flushRequestsPersist } from "./request-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// From here on, every console.* call (legacy call sites and dependencies
// alike) is redacted and honors LOG_FORMAT=json.
installConsoleBridge();

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const log = createLogger("server");
const httpLog = log.child("http");
const ACCESS_LOG_SKIP = new Set(["/api/health", "/api/ready"]);

// Read once at boot so the UI can show which build is running.
let VERSION = "";
try {
  VERSION = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  ).version;
} catch {
  /* version stays blank if package.json can't be read */
}

const SHUTDOWN_TIMEOUT_MS = 5_000;
let httpServer = null;
let shuttingDown = false;
let signalHandlersRegistered = false;
/** @type {(code?: number) => void} */
let exitProcess = (code = 0) => process.exit(code);

// Correlate API work across Unraid/Docker logs without a heavy framework.
app.use((req, res, next) => {
  const incoming = String(req.get("x-request-id") || "").trim();
  const requestId =
    incoming && incoming.length <= 64
      ? incoming
      : crypto.randomBytes(8).toString("hex");
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const started = Date.now();
  res.on("finish", () => {
    const pathOnly = req.path || "";
    if (!pathOnly.startsWith("/api/") || ACCESS_LOG_SKIP.has(pathOnly)) return;
    httpLog.info("request", {
      requestId,
      method: req.method,
      path: pathOnly,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

// Last-line response guard: no API error may return a credential pattern even
// when an upstream library embeds one in Error.message.
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && typeof body.error === "string") {
      return sendJson({ ...body, error: redactString(body.error) });
    }
    return sendJson(body);
  };
  next();
});

// Baseline security headers on every response. Content types are always set
// explicitly (static by extension, JSON by express), so nosniff is safe.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// DNS-rebinding guard: API/auth requests must carry a LAN-plausible Host.
app.use(["/api", "/auth"], hostGuard);

// Block cross-site state-changing requests (CSRF / DNS-rebinding against this
// LAN service). Same-origin app calls always match. Requests with no Origin
// (curl, OAuth callback, non-browser clients) are left alone.
app.use((req, res, next) => {
  if (req.method !== "POST" && req.method !== "DELETE") return next();
  const origin = req.get("origin");
  if (!origin) return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return res.status(403).json({ error: "Bad origin." });
  }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  next();
});

// Default JSON parser for normal API calls. Banner / DJ-icon upload routes
// carry a base64 image, so they opt into a larger limit in the route module.
const jsonParser = express.json();
app.use((req, res, next) => {
  if (
    req.method === "POST" &&
    (req.path === "/api/banners" || req.path === "/api/dj-icon")
  ) {
    return next();
  }
  return jsonParser(req, res, next);
});

// Inject saved branding JSON into index.html before first paint.
const INDEX_HTML_PATH = path.join(__dirname, "..", "public", "index.html");

// Template cache: a cheap async stat per request instead of re-reading ~100 KB
// of HTML for every page load (and twice on the error path). mtime validation
// keeps local-dev edits visible without a restart. Async so cold loads do not
// block the event loop on sync disk I/O.
let indexTemplateCache = null; // { html, mtimeMs }
async function indexTemplate() {
  const { mtimeMs } = await fs.promises.stat(INDEX_HTML_PATH);
  if (!indexTemplateCache || indexTemplateCache.mtimeMs !== mtimeMs) {
    indexTemplateCache = {
      html: await fs.promises.readFile(INDEX_HTML_PATH, "utf8"),
      mtimeMs,
    };
  }
  return indexTemplateCache.html;
}

// Per-request script nonce: inline scripts in index.html carry
// nonce="__PQ_NONCE__", so only markup we templated ourselves can execute.
// Spotify CDNs are allowed for search-result and playlist artwork; media
// stays open because DJ voice previews may use the PUBLIC_BASE_URL host.
function indexCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.scdn.co https://*.spotifycdn.com",
    "media-src 'self' http: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

async function renderIndexHtml(brandJson) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = (await indexTemplate())
    .replaceAll("__PQ_BRAND_JSON__", brandJson)
    .replaceAll("__PQ_NONCE__", nonce);
  return { html, nonce };
}

async function sendBrandedIndex(_req, res) {
  try {
    const { eventName, subtitle, heroBanner, showVersion, showQueueGenre } =
      getBrandingSettings();
    const brandJson = JSON.stringify({
      eventName,
      subtitle: subtitle ?? "",
      heroBanner: heroBanner || null,
      version: VERSION || "",
      showVersion: !!showVersion,
      showQueueGenre: !!showQueueGenre,
    }).replace(/</g, "\\u003c");
    const { html, nonce } = await renderIndexHtml(brandJson);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Security-Policy", indexCsp(nonce));
    res.type("html").send(html);
  } catch (err) {
    console.error("[index] brand inject failed:", err.message);
    try {
      const { html, nonce } = await renderIndexHtml("null");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Security-Policy", indexCsp(nonce));
      return res.type("html").send(html);
    } catch {
      res.sendFile(INDEX_HTML_PATH);
    }
  }
}
const brandedIndex = asyncHandler(sendBrandedIndex);
brandedIndex.displayName = "sendBrandedIndex";
app.get(["/", "/index.html"], brandedIndex);

// App code (HTML/CSS/JS) stays "no-cache" so deploys reach guests immediately
// (cheap 304 revalidations). Images and vendored libs rarely change and cost
// each phone real transfer time on party Wi-Fi, so they get a day of cache.
const STATIC_IMAGE_RE = /\.(png|jpe?g|webp|gif|ico|svg)$/i;
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    index: false,
    setHeaders: (res, filePath) => {
      const longLived =
        STATIC_IMAGE_RE.test(filePath) || /[\\/]vendor[\\/]/.test(filePath);
      res.setHeader(
        "Cache-Control",
        longLived ? "public, max-age=86400" : "no-cache"
      );
    },
  })
);
// Uploaded banners/DJ icons get random filenames, so cached copies can never
// go stale under the same URL — cache them for a week.
app.use(
  "/banners",
  express.static(path.join(__dirname, "..", "data", "banners"), {
    setHeaders: (res) =>
      res.setHeader("Cache-Control", "public, max-age=604800"),
  })
);
app.get("/banner", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  const name = getBrandingSettings().heroBanner;
  if (name && bannerExists(name)) {
    const file = bannerPath(name);
    if (file) return res.sendFile(file);
  }
  return res.sendFile(path.join(__dirname, "..", "public", "hero.jpg"));
});
app.use(
  "/dj-icon",
  express.static(path.join(__dirname, "..", "data", "dj-icons"), {
    setHeaders: (res) =>
      res.setHeader("Cache-Control", "public, max-age=604800"),
  })
);
app.use(
  "/media/tts",
  express.static(path.join(__dirname, "..", "data", "tts"), {
    fallthrough: false,
    setHeaders(res) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

const queueBurstLimit = softRateLimit({
  windowMs: 10_000,
  max: 3,
  message: "Easy on the requests — wait a few seconds and try again.",
});
const queueSustainedLimit = softRateLimit({
  windowMs: 5 * 60_000,
  max: 20,
  message: "Request limit reached — try again in a few minutes.",
});
const destructiveLimit = softRateLimit({
  windowMs: 2500,
  max: 2,
  message: "Slow down — try again in a moment.",
});
const transportLimit = softRateLimit({
  windowMs: 800,
  max: 4,
  message: "Easy on the controls — try again in a moment.",
});
// Guest search is client-debounced (~300ms); stay generous for shared NAT
// (many phones, one public IP) while still capping Spotify spam.
const searchLimit = softRateLimit({
  windowMs: 10_000,
  max: 20,
  message: "Search is cooling down — try again in a moment.",
});
// Tag the limiter closures so the route-table parity test (and debuggers) can
// tell them apart — they all share the internal name "rateLimitMiddleware".
queueBurstLimit.displayName = "queueBurstLimit";
queueSustainedLimit.displayName = "queueSustainedLimit";
destructiveLimit.displayName = "destructiveLimit";
transportLimit.displayName = "transportLimit";
searchLimit.displayName = "searchLimit";

registerNowPlayingRoutes(app);
registerQueueStreamRoutes(app);
registerApiRoutes(app, {
  VERSION,
  isListening: () => !!httpServer?.listening,
  isShuttingDown: () => shuttingDown,
  queueBurstLimit,
  queueSustainedLimit,
  destructiveLimit,
  transportLimit,
  searchLimit,
  requestShutdown: (opts) => {
    void shutdownServer(opts);
  },
});

// Terminal error handler: sync throws and next(err) become JSON instead of
// Express's default HTML error page. (Async rejections are converted upstream
// by asyncHandler.) The res.json wrapper above redacts credential patterns.
// Express requires the 4-arg signature to treat this as an error handler.
app.use((err, req, res, _next) => {
  httpLog.error("unhandled route error", {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    err,
  });
  if (res.headersSent) return res.end();
  const status = Number(err?.statusCode || err?.status);
  const safe =
    Number.isFinite(status) && status >= 400 && status < 600 ? status : 500;
  res.status(safe).json({ error: err?.message || "Internal server error." });
});

function flushShutdownStores() {
  for (const [name, flush] of [
    ["history", flushHistoryPersist],
    ["genres", flushGenrePersist],
    ["lyrics", flushLyricsPersist],
    ["reactions", flushReactionsPersist],
    ["queue-origin", flushOriginPersist],
    ["requests", flushRequestsPersist],
  ]) {
    try {
      flush();
    } catch (err) {
      log.error(`${name} flush failed`, { err });
    }
  }
}

/**
 * Importable Express app + runtime handles for HTTP tests.
 * Building routes still happens at module load; this does not bind a port.
 */
export function createApp() {
  return {
    app,
    nowPlayingMonitor,
    queueMonitor,
    get listening() {
      return !!httpServer?.listening;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  };
}

function registerSignalHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      void shutdownServer({ reason: signal });
    });
  }
  // Keep the music playing: a stray unhandled rejection would otherwise kill
  // the process on Node 20+. Log it loudly instead. Uncaught synchronous
  // exceptions still crash (state may be corrupt; Docker restarts us).
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", {
      event: "unhandled-rejection",
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
}

function runListenStartup({ seed = true, warm = true } = {}) {
  log.info(
    `PartyQueue running on http://0.0.0.0:${httpServer.address()?.port || PORT}`
  );
  if (!isHostPinConfigured()) {
    ensureHostBootstrapCode();
    log.info(
      `First-time host setup code stored in data/${hostBootstrapFileName()} ` +
        "(expires in 2 hours; restart to issue a new code)",
      { event: "setup-code" }
    );
  }
  if (seed) {
    seedStarterDjIcons();
    seedStarterBanners();
    import("./dj-voice.js")
      .then(({ getPublicBaseUrl, ensureSilenceBridge, ensureSilenceRamp }) => {
        log.info(`Sonos media base ${getPublicBaseUrl()}`, { event: "dj-voice" });
        try {
          const bridge = ensureSilenceBridge();
          const ramp = ensureSilenceRamp();
          log.info(`silence restore ready → ${bridge.publicUrl}`, {
            event: "dj-voice",
          });
          log.info(`silence ramp ready → ${ramp.publicUrl}`, {
            event: "dj-voice",
          });
        } catch (err) {
          log.warn(`silence pads not ready: ${err.message}`, {
            event: "dj-voice",
          });
        }
      })
      .catch((err) => {
        log.warn(`PUBLIC_BASE_URL not ready: ${err.message}`, {
          event: "dj-voice",
        });
      });
  }
  if (warm) {
    // Discover starts ON for every deploy/restart. The host can still turn it
    // off for the night; it simply re-arms the next time the container starts.
    try {
      setDiscoverySettings({ discoverEnabled: true });
    } catch (err) {
      log.warn(`could not re-arm Discover: ${err.message}`, { event: "startup" });
    }
    warmTrackPool().then(() => warmGenresFromPool());
    startPoolRewarmLoop();
    initAutoFill();
    initQueueMaintenance();
  }
}

/**
 * Bind HTTP and optionally start background party monitors.
 * @param {{
 *   port?: number,
 *   host?: string,
 *   signals?: boolean,
 *   seed?: boolean,
 *   warm?: boolean,
 *   exit?: (code?: number) => void,
 * }} [options]
 */
export function startServer(options = {}) {
  if (httpServer?.listening) {
    return {
      app,
      httpServer,
      port: httpServer.address()?.port,
      nowPlayingMonitor,
      queueMonitor,
    };
  }
  shuttingDown = false;
  if (typeof options.exit === "function") exitProcess = options.exit;
  else exitProcess = (code = 0) => process.exit(code);

  const port = Number(options.port ?? PORT) || 0;
  const host = options.host || "0.0.0.0";
  if (options.signals !== false) registerSignalHandlers();

  httpServer = app.listen(port, host, () => {
    runListenStartup({
      seed: options.seed !== false,
      warm: options.warm !== false,
    });
  });
  httpServer.on("error", (err) => {
    log.error(`listen failed: ${err.message}`, { event: "listen" });
  });

  return {
    app,
    httpServer,
    get port() {
      const addr = httpServer?.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    nowPlayingMonitor,
    queueMonitor,
  };
}

/**
 * Stop monitors, close HTTP, flush stores. Tests should pass `{ exit: false }`.
 * @param {{
 *   reason?: string,
 *   restart?: boolean,
 *   exit?: boolean,
 * }} [options]
 */
export async function shutdownServer({
  reason = "shutdown",
  restart = false,
  exit = true,
} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(reason, { event: "shutdown" });

  const forceExit = setTimeout(() => {
    log.error("timed out; forcing exit", { event: "shutdown" });
    if (exit) exitProcess(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref?.();

  stopGenreWarm();
  closeNowPlayingStreams();
  closeQueueStreams();
  const pendingShutdown = [
    stopAutoFillMonitor(),
    stopQueueMaintenance(),
    nowPlayingMonitor.stop(),
    queueMonitor.stop(),
  ];

  if (httpServer?.listening) {
    pendingShutdown.push(
      new Promise((resolve) => {
        httpServer.close((err) => {
          if (err) {
            log.error("server close failed", { event: "shutdown", err });
          }
          resolve();
        });
        httpServer.closeIdleConnections?.();
      })
    );
  }

  await Promise.allSettled(pendingShutdown);
  flushShutdownStores();
  httpServer = null;

  if (restart) {
    try {
      const inDocker = fs.existsSync("/.dockerenv");
      if (!inDocker) {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "ignore",
          cwd: process.cwd(),
          env: process.env,
          windowsHide: true,
        });
        child.unref();
        log.info(`spawned pid ${child.pid}`, { event: "restart" });
      } else {
        log.info("exiting for Docker restart policy", { event: "restart" });
      }
    } catch (err) {
      log.error("spawn failed", { event: "restart", err });
    }
  }

  clearTimeout(forceExit);
  if (exit) exitProcess(0);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startServer();
}
