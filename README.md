# PartyQueue

**Version 10.9.6**

PartyQueue lets everyone at your party help choose the music. Guests open a
web page on their phones, search Spotify, and add songs to your Sonos queue.
There is no app to install on their phones and guests do not need to sign in to
Spotify.

PartyQueue is designed for **personal use on a trusted home LAN**. Do not expose
it directly on the public internet. Guest search, queue adds, and many party
controls are intentionally open so phones on your Wi‑Fi can join without
accounts.

## What you need

Before you begin, make sure you have:

- A Sonos system with Spotify already added as a music service
- A Spotify Premium account
- A free Spotify Developer app (instructions below)
- A computer or Unraid server that stays on during the party
- All phones, Sonos speakers, and PartyQueue on the same home network
  (or across VLANs if you run a multicast relay so Sonos discovery still works)

Last.fm, Home Assistant, and DJ Voice are optional. You can add them later.

## Setup at a glance

1. [Create a Spotify Developer app](#1-create-a-spotify-developer-app).
2. [Install and start PartyQueue](#2-install-partyqueue).
3. Open PartyQueue in a browser.
4. Go to **DJ Booth → Connections**.
5. Enter your Spotify details, save them, and select **Test**.
6. Open PartyQueue on a phone and add a song.

You do not need to start music in the Sonos app first. Adding the first song
from PartyQueue will create and start the queue.

## 1. Create a Spotify Developer app

This is a one-time setup. It gives PartyQueue permission to search Spotify.
Your guests never see these credentials and never access your Spotify account.

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and sign in.
2. Select **Create app**. The app name and description can be anything.
3. Add this Redirect URI:

   `http://127.0.0.1:8080/auth/callback`

   If you change PartyQueue's port from `8080`, use that same port here.
4. Save the Spotify app.
5. Copy its **Client ID** and **Client Secret**. You will enter both in
   PartyQueue after it starts.

The Redirect URI in Spotify and PartyQueue must match exactly.

## 2. Install PartyQueue

Choose the setup that matches your system.

### Unraid or another Docker server

Copy the PartyQueue folder to `/mnt/user/appdata/PartyQueue`. In that folder,
make a copy of `.env.example` named `.env`.

Then open an Unraid terminal and run:

```bash
cd /mnt/user/appdata/PartyQueue
docker compose build --no-cache && docker compose up -d
```

Open PartyQueue at:

`http://YOUR_UNRAID_IP:8080`

Replace `YOUR_UNRAID_IP` with the address of your Unraid server. If you set a
different `PORT` in `.env` (for example `8088`), use that port instead.

The included Docker setup uses host networking because Sonos discovery usually
does not work through Docker's normal bridge network. It also stores your
settings in the local `data` folder so they survive updates.

Use the same two-line command after downloading a PartyQueue update. Maintainers
with the Windows deploy script can instead run `npm run deploy:unraid` from a
dev machine after committing.

### Windows, macOS, or Linux

Install [Node.js 20 or newer](https://nodejs.org/), open a terminal in the
PartyQueue folder, and run:

```bash
npm ci
npm start
```

The `.env` file is optional for a local install because most settings can be
entered in PartyQueue.

Open `http://localhost:8080` on that computer. On another phone or computer,
use the PartyQueue computer's network address, for example:

`http://192.168.1.50:8080`

## 3. Finish first-time setup

Open **DJ Booth → Connections**.

### Spotify (required)

Enter:

- **Client ID** — copied from your Spotify Developer app
- **Client Secret** — copied from your Spotify Developer app
- **Redirect URI** — normally `http://127.0.0.1:8080/auth/callback`
- **Market** — your two-letter country code, such as `US`, `CA`, or `GB`

Select **Save**, then **Test**.

### Sonos

PartyQueue normally finds Sonos automatically. If it does not:

1. Open **DJ Booth → Connections → Sonos**.
2. Enter the IP address of one Sonos speaker.
3. Optionally enter the room you want PartyQueue to control.
4. Save and test again.

Giving that speaker a reserved IP address in your router will prevent the
address from changing later.

### Host PIN (recommended)

A Host PIN protects settings, credentials, resets, uploads, and other DJ Booth
tools.

On a new install:

1. Open **DJ Booth → Connections → Host PIN**.
2. Find the temporary six-digit setup code in
   `data/host-bootstrap-code.json`.
3. Enter that setup code and choose your Host PIN.

The temporary code expires after two hours and is deleted after setup. Restart
PartyQueue to create a new code if it expires.

Party controls stay open to guests unless you also enable **Host-only
controls** in DJ Booth.

### Public URL (Docker / Unraid)

Set `PUBLIC_BASE_URL` in `.env` to the LAN address Sonos and phones use, for
example `http://YOUR_UNRAID_IP:8080`. PartyQueue uses it for:

- Silence / DJ Voice media URLs Sonos must fetch
- The Join QR code
- Stricter Origin checks on changing API requests (browsers already send Origin)

## How a night works

```text
  Host prep                Guests join              Keep it going
 ┌────────────┐          ┌──────────────┐         ┌─────────────────┐
 │ Start app  │          │ Scan Join QR │         │ Random / Never- │
 │ Unlock     │ ───────► │ Enter a name │ ───────►│ Ending feed the │
 │ Booth      │          │ Search → Add │         │ queue           │
 │ Set Vibe   │          └──────────────┘         └────────┬────────┘
 └────────────┘                                            │
                                                           ▼
                                              Optional: DJ Voice shouts,
                                              Set Request, fairness caps,
                                              Loved/Hated sets, dedications,
                                              Party Display on a TV
                                                           │
                                                           ▼
                                              Last call → Closing Time
                                              (Never-Ending stops)
                                                           │
                                                           ▼
                                              Clear / Party Over when done
```

1. **Prep** — Start PartyQueue, unlock the Booth with your Host PIN, pick Vibe
   (mood / genres / playlists), and turn on Never-Ending if you want automatic
   fills.
2. **Join** — Share the Join QR or LAN URL. Guests pick a display name, search
   Spotify, and add songs. Quotas (if enabled) show how many requests they have
   left.
3. **Run the room** — Use play / pause / skip / volume on the main page. Random
   adds a fresh batch; Never-Ending tops up while music is playing from the
   queue. Same-artist showcase batches and Most Requested / Most Loved /
   Most Hated sets are optional in the Booth.
4. **Extras** — DJ Voice can announce requests and refills. Guests can dedicate
   songs from Up Next. Party Display (`#/display`) is meant for a TV or Fully
   Kiosk Browser. Stats stay on the main toolbar.
5. **Last call** — When Closing Time (or your configured last song) is added,
   Never-Ending stops so the night can wind down. Clear the queue or use Party
   Over when you are finished. Use **New party** in the Booth header to clear
   shout memory, fairness, and crowd-set memory before the next gathering.

Useful music tools:

- **Random** adds a fresh group of songs from your selected music.
- **Never-Ending** adds more music when the active queue is running low. It
  will not restart an empty queue after Stop or Clear.
- **Vibe** controls which playlists and genres Random can use.
- **Edit queue** lets you remove or rearrange songs. It is off by default.
- **Request fairness** can limit how many songs or sets one person adds. It is
  off by default; guests see remaining quota when it is on.
- **Most Requested / Most Loved / Most Hated sets** (optional) insert short
  crowd mini-sets on a shared once-per-X cadence when 5 songs have 5+
  requests or reactions. Each flavor has its own Booth toggle.
- **Last call** stops Never-Ending when the configured final song is added.
  The default final song is “Closing Time” by Semisonic.

Host tools live under **DJ Booth**: toggles on the Booth home page, plus hub
cards for Look, Queue, DJ, Users, Connections, Memory, Suggestions, and Reset.
**Look** covers the party title and separate Desktop / Phone hero banners
(phones stack the banner above the title; desktop uses the wide overlay).
**Tools** on the main page covers Join QR, Party Display, and related guest
helpers. Stats, Sonos groups, and Vibe are on the main toolbar.

## Network and security posture

PartyQueue assumes every device on your Wi‑Fi is a guest you invited.

| Surface | Default |
| --- | --- |
| Song search, add, Now Playing, queue | Open on the LAN |
| Vibe / Never-Ending / many party toggles | Open on the LAN |
| DJ Booth, credentials, resets, uploads | Host PIN |
| Transport / Clear Queue | Open unless **Host-only controls** is on |

Do **not** port-forward PartyQueue or put it on a public reverse proxy. If you
must use a private reverse proxy (for example on the same LAN or a VPN):

- Keep the proxy off the public internet.
- Guests should open the same hostname and port that appear in
  `PUBLIC_BASE_URL`.
- Mutating API calls require a matching browser `Origin` when
  `PUBLIC_BASE_URL` is set.
- API `Host` headers must look like a LAN address, `*.local`, localhost, or a
  name listed in `PUBLIC_BASE_URL` / `PARTYQUEUE_ALLOWED_HOSTS` (DNS-rebinding
  guard). Add MagicDNS or other dotted private names there if you use them.
- PartyQueue is not a multi-tenant SaaS app: the `data` folder holds secrets in
  plain files on disk. Protect the host and the share.

## Your Spotify playlists (optional)

Basic song search works without linking your personal Spotify account. Link it
only if you want Random and Vibe to use your own playlists, including
private playlists.

1. Register PartyQueue's Redirect URI in your Spotify Developer app.
2. In PartyQueue, open **Vibe → Playlists**.
3. Select **Connect Spotify** and approve access.

PartyQueue saves a refresh token in `data/spotify-tokens.json`. Keep that file
private.

## Optional features

### Last.fm

Last.fm adds genre information and similar-song discovery.

1. Request a free key at
   [last.fm/api/account/create](https://www.last.fm/api/account/create).
2. Open **DJ Booth → Connections → Last.fm**.
3. Paste the key, save, and test.

### Home Assistant and DJ Voice

DJ Voice can make spoken announcements on Sonos through Home Assistant using
ElevenLabs or OpenAI TTS.

1. In Home Assistant, add the ElevenLabs or OpenAI TTS integration.
2. Create a Home Assistant long-lived access token from your profile.
3. In PartyQueue, open **DJ Booth → Connections → Home Assistant**.
4. Enter the Home Assistant URL and token, then select **Test**.
   The URL must be a private LAN / `.local` address, localhost, or HTTPS
   Nabu Casa unless you explicitly allow another public HTTPS host.
5. Open **DJ Booth → DJ**, choose the provider and voice, and test it.
6. Enable **DJ Voice** (and shout-outs / party summary if you want them) on the
   Booth home page.

During an announcement, PartyQueue temporarily adjusts the volume and then
returns every speaker to its exact previous level before music continues.

### Party Display

Open `#/display` from **Tools → Party Display**, or use `#/display?kiosk=1`
for Fully Kiosk Browser on a TV. The Booth **Party Display TV** section has a
copyable Fully start URL, preview controls, and idle dim so a kiosk screen is
not bright all night.

## Where settings are stored

Settings entered in PartyQueue are stored in the `data` folder. This includes
Spotify credentials, tokens, Home Assistant credentials, user notes, and your
Host PIN hash.

- Keep the `data` folder private.
- Unraid deploy stops the container (flushing debounced writes), archives
  `data/` under `/mnt/user/appdata/PartyQueue-backups/`, then rebuilds. It also
  tries a local SMB zip via `npm run backup:data`.
- Restore: stop PartyQueue, extract a `data-v…tar.gz` (or zip) into `data/`,
  `chown -R 1000:1000 data` on Unraid, start again.
- Never upload `data/` to GitHub or include it in a shared copy.
- Never share your `.env` file.

Saved secrets are not sent back to the browser after they are stored.

## Sharing a clean copy

Do not zip your working PartyQueue folder by hand because it may contain your
private settings.

On Windows, create a share-safe package with:

```bash
npm run package:share
```

The package is written to the nearby `PartyQueue-backups` folder. The packaging
script includes only approved project files and leaves out `data`, `.env`,
logs, diagnostics, and other private files.

## Troubleshooting

### PartyQueue cannot find Sonos

- Confirm PartyQueue and Sonos are on the same network.
- For Docker or Unraid, confirm the container uses host networking.
- Enter a speaker's IP address under **DJ Booth → Connections → Sonos**.
- Avoid guest Wi-Fi, VPNs, or network isolation between PartyQueue and Sonos.

### Search returns no songs

- Recheck the Spotify Client ID and Client Secret.
- Make sure the Market is a valid two-letter country code.
- Select **Test** in Spotify Connections.

### A song is found but will not play

- Confirm Spotify is added as a music service in the Sonos app.
- Confirm the Sonos account can use Spotify Premium.
- Try changing the Sonos region between `NorthAmerica` and `EU`.

### A phone cannot open PartyQueue

- Confirm the phone is on the same Wi-Fi.
- Use the computer or Unraid server's network IP, not `localhost`.
- Confirm the address includes the port (`PORT` in `.env`, default `:8080`).
- Check whether a firewall is blocking Node.js or that port.

### DJ Booth is locked

Enter your Host PIN. If you are setting the first PIN, use the temporary setup
code from `data/host-bootstrap-code.json`.

### Music returns after Clear

Update PartyQueue and rebuild the Docker image. Current versions only refill
while music is actively playing from the queue.

### Host not allowed / Origin required

- Open PartyQueue with the same host and port as `PUBLIC_BASE_URL`.
- For a private dotted hostname (MagicDNS, etc.), add it to
  `PARTYQUEUE_ALLOWED_HOSTS`.
- Smoke scripts and non-browser tools need an `Origin` header when
  `PUBLIC_BASE_URL` is set.

## Advanced configuration

Most people can skip this section.

To use environment settings, copy `.env.example` to `.env`. Values in `.env`
override settings saved through PartyQueue.

Common options:

```text
PORT=8080
SONOS_REGION=NorthAmerica
SONOS_ROOM=
SONOS_HOST=
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:8080
PARTYQUEUE_ALLOWED_HOSTS=
SETTINGS_PIN=
```

- `SONOS_ROOM` chooses a room or group coordinator.
- `SONOS_HOST` pins discovery to one speaker IP.
- `PUBLIC_BASE_URL` is the address Sonos uses to reach PartyQueue media, and
  enables Origin checks on mutating requests.
- `PARTYQUEUE_ALLOWED_HOSTS` lists extra dotted hostnames the API may accept
  (comma-separated).
- `SETTINGS_PIN` is an optional setup fallback; using the Host PIN screen is
  preferred.

Docker users can also configure Spotify, Last.fm, and Home Assistant in `.env`.
See `.env.example` for every available option.

## For developers

Run all automated tests:

```bash
npm test
```

GitHub Actions runs Node.js 22 on Linux and Windows (`npm test`), a Chromium
Playwright smoke suite, a Docker image build, and an `npm audit` of production
dependencies (high/critical). Hardware smoke tests are manual because they
control real Sonos and Home Assistant devices. Local development still supports
Node.js 20 or newer.

Useful health checks:

- `/api/health` — liveness only (process up + version)
- `/api/ready` — readiness: `ready` means listening with a writable `data/` volume; `partyReady` also requires Spotify credentials and Sonos connected/connecting or a configured speaker host. Unraid deploy waits for both. The Docker `HEALTHCHECK` and compose `autoheal` sibling use `/api/ready` (HTTP 200 = `ready`), not `partyReady`, so missing Spotify keys or a brief Sonos blip does not restart-loop the container
- `/api/rooms` — shows the Sonos rooms PartyQueue can find

PartyQueue uses the MIT license. It is not affiliated with or endorsed by
Sonos, Spotify, Last.fm, Home Assistant, ElevenLabs, or OpenAI. You are
responsible for following the terms of any connected service.
