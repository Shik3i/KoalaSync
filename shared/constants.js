/**
 * KoalaSync Shared Constants & Protocol Definitions
 * 
 * ⚠️ WARNING: This is the SINGLE SOURCE OF TRUTH.
 * If you edit this file, you MUST run: node scripts/build-extension.cjs
 * to propagate changes to the extension and relay server.
 */

export const PROTOCOL_VERSION = "1.0.0";
export const APP_VERSION = "3.2.0";

export const OFFICIAL_SERVER_URL = 'wss://syncserver.koalastuff.net';
export const OFFICIAL_LANDING_PAGE_URL = 'https://sync.koalastuff.net';
export const OFFICIAL_SERVER_TOKEN = '62170b705234c4f4807a9b22420bb93cf1a2aacfa4c5d3b47804482babb8eb50';
export const SUPPORT_URL = 'https://support.koalastuff.net';
export const GITHUB_URL = 'https://github.com/Shik3i/KoalaSync';

export function isFirefox() {
    const manifest = chrome.runtime.getManifest();
    return !!manifest.browser_specific_settings?.gecko?.id;
}

export function getReviewUrl() {
    return isFirefox()
        ? 'https://addons.mozilla.org/firefox/addon/koalasync/reviews/'
        : 'https://chromewebstore.google.com/detail/koalasync/obbnmkmlaaddodakcbdljknjpagklifc/reviews';
}

export const EVENTS = {
    // Connection & Room
    JOIN_ROOM: "join_room",
    LEAVE_ROOM: "leave_room",
    ROOM_DATA: "room_data", // Server -> Client: current room state
    ERROR: "error",

    // Host Control Mode
    SET_CONTROL_MODE: "set_control_mode", // Client -> Server: host sets room control mode ('everyone' | 'host-only')
    CONTROL_MODE: "control_mode",          // Server -> Client: control mode/role changed { controlMode, hostPeerId, controllers }
    SET_PEER_ROLE: "set_peer_role",        // Client -> Server: owner promotes/demotes a peer { peerId, controller }

    // Media Control
    PLAY: "play",
    PAUSE: "pause",
    SEEK: "seek",
    
    // Sync Coordination
    PEER_STATUS: "peer_status", // Heartbeat from peers
    FORCE_SYNC_PREPARE: "force_sync_prepare",
    FORCE_SYNC_ACK: "force_sync_ack",
    FORCE_SYNC_EXECUTE: "force_sync_execute",
    EVENT_ACK: "event_ack",
    GET_ROOMS: "get_rooms",
    ROOM_LIST: "room_list",

    // Episode Auto-Sync
    EPISODE_LOBBY: "episode_lobby",     // Broadcast: waiting for everyone on this episode
    EPISODE_READY: "episode_ready",      // Response: loaded the episode and paused at 0:00
    EPISODE_LOBBY_CANCEL: "episode_lobby_cancel", // Broadcast: cancel active lobby and resume
    EPISODE_SYNC_V2: "episode_sync_v2", // Capability-gated, relay-authoritative episode transaction

    // Ephemeral end-to-end encrypted chat
    CHAT_MESSAGE: "chat_message", // Ciphertext relay; no server history

    // Ping / Latency
    PING: "ping",  // { t: timestamp, target?: peerId } — empty target = server echo
    PONG: "pong"   // server responds with same { t } for client RTT calculation
};

// Stable server error identifiers. Clients must branch on these codes instead
// of localized or user-facing message text whenever the error changes session
// state.
export const ERROR_CODES = {
    ROOM_CLOSED: 'room_closed',
    PEER_TIMED_OUT: 'peer_timed_out'
};

// Room control modes (Host Control Mode feature).
// NOTE: content.js does not import this module — it uses the string literals
// 'everyone' / 'host-only' directly. Keep these values in sync there.
export const CONTROL_MODES = {
    EVERYONE: 'everyone',   // default: anyone can play/pause/seek for the room
    HOST_ONLY: 'host-only'  // only the host drives the room
};

// Server feature capabilities, advertised to clients in ROOM_DATA. Lets a client
// detect what the relay actually supports instead of inferring it from the
// presence of a data field — so new server features degrade cleanly on older
// relays (unknown/absent list → feature treated as unavailable) and old clients
// simply ignore the field. Add a flag here as each server-gated feature lands.
export const CAPABILITIES = {
    HOST_CONTROL: 'host-control',
    CO_HOST: 'co-host',  // owner promotes guests to additional controllers
    CHAT: 'chat',        // legacy server capability used by the first chat beta
    CHAT_V1: 'chat-v1',  // versioned client/server chat wire contract
    MEDIA_STATE_V1: 'media-state-v1', // server-authoritative room playback recovery snapshot
    EPISODE_SYNC_V2: 'episode-sync-v2' // transaction IDs + relay-owned load/prepare/execute phases
};

// Relay and extension media-time validation must use the same upper bound.
export const MAX_MEDIA_TIME = 86400;

export const HEARTBEAT_INTERVAL = 15000; // 15s
export const FORCE_SYNC_TIMEOUT = 8500; // 8.5s timeout for force sync ACKs (must be > content.js poll timeout of 8s)
// Log unexpectedly delayed EXECUTE delivery after the normal ACK wait plus
// transport grace. The target remains valid until newer room playback replaces it.
export const FORCE_SYNC_TARGET_DELAY_WARNING = FORCE_SYNC_TIMEOUT + 2000;
export const EPISODE_LOBBY_TIMEOUT = 60000; // 60s timeout for episode lobby
// V2 has a relay-owned loading phase. Keep this separate from the bundled
// legacy timer so rolling old/new rooms retain the legacy 60s wire contract.
export const EPISODE_SYNC_V2_LOAD_TIMEOUT = 120000;
export const EPISODE_SYNC_V2_PREPARE_TIMEOUT = 15000; // pause, seek, buffer and 1s stable verification
export const EPISODE_SYNC_V2_EXECUTE_TIMEOUT = 10000; // apply playback and acknowledge before commit
export const EPISODE_SYNC_V2_STABILITY_MS = 1000;
