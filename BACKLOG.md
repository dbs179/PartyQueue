# PartyQueue backlog

Ideas parked for later — not scheduled work unless pulled into a release.

The 28 Sep 2026 application review is folded in below. Party-night bugs from that review shipped in 14.1.0 and 14.1.1. A later pass stopped a Set Request from holding the fairness lock across its Sonos writes, quieted guest search, and stopped a normal Skip from browsing the queue. The three plan files that still said “not started” (`PLAN-queue-on-change.md`, `PLAN-topology-hold.md`, `PLAN-shared-volume.md`) described work that shipped in 14.0.5–14.0.7; those files were removed. `PLAN-async-guest-adds.md` stays as the record of the 14.0.0 outbox.

## Left as-is (28 Sep 2026)

Recorded so the next pass does not treat these as bugs. The party stays open unless we decide otherwise.

- **Skip, volume, and Clear stay open after a PIN is set**  
  `requireHostControls` (`src/http/host-controls.js`) does nothing unless Host-only controls is on (`hostControlsOnly` in `src/settings.js`, default off). A phone on guest Wi-Fi can skip, pause, change volume, clear the queue, Random-fill, and regroup speakers. Soft rate limits only slow that down.

  **If we change it:** turn Host-only controls on for a real party. Leave search and Add open. Rate-limit group select the same way as skip.

- **Settings, including the guest Wi-Fi password, are readable until a PIN exists**  
  `requireHost` (`src/host-auth.js`) calls through when no PIN is configured, so `GET /api/settings` includes `guestWifiPassword`. Spotify login and banner uploads use the same gate. Credential writes already use `requireHostStrict` and the bootstrap code. The gap is first boot, and any night the PIN file is missing.

  **If we change it:** omit the Wi-Fi password from the settings payload, or require a host session to read it.

## Accept or limit

- **Vibe, Mix, and Never-Ending have no PIN and no rate limit**  
  `POST /api/party`, `POST /api/autofill`, and `POST /api/selection` are open so the Vibe page works for everyone. A guest can turn off Never-Ending, rewrite the Mix, or flip Kids lock as fast as they can tap. CSRF Origin is checked only when `PUBLIC_BASE_URL` is set.

  **Keep them open** if that is the party. Otherwise add the same soft rate limit used for search, and confirm `PUBLIC_BASE_URL` is set in the container env.

## When you next touch it

- **Split DJ voice, and thin the client shell, only while those files are already open**  
  `src/dj-voice.js` (~4,400 lines) still mixes copy, TTS, bake, and playback. `public/js/app.js` is still the lifecycle for views, volume, stats, and groups. `src/settings.js` (~1,800 lines) mixes disk format with product policy. Sonos was already split into a barrel plus focused modules, which is why later playback work could land without a rewrite.

  Split `dj-voice.js` the way `sonos.js` was split: copy, TTS I/O, and playback orchestration. Keep `app.js` as imports and route wiring. Leave settings persistence in one module and move policy getters out as you touch them.

## Playback / Sonos

- **Group All should make Living Room the coordinator**  
  Group All used to keep whoever was already coordinating the targeted group. If that speaker was Office, Office ran the house and every now-playing read went there.

  **Done in 15.3.0**
  Group All hands the current group to Living Room and keeps the queue playing. If that handoff fails, the same queue is copied onto Living Room and restarted at the same spot. A speaker that fails to join is skipped. See `PLAN-group-all-coordinator.md`.

- **Arc TV input blocks auto-start after Clear / Random**  
  Living Room Arc is the whole-house coordinator. After a Home Assistant Node-RED grouping flow, the TV can power on and the Arc switches to HDMI/SPDIF (`x-sonos-htastream:…:spdif`). That reports `PLAYING`, so `autoStartDecision` used to skip starting the queue.

  **Done**
  1. `x-sonos-htastream` counts as idle for auto-start and the empty-queue DJ hold. SiriusXM, radio, and line-in are still left alone. A paused TV stays paused.
  2. After Clear, the coordinator `SwitchToQueue`s when it is still on that TV input.

  **Later**
  3. Now Playing label "TV" instead of the raw RINCON URI.

- **Zone topology flaps mid-operation, so Play lands on a non-coordinator**  
  Seen 2026-09-12 while smoke-testing 11.2.4 against the Office alone. PartyQueue pulled Office out of the house group and enqueued three Spotify tracks to it correctly (own coordinator, transport on `x-rincon-queue:<Office>#0`, playhead on row 1), and every `Play` still came back `701 Transition not available`; `SeekTrack` gave `711 Illegal seek target`. Mid-run, `/api/groups` showed **all seven rooms standalone** when only Office had been removed, and a queue-clear moments later reported Office back in "Living Room + 6". So something outside PartyQueue is regrouping rooms while requests are in flight.

  Suspect the same Home Assistant Node-RED grouping flow as the Arc item above. The failure mode is generic: we resolve a coordinator, enqueue to it, and by the time `Play` is sent that device is no longer the coordinator, so Sonos refuses the transition. Because nothing ever started, no DJ shout was generated either — announces silently do not happen.

  **Done**
  1. Play, Skip, and queue writes (`enqueue`, Clear) invalidate the zone cache and retry once on `701`/`711` (queue writes also still retry `800`).
  2. The queue-write retry logs the group topology next to the refusal.

  **Later**
  3. Consider whether guest-visible state should say "speakers regrouped" rather than failing quietly.
  4. Worth checking against the 2026-09-11 party logs — this may be a second, independent cause of missed announces alongside the stale queue indices fixed in 11.2.4.

