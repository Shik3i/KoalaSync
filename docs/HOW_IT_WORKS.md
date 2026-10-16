# KoalaSync — How It Works (Step-by-Step)

This guide walks through the complete user flow of KoalaSync, from creating a room to synchronized playback. It is designed for **store reviewers**, **end-users**, and **manual testers** to understand exactly what happens at each step, what data is sent, and where it goes.

---

## Step 1: Installing the Extension

1. Download the extension from the [Releases](https://github.com/Shik3i/KoalaSync/releases) page (or install from the Chrome Web Store / Firefox Add-ons).
2. The extension adds a small icon to your browser toolbar.
3. On first install, a unique 8-character **Peer ID** is generated locally and stored in `chrome.storage.local`. This ID is never sent to any external service — it only travels to the relay server when you join a room.

> **What's stored locally**: `peerId` (8-char hex), `username` (customizable, defaults to a readable adjective-noun pair), `serverUrl`, `filterNoise` preference. All stored via `chrome.storage.sync` and `chrome.storage.local`.

---

## Step 2: Connecting to the Relay Server

When you open the extension popup (with saved room credentials) or when a saved room configuration exists from a previous session, the background service worker connects to the relay server:

1. **WebSocket Handshake** (on demand): `background.js` opens a WebSocket to `wss://syncserver.koalastuff.net/socket.io/?EIO=4&transport=websocket` only when needed (popup opened or active room).
2. **Security Checks** (server-side):
   - The server checks the client's **IP rate limit** (max 10 connections per 60 seconds).
   - The server validates the **authentication token** (hardcoded in `shared/constants.js`) to verify this is a legitimate KoalaSync client.
   - The server checks the **extension version** against `MIN_VERSION` to reject outdated clients.
3. **Connection Established**: The server responds with an Engine.IO handshake (`0{...}`), followed by a Socket.IO namespace join (`40`). The connection status dot in the popup turns green.

> **Data sent to server**: `token` (authentication), `version` (e.g., `1.3.1`). No personal data is transmitted during connection.

---

## Step 3: Creating a Room

Click **"Create Room"** in the popup's Room tab:

1. The extension generates a random Room ID (e.g., `happy-koala-42`) and a random 6-character password.
2. Room IDs are restricted to `[a-zA-Z0-9-]` (alphanumeric + hyphens only).
3. The extension emits a `JOIN_ROOM` event to the server.

> **Data sent in `JOIN_ROOM`**:
> ```json
> {
>   "roomId": "happy-koala-42",
>   "password": "x7k2m9",
>   "peerId": "a1b2c3d4",
>   "username": "MyName",
>   "tabTitle": "YouTube - My Video",
>   "protocolVersion": "1.0.0"
> }
> ```

4. **Server-side processing**:
   - All fields are **sanitized**: `roomId` is stripped of invalid characters and clamped to 64 chars; `peerId` clamped to 16 chars; `password` clamped to 128 chars; `username` clamped to 30 chars.
   - The server **hashes the password** with a keyed SHA-256 HMAC and stores only that hash in RAM (the plaintext is never stored).
   - A new room object is created in memory with the peer's data.
   - The server responds with `ROOM_DATA` containing the list of peers in the room.

5. **Popup updates**: The Room tab switches to the "Active Room" view, showing your Room ID and an invitation link.

---

## Step 4: Sharing an Invitation Link

Click the **📋 Copy** button next to the invite link:

1. The extension constructs a URL in this format:
   ```
   https://sync.koalastuff.net/join.html#join:<roomId>:<password>:<serverFlag>:<encodedServerUrl>
   ```
   - `serverFlag`: `0` for official server, `1` for custom server.
   - `encodedServerUrl`: Only populated if using a custom server.
   
2. **Important**: The room credentials are in the **URL hash** (`#`), which means they are **never sent to the web server** — the hash fragment stays entirely in the browser. The landing page server never sees your room ID or password.

3. Send this link to your friend via any messaging app.

---

## Step 5: Your Friend Opens the Invitation Link

When your friend opens the link in their browser:

1. **`join.html` loads** on `sync.koalastuff.net`. The page displays "INVITATION DETECTED" with the Room ID.

2. **Extension detection**: The page checks for `document.documentElement.dataset.koalasyncInstalled`, which is set by `bridge.js` (a content script injected only on `sync.koalastuff.net`).

3. **If the extension IS installed**:
   - The page shows "Joining room automatically..."
   - After 500ms, the page dispatches a `KOALASYNC_JOIN_REQUEST` custom DOM event with `{ roomId, password, useCustomServer, serverUrl }`.
   - `bridge.js` catches this event and forwards it to `background.js` via `chrome.runtime.sendMessage`.
   - `background.js` stores the credentials in `chrome.storage.sync` and emits `JOIN_ROOM` to the server.
   - The server validates the password against the stored keyed SHA-256 HMAC hash.
   - On success, the server responds with `ROOM_DATA` and broadcasts `PEER_STATUS { status: 'joined' }` to all existing peers.
   - The join page updates to show "✅ Successfully joined!".

4. **If the extension is NOT installed**:
   - The page shows download links (Chrome Web Store / GitHub).
   - The user installs the extension, returns to the link, and the flow continues from step 3.

5. **Alternative: paste the link into the popup**:
   - Pasting a full invite link into the **Room ID** or **Password** field fills in room, password, chat key and server.
   - Only the `#j2:` / `#join:` fragment is read, so the link's domain does not matter. This also works for links that point to a self-hosted page or to a blocked `sync.koalastuff.net`.
   - The popup uses the regular paste event, so no clipboard permission is needed and no page is injected.

---

## Step 6: Selecting a Video Tab

Both users now need to select which browser tab contains the video to sync:

1. Open a video on any website (YouTube, Twitch, Netflix, etc.).
2. In the extension popup → **Sync** tab → use the **"Target Tab"** dropdown.
3. The dropdown lists all open tabs, filtered to exclude noise (search engines, social media — configurable via Settings).
4. Tabs with a **matching video title** are highlighted with a ⭐ prefix for easy identification.
5. Selecting a tab causes `background.js` to set `currentTabId` and inject `content.js` into that tab via `chrome.scripting.executeScript`.

> **What `content.js` does on injection**: Finds the first `<video>` element on the page and attaches event listeners for `play`, `pause`, `seeked`, and `loadeddata`. (Time and volume state are tracked via a 15-second heartbeat interval, not continuous event listeners). It uses an `expectedEvents` Set to distinguish between user actions and programmatic actions (loop prevention).

---

## Step 7: Synchronized Playback

When User A presses **Play** on their video:

1. `content.js` detects the native `play` event on the `<video>` element.
2. It checks the `expectedEvents` Set — if this event was expected (caused by a remote command), it's consumed silently. If not, it's a **user action**.
3. For user actions, `content.js` sends `{ type: 'CONTENT_EVENT', action: 'play', payload: { currentTime, ... } }` to `background.js`.
4. `background.js` adds an `actionTimestamp` and emits the `PLAY` event to the server.
5. **Server relay**: The server sanitizes all fields (strings clamped, numbers validated, booleans type-checked) and constructs a clean `relayPayload` with `senderId` set to User A's `peerId`. The raw client data is never forwarded directly.
6. The server broadcasts the sanitized payload to all other peers in the room.
7. User B's `background.js` receives the `PLAY` event and calls `routeToContent()`, which sends a `SERVER_COMMAND` message to User B's `content.js`.
8. User B's `content.js` adds `'playing'` to its `expectedEvents` Set (so it won't echo the event back), then calls `video.play()`.

