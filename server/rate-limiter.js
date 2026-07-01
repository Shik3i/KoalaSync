/**
 * KoalaSync Rate Limiter
 * Connection, event, health, and auth rate limiting for the relay server.
 */

export const ROOM_LIST_COOLDOWN_MS = 10000;
export const HEALTH_RATE_LIMIT_PER_MINUTE = 10;
export const ADMIN_METRICS_AUTH_RATE_LIMIT_PER_MINUTE = 5;

// --- Connection & event budgets (formerly inline magic numbers) ---
export const CONNECTION_RATE_LIMIT = 10;           // max new connections per IP per window
export const CONNECTION_RATE_WINDOW_MS = 60000;    // 1 minute
export const EVENT_RATE_LIMIT = 50;                // max relayed events per socket per window
export const EVENT_RATE_WINDOW_MS = 10000;         // 10 seconds
export const HEALTH_RATE_WINDOW_MS = 60000;        // 1 minute
export const ADMIN_METRICS_AUTH_WINDOW_MS = 60000; // 1 minute
export const LEAVE_ROOM_RATE_LIMIT = 10;           // max LEAVE_ROOM events per socket per window
export const LEAVE_ROOM_RATE_WINDOW_MS = 60000;    // 1 minute

export const connectionCounts = new Map(); // ip -> { count, resetTime }
export const failedAuthAttempts = new Map(); // Map<IP+RoomID, {count, lastAttempt}>
export const eventCounts = new Map(); // socketId -> { count, resetTime }
export const healthCounts = new Map(); // ip -> { count, resetTime }
export const adminMetricsAuthCounts = new Map(); // ip -> { count, resetTime }
export const roomListCooldowns = new Map(); // socketId -> last allowed timestamp
export const leaveRoomCounts = new Map();    // socketId -> { count, resetTime }

export const rateLimitDenied = {
    connections: 0,
    events: 0,
    health: 0,
    adminMetricsAuth: 0,
    roomList: 0,
    leaveRoom: 0
};

let authCleanupId = null;
let rateLimitCleanupId = null;

export function checkAuthRate(ip, roomId) {
    const key = `${ip}:${roomId}`;
    const now = Date.now();
    const record = failedAuthAttempts.get(key) || { count: 0, lastAttempt: 0 };

    if (record.count >= 5 && (now - record.lastAttempt) < 15 * 60 * 1000) {
        return false;
    }

    if ((now - record.lastAttempt) > 2 * 60 * 1000) {
        record.count = 0;
    }

    return true;
}

export function recordAuthFailure(ip, roomId) {
    if (failedAuthAttempts.size > 200000) {
        const now = Date.now();
        for (const [key, record] of failedAuthAttempts.entries()) {
            if (now - record.lastAttempt > 15 * 60 * 1000) {
                failedAuthAttempts.delete(key);
            } else {
                break;
            }
        }

        if (failedAuthAttempts.size > 200000) {
            console.warn('SECURITY: failedAuthAttempts size exceeded 200000. Performing insertion-order eviction.');
            for (const [key] of failedAuthAttempts.entries()) {
                if (failedAuthAttempts.size <= 190000) {
                    break;
                }
                failedAuthAttempts.delete(key);
            }
        }
    }
    const key = `${ip}:${roomId}`;
    const record = failedAuthAttempts.get(key) || { count: 0, lastAttempt: 0 };
    record.count++;
    record.lastAttempt = Date.now();
    failedAuthAttempts.delete(key);
    failedAuthAttempts.set(key, record);
}

export function checkConnectionRate(ip) {
    const now = Date.now();
    const entry = connectionCounts.get(ip) || { count: 0, resetTime: now + CONNECTION_RATE_WINDOW_MS };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + CONNECTION_RATE_WINDOW_MS; }
    entry.count++;
    connectionCounts.set(ip, entry);
    if (entry.count <= CONNECTION_RATE_LIMIT) return true;
    rateLimitDenied.connections++;
    return false;
}

