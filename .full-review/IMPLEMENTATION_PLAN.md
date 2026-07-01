# Umsetzungsplan — KoalaSync Code Review Fixen

**Erstellt:** 2026-07-01  
**Priorität:** P0 → P1 → P3 (chronologisch)

---

## Phase 1: WebSocket Protocol Spec (P1)
**Datei:** neue Datei `docs/PROTOCOL.md` | **Neue Dateien:** 1 (ca. 150-200 Zeilen) | **Agent:** `documentation-generation__docs-architect`

### Task 1.1
- Datei erstellen: `docs/PROTOCOL.md`
- Alle ~20 Events aus `shared/constants.js:L29-63` dokumentieren
- Für jedes Event: Event-Name, Richtung (C→S / S→C), Payload-Schema, Wann gesendet, Edge Cases
- Referenz aus `ARCHITECTURE.md` und `HOW_IT_WORKS.md` umbauen auf `docs/PROTOCOL.md`
- CHANGELOG.md Eintrag

### Struktur der PROTOCOL.md (Vorschlag)
```markdown
# WebSocket Protocol Specification

## Overview
- Server URL, Auth, Transport (websocket only)
- PROTOCOL_VERSION, MIN_VERSION

## Events Table
| Event | Direction | Description |
|-------|-----------|-------------|
| JOIN_ROOM | C→S | Join a room |
| LEAVE_ROOM | C→S | Leave current room |
| ... | ... | ... |

## Payload Schemas

### JOIN_ROOM
```json
{
  "peerId": "string (16 chars max)",
  "roomId": "string (alphanum + hyphens, 64 max)",
  "username": "string",
  "password": "string (hashed with server salt)",
  "tabTitle": "string",
  "mediaTitle": "string"
}
```

### ROOM_DATA (Server → Client)
```json
{
  "roomId": "string",
  "peers": "array",
  "controlMode": "string",
  "hostPeerId": "string",
  "controllers": "array",
  ...
}
```

## Rate Limits
- Connection: 10 req/min per IP
- Events: 50 req/10s per socket
- Health: 10 req/min per IP
- Admin Metrics: 5 req/min per IP
```

### Checklist
- [ ] `docs/PROTOCOL.md` erstellt (150-200 Zeilen)
- [ ] Alle Events aus `shared/constants.js` dokumentiert mit Richtung + Payload-Schema
- [ ] Rate Limits dokumentiert
- [ ] `ARCHITECTURE.md` / `HOW_IT_WORKS.md` aktualisiert (Referenzen umbogen)

---

## Phase 2: Socket.IO Graceful Shutdown (P0)
**Datei:** `server/index.js` | **Änderung:** 1 Zeile hinzugefügt (L921) | **Agent:** `backend-development__test-automator`

### Task 2.1
```diff
  function gracefulShutdown(signal) {
      log('SERVER', `${signal} received — starting graceful shutdown...`);
      io.emit(EVENTS.ERROR, { message: 'Server is restarting. Reconnecting automatically...' });
+     // Gracefully disconnect all Socket.IO clients
+     io.disconnectSockets(true);
      httpServer.close(() => {
          log('SERVER', 'HTTP server closed. Exiting.');
          process.exit(0);
      });
      setTimeout(() => {
          log('SERVER', 'Force-exit after timeout.');
          process.exit(1);
      }, 5000);
  }
```

Beachte: In `stopServerForTests()` (L945) ist `io.disconnectSockets(true)` bereits vorhanden.

### Checklist
- [ ] Code geändert in `server/index.js:L921` (1 Zeile hinzugefügt)
- [ ] Parallel zu `stopServerForTests()` konsistent (L945)

---

## Phase 3: LEAVE_ROOM Rate Limiting (P1)
**Dateien:** `server/rate-limiter.js`, `server/index.js` | **Änderung:** 30+ Zeilen neu + ~20 Zeilen geändert | **Agent:** `backend-development__test-automator`

### Task 3.1 — Neue Rate-Limit-Konstante in `server/rate-limiter.js`
```diff
  export const EVENT_RATE_WINDOW_MS = 10000; // 10 seconds
  export const HEALTH_RATE_WINDOW_MS = 60000; // 1 minute
  export const ADMIN_METRICS_AUTH_WINDOW_MS = 60000; // 1 minute
+ export const LEAVE_ROOM_RATE_LIMIT = 10; // max LEAVE_ROOM events per socket per window
+ export const LEAVE_ROOM_RATE_WINDOW_MS = 60000; // 1 minute
```

### Task 3.2 — Neue Rate-Limit-Map
```diff
  export const roomListCooldowns = new Map(); // socketId -> last allowed timestamp
+ export const leaveRoomCounts = new Map();    // socketId -> { count, resetTime }
```