> **The same flow applies to Pause and Seek**, with Seek additionally sending `targetTime` for the time position.

---

## Step 8: Force Sync (Two-Phase Protocol)

If videos drift out of sync, either user can click **"Force Sync"**:

### Phase 1 — Prepare
1. The initiator's `content.js` captures the current `video.currentTime` as the `targetTime`.
2. `background.js` emits `FORCE_SYNC_PREPARE` with `{ targetTime }` to all peers.
3. All peers (including the initiator) **pause** their video and **seek** to `targetTime`.
4. Each peer's `content.js` polls `video.readyState` until it reaches `≥ 3` (buffered enough to play), with an 8-second timeout.
5. Once buffered, each peer sends `FORCE_SYNC_ACK` back.

### Phase 2 — Execute
6. Once all ACKs are received (or after 8.5 seconds), the initiator emits `FORCE_SYNC_EXECUTE`.
7. All peers call `video.play()` simultaneously, achieving synchronized playback.

> **Why two phases?** Without buffering confirmation, peers with slower connections would start playing before they've loaded the target timestamp, causing immediate desync.

---

## Step 9: Heartbeat & Peer Health

While in a room, two heartbeats keep the session alive:

| Heartbeat | Interval | Source | Purpose |
|:----------|:---------|:-------|:--------|
| **Background** | 30 seconds | `background.js` | While connected, signals "I'm still connected" and triggers automatic reconnect (500ms base, max 5s). No heartbeats fire when idle (lazy connect). |
| **Content** | 15 seconds | `content.js` | Sends video metadata: `currentTime`, privacy-filtered `mediaTitle`, `playbackState`, `volume`, `muted` |

