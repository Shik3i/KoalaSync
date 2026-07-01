import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { EVENTS, OFFICIAL_SERVER_TOKEN, PROTOCOL_VERSION, CONTROL_MODES, CAPABILITIES } from '../shared/constants.js';
import {
    buildHealthPayload,
    checkCooldown,
    getCachedPayload,
    isAdminMetricsAuthorized,
    isAdminMetricsTokenStrong
} from './ops.js';
import {
    ROOM_LIST_COOLDOWN_MS,
    HEALTH_RATE_LIMIT_PER_MINUTE,
    ADMIN_METRICS_AUTH_RATE_LIMIT_PER_MINUTE,
    connectionCounts,
    failedAuthAttempts,
    eventCounts,
    healthCounts,
    adminMetricsAuthCounts,
    roomListCooldowns,
    rateLimitDenied,
    checkAuthRate,
    recordAuthFailure,
    checkConnectionRate,
    checkEventRate,
    checkHealthRate,
    checkAdminMetricsAuthRate,
    startRateLimitCleanup,
    stopRateLimitCleanup,
    clearRateLimitMaps
} from './rate-limiter.js';

// Re-export for external consumers (tests, ops)
export {
    HEALTH_RATE_LIMIT_PER_MINUTE,
    ADMIN_METRICS_AUTH_RATE_LIMIT_PER_MINUTE,
    healthCounts,
    adminMetricsAuthCounts,
    connectionCounts,
    eventCounts,
    rateLimitDenied
};

dotenv.config();

function hashPassword(password) {
    if (!password) return null;
    const salt = process.env.SERVER_SALT || 'koalasync_salt_3i';
    return crypto.createHmac('sha256', salt).update(password).digest('hex');
}

const PORT = process.env.PORT || 3000;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 1000;
const MAX_PEERS_PER_ROOM = parseInt(process.env.MAX_PEERS_PER_ROOM) || 25;
const MIN_VERSION = process.env.MIN_VERSION || '1.0.0';
const ADMIN_METRICS_TOKEN = process.env.ADMIN_METRICS_TOKEN || '';
const HEALTH_RESPONSE_CACHE_TTL_MS = 60000;

if (!isAdminMetricsTokenStrong(ADMIN_METRICS_TOKEN)) {
    console.warn('[SECURITY] ADMIN_METRICS_TOKEN is set but shorter than 32 characters. Use a long random token.');
}

if (!process.env.SERVER_SALT) {
    console.warn('[SECURITY] SERVER_SALT is not set — using the built-in default salt (public in the repo). Set a unique SERVER_SALT so room-password hashes are not computed with a known salt.');
}

export const app = express();
app.set('trust proxy', 1); // For real client IP through reverse proxy

export const healthResponseCache = new Map();

// Health Check with Rate Limiting
app.get('/', (req, res) => {
    const clientIp = req.ip;
    if (!checkHealthRate(clientIp)) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(getCachedPayload(
        healthResponseCache,
        'root',
        HEALTH_RESPONSE_CACHE_TTL_MS,
        () => ({ status: 'online', service: 'KoalaSync Relay' })
    ));
});

