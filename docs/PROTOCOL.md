# WebSocket Protocol Specification

## Overview

KoalaSync uses WebSocket for real-time communication between clients and the relay server. The protocol is based on Socket.IO events with a custom message format.

- **Transport**: WebSocket only (no long-polling fallback)
- **Server URL**: `wss://syncserver.koalastuff.net` (official) or custom server
- **Protocol Version**: `1.0.0` (current), `MIN_VERSION` not enforced (backward compatible)
- **Authentication**: Optional server token for custom relays

## Protocol Basics

### Message Format

All messages follow the Socket.IO v4 protocol format:
- Engine.IO packet type `42` (WEBSOCKET_MESSAGE)
- JSON-encoded array: `[eventName, payload]`

Example: `42["play",{"currentTime":123.45}]`

### Event Flow

```
Client → Server: JOIN_ROOM, PLAY, PAUSE, SEEK, etc.
Server → Client: ROOM_DATA, PEER_STATUS, CONTROL_MODE, etc.
Client ↔ Server: PING/PONG (latency measurement)
```

## Events Reference

### Connection & Room Management

#### JOIN_ROOM (Client → Server)

Join an existing room or create a new one.

**Payload:**
```json
{
  "roomId": "string (alphanum + hyphens, 64 max)",
  "peerId": "string (16 chars max)",
  "username": "string (30 chars max)",
  "password": "string (128 chars max, optional)",
  "tabTitle": "string (100 chars max, optional)",
  "mediaTitle": "string (100 chars max, optional)",
  "protocolVersion": "string (16 chars max)"
}
```

**Server Response:**
- Success: `ROOM_DATA` event with room state
- Error: `ERROR` event with message

**Rate Limit:** 10 attempts per IP per minute

**Edge Cases:**
- Room ID sanitization (alphanumeric + hyphens only)
- Peer ID deduplication (kicks old socket for same peerId)
- Protocol version mismatch → disconnect

#### LEAVE_ROOM (Client → Server)

Leave the current room.

**Payload:** None

**Server Action:**
- Removes peer from room
- Broadcasts `PEER_STATUS` with `status: 'left'` to remaining peers
- If room becomes empty, deletes room

**Rate Limit:** 10 requests per socket per minute

**Edge Cases:**
- Host leaving → controlMode falls back to 'everyone'
- Last peer leaving → room deletion

#### ROOM_DATA (Server → Client)

Current room state snapshot sent on join or when room changes.

**Payload:**
```json
{
  "roomId": "string",
  "peers": [
    {
      "peerId": "string",
      "username": "string",
      "tabTitle": "string",
      "mediaTitle": "string",
      "playbackState": "playing" | "paused",
      "currentTime": "number",
      "volume": "number",
      "muted": "boolean",
      "lastHeartbeat": "timestamp"
    }
  ],
  "activeLobby": "object | null",
  "hostPeerId": "string | null",
  "controlMode": "everyone" | "host-only",
  "controllers": ["string"],
  "capabilities": ["string"]
}
```

**Triggered by:**
- Successful JOIN_ROOM
- Room state changes (peer join/leave, mode change)

#### ERROR (Server → Client)

Error notification.

**Payload:**
```json
{
  "message": "string"
}
```

**Common Errors:**
- "Incompatible protocol version"
- "Invalid password"
- "Room full"
- "Server capacity reached"

### Media Control Events

#### PLAY (Client → Server → Client)

Resume playback for all peers in the room.

**Payload:**
```json
{
  "currentTime": "number (seconds)"
}
```

**Broadcast:** Relayed to all peers in room

**Gated in host-only mode:** Only controllers can initiate

#### PAUSE (Client → Server → Client)

Pause playback for all peers in the room.

**Payload:**
```json
{
  "currentTime": "number (seconds)"
}
```

**Broadcast:** Relayed to all peers in room

**Gated in host-only mode:** Only controllers can initiate

#### SEEK (Client → Server → Client)

