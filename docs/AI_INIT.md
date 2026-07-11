# KoalaSync AI Onboarding (AI_INIT.md)

Welcome to the KoalaSync project. This file is the primary entry point for any developer or AI agent working on this codebase. It defines the architecture, non-negotiables, and workflows required to maintain the stability and security of the system.

> [!IMPORTANT]
> **Privacy & Data Sovereignty**: KoalaSync follows a strict **Zero-External-Requests Policy**: The extension and website must not make requests to any third-party domains (Google Fonts, CDNs, etc.). All assets (fonts, icons, scripts) must be self-hosted or use system defaults.
> - **Font Stack**: Use a modern system font stack (e.g., -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif) to maintain a premium look without external dependencies. Prohibit the use of `@import` or `<link>` for external font services.
> 
> [!IMPORTANT]
> **Communication Standard**: Be concise, concrete, and professional. Match the user's language when practical, explain risky changes before making them, and report exactly what was changed and verified. Do not use joke protocols or intentionally broken language in contributor-facing work.

---

## 1. Project Overview
KoalaSync is a specialized tool for **synchronized video playback** across multiple remote peers. It supports YouTube, Twitch, and native HTML5 video elements. 
- **Users**: Friends or groups wanting to watch synchronized content together.
- **Workflow**: A user creates a room, shares an invitation link, and all peers in that room are synchronized via a Node.js relay server.
- **Identity**: Users are identified by a unique hex `peerId` combined with a customizable `username`.

## 2. Repository Structure
- `extension/`: Browser Extension (Chrome & Firefox, Manifest V3). Contains background service worker, content scripts, and popup UI.
- `server/`: Node.js Relay Server using Socket.IO (WebSocket-only).
- `website/`: **Landing Page** & Invitation Bridge (Marketing, Tutorials, and Downloads).
  - **`build.cjs`**: Zero-dependency static site compiler. Translates `template.html` + `locales/*.json` → `www/`. Also minifies CSS/JS automatically.
  - **`www/` is auto-generated**: Never edit files in `www/` directly. Always edit source files (`template.html`, `style.css`, `app.js`, `lang-init.js`, `locales/*.json`) and run `node website/build.cjs` to regenerate. CSS/JS are output as `.min.*` files — a built-in cleanup step removes stale artifacts on each build.
- `shared/`: **Single Source of Truth** for protocol constants, event names, blacklist data, and generated usernames.
- `scripts/`: Development utilities (e.g., `build-extension.cjs`).
- `docker-compose.yml`: Root-level orchestration for the relay server.

> [!IMPORTANT]
> **Single Source of Truth**: `shared/constants.js`, `shared/blacklist.js`, and `shared/names.js` are the master shared files. They must be synchronized to the `extension/shared/` directory using `node scripts/build-extension.cjs`.
> - **Extension Modules** (`background.js`, `popup.js`) import directly from `./shared/constants.js`.
> - **Content Scripts** (`content.js`) use a **marker-injected synchronous copy** of the constants. The build script automatically replaces the marked blocks — no manual mirroring needed.

## 3. Mandatory Reading
Before touching any code, you MUST read the following documents in order:
1. [../README.md](../README.md) – User, developer, and self-hosting overview.
2. [README.md](README.md) – Documentation map by role.
3. [ARCHITECTURE.md](ARCHITECTURE.md) – Detailed communication flows, Dual Heartbeat, and two-phase sync protocol.
4. [../extension/README.md](../extension/README.md) – Extension components, tab structure, and loading process.
5. [SYNC_GUIDE.md](SYNC_GUIDE.md) – Protocol constants and synchronization requirements.

## 4. The "Vanilla JS Mirror" Pattern
To avoid boot-time race conditions in Manifest V3 without a bundler, the following architectural trade-off is enforced:
- **Synchronous Execution**: `content.js` MUST execute synchronously to catch early media events. 
- **Automated Injection**: The build script (`node scripts/build-extension.cjs`) automatically injects `EVENTS`, `HEARTBEAT_INTERVAL`, and episode utility functions into `content.js` using marker-based replacement (see `../scripts/README.md` for marker details).
- **Maintenance**: After modifying any root `shared/` file, run the build script. No manual mirroring is required.

## 5. File Responsibility Map

| File | Responsibility |
|:-----|:---------------|
| `background.js` | WebSocket client, state orchestrator, event router, session persistence |
| `content.js` | Video element detection, media control, event origin detection (loop prevention) |
| `popup.js` | UI rendering, user input handling, peer display, invitation link generation |
| `bridge.js` | Landing page ↔ extension communication for invitation join flow |
| `episode-utils.js` | Shared episode parsing, imported by background and injected into content |
| `title-privacy.js` | Tab/media title privacy normalization and sanitization |
| `page-api-seek-overrides.js` | Page-level seek bridge for site-specific player APIs |
| `server/index.js` | Room management, message relay, rate limiting, authentication, peer lifecycle |

