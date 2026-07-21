# PartyQueue

**Version 7.0.0**

PartyQueue lets everyone at your party help choose the music. Guests open a
web page on their phones, search Spotify, and add songs to your Sonos queue.
There is no app to install on their phones and guests do not need to sign in to
Spotify.

PartyQueue is designed for personal use on a trusted home network. Do not make
it directly available on the public internet.

## What you need

Before you begin, make sure you have:

- A Sonos system with Spotify already added as a music service
- A Spotify Premium account
- A free Spotify Developer app (instructions below)
- A computer or Unraid server that stays on during the party
- All phones, Sonos speakers, and PartyQueue on the same home network

Last.fm, Home Assistant, and DJ Voice are optional. You can add them later.

## Setup at a glance

1. [Create a Spotify Developer app](#1-create-a-spotify-developer-app).
2. [Install and start PartyQueue](#2-install-partyqueue).
3. Open PartyQueue in a browser.
4. Go to **DJ Booth → Settings → Connections**.
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

Replace `YOUR_UNRAID_IP` with the address of your Unraid server.

The included Docker setup uses host networking because Sonos discovery usually
does not work through Docker's normal bridge network. It also stores your
settings in the local `data` folder so they survive updates.

Use the same two-line command after downloading a PartyQueue update.

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

Open **DJ Booth → Settings → Connections**.

### Spotify (required)

Enter:

- **Client ID** — copied from your Spotify Developer app
- **Client Secret** — copied from your Spotify Developer app
- **Redirect URI** — normally `http://127.0.0.1:8080/auth/callback`
- **Market** — your two-letter country code, such as `US`, `CA`, or `GB`

Select **Save**, then **Test**.

### Sonos

PartyQueue normally finds Sonos automatically. If it does not:

1. Open **Connections → Sonos**.
2. Enter the IP address of one Sonos speaker.
3. Optionally enter the room you want PartyQueue to control.
4. Save and test again.

Giving that speaker a reserved IP address in your router will prevent the
address from changing later.

### Host PIN (recommended)

A Host PIN protects settings, credentials, resets, uploads, and other DJ Booth
tools.

On a new install:

1. Open **Connections → Host PIN**.
2. Find the temporary six-digit setup code in
   `data/host-bootstrap-code.json`.
3. Enter that setup code and choose your Host PIN.

The temporary code expires after two hours and is deleted after setup. Restart
PartyQueue to create a new code if it expires.

Party controls stay open to guests unless you also enable **Host-only
controls** in Music Mix.

## Using PartyQueue at a party

1. Make sure guests are connected to the same Wi-Fi as PartyQueue and Sonos.
2. Open the **Join** QR code in PartyQueue, or share its web address.
3. Guests enter a name, search for a song, and select **Add**.
4. Use the main controls to play, pause, skip, change volume, or clear the
   queue.

Useful music tools:

- **Random** adds a fresh group of songs from your selected music.
- **Never-Ending** adds more music when the active queue is running low. It
  will not restart an empty queue after Stop or Clear.
- **Music Mix** controls which playlists and genres Random can use.
- **Edit queue** lets you remove or rearrange songs. It is off by default.
- **Request fairness** can limit how many songs one person adds after the
  shared request queue reaches a size you choose. It is off by default.
- **Last call** stops Never-Ending when the configured final song is added.
  The default final song is “Closing Time” by Semisonic.

Host settings, user notes, branding, connections, reset, and restart tools are
under **DJ Booth**. Stats, Sonos groups, and Music Mix are available from the
main toolbar.

## Your Spotify playlists (optional)

Basic song search works without linking your personal Spotify account. Link it
only if you want Random and Music Mix to use your own playlists, including
private playlists.

1. Register PartyQueue's Redirect URI in your Spotify Developer app.
2. In PartyQueue, open **Music Mix → Playlists**.
3. Select **Connect Spotify** and approve access.

PartyQueue saves a refresh token in `data/spotify-tokens.json`. Keep that file
private.

## Optional features

### Last.fm

Last.fm adds genre information and similar-song discovery.

1. Request a free key at
   [last.fm/api/account/create](https://www.last.fm/api/account/create).
2. Open **DJ Booth → Settings → Connections → Last.fm**.
3. Paste the key, save, and test.

### Home Assistant and DJ Voice

DJ Voice can make spoken announcements on Sonos through Home Assistant using
ElevenLabs or OpenAI TTS.

1. In Home Assistant, add the ElevenLabs or OpenAI TTS integration.
2. Create a Home Assistant long-lived access token from your profile.
3. In PartyQueue, open **Connections → Home Assistant**.
4. Enter the Home Assistant URL and token, then select **Test**.
5. Open **Settings → DJ**, choose the provider and voice, and test it.
6. Enable **DJ Voice** and any request shout-outs you want.

During an announcement, PartyQueue temporarily adjusts the volume and then
returns every speaker to its exact previous level before music continues.

## Where settings are stored

Settings entered in PartyQueue are stored in the `data` folder. This includes
Spotify credentials, tokens, Home Assistant credentials, user notes, and your
Host PIN hash.

- Keep the `data` folder private.
- Back it up if you want to preserve your setup.
- Never upload it to GitHub or include it in a shared copy.
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
- Enter a speaker's IP address under **Connections → Sonos**.
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
- Confirm the address includes the port, normally `:8080`.
- Check whether a firewall is blocking Node.js or port `8080`.

### DJ Booth is locked

Enter your Host PIN. If you are setting the first PIN, use the temporary setup
code from `data/host-bootstrap-code.json`.

### Music returns after Clear

Update PartyQueue and rebuild the Docker image. Current versions only refill
while music is actively playing from the queue.

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
SETTINGS_PIN=
```

- `SONOS_ROOM` chooses a room or group coordinator.
- `SONOS_HOST` pins discovery to one speaker IP.
- `PUBLIC_BASE_URL` is the address Sonos uses to reach PartyQueue media.
- `SETTINGS_PIN` is an optional setup fallback; using the Host PIN screen is
  preferred.

Docker users can also configure Spotify, Last.fm, and Home Assistant in `.env`.
See `.env.example` for every available option.

## For developers

Run all automated tests:

```bash
npm test
```

GitHub Actions tests Node.js 20 on Linux and Windows and audits production
dependencies. Hardware smoke tests are manual because they control real Sonos
and Home Assistant devices.

Useful health checks:

- `/api/health` — confirms PartyQueue is running and shows its version
- `/api/ready` — reports startup and shutdown readiness
- `/api/rooms` — shows the Sonos rooms PartyQueue can find

PartyQueue uses the MIT license. It is not affiliated with or endorsed by
Sonos, Spotify, Last.fm, Home Assistant, ElevenLabs, or OpenAI. You are
responsible for following the terms of any connected service.
