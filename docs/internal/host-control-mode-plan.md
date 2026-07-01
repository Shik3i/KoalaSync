# Host Control Mode — Implementierungsplan

Branch: `feature/host-control-mode`
Issue: GitHub feature request (wasserrutschentester) — nur Host darf den Raum steuern; Gäste werden zurückgesnappt oder gehen bewusst in Desync.

## Ziel

Ein Raum kann zwischen zwei Modi umgeschaltet werden:
- **`everyone`** (Default, heutiges Verhalten): jeder kann play/pause/seek für alle auslösen.
- **`host-only`**: nur der Host steuert den Raum. Pause/Seek eines Gasts wird **nicht** gebroadcastet; stattdessen snappt die eigene Extension den Gast zurück auf den Raum-Zustand — es sei denn, der Gast entscheidet sich bewusst für Desync.

Trust-Modell: client-seitig durchgesetzt. Kein Token, keine Auth. Es geht um versehentliches Stören, nicht um Angriffsschutz.

---

## Datenmodell

### Server (`server/index.js`, Room-Objekt ~Z.331)
Room bekommt zwei neue Felder:
```js
room = {
  ...,
  hostPeerId: peerId,        // gesetzt beim Anlegen = erster Joiner
  controlMode: 'everyone',   // 'everyone' | 'host-only'
}
```
- In `ROOM_DATA` (~Z.418) mitschicken: `hostPeerId`, `controlMode`.
- Neues Event `SET_CONTROL_MODE` (siehe unten): nur akzeptieren, wenn `senderPeerId === room.hostPeerId`. Server setzt `room.controlMode`, broadcastet die Änderung an alle.
- **Host-Migration:** in `removePeerFromRoom` (~Z.168) — wenn der gehende Peer `hostPeerId` war: entweder neuen Host bestimmen (nächster Peer) **oder** `controlMode` auf `everyone` zurückfallen lassen. → Entscheidung: **Fallback auf `everyone`** (simpel, nie verwaister gesperrter Raum). Optional später: Host-Transfer-Button.

### Shared Constants (`shared/constants.js`)
Neue Events im `EVENTS`-Objekt:
```js
SET_CONTROL_MODE: "set_control_mode",   // Client->Server: Host ändert Modus
CONTROL_MODE: "control_mode",            // Server->Client: Modus geändert { controlMode, hostPeerId }
```
⚠️ Danach `node scripts/build-extension.cjs` laufen lassen (Single Source of Truth propagieren). Ggf. `PROTOCOL_VERSION` bumpen — **nein, nur wenn alte Clients brechen würden**. Da alles additiv ist und alte Clients die neuen Felder/Events einfach ignorieren, ist KEIN Protokoll-Bump nötig. (Alter Client in host-only-Raum kennt den Modus nicht und sendet weiter → Host-Extensions ignorieren fremde Events nicht... → siehe Edge Case 7. Evtl. doch Bump erwägen.)

### Extension State (`background.js`)
```js
let controlMode = 'everyone';
let hostPeerId = null;
// abgeleitet: const amHost = () => hostPeerId === peerId;
```
Aus `ROOM_DATA` / `CONTROL_MODE` befüllen, in `chrome.storage.session` persistieren (wie `currentRoom`).

---

## Implementierung nach Schichten

### 1. Server (`server/index.js`)
- [ ] Room-Objekt um `hostPeerId` + `controlMode` erweitern (~Z.331).
- [ ] `ROOM_DATA`-Payload erweitern (~Z.418).
- [ ] Handler `SET_CONTROL_MODE`: validieren (Host-Check + Wert in {everyone, host-only}), setzen, `CONTROL_MODE` an Raum broadcasten.
- [ ] Host-Migration in `removePeerFromRoom`: Fallback auf `everyone` + neues `CONTROL_MODE` broadcasten, wenn Host geht.
- [ ] `SET_CONTROL_MODE` in die `relayEvents`-Liste? **Nein** — eigener Handler, da Sonderlogik + Host-Check. (relayEvents broadcastet blind.)