## 6. Design Guidelines
The popup UI follows a strict design system. Do not modify these variables or the layout structure without explicit approval.
- **Font**: System font stack. **MANDATORY**: No external CDNs or Google Fonts to ensure 100% privacy.
- **Popup Width**: Fixed at `320px`.
- **Tab Structure**: Must maintain the visible **Room**, **Sync**, **Settings**, and **Status** tabs. The hidden **Dev** tab is available only for developer diagnostics.
- **CSS Variables**:
  | Variable | Value | Purpose |
  | :--- | :--- | :--- |
  | `--bg` | `#0f172a` | Main background |
  | `--card` | `#1e293b` | Form and info cards |
  | `--accent` | `#6366f1` | Primary actions and branding |
  | `--success` | `#22c55e` | Success states / Online dot |
  | `--error` | `#ef4444` | Errors / Offline dot |

## 7. Non-Negotiables (Core Logic)
The following features are critical and must not be removed or fundamentally altered:
- **Two-Phase Force Sync**: The `Prepare` → `ACK` → `Execute` flow ensures all peers are buffered before playback resumes.
- **Episode Auto-Sync**: Ensures series binges stay perfectly synced. A lobby initiates during title transitions, freezing peers until everyone is ready.
- **Host Control Mode**: In `host-only` rooms, only the host and promoted controllers may initiate room-moving playback events. Both client-side UX and server-side gates must remain intact.
- **Dual Heartbeat**: 
    - **Background Heartbeat (1m)**: Ensures session persistence even without a video element.
    - **Content Heartbeat (15s)**: Transmits current video metadata (time, title).
- **Dead Peer Pruning**: Server "Reaper" disconnects peers after 5 minutes of total silence (no heartbeats or events).
- **Deduplication**: Server kills old sockets if a user re-joins with the same `peerId` to prevent ghosts.
- **Platform Specifics**: Specialized click-logic for YouTube (`.ytp-play-button`) and Twitch.
- **pollSeekReady()**: Polling mechanism that checks `video.readyState` before acknowledging sync.
- **SW Keep-alive**: Use of `chrome.alarms` to prevent the Manifest V3 Service Worker from suspending.
- **Diagnostics**: The visible **Status** tab provides real-time access to connection state, ping, logs, history, and underlying `<video>` state for troubleshooting.
- **Persistence**: `peerId` and `username` must be stored to remain stable across sessions.
- **Title Privacy**: Do not accidentally reintroduce tab/media title sharing when users disabled or reduced it.
- **Room ID Format**: Room IDs are restricted to `[a-zA-Z0-9-]` only (alphanumeric + hyphens). This is enforced server-side.

## 8. Technical Constraints
- **No Bundler**: The extension uses plain ES Modules. Do not introduce build steps or npm packages into the `extension/` folder.
- **Manual Protocol**: `background.js` implements a subset of the Socket.IO wire protocol natively.
- **Server Transport**: Restricted to `websocket` only. Polling is disabled.
- **Docker Context**: The Docker build must run from the **Repo Root**.
- **Content Script Scope**: `bridge.js` is the only static content script in the manifest and runs on `https://sync.koalastuff.net/*` at `document_start`. Video control scripts are injected only into the selected tab via `chrome.scripting`; do not add broad persistent video content-script matches.
- **Self-Hosting Salt**: Production/self-hosted relay examples must include a unique `SERVER_SALT` so room-password hashes are not derived with the public fallback salt.
- **Strict Backward & Forward Compatibility (Store Delay Rule)**: Browser extensions are distributed through stores (e.g., Chrome Web Store, Firefox Add-ons) which can take up to 2 weeks to approve updates. Therefore, the server MUST NOT reject older extension clients unless a critical protocol version bump is explicitly authorized, and new extension versions MUST remain fully operational when connected to older servers (e.g., by silently falling back if a new feature is not supported). This is a core architectural requirement.

## 9. Security & Deployment
- **Tokens**: Security tokens are intentionally managed via `shared/constants.js` and server `.env`.
- **Environment**: `.env` is excluded via `.gitignore`. Only `.env.example` should be committed.
- **Revocation**: `MIN_VERSION` check on the server is used to deprecate old extension versions.
- **Invitation Links**: Correctly propagate server URLs, Room IDs, and Passwords via the URL hash to the bridge.

## 10. Common Workflows

## CRITICAL: Git & Release Rules

- **NEVER** push, commit, tag, or release without explicit user instruction.
- **NEVER** retag or force-push without explicit instruction.
- **NEVER** create tags for documentation-only or README changes.
- **NEVER** run `git push`, `git tag`, `git commit` unless the user says "push", "commit", or "tag".
- Only the user decides when to commit, push, tag, or release.
- Ask before any git write operation.