- **Subscribe to coordinator playback instead of the 1.5s poll**  
  The phone already runs the progress bar on its own clock. The 1.5s poll is how PartyQueue notices a song change, an outside play/pause, or a seek. A coordinator-only AVTransport subscription can replace that poll and the announcement playhead loop, with a 10s safety read kept. Fixed 3-second silence pads on the baked MP3 let the volume restore run from the ffmpeg length.

  **Later**
  Build `PLAN-sonos-playback-subscription.md` after Group All makes Living Room the coordinator. Do not build it in the same change. The cheap alternative in that plan is to stretch the playing poll to about 8–10s and leave announcements alone.

- **Paused Now Playing: wake instead of 5s poll**  
  Folded into `PLAN-sonos-playback-subscription.md`. Do not treat the notes below as a second design.

  Keep today’s cadences until that plan is pulled (1.5s while playing, 5s paused; queue 3s / 15s). Extra phones and TVs already share one server poller. PartyQueue Play/Skip/Random already **nudge** immediately. The 5s paused tick is only to notice playback that PartyQueue did not start (Sonos app, speaker button, Alexa, HA). Do not zero-poll while paused with no external wake — TVs would sit stale.

- **Volume normalization (party helper)**  
  Quiet Spotify masters still play quiet on Sonos because PartyQueue doesn’t process audio. True stream-level ReplayGain is out of scope on the current Spotify path (Sonos owns decode/playback).

  **What Sonos actually does**
  - EQ “Loudness” is bass/treble at low listening levels, not track leveling.
  - Local library: ReplayGain / similar tags on some files (not Spotify streams).
  - **Spotify Connect** (2025): Sonos applies Spotify’s per-track `gain_mdb` (mostly negative → quieter overall). No toggle. PartyQueue does **not** use Connect — it queues `spotify:track:` URIs on the native Sonos Spotify service, which likely does **not** get that gain. Matches the quiet-song report.
  - **Apple Music** (firmware 15.2+): Sonos applies Apple’s loudness metadata on the **native Sonos Apple Music / SMAPI queue path** (the path PartyQueue would use if it enqueued AM tracks). Automatic, no toggle. Levels average loudness; not perfect (album-relative quiet tracks can stay quieter; unmatched/uploaded library often skipped). After 15.2 many rooms got **louder overall**. AirPlay + Sound Check is a different stack — not relevant.

  **If we stay on Spotify (in-app helper)**
  1. Host “boost this track” (temporary Sonos volume bump for current song).
  2. Best-effort auto from Spotify `loudness` (`GET /v1/audio-features/{id}`; also audio-analysis). Track objects have no loudness. Probe at startup: many apps get **403** since late 2024 — if so, hide auto and keep manual boost.
  3. Both, behind a Booth toggle.
  4. **Pad/ramp sandwich** (reuse DJ volume handoff, no TTS): only for outlier tracks, not every song.  
     `[short silence-ramp] → ramp room volume UP → song at boosted volume → [short silence] → ramp DOWN to baseline`.  
     Pads ~1–1.5s (DJ announce still wants ~3s). Boost only, never turn down bangers. Map dB → Sonos 0–100 with a cap (e.g. ~1.5 pts/dB, max +12–15). Merge with DJ announce on the same boundary; restore on Skip/Next/Clear. Don’t lock the host volume knob for the whole song.

  **If we moved to Apple Music**
  Native Sonos AM playback would likely give real stream-level normalization for free — better match than Spotify-in-the-queue. Would not replace a host boost for outliers. Not a settings switch: PartyQueue is Spotify-shaped (search, playlists, URIs, guest search, Random/Never-Ending); AM would be new catalog, MusicKit auth, and Sonos URI scheme.

## Lyrics / Karaoke

- **Slightly late community LRC (per-file, not a global lead bump)**  
  *Number 3 and Number 7* (Morgan Wallen) and *Must've Never Met You* (Luke Combs) sat a hair behind the vocal. Another song the same night was spot on, so do **not** raise `LYRICS_LEAD_SEC` (0.75) — that would pull good files early.

  Not a wrong-mix pick. Wallen: every LRClib copy used the same timestamps. Combs: two community timings; equal scores keep search order, and we cached the later family. Neither file had `[offset:]`.

  **Later**
  1. Tie-break in `pickBestSearchHit`: when duration/span scores match, prefer the file whose first vocal line is slightly earlier (cap ~2–4s; skip bogus `0:00` intros).
  2. Apply LRC `[offset:±ms]` in `normalizeLrc` and Unison `cleanEnhancedLrc` (`t' = t + offset/1000`, clamp about ±10s, then strip the tag). Files without a tag stay unchanged.
  3. Bump the lyrics cache key/version so the 24h cache re-fetches after the change.

## Look / banners

- **Swinefeld desktop banner — wine-lady hand**  
  Brown-haired woman in leopard top (right of the dog): wine-glass hand/wrist looks detached or backwards. Prefer a **local retouch** of the wrist join on the existing `banner-swinefeld.png` / `swinefeld.png` — do not regenerate the whole banner.