### 2. Shared / Build
- [ ] `EVENTS.SET_CONTROL_MODE`, `EVENTS.CONTROL_MODE` ergänzen.
- [ ] `node scripts/build-extension.cjs`.

### 3. background.js (Gast-Logik = Kern)
- [ ] `controlMode` / `hostPeerId` aus `ROOM_DATA` (~Z.875) und neuem `CONTROL_MODE`-Case übernehmen + persistieren + an Popup/Content pushen.
- [ ] **Emit-Gate** im SEND-Pfad (~Z.1786): bei `host-only && !amHost()` und action ∈ {play, pause, seek}:
      - NICHT `emit`en.
      - Stattdessen Content-Script anweisen: "snap back" ODER Desync-Confirm anzeigen.
- [ ] **Snap-Back-Zielzeit berechnen:** aus Host-Peer-State (`playbackState`, `currentTime`, `lastHeartbeat`) extrapolieren:
      `targetTime = host.currentTime + (host.playbackState==='playing' ? (now - host.lastHeartbeat)/1000 : 0)`.
      Genauigkeit ~±1s, für Watchparty ok. (Force-Sync-Maschinerie als Referenz für Ziel-Zeit-Koordination.)
- [ ] Nachricht an content.js: `{ type: 'HOST_BLOCK', action, targetTime, hostPlaybackState }`.

### 4. content.js (Player-Reaktion + Dialog)
- [ ] Handler für `HOST_BLOCK`: Confirm-Dialog im Player-Overlay rendern:
      "Pause only your own player and desync from the group? [Yes] [No]".
      - **No** (Default): Player via bestehende `_setSuppress`-Mechanik ([content.js:442](../extension/content.js:442)) wieder in Raum-Zustand zwingen (play + seek auf targetTime). Suppress verhindert Re-Broadcast.
      - **Yes:** lokal pausiert lassen, `isDesynced = true` setzen, dezenten "Desynced — Resync"-Button zeigen.
- [ ] "Resync"-Button → snappt zurück auf aktuelle Raum-Zeit, `isDesynced = false`.
- [ ] **Loop-Schutz:** nach einer Snap-Back-Aktion kurzes Cooldown-Fenster (z.B. 600ms), in dem weitere lokale pause/seek-Events nicht erneut den Dialog triggern (verhindert pause→play→pause-Pingpong).

### 5. popup (Host-UI)
- [ ] Host-Toggle "Only I can control" (nur sichtbar wenn `amHost()`), sendet `SET_CONTROL_MODE`.
- [ ] Rollen-Badge: "Host" / "Guest" + aktueller Modus.
- [ ] Gast-Hinweis wenn host-only aktiv: "The host controls playback".
- [ ] i18n-Keys in `extension/_locales` / `locales` für ~15 Sprachen.

---

## Edge Cases (Test-Checkliste)

