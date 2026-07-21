let generation = 0;

/** Snapshot the current queue-work generation for cooperative cancellation. */
export function queueWorkGeneration() {
  return generation;
}

/** Cancel all queue work that began before this call. */
export function preemptQueueWork() {
  generation += 1;
  return generation;
}

export function queueWorkWasPreempted(startedGeneration) {
  return Number(startedGeneration) !== generation;
}

export function resetQueuePreemptForTests() {
  generation = 0;
}
