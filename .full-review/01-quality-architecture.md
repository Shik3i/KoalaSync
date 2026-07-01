# Phase 1: Code Quality & Architecture Review

## Code Quality Findings

### Critical

**CQ-1: background.js is 2,418 lines**  
*File: `extension/background.js`*  
*Severity: High*  
The background service worker handles WebSocket connections, room management, peer synchronization, force sync coordination, episode lobby logic, ping/latency, notification system, reconnection logic, UI state management, and routing — an enormous responsibility single-handedly. Any single change risks unintended side effects. **Recommendation: Extract logical modules into separate files (e.g., `socket-connector.js`, `room-manager.js`, `force-sync.js`, `episode-lobby.js`, `notification-manager.js`).**

**CQ-2: content.js is 1,525 lines**  
*File: `extension/content.js`*  
*Severity: High*  
The content script manages video detection, play/pause coalescing, seek filtering, episode auto-sync, host control mode UI (dialog + badge), audio processing, Shadow DOM rendering, and platform-specific overrides. It should be decomposed into focused modules for video handling, HCM UX, and audio processing.

**CQ-3: popup.js is 1,100+ lines**  
*File: `extension/popup.js`*  
*Severity: High*  
The popup contains extensive UI rendering logic, peer list rendering with role badges, history rendering, room list management, tab matching with smart detection, debug info, onboarding, feature hints, and host control UI — all in a single file. **Recommendation: Extract into `popup-ui.js` (DOM rendering), `popup-state.js` (state management), and `popup-events.js` (message routing).**

### High

**HQ-1: Duplicate event constants between shared/constants.js and content.js**  
*Files: `shared/constants.js`, `extension/content.js:17-29`*  
The `SHARED_EVENTS_INJECT_START/END` block in content.js duplicates the EVENTS object from shared/constants.js. If an event is added to the shared file but the inject block is not updated, the content script won't recognize it. **Recommendation: Ensure the build step properly propagates all event names, or reduce the duplication footprint by only injecting the subset content.js needs.**

**HQ-2: Duplicate episode utils (content.js vs episode-utils.js)**  
*Files: `extension/content.js:601-618`, `extension/episode-utils.js`*  
The `extractEpisodeId` and `sameEpisode` functions exist in both files. The build script injects a copy of episode-utils.js into content.js. Same duplication risk as CQ-1 — out-of-sync copies cause bugs.

**HQ-3: Hardcoded server token in shared/constants.js line 14**  
*File: `shared/constants.js:14`*  
`OFFICIAL_SERVER_TOKEN` is a plaintext token visible in source code. While the server validates this token on every connection, it means anyone who sees the token can authenticate. This is a design decision (token is in the extension source which is always visible) but should be documented with a recommendation to rotate it.

**HQ-4: Massive CSS file (2,966 lines)**  
*File: `website/style.css`*  
The stylesheet has no apparent component-based structure or separation. While CSS does not have native module scoping, adding section comments, a design token system, and BEM-like naming would improve maintainability.

### Medium

**MQ-1: Numerous magic numbers throughout the codebase**  
While many values are now constants (e.g., `ROOM_LIST_COOLDOWN_MS`), there are still scattered magic numbers in background.js (e.g., line 267: `MAX_RECONNECT_ATTEMPTS = 20`, line 615: `if (!finalUrl.includes('://'))`), content.js (`MIN_SEEK_DELTA = 2.0`, `PLAY_PAUSE_COALESCE_MS = 150`), and popup.js (`ROOM_LIST_REFRESH_COOLDOWN_MS = 11000`). **Recommendation: Centralize configuration constants into a single config module.**

**MQ-2: Inconsistent peer data shapes**  
Throughout the codebase, peers are sometimes strings (just peerId) and sometimes objects with full properties. The `createPeerData()` factory exists but is not always used on the receiving side. The popup also does inline checks like `(typeof p === 'object' ? p.peerId : p)` repeatedly. **Recommendation: Enforce object shape everywhere; deprecate string peer references.**

