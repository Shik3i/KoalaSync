# KoalaSync Architecture

This document describes the communication flows and internal logic of the KoalaSync system.

## 1. Extension Connection (Lazy Connect)
- **Initialization**: On startup, `background.js` reads settings (Server URL, Username, Last Room) from `chrome.storage.sync`. No WebSocket connection is established at this point.
- **On-Demand Connection**: The extension only connects when needed — either the user opens the popup with saved room credentials, or when actively in a room. When not in a room, no connection exists. This improves privacy (IP not exposed while idle) and reduces battery/network usage.
- **WebSocket Handshake (when connecting)**:
  1. Background creates a `new WebSocket` to `/socket.io/?EIO=4&transport=websocket&version=1.0.0`.
  2. Server performs security checks:
     - **IP Rate Limit**: Checks if the IP has exceeded connection limits.
     - **Protocol Version**: Client must match the server's protocol (currently `1.0.0`).
  3. Server responds with Engine.IO handshake (`0`) and the client joins the namespace (`40`).
- **Room Join**: Background emits `JOIN_ROOM` containing `roomId`, `password`, `peerId`, and `username`.
- **Deduplication**: If a user joins with a `peerId` that already has an active socket, the server kills the old socket to prevent "Ghost Peers". Deduplication re-validates after acquiring the room creation lock to avoid kicking the wrong socket during concurrent joins.

## 2. Media Event Synchronization
When a user interacts with a video:
1. **Detection**: `content.js` listens to native events (`play`, `pause`, `seeked`) on the `<video>` element, including videos inside Shadow DOM (YouTube, Netflix, etc.).
2. **Prevention of Loops**: Uses an `expectedEvents` Set to distinguish between user actions and programmatic actions. Expected events are consumed on match and expire via timeout. Timeout IDs are cleaned up immediately to prevent memory leaks.
3. **Reporting**: `content.js` sends a `CONTENT_EVENT` to `background.js`.
4. **Relay**: The Server forwards the event to all other peers in the room.
5. **Execution**: Remote peers receive the command via `SERVER_COMMAND` (which includes the original `senderId` for correct ACK routing) and call `video.play()`, `video.pause()`, or `video.currentTime = targetTime`.
6. **ACK Routing**: `content.js` echoes the `commandSenderId` back in `CMD_ACK`, ensuring the `EVENT_ACK` is routed to the correct initiating peer even when multiple commands arrive concurrently.

## 3. Two-Phase Force Sync
Ensures all peers are buffered and synchronized before resuming:
1. **Prepare**: Initiator sends `FORCE_SYNC_PREPARE` with the target timestamp.
2. **Buffer**: Peers seek and pause. Once buffered (`readyState >= 3`), they send a `FORCE_SYNC_ACK`. (Note: `content.js` limits polling to 8000ms).
3. **Execute**: Once the Initiator collects ACKs (or after an 8.5s timeout), they send `FORCE_SYNC_EXECUTE`.
   > [!IMPORTANT]
   > **Network Transit Buffer Rule**: The orchestrator (`background.js`) must always use a timeout at least 500ms longer than the worker (`content.js`) to account for IPC and network transit time. Never align them exactly 1:1, as this will introduce a race condition on slow connections.
4. **Resume**: All peers call `play()` simultaneously.

## 3.1 Canonical Media State v1

The relay keeps one optional, in-memory canonical playback state per active room.
Accepted `PLAY`, `PAUSE`, and `SEEK` commands advance a server-owned revision.
Playing positions advance lazily from the server update time; paused positions do
not. Heartbeats remain observational and do not mutate canonical state.

`ROOM_DATA` materializes the playing position at snapshot creation and advertises
the optional `media-state-v1` capability. A joining/reconnecting client validates
the room/revision, respects Host Control solo mode and Episode Lobby, then sends an
internal `APPLY_CANONICAL_MEDIA_STATE` message to the existing content/video path.
That path reuses frame election, Netflix/Disney page-API seeks, native play/pause,
the 2-second drift tolerance, and programmatic-event suppression. The apply is
one-shot recovery: a pending playing snapshot advances from its local receipt
time while waiting for a target, and the apply creates no action history,
notification, command ACK, or relay media event.

Force Sync remains a two-phase ACK protocol. A valid `PREPARE` is temporary
room-wide choreography; the next authorized `EXECUTE` commits the latest target
visible to peers to canonical state before the shared Force Sync timeout. The
offline queue replays an adjacent `PREPARE`/`EXECUTE` pair in one paced batch and
retains both if delivery fails. Per-sender
`seq`, peer heartbeats, and the reconnect queue remain separate mechanisms.

## 3.2 Offline Media Intent

Canonical Media State and Offline Media Intent have different ownership:

- Canonical Media State is the relay's last accepted shared playback truth.
- Offline Media Intent is one room-scoped client representation of local
  `PLAY`/`PAUSE`/`SEEK` commands that have not reached the relay yet.

Contiguous offline controls merge into a bounded logical queue entry. Every
retained coordination event, including Force Sync and Episode Lobby events, is
an ordering barrier. Stale offline `PING`, `PONG`, heartbeat `PEER_STATUS`, and
`EVENT_ACK` frames are not persisted because they are no longer meaningful after
reconnect. Force Sync ACK remains transactional and is not dropped or merged.

