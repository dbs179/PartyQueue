// Leaf flags for the DJ volume handoff — imported by handoff + volume + queue
// policy without cycles.

let volumeHandoffActive = false;
let volumeHandoffArmed = false;
let volumeHandoffArmedAt = 0;

/**
 * An announce waits at most one song for its ramp to reach the playhead. A
 * handoff still armed well past that never got its pads and is not coming back,
 * so the flag self-expires rather than pausing trim for the rest of the night.
 */
export const MAX_HANDOFF_ARMED_MS = 10 * 60_000;

export function isDjVolumeHandoffActive() {
  return volumeHandoffActive;
}

export function setDjVolumeHandoffActive(active) {
  volumeHandoffActive = !!active;
}

/**
 * True from the moment an announce is armed until it completes or is cancelled
 * — including the minutes it spends waiting for the ramp pad to reach the
 * playhead. `isDjVolumeHandoffActive` only covers the volume-locked window,
 * which left the whole wait unguarded: a trim in there shifts every queue index
 * the handoff was handed at insert time.
 */
export function isDjVolumeHandoffArmed(now = Date.now) {
  if (!volumeHandoffArmed) return false;
  if (now() - volumeHandoffArmedAt > MAX_HANDOFF_ARMED_MS) {
    volumeHandoffArmed = false;
    volumeHandoffArmedAt = 0;
    return false;
  }
  return true;
}

export function setDjVolumeHandoffArmed(armed, now = Date.now) {
  const next = !!armed;
  // Only the false → true edge starts the clock; phase changes must not keep
  // renewing the window on a handoff that is stuck.
  if (next && !volumeHandoffArmed) volumeHandoffArmedAt = now();
  if (!next) volumeHandoffArmedAt = 0;
  volumeHandoffArmed = next;
}
