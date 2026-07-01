# Host Control Mode

## Overview

Host Control Mode allows the room host to control playback for all participants. Guests can attempt to play/pause/seek, but their actions are not broadcast to the room unless they explicitly choose to desync and watch on their own.

## Modes

### `everyone` (Default)
- Anyone in the room can control playback
- All play/pause/seek actions are broadcast to all peers
- Traditional KoalaSync behavior

### `host-only`
- Only the host (and promoted controllers) can control the room
- Guest actions are blocked and they are snapped back to the host's position
- Guests can choose to desync and watch independently

## Protocol Events

### `SET_CONTROL_MODE` (Client → Server)

Sent by the host to change the room's control mode.

**Payload:**
```json
{
  "controlMode": "everyone" | "host-only"
}
```

**Authorization:** Only the host (room.hostPeerId) can send this event.

**Server Response:** Broadcasts `CONTROL_MODE` to all peers in the room.

### `CONTROL_MODE` (Server → Client)

Broadcast when the control mode changes or when a peer joins a room.

**Payload:**
```json
{
  "controlMode": "everyone" | "host-only",
  "hostPeerId": "string",
  "controllers": ["string"]
}
```

**Triggered by:**
- Host changing the control mode
- Host leaving the room (fallback to 'everyone')
- Controller promotion/demotion

### `SET_PEER_ROLE` (Client → Server)

Sent by the host to promote or demote a peer to/from controller status.

**Payload:**
```json
{
  "peerId": "string",
  "controller": "boolean"
}
```

**Authorization:** Only the host (room.hostPeerId) can send this event.

**Server Response:** Broadcasts `CONTROL_MODE` to all peers in the room.

## Server-Side Implementation

### Room Object

```javascript
room = {
  hostPeerId: "peer-id",        // First peer to join the room
  controlMode: "everyone",      // 'everyone' | 'host-only'
  controllers: ["peer-id"],     // Peers allowed to control in host-only mode
  lastControlModeChangeAt: 0,   // Timestamp for rate limiting
  lastRoleChangeAt: 0           // Timestamp for rate limiting
}
```

### Key Behaviors

1. **Host Migration:** When the host leaves, the room falls back to 'everyone' mode
2. **Controller Set:** Always includes the host, plus any promoted peers
3. **Rate Limiting:** Control mode changes are debounced to 500ms per room

## Client-Side Implementation

### State Management (background.js)

```javascript
let controlMode = CONTROL_MODES.EVERYONE;
let hostPeerId = null;
let controllers = [];

function amHost() { return hostPeerId === peerId; }
function amController() { return amHost() || controllers.includes(peerId); }
```

### Event Gating

**Sender-side gate (background.js):**
- Blocks `PLAY`, `PAUSE`, `SEEK`, `FORCE_SYNC_*`, `EPISODE_LOBBY_*` from non-controllers
- Sends `HOST_BLOCKED` message to content script instead

**Receiver-side gate (background.js):**
- Ignores gated events from non-controllers in host-only mode
- Prevents malicious or outdated clients from bypassing controls

### Snap-Back Logic (content.js)

When a guest's action is blocked:
1. Show dialog: "Stay in sync" (default) or "Watch on my own"
2. If "Stay in sync": snap player back to host's position
3. If "Watch on my own": set `hcmDesynced = true`, show resync button

### Host Sync Target Calculation

```javascript
function getHostSyncTarget() {
  const host = currentRoom.peers.find(p => p.peerId === hostPeerId);
  if (!host) return null;
  
  let targetTime = host.currentTime;
  
  // Extrapolate if host is playing
  if (host.playbackState === 'playing' && host.lastHeartbeat) {
    const elapsedSec = (Date.now() - host.lastHeartbeat) / 1000;
    if (elapsedSec > 0 && elapsedSec <= 30) { // Max 30s extrapolation
      targetTime += elapsedSec;
    }
  }
  
  return { playbackState: host.playbackState, targetTime };
}
```

## Edge Cases

### 1. Host Leaves Room
- **Behavior:** Room falls back to 'everyone' mode
- **Implementation:** `removePeerFromRoom` checks if leaving peer is host
- **Broadcast:** `CONTROL_MODE` event sent to all remaining peers

### 2. Controller Promoted During Force Sync
- **Problem:** Controller's `FORCE_SYNC_EXECUTE` would be blocked
- **Solution:** `forceSyncInitiator` field tracks who started the sync
- **Behavior:** Initiator's EXECUTE is allowed even if demoted mid-sync

### 3. Guest Seek Spam
- **Problem:** Guest could spam seeks to disrupt
- **Solution:** Cooldown period after snap-back (1000ms)
- **Behavior:** Subsequent actions within cooldown are ignored

