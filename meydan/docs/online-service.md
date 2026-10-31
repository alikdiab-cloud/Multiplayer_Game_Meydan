# Online service lifecycle

## Room inactivity

Rooms expire when the maintenance pass observes at least six hours since the room's `lastActivityAt` timestamp. The timestamp is set at room creation and refreshed by a successful room join or resume, a player move or match action, and a membership or connection-state change such as a leave or disconnect. Failed requests, read-only snapshots, clock broadcasts, and passive timeout maintenance do not refresh it. The maintenance interval is shared by all rooms; no per-room expiry timer is created.

Expiry releases every player seat and spectator presence, removes all associated reconnect sessions, drops pending room snapshots, and tells currently connected room sessions that the room expired. The client clears its saved credential and returns to the online lobby with a create/join recovery message. Rate-limit counters are fixed-window scalars attached to each live socket, bounded by the event cap, and are discarded when that socket disconnects; room expiry does not reset a live socket's rate window.

## Process lifetime and hosting

Online rooms, matches, clocks, offers, rematch votes, and reconnect sessions live only in this process's memory. A process restart destroys them; the service does not promise to restore matches after a restart. `/api/health` is a lightweight liveness check and returns only `{ "status": "ok" }`; it does not expose room contents, reconnect credentials, or player diagnostics.

Multi-instance hosting is unsupported without shared room/session storage and a Socket.IO adapter that distributes room events across instances. The current registry and socket ownership map are process-local, so routing a reconnect or another player to a different instance cannot recover the same room.

The shared maintenance loop starts once per attached HTTP server and is stopped during server shutdown. Shutdown also clears the in-memory room and reconnect registries and closes connected sockets.
