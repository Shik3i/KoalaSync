# Phase 4: Best Practices & Standards

## Framework & Language Findings

### Critical

**F-1: background.js is 2,418 lines — architectural split required**
- Handles: WebSocket connections, room management, peer synchronization, force sync coordination, episode lobby logic, ping/latency, notification system, reconnection logic, UI state management, and routing
- **Recommendation:** Extract into: connection.js, events/handler.js, events/force-sync.js, events/episode-lobby.js, state/room.js, state/peer.js, messaging.js, keepalive.js
- **Reference:** `extension/background.js`

### High

**H1: Express 5 — no error-handling middleware**
- `server/package.json` lists Express `^5.2.1` (breaking changes from Express 4)
- No `(err, req, res, next) => {}` error handlers defined
- Express 5 expects explicit body parsers and error middleware
- **Recommendation:** Add Express 5 error middleware: `app.use((err, req, res, next) => { ... })`

**H2: `chrome.runtime.onStartup` deprecated in Manifest V3**
- `background.js` lines 51-54: `chrome.runtime.onStartup.addListener(...)` never fires in Chrome MV3
- Service workers do not have an "onStartup" event — created on-demand
- **Recommendation:** Move init logic into `chrome.runtime.onInstalled` (already used at lines 44-49)

**H3: Socket.IO graceful shutdown incomplete**
- `server/index.js` lines 918-932: Does NOT call `io.disconnectSockets(true)` or `io.close()`
- HTTP server closes but Socket.IO clients are not gracefully disconnected
- **Recommendation:** Add `io.disconnectSockets(true)` before `httpServer.close()`

**H4: ESM/CJS module mix acknowledged but untidy**
- Three module systems: `.js` (ESM via `type="module"` in package.json or HTML), `.cjs` (CommonJS), inline `type="module"` in HTML
- `eslint.config.mjs` explicitly splits globals rules between ESM and CJS files
- The mix is intentional (CJS for build scripts, ESM for runtime) but could be cleaner
- **Recommendation:** Migrate all build scripts to ESM (`scripts/build-extension.cjs` → `.mjs`)

**H5: IIFE pattern in content.js is deprecated for MV3**
- `content.js` line 6: `(function() { ... })();` wrapper — should use real modules
- **Recommendation:** If CSP allows, use `type="module"`; otherwise use a named function

### Medium

**HM-1: Promise errors silently swallowed (40+ instances)**
- Repeated `chrome.runtime.sendMessage().catch(() => {})` in background.js and content.js
- Silent error swallowing makes debugging impossible
- **Recommendation:** Implement message result handler that logs failures: `console.warn('[bg] Message failed:', err.message)`

**HM-2: No Socket.IO rooms cleanup**
- When socket disconnects, `io.sockets.adapter.rooms` persists rooms
- Server cleans its own `rooms` Map but not the adapter's internal state
- **Recommendation:** Add cleanup callback: `socket.on('disconnect', () => { /* cleanup */ })`

**HM-3: Command handler registry over switch statement**
- `background.js` lines 1018-1399: massive `switch`/`case` dispatching 16+ events
- **Recommendation:** `const HANDLERS = { [EVENTS.PLAY]: handlePlay, ... }; HANDLERS[event]?.(data)`

**HM-4: `self.crypto.randomUUID()` should be `globalThis.crypto.randomUUID()`**
- `background.js` line 356 — inconsistent global access
- **Recommendation:** Use `crypto.randomUUID()` (standard global) or `globalThis.crypto.randomUUID()`

**HM-5: Extension build uses regex injection, fragile**
- `scripts/build-extension.cjs`: shared constants injected via regex into content.js
- No sourcemaps, no linting in build, no checksums
- **Recommendation:** Use esbuild with `external: ['chrome']` for proper bundling

**HM-6: Express 5 — no body parsing middleware**
- Express 5 removed built-in body-parser; server only uses Socket.IO for data transfer
- **Recommendation:** No fix needed (Socket.IO handles data) but document this assumption

**HM-7: `background.js` callback-style storage API mixed with Promise-based**
- `popup.js` line 298: uses `chrome.storage.sync.get(['onboardingComplete'], (data) => { ... })` callback pattern
- Other lines use await — inconsistent
- **Recommendation:** Standardize on Promise-based API

**HM-8: Version mismatch in package-lock.json**
- Root `package.json` says version 2.5.0, lockfile lists 2.2.4
- **Recommendation:** Run `npm install` to regenerate lockfile

### Low

**LM-1: No multi-stage Docker build**
- Dockerfile copies everything in single stage — acceptable for small project but not optimal
- **Recommendation:** Split builder/runtime stages when deps grow

**LM-2: ESLint config minimal — 9 rules only**
- `eslint.config.mjs` defines only 9 rules (no `prefer-const`, `no-var`, `eqeqeq`, `curly`)
- ecmaVersion set to 2022, could bump to 2024
- **Recommendation:** Add rules: `prefer-const`, `no-var`, `eqeqeq: "error"`, `curly: "error"`

**LM-3: No production minification for extension**
- Extension files shipped uncompressed (no esbuild/minification in build-extension.cjs)
- **Recommendation:** Add `esbuild.minify: true` to build pipeline