### Task 3.3 — `checkLeaveRoomRate` Funktion (ca. 15 Zeilen neu)
```javascript
export function checkLeaveRoomRate(socketId) {
    const now = Date.now();
    const entry = leaveRoomCounts.get(socketId) || { count: 0, resetTime: now + LEAVE_ROOM_RATE_WINDOW_MS };
    if (now > entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + LEAVE_ROOM_RATE_WINDOW_MS;
    }
    entry.count++;
    leaveRoomCounts.set(socketId, entry);
    if (entry.count <= LEAVE_ROOM_RATE_LIMIT) return true;
    rateLimitDenied.leaveRoom = (rateLimitDenied.leaveRoom ?? 0) + 1;
    return false;
}
```

### Task 3.4 — Cleanup in `startRateLimitCleanup`
```diff
        for (const [socketId] of roomListCooldowns.entries()) {
            if (!io.sockets.sockets.has(socketId)) roomListCooldowns.delete(socketId);
        }
+       for (const [socketId, entry] of leaveRoomCounts.entries()) {
+           if (now > entry.resetTime) leaveRoomCounts.delete(socketId);
+       }
```

### Task 3.5 — `rateLimitDenied` + `clearRateLimitMaps`
```diff
  export const rateLimitDenied = {
      connections: 0, events: 0, health: 0, adminMetricsAuth: 0, roomList: 0,
+     leaveRoom: 0
  };
```
```diff
  export function clearRateLimitMaps() {
      // ... existing clears ...
      roomListCooldowns.clear();
+     leaveRoomCounts.clear();
  }
```

### Task 3.6 — Rate Limit im Event-Handler enforce (`server/index.js`)
```diff
      socket.on(EVENTS.LEAVE_ROOM, () => {
+         if (!checkLeaveRoomRate(socket.id)) {
+             log('SECURITY', `LEAVE_ROOM rate limit exceeded for socket: ${socket.id}`);
+             return;
+         }
          try {
              // ... existing leave logic ...
          }
      });
```

### Checklist
- [ ] `server/rate-limiter.js`: 25+ Zeilen neu (Konstanten, Map, Funktion, Cleanup)
- [ ] `server/index.js`: 5 Zeilen hinzugefügt (Handler check)
- [ ] Tests: 10 LEAVE_ROOM/Min pro Socket funktioniert
- [ ] 11. Request wird still ignoriert

---

## Phase 4: Testing Framework + Coverage (P1)
**Dateien:** Root (`vitest.config.mjs` neu, `package.json` geändert) | **Änderung:** 1 neue Datei (~10 Zeilen), 2 Zeilen geändert | **Agent:** `backend-development__test-automator`

### Task 4.1 — Vitest installieren
```bash
npm install -D vitest c8
```

### Task 4.2 — `vitest.config.mjs` erstellen (~50 Zeilen)
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['scripts/test-*.mjs', 'scripts/test-*.cjs'],
        coverage: {
            provider: 'c8',
            reporter: ['text', 'lcov'],
            include: ['server/**/*.js', 'shared/**/*.js', 'extension/**/*.js'],
            exclude: [
                'extension/background.js',
                'extension/content.js',
                'extension/popup.js',
                '**/node_modules/**'
            ],
            thresholds: {
                functions: 30,
                lines: 30,
                branches: 25,
                statements: 30
            }
        }
    }
});
```

### Task 4.3 — `package.json` anpassen
```diff
  "scripts": {
    "build:extension": "node scripts/build-extension.cjs",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
-   "test": "node scripts/verify-release.mjs",
+   "test": "vitest run",
    "verify": "node scripts/verify-release.mjs"
  },
```

### Task 4.4 — CI-Gate aktualisieren
`.github/workflows/ci.yml`:
```yaml
- name: Run tests
  run: npm test
  continue-on-error: true  # Schritt-Phase; später: false