app.get('/health', (req, res) => {
    const clientIp = req.ip;
    if (!checkHealthRate(clientIp)) {
        return res.status(429).json({ error: 'Rate limited' });
    }
    const authHeader = req.get('authorization');
    const includeMetrics = isAdminMetricsAuthorized(authHeader, ADMIN_METRICS_TOKEN);
    if (ADMIN_METRICS_TOKEN && authHeader && !includeMetrics && !checkAdminMetricsAuthRate(clientIp)) {
        return res.status(429).json({ error: 'Rate limited' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(getCachedPayload(
        healthResponseCache,
        includeMetrics ? 'health-admin' : 'health-basic',
        HEALTH_RESPONSE_CACHE_TTL_MS,
        () => buildHealthPayload({
            rooms,
            connections: io.engine?.clientsCount ?? 0,
            includeMetrics,
            uptime: process.uptime(),
            rateLimitSizes: {
                connections: connectionCounts.size,
                events: eventCounts.size,
                health: healthCounts.size,
                adminMetricsAuth: adminMetricsAuthCounts.size,
                authFailures: failedAuthAttempts.size,
                roomList: roomListCooldowns.size
            },
            rateLimitDenied
        })
    ));
});

export const httpServer = createServer(app);

// Socket.IO setup with security constraints
export const io = new Server(httpServer, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || origin === 'https://sync.koalastuff.net' || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
                callback(null, true);
            } else {
                log('CORS', `Rejected origin: ${(origin || '').replace(/[\r\n]/g, '')}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 4096, // 4KB max per message (headroom for JOIN_ROOM payloads)
    transports: ['websocket'],
    allowUpgrades: false
});

startRateLimitCleanup(io);

/**
 * In-memory storage
 */
export const rooms = new Map();
const socketToRoom = new Map();
const peerToSocket = new Map(); // peerId -> socketId (Global lookup)
const roomCreationLocks = new Map(); // roomId -> Promise (prevents race on room creation)
const peerJoinLocks = new Map(); // peerId -> Promise (prevents race on same peerId joins)

// Host Control Mode: events a non-host guest may NOT initiate while a room is in
// 'host-only' mode (they would move/disrupt everyone). Reactions like FORCE_SYNC_ACK,
// EPISODE_READY, PEER_STATUS heartbeats remain allowed for all peers.
const HOST_ONLY_GATED_EVENTS = new Set([
    EVENTS.PLAY,
    EVENTS.PAUSE,
    EVENTS.SEEK,
    EVENTS.FORCE_SYNC_PREPARE,
    EVENTS.FORCE_SYNC_EXECUTE,
    EVENTS.EPISODE_LOBBY,
    EVENTS.EPISODE_LOBBY_CANCEL
]);

// Features this relay supports, advertised to clients in ROOM_DATA so they can
// enable matching UI/behavior only when the server actually backs it. Append a
// flag here when a new server-gated feature ships (e.g. co-host promotion).
const SERVER_CAPABILITIES = [CAPABILITIES.HOST_CONTROL, CAPABILITIES.CO_HOST];

// M-4: minimum interval between CONTROL_MODE changes per room. Stops a rapidly
// toggling host from thrashing every guest's UI (locked/unlocked/locked...) and
// from generating one broadcast per toggle across all peers.
const CONTROL_MODE_MIN_INTERVAL_MS = 500;

// Canonical control-mode/role snapshot sent to clients. controllers always includes
// the owner (hostPeerId). Built in one place so every emit stays consistent.
function controlModePayload(room) {
    return {
        controlMode: room.controlMode,
        hostPeerId: room.hostPeerId,
        controllers: room.controllers ? Array.from(room.controllers) : (room.hostPeerId ? [room.hostPeerId] : [])
    };
}

function log(type, message, details = '') {
    const debugLogging = process.env.DEBUG_LOGGING === '1';
    const isVerbose = type === 'CONN' || type === 'ROOM' || type === 'DEDUPE' || type === 'CORS' || type === 'ACKDROP';
    if (!debugLogging && isVerbose) return;

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`, details);
}

/**
 * Central peer teardown. Removes a socket from all room state and notifies
 * remaining peers. Call this from every disconnect/leave/reaper/dedupe path.
 *
 * @param {string}  socketId   - The socket.id being removed.
 * @param {string}  roomId     - The room it belongs to.
 * @param {string}  reason     - Log label ('disconnect', 'leave', 'reaper', 'dedupe', 'room-switch').
 */
function removePeerFromRoom(socketId, roomId, reason) {
    const room = rooms.get(roomId);
    if (!room) return;

    const peerData = room.peerData.get(socketId);
    if (!peerData) return; // Already cleaned up

    const { peerId } = peerData;

    // 1. Remove from room data structures
    room.peers.delete(socketId);
    room.peerIds.delete(socketId);
    room.peerData.delete(socketId);

    // 2. Remove from global maps
    socketToRoom.delete(socketId);
    const currentSocketId = peerToSocket.get(peerId);
    if (currentSocketId === socketId) {
        peerToSocket.delete(peerId);
    }

    // 3. Notify remaining peers (use io.to so the removed socket itself
    //    doesn't receive it — it has already left or is disconnecting)
    const isPeerStillConnected = Array.from(room.peerData.values()).some(data => data.peerId === peerId);
    if (!isPeerStillConnected) {
        io.to(roomId).emit(EVENTS.PEER_STATUS, { peerId, status: 'left' });
    }

    // 3.5. Clean up active lobby if a peer leaves
    if (room.activeLobby) {
        room.activeLobby.readyPeers = room.activeLobby.readyPeers.filter(id => id !== peerId);
        if (room.activeLobby.readyPeers.length <= 1 || room.activeLobby.initiatorPeerId === peerId) {
            room.activeLobby = null; // Dissolve lobby
        }
    }

    // 3.6. Host Control Mode: if the host left (and isn't still connected via another
    //      socket), fall back to 'everyone' so the room never gets stuck locked, and
    //      reassign host to the earliest remaining peer so the feature stays usable.
    //      (v1: immediate fallback, no grace period — see host-control-mode docs.)
    //      Skip while a join for this peerId is in flight (peerJoinLocks holds it):
    //      that's the reconnect / second-tab case where the same peerId is being
    //      re-added right after the dedupe kicked the old socket. Demoting there
    //      would silently unlock the room on every second-tab open.
    //      NOTE: this does *not* cover a true network blip where the old socket's
    //      'disconnect' fires before the new socket acquires its join lock — in that
    //      window peerJoinLocks is empty, so the fallback fires. Documented v1
    //      limitation (no host grace period); see KNOWN_LIMITATIONS.md.
    const peerRejoining = peerJoinLocks.has(peerId);
    const peerGone = !isPeerStillConnected && !peerRejoining;
    if (peerGone && room.controllers && room.peers.size > 0) {
        const wasController = room.controllers.has(peerId);
        room.controllers.delete(peerId);
        // H-1: a leaving initiator strands the room's force-sync — release the
        // slot so a future controller's PREPARE can take over cleanly.
        if (room.forceSyncInitiator === peerId) room.forceSyncInitiator = null;
        if (room.hostPeerId === peerId) {
            // Owner left → reassign owner + fall back to 'everyone' so the room is
            // never stuck locked, and reset the controller set to just the new owner.
            const nextPeerData = room.peerData.values().next().value;
            room.hostPeerId = nextPeerData ? nextPeerData.peerId : null;
            room.controlMode = CONTROL_MODES.EVERYONE;
            room.controllers = new Set(room.hostPeerId ? [room.hostPeerId] : []);
            io.to(roomId).emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            log('ROOM', `Owner left room ${roomId.substring(0, 3)}*** — fell back to 'everyone', new owner: ${room.hostPeerId}`);
        } else if (wasController) {
            // A co-host left → keep the mode, just broadcast the updated controller list.
            io.to(roomId).emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            log('ROOM', `Controller ${peerId} left room ${roomId.substring(0, 3)}***`);
        }
    }

    // 4. Delete empty room
    if (room.peers.size === 0) {
        rooms.delete(roomId);
        log('ROOM', `Deleted empty room after ${reason}: ${roomId.substring(0, 3)}***`);
    }

    log('ROOM', `Peer ${peerId} removed (${reason}) from room ${roomId.substring(0, 3)}***`);
}

io.on('connection', (socket) => {
    // Get real client IP behind proxy/CDN
    const forwardedFor = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : socket.handshake.address;
    socket._clientIp = clientIp;
    
    // 1. Connection Rate Limit
    if (!checkConnectionRate(clientIp)) {
        log('SECURITY', `Rate limit exceeded for IP: ${clientIp}`);
        socket.disconnect(true);
        return;
    }

    // 2. Token & Version Validation
    const clientToken = socket.handshake.query.token;
    const clientVersion = socket.handshake.query.version;

    if (clientToken !== OFFICIAL_SERVER_TOKEN) {
        log('AUTH', `Unauthorized connection attempt from ${clientIp}`);
        socket.emit(EVENTS.ERROR, { message: 'Unauthorized' });
        socket.disconnect(true);
        return;
    }

    if (clientVersion) {
        if (typeof clientVersion !== 'string') {
            log('AUTH', `Invalid version type from ${clientIp}`);
            socket.emit(EVENTS.ERROR, { message: 'Invalid version format' });
            socket.disconnect(true);
            return;
        }
        const parts = clientVersion.split('.').map(Number);
        const cMaj = parts[0], cMin = parts[1], cPatch = parts[2] || 0;
        const [mMaj, mMin, mPatch] = MIN_VERSION.split('.').map(Number);
        if (isNaN(cMaj) || isNaN(cMin) || isNaN(cPatch)) {
            log('AUTH', `Invalid version format (${clientVersion}) from ${clientIp}`);
            socket.emit(EVENTS.ERROR, { message: 'Invalid version format' });
            socket.disconnect(true);
            return;
        }
        const tooOld = cMaj < mMaj || (cMaj === mMaj && cMin < mMin) || (cMaj === mMaj && cMin === mMin && cPatch < mPatch);
        if (tooOld) {
            log('AUTH', `Version too old (${clientVersion}) from ${clientIp}`);
            socket.emit(EVENTS.ERROR, { message: `Version too old. Minimum: ${MIN_VERSION}` });
            socket.disconnect(true);
            return;
        }
    }

    log('CONN', `New connection: ${socket.id} from ${clientIp}`);

    socket.on(EVENTS.JOIN_ROOM, async (payload) => {
        if (!checkEventRate(socket.id)) {
            log('SECURITY', `Event rate limit exceeded for socket (JOIN): ${socket.id}`);
            socket.disconnect(true);
            return;
        }
        if (!payload || typeof payload.roomId !== 'string') return;

        // --- S-1 & S-5: Sanitize and clamp all incoming fields ---
        const password        = typeof payload.password === 'string' ? payload.password.substring(0, 128) : null;
        const peerId          = typeof payload.peerId === 'string' ? payload.peerId.substring(0, 16) : null;
        const protocolVersion = typeof payload.protocolVersion === 'string' ? payload.protocolVersion.substring(0, 16) : null;
        const roomId   = String(payload.roomId || '').replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 64);
        const username = typeof payload.username  === 'string' ? payload.username.substring(0, 30)  : null;
        const tabTitle = typeof payload.tabTitle  === 'string' ? payload.tabTitle.substring(0, 100) : null;
        const mediaTitle = typeof payload.mediaTitle === 'string' ? payload.mediaTitle.substring(0, 100) : null;

        if (!roomId || !peerId) return; // Guard: empty or invalid after sanitization

        try {
            // Protocol check
            if (protocolVersion !== PROTOCOL_VERSION) {
                log('AUTH', `Protocol mismatch from ${peerId}: ${protocolVersion}`);
                socket.emit(EVENTS.ERROR, { message: 'Incompatible protocol version' });
                return;
            }

            // Cleanup old room if re-joining
            const oldMapping = socketToRoom.get(socket.id);
            if (oldMapping && oldMapping.roomId === roomId && oldMapping.peerId === peerId) {
                return; // Already in this room with same peerId, ignore to prevent spam
            }
            if (oldMapping && oldMapping.roomId !== roomId) {
                socket.leave(oldMapping.roomId);
                removePeerFromRoom(socket.id, oldMapping.roomId, 'room-switch');
            }

            const ip = socket._clientIp || socket.handshake.address;
            if (!checkAuthRate(ip, roomId)) {
                log('AUTH', `Auth rate limit blocked ${ip} from room ${roomId.substring(0, 3)}***`);
                socket.emit(EVENTS.ERROR, { message: "Too many failed attempts. Try again later." });
                return;
            }

            let room = rooms.get(roomId);
            let createdByMe = false;

            if (!room) {
                // Acquire per-room creation lock to prevent race conditions
                let lockPromise = roomCreationLocks.get(roomId);
                if (lockPromise) {
                    await lockPromise;
                    room = rooms.get(roomId);
                }
                if (!room) {
                    // Create and store lock before async boundary
                    let resolveLock;
                    lockPromise = new Promise(resolve => { resolveLock = resolve; });
                    roomCreationLocks.set(roomId, lockPromise);
                    try {
                        if (rooms.size >= MAX_ROOMS) {
                            log('ROOM', `Server at capacity: ${rooms.size}/${MAX_ROOMS} rooms — rejecting join`);
                            socket.emit(EVENTS.ERROR, { message: "Server capacity reached" });
                            return;
                        }

                        const passwordHash = hashPassword(password);
                        room = {
                            passwordHash,
                            peers: new Set(),
                            peerIds: new Map(),
                            peerData: new Map(),
                            lastActivity: Date.now(),
                            // Host Control Mode: creator (first joiner) is the host/owner.
                            hostPeerId: peerId,
                            controlMode: CONTROL_MODES.EVERYONE,
                            lastControlModeChangeAt: 0, // M-4: per-room debounce for control-mode toggles
                            lastRoleChangeAt: 0, // M-4: per-room debounce for role promote/demote
                            // Co-Host: peers allowed to drive in 'host-only'. Always includes the owner.
                            controllers: new Set([peerId]),
                            // H-1: peerId of the in-flight force-sync initiator. Lets a demoted
                            // controller's FORCE_SYNC_EXECUTE through the host-only gate — without
                            // it, demoting a co-host mid-force-sync would drop their EXECUTE and
                            // leave every peer stuck paused.
                            forceSyncInitiator: null
                        };
                        rooms.set(roomId, room);
                        createdByMe = true;
                        log('ROOM', `Created room: ${roomId.substring(0, 3)}***`);
                    } finally {
                        roomCreationLocks.delete(roomId);
                        resolveLock();
                    }
                }
            }

            if (!room) {
                socket.emit(EVENTS.ERROR, { message: "Join error" });
                return;
            }

            let peerLockPromise = peerJoinLocks.get(peerId);
            if (peerLockPromise) {
                await peerLockPromise;
                room = rooms.get(roomId);
                if (!room) {
                    socket.emit(EVENTS.ERROR, { message: "Room no longer exists" });
                    return;
                }
            }
            let resolvePeerLock;
            peerLockPromise = new Promise(resolve => { resolvePeerLock = resolve; });
            peerJoinLocks.set(peerId, peerLockPromise);
            try {
                if (!createdByMe) {
                if (room.passwordHash) {
                    if (!password || hashPassword(password) !== room.passwordHash) {
                        recordAuthFailure(ip, roomId);
                        log('AUTH', `Invalid password from ${ip} for room ${roomId.substring(0, 3)}***`);
                        socket.emit(EVENTS.ERROR, { message: "Invalid password" });
                        return;
                    }
                }
                if (room.peers.size >= MAX_PEERS_PER_ROOM) {
                    log('ROOM', `Room full (${room.peers.size}/${MAX_PEERS_PER_ROOM}): ${roomId.substring(0, 3)}***`);
                    socket.emit(EVENTS.ERROR, { message: "Room full" });
                    return;
                }

                // Peer Deduplication: Remove existing socket for the same peerId
                const dedupeSids = [];
                for (const [sid, data] of room.peerData.entries()) {
                    if (data.peerId === peerId && sid !== socket.id) {
                        dedupeSids.push(sid);
                    }
                }
                for (const sid of dedupeSids) {
                    // Re-check: the socket might have been replaced by another concurrent join
                    const currentMapping = room.peerData.get(sid);
                    if (!currentMapping || currentMapping.peerId !== peerId) continue;
                    
                    const oldSocket = io.sockets.sockets.get(sid);
                    if (oldSocket) {
                        oldSocket.emit(EVENTS.ERROR, { message: 'Deduplication: Another session with this ID joined. Disconnecting...' });
                        oldSocket.leave(roomId);
                        oldSocket.disconnect(true);
                        log('DEDUPE', `Kicked old session for peer ${peerId}`);
                    }
                    removePeerFromRoom(sid, roomId, 'dedupe');
                }
            }

            socket.join(roomId);
            room.peers.add(socket.id);
            room.peerIds.set(socket.id, peerId);
            room.peerData.set(socket.id, { 
                peerId, 
                username: username || null, 
                tabTitle: tabTitle || null,
                mediaTitle: mediaTitle || null,
                lastSeen: Date.now() 
            });
            socketToRoom.set(socket.id, { roomId, peerId });
            peerToSocket.set(peerId, socket.id);

            socket.to(roomId).emit(EVENTS.PEER_STATUS, { peerId, username: username || null, tabTitle: tabTitle || null, mediaTitle: mediaTitle || null, status: 'joined' });
            socket.emit(EVENTS.ROOM_DATA, {
                roomId,
                peers: Array.from(room.peers).map(sid => room.peerData.get(sid)),
                activeLobby: room.activeLobby || null,
                hostPeerId: room.hostPeerId || null,
                controlMode: room.controlMode || CONTROL_MODES.EVERYONE,
                controllers: room.controllers ? Array.from(room.controllers) : [],
                capabilities: SERVER_CAPABILITIES
            });
            log('ROOM', `Peer ${peerId} joined: ${roomId.substring(0, 3)}***`);
            } finally {
                peerJoinLocks.delete(peerId);
                resolvePeerLock();
            }
        } catch (err) {
            log('ERROR', `Join error for ${socket.id}`, err);
            if (socket.connected) {
                socket.emit(EVENTS.ERROR, { message: "Join error" });
            }
        }
    });

    // Relay Loop with Rate Limiting
    const relayEvents = [
        EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK, 
        EVENTS.PEER_STATUS, EVENTS.FORCE_SYNC_PREPARE, 
        EVENTS.FORCE_SYNC_ACK, EVENTS.FORCE_SYNC_EXECUTE,
        EVENTS.EPISODE_LOBBY, EVENTS.EPISODE_READY,
        EVENTS.EPISODE_LOBBY_CANCEL
    ];

    relayEvents.forEach(eventName => {
        socket.on(eventName, (data) => {
            try {
                if (!checkEventRate(socket.id)) {
                    log('SECURITY', `Event rate limit exceeded for socket: ${socket.id}`);
                    socket.disconnect(true);
                    return;
                }

                if (!data || typeof data !== 'object') return;

                const mapping = socketToRoom.get(socket.id);
                if (mapping) {
                    const room = rooms.get(mapping.roomId);
                    if (room) {
                    room.lastActivity = Date.now();

                    // --- Host Control Mode gate ---
                    // In 'host-only' mode, drop room-moving events from anyone who is not
                    // a controller (the owner + any promoted co-hosts). Robust chokepoint:
                    // independent of client behavior, kills spam. Heartbeats/ACKs pass.
                    //
                    // H-1 exception: a demoted co-host's FORCE_SYNC_EXECUTE still has to
                    // land — otherwise their already-relayed PREPARE would leave the whole
                    // room stuck paused. Track the in-flight initiator on PREPARE and let
                    // their matching EXECUTE through regardless of current controllers set.
                    if (eventName === EVENTS.FORCE_SYNC_PREPARE &&
                        room.controlMode === CONTROL_MODES.HOST_ONLY &&
                        room.controllers && room.controllers.has(mapping.peerId)) {
                        room.forceSyncInitiator = mapping.peerId;
                    }
                    const isOwnForceSyncExecute = eventName === EVENTS.FORCE_SYNC_EXECUTE &&
                        room.forceSyncInitiator && mapping.peerId === room.forceSyncInitiator;
                    if (!isOwnForceSyncExecute &&
                        room.controlMode === CONTROL_MODES.HOST_ONLY &&
                        !(room.controllers && room.controllers.has(mapping.peerId)) &&
                        HOST_ONLY_GATED_EVENTS.has(eventName)) {
                        log('ROOM', `Dropped ${eventName} from guest ${mapping.peerId} in host-only room ${mapping.roomId.substring(0, 3)}***`);
                        return;
                    }
                    // Clear initiator tracking once the EXECUTE has been relayed.
                    if (eventName === EVENTS.FORCE_SYNC_EXECUTE && room.forceSyncInitiator) {
                        room.forceSyncInitiator = null;
                    }

                    // --- S-2 & S-3: Sanitize ALL relay fields (strings, numbers, booleans) ---
                    const clamp    = (val, max) => typeof val === 'string' ? val.substring(0, max) : undefined;
                    const clampNum = (val, min, max) => typeof val === 'number' && Number.isFinite(val) ? Math.max(min, Math.min(max, val)) : undefined;
                    const validState = (val) => (val === 'playing' || val === 'paused') ? val : undefined;
                    const validBool  = (val) => typeof val === 'boolean' ? val : undefined;

                    const existing = room.peerData.get(socket.id) || { peerId: mapping.peerId };
                    room.peerData.set(socket.id, { 
                        ...existing,
                        username:      data.username      !== undefined ? (clamp(data.username, 30)   ?? existing.username)      : existing.username,
                        tabTitle:      data.tabTitle      === null ? null : (data.tabTitle      !== undefined ? (clamp(data.tabTitle, 100)  ?? existing.tabTitle)      : existing.tabTitle),
                        mediaTitle:    data.mediaTitle    === null ? null : (data.mediaTitle    !== undefined ? (clamp(data.mediaTitle, 100) ?? existing.mediaTitle)   : existing.mediaTitle),
                        playbackState: data.playbackState !== undefined ? (validState(data.playbackState) ?? existing.playbackState) : existing.playbackState,
                        currentTime:   data.currentTime   === null ? null : (data.currentTime   !== undefined ? (clampNum(data.currentTime, 0, 86400) ?? existing.currentTime)   : existing.currentTime),
                        volume:        data.volume        !== undefined ? (clampNum(data.volume, 0, 1) ?? existing.volume)                 : existing.volume,
                        muted:         data.muted         !== undefined ? (validBool(data.muted) ?? existing.muted)                       : existing.muted,
                        desynced:      data.desynced      !== undefined ? (validBool(data.desynced) === true) : (existing.desynced || false),
                        lastSeen: Date.now()
                    });

                    // --- S-3: Construct clean relay payload — never forward raw client data ---
                    const relayPayload = {
                        senderId:        mapping.peerId,
                        seq:             clampNum(data.seq, 0, Number.MAX_SAFE_INTEGER),
                        currentTime:     data.currentTime === null ? null : clampNum(data.currentTime, 0, 86400),
                        targetTime:      clampNum(data.targetTime, 0, 86400),
                        playbackState:   validState(data.playbackState),
                        username:        clamp(data.username, 30),
                        tabTitle:        data.tabTitle === null ? null : clamp(data.tabTitle, 100),
                        mediaTitle:      data.mediaTitle === null ? null : clamp(data.mediaTitle, 100),
                        volume:          clampNum(data.volume, 0, 1),
                        muted:           validBool(data.muted),
                        desynced:        validBool(data.desynced),
                        peerId:          mapping.peerId,
                        status:          typeof data.status === 'string' ? data.status.substring(0, 16) : undefined,
                        expectedTitle:   clamp(data.expectedTitle, 100),
                        title:           clamp(data.title, 100),
                        actionTimestamp:  clampNum(data.actionTimestamp, 0, Number.MAX_SAFE_INTEGER),
                    };
                    // Strip undefined keys for clean wire format
                    Object.keys(relayPayload).forEach(k => relayPayload[k] === undefined && delete relayPayload[k]);
                    socket.to(mapping.roomId).emit(eventName, relayPayload);

                    // --- Side-effects: Server-side Episode Lobby Tracking ---
                    if (eventName === EVENTS.EPISODE_LOBBY && relayPayload.expectedTitle && !room.activeLobby) {
                        room.activeLobby = {
                            expectedTitle: relayPayload.expectedTitle,
                            initiatorPeerId: mapping.peerId,
                            readyPeers: [mapping.peerId]
                        };
                    } else if (eventName === EVENTS.EPISODE_READY && room.activeLobby) {
                        if (!room.activeLobby.readyPeers.includes(mapping.peerId)) {
                            room.activeLobby.readyPeers.push(mapping.peerId);
                        }
                    } else if ((eventName === EVENTS.FORCE_SYNC_PREPARE || eventName === EVENTS.FORCE_SYNC_EXECUTE || eventName === EVENTS.EPISODE_LOBBY_CANCEL) && room.activeLobby) {
                        room.activeLobby = null;
                    }
                    }
                }
            } catch (err) {
                log('ERROR', `Relay handler error for ${eventName}: ${err.message}`);
            }
        });
    });

    socket.on(EVENTS.GET_ROOMS, () => {
        if (!checkEventRate(socket.id)) {
            log('SECURITY', `Event rate limit exceeded for socket (GET_ROOMS): ${socket.id}`);
            socket.disconnect(true);
            return;
        }
        if (!checkCooldown(roomListCooldowns, socket.id, ROOM_LIST_COOLDOWN_MS)) {
            rateLimitDenied.roomList++;
            socket.emit(EVENTS.ERROR, { message: 'Room list refresh is rate limited. Try again in a few seconds.' });
            return;
        }
        const list = Array.from(rooms.entries()).map(([id, r]) => ({
            id,
            peerCount: r.peers.size,
            hasPassword: !!r.passwordHash
        }));
        socket.emit(EVENTS.ROOM_LIST, { rooms: list });
    });

    socket.on(EVENTS.LEAVE_ROOM, () => {
        if (!checkLeaveRoomRate(socket.id)) {
            log('SECURITY', `LEAVE_ROOM rate limit exceeded for socket: ${socket.id}`);
            return;
        }
        try {
            const mapping = socketToRoom.get(socket.id);
            if (mapping) {
                socket.leave(mapping.roomId);
                removePeerFromRoom(socket.id, mapping.roomId, 'leave');
            }
        } catch (err) {
            log('ERROR', 'removePeerFromRoom failed in leave', err);
        }
    });

    socket.on(EVENTS.SET_CONTROL_MODE, (data) => {
        if (!checkEventRate(socket.id)) {
            log('SECURITY', `Event rate limit exceeded for socket (SET_CONTROL_MODE): ${socket.id}`);
            socket.disconnect(true);
            return;
        }
        if (!data || typeof data !== 'object') return;
        const mode = data.controlMode;
        if (mode !== CONTROL_MODES.EVERYONE && mode !== CONTROL_MODES.HOST_ONLY) return;

        const mapping = socketToRoom.get(socket.id);
        if (!mapping) return;
        const room = rooms.get(mapping.roomId);
        if (!room) return;

        // Only the owner may change the control mode.
        if (mapping.peerId !== room.hostPeerId) {
            log('AUTH', `Non-host ${mapping.peerId} tried to set control mode in ${mapping.roomId.substring(0, 3)}***`);
            // Re-sync the sender to the actual room state so any optimistic UI
            // (e.g. popup toggle) reverts — covers stale-local-amHost races (H-5).
            socket.emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            return;
        }
        if (room.controlMode === mode) return; // no-op, ignore (UI debounce backstop)

        // M-4: per-room debounce — reject toggles faster than CONTROL_MODE_MIN_INTERVAL_MS.
        // The host still gets the final state via the next legit change; this just
        // kills the spam vector.
        const now = Date.now();
        if (now - room.lastControlModeChangeAt < CONTROL_MODE_MIN_INTERVAL_MS) {
            log('ROOM', `Control mode toggle debounced in ${mapping.roomId.substring(0, 3)}***`);
            // Re-sync the sender so any optimistic UI matches the actual (unchanged) state.
            socket.emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            return;
        }

        room.controlMode = mode;
        room.lastControlModeChangeAt = now;
        room.lastActivity = now;
        io.to(mapping.roomId).emit(EVENTS.CONTROL_MODE, controlModePayload(room));
        log('ROOM', `Control mode set to '${mode}' by host in room ${mapping.roomId.substring(0, 3)}***`);
    });

    socket.on(EVENTS.SET_PEER_ROLE, (data) => {
        if (!checkEventRate(socket.id)) {
            log('SECURITY', `Event rate limit exceeded for socket (SET_PEER_ROLE): ${socket.id}`);
            socket.disconnect(true);
            return;
        }
        if (!data || typeof data !== 'object') return;
        const targetPeerId = typeof data.peerId === 'string' ? data.peerId.substring(0, 16) : null;
        const makeController = data.controller === true;
        if (!targetPeerId) return;

        const mapping = socketToRoom.get(socket.id);
        if (!mapping) return;
        const room = rooms.get(mapping.roomId);
        if (!room || !room.controllers) return;

        // Only the owner may promote/demote controllers.
        if (mapping.peerId !== room.hostPeerId) {
            log('AUTH', `Non-owner ${mapping.peerId} tried to set peer role in ${mapping.roomId.substring(0, 3)}***`);
            socket.emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            return;
        }
        // The owner is always a controller and cannot be demoted.
        if (targetPeerId === room.hostPeerId) return;
        // Target must be a peer currently in the room.
        const targetPresent = Array.from(room.peerData.values()).some(d => d.peerId === targetPeerId);
        if (!targetPresent) return;

        const now = Date.now();
        if (now - (room.lastRoleChangeAt || 0) < CONTROL_MODE_MIN_INTERVAL_MS) {
            log('ROOM', `Role change debounced in ${mapping.roomId.substring(0, 3)}***`);
            socket.emit(EVENTS.CONTROL_MODE, controlModePayload(room));
            return;
        }

        if (makeController) {
            if (room.controllers.has(targetPeerId)) return; // no-op
            room.controllers.add(targetPeerId);
        } else {
            if (!room.controllers.has(targetPeerId)) return; // no-op
            room.controllers.delete(targetPeerId);
        }
        room.lastRoleChangeAt = now;
        room.lastActivity = now;
        io.to(mapping.roomId).emit(EVENTS.CONTROL_MODE, controlModePayload(room));
        log('ROOM', `Peer ${targetPeerId} ${makeController ? 'promoted to' : 'demoted from'} controller in ${mapping.roomId.substring(0, 3)}***`);
    });

    socket.on(EVENTS.EVENT_ACK, (data) => {
        if (!checkEventRate(socket.id)) {
            log('SECURITY', `Event rate limit exceeded for socket (ACK): ${socket.id}`);
            socket.disconnect(true);
            return;
        }
        if (!data || typeof data !== 'object') return;
        if (typeof data.targetId !== 'string') return;
        if (data.actionTimestamp !== undefined && (typeof data.actionTimestamp !== 'number' || !Number.isFinite(data.actionTimestamp))) return;
        
        const senderMapping = socketToRoom.get(socket.id);
        const targetSocketId = peerToSocket.get(data.targetId);
        const targetMapping = targetSocketId ? socketToRoom.get(targetSocketId) : null;

        // Security: Only relay ACK if both peers are in the same room
        if (senderMapping && targetMapping && senderMapping.roomId === targetMapping.roomId) {
            io.to(targetSocketId).emit(EVENTS.EVENT_ACK, {
                senderId: senderMapping.peerId,
                actionTimestamp: data.actionTimestamp
            });
        } else if (senderMapping && targetMapping) {
            // Both peers exist but live in different rooms — genuinely suspicious.
            log('SECURITY', `Blocked cross-room ACK attempt from ${socket.id} to ${data.targetId}`);
        } else {
            // Benign + common: sender or target left/disconnected before the ACK
            // arrived (a command was in-flight when they went). Not an attack —
            // log quietly (verbose only) so it doesn't drown out real signals.
            log('ACKDROP', `Dropped ACK from ${socket.id} to absent peer ${data.targetId}`);
        }
    });

    socket.on(EVENTS.PING, (data) => {
        if (!checkEventRate(socket.id)) {
            socket.disconnect(true);
            return;
        }
        if (!data || typeof data.t !== 'number' || !Number.isFinite(data.t)) return;

        if (typeof data.target === 'string' && data.target.length > 0) {
            const targetSocketId = peerToSocket.get(data.target);
            const senderMapping = socketToRoom.get(socket.id);
            if (targetSocketId && senderMapping && data.target !== senderMapping.peerId) {
                const targetMapping = socketToRoom.get(targetSocketId);
                if (targetMapping && targetMapping.roomId === senderMapping.roomId) {
                    io.to(targetSocketId).emit(EVENTS.PING, { t: data.t, sender: senderMapping.peerId });
                    return;
                }
            }
        }

        socket.emit(EVENTS.PONG, { t: data.t });
    });

    socket.on(EVENTS.PONG, (data) => {
        if (!checkEventRate(socket.id)) {
            socket.disconnect(true);
            return;
        }
        if (!data || typeof data.target !== 'string' || data.target.length === 0) return;
        if (typeof data.t !== 'number' || !Number.isFinite(data.t)) return;

        const senderMapping = socketToRoom.get(socket.id);
        if (!senderMapping || data.target === senderMapping.peerId) return;

        const targetSocketId = peerToSocket.get(data.target);
        if (!targetSocketId) return;

        const targetMapping = socketToRoom.get(targetSocketId);
        if (targetMapping && targetMapping.roomId === senderMapping.roomId) {
            io.to(targetSocketId).emit(EVENTS.PONG, { t: data.t });
        }
    });

    socket.on('disconnect', () => {
        eventCounts.delete(socket.id);
        roomListCooldowns.delete(socket.id);
        const mapping = socketToRoom.get(socket.id);
        if (mapping) {
            try {
                removePeerFromRoom(socket.id, mapping.roomId, 'disconnect');
            } catch (err) {
                log('ERROR', 'removePeerFromRoom failed in disconnect', err);
            }
        }
    });
});

// Active Room & Dead Peer Cleanup (Every 2m)
const roomCleanupInterval = setInterval(() => {
    const now = Date.now();
    const roomCutoff = now - (2 * 60 * 60 * 1000); // 2 hours
    const peerCutoff = now - (5 * 60 * 1000);      // 5 minutes
    
    // Snapshot room keys to avoid mutation during iteration
    const roomIds = Array.from(rooms.keys());
    for (const roomId of roomIds) {
        const room = rooms.get(roomId);
        if (!room) continue; // Room may have been deleted between snapshot and now
        // 1. Prune dead peers
        // Snapshot keys first — we must not mutate peerData while iterating it.
        const staleSids = [];
        for (const [sid, data] of room.peerData.entries()) {
            if (data.lastSeen && data.lastSeen < peerCutoff) {
                staleSids.push(sid);
            }
        }
        for (const sid of staleSids) {
            const deadSocket = io.sockets?.sockets?.get(sid);
            if (deadSocket) deadSocket.leave(roomId);
            log('CLEANUP', `Pruning dead peer from room ${roomId.substring(0, 3)}***`);
            try {
                removePeerFromRoom(sid, roomId, 'reaper');
            } catch (err) {
                log('ERROR', 'removePeerFromRoom failed in reaper', err);
            }
        }

        // 2. Prune empty or inactive rooms
        const currentRoom = rooms.get(roomId);
        if (currentRoom && (currentRoom.peers.size === 0 || currentRoom.lastActivity < roomCutoff)) {
            io.to(roomId).emit(EVENTS.ERROR, { message: 'Room closed' });
            rooms.delete(roomId);
            log('CLEANUP', `Deleted room ${roomId.substring(0, 3)}*** (Empty/Inactive)`);
        }
    }
}, 2 * 60 * 1000);

export function startServer(port = PORT, host) {
    if (httpServer.listening) return Promise.resolve(httpServer);
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            httpServer.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            httpServer.off('error', onError);
            const address = httpServer.address();
            const actualPort = address && typeof address === 'object' ? address.port : port;
            log('SERVER', `KoalaSync Relay running on port ${actualPort}`);
            resolve(httpServer);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        if (host) {
            httpServer.listen(port, host);
        } else {
            httpServer.listen(port);
        }
    });
}