- **Server Reaper**: Every 2 minutes, the server checks for peers with no activity for 5+ minutes and disconnects them ("dead peer pruning").
- **Room Cleanup**: Empty rooms are deleted immediately. Inactive rooms are pruned after 2 hours.

---

## Step 10: Leaving a Room

When a user clicks **"Leave"** or closes their browser:

1. `background.js` emits `LEAVE_ROOM` (or the WebSocket `disconnect` fires automatically).
2. The server calls `removePeerFromRoom()`, which:
   - Removes the peer from the room's `peers` Set, `peerIds` Map, and `peerData` Map.
   - Removes the socket from the global `socketToRoom` and `peerToSocket` maps.
   - Broadcasts `PEER_STATUS { status: 'left' }` to remaining peers.
   - If the room is now empty, **deletes the room entirely** — no data persists.
3. The event rate-limit counter for that socket is also cleaned up.

> **After disconnect, zero data about the user remains on the server.** There is no database, no log file, no analytics record. The session existed only in RAM and is now gone.

---

## Episode Auto-Sync Flow

When watching a series and an episode ends:

1. `content.js` monitors the [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API) for title changes.
2. When a new title is detected, the peer broadcasts `EPISODE_LOBBY` with the expected title after applying the local media title privacy setting. In episode-only mode this is an identifier such as `S01E04`; when media titles are not sent, the client does not create a new episode lobby.
3. All peers' videos freeze. The UI shows an "Episode Lobby" card with peer readiness status.
4. Each peer's `content.js` polls for the new title to appear in the `<video>` element's metadata.
5. Once a peer detects the matching title, they send `EPISODE_READY`.
6. When all peers report ready, the lobby resolves and playback resumes simultaneously.

---

## Data Flow Summary

```
┌─────────────┐     WebSocket      ┌──────────────┐     WebSocket      ┌─────────────┐
│  Extension  │ ←─────────────────→│  Relay Server │←──────────────────→│  Extension  │
│  (User A)   │   JOIN_ROOM        │  (RAM only)   │   JOIN_ROOM        │  (User B)   │
│             │   PLAY/PAUSE/SEEK  │               │   PLAY/PAUSE/SEEK  │             │
│             │   FORCE_SYNC_*     │  Sanitizes &  │   FORCE_SYNC_*     │             │
│             │   PEER_STATUS      │  relays only  │   PEER_STATUS      │             │
│             │   EPISODE_*        │               │   EPISODE_*        │             │
└──────┬──────┘                    └───────────────┘                    └──────┬──────┘
       │                                                                      │
  ┌────┴─────┐                                                          ┌─────┴────┐
  │ content  │  Listens to <video> events                               │ content  │
  │   .js    │  Controls playback                                       │   .js    │
  └──────────┘                                                          └──────────┘
```

> **The relay server is a pure message forwarder.** It never interprets video content, accesses URLs, or stores session history. All media control happens locally inside each user's browser via the `<video>` DOM API.
