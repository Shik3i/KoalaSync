# WebSocket Protocol Reference

This document describes the relay behavior implemented by `server/index.js` and
the event names defined in `shared/constants.js`.

## Transport

- The relay uses Socket.IO v4 events over WebSocket.
- Long-polling is disabled (`transports: ['websocket']`, `allowUpgrades: false`).
- Messages are Socket.IO event packets whose payload is an event name plus an
  object payload.
- The relay caps incoming Socket.IO message size at 4 KB.

## Connection Handshake

The Socket.IO handshake must include:

- `token`: must match `OFFICIAL_SERVER_TOKEN`.
- `version`: optional app version. If present, it must be a valid semver-like
  string and not older than `MIN_VERSION` (default `1.0.0`).

If the token is invalid, the relay emits `error` and disconnects the socket.
If `version` is invalid or too old, the relay emits `error` and disconnects the
socket.

After the socket is connected, `join_room` must include `protocolVersion`.
It must equal `PROTOCOL_VERSION` exactly. A mismatch emits `error` and rejects
the join attempt; it does not currently disconnect the socket.

## Room Join

### `join_room` (client -> server)

Payload:

```json
{
  "roomId": "string, sanitized to [A-Za-z0-9-], max 64",
  "peerId": "string, max 16",
  "username": "string, max 30",
  "password": "string, max 128, optional",
  "tabTitle": "string, max 100, optional",
  "mediaTitle": "string, max 100, optional",
  "protocolVersion": "string, max 16"
}
```

Behavior:

- Creates the room if it does not exist and capacity allows it.
- The first peer becomes `hostPeerId`.
- Rooms may have an optional password hash.
- Joining with a duplicate `peerId` disconnects the previous socket for that peer.
- Joining the same room with the same socket and peer is ignored as a no-op.
- Switching rooms removes the socket from the old room first.

On success, the joining socket receives `room_data`.
Other room members receive `peer_status` with `status: "joined"`.

### `room_data` (server -> client)

Payload:

```json
{
  "roomId": "string",
  "peers": ["peer state objects"],
  "activeLobby": "object or null",
  "hostPeerId": "string or null",
  "controlMode": "everyone | host-only",
  "controllers": ["peerId"],
  "capabilities": ["host-control", "co-host", "chat"],
  "chatHistory": ["chat message objects"],
  "chatBannedPeerIds": ["peerId"]
}
```

`room_data` is sent to the joining socket. It is not the general broadcast used
for every later room update.

## Room Leave

### `leave_room` (client -> server)

Payload: none.

Behavior:

- Rate-limited to 10 events per socket per minute.
- If the socket is mapped to a room, the relay removes it from that room.
- Remaining room members receive `peer_status` with `status: "left"` when the
  peer is no longer represented by another socket.
- Empty rooms are deleted.
- If the host leaves and peers remain, the relay assigns the next peer as host,
  falls back to `controlMode: "everyone"`, resets controllers to the new host,
  and broadcasts `control_mode`.

Exceeding the `leave_room` limit is logged and the socket is disconnected.

## Relayed Room Events

The relay accepts and sanitizes these events, then emits the same event to other
peers in the room:

- `play`
- `pause`
- `seek`
- `peer_status`
- `force_sync_prepare`
- `force_sync_ack`
- `force_sync_execute`
- `episode_lobby`
- `episode_ready`
- `episode_lobby_cancel`

Relayed payload fields are sanitized and may include:

```json
{
  "senderId": "peerId of sender",
  "seq": "number",
  "currentTime": "number 0..86400 or null",
  "targetTime": "number 0..86400",
  "playbackState": "playing | paused",
  "username": "string, max 30",
  "tabTitle": "string, max 100 or null",
  "mediaTitle": "string, max 100 or null",
  "volume": "number 0..1",
  "muted": "boolean",
  "desynced": "boolean",
  "peerId": "sender peerId",
  "status": "string, max 16",
  "expectedTitle": "string, max 100",
  "title": "string, max 100",
  "actionTimestamp": "number"
}
```

Undefined fields are removed before relay. Raw client payloads are not forwarded.

## Chat

Chat is advertised with `CAPABILITIES.CHAT` (`"chat"`). If the capability is
absent, clients should disable chat UI. The relay omits this capability when
`CHAT_HISTORY_LIMIT=0`, which disables chat entirely server-side.

Chat events are handled by dedicated server handlers, not the generic relay
loop:

- `chat_message`
- `chat_typing`
- `chat_read`
- `chat_ban`
- `chat_unban`
- `chat_system`

### `chat_message`

Client payload:

```json
{
  "username": "string, max 30, optional",
  "text": "string, max 500"
}
```

Server relay payload:

```json
{
  "id": "string",
  "senderId": "peerId of sender",
  "username": "string or null",
  "text": "string, max 500",
  "timestamp": "number"
}
```

The server owns `id`, `senderId`, and `timestamp`. The sanitized message is
sent back to the sender and to other peers. The relay stores the message in
RAM-only room history capped by `CHAT_HISTORY_LIMIT`.

### `chat_typing`

Broadcasts transient typing state to other room peers. Chat-banned peers cannot
send typing events.

### `chat_read`

Relays a read receipt only when sender and target are in the same room.

Payload:

```json
{
  "senderId": "peerId of reader, server-set",
  "targetId": "peerId of original sender",
  "messageId": "chat message id"
}
```

### `chat_ban` / `chat_unban`