```

### Checklist
- [ ] `vitest.config.mjs` erstellt (50 Zeilen)
- [ ] `package.json` test-Script aktualisiert
- [ ] `npm test` läuft ohne Fehler
- [ ] Coverage-Report wird generiert
- [ ] CI-Workflow aktualisiert (1 Zeile geändert)

---

## Phase 5: Background.js Module Split (P0)
**Dateien:** `extension/background.js` → 8+ Dateien | **Änderung:** 2418 Zeilen aufgeteilt ≈ 240 Zeilen Entry-Point + 8 Module | **Agent:** `agent-teams__team-implementer`

### Task 5.1 — Architektur (Vorschlag)
```
extension/
  background.js          # Entry-Point, Initialization, chrome.* listeners (~240 Zeilen)
  background/
    connection.js        # connect(), forceDisconnect(), scheduleReconnect()
    events/
      handler.js         # handleServerEvent() — command handler registry
      media-event.js     # handlePlay, handlePause, handleSeek
      peer-event.js      # handlePeerStatus, handlePeerJoin/Leave
      force-sync.js      # forceSync logic (prepare, ack, execute)
      episode-lobby.js   # episode lobby logic
    state/
      room.js            # currentRoom management
      peer.js            # peer data factory, update helpers
    messaging.js         # chrome.runtime.onMessage handlers
    keepalive.js         # ping/pong, chrome.alarms, keepAlive port
    storage.js           # chrome.storage read/write helpers
```

### Task 5.2 — Migrationsschritte (sequentiell, nach Zeilen-Bereichen)
| Schritt | Zeilen | Ziel-Datei | Inhalt |
|---------|--------|------------|--------|
| 6.1 | L32-99 | `extension/background/state/peer.js` | State-Declarations, `createPeerData()` |
| 6.2 | L354-420 | `extension/background/connection.js` | `connect()`, `forceDisconnect()` |
| 6.3 | L1018-1399 | `extension/background/events/handler.js` | Switch-Block → Handler-Registry |
| 6.4 | L422-530 | `extension/background/storage.js` | Storage-Operations |
| 6.5 | L531-600 | `extension/background/keepalive.js` | Ping/Pong, chrome.alarms |
| 6.6 | L601-850 | `extension/background/events/force-sync.js` | Force sync orchestration |
| 6.7 | L1400-1470 | `extension/background/events/episode-lobby.js` | Episode lobby |
| 6.8 | L1520-2418 | aufgeteilt auf Module | Tab-Matching, Audio, Host Control |

### tests
- Nach jedem Extraktions-Schritt: `npm test` muss bestehen
- Neue Unit-Tests für extrahierte Module

### Checklist
- [ ] `extension/background/state/peer.js` erstellt (68 Zeilen)
- [ ] `extension/background/connection.js` erstellt (67 Zeilen)
- [ ] `extension/background/events/handler.js` erstellt (382 Zeilen)
- [ ] `extension/background/storage.js` erstellt (109 Zeilen)
- [ ] `extension/background/keepalive.js` erstellt (70 Zeilen)
- [ ] `extension/background.js` reduziert auf < 250 Zeilen (von 2418)
- [ ] Alle Tests bestehen

---

## Phase 6: Content.js & Popup.js Module Split (P1)
**Dateien:** `extension/content.js`, `extension/popup.js` | **Änderung:** 4100+ Zeilen aufgeteilt ≈ 300+800 Zeilen Entry-Points + Module | **Agent:** `agent-teams__team-implementer`

### Task 6.1 — Content.js Struktur
```
extension/
  content.js                # Entry, init(), shadow DOM creation (~150 Zeilen)
  modules/
    video-detection.js      # findVideo(), video score computation (L411-444: ~34 Zeilen)
    event-listeners.js      # addPlayerEventListeners(), coalesce logic (L60-79, 231-310: ~180 Zeilen)
    seek-filter.js          # MIN_SEEK_DELTA logic (L52-57, 450-520: ~125 Zeilen)
    episode-sync.js         # extractEpisodeId(), episode detection (L824-920: ~96 Zeilen)
    hcm-ui.js               # Host Control Mode popup/badge (L280-332: ~52 Zeilen)
    platform-overrides.js   # YouTube/Twitch/Netflix selectors (L739-870: ~131 Zeilen)
    force-sync.js           # force sync buffer polling (L1140-1340: ~200 Zeilen)
    audio-processing.js     # AudioContext, compressor, crossfade (L1377+: ~150+ Zeilen)
```

### Task 6.2 — Popup.js Struktur
```
extension/
  popup.js                  # Entry, init(), DOM query (~200 Zeilen)
  modules/
    popup-ui.js             # updatePeerList(), renderPeer(), interpolationTimer (L559-811: ~252 Zeilen)
    popup-state.js          # updateState(), storage, tab matching (L422-570: ~148 Zeilen)
    popup-events.js         # message routing, button click handlers (L812-841: ~30 Zeilen)
