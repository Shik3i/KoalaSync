# KoalaSync Architecture

This document describes the communication flows and internal logic of the KoalaSync system.

## 1. Extension Startup & Connection
- **Initialization**: On startup, `background.js` reads settings (Server URL, Last Room) from `chrome.storage.sync`.
- **WebSocket Handshake**:
  1. Background creates a `new WebSocket` to `/socket.io/?EIO=4&transport=websocket&version=1.0.0&token=...`.
  2. Server performs security checks:
     - **IP Rate Limit**: Checks if the IP has exceeded 10 connections/min.
     - **Auth Token**: If a server token is required, it must match.
     - **Version Check**: Client version must be `>= MIN_VERSION`.
  3. Server responds with an Engine.IO handshake (packet type `0`).
  4. Background sends `40` to join the default Socket.IO namespace.
  5. Server responds with `40`.
- **Room Join**: If a Room ID is stored, Background emits `42["join_room", {...}]`.
- **Reconnect Logic**: If the connection drops, Background uses an exponential backoff (1s, 2s, 4s... max 30s) to reconnect.

## 2. Media Event Synchronization
When a user presses Play/Pause in a synchronized tab:
1. **Detection**: `content.js` listens to native `play`/`pause` events on the `<video>` element.
2. **Reporting**: `content.js` sends a `CONTENT_EVENT` message to `background.js`.
3. **Emission**: `background.js` emits `42["play"|"pause", {...}]` to the server.
4. **Relay**: The Server forwards the event to all other sockets in the same room.
5. **Reception**: Other Extensions receive the event via WebSocket.
6. **Execution**: `background.js` sends a `SERVER_COMMAND` to its `content.js`.
7. **Control**: `content.js` calls `video.play()` or `video.pause()`. 
   - *Note*: It uses `isProcessingCommand` to prevent feedback loops.

## 3. Two-Phase Force Sync
This protocol ensures all peers are paused and buffered at the exact same timestamp before resuming playback.
1. **Initiation**: User clicks "Force Sync" in the popup.
2. **Preparation**:
   - Popup asks Content Script for the current time.
   - Background emits `FORCE_SYNC_PREPARE` with `targetTime`.
3. **Coordination**:
   - Peers receive `PREPARE`, `content.js` pauses and seeks.
   - Once `video.readyState >= 3` (buffered), `content.js` sends `FORCE_SYNC_ACK`.
   - Background forwards ACK to the Initiator via Server.
4. **Execution**:
   - Initiator collects ACKs. Once all peers have responded (or 5s timeout), Initiator emits `FORCE_SYNC_EXECUTE`.
   - All peers receive `EXECUTE` and call `video.play()`.

## 4. Peer Lifecycle
- **Join**: Server sends `ROOM_DATA` to the joiner and `PEER_STATUS (joined)` to others.
- **Leave**:
  - **Manual**: User clicks "Leave". Popup sends `LEAVE_ROOM` to Background -> Server.
  - **Pruning**: If a socket disconnects, the Server automatically broadcasts `PEER_STATUS (left)` and deletes the room if empty.
- **Heartbeat**: `content.js` sends a status heartbeat every 15s to keep the peer list updated with current playback states.

## 5. Service Worker Keep-alive
Manifest V3 Service Workers are ephemeral. To keep the connection alive:
1. `chrome.alarms` triggers every 15 seconds.
2. The alarm listener checks the WebSocket `readyState`.
3. If not `OPEN`, it triggers a `connect()` attempt.
4. This keeps the background process "awake" enough to handle incoming WebSocket messages.