**MQ-3: Repeated chrome.runtime.sendMessage().catch(() => {})**  
This pattern appears 40+ times across background.js and content.js. Silently swallowing all messages means real errors (e.g., "Receiving end does not exist") are logged once at the `.catch()` but most issues are completely invisible. **Recommendation: Implement a message result handler that logs failures and optionally surfaces them to the debug log.**

**MQ-4: `forEach` over Maps with mutation**  
*File: `server/rate-limiter.js:130-133`*  
Iterating over `failedAuthAttempts` with `for...of` inside `setInterval` is safe (Map iterator snapshot), but the deletion pattern could lose entries if the map grows mid-iteration. The cleanup in `server/rate-limiter.js:138-157` similarly iterates and deletes from the same map being traversed. **Recommendation: Snapshot keys before iterating for mutation.**

**MQ-5: `Object.assign({}, enDict, targetDict)` for i18n merge**  
*File: `extension/i18n.js:48`*  
Uses shallow merge, which means nested objects in translation dicts (if any are ever added) won't deep merge. Currently safe since values are flat strings, but a fragile assumption.

### Low

**LQ-1: Long function names with cryptic abbreviations in server**  
Constants like `ROOM_LIST_COOLDOWN_MS`, `ADMIN_METRICS_AUTH_RATE_LIMIT_PER_MINUTE`, and variable names like `hcmDesynced`, `epLobby` are readable but dense. The code has excellent inline documentation that compensates, but the naming is very developer-insider focused.

**LQ-2: `console.warn` used for security notices in server**  
*File: `server/index.js:64, 68`*  
Security warnings are written to console rather than a structured logger or config validation step. In production, this could be missed. **Recommendation: Use a structured init validation step that exits or alerts on critical config failures.**

**LQ-3: Extension build scripts use `.cjs` for CommonJS**  
*File: `scripts/build-extension.cjs`*  
This is a reasonable choice for Node projects migrating to ESM, but the mix of `.mjs`, `.cjs`, and `.js` (ESM) files across the project could confuse new developers.

---

## Architecture Findings

### Critical

**CA-1: Single-server in-memory room state with no persistence**  
*File: `server/index.js:149`*  
`const rooms = new Map();` — all room state lives in process memory. A server restart (crash, deployment, OOM kill) loses all active rooms, sessions, and peer positions. WebSocket connections are re-established but peers re-join as strangers. **Recommendation: Add Redis or a lightweight persistent store for room state, or at minimum use process-wide state that survives crashes via a watchdog.**

**CA-2: No authentication beyond a shared token**  
*File: `server/index.js:303`*  
The authentication model (`clientToken !== OFFICIAL_SERVER_TOKEN`) uses a single shared secret. Any device with the extension has the same token — there is no per-user authentication, no session isolation, and anyone who reverse-engineers the token can impersonate any client. This is an acceptable trade-off for a simple sync service, but the architecture should document this security boundary.

### High

**HA-1: Server has no horizontal scaling path**  
*File: `server/index.js:127-142`*  
Since rooms are stored in a single process's memory, running multiple server instances does nothing — peers can only connect to one server. Socket.IO rooms won't cross instances. **Recommendation: For multi-instance deployment, use Socket.IO Redis adapter and external session storage.**

**HA-2: Server has no graceful shutdown of WebSocket connections**  
*File: `server/index.js:918-931`*  
The graceful shutdown sends an error event, closes the HTTP server, and forces exit after 5 seconds. However, it doesn't await all WebSocket disconnections before exiting. A client might be mid-force-sync when the server exits.

**HA-3: No API versioning or deprecation policy**  
*File: `shared/constants.js:9`*  
`PROTOCOL_VERSION` is defined but there's no documented API versioning strategy. Adding a new event or changing an event payload could break older clients. The server has `MIN_VERSION` enforcement (line 59) but no way to serve version-specific behavior.

