# KoalaSync

KoalaSync is a premium, lightweight Chrome Extension and Relay Server for synchronized video playback across any website (YouTube, Twitch, Netflix, and custom HTML5 players).

> [!TIP]
> **New Developers & AI Agents**: Please read [AI_INIT.md](AI_INIT.md) before starting work.

## Repository Structure
- `extension/`: Chrome Extension (Manifest V3, Vanilla JS).
- `server/`: Node.js + Socket.IO Relay Server (Containerized).
- `website/`: Marketing landing page & **Invitation Bridge**.
- `shared/`: Protocol constants and domain blacklist.
- `scripts/`: Development utilities for protocol synchronization.

> [!NOTE]
> For deep technical dives, see [ARCHITECTURE.md](ARCHITECTURE.md) and [SYNC_GUIDE.md](SYNC_GUIDE.md).

## Key Features
- **Global Synchronization**: Synchronize Play, Pause, and Seeking on any website with a `<video>` tag.
- **Smart Matching**: Automatically highlights and sorts tabs containing matching video titles.
- **Noise Filtering**: Built-in domain blacklist to hide non-video sites from selection.
- **Smart Identity**: Customizable usernames combined with unique hexadecimal peer IDs.
- **Dual Heartbeat Architecture**: Robust session tracking that prevents ghost rooms and stale connections.
- **Zero-Latency Relay**: Custom Socket.IO wire protocol implementation for maximum performance.
- **Integrated Diagnostics**: A dedicated "Dev" tab for real-time video state debugging.
- **Seamless Invitations**: Smart invitation links that automatically configure the server and room credentials for your friends.

## Setup Instructions

### 1. Relay Server (Docker)
The server runs on Node.js using Socket.IO, containerized for easy deployment.

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
1. Open the extension and go to the **Settings** tab to set your **Username**.
2. Go to the **Room** tab, enter your Server URL (default: `ws://localhost:3000`), and click **Join / Create Room**.
3. In the **Sync** tab, select the tab containing the video you want to sync.
4. Share the **Invite Link** from the Room tab. When your friends click it, they will automatically join your room and server.
5. Use **Force Sync** to perfectly align everyone to your current timestamp.

## Technical Details
- **Manifest V3**: Uses a persistent Service Worker with Alarm-based keep-alive.
- **Manual Socket.IO Protocol**: The extension implements the Socket.IO v4 wire protocol natively for extreme performance and zero dependencies.
- **Dead Peer Pruning**: The server automatically prunes peers after 5 minutes of total inactivity (detected via dual heartbeats).
- **Two-Phase Sync**: Ensures all peers are buffered (`readyState >= 3`) before resuming playback.

## Security & Privacy
> [!IMPORTANT]
> **Privacy First**: KoalaSync stores no data on disk. All room states exist only in RAM and are purged immediately when empty. There is zero telemetry, tracking, or analytics.

## Troubleshooting
- **Logs**: Check the **Dev** tab in the extension popup for live connection logs and video state diagnostics.
- **Handshake**: Verify you see `Joined Namespace /` in the logs.
- **Permissions**: Ensure the target site hasn't blocked script injection (rare for most video sites).
