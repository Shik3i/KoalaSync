/**
 * KoalaSync Shared Constants & Protocol Definitions
 */

export const PROTOCOL_VERSION = "1.0.0";
export const APP_VERSION = "1.0.0";

export const OFFICIAL_SERVER_URL = 'wss://sync.shik3i.net';
export const OFFICIAL_LANDING_PAGE_URL = 'https://koalasync.shik3i.net';
export const OFFICIAL_SERVER_TOKEN = 'koala_secure_access_2026';

export const EVENTS = {
    // Connection & Room
    JOIN_ROOM: "join_room",
    LEAVE_ROOM: "leave_room",
    ROOM_DATA: "room_data", // Server -> Client: current room state
    ERROR: "error",

    // Media Control
    PLAY: "play",
    PAUSE: "pause",
    SEEK: "seek",
    
    // Sync Coordination
    PEER_STATUS: "peer_status", // Heartbeat from peers
    FORCE_SYNC_PREPARE: "force_sync_prepare",
    FORCE_SYNC_ACK: "force_sync_ack",
    FORCE_SYNC_EXECUTE: "force_sync_execute",
    GET_ROOMS: "get_rooms",
    ROOM_LIST: "room_list"
};

export const HEARTBEAT_INTERVAL = 15000; // 15s
export const FORCE_SYNC_TIMEOUT = 5000; // 5s timeout for ACKs