**LM-4: Dockerfile lacks NODE_ENV=production**
- No `ENV NODE_ENV=production` in Dockerfile
- **Recommendation:** Add `ENV NODE_ENV=production` and `ENV PORT=3000`

**LM-5: No .dockerignore file documented**
- Build context may include node_modules, dist, .git
- **Recommendation:** Add `.dockerignore` excluding `node_modules/`, `dist/`, `.git/`, `website/`, `extension/`

**LM-6: Dockerfile runs as root**
- No `USER` directive in Dockerfile
- **Recommendation:** Add `adduser -S appuser` and `USER appuser`

---

## CI/CD & DevOps Findings

### Critical

**CD-1: SERVER_SALT defaults to hardcoded public value — no startup guard**
- `server/index.js:52`: `const salt = process.env.SERVER_SALT || 'koalasync_salt_3i'`
- Server warns at startup but continues running with publicly-known salt
- Anyone reading the source can verify room passwords offline
- **Recommendation:** Hard error if SERVER_SALT is not set: `if (!process.env.SERVER_SALT) { console.error('[FATAL] SERVER_SALT must be set'); process.exit(1); }`

### High

**CD-H1: No SAST, container scanning, or comprehensive SCA**
- Only `npm audit` (twice) — no Semgrep, no Trivy/Grype container scanning, no Gitleaks for secrets
- No dependabot.yml configuration file (may be enabled in GitHub settings)
- **Recommendation:** Add Semgrep SAST, Trivy container scanning, dependabot.yml with security-only updates

**CD-H2: Test coverage ~7% — critical code paths untested**
- WebSocket relay handler (~300 lines), server lifecycle handlers, background.js, content.js all untested
- `npm test` runs but doesn't gate on coverage threshold
- **Recommendation:** Add `npm test` coverage threshold (e.g., 60% for server, 30% for shared/utils)

**CD-H3: Server logging is plain-text `console.log` only**
- All server logs use tagged `console.log` (e.g., `[SECURITY]`, `[AUTH]`, `[EVENT]`)
- No structured logger (Pino/Winston), no log rotation, no external aggregation
- **Recommendation:** Migrate to Pino or Winston with `NODE_ENV`-based log levels

**CD-H4: Chrome/Firefox extension store publishing is entirely manual**
- Release workflow builds .zip artifacts but maintainer must manually upload to stores
- **Recommendation:** Integrate with Chrome Web Store API and Firefox Add-ons API

**CD-H5: No documented runbooks or rollback procedures**
- No SOPs for common failures (server crash, WS storms, version mismatch)
- No rollback procedure — `:latest` pushes instantly to production
- **Recommendation:** Create `docs/INCIDENT_RUNBOOK.md` and `docs/ROLLBACK_PROCEDURE.md`

### Medium

**CD-M1: No built-in Prometheus metrics**
- Requires external `json_exporter` sidecar — operators who don't configure it get zero visibility
- **Recommendation:** Add optional `/metrics` endpoint using `prom-client` library

**CD-M2: No alerting configuration documented**
- No alert thresholds, on-call routing, or notification channels documented
- **Recommendation:** Document recommended alerting rules (rooms > threshold, memory approaching limits, rate limit spikes)

**CD-M3: No env separation (dev/staging/prod)**
- Only one `.env` file, same Docker image deployed everywhere
- **Recommendation:** Add `.env.development`, `.env.staging` examples; `docker-compose.dev.yml` override

**CD-M4: Extension version drift between GitHub and stores**
- GitHub Release artifacts available before store review completes
- **Recommendation:** Use store publishing automation with version synchronization

**CD-M5: No `:stable` Docker tag policy**
- Only `:latest` and `:beta` tags — no pinned stable tag for self-hosters
- **Recommendation:** Release workflow should tag `:stable` and publish image digests for pinning

### Low

**CD-L1: HEALTHCHECK uses `wget` without timeout**
- `wget --spider` without `--timeout=5` is fragile if health endpoint slows
- **Recommendation:** Add `--timeout=10` or swap to `curl`

**CD-L2: No pre-commit hooks configured**
- No lint-staged, no Husky, no automated formatting before commits
- **Recommendation:** Add `lint-staged` + Prettier for pre-commit formatting

**CD-L3: GitHub workflows are well-structured**
- Three workflows (CI, release, beta-server) with multi-arch builds and attestations — positive finding
- **No fix needed**

**CD-L4: Docker Compose examples are comprehensive**
- Caddy-based and IP-based configs with good security headers, HSTS, CSP — positive finding
- **No fix needed**

---

## Critical Issues for Phase 5 Context

### Cross-cutting priorities (affecting multiple phases):

1. **SERVER_SALT default must be a hard error** (P0) — affects Security, CI/CD, and self-hosting docs
2. **background.js needs architectural split into modules** (P1) — affects Code Quality, Testing, and inline documentation
3. **Express 5 error middleware must be added** (P1) — affects Framework best practices and production reliability
4. **Structured logging (Pino) should be adopted** (P1) — affects CI/CD, monitoring, and incident response
5. **WebSocket protocol specification should be authored** (P1) — affects Testing, Documentation, and CI/CD test coverage
6. **Missing `chrome.runtime.onStartup` fix** (P2) — affects Chrome Extension API standards
7. **Socket.IO graceful shutdown** (P2) — affects Operations and user experience