**HA-4: Tightly coupled extension-server protocol**  
The extension server URL is hardcoded (`OFFICIAL_SERVER_URL`) and every feature addition requires coordinated changes to: shared constants, server handlers, background.js event handlers, content.js event handlers, and popup UI. There's no independent evolution path for any component.

### Medium

**MA-1: Good rate limiting architecture with multiple layers**  
*File: `server/index.js:286-837`, `server/rate-limiter.js`*  
Connection rate (per IP), event rate (per socket), health endpoint rate (per IP), auth failure tracking (per IP+Room), and room list cooldown (per socket) — this is comprehensive and well-structured. The cleanup intervals prevent unbounded Map growth.

**MA-2: Good peer deduplication and concurrency controls**  
*File: `server/index.js:381-449`*  
Room creation locks, peer join locks, and dedup logic prevent race conditions. The pattern of acquiring a promise-based lock before async operations is clean.

**MA-3: Clean event relay with sanitization**  
*File: `server/index.js:579-619`*  
The relay pipeline sanitizes ALL incoming data before forwarding (clamp strings, validate numbers, whitelist booleans), then constructs a clean payload with only known fields. This is a solid security pattern.

**MA-4: Shadow DOM for in-page HCM dialog**  
*File: `extension/content.js:280-332`*  
Using Shadow DOM to create a CSP-safe UI overlay that can't be hidden by the page's CSS is an excellent architectural decision for content scripts running on sites like Netflix/YouTube.

### Low

**LA-1: Website uses inline JavaScript in HTML template**  
*File: `website/template.html` likely inlines app.js*  
The website is essentially a static HTML/JS/CSS app. The `app.js` at 778 lines handles page routing, language switching, invite detection, and UI animations — most of it DOM manipulation. Could benefit from a lightweight component framework for state management.

**LA-2: No Docker Compose for local development**  
*File: `docker-compose.yml` exists but only likely for production*  
Would be helpful to have a docker-compose setup that spins up the server, a dev server for the website, and the Chrome extension in watch mode.

---

## Critical Issues for Phase 2 Context

### Security-relevant

1. **Hardcoded SERVER_SALT default** (`server/index.js:52: 'koalasync_salt_3i'`) — If SERVER_SALT env var is not set, the salt is publicly visible in the repo. Password hashes could be verified offline by anyone.

2. **All client data is relayed to all room peers** with only field sanitization — no message-level encryption. Content of playback events (titles, positions) is sent in plaintext to all connected peers.

3. **CORS allows any `chrome-extension://` or `moz-extension://` origin** — these origin wildcards are inherently trusted by the browser, but the server should explicitly validate the extension ID if possible.

4. **No rate limit on LEAVE_ROOM** — A peer could spam leave/join to flood room broadcast events to other peers.

5. **ADMIN_METRICS_TOKEN weakness check** uses only length (32 chars) — no entropy requirement. A 32-character dictionary word string would pass but be weak against brute force.

### Performance-relevant

1. **In-memory Maps with no TTL** — While cleanup intervals exist, the `roomListCooldowns` Map stores socketIds which are per-connection and are only cleaned when the socket disconnects. Long-lived pages that rapidly join/leave rooms could cause growth.

2. **`updatePeerList()` re-renders DOM on every peer change** — The popup renders all peers on every state change. With 25 peers (MAX_PEERS_PER_ROOM), each with complex DOM including avatars, role badges, and volume icons, and interpolation updating times every second, this creates significant DOM churn.

3. **`Array.from(room.entries())` snapshot + double lookup in cleanup** — Server cleanup snapshots room keys, then does `rooms.get(roomId)` again within the loop. This is defensive (room may be deleted between snapshot and now) but adds redundant work.

4. **No pagination on room list** — `GET_ROOMS` returns all rooms to all clients. With MAX_ROOMS=1000, each client receives a 1000-element array on every refresh.
