// Public Sonos API barrel.
// Implementation lives in sonos-*.js modules; this file re-exports the stable surface
// so existing `from "./sonos.js"` and `import("./sonos.js")` importers keep working.

export {
  pickGroupByTarget,
  removeRangeFor,
  autoStartDecision,
  shouldClearQueueForRandomDj,
  randomDjAnnouncePlan,
  findInsertPosition,
  findUpcomingAnnouncePadIndices,
  songMatchKey,
  interleave,
  findCompanionDjTtsUri,
  isDjVoiceUri,
  isDjSilenceUri,
  queueTrackGenreFields,
  queueTrackFromPlaylist,
  visibleUpcomingQueueItems,
  upcomingGenreHintFromQueueItems,
} from "./sonos-queue-policy.js";

export {
  makeCachedReader,
  NOW_PLAYING_TTL_MS,
  SNAPSHOT_TTL_MS,
} from "./sonos-cache.js";

export {
  getManager,
  resolveCoordinator,
  resolveGroup,
  isNotCoordinatorError,
  resetSonosManager,
  resolveRegion,
} from "./sonos-core.js";

export {
  getNowPlaying,
  getNowPlayingFresh,
  getQueueList,
  listGroups,
  getQueueStatus,
  invalidateSonosSnapshots,
  onSonosSnapshotsInvalidated,
  findUpcomingTrackPosition,
} from "./sonos-snapshots.js";

export {
  play,
  pause,
  resumeQueuePlayback,
  next,
  advanceQueueTrack,
  previous,
  toggleShuffle,
  toggleMute,
  getAnnouncePlaybackContext,
} from "./sonos-transport.js";

export {
  getGroupVolume,
  setGroupVolume,
  volumeUp,
  volumeDown,
} from "./sonos-volume.js";

export {
  pauseQueueTrim,
  trimPlayedTracks,
  addTrackToQueue,
  addSetRequestToQueue,
  SET_REQUEST_SIZE,
  addPlaylistToQueue,
  enqueueHttpAudio,
  insertAnnounceBlock,
  removeQueueTrack,
  removeUpcomingAnnouncePads,
  removeUpcomingFillerTracks,
  ensureShoutLeadBuffer,
  reorderQueueTrack,
  clearQueue,
} from "./sonos-queue-mutations.js";

export {
  SHOUT_LEAD_BUFFER_SEC,
  needsShoutLeadBuffer,
  findShoutBufferTrackNumber,
  requestPosAfterShoutBuffer,
} from "./shout-lead-buffer.js";

export {
  listRooms,
  selectGroup,
  groupAll,
  joinSpeakerToTarget,
  leaveSpeakerGroup,
  ungroupAll,
  isKnownSonosHost,
} from "./sonos-groups.js";

export { addRandomFromPlaylists } from "./sonos-random.js";
