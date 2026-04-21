# KoalaSync Shared Constants

This directory contains constants and protocol definitions used by both the extension and the server.

## Syncing with the Extension
> [!IMPORTANT]
> Every time this file is modified, you must run `scripts/sync-constants.sh` to keep the extension's copy up to date.

Because Chrome Extensions cannot load files outside their root directory, `constants.js` must be copied to `extension/shared/constants.js` whenever it is modified.

## Security & Versioning Constants
- `OFFICIAL_SERVER_TOKEN`: A 32-byte hex token required to connect to the official relay server.
- `APP_VERSION`: The current version of the extension. Used by the server to enforce minimum version requirements (Revocation). This must always be in sync with `manifest.json`.
- `OFFICIAL_SERVER_URL`: The default endpoint for the official KoalaSync relay.
- `ROOM_DATA`: Server response with current room state (peers).
- `PLAY`: Sync command to start playback.
- `PAUSE`: Sync command to pause playback.
- `SEEK`: Sync command to change the current time.
- `PEER_STATUS`: Heartbeat or join/leave notification for peers.
- `FORCE_SYNC_PREPARE`: Phase 1 of Force Sync (Pause & Seek).
- `FORCE_SYNC_ACK`: Peer confirmation of Phase 1 readiness.
- `FORCE_SYNC_EXECUTE`: Phase 2 of Force Sync (Start Playback).
- `ERROR`: Generic error message from the server.
