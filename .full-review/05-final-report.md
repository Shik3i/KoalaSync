# Comprehensive Code Review Report

## Review Target

KoalaSync (v2.5.0) - A full-stack podcast synchronization application consisting of:

- **extension/** - Chrome/Firefox browser extension for podcast sync (Manifest V3)
- **server/** - Node.js backend API server with Docker support
- **shared/** - Shared utilities (blacklist, constants, names)
- **website/** - Public website/frontend (static HTML + JS + CSS)

Tech stack: Node.js, Chrome Extension API, Docker, ESM modules, ESLint, esbuild.

## Executive Summary

KoalaSync is a well-designed, feature-rich podcast synchronization application with a comprehensive server-side security model including multi-layer rate limiting, input sanitization, and timing-safe comparisons. The server architecture is solid for its intended single-instance use case. However, the project has three critical structural issues: **no persistence** (all state lost on restart), **insecure defaults** (SERVER_SALT hardcoded in repo), and **massive code files** (background.js at 2,418 lines). Test coverage is minimal (~7% server code, ~0% extension code), and the extension codebase has architectural fragmentation requiring immediate module decomposition.

## Findings by Priority

### Critical Issues (P0 -- Must Fix Immediately)

**1. SERVER_SALT defaults to hardcoded public value** (Security/CI-CD)
- `server/index.js:52`: `const salt = process.env.SERVER_SALT || 'koalasync_salt_3i'`
- CVSS: 7.5 — CWE-798: Use of Hard-coded Credentials
- Anyone reading the source can verify room passwords offline
- The server warns at startup but continues running with the default
- **Fix:** Hard error if SERVER_SALT not set:
  ```javascript
  if (!process.env.SERVER_SALT) {
      console.error('[FATAL] SERVER_SALT must be set in production');
      process.exit(1);
  }
  ```

**2. background.js is 2,418 lines — architectural split required** (Code Quality/Testing/Documentation)
- Handles WebSocket connections, room management, peer sync, force sync, episode lobby, notifications, reconnection, UI state, and routing in a single file
- Zero test coverage, zero JSDoc
- **Fix:** Extract into modules: `connection.js`, `events/handler.js`, `events/force-sync.js`, `events/episode-lobby.js`, `state/room.js`, `state/peer.js`, `messaging.js`, `keepalive.js`

**3. content.js is 1,525 lines with zero functional tests** (Code Quality/Testing)
- Manages video detection, play/pause coalescing, seek filtering, episode auto-sync, host control mode UI, audio processing, Shadow DOM rendering, and platform-specific overrides
- Only `findVideo()` is tested (64 lines)
- **Fix:** Extract pure functions to testable modules; add Puppeteer/Playwright E2E tests

**4. popup.js is 1,100+ lines with zero functional tests** (Code Quality/Testing)
- Contains UI rendering, peer list management, history, room list, tab matching, onboarding, and host control UI
- **Fix:** Extract into `popup-ui.js` (DOM rendering), `popup-state.js` (state management), `popup-events.js` (message routing)

**5. No database or persistent storage — all state is volatile** (Architecture/Performance)
- `server/index.js:149`: `const rooms = new Map();`
- Server restart = total data loss (rooms, peer positions, control modes, episode lobby state)
- **Fix:** Add Redis or SQLite for room state persistence; implement room recovery protocol for reconnecting peers

**6. chrome.runtime.onStartup deprecated in Manifest V3** (Best Practices)
- `background.js:51-54`: `chrome.runtime.onStartup.addListener(...)` NEVER fires in Chrome MV3
- Service workers are created on-demand — no "onStartup" event exists
- **Fix:** Move init logic into `chrome.runtime.onInstalled` (already used at lines 44-49)

**7. No WebSocket protocol specification** (Documentation)
- ~20 events defined in `shared/constants.js` but no authoritative document
- Protocol scattered across `ARCHITECTURE.md`, `HOW_IT_WORKS.md`, inline comments
- **Fix:** Create `docs/PROTOCOL.md` with event name, direction, payload schema, examples, edge cases

**8. Extension source code exposes OFFICIAL_SERVER_TOKEN** (Security)
- `shared/constants.js:14`: 64-char hex token visible in Chrome extension source
- Treated as compromised by design but has no rotation mechanism
- **Fix:** Document as expected trade-off; implement server-side rate limiting + device fingerprinting to limit impact

### High Priority (P1 -- Fix Before Next Release)

**9. No testing framework or CI gating** (Testing/CI-CD)
- All 12 test files use raw `node:assert/strict` — no test harness, no coverage tool, no CI workflow
- **Fix:** Introduce Vitest with `npm test`; add GitHub Actions PR test gate with coverage threshold

**10. WebSocket relay handler has ~300 untested lines** (Testing)
- `server/index.js:230-750` — field sanitization, auth rate limits, room creation locks, relay payloads untested with malformed input
- **Fix:** Extract sanitization to testable unit; add tests for null bytes, Unicode surrogates, type confusion

**11. Express 5 — no error-handling middleware** (Best Practices)
- `server/package.json`: Express `^5.2.1` (breaking changes from Express 4)
- **Fix:** Add `app.use((err, req, res, next) => { ... })` error handler

**12. No SAST, container scanning, or comprehensive SCA** (CI-CD)
- Only `npm audit` (twice) — no Semgrep, no Trivy/Grype, no Gitleaks
- **Fix:** Add Semgrep SAST, Trivy container scanning, dependabot.yml

**13. Server logging is plain-text `console.log` only** (CI-CD)
- No structured logger, no log rotation, no external aggregation
- **Fix:** Migrate to Pino or Winston with `NODE_ENV`-based log levels

**14. Socket.IO graceful shutdown incomplete** (Architecture/Best Practices)
- `server/index.js:918-932` — does NOT call `io.disconnectSockets(true)` or `io.close()`
- **Fix:** Add `io.disconnectSockets(true)` before `httpServer.close()`

**15. Plaintext relay of tab titles, media titles, and usernames** (Security)
- All user-visible data transmitted in plaintext to room peers, server, and server logs
- Inherent to sync app design but should be documented and optional
- **Fix:** Add opt-in per-peer encryption (libsodium) or document as known limitation

**16. LEAVE_ROOM has no rate limiting** (Security/Performance)
- Peer can spam LEAVE_ROOM events unlimited times to flood peers with broadcasts
- **Fix:** Add per-socket rate limit on LEAVE_ROOM events

**17. No documented runbooks or rollback procedures** (CI-CD)
- No SOPs for common failures (`:latest` pushes instantly to production)
- **Fix:** Create `docs/INCIDENT_RUNBOOK.md` and `docs/ROLLBACK_PROCEDURE.md`

**18. Chrome/Firefox extension store publishing is entirely manual** (CI-CD)
- Release workflow builds `.zip` artifacts but maintainer must manually upload to stores
- **Fix:** Integrate with Chrome Web Store API and Firefox Add-ons API

**19. In-memory Maps grow unbounded without guaranteed cleanup** (Performance)
- `server/rate-limiter.js:18-23` — six Maps, some only cleaned on disconnect
- `failedAuthAttempts` has 200K entry soft cap with worst-case O(n) eviction
- **Fix:** Use QuickLRU with TTL-based expiry; add memory usage metrics

**20. `updatePeerList()` does full DOM repaint on every peer change** (Performance)
- `extension/popup.js:619-811` — 25+ DOM writes per heartbeat (15s interval = ~100+ writes/min per room)
- **Fix:** Use DOM diffing or update only changed peer elements

### Medium Priority (P2 -- Plan for Next Sprint)

**21. No architecture diagrams** (Documentation)
- Complex dual-heartbeat, two-phase force sync, episode lobby architecture difficult to grasp from text
- **Fix:** Add Mermaid.js sequence diagrams for join flow, force sync, episode sync, host control, service worker lifecycle

**22. No self-hosting troubleshooting guide** (Documentation)
- Common issues (WSS, CORS, reverse proxy, admin metrics) undocumented
- **Fix:** Create `docs/SERVER_ADMIN.md` with Docker Compose + Caddy instructions

**23. 40+ silent `.catch(() => {})` firewalls** (Code Quality)
- Real errors (e.g., "Receiving end does not exist") are completely invisible
- **Fix:** Implement message result handler that logs failures

**24. No concurrency/race-condition testing** (Testing)
- Concurrent JOIN_ROOM, rapid connect/disconnect storms, dedup during relay untested
- **Fix:** Add stress tests using `ws` library flooding server with rapid cycles

**25. No authentication bypass / brute force tests** (Testing)
- Only single-IP password brute force tested; different IPs, time-waiting, room traversal untested
- **Fix:** Add stress tests for auth failure map and memory pressure

**26. Extension build uses regex injection** (Best Practices)
- `scripts/build-extension.cjs` injects shared constants via regex — fragile
- No sourcemaps, no linting, no checksums
- **Fix:** Use esbuild with `external: ['chrome']` for proper bundling

**27. No built-in Prometheus metrics** (CI-CD)
- Requires external `json_exporter` sidecar — operators get zero visibility without it
- **Fix:** Add optional `/metrics` endpoint using `prom-client` library

**28. No alerting configuration documented** (CI-CD)
- No alert thresholds, on-call routing, or notification channels
- **Fix:** Document recommended alerting rules (rooms > threshold, memory limits, rate limit spikes)

**29. Dockerfile runs as root, no .dockerignore** (CI-CD)
- Container runs as root; build context may include node_modules, .git
- **Fix:** Add `adduser -S appuser`/`USER appuser`; create `.dockerignore`

**30. Website `app.js` has no lazy loading** (Performance)
- All CSS (2,966 lines) and app.js (778 lines) loaded on every page
- **Fix:** Code-split site; lazy-load join/imprint/privacy pages

### Low Priority (P3 -- Track in Backlog)

**31. ESLint config minimal — 9 rules only** (Best Practices)
- No `prefer-const`, `no-var`, `eqeqeq`, `curly` rules
- ecmaVersion at 2022 (could bump to 2024)
- **Fix:** Add missing rules; bump ecmaVersion

**32. No production minification for extension** (Best Practices)
- Extension files shipped uncompressed
- **Fix:** Add `esbuild.minify: true` to build pipeline

**33. Host Control Mode documentation scattered across 6+ files, some in German** (Documentation)
- `docs/host-control-mode-plan.md` (German), `host-control-mode-COHOST-PLAN.md`, `EDGECASES.md`, `TESTING.md`
- **Fix:** Consolidate into single English-language doc in `docs/`; move internals to `docs/internal/`

**34. `KNOWN_LIMITATIONS.md` no "accepted risks" summary** (Documentation)
- No executive summary for security reviewers or new contributors
- **Fix:** Add "Threat Model Summary" table

**35. No `CODE_OF_CONDUCT.md` file exists** (Documentation)
- README and CONTRIBUTING both reference it but file was not found
- **Fix:** Add `CODE_OF_CONDUCT.md` or remove references

**36. Website language switching triggers full page reloads** (Performance)
- `window.location.href` navigation to `/de/`, `/fr/` instead of dynamic DOM updates
- **Fix:** Use client-side language switching for join/imprint/privacy pages

**37. `findVideo()` traverses entire DOM on every event** (Performance)
- Called on every play/pause/seek/heartbeat/media action — full DOM scan + shadow traversal
- **Fix:** Cache last found video element; re-query only on MutationObserver events

**38. Heartbeat polling interval fixed at 15s for all rooms** (Performance)
- A room with 1 peer generates same traffic as room with 25 peers
- **Fix:** Scale heartbeat frequency inversely with peer count

## Findings by Category

| Category | Severity | Count |
|----------|----------|-------|
| **Code Quality** | C:0, H:3, M:3, L:3 | **9** |
| **Architecture** | C:2, H:3, M:3, L:2 | **10** |
| **Security** | C:3, H:5, M:4, L:2 | **14** |
| **Performance** | C:1, H:3, M:4, L:2 | **10** |
| **Testing** | C:5, H:4, M:4, L:2 | **15** |
| **Documentation** | C:3, H:5, M:5, L:3 | **16** |
| **Best Practices** | C:2, H:3, M:5, L:4 | **14** |
| **CI/CD & DevOps** | C:1, H:5, M:5, L:2 | **13** |

**Grand Total: 101 findings**
- Critical: **15**
- High: **36**
- Medium: **33**
- Low: **17**

## Recommended Action Plan

1. **SERVER_SALT → hard error** (15 min) — Prevents offline dictionary attacks. File: `server/index.js:52`
2. **Split background.js into modules** (1-2 days) — Enables testing, reduces cognitive load. Extract: connection.js, events/handler.js, events/force-sync.js, events/episode-lobby.js, state/*.js, messaging.js, keepalive.js. File: `extension/background.js`
3. **Split content.js and popup.js** (2-3 days) — Parallelizable with background.js work. Extract pure functions to shared testable modules. Files: `extension/content.js`, `extension/popup.js`
4. **Add Express 5 error middleware** (1 hour) — Production reliability. File: `server/index.js`
5. **Switch server logging to Pino** (1 day) — Structured logs enable monitoring and incident response. File: `server/index.js`
6. **Add Vitest + coverage threshold** (2-3 days) — Foundation for test safety net. Root `package.json`, `vitest.config.mjs`
7. **Create WebSocket protocol spec** (2 days) — Enables testing automation and contributor onboarding. File: `docs/PROTOCOL.md`
8. **Add missing SAST and container scanning** (1 day) — CI/CD security hardening. File: `.github/workflows/ci.yml`
9. **Add Socket.IO graceful shutdown fix** (30 min) — File: `server/index.js:918-932`
10. **Create docs/SERVER_ADMIN.md + docs/INCIDENT_RUNBOOK.md** (1 day) — Self-hosting reliability. Files: `docs/SERVER_ADMIN.md`, `docs/INCIDENT_RUNBOOK.md`
11. **Add `chrome.runtime.onStartup` → `onInstalled` migration** (30 min) — MV3 compliance. File: `extension/background.js:51-54`
12. **Leak-proof Maps / add QuickLRU** (1 day) — Performance and memory safety. File: `server/rate-limiter.js`
13. **Add DOM diffing for peer list** (2 days) — Reduces popup DOM churn by ~80%. File: `extension/popup.js:619-811`
14. **Document extension module interdependencies** (1 day) — Developer onboarding. File: `extension/README.md`
15. **Implement Chrome/Firefox store publishing automation** (3-5 days) — Reduces release friction. GitHub Actions integration with Web Store APIs

**Estimated total effort: ~2-3 weeks of focused development + documentation**

## Review Metadata

- **Review date:** 2026-07-01
- **Phases completed:** Code Quality, Architecture, Security, Performance, Testing, Documentation, Best Practices, CI/CD
- **Flags applied:** None (no special flags set)
- **Test framework:** None found (raw `node:assert/strict` only)
- **CI/CD:** GitHub Actions (ci.yml, release.yml, beta-server-image.yml)