Seek to specific time in the media.

**Payload:**
```json
{
  "targetTime": "number (seconds)"
}
```

**Broadcast:** Relayed to all peers in room

**Gated in host-only mode:** Only controllers can initiate

**Edge Cases:**
- Minimum seek delta (0.5s) to avoid spam
- Coalesced with subsequent seeks within 200ms

### Sync Coordination

#### PEER_STATUS (Client → Server → Client)

Heartbeat with current peer state.

**Payload:**
```json
{
  "peerId": "string",
  "username": "string",
  "tabTitle": "string",
  "mediaTitle": "string",
  "playbackState": "playing" | "paused",
  "currentTime": "number",
  "volume": "number",
  "muted": "boolean",
  "status": "joined" | "left" | "heartbeat"
}
```

**Frequency:** Every 15 seconds (HEARTBEAT_INTERVAL)

**Purpose:**
- Keep-alive
- State synchronization
- Peer presence tracking

#### FORCE_SYNC_PREPARE (Client → Server → Client)

Initiate force sync sequence.

**Payload:**
```json
{
  "targetTime": "number (seconds)"
}
```

**Sequence:**
1. Initiator sends PREPARE
2. Server broadcasts PREPARE to all peers
3. Peers respond with FORCE_SYNC_ACK
4. Initiator sends FORCE_SYNC_EXECUTE after timeout or when all ACKs received
5. Server broadcasts EXECUTE to all peers

**Timeout:** 8.5 seconds (FORCE_SYNC_TIMEOUT)

**Gated in host-only mode:** Only controllers can initiate

#### FORCE_SYNC_ACK (Client → Server)

Acknowledgment of force sync preparation.

**Payload:** None

**Purpose:** Let initiator know peer is ready

#### FORCE_SYNC_EXECUTE (Client → Server → Client)

Execute the force sync (seek + play).

**Payload:**
```json
{
  "targetTime": "number (seconds)"
}
```

**Broadcast:** Relayed to all peers

**Effect:** All peers seek to targetTime and play

### Episode Auto-Sync

#### EPISODE_LOBBY (Client → Server → Client)

Wait for all peers to load the next episode.

**Payload:**
```json
{
  "episodeId": "string",
  "targetTime": "number (seconds, usually 0)"
}
```

**Sequence:**
1. Initiator sends EPISODE_LOBBY
2. Server broadcasts to all peers
3. Peers load episode and send EPISODE_READY when paused at targetTime
4. When all peers ready or timeout, initiator sends EPISODE_LOBBY_CANCEL or room resumes

**Timeout:** 60 seconds (EPISODE_LOBBY_TIMEOUT)

**Gated in host-only mode:** Only controllers can initiate

#### EPISODE_READY (Client → Server)

Peer is ready for episode sync.

**Payload:**
```json
{
  "episodeId": "string"
}
```

#### EPISODE_LOBBY_CANCEL (Client → Server → Client)

Cancel active episode lobby and resume playback.

**Payload:** None

### Host Control Mode

#### SET_CONTROL_MODE (Client → Server)

Host changes room control mode.

**Payload:**
```json
{
  "controlMode": "everyone" | "host-only"
}
```

**Authorization:** Only host (room.hostPeerId) can send

**Server Action:**
- Validates sender is host
- Updates room.controlMode
- Broadcasts CONTROL_MODE to all peers

**Rate Limit:** 500ms debounce per room

#### CONTROL_MODE (Server → Client)

Control mode or role changed.

**Payload:**
```json
{
  "controlMode": "everyone" | "host-only",
  "hostPeerId": "string",
  "controllers": ["string"]
}
```

**Triggered by:**
- SET_CONTROL_MODE from host
- Host leaving room (fallback to 'everyone')
- Controller promotion/demotion

#### SET_PEER_ROLE (Client → Server)

Owner promotes/demotes a peer to/from controller.

**Payload:**
```json
{
  "peerId": "string",
  "controller": "boolean"
}
```

