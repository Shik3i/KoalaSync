import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { EVENTS, OFFICIAL_SERVER_TOKEN } from '../shared/constants.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 1000;
const MAX_PEERS_PER_ROOM = parseInt(process.env.MAX_PEERS_PER_ROOM) || 50;
const MIN_VERSION = process.env.MIN_VERSION || '1.0.0';

const app = express();
app.set('trust proxy', 1); // For real client IP through reverse proxy

// Health Check
app.get('/', (req, res) => res.json({ status: 'online', service: 'KoalaSync Relay' }));

const httpServer = createServer(app);

// Socket.IO setup with security constraints
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1024, // 1KB max per message
    transports: ['websocket'],
    allowUpgrades: false
});

/**
 * In-memory storage
 */
const rooms = new Map();
const socketToRoom = new Map();
const peerToSocket = new Map(); // peerId -> socketId (Global lookup)

function log(type, message, details = '') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`, details);
}

// Rate Limiting & Security
const connectionCounts = new Map(); // ip -> { count, resetTime }
const failedAuthAttempts = new Map(); // Map<IP+RoomID, {count, lastAttempt}>

function checkAuthRate(ip, roomId) {
    const key = `${ip}:${roomId}`;
    const now = Date.now();
    const record = failedAuthAttempts.get(key) || { count: 0, lastAttempt: 0 };
    
    // Block for 15 mins if 5 fails in 2 mins
    if (record.count >= 5 && (now - record.lastAttempt) < 15 * 60 * 1000) {
        return false;
    }
    
    // Reset if last attempt was long ago
    if ((now - record.lastAttempt) > 2 * 60 * 1000) {
        record.count = 0;
    }
    
    return true;
}

function recordAuthFailure(ip, roomId) {
    const key = `${ip}:${roomId}`;
    const record = failedAuthAttempts.get(key) || { count: 0, lastAttempt: 0 };
    record.count++;
    record.lastAttempt = Date.now();
    failedAuthAttempts.set(key, record);
}

// Periodically clean up old auth failure records (every hour)
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of failedAuthAttempts.entries()) {
        if (now - record.lastAttempt > 60 * 60 * 1000) {
            failedAuthAttempts.delete(key);
        }
    }
}, 60 * 60 * 1000);

const eventCounts = new Map(); // socketId -> { count, resetTime }

// Clean up connection counts to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of connectionCounts.entries()) {
        if (now > entry.resetTime) {
            connectionCounts.delete(ip);
        }
    }
}, 60000);

function checkConnectionRate(ip) {
    const now = Date.now();
    const entry = connectionCounts.get(ip) || { count: 0, resetTime: now + 60000 };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + 60000; }
    entry.count++;
    connectionCounts.set(ip, entry);
    return entry.count <= 10;
}

function checkEventRate(socketId) {
    const now = Date.now();
    const entry = eventCounts.get(socketId) || { count: 0, resetTime: now + 10000 };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + 10000; }
    entry.count++;
    eventCounts.set(socketId, entry);
    return entry.count <= 30;
}

io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    
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
        const [cMaj, cMin, cPatch] = clientVersion.split('.').map(Number);
        const [mMaj, mMin, mPatch] = MIN_VERSION.split('.').map(Number);
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
        const { roomId, password, peerId, username, tabTitle, mediaTitle, protocolVersion } = payload;
        try {
            // Protocol check
            if (protocolVersion !== '1.0.0') {
                log('AUTH', `Protocol mismatch from ${peerId}: ${protocolVersion}`);
                socket.emit(EVENTS.ERROR, { message: 'Incompatible protocol version' });
                return;
            }

            // Cleanup old room if re-joining
            const oldMapping = socketToRoom.get(socket.id);
            if (oldMapping && oldMapping.roomId === roomId) {
                return; // Already in this room, ignore to prevent spam
            }
            if (oldMapping && oldMapping.roomId !== roomId) {
                socket.leave(oldMapping.roomId);
                const oldRoom = rooms.get(oldMapping.roomId);
                if (oldRoom) {
                    oldRoom.peers.delete(socket.id);
                    oldRoom.peerIds.delete(socket.id);
                    oldRoom.peerData.delete(socket.id);
                    socket.to(oldMapping.roomId).emit(EVENTS.PEER_STATUS, { peerId: oldMapping.peerId, status: 'left' });
                    if (oldRoom.peers.size === 0) rooms.delete(oldMapping.roomId);
                }
            }

            const ip = socket.handshake.address;
            if (!checkAuthRate(ip, roomId)) {
                socket.emit(EVENTS.ERROR, { message: "Too many failed attempts. Try again later." });
                return;
            }

            let room = rooms.get(roomId);

            if (!room) {
                if (rooms.size >= MAX_ROOMS) {
                    socket.emit(EVENTS.ERROR, { message: "Server capacity reached" });
                    return;
                }

                const passwordHash = password ? await bcrypt.hash(password, 10) : null;
                room = {
                    passwordHash,
                    peers: new Set(),
                    peerIds: new Map(),
                    peerData: new Map(), // socketId -> { peerId, tabTitle }
                    lastActivity: Date.now()
                };
                rooms.set(roomId, room);
                log('ROOM', `Created room: ${roomId.substring(0, 3)}***`);
            } else {
                if (room.passwordHash) {
                    if (!password || !(await bcrypt.compare(password, room.passwordHash))) {
                        recordAuthFailure(ip, roomId);
                        socket.emit(EVENTS.ERROR, { message: "Invalid password" });
                        return;
                    }
                }
                if (room.peers.size >= MAX_PEERS_PER_ROOM) {
                    socket.emit(EVENTS.ERROR, { message: "Room full" });
                    return;
                }

                // Peer Deduplication: Remove existing socket for the same peerId
                for (const [sid, data] of room.peerData.entries()) {
                    if (data.peerId === peerId && sid !== socket.id) {
                        const oldSocket = io.sockets.sockets.get(sid);
                        if (oldSocket) {
                            oldSocket.emit(EVENTS.ERROR, { message: 'Deduplication: Another session with this ID joined. Disconnecting...' });
                            oldSocket.leave(roomId);
                            oldSocket.disconnect(true);
                            log('DEDUPE', `Kicked old session for peer ${peerId}`);
                        }
                        room.peers.delete(sid);
                        room.peerIds.delete(sid);
                        room.peerData.delete(sid);
                        socket.to(roomId).emit(EVENTS.PEER_STATUS, { peerId: data.peerId, status: 'left' });
                        log('ROOM', `Deduplicated peer ${peerId} from room ${roomId}`);
                    }
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
                peers: Array.from(room.peers).map(sid => room.peerData.get(sid)) 
            });
            log('ROOM', `Peer ${peerId} joined: ${roomId.substring(0, 3)}***`);
        } catch (err) {
            log('ERROR', `Join error for ${socket.id}`, err);
            socket.emit(EVENTS.ERROR, { message: "Join error" });
        }
    });

    // Relay Loop with Rate Limiting
    const relayEvents = [
        EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK, 
        EVENTS.PEER_STATUS, EVENTS.FORCE_SYNC_PREPARE, 
        EVENTS.FORCE_SYNC_ACK, EVENTS.FORCE_SYNC_EXECUTE
    ];

    relayEvents.forEach(eventName => {
        socket.on(eventName, (data) => {
            if (!checkEventRate(socket.id)) {
                log('SECURITY', `Event rate limit exceeded for socket: ${socket.id}`);
                socket.disconnect(true);
                return;
            }

            if (!data || typeof data !== 'object') return; // Prevent null/invalid payload crash

            const mapping = socketToRoom.get(socket.id);
            if (mapping) {
                const room = rooms.get(mapping.roomId);
                if (room) {
                    room.lastActivity = Date.now();
                    
                    // Update peer metadata and lastSeen
                    const existing = room.peerData.get(socket.id) || { peerId: mapping.peerId };
                    room.peerData.set(socket.id, { 
                        ...existing,
                        username: data.username !== undefined ? data.username : existing.username,
                        tabTitle: data.tabTitle !== undefined ? data.tabTitle : existing.tabTitle,
                        mediaTitle: data.mediaTitle !== undefined ? data.mediaTitle : existing.mediaTitle,
                        lastSeen: Date.now()
                    });

                    socket.to(mapping.roomId).emit(eventName, { ...data, senderId: mapping.peerId });
                }
            }
        });
    });

    socket.on(EVENTS.GET_ROOMS, () => {
        const list = Array.from(rooms.entries()).map(([id, r]) => ({
            id,
            peerCount: r.peers.size,
            hasPassword: !!r.passwordHash
        }));
        socket.emit(EVENTS.ROOM_LIST, { rooms: list });
    });

    socket.on(EVENTS.LEAVE_ROOM, () => {
        const mapping = socketToRoom.get(socket.id);
        if (mapping) {
            const { roomId, peerId } = mapping;
            socket.leave(roomId);
            const room = rooms.get(roomId);
            if (room) {
                room.peers.delete(socket.id);
                room.peerIds.delete(socket.id);
                room.peerData.delete(socket.id);
                socket.to(roomId).emit(EVENTS.PEER_STATUS, { peerId, status: 'left' });
                if (room.peers.size === 0) {
                    rooms.delete(roomId);
                    log('ROOM', `Deleted empty room: ${roomId.substring(0, 3)}***`);
                }
            }
            socketToRoom.delete(socket.id);
            if (peerToSocket.get(peerId) === socket.id) {
                peerToSocket.delete(peerId);
            }
        }
    });

        socket.on(EVENTS.EVENT_ACK, (data) => {
            if (!data.targetId) return;
            
            const senderMapping = socketToRoom.get(socket.id);
            const targetSocketId = peerToSocket.get(data.targetId);
            const targetMapping = targetSocketId ? socketToRoom.get(targetSocketId) : null;

            // Security: Only relay ACK if both peers are in the same room
            if (senderMapping && targetMapping && senderMapping.roomId === targetMapping.roomId) {
                io.to(targetSocketId).emit(EVENTS.EVENT_ACK, { 
                    senderId: senderMapping.peerId,
                    actionTimestamp: data.actionTimestamp
                });
            } else {
                log('SECURITY', `Blocked cross-room ACK attempt from ${socket.id} to ${data.targetId}`);
            }
        });

    socket.on('disconnect', () => {
        eventCounts.delete(socket.id);
        const mapping = socketToRoom.get(socket.id);
        if (mapping) {
            const { roomId, peerId } = mapping;
            const room = rooms.get(roomId);
            if (room) {
                room.peers.delete(socket.id);
                room.peerIds.delete(socket.id);
                room.peerData.delete(socket.id);
                socket.to(roomId).emit(EVENTS.PEER_STATUS, { peerId, status: 'left' });
                if (room.peers.size === 0) {
                    rooms.delete(roomId);
                    log('ROOM', `Deleted empty room (after disconnect): ${roomId.substring(0, 3)}***`);
                }
            }
            socketToRoom.delete(socket.id);
            if (peerToSocket.get(peerId) === socket.id) {
                peerToSocket.delete(peerId);
            }
        }
    });
});

// Active Room & Dead Peer Cleanup (Every 2m)
setInterval(() => {
    const now = Date.now();
    const roomCutoff = now - (2 * 60 * 60 * 1000); // 2 hours
    const peerCutoff = now - (5 * 60 * 1000);      // 5 minutes
    
    for (const [roomId, room] of rooms) {
        // 1. Prune dead peers
        for (const [sid, data] of room.peerData.entries()) {
            if (data.lastSeen && data.lastSeen < peerCutoff) {
                const socket = io.sockets.sockets.get(sid);
                if (socket) socket.leave(roomId);
                
                room.peers.delete(sid);
                room.peerIds.delete(sid);
                room.peerData.delete(sid);
                socketToRoom.delete(sid);
                if (peerToSocket.get(data.peerId) === sid) {
                    peerToSocket.delete(data.peerId);
                }
                
                io.to(roomId).emit(EVENTS.PEER_STATUS, { peerId: data.peerId, status: 'left' });
                log('CLEANUP', `Pruned dead peer ${data.peerId} from room ${roomId}`);
            }
        }

        // 2. Prune empty or inactive rooms
        if (room.peers.size === 0 || room.lastActivity < roomCutoff) {
            io.to(roomId).emit(EVENTS.ERROR, { message: 'Room closed' });
            rooms.delete(roomId);
            log('CLEANUP', `Deleted room ${roomId.substring(0, 3)}*** (Empty/Inactive)`);
        }
    }
}, 2 * 60 * 1000);

httpServer.listen(PORT, () => {
    log('SERVER', `KoalaSync Relay running on port ${PORT}`);
});