### ⚠️ Pre-Session Git Sync (MANDATORY)
Before starting any task, committing, or pushing, you **MUST** run `git pull --rebase` to ensure your local branch is up-to-date with `origin/main`. CI pipelines and other agents may push commits concurrently. Skipping this step will cause merge conflicts and rejected pushes.

### Releasing a New Version (CRITICAL WORKFLOW FOR AI AGENTS)
> [!CAUTION]
> **AI AGENTS MUST FOLLOW THIS EXACT SEQUENCE WHEN RELEASING A NEW VERSION OR TAGGING.**
> 
> **🚫 NO MANUAL VERSION BUMPING**: You MUST **NEVER** manually modify the version strings in `package.json`, `extension/manifest.base.json`, or `website/version.json`. The GitHub Actions CI pipeline automatically extracts the version from the git tag (e.g. `v2.0.5` -> `2.0.5`), injects it into all target files, and commits the updates back to `main` with `[skip ci]`. Manual bumps will cause merge conflicts and build failures.
> - **Website Versioning**: **NEVER** manually modify generated version strings in `website/www/`. The website build injects version data from `website/version.json` into generated output.
1. **MANDATORY SYNTAX & LINT CHECKS**: Before staging, committing, or pushing any changes, you **MUST** run both checks on every modified JavaScript file:
   - **Syntax Validation**: Run `node -c` on every single modified JavaScript file (e.g., `node -c extension/background.js` and `node -c extension/content.js`). **NEVER** commit or push code that fails this check.
   - **ESLint Validation**: Run `npm run lint` (or `npx eslint .`). The output must show **zero errors and zero warnings**. ESLint is configured to catch undefined variables, unused vars, unreachable code, and other semantic issues. **NEVER** commit or push code that fails this check.
2. Commit all verified code changes and push to `main`.
3. Create and push a new tag. **MANDATORY**: Tags MUST start with a `v` (e.g., `v1.4.0`). The GitHub Actions release workflow is strictly configured to ignore any tags without the `v` prefix.
   - **🚫 TAG IMMUTABILITY**: Once a tag is pushed to `origin`, it is **PERMANENT**. You MUST **NEVER** reuse, move, or force-push an existing tag — not even to "fix" a mistake. If a release is missing a fix, increment the version and create a **new** tag (e.g., `v1.7.0` → `v1.7.1`). Tags are immutable identifiers; moving them breaks CI pipelines, corrupts the release history, and causes unreproducible builds.
   - **🚫 WHEN NOT TO TAG**: Do NOT create a release tag for changes that do NOT affect the shipped extension or server artifacts. Website text changes, documentation updates (`.md` files), and landing page content do NOT require a version tag. Tags trigger the full CI pipeline (Docker build, extension packaging, GitHub Release) — running this for a typo fix wastes CI resources and creates meaningless releases. Only tag when extension code (`extension/`), server code (`server/`), or shared protocol constants (`shared/`) have changed.
4. The CI will extract the version from the tag (e.g., `v1.4.0` → `1.4.0`), inject it into all source files, build the extension artifacts, publish the Docker image, and create a GitHub Release.
5. Verify the release builds on GitHub Actions.

### 🚫 Force Push Policy
> [!CAUTION]
> **Force pushing (`git push --force` or `git push -f`) is FORBIDDEN without explicit user confirmation.**
> - If a push is rejected due to a non-fast-forward conflict, you **MUST** run `git pull --rebase` first.
> - If a force push is absolutely required (e.g., squashed history, amended commits), you **MUST** ask the user for explicit permission with a clear explanation of why it's necessary. Never force-push autonomously.
> - This applies to both branches (`main`) and **tags** (see Tag Immutability above). Force-pushing tags is doubly destructive. Never do it.

### Adding a Protocol Event
1. Add the event name to `shared/constants.js`.
2. Run the build script (`node scripts/build-extension.cjs`).
3. Implement the handler in `server/index.js` and `background.js`.

### Making Website Changes
1. Edit source files in `website/` (`template.html`, `style.css`, `app.js`, `lang-init.js`, or `locales/*.json`).
2. Run the compiler: `node website/build.cjs`. This generates the multilingual pages in `www/` and minifies CSS/JS.
3. Verify the output: `node --check website/www/app.min.js && node --check website/www/lang-init.min.js`.
4. Test locally: `npx serve website/www` or `python3 -m http.server 8080 -d website/www`.
5. Commit both source changes and the updated `www/` output.

### Testing Locally
1. Run the build script: `node scripts/build-extension.cjs`.
2. Load `dist/chrome/` as an "Unpacked Extension" in Chrome (or `dist/firefox/` in Firefox).
3. Start the server from the root: `docker compose up --build`.
4. Use **different browser profiles** or vendors to test multi-peer logic.
5. Use the **Status tab** to verify real-time connection state, logs, and video element metadata.

### Locking Old Versions
1. Update `MIN_VERSION` in the server's `.env` file to the minimum acceptable version.
2. Restart the server. Older extensions will be rejected with a "Version too old" error.