export function checkEventRate(socketId) {
    const now = Date.now();
    const entry = eventCounts.get(socketId) || { count: 0, resetTime: now + EVENT_RATE_WINDOW_MS };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + EVENT_RATE_WINDOW_MS; }
    entry.count++;
    eventCounts.set(socketId, entry);
    if (entry.count <= EVENT_RATE_LIMIT) return true;
    rateLimitDenied.events++;
    return false;
}

export function checkHealthRate(ip) {
    const now = Date.now();
    const entry = healthCounts.get(ip) || { count: 0, resetTime: now + HEALTH_RATE_WINDOW_MS };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + HEALTH_RATE_WINDOW_MS; }
    entry.count++;
    healthCounts.set(ip, entry);
    if (entry.count <= HEALTH_RATE_LIMIT_PER_MINUTE) return true;
    rateLimitDenied.health++;
    return false;
}

export function checkAdminMetricsAuthRate(ip) {
    const now = Date.now();
    const entry = adminMetricsAuthCounts.get(ip) || { count: 0, resetTime: now + ADMIN_METRICS_AUTH_WINDOW_MS };
    if (now > entry.resetTime) { entry.count = 0; entry.resetTime = now + ADMIN_METRICS_AUTH_WINDOW_MS; }
    entry.count++;
    adminMetricsAuthCounts.set(ip, entry);
    if (entry.count <= ADMIN_METRICS_AUTH_RATE_LIMIT_PER_MINUTE) return true;
    rateLimitDenied.adminMetricsAuth++;
    return false;
}

export function checkLeaveRoomRate(socketId) {
    const now = Date.now();
    const entry = leaveRoomCounts.get(socketId) || { count: 0, resetTime: now + LEAVE_ROOM_RATE_WINDOW_MS };
    if (now > entry.resetTime) {
        entry.count = 0;
        entry.resetTime = now + LEAVE_ROOM_RATE_WINDOW_MS;
    }
    entry.count++;
    leaveRoomCounts.set(socketId, entry);
    if (entry.count <= LEAVE_ROOM_RATE_LIMIT) return true;
    rateLimitDenied.leaveRoom++;
    return false;
}

export function startRateLimitCleanup(io) {
    if (authCleanupId !== null || rateLimitCleanupId !== null) return; // guard double-start
    // Clean up old auth failure records (every 15 minutes)
    authCleanupId = setInterval(() => {
        const now = Date.now();
        for (const [key, record] of failedAuthAttempts.entries()) {
            if (now - record.lastAttempt > 15 * 60 * 1000) {
                failedAuthAttempts.delete(key);
            }
        }
    }, 15 * 60 * 1000);

    // Clean up rate-limit maps to prevent memory leaks (every 60 seconds)
    rateLimitCleanupId = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of connectionCounts.entries()) {
            if (now > entry.resetTime) connectionCounts.delete(ip);
        }
        for (const [socketId, entry] of eventCounts.entries()) {
            if (now > entry.resetTime || !io.sockets.sockets.has(socketId)) {
                eventCounts.delete(socketId);
            }
        }
        for (const [socketId, entry] of leaveRoomCounts.entries()) {
            if (now > entry.resetTime) {
                leaveRoomCounts.delete(socketId);
            }
        }
        for (const [ip, entry] of healthCounts.entries()) {
            if (now > entry.resetTime) healthCounts.delete(ip);
        }
        for (const [ip, entry] of adminMetricsAuthCounts.entries()) {
            if (now > entry.resetTime) adminMetricsAuthCounts.delete(ip);
        }
        for (const [socketId] of roomListCooldowns.entries()) {
            if (!io.sockets.sockets.has(socketId)) roomListCooldowns.delete(socketId);
        }
    }, 60000);
}

export function stopRateLimitCleanup() {
    if (authCleanupId) { clearInterval(authCleanupId); authCleanupId = null; }
    if (rateLimitCleanupId) { clearInterval(rateLimitCleanupId); rateLimitCleanupId = null; }
}

export function clearRateLimitMaps() {
    connectionCounts.clear();
    failedAuthAttempts.clear();
    eventCounts.clear();

    healthCounts.clear();
    adminMetricsAuthCounts.clear();
    roomListCooldowns.clear();
    leaveRoomCounts.clear();
}
