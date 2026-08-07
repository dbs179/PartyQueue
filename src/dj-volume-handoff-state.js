// Leaf flag for DJ volume handoff lock — imported by handoff + volume without cycles.

let volumeHandoffActive = false;

export function isDjVolumeHandoffActive() {
  return volumeHandoffActive;
}

export function setDjVolumeHandoffActive(active) {
  volumeHandoffActive = !!active;
}