```

### Checklist
- [ ] `content.js` reduziert auf ~150 Zeilen (von 1525)
- [ ] 8 Module in `extensions/modules/` erstellt
- [ ] `popup.js` reduziert auf ~200 Zeilen (von 2596)
- [ ] 3 Module in `extension/modules/` erstellt
- [ ] Alle Tests bestehen

---

## Phase 7: Host Control Mode Docs Consolidate (P3)
**Dateien:** `docs/` | **Änderung:** neue Datei (~100 Zeilen) + 4 Dateien umziehen | **Agent:** `documentation-generation__docs-architect`

### Task 7.1 — Zielarchitektur
```
docs/
  host-control-mode.md          # Konsolidierte Dokumentation (EN, ~100 Zeilen)
  internal/                     # Neue Unterverzeichnis
    host-control-mode-plan.md   # (vom Root, DE)
    host-control-mode-COHOST-PLAN.md
    host-control-mode-EDGECASES.md
    host-control-mode-TESTING.md
```

### Task 7.2 — `docs/host-control-mode.md` erstellen (~100 Zeilen)
```markdown
# Host Control Mode

## Overview
Der Host steuert den Raum. Gäste können nur spielen/pausen/seeken, aber
die Aktion wird nicht an den Raum broadcastet (außer der Gast aktiviert
bewusst Desync).

## Modes
- **`everyone`** (Default): Jeder User steuert den Raum
- **`host-only`**: Nur der Host steuert

## Protocol Events
- `SET_CONTROL_MODE` (C→S): Host ändert Modus
- `CONTROL_MODE` (S→C): Broadcast Modus-Änderung an alle

## Server-Side
- `room.hostPeerId` = Erster Peer (Host)
- `room.controlMode` = 'everyone' | 'host-only'

## Client-Side
- `background.js`:
  - `controlMode` = 'everyone' | 'host-only' (aus ROOM_DATA)
  - `hostPeerId` (aus ROOM_DATA)
  - `amHost()` / `amController()` helpers

## Edge Cases
- Host verlässt → room.controlMode = 'everyone' (Fallback)
- Controller promoted → additional host controls

## Migration
Wenn von `everyone` auf `host-only` gewechselt wird:
- Bestehende Peers behalten ihre Position
- Neue Events werden entsprechend gefiltert
```

### Checklist
- [ ] `docs/internal/` Verzeichnis erstellt
- [ ] Alte DE-Dateien (`host-control-mode-plan.md`, etc.) verschoben
- [ ] Konsolidierte EN-Dokumentation erstellt (~100 Zeilen)
- [ ] CHANGELOG.md Eintrag

---

## Reihenfolge & Abhängigkeiten

| Phase | Priorität | Datei | Zeilen | Agent | Abhängig von |
|-------|-----------|-------|--------|-------|--------------|
| 1 | P1 | `docs/PROTOCOL.md` | 1 neue Datei (~200 Z) | `documentation-generation__docs-architect` | — |
| 2 | P0 | `server/index.js` | 1 Zeile hinzugefügt | `backend-development__test-automator` | — |
| 3 | P1 | `server/rate-limiter.js`, `server/index.js` | 30+ neu, ~20 geändert | `backend-development__test-automator` | 1 |
| 4 | P1 | `vitest.config.mjs` (neu), `package.json` | 10+ neu, 2 geändert | `backend-development__test-automator` | 3 |
| 5 | P0 | `extension/background.js` | 2418→240 Zeilen | `agent-teams__team-implementer` | 4 |
| 6 | P1 | `extension/content.js`, `extension/popup.js` | 4100+→1000 Zeilen | `agent-teams__team-implementer` | 5 |
| 7 | P3 | `docs/host-control-mode.md` | 1 neue Datei (~100 Z) | `documentation-generation__docs-architect` | — |

---

## Zusammenfassung aller Tasks

| # | Task | Datei(n) | Änderung (Zeilen) | Agent |
|---|------|----------|-------------------|-------|
| 1 | PROTOCOL.md erstellen | neue `docs/PROTOCOL.md` | 1 Datei (~200 Z) | `documentation-generation__docs-architect` |
| 2 | Socket.IO graceful shutdown | `server/index.js:L921` | 1 hinzugefügt | `backend-development__test-automator` |
| 3 | LEAVE_ROOM Rate Limit | `server/rate-limiter.js`, `server/index.js` | 30+ neu, ~20 geändert | `backend-development__test-automator` |
| 4 | Vitest + Coverage | `vitest.config.mjs` (neu), `package.json` | 10+ neu, 2 geändert | `backend-development__test-automator` |
| 5 | Background.js Split | `extension/background.js` → 8 Module | 2418→~240 | `agent-teams__team-implementer` |
| 6 | Content.js & Popup.js Split | beide Dateien | 4100+→~1000 | `agent-teams__team-implementer` |
| 7 | HCM Docs Consolidate | `docs/host-control-mode.md` | 1 Datei (~100 Z) | `documentation-generation__docs-architect` |
