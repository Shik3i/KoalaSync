/**
 * KoalaSync Shared Constants & Protocol Definitions
 * 
 * ⚠️ WARNING: This is the SINGLE SOURCE OF TRUTH.
 * If you edit this file, you MUST run /scripts/sync-constants.bat 
 * to propagate changes to the extension and relay server.
 */

export const PROTOCOL_VERSION = "1.0.0";
export const APP_VERSION = "1.1.4";

export const OFFICIAL_SERVER_URL = 'wss://sync.shik3i.net';
export const OFFICIAL_LANDING_PAGE_URL = 'https://koalasync.shik3i.net';
export const OFFICIAL_SERVER_TOKEN = '62170b705234c4f4807a9b22420bb93cf1a2aacfa4c5d3b47804482babb8eb50';

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
    EVENT_ACK: "event_ack",
    GET_ROOMS: "get_rooms",
    ROOM_LIST: "room_list"
};

export const HEARTBEAT_INTERVAL = 15000; // 15s
export const FORCE_SYNC_TIMEOUT = 5000; // 5s timeout for ACKs
