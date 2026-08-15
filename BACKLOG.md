# PartyQueue backlog

Ideas parked for later — not scheduled work unless pulled into a release.

## Playback / Sonos

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

## Look / banners

- **Swinefeld desktop banner — wine-lady hand**  
  Brown-haired woman in leopard top (right of the dog): wine-glass hand/wrist looks detached or backwards. Prefer a **local retouch** of the wrist join on the existing `banner-swinefeld.png` / `swinefeld.png` — do not regenerate the whole banner.
