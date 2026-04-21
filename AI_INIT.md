# KoalaSync AI Onboarding (AI_INIT.md)

Welcome to the KoalaSync project. This file is the primary entry point for any developer or AI agent working on this codebase. It defines the architecture, non-negotiables, and workflows required to maintain the stability and security of the system.

---

## 1. Project Overview
KoalaSync is a specialized tool for **synchronized video playback** across multiple remote peers. It supports YouTube, Twitch, and native HTML5 video elements. 
- **Users**: Friends or groups wanting to watch synchronized content together.
- **Workflow**: A user creates a room, shares an invite link (RoomID#Password), and all peers in that room are synchronized via a Node.js relay server.

## 2. Repository Structure
- `extension/`: Chrome Extension (Manifest V3). Contains background service worker, content scripts, and popup UI.
- `server/`: Node.js Relay Server using Socket.IO (WebSocket-only).
- `shared/`: **Single Source of Truth** for protocol constants and event names.
- `scripts/`: Utility scripts (e.g., `sync-constants.sh`).
- `docker-compose.yml`: Root-level orchestration for the relay server.

> [!IMPORTANT]
> `shared/constants.js` and `shared/blacklist.js` must be synchronized to the `extension/shared/` directory after every modification by running `./scripts/sync-constants.sh`.

## 3. Mandatory Reading
Before touching any code, you MUST read the following documents in order:
1. [ARCHITECTURE.md](ARCHITECTURE.md) – Detailed communication flows and two-phase sync protocol.
2. [shared/README.md](shared/README.md) – Protocol constants and synchronization requirements.
3. [extension/README.md](extension/README.md) – Extension components and loading process.
4. [server/README.md](server/README.md) – Server setup, Docker configuration, and security.

## 4. Design Guidelines
The popup UI follows a strict design system. Do not modify these variables or the layout structure without explicit approval.
- **Font**: 'Outfit' (Google Fonts).
- **Popup Width**: Fixed at `320px`.
- **Tab Structure**: Must maintain the **Room**, **Sync**, and **Dev** tabs.
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
- **Platform Specifics**: Specialized click-logic for YouTube (`.ytp-play-button`) and Twitch play/pause buttons in `content.js`.
- **pollSeekReady()**: The polling mechanism that checks `video.readyState` and `currentTime` offset before acknowledging a sync command.
- **SW Keep-alive**: Use of `chrome.alarms` to prevent the Manifest V3 Service Worker from suspending.
- **Exponential Backoff**: Reconnection logic in `background.js` (1s → 30s max).
- **Rate Limiting**: IP-based connection limits (10/min) and socket-based event limits (30/10s) on the server.
- **Security**: Token validation during the initial WebSocket handshake.
- **Persistence**: `peerId` must be stored in `chrome.storage.local` to remain stable across sessions.

## 6. Technical Constraints
- **No Bundler**: The extension uses plain ES Modules. Do not introduce build steps or npm packages into the `extension/` folder.
- **Manual Protocol**: `background.js` implements a subset of the Socket.IO wire protocol (e.g., `42[...]` framing) to work with native WebSockets.
- **Server Transport**: Restricted to `websocket` only. Polling is disabled.
- **Docker Context**: The Docker build must run from the **Repo Root**, as it needs access to the `shared/` directory.
- **Manifest Settings**: `run_at` must remain `document_idle`, and `all_frames` must remain `false`.

## 7. Security & Deployment
- **Tokens**: `OFFICIAL_SERVER_TOKEN` and `OFFICIAL_SERVER_URL` are intentionally hardcoded in `constants.js` by design.
- **Environment**: `.env` is excluded via `.gitignore`. Only `.env.example` should be committed.
- **Revocation**: `MIN_VERSION` in the server configuration is the only way to deprecate old extension versions.
- **Token Rotation**: Requires updating `shared/constants.js`, running the sync script, incrementing the extension version, and re-deploying the server.

## 8. Common Workflows

### Adding a Protocol Event
1. Add the event name to `shared/constants.js`.
2. Run `./scripts/sync-constants.sh`.
3. Implement the handler in `server/index.js` and `background.js`.

### Testing Locally
1. Load `extension/` as an "Unpacked Extension" in Chrome.
2. Start the server from the root: `docker-compose up --build`.
3. Select "Custom" server in the popup and enter `ws://localhost:3000`.

### Locking Old Versions
1. Increase `APP_VERSION` in `shared/constants.js`.
2. Update `MIN_VERSION` in the server's `.env` file.
3. Restart the server.
