# PartyQueue backlog

Ideas parked for later — not scheduled work unless pulled into a release.

## Playback / Sonos

- **Paused Now Playing: wake instead of 5s poll**  
  Keep today’s cadences until we pull this (1.5s while playing, 5s paused; queue 3s / 15s). Extra phones and TVs already share one server poller.

  PartyQueue Play/Skip/Random already **nudge** immediately. The 5s paused tick is only to notice playback that PartyQueue did not start (Sonos app, speaker button, Alexa, HA). Progress bars do not need it while paused.

  **Do not** zero-poll while paused with no external wake — TVs would sit stale.

  **Later options**
  1. Cheap: stretch paused NP to 30–60s. In-app controls stay instant; Sonos-app Play lags up to that window.
  2. Real wake: subscribe to Kitchen AVTransport GENA/`LastChange`, then run the 1.5s playing poll until paused again. Keep a 60s heartbeat — subscriptions expire and can die across VLAN/restart. Unused in `@svrooij/sonos` today; host networking + `PUBLIC_BASE_URL` make it feasible.

  Leave playing at 1.5s (track-end, DJ pads, karaoke).

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