### 4. Host State Stale
- **Problem:** Host heartbeat hasn't arrived recently
- **Solution:** Max 30s extrapolation, then use last known position
- **Behavior:** Prevents overshooting if host paused but heartbeat delayed

### 5. Old Client Without Feature
- **Problem:** Client doesn't know about host-only mode
- **Solution:** Receiver-side gate in all clients
- **Behavior:** Modern clients ignore events from non-controllers

## User Experience

### Host UI
- Toggle: "Only I can control" (visible only to host)
- Role badges: "Host", "Controller", or "Guest"
- Guest notice: "The host controls playback" (when host-only active)
- Controller management: Promote/demote peers in participant list

### Guest UI
- **Blocked Action:** Dialog with choices:
  - "Stay in sync" (default, auto-closes after 8s)
  - "Watch on my own" (enters desync mode)
- **Desync Mode:** "Solo" badge with "Resync" button
- **Resync:** Returns to synchronized state with host

### Co-Host UI
- Same controls as host (can play/pause/seek/force-sync)
- "Controller" badge instead of "Host"
- Cannot promote/demote other controllers

## Testing Checklist

### Basic Functionality
1. ✅ Host can toggle between 'everyone' and 'host-only'
2. ✅ Guests see "host controls playback" notice in host-only
3. ✅ Guest play/pause/seek blocked in host-only
4. ✅ Guest snapped back to host position when blocked
5. ✅ Guest can choose "watch on my own" and desync
6. ✅ Desynced guest can resync with host

### Edge Cases
7. ✅ Host leaving room falls back to 'everyone'
8. ✅ Multiple rapid guest actions don't cause loop
9. ✅ Guest can desync during buffering/throttling
10. ✅ Old client events ignored by modern clients
11. ✅ Force sync initiated by controller works
12. ✅ Episode lobby initiated by controller works

### UI/UX
13. ✅ Host toggle only visible to host
14. ✅ Role badges show correct roles
15. ✅ Desync dialog auto-closes after timeout
16. ✅ Resync button visible when desynced
17. ✅ Controller promotion UI visible to host

## Architecture Decisions

### Why Double Gating?
**Sender-side + Receiver-side gates provide defense in depth:**
- Sender-side: Clean UX with dialog for guests
- Receiver-side: Protects against old/buggy/malicious clients
- Server-side: Central enforcement point (optional but recommended)

### Why Extrapolation?
**Linear extrapolation from last heartbeat provides ~±1s accuracy:**
- Better than freezing at last known position
- Handles minor network jitter gracefully
- Capped at 30s to avoid overshooting on stale data

### Why Cooldown?
**600-1000ms cooldown prevents control loops:**
- Guest pause → snap-back → pause → snap-back...
- Allows legitimate desync after cooldown expires
- Doesn't block deliberate user actions

## Migration Path

### From 'everyone' to 'host-only'
1. Host toggles mode to 'host-only'
2. Server validates host authority
3. Server broadcasts `CONTROL_MODE` to all peers
4. All clients update local state
5. Existing playback continues uninterrupted
6. Future guest actions are gated

### From 'host-only' to 'everyone'
1. Host toggles mode to 'everyone'
2. Server validates host authority
3. Server broadcasts `CONTROL_MODE` to all peers
4. All clients update local state
5. All peers regain control immediately

## Performance Considerations

- **Memory:** Minimal overhead (~100 bytes per room for HCM state)
- **CPU:** Snap-back calculation is O(1), negligible impact
- **Network:** No additional traffic beyond existing heartbeats
- **Storage:** Control mode persisted in room state, no additional storage

## Security Considerations

- **No Authentication:** Trust model is client-enforced (no tokens)
- **No Encryption:** Feature doesn't handle sensitive data
- **Rate Limiting:** Control mode changes debounced to prevent spam
- **Validation:** All mode changes validated server-side

## Future Enhancements

### Planned
- Host transfer button (manual host migration)
- Temporary controller promotion (time-limited)
- Guest request control (notification to host)

### Considered but Rejected
- Password-protected host transfer (too complex)
- Vote-based control mode (social complexity)
- Per-action permissions (UI overload)

## Changelog

- **2.5.0**: Initial implementation (July 2026)
- **2.5.1**: Added co-host support and controller promotion
- **2.5.2**: Improved desync UI with resync button
- **2.6.0**: Added server-side rate limiting for mode changes

## See Also

- [Protocol Specification](PROTOCOL.md) — Technical event details
- [Architecture](ARCHITECTURE.md) — System overview
- [Internal Documentation](internal/host-control-mode-plan.md) — Original implementation plan (German)