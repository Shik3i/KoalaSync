# KoalaSync

KoalaSync is a Chrome Extension and Relay Server for synchronized video playback (YouTube, Twitch, HTML5).

> [!TIP]
> **New Developers & AI Agents**: Please read [AI_INIT.md](AI_INIT.md) before starting work.

## Repository Structure
- `extension/`: Chrome Extension (Manifest V3).
- `server/`: Node.js + Socket.IO Relay Server.
- `website/`: Static marketing landing page & tutorials.
- `shared/`: Shared protocol constants.

## Setup Instructions

### 1. Relay Server (Docker)
The server runs on Node.js using Socket.IO but is restricted to WebSocket transport for compatibility with native clients.

```bash
# From the root directory
docker-compose up -d --build
```
The server will be available at `ws://localhost:3000`.

### 2. Chrome Extension
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `extension/` folder.

## Usage
1. Open the extension popup.
2. Enter the Server URL (default: `ws://localhost:3000`).
3. Click **Join / Create Room**.
4. In the **Sync** tab, select the tab containing the video you want to sync.
5. Share the **Invite Link** (RoomID#Password) with your friends.
6. When they join, your play/pause/seek actions will be synchronized.
7. Use **Force Sync** to align everyone to your current timestamp.

## Technical Details
- **Manifest V3**: Uses a Service Worker for background tasks.
- **Native WebSockets**: The extension uses the native `WebSocket` API. 
  - > [!IMPORTANT]
  - > **Socket.IO Compatibility**: The server must use **Socket.IO v4**. The extension implements a subset of the Engine.IO/Socket.IO wire protocol.
- **Keep-Alive**: A `chrome.alarms` mechanism keeps the Service Worker active.
- **Two-Phase Force Sync**: Uses `pollSeekReady` to ensure all peers are synchronized before resuming.

## Security & Privacy

> [!IMPORTANT]
> **Privacy by Design**: KoalaSync is built with extreme data parsimony in mind.
> - **No Databases**: The server stores absolutely nothing on disk. All room states and peer mappings exist only in RAM and are destroyed as soon as a room is empty or inactive.
> - **No Tracking**: There is zero telemetry, analytics, or user tracking in both the extension and the server.
> - **Minimal Logging**: The server logs only technical events (connections, errors, rate-limiting) with no personally identifiable information (PII).
> - **Extension Permissions**: The `<all_urls>` permission is required solely to detect and synchronize HTML5 video elements on any website you visit. No browsing history is ever transmitted or stored.

- > [!WARNING]
  > **Invite Links**: Passwords in invite links (e.g., `RoomID#Password`) are shared in plaintext. This is a trade-off for convenience. For higher security, share the password via a secure channel.

## Troubleshooting
- **Logs**: Check the **Dev** tab in the extension popup for detailed connection logs.
- **Handshake**: Look for `Socket.IO Handshake: 0{...}` in the logs to verify successful connection.
- **Permissions**: Ensure you have granted the extension permission to access the video site's tab.
