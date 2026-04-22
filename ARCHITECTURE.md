# KoalaSync Architecture

This document describes the communication flows and internal logic of the KoalaSync system.

## 1. Extension Startup & Connection
- **Initialization**: On startup, `background.js` reads settings (Server URL, Username, Last Room) from `chrome.storage.sync`.
- **WebSocket Handshake**:
  1. Background creates a `new WebSocket` to `/socket.io/?EIO=4&transport=websocket&version=1.0.0`.
  2. Server performs security checks:
     - **IP Rate Limit**: Checks if the IP has exceeded connection limits.
     - **Protocol Version**: Client must match the server's protocol (currently `1.0.0`).
  3. Server responds with Engine.IO handshake (`0`) and the client joins the namespace (`40`).
- **Room Join**: Background emits `JOIN_ROOM` containing `roomId`, `password`, `peerId`, and `username`.
- **Deduplication**: If a user joins with a `peerId` that already has an active socket, the server kills the old socket to prevent "Ghost Peers".

## 2. Media Event Synchronization
When a user interacts with a video:
1. **Detection**: `content.js` listens to native events (`play`, `pause`, `seeked`) on the `<video>` element.
2. **Prevention of Loops**: Uses `lastTargetState` to distinguish between user actions and programmatic actions triggered by the extension.
3. **Reporting**: `content.js` sends a `CONTENT_EVENT` to `background.js`.
4. **Relay**: The Server forwards the event to all other peers in the room.
5. **Execution**: Remote peers receive the command and call `video.play()`, `video.pause()`, or `video.currentTime = targetTime`.

## 3. Two-Phase Force Sync
Ensures all peers are frame-perfect and buffered before resuming:
1. **Prepare**: Initiator sends `FORCE_SYNC_PREPARE` with the target timestamp.
2. **Buffer**: Peers seek and pause. Once buffered (`readyState >= 3`), they send a `FORCE_SYNC_ACK`.
3. **Execute**: Once the Initiator collects ACKs (or after a 5s timeout), they send `FORCE_SYNC_EXECUTE`.
4. **Resume**: All peers call `play()` simultaneously.

## 4. Peer Lifecycle & Dual Heartbeat
To maintain a clean room state and eliminate "Ghost Peers":
- **Session Heartbeat (Background)**: Every 30 seconds, `background.js` sends an "I'm alive" signal to the server. This keeps you in the room even if no video is playing.
- **Video Heartbeat (Content)**: Every 15 seconds, `content.js` sends current playback metadata (time, title, state) if a video is found.
- **Server Pruning**: The server runs a "Reaper" every 2 minutes. If a peer has sent **zero** activity (no events and no heartbeats) for 5 minutes, they are forcefully disconnected.
- **Immediate Cleanup**: Rooms are deleted instantly when the last peer leaves or disconnects.

## 5. Security & Stability
- **Service Worker Lifecycle**: Uses `chrome.alarms` to prevent the Manifest V3 service worker from suspending while in an active room.
- **Rate Limiting**: Server-side per-socket and per-IP rate limits to prevent sync-spamming or DoS.
- **Noise Filtering**: Uses a curated blacklist of domains (Search Engines, Social Media) to declutter the "Target Tab" selector in the popup.
- **Diagnostics**: A "Dev" tab provides real-time access to the underlying `<video>` state (`readyState`, `paused`, `currentTime`) for easier troubleshooting.
