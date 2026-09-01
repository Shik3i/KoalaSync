# WebSocket Protocol Reference

This document describes the relay behavior implemented by `server/index.js` and
the event names defined in `shared/constants.js`.

## Transport

- The relay uses Socket.IO v4 events over WebSocket.
- Long-polling is disabled (`transports: ['websocket']`, `allowUpgrades: false`).
- Messages are Socket.IO event packets whose payload is an event name plus an
  object payload.
- The relay caps incoming Socket.IO message size at 4 KB.

## Invite fragments

Current invitations use named URL-fragment fields:

```text
#j2:r=<roomId>&p=<password>&k=<base64url-chat-secret>[&u=<relayUrl>]
```

The fragment is parsed by the website and forwarded to the extension as structured
fields. `k` is client-only and must never appear in a relay payload. Legacy
`#join:<roomId>:<password>[:1:<relayUrl>]` fragments remain valid but provide no chat
secret.

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
  "clientCapabilities": ["chat-v1", "media-state-v1", "episode-sync-v2"],
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
  "mediaState": "canonical media state object or null",
  "episodeSyncV2": "active transaction object for a frozen participant, or null",
  "capabilities": ["host-control", "co-host", "chat", "chat-v1", "media-state-v1", "episode-sync-v2"]
}
```

`room_data` is sent to the joining socket. It is not the general broadcast used
for every later room update.

## Canonical Media State v1

Relays advertise this optional recovery primitive with `"media-state-v1"` in
`room_data.capabilities`. Each active room stores at most one state:

```json
{
  "revision": 42,
  "playbackState": "playing",
  "currentTime": 1234.5,
  "updatedAt": 1787234425123,
  "updatedBy": "peer-id"
}
```

The internal `currentTime` is the media position at server-owned `updatedAt`.
Playing state advances lazily when a snapshot is requested; paused state stays
fixed. `revision`, `updatedAt`, and `updatedBy` are server-owned. Clients cannot
spoof them. The wire snapshot contains the already-projected `currentTime`,
`revision`, `playbackState`, `updatedBy`, and an optional privacy-sanitized
`mediaTitle`, so clients never compare client and server wall clocks and retain
the existing cross-episode guard during recovery.

Only accepted, sanitized room controls update canonical state:

- `play` uses its valid `currentTime`, or an existing effective canonical position.
- `pause` uses its valid `currentTime`, or freezes an existing effective position.
- `seek` prefers `targetTime` (with `currentTime` compatibility) and preserves the
  established playback state.
- a valid `force_sync_prepare` records only temporary coordination state. The
  next authorized `force_sync_execute` commits the latest room-wide prepared
  target as playing. A target older than `FORCE_SYNC_TARGET_DELAY_WARNING` is
  logged but remains executable until newer room playback supersedes it, because
  receivers are already paused. An execute without retained target still uses
  the legacy wire fallback after relay restart but cannot invent canonical state.
  The latest valid prepare is also the only post-demotion or reconnect execute
  exemption in Host Control mode.

`peer_status` heartbeats are observations and never rewrite canonical intent.
For current clients, the relay drops invalid, duplicate, or regressing `seq`
values on room-moving media commands before relay/canonical mutation. Legacy
clients without `seq` retain their existing behavior. Canonical `revision`
orders server-accepted room transitions; it does not replace per-sender order.

On join/reconnect, a capable extension attempts to apply a valid snapshot
through an extension-internal recovery message. Recovery is only marked handled
after playback state and position verification. Transient failures use bounded
retries after 250, 750, 1500, and 3000 ms and can also be retriggered by target,
heartbeat, or content-boot signals. Existing seek/page-API and native-event
suppression prevent `play`, `pause`, or `seek` echoes. Pending recovery is scoped
to the room/revision in `chrome.storage.session`, waits for the selected media
target lifecycle, and projects a still-playing snapshot from its local receipt
time before a delayed apply. It is cleared on leave/switch. Intentional host-only
guest desync and an active Episode Lobby take precedence over snapshot recovery.

Compatibility is additive: new clients use old behavior with a relay that omits
the capability; old clients ignore the extra `room_data` field from a new relay.
A new relay canonicalizes every accepted legacy `play`, `pause`, `seek`, and
matching Force Sync command regardless of `join_room.clientCapabilities`, while
relaying the established event names, payloads, and order unchanged. This makes
server-first rollout safe: old clients populate recovery state without needing to
understand or acknowledge it, and new clients consume it only when the relay
advertises the capability. No protocol-version or minimum-version bump is
required. New clients also announce `"media-state-v1"` in optional
`join_room.clientCapabilities`; this only tells a capable relay that the client
keeps canonical state current while alone. When a room falls back to one legacy
client, the relay clears potentially stale canonical state instead of recovering
future joiners to unverified solo playback. Offline `play`/`pause`/`seek`
compaction remains the separate
client-owned layer described below rather than part of the relay capability.

### Offline media intent

Offline media intent is client-side queue state, not a relay protocol feature.
An updated extension coalesces contiguous unsent `play`, `pause`, and `seek`
commands for one room. Retained non-media events are ordering barriers. On a
successful rejoin, the extension first reads `room_data` so current Host Control
and Episode Lobby authority can be applied, then replays an authorized intent as
the minimum existing legacy media-event sequence. Actual wire frames, rather
than logical queue entries, consume the paced reconnect budget.

Pending authorized local intent takes precedence over an older canonical
snapshot because it has not yet been accepted by the relay. Its legacy replay
then updates canonical state like any other accepted control. Without pending
intent, canonical recovery proceeds normally. Intent made stale by a room switch,
role loss, intentional solo mode, or an active Episode Lobby is discarded and
cannot suppress server recovery.

This requires no event, capability, ACK, protocol-version, or minimum-version
change. Old relays receive ordinary `play`/`pause`/`seek`; old peers see only the
same existing relayed events.

Queued adjacent `force_sync_prepare` and `force_sync_execute` entries replay in
one paced batch. If either send fails, the full pair remains queued so a later
retry refreshes the prepared target before executing it.

## Ephemeral encrypted chat

Relays advertise chat support with `"chat-v1"` in `room_data.capabilities` and keep
the initial beta's `"chat"` flag during the transition. New clients announce
`"chat-v1"` in optional `join_room.clientCapabilities` (at most the first 16 entries
are inspected; unknown or malformed values are ignored). Old clients omit the field
and continue using the pre-chat protocol unchanged.

The relay sends `chat_message` only to sockets that announced `"chat-v1"`. As a
transition for the first chat beta, a socket that sends a valid v1 ciphertext is
marked capable for the rest of that connection. This prevents old non-chat
extensions from receiving unknown events while preserving the first beta's send
path.

### `chat_message`

Client to relay:

```json
{ "ciphertext": "<unpadded-base64url>" }
```

`ciphertext` contains a 12-byte AES-GCM IV followed by ciphertext and the 16-byte
authentication tag. The relay validates only canonical base64url and byte bounds.
It cannot inspect plaintext.

Relay to every chat-capable current room peer, including the sender:

```json
{
  "id": "<server-generated UUID>",
  "senderId": "<server-stamped peer ID>",
  "timestamp": 1710000000000,
  "ciphertext": "<unpadded-base64url>"
}
```

Client-provided `id`, `senderId`, `timestamp`, or plaintext fields are discarded.
The relay keeps no message collection and `room_data` contains no chat history.
Messages are limited to 10 per socket per 10 seconds in addition to the global event
budget. There are no typing, read-receipt, history, or chat-specific peer-management
events.

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

The current extension sends sequence/action metadata but no target; the relay uses
the latest validated room target retained from `force_sync_prepare`. In
`host-only` mode, only controllers may send it.
The relay also allows that latest valid initiator's execute event after their
controller state changed or their socket reconnected before execute. Invalid
prepares are dropped and grant no exemption. Newer accepted playback/lobby state
explicitly supersedes the prepared target, so its delayed execute is dropped.
Otherwise, even a delayed execute is relayed to release paused receivers.

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
- `chat`
- `chat-v1`
- `media-state-v1`
- `episode-sync-v2`

Clients should treat a missing or unknown capabilities list as unsupported.

## Episode Sync v2

Relays advertise `"episode-sync-v2"`. Updated clients use the additive
`episode_sync_v2` event without changing `PROTOCOL_VERSION`; automatic episode
sync is skipped safely when the relay omits the capability or any current room
peer did not announce it. Manual Force Sync remains on the legacy event family.

The relay creates the transaction ID, freezes non-desynced participants, owns
deadlines, and is the only component that advances:

```text
start -> lobby/loading -> prepare -> execute
                         \-> cancel
```

Client phases are `start`, `loaded`, `prepared`, `failed`, and `cancel`. Relay
phases are `lobby`, `prepare`, `execute`, and `cancel`. Every post-start frame is
correlated by `transactionId`; duplicate or stale frames are idempotently
ignored. No participant is pre-marked loaded. `execute` is emitted exactly once
only after every frozen participant reports `loaded`, then pauses, seeks to
0:00, reaches `readyState >= 3`, and remains on the same player/title in paused,
non-seeking state for `EPISODE_SYNC_V2_STABILITY_MS`.

Any timeout, failed player action, participant departure, manual media command,
room/target change, or explicit cancellation produces `cancel`; v2 never
executes after a timeout. Peers resume only when that transaction paused a
previously playing player and no newer local user action superseded it. Peers
joining after `start` are excluded from the frozen barrier and receive no v2
frames for that transaction.

Legacy episode events remain accepted. A new relay binds their PREPARE, EXECUTE,
and CANCEL to the accepted lobby initiator, limiting duplicate old-client wire
actions; an unmodified old non-initiator can still run its own local timeout, so
full v2 guarantees require capable extensions on every peer.
