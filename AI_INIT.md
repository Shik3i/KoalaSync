# KoalaSync AI Onboarding (AI_INIT.md)

Welcome to the KoalaSync project. This file is the primary entry point for any developer or AI agent working on this codebase. It defines the architecture, non-negotiables, and workflows required to maintain the stability and security of the system.

> [!IMPORTANT]
> **Privacy & Data Sovereignty**: KoalaSync follows a strict **Zero-External-Requests Policy**: The extension and website must not make requests to any third-party domains (Google Fonts, CDNs, etc.). All assets (fonts, icons, scripts) must be self-hosted or use system defaults.
> - **Font Stack**: Use a modern system font stack (e.g., -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif) to maintain a premium look without external dependencies. Prohibit the use of `@import` or `<link>` for external font services.

---

## 1. Project Overview
KoalaSync is a specialized tool for **synchronized video playback** across multiple remote peers. It supports YouTube, Twitch, and native HTML5 video elements. 
- **Users**: Friends or groups wanting to watch synchronized content together.
- **Workflow**: A user creates a room, shares an invitation link, and all peers in that room are synchronized via a Node.js relay server.
- **Identity**: Users are identified by a unique hex `peerId` combined with a customizable `username`.

## 2. Repository Structure
- `extension/`: Chrome Extension (Manifest V3). Contains background service worker, content scripts, and popup UI.
- `server/`: Node.js Relay Server using Socket.IO (WebSocket-only).
- `website/`: **Landing Page** & Invitation Bridge (Marketing, Tutorials, and Downloads).
- `shared/`: **Single Source of Truth** for protocol constants and event names.
- `scripts/`: Utility scripts (e.g., `sync-constants.sh`).
- `docker-compose.yml`: Root-level orchestration for the relay server.

> [!IMPORTANT]
> **Single Source of Truth**: `shared/constants.js` and `shared/blacklist.js` are the master files. They must be synchronized to the `extension/shared/` directory using `.\scripts\sync-constants.bat` or `./scripts/sync-constants.sh`. 
> - **Extension Modules** (`background.js`, `popup.js`) import directly from `./shared/constants.js`.
> - **Content Scripts** (`content.js`) use a **manual synchronous mirror** to prevent race conditions during page load. Always verify parity after sync.

## 3. Mandatory Reading
Before touching any code, you MUST read the following documents in order:
1. [ARCHITECTURE.md](ARCHITECTURE.md) – Detailed communication flows, Dual Heartbeat, and two-phase sync protocol.
2. [extension/README.md](extension/README.md) – Extension components, tab structure, and loading process.
3. [SYNC_GUIDE.md](SYNC_GUIDE.md) – Protocol constants and synchronization requirements.

## 4. The "Vanilla JS Mirror" Pattern
To avoid boot-time race conditions in Manifest V3 without a bundler, the following architectural trade-off is enforced:
- **Synchronous Execution**: `content.js` MUST execute synchronously to catch early media events. 
- **Manual Mirroring**: `content.js` maintains a manual mirror of the `EVENTS` constants from `shared/constants.js`.
- **Maintenance**: Developers must ensure that any changes to `shared/constants.js` are manually reflected in `content.js` after running the sync scripts.

## 5. Design Guidelines
The popup UI follows a strict design system. Do not modify these variables or the layout structure without explicit approval.
- **Font**: System font stack. **MANDATORY**: No external CDNs or Google Fonts to ensure 100% privacy.
- **Popup Width**: Fixed at `320px`.
- **Tab Structure**: Must maintain the **Room**, **Sync**, **Settings**, and **Dev** tabs.
- **CSS Variables**:
  | Variable | Value | Purpose |
  | :--- | :--- | :--- |
  | `--bg` | `#0f172a` | Main background |
  | `--card` | `#1e293b` | Form and info cards |
  | `--accent` | `#6366f1` | Primary actions and branding |
  | `--success` | `#22c55e` | Success states / Online dot |
  | `--error` | `#ef4444` | Errors / Offline dot |

## 5. Non-Negotiables (Core Logic)
The following features are critical and must not be removed or fundamentally altered:
- **Two-Phase Force Sync**: The `Prepare` → `ACK` → `Execute` flow ensures all peers are buffered before playback resumes.
- **Dual Heartbeat**: 
    - **Background Heartbeat (30s)**: Ensures session persistence even without a video element.
    - **Content Heartbeat (15s)**: Transmits current video metadata (time, title).
- **Dead Peer Pruning**: Server "Reaper" disconnects peers after 5 minutes of total silence (no heartbeats or events).
- **Deduplication**: Server kills old sockets if a user re-joins with the same `peerId` to prevent ghosts.
- **Platform Specifics**: Specialized click-logic for YouTube (`.ytp-play-button`) and Twitch.
- **pollSeekReady()**: Polling mechanism that checks `video.readyState` before acknowledging sync.
- **SW Keep-alive**: Use of `chrome.alarms` to prevent the Manifest V3 Service Worker from suspending.
- **Diagnostics**: The "Dev" tab provides real-time access to the underlying `<video>` state for troubleshooting.
- **Persistence**: `peerId` and `username` must be stored to remain stable across sessions.

## 6. Technical Constraints
- **No Bundler**: The extension uses plain ES Modules. Do not introduce build steps or npm packages into the `extension/` folder.
- **Manual Protocol**: `background.js` implements a subset of the Socket.IO wire protocol natives.
- **Server Transport**: Restricted to `websocket` only. Polling is disabled.
- **Docker Context**: The Docker build must run from the **Repo Root**.
- **Manifest Settings**: `run_at` must remain `document_idle`, and `all_frames` must remain `false`.

## 7. Security & Deployment
- **Tokens**: Security tokens are intentionally managed via `shared/constants.js` and server `.env`.
- **Environment**: `.env` is excluded via `.gitignore`. Only `.env.example` should be committed.
- **Revocation**: `MIN_VERSION` check on the server is used to deprecate old extension versions.
- **Invitation Links**: Correctly propagate server URLs, Room IDs, and Passwords via the URL hash to the bridge.

## 8. Common Workflows

### Adding a Protocol Event
1. Add the event name to `shared/constants.js`.
2. Run the sync script (`.\scripts\sync-constants.bat` or `./scripts/sync-constants.sh`).
3. Implement the handler in `server/index.js` and `background.js`.

### Testing Locally
1. Load `extension/` as an "Unpacked Extension" in Chrome.
2. Start the server from the root: `docker-compose up --build`.
3. Use **different browser profiles** or vendors to test multi-peer logic.
4. Use the **Dev tab** to verify real-time video element metadata.

### Locking Old Versions
1. Increase `APP_VERSION` in `shared/constants.js`.
2. Update `MIN_VERSION` in the server's `.env` file and restart.
