# PartyQueue

**Version:** 6.7.0 (tracked in `package.json`)

A LAN party app for Sonos: guests open it on their phones, search Spotify, and
add songs to **your** queue. Playback controls, Random, and Music Mix are on the
LAN so anyone at the party can help run the night.

**License:** [MIT](LICENSE). Not affiliated with, endorsed by, or supported by
Sonos or Spotify. You must use your own
[Spotify Developer](https://developer.spotify.com/dashboard) app and a
**Spotify Premium** account, and you are responsible for complying with their
terms. Intended for **personal use on a trusted home LAN** — do not expose it to
the public internet.

---

## Quick start (minimum path)

1. **Requirements:** Spotify Premium, PartyQueue on the **same Wi‑Fi/LAN** as
   your Sonos, Spotify already added as a music service in the Sonos app.
2. **Create a Spotify app** (one time) — see [Spotify Developer app](#spotify-developer-app).
3. **Run** PartyQueue ([locally](#run-locally) or [Unraid/Docker](#run-on-unraid-docker)).
4. Open **DJ Booth → Settings → Connections**, paste Client ID / Secret /
   Redirect URI / Market, Save, then **Test**.
5. On a phone on the same network, open `http://<host-ip>:<PORT>`, search, tap
   **Add**. That starts (or extends) the queue — you do **not** need music
   playing in Sonos first.
6. Optional next: turn on **Never-Ending** / use **Random**, set a
   [host PIN](#host-pin), connect your playlists, Last.fm, or DJ Voice.

---

## How it works

- **Spotify search** uses an app-level token (Client Credentials). Guests never
  log in and never touch your Spotify account.
- **Queue adds** talk to Sonos on your LAN (append / insert — not “replace
  everything and hijack the house” by default).
- Spotify must already be a music service in your Sonos system.
- **Now Playing** uses a demand-driven Server-Sent Events stream. While at least
  one guest is viewing the main page, the server takes at most one shared Sonos
  snapshot every 1.5 seconds, regardless of guest count, and broadcasts
  meaningful changes. With no active viewers the stream poller stops entirely.
  Queue and group lists remain on a conservative 5-second browser refresh, and
  browsers fall back to `/api/nowplaying` every 15 seconds if streaming fails.
  After repeated Sonos read failures, clients mark the last snapshot as stale
  and clear the warning automatically when Sonos recovers.

**Optional host PIN:** set it under **DJ Booth → Settings → Connections → Host
PIN** (stored hashed on the server), or use `SETTINGS_PIN` in `.env`. On a fresh
install, enter the six-digit setup code printed in the PartyQueue server or
Unraid logs before choosing the first PIN; it expires after two hours, and a
restart issues a new one. The PIN locks the **DJ Booth** UI and host-only APIs
(settings, credentials, resets, restart, guest admin, uploads). Party controls
remain open by default; **Music Mix → Host-only controls** can also require the
PIN for playback, queue editing, and Sonos grouping. Random requests remain
available to guests. The server also rejects cross-site browser requests so a
random website can’t quietly poke your queue.

---

## Spotify Developer app

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. **Create app**. Name/description can be anything.
3. Under **Redirect URIs**, add the callback you’ll use for the one-time
   playlist login, e.g. `http://127.0.0.1:8080/auth/callback`. (Spotify allows
   loopback without HTTPS.) Save.
4. Copy **Client ID** and **Client Secret** into PartyQueue
   (**DJ Booth → Settings → Connections**) or into `.env` for Docker.

---

## Run locally

Requires Node.js 20+.

```bash
npm ci
cp .env.example .env   # optional Sonos/PORT; APIs can go in Settings
npm start
```

Then open **DJ Booth → Settings → Connections** and enter Spotify (and
optionally Last.fm / Home Assistant).

Open `http://<your-computer-ip>:<PORT>` on your phone (same Wi‑Fi). Default
`PORT` in `.env.example` is `8080`. Use `/api/health` for a quick liveness check
(process up + version). Use `/api/rooms` to confirm Sonos discovery.

---

## Run on Unraid (Docker)

Sonos uses multicast (SSDP) discovery, which does **not** work over Docker’s
default bridge network. Use **host networking**.

### Compose (recommended)

Copy the project (or a [share zip](#sharing-this-project)) onto the server,
create a `.env` from `.env.example`, then:

```bash
cd /mnt/user/appdata/PartyQueue
docker compose build --no-cache && docker compose up -d
```

The included `docker-compose.yml` sets `network_mode: host` and mounts
`./data:/app/data`. The app is reachable at `http://<unraid-ip>:<PORT>`
(default `8080` unless you change `PORT`). Image builds use the committed npm
lockfile, so rebuilds install the same dependency versions.

After code updates, use the same rebuild command so you’re not served a stale
image layer. Docker stop/restart signals are handled gracefully: PartyQueue
stops its background monitors, flushes pending history and genre-cache writes,
and then exits for the container restart policy. The image includes a
`HEALTHCHECK` against `/api/health`. For stricter orchestration use
`/api/ready` (503 while the HTTP server is down or shutting down; Sonos and
Spotify are reported as checks, not hard requirements).

### Manual “Add Container”

1. **Docker** tab → **Add Container**.
2. **Network Type:** `Host`.
3. Build first (`docker build -t partyqueue .`) or point at your image.
4. Add env vars as needed (`SPOTIFY_*`, `SONOS_REGION`, `SONOS_HOST`, `PORT`, …).
5. Persist `data/` if you use Settings-stored credentials.

> **Tip:** If discovery is flaky even with host networking, give a speaker a
> DHCP reservation and set `SONOS_HOST` to that IP.

---

## Configure

### Credentials (preferred: in the app)

**DJ Booth → Settings → Connections:**

| Section | What to enter | Stored in (gitignored) |
|---------|---------------|------------------------|
| **Host PIN** | Optional booth / host-API lock | `data/host-pin.json` (hashed) |
| **Sonos** | Speaker IP + room name (when discovery fails) | `data/sonos.json` |
| **Spotify** | Client ID, Secret, Redirect URI, Market | `data/spotify-app.json` |
| **Last.fm** | API key (genres + Discover) | `data/lastfm.json` |
| **Home Assistant** | URL + long-lived token (DJ Voice) | `data/home-assistant.json` |

Secrets are never returned to the browser after save and are **not** included in
the share zip.

### `.env` (Sonos / server / Docker)

Copy from `.env.example`. Common keys:

```
SONOS_REGION=NorthAmerica      # or "EU"
SONOS_ROOM=                    # optional, e.g. "Living Room"
SONOS_HOST=                    # optional speaker IP (recommended on Docker)
PORT=8080
PUBLIC_BASE_URL=               # Docker: http://YOUR_UNRAID_IP:8080 (example)
SETTINGS_PIN=                  # optional bootstrap; prefer Host PIN in the UI
```

For Docker/Unraid you can also set `SPOTIFY_*`, `LASTFM_API_KEY`, `HA_URL`, and
`HA_TOKEN` in `.env`; env values override the JSON files.

- **SONOS_ROOM** — blank = first group coordinator; or a room name for that group.
- **SONOS_HOST** — blank = SSDP discovery; pin an IP if discovery is flaky.
- **Redirect URI** — must match the Spotify Developer app exactly (playlist login).

### Your playlists (one-time login)

Guest search needs no login. To use **your** playlists (including private ones):

1. **Music Mix → Playlists** (or Connect Spotify where shown) and approve access.
2. Do that on the machine running the app so a `127.0.0.1` redirect resolves.
3. Refresh token lands in `data/spotify-tokens.json` (or set
   `SPOTIFY_REFRESH_TOKEN` in Docker `.env`).

### Last.fm (optional)

Genre filters and Discover Similar. Free key:
[last.fm/api/account/create](https://www.last.fm/api/account/create) →
**DJ Booth → Settings → Connections → Last.fm** → Test.

### Home Assistant + DJ Voice (optional)

Announcements on Sonos via Home Assistant TTS (ElevenLabs or OpenAI):

1. **DJ Booth → Settings → Connections → Home Assistant** — URL + long-lived
   token → Test.
2. In HA, add **ElevenLabs** (or OpenAI TTS). PartyQueue calls `tts_get_url` on
   `tts.elevenlabs_text_to_speech` or `tts.openai_tts_2`.
3. **DJ Booth → Settings → DJ** — provider, voice, character → Test.
4. Enable **DJ Voice** in those DJ settings (and shouts if you want request
   shout-outs).
5. Pick your Sonos group in the app. PartyQueue maps the room to
   `media_player.sonos_<room>` for HA.

The Docker image includes `ffmpeg`, which PartyQueue uses to apply non-default
OpenAI TTS speed locally. Local Windows/macOS/Linux installs need `ffmpeg` on
`PATH` (or `FFMPEG_PATH`) only when a non-1× speed is selected.

Every queued announcement uses a fixed handoff: a 3-second pre-silence pad
smoothly raises the current group volume, the DJ clip plays, then a matching
3-second post-silence pad returns every speaker to the exact pre-DJ level before
music continues. Volume and mute buttons are temporarily locked during that
critical handoff so the saved baseline cannot drift.

**When it speaks**

- **Fresh set** — Random while nothing is playing: announce, then music.
- **Never-Ending refill** — announce when playback crosses into the new batch.

HA token: profile → **Long-lived access tokens** → Create → paste into PartyQueue.

---

## Using it at a party

1. Share `http://<host-ip>:<PORT>` (Join QR in the app helps). Same Wi‑Fi as Sonos.
2. Guests set a name if prompted, search, tap **Add**. An empty queue is fine —
   the first add (or **Random**) starts the night.
3. **Random** draws from playlists/genres in **Music Mix**. **Never-Ending**
   tops up while music is already playing from the queue and running low — it
   will **not** seed an empty idle queue after boot, Stop, or Clear.
4. **Controls** — play/pause, skip, volume, clear (with confirm), etc.
5. **Edit** on the queue — delete / drag-reorder when you need it; off by default.
6. **Last call:** hand-adding the **End of night song** (default: Closing Time
   by Semisonic — change it under **DJ Booth → Settings → DJ → Last call**)
   turns off Never-Ending and shows a last-call toast. Optional **Party
   Summary** has the DJ speak a short recap before that song (needs DJ Voice).

Host tools (credentials, Users, Reset, Restart, branding) live under **DJ Booth**
(PIN-gated when configured). Stats, Sonos Group, and Music Mix are on the
toolbar.

---

## Sharing this project

`.env` and `data/` are gitignored. For a **share-safe** zip (no secrets):

```bash
npm run package:share
```

Writes something like `PartyQueue-share-v<version>-….zip` under
`PartyQueue-backups/`. Includes the MIT `LICENSE`. Recipients configure APIs in
Settings after install. **Do not** zip the install folder by hand.

---

## Endpoints

| Method | Path                   | Purpose                                       |
| ------ | ---------------------- | --------------------------------------------- |
| GET    | `/api/health`          | Liveness + version + Spotify-configured flag  |
| GET    | `/api/ready`           | Readiness for orchestrators (503 if stopping) |
| GET    | `/api/rooms`           | List Sonos rooms PartyQueue can see           |
| GET    | `/api/nowplaying/stream` | Shared live Now Playing event stream         |
| GET    | `/api/search`          | `?q=` Spotify track search                    |
| POST   | `/api/queue`           | `{ "uri": "spotify:track:..." }` append (limited) |
| POST   | `/api/queue/playlist`  | `{ "uri": "spotify:playlist:..." }` append    |
| POST   | `/api/queue/random`    | `{ "count", "playlistIds" }` add random songs |
| POST   | `/api/queue/remove`    | `{ "uri", "position" }` remove a queued song  |
| POST   | `/api/queue/reorder`   | `{ "uri", "beforeUri", ... }` move a song     |
| GET    | `/api/playlists`       | Host playlists (after Connect Spotify)        |
| GET    | `/api/autofill`        | `{ enabled }` — Never-Ending state            |
| POST   | `/api/autofill`        | `{ enabled, playlistIds }` toggle refill      |
| GET    | `/api/auth/status`     | `{ connected }` — Spotify user linked         |
| GET    | `/auth/login`          | One-time host Spotify login (PIN if set)      |

Guest song adds remain open on the LAN. To prevent accidental double-taps and
queue floods, `/api/queue` allows three adds per source IP in 10 seconds and 20
adds in five minutes. A limited request returns `429`, `Retry-After`, and a
JSON `retryMs` value; normal playback and queue permissions are unchanged.

---

## Tests and CI

Run the complete Node 20 test suite with `npm test`. That includes an in-process
HTTP harness (`createApp` / `startServer` / `shutdownServer`) covering liveness,
readiness, CSRF rejection, and request IDs — without binding the production
port or starting Spotify/Sonos warmers. GitHub Actions runs the locked install
and tests on Linux and Windows for pushes and pull requests, and audits
production dependencies on Linux. Sonos/Home Assistant smoke scripts remain
manual because they control real hardware.

### Logging

By default PartyQueue logs human-readable tagged lines (`[server]`, `[http]`,
`[dj-voice]`, …). Set `LOG_FORMAT=json` for one JSON object per line. API
responses include `X-Request-Id` (echoed from the request header when provided)
so Unraid/Docker logs can be correlated with a browser session.

---

## Troubleshooting

- **"No Sonos devices found"** — under **DJ Booth → Settings → Connections → Sonos**,
  pin a speaker IP (or set `SONOS_HOST`). On Docker, use host networking.
- **Song adds but won’t play / unavailable** — Spotify service on Sonos + Premium;
  try `SONOS_REGION` `NorthAmerica` vs `EU`.
- **Search returns nothing** — check Client ID/Secret and `SPOTIFY_MARKET`.
- **Host actions 401 / DJ Booth locked** — unlock with your PIN, or set one under
  Connections if you haven’t yet.
- **Music came back after Clear** — upgrade to a build that only Never-Ending
  refills while playback is already on the queue (empty idle queues stay quiet).