Host/controllers can ban or unban a peer from chat without removing them from
the sync room.

Client payload:

```json
{
  "targetId": "peerId"
}
```

Server broadcast payload:

```json
{
  "senderId": "host/controller peerId",
  "targetId": "peerId",
  "chatBannedPeerIds": ["peerId"],
  "timestamp": "number"
}
```

### `chat_system`

Server-generated only. Clients cannot broadcast arbitrary system messages.

## Media Control

### `play`, `pause`, `seek`

These are room-moving actions. In `host-only` mode, the relay drops them unless
the sender is a controller.

Common payload fields:

- `currentTime` for `play`/`pause`.
- `targetTime` for `seek`.
- `seq` and `actionTimestamp` when the extension needs stale-command or ACK
  handling.

The content script applies additional client-side filtering for noisy native
player events before it sends these events.

## Peer Status

### `peer_status`

Used for heartbeats and peer state updates. The extension sends it every
`HEARTBEAT_INTERVAL` while syncing is active.

Typical fields:

- `peerId`
- `username`
- `tabTitle`
- `mediaTitle`
- `playbackState`
- `currentTime`
- `volume`
- `muted`
- `desynced`
- `status`

The relay stores sanitized peer state and relays the sanitized update to other
peers.

## Force Sync

Force sync coordination is implemented primarily in the extension. The relay
sanitizes and relays the events.

### `force_sync_prepare`

Payload includes `targetTime`. The initiator waits for ACKs or for
`FORCE_SYNC_TIMEOUT` before sending `force_sync_execute`.

In `host-only` mode, only controllers may initiate it.

### `force_sync_ack`

The extension sends ACKs with peer identity and sequence data. The relay relays
them with the same sanitized relay envelope as other room events, including
`senderId`.

### `force_sync_execute`

Payload includes `targetTime`. In `host-only` mode, only controllers may send it.
The relay also allows a matching initiator's execute event after that initiator
started the prepare step, even if their controller state changed before execute.

## Episode Lobby

Episode lobby coordination is implemented primarily in the extension. The relay
tracks enough state to include `activeLobby` in `room_data` for later joiners.

### `episode_lobby`

Payload uses `expectedTitle`. The relay creates `activeLobby` when this field is
present and no lobby is already active.

In `host-only` mode, only controllers may initiate it.

### `episode_ready`

Payload may include `title`. The relay adds the sender to the active lobby's
ready list when a lobby exists.

### `episode_lobby_cancel`

Clears the active lobby and is relayed to peers. In `host-only` mode, only
controllers may initiate it.

## Host Control Mode

### `set_control_mode` (client -> server)

Payload:

```json
{
  "controlMode": "everyone | host-only"
}
```

Only the room host may change the mode. Non-host attempts are ignored and the
sender receives the current `control_mode` snapshot.

Mode changes are debounced per room with `CONTROL_MODE_MIN_INTERVAL_MS` (500 ms).

### `set_peer_role` (client -> server)

Payload:

```json
{
  "peerId": "string, max 16",
  "controller": "boolean"
}
```

Only the room host may promote or demote controllers. The host cannot demote
themself. Role changes use the same 500 ms per-room debounce as mode changes.

### `control_mode` (server -> client)

Payload:

```json
{
  "controlMode": "everyone | host-only",
  "hostPeerId": "string or null",
  "controllers": ["peerId"]
}
```

Sent when mode or controller state changes, when host migration changes room
authority, and when unauthorized role/mode attempts need to resync the sender.

## Room List

### `get_rooms` (client -> server)

Payload: none.

No admin token is required for this Socket.IO event.

Limits:

- Counts against the per-socket event limit.
- Also has a 10 second per-socket cooldown.

### `room_list` (server -> client)

Payload:

```json
{
  "rooms": [
    {
      "id": "room id",
      "peerCount": 2,
      "hasPassword": false
    }
  ]
}
```

## Ping, Pong, and ACK

### `ping`

Payload:

```json
{
  "t": 1234567890,
  "target": "peerId, optional"
}
```

If `target` is omitted, the relay responds to the sender with `pong`.
If `target` is another peer in the same room, the relay sends `ping` to that peer
with `{ "t": ..., "sender": "senderPeerId" }`.

### `pong`

Payload:

```json
{
  "t": 1234567890,
  "target": "peerId, optional"
}
```

If `target` is a peer in the same room, the relay sends `pong` to that peer with
`{ "t": ... }`.

### `event_ack`

Client payload:

```json
{
  "targetId": "peerId",
  "actionTimestamp": 1234567890
}
```

If sender and target are still in the same room, the relay emits:

```json
{
  "senderId": "sender peerId",
  "actionTimestamp": 1234567890
}
```

## Rate Limits

- Connections: 10 per IP per minute; excess connections are disconnected.
- Relayed/events: 50 per socket per 10 seconds; excess disconnects the socket.
- `get_rooms`: 10 second cooldown per socket plus the event limit.
- `leave_room`: 10 per socket per minute; excess disconnects the socket.
- Invalid room passwords: tracked per IP and room. Five recent failures block
  more password attempts for that room until the failure window ages out.
- HTTP health and admin-metrics endpoints have their own rate limits outside this
  Socket.IO protocol.

## Capabilities

`room_data.capabilities` advertises server-backed features:

- `host-control`
- `co-host`

Clients should treat a missing or unknown capabilities list as unsupported.