1. **Pause nicht verhinderbar, nur revidierbar** → kurzer Flicker (~½s) beim Gast ist erwartet/akzeptabel.
2. **Snap-Back-Zielzeit** aus Heartbeat extrapoliert, ±1s. Bei stark veraltetem Host-State (kein Heartbeat) → letzten bekannten Wert nehmen.
3. **Kampf-Loop pause/play/skip back/pause/play** → Cooldown-Fenster nach Snap-Back. Testen mit aggressivem Mashing.
4. **Desync-Escape:** Gast kann bewusst pausieren (Klo/Telefon) → "Yes" → solo, dann Resync.
5. **Host verlässt Raum** → Fallback auf `everyone`, alle bekommen `CONTROL_MODE`-Update. Testen: Host schließt Tab / Disconnect / Netzabbruch.
6. **host-only + Episode-Auto-Sync / Force-Sync** (server/index.js:503-516): **Gast darf NICHT initiieren.** Force-Sync trägt eine `targetTime` und zwingt ALLE darauf (background.js:1261) — ein Gast könnte seeken → Force-Sync spammen und damit host-only komplett aushebeln. Episode-Lobby pausiert ebenfalls alle. → Im host-only-Modus dürfen `FORCE_SYNC_PREPARE`/`FORCE_SYNC_EXECUTE` und `EPISODE_LOBBY` nur vom Host **initiiert** werden. Gäste dürfen weiterhin nur **reagieren**: `FORCE_SYNC_ACK`, `EPISODE_READY`. Gäste brauchen Force-Sync nicht — ihr legitimer Fall ist der "Resync"-Button (snappt nur sie selbst, nicht alle).
7. **Alter Client (ohne Feature) in host-only-Raum** → kennt Modus nicht, sendet weiter pause/seek → andere Extensions wenden es an. Mitigation: Empfänger-seitiges Gate (host-only-Clients ignorieren play/pause/seek von Nicht-Host) ODER `MIN_VERSION`/Protokoll-Bump. → **Empfehlung: zusätzlich Empfänger-seitig filtern** (robuster als nur Sender-Gate).
8. **Seek getrennt von Pause** → host-only blockt auch Gast-Seeks, nicht nur Pausen.
9. **Mehrere Tabs / Multi-Peer mit gleicher peerId** (Dedup, server:381) → Host-Identität bleibt an peerId hängen, ok.
10. **DAU-Verwirrung** "warum kann ich nicht mehr pausieren?" → klare UI-Botschaft + der Desync-Dialog erklärt sich selbst.

## Architektur-Entscheidung zu Edge Case 7 (wichtig)
Wir setzen das Gate **doppelt** und über **alle raum-verschiebenden Events**, nicht nur play/pause/seek:
Geblockte Initiierungen für Nicht-Host im host-only-Modus:
`PLAY`, `PAUSE`, `SEEK`, `FORCE_SYNC_PREPARE`, `FORCE_SYNC_EXECUTE`, `EPISODE_LOBBY`.
Weiterhin erlaubt für Gäste (reine Reaktion, verschiebt niemanden): `FORCE_SYNC_ACK`, `EPISODE_READY`, `PEER_STATUS`, `PING`/`PONG`.

- **Sender-seitig** (Gast sendet erst gar nicht) → saubere UX, Confirm-Dialog bei play/pause/seek; Force-Sync-/Episode-Lobby-Buttons im Gast-UI deaktiviert/ausgeblendet.
- **Empfänger-seitig** (in `handleServerEvent`, background.js:969 + Force-Sync-/Episode-Cases): wenn `host-only` und `data.senderId !== hostPeerId` → Event verwerfen (nicht an Content routen, keine State-Mutation).
So sind auch alte/buggy/manipulierte Clients abgedeckt, ohne harten Protokoll-Bump.

Optional zusätzlich **server-seitig** in den `relayEvents` (server/index.js:445): im host-only-Modus Initiierungs-Events von Nicht-Host gar nicht erst relayen. Spart Traffic + deckt alles zentral ab. Empfehlenswert, da der Server `hostPeerId`/`controlMode` ohnehin kennt.

---

## Reihenfolge der Umsetzung (kleine, testbare Schritte)
1. Constants + Build (Events da, nichts kaputt).
2. Server: hostPeerId/controlMode + ROOM_DATA + SET_CONTROL_MODE + Migration.
3. background.js: State übernehmen + Empfänger-seitiges Gate (Edge 7) — testbar ohne UI.
4. background.js: Sender-seitiges Gate + Snap-Back-Zielzeit.
5. content.js: Snap-Back-Apply + Confirm-Dialog + Loop-Cooldown.
6. popup: Host-Toggle + Badge + i18n.
7. Durchtesten der Edge-Case-Liste auf YT / Netflix / generischem HTML5-Player.
