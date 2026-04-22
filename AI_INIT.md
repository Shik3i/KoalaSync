# KoalaSync AI Onboarding (AI_INIT.md)

Welcome to the KoalaSync project. This file is the primary entry point for any developer or AI agent working on this codebase. It defines the architecture, non-negotiables, and workflows required to maintain the stability and security of the system.

> [!IMPORTANT]
> **Privacy & Data Sovereignty**: KoalaSync follows a strict **Zero-External-Requests Policy**: The extension and website must not make requests to any third-party domains. All assets must be self-hosted.
> - **Font Stack**: Use a modern system font stack to maintain a premium look without external dependencies.

---

## 1. Project Overview
KoalaSync is a specialized tool for **synchronized video playback** across multiple remote peers. 
- **Workflow**: A user creates a room, shares an invitation link, and all peers are synchronized via a Node.js relay server.
- **Identity**: Users are identified by a unique hex `peerId` combined with a customizable `username`.

## 2. Repository Structure
- `extension/`: Chrome Extension (Manifest V3).
- `server/`: Node.js Relay Server using Socket.IO (WebSocket-only).
- `website/`: Landing Page & Invitation Bridge.
- `shared/`: Single Source of Truth for protocol constants and event names.

## 3. Mandatory Reading
1. [ARCHITECTURE.md](ARCHITECTURE.md) – Communication flows and Dual Heartbeat protocol.
2. [extension/README.md](extension/README.md) – UI structure and component overview.

## 4. Design Guidelines
- **Popup Width**: Fixed at `320px`.
- **Tab Structure**: **Room**, **Sync**, **Settings**, and **Dev**.
- **CSS Variables**: Uses the CSS variables defined in `popup.html` for a consistent Dark Mode / Glassmorphic look.

## 5. Non-Negotiables (Core Logic)
- **Two-Phase Force Sync**: `Prepare` → `ACK` → `Execute` flow for frame-perfect sync.
- **Dual Heartbeat**: 
    - **Background Heartbeat (30s)**: Keeps the session alive even without a video.
    - **Content Heartbeat (15s)**: Transmits current video metadata (title, time).
- **Dead Peer Pruning**: Server automatically disconnects peers after 5 minutes of total silence.
- **Deduplication**: Server kills old sockets if a user re-joins with the same `peerId`.
- **Diagnostics**: The "Dev" tab provides real-time access to the underlying `<video>` state for troubleshooting.

## 6. Technical Constraints
- **No Bundler**: Plain ES Modules only.
- **Socket.IO Protocol**: Manual implementation of the wire protocol in `background.js`.
- **Docker Context**: Must build from the **Repo Root**.

## 7. Security & Deployment
- **Invitation Links**: Correctly propagate server URLs and room credentials via the URL hash.
- **Rate Limiting**: IP and socket-based limits are enforced server-side.
- **Persistence**: `peerId` and `username` must persist across browser sessions.

## 8. Common Workflows

### Modifying the Protocol
1. Edit `shared/constants.js`.
2. Run `scripts/sync-constants.bat` (Windows) or `scripts/sync-constants.sh` (POSIX).
3. Restart the server and reload the extension.

### Testing
- Use **different browser profiles** or vendors to test multi-peer logic locally.
- Use the **Dev tab** to verify that the extension is correctly detecting the video state.
