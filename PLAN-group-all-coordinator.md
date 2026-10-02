# Plan: Group All makes Living Room the coordinator

Status: **Shipped in 15.3.0.** Group All makes Living Room the coordinator
and keeps the current queue. Delegation is the first path. If that handoff
fails, the same queue is copied onto Living Room and started again at the
same spot. Do not build the playback-subscription design in the same change.

## What shipped

Group All leaves Living Room as the coordinator of the whole house and keeps
the current queue.

1. If Living Room is missing or in its unreachable cool-off, stop and leave
   the current groups alone.
2. If Living Room already coordinates the target group, join every other
   speaker to it. The song that is playing keeps playing.
3. Otherwise join Living Room into that group when it is outside it, then
   `DelegateGroupCoordinationTo` with `RejoinGroup` so the old coordinator
   stays. Party Queue then selects Living Room. The same queue, song, and
   position stay put.
4. Join any speaker still outside that group. A speaker that fails to join
   is skipped.
5. Set the group volume to `GROUP_ALL_VOLUME` (15). If the handoff left a
   queue that had been playing paused, resume it.

If delegation fails, snapshot the coordinator queue first. A failed read
leaves the groups alone. After a good read, ungroup without resuming, clear
each speaker's private queue, put that same list on Living Room, join
everyone, and seek to the same spot. Play only when the party was playing
from the queue. TV, line-in, and radio are not copied into a queue. Never-Ending
stays paused until that rebuild finishes.

## Out of scope

Do not subscribe to Sonos events, do not change the 1.5s now-playing poll, and
do not change announcement playhead timing. That design is
`PLAN-sonos-playback-subscription.md` and is not part of this build.
