# KoalaSync Shared Constants

This directory is the source of truth for protocol constants and shared browser/server data.

## Where You Are

- `constants.js`: protocol version, app version, official URLs/token, event names, control modes, capabilities, and timing constants.
- `blacklist.js`: domains hidden by the popup's clutter filter.
- `names.js`: generated username parts and helper used by the extension.
- `extension/shared/`: generated mirror created by `npm run build:extension`; do not edit that mirror directly.

## Syncing with the Extension

> [!IMPORTANT]
> After modifying any file in this directory, run `npm run build:extension` from the repository root.

Browser extensions cannot import files outside their own root directory, so the build script copies shared files into `extension/shared/` and injects selected constants into `content.js`.

## Security & Versioning Constants

- `PROTOCOL_VERSION`: exact protocol version required during `join_room`.
- `APP_VERSION`: extension/app version, injected from release tags by CI.
- `OFFICIAL_SERVER_URL`: default public relay endpoint.
- `OFFICIAL_LANDING_PAGE_URL`: public website and invitation bridge origin.
- `OFFICIAL_SERVER_TOKEN`: public client token used to reject non-KoalaSync Socket.IO clients. It is not a secret; see `docs/KNOWN_LIMITATIONS.md`.
- `SUPPORT_URL` and `GITHUB_URL`: public project links used by the extension UI.

## Control Modes & Capabilities

- `CONTROL_MODES.EVERYONE`: default room mode; any peer may control playback.
- `CONTROL_MODES.HOST_ONLY`: only the host and promoted controllers may move playback.
- `CAPABILITIES.HOST_CONTROL`: relay supports host-only room authority.
- `CAPABILITIES.CO_HOST`: relay supports promoted controller peers.
- `CAPABILITIES.MEDIA_STATE_V1`: relay exposes canonical room playback recovery snapshots.
- `CAPABILITIES.EPISODE_SYNC_V2`: relay owns an ID-correlated load/prepare/execute episode barrier.

Clients should enable capability-gated UI only when the relay advertises the matching flag in `room_data.capabilities`.

## Protocol Events

For the complete event list, read the `EVENTS` object in [`constants.js`](constants.js). Current event groups:

| Event | Direction | Purpose |
|:---|:---|:---|
| `JOIN_ROOM` | Client -> Server | Join or create a room with credentials and protocol version |
| `LEAVE_ROOM` | Client -> Server | Leave the current room |
| `ROOM_DATA` | Server -> Client | Initial room snapshot, peers, host state, capabilities |
| `ERROR` | Server -> Client | Connection, auth, capacity, or protocol error |
| `SET_CONTROL_MODE` | Client -> Server | Host switches between `everyone` and `host-only` |
| `CONTROL_MODE` | Server -> Client | Host/control-mode/controller snapshot changed |
| `SET_PEER_ROLE` | Client -> Server | Host promotes or demotes a co-host/controller |
| `PLAY` / `PAUSE` / `SEEK` | Bidirectional relay | Media control commands |
| `PEER_STATUS` | Bidirectional relay | Heartbeat and current media state |
| `FORCE_SYNC_PREPARE` | Bidirectional relay | Phase 1: pause and seek peers to a target time |
| `FORCE_SYNC_ACK` | Bidirectional relay | Phase 1 confirmation that a peer is ready |
| `FORCE_SYNC_EXECUTE` | Bidirectional relay | Phase 2: resume playback together |
| `EVENT_ACK` | Server -> Client | Delivery confirmation for UI feedback |
| `EPISODE_LOBBY` | Bidirectional relay | Episode transition lobby started |
| `EPISODE_READY` | Bidirectional relay | Peer has loaded the episode and is ready |
| `EPISODE_LOBBY_CANCEL` | Bidirectional relay | Active episode lobby cancelled |
| `EPISODE_SYNC_V2` | Bidirectional, capability-gated | Relay-authoritative episode transaction (`start/lobby/loaded/prepare/prepared/execute/cancel`) |
| `GET_ROOMS` / `ROOM_LIST` | Client <-> Server | Room discovery with server-side cooldown |
| `PING` / `PONG` | Client <-> Server/Peer | Server RTT and peer latency checks |

## Timing Constants

- `HEARTBEAT_INTERVAL`: content heartbeat interval in milliseconds.
- `FORCE_SYNC_TIMEOUT`: max wait for force-sync ACKs.
- `FORCE_SYNC_TARGET_DELAY_WARNING`: threshold for logging delayed Force Sync execution; an unsuperseded prepared target remains executable for receiver liveness.
- `EPISODE_LOBBY_TIMEOUT`: max wait for episode-lobby readiness.
- `EPISODE_SYNC_V2_PREPARE_TIMEOUT`: max wait for every frozen participant to pause, seek, buffer, and verify stable state.
- `EPISODE_SYNC_V2_STABILITY_MS`: continuous ready-state window required before `prepared`.
- `MAX_MEDIA_TIME`: shared relay/extension upper bound, in seconds, for synchronized media positions.

## Do Not Break

- Do not rename events without updating `docs/PROTOCOL.md`, `server/index.js`, `extension/background.js`, and the build-injected `content.js` path.
- Do not edit `extension/shared/` directly.
- Keep new server-gated features behind `CAPABILITIES` so old clients and old relays degrade cleanly.
- Run `npm run build:extension` and `npm run verify` after protocol changes.