**Authorization:** Only owner (room.hostPeerId) can send

**Server Action:**
- Updates room.controllers set
- Broadcasts CONTROL_MODE to all peers

**Rate Limit:** 500ms debounce per room

### Ping / Latency Measurement

#### PING (Client → Server → Client)

Measure round-trip time.

**Payload:**
```json
{
  "t": "timestamp (Date.now())",
  "target": "peerId (optional, empty = server echo)"
}
```

**Server Response:** PONG with same timestamp

**Frequency:** Every 30 seconds

#### PONG (Server → Client)

Response to PING.

**Payload:**
```json
{
  "t": "timestamp (from PING)"
}
```

### Administrative Events

#### GET_ROOMS (Client → Server)

Request list of active rooms (admin only).

**Payload:** None

**Authorization:** Requires admin token

**Rate Limit:** 10 requests per IP per minute

**Server Response:** ROOM_LIST event

#### ROOM_LIST (Server → Client)

List of active rooms.

**Payload:**
```json
{
  "rooms": [
    {
      "roomId": "string",
      "peerCount": "number",
      "createdAt": "timestamp",
      "lastActivity": "timestamp"
    }
  ]
}
```

## Rate Limits

### Connection Rate Limits

- **Connections:** 10 per IP per minute
- **Authentication Attempts:** 5 per IP per room per minute
- **Event Rate:** 50 events per 10 seconds per socket

### Specific Event Rate Limits

- **Health Checks:** 10 per IP per minute
- **Admin Metrics Auth:** 5 per IP per minute
- **Room List:** 10 per IP per minute (cooldown)
- **LEAVE_ROOM:** 10 per socket per minute

### Debounce Intervals

- **Control Mode Changes:** 500ms per room
- **Role Changes:** 500ms per room

## Server Capabilities

The server advertises supported features in ROOM_DATA.capabilities:

- `host-control`: Host Control Mode feature
- `co-host`: Co-host/promotion feature

Clients should check capabilities before using features.

## Protocol Versioning

- **PROTOCOL_VERSION**: "1.0.0" (current)
- **Backward Compatibility**: Older clients can connect but may not support all features
- **Version Check**: Server validates protocolVersion on JOIN_ROOM

## Edge Cases & Error Handling

### Connection Issues

- **Protocol Mismatch**: Client disconnected with ERROR message
- **Rate Limit Exceeded**: Socket disconnected immediately
- **Server Restart**: Clients auto-reconnect with exponential backoff

### Room Management

- **Host Leaves**: controlMode falls back to 'everyone'
- **Room Full**: Error response on JOIN_ROOM
- **Duplicate PeerId**: Old socket kicked on new join

### Media Sync

- **Seek Spam**: Coalesced within 200ms window
- **Force Sync Timeout**: Auto-executes after 8.5s if not all peers ACK
- **Episode Lobby Timeout**: Auto-cancels after 60s

### Host Control Mode

- **Non-host Attempts**: Event ignored, CONTROL_MODE sent to sync UI
- **Host-only Gating**: play/pause/seek/forceSync/episodeLobby blocked for guests
- **Desync Handling**: Guests can opt-out via dialog, resync button available

## Security Considerations

- **No Authentication**: Trust model is client-enforced (no tokens)
- **Rate Limiting**: Prevents abuse and DoS
- **Input Sanitization**: All strings truncated and validated
- **No Sensitive Data**: Only public room/peer metadata transmitted

## Testing Recommendations

1. **Connection Flow**: Join, leave, reconnect, room creation
2. **Media Sync**: Play/pause/seek propagation, force sync sequence
3. **Host Control**: Mode toggle, guest blocking, desync/resync
4. **Rate Limits**: Verify limits enforced, errors logged
5. **Edge Cases**: Host leave, network blips, seek spam

## Changelog

- **1.0.0**: Initial protocol specification (2026)
- Documented all events from shared/constants.js
- Added rate limit details and edge cases