// --- M-4: Graceful Shutdown ---
function gracefulShutdown(signal) {
    log('SERVER', `${signal} received — starting graceful shutdown...`);
    // 1. Notify all connected clients so they can display a meaningful message
    io.emit(EVENTS.ERROR, { message: 'Server is restarting. Reconnecting automatically...' });
    // 2. Gracefully disconnect all Socket.IO clients
    io.disconnectSockets(true);
    // 3. Stop accepting new HTTP connections
    httpServer.close(() => {
        log('SERVER', 'HTTP server closed. Exiting.');
        process.exit(0);
    });
    // 4. Safety net: force-exit after 5s if connections don't drain
    setTimeout(() => {
        log('SERVER', 'Force-exit after timeout.');
        process.exit(1);
    }, 5000);
}

export async function stopServerForTests() {
    stopRateLimitCleanup();
    clearInterval(roomCleanupInterval);
    rooms.clear();
    socketToRoom.clear();
    peerToSocket.clear();
    roomCreationLocks.clear();
    peerJoinLocks.clear();
    clearRateLimitMaps();
    healthResponseCache.clear();
    io.removeAllListeners();
    io.disconnectSockets(true);
    Object.assign(rateLimitDenied, { connections: 0, events: 0, health: 0, adminMetricsAuth: 0, roomList: 0 });
    if (!httpServer.listening) return;
    await new Promise((resolve, reject) => {
        httpServer.close((err) => err ? reject(err) : resolve());
    });
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
    startServer(PORT);

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    process.on('uncaughtException', (err) => {
        log('ERROR', `Uncaught exception: ${err.message}`, err.stack);
        process.exit(1);
    });

    let unhandledRejectionCount = 0;
    let unhandledRejectionReset = Date.now();
    process.on('unhandledRejection', (reason) => {
        log('ERROR', `Unhandled rejection: ${reason}`, reason?.stack || '');
        const now = Date.now();
        if (now - unhandledRejectionReset > 60000) {
            unhandledRejectionCount = 0;
            unhandledRejectionReset = now;
        }
        unhandledRejectionCount++;
        if (unhandledRejectionCount >= 5) {
            log('ERROR', `Too many unhandled rejections (${unhandledRejectionCount}/min) — aborting`);
            process.exit(1);
        }
    });
}