Media intent waits for the reconnecting room's `ROOM_DATA`. An authorized intent
takes precedence over the older canonical snapshot, materializes into the
minimum ordered legacy `SEEK` plus `PLAY`/`PAUSE` frames needed by old peers, and
thereby advances relay canonical state normally. With no intent, canonical
recovery is unchanged. Role loss discards room-driving intent before recovery;
intentional Host Control solo mode and an active Episode Lobby remain
authoritative. MV3 session restoration migrates the previous raw queue format,
preserves barriers, repairs `localSeq` monotonically, and rejects another room's
intent.

## 4. Episode Auto-Sync
Maintains continuous synchronized viewing when watching series:
1. **Detection**: `content.js` monitors the Media Session API for title changes.
2. **Lobby Creation**: When a new title is detected, the peer initiates an `EPISODE_LOBBY` and broadcasts the new title.
3. **Wait State**: All peers freeze their video until they have also loaded the exact same title.
4. **Mid-Lobby Joins**: If a new user joins the room during an active lobby, the lobby initiator broadcasts the active lobby state so the newcomer can sync up.
5. **Resume**: Once all peers report `EPISODE_READY`, the lobby is resolved and playback resumes perfectly.

## 5. Peer Lifecycle & Dual Heartbeat
To maintain a clean room state and eliminate "Ghost Peers":
- **Session Heartbeat (Background)**: Every 30 seconds, `background.js` sends an "I'm alive" signal to the server. This keeps you in the room even if no video is playing.
- **Video Heartbeat (Content)**: Every 15 seconds, `content.js` sends current playback metadata (time, title, state) if a video is found.
- **Server Pruning**: The server runs a "Reaper" every 2 minutes. If a peer has sent **zero** activity (no events and no heartbeats) for 5 minutes, they are forcefully disconnected.
- **Immediate Cleanup**: Rooms are deleted instantly when the last peer leaves or disconnects.
- **Reconnect Strategy (while in room)**: Aggressive backoff — 500ms base, 1.5x multiplier, capped at 5s. Max 20 attempts before marking as failed. Events are queued during disconnect and flushed after namespace rejoin. When not in a room, no reconnection occurs.

> [!CAUTION]
> **Identity Rule**: Differentiate between `peerId` and `socket.id`. Use `socket.id` exclusively for ephemeral transport routing on the server. Use `peerId` exclusively for identity, state management, and room tracking across the stack.

## 6. Broadcast Protocol & Routing
KoalaSync uses a megaphone routing approach to minimize server logic:
- **`emit()` Broadcast Behavior**: Any `emit()` from the extension client is unconditionally broadcast to **all other peers in the room**. It is not a direct message. 
- **Storm Prevention**: When dispatching state updates in response to a new user joining (e.g., an active lobby state), ensure ONLY the initiator (or a designated leader) calls `emit()` to prevent $O(N)$ broadcast storms.

## 7. Security & Stability
- **Service Worker Lifecycle**: Uses `chrome.alarms` (30s interval) to prevent the Manifest V3 service worker from suspending while in an active room. On wake, runtime state is restored from `chrome.storage.session` via `ensureState()`.
- **Reconnect Visualization**: Badge shows "..." (orange) during reconnect. Popup displays "Reconnecting..." with attempt counter.
- **Rate Limiting**: Server-side per-socket and per-IP rate limits to prevent sync-spamming or simple DoS. Public health endpoints are limited to 10 requests/minute/IP and cached server-side for 60 seconds, wrong admin-metrics bearer attempts to 5 requests/minute/IP, and room discovery to one request every 10 seconds per socket. Real client IP is taken from the trusted reverse proxy hop, so the Node port must stay private behind Caddy or another trusted proxy.
- **Room Creation Lock**: Per-room mutex prevents race conditions when multiple peers join a new room simultaneously.
- **CORS**: Allows `chrome-extension://` origins for WebSocket fallback compatibility.
- **Message Buffer**: `maxHttpBufferSize` set to 4KB to accommodate large `JOIN_ROOM` payloads.
- **Process Guards**: `uncaughtException` and `unhandledRejection` handlers prevent silent server crashes.
- **Noise Filtering**: Uses a curated blacklist of domains (Search Engines, Social Media) to declutter the "Target Tab" selector in the popup.
- **Diagnostics**: A "Dev" tab provides real-time access to the underlying `<video>` state (`readyState`, `paused`, `currentTime`) for easier troubleshooting.

## 8. Constant Synchronization & Consistency
To maintain a "Single Source of Truth" across the server and extension without using a bundler:
- **Relay Server & Extension Modules**: `background.js` and `popup.js` import constants directly from `shared/constants.js`.
- **Content Scripts**: To ensure zero-latency execution, `content.js` uses a synchronized copy of `EVENTS` and constants.
- **Automation**: The `npm run build:extension` script automatically injects `EVENTS`, `HEARTBEAT_INTERVAL`, and `episode-utils.js` functions into `content.js` during the build process, eliminating the risk of manual mirror mismatch.
- **Verification**: Any protocol change is automatically propagated across the stack by running the build script.
