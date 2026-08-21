import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    checkAdminMetricsAuthRate,
    checkAuthRate,
    checkConnectionRate,
    checkEventRate,
    checkHealthRate,
    checkLeaveRoomRate,
    checkChatMessageRate,
    CONNECTION_RATE_LIMIT,
    EVENT_RATE_LIMIT,
    CHAT_MESSAGE_RATE_LIMIT,
    CHAT_MESSAGE_RATE_WINDOW_MS,
    chatMessageCounts,
    failedAuthAttempts,
    LEAVE_ROOM_RATE_LIMIT,
    LEAVE_ROOM_RATE_WINDOW_MS,
    rateLimitDenied,
    leaveRoomCounts,
    clearRateLimitMaps,
    recordAuthFailure,
    startRateLimitCleanup,
    stopRateLimitCleanup
} from './rate-limiter.js';

function resetRateLimits() {
    stopRateLimitCleanup();
    clearRateLimitMaps();
    Object.assign(rateLimitDenied, {
        connections: 0,
        events: 0,
        health: 0,
        adminMetricsAuth: 0,
        roomList: 0,
        leaveRoom: 0,
        chatMessages: 0
    });
}

describe('LEAVE_ROOM Rate Limiter', () => {
    const testSocketId = 'test-socket-123';

    beforeEach(() => {
        resetRateLimits();
    });

    afterEach(resetRateLimits);

    it('should allow LEAVE_ROOM within limit', () => {
        // Test within the rate limit
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            const result = checkLeaveRoomRate(testSocketId);
            expect(result).toBe(true);
        }
        expect(rateLimitDenied.leaveRoom).toBe(0);
    });

    it('should block LEAVE_ROOM when exceeding limit', () => {
        // Fill up to the limit
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            checkLeaveRoomRate(testSocketId);
        }

        // Next request should be blocked
        const result = checkLeaveRoomRate(testSocketId);
        expect(result).toBe(false);
        expect(rateLimitDenied.leaveRoom).toBe(1);
    });

    it('should reset count after window expires', () => {
        // Fill up to the limit
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            checkLeaveRoomRate(testSocketId);
        }

        // Verify we're at the limit
        let result = checkLeaveRoomRate(testSocketId);
        expect(result).toBe(false);

        // Fast-forward time beyond the rate limit window
        const entry = leaveRoomCounts.get(testSocketId);
        entry.resetTime = Date.now() - LEAVE_ROOM_RATE_WINDOW_MS - 1000;
        leaveRoomCounts.set(testSocketId, entry);

        // Next request should be allowed again
        result = checkLeaveRoomRate(testSocketId);
        expect(result).toBe(true);
    });

    it('should handle multiple sockets independently', () => {
        const socketId2 = 'test-socket-456';

        // Fill up first socket
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            checkLeaveRoomRate(testSocketId);
        }

        // Second socket should still be allowed
        const result = checkLeaveRoomRate(socketId2);
        expect(result).toBe(true);

        // First socket should be blocked
        const result2 = checkLeaveRoomRate(testSocketId);
        expect(result2).toBe(false);
    });

    it('should increment rateLimitDenied counter on block', () => {
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            checkLeaveRoomRate(testSocketId);
        }

        checkLeaveRoomRate(testSocketId);
        expect(rateLimitDenied.leaveRoom).toBe(1);

        checkLeaveRoomRate(testSocketId);
        expect(rateLimitDenied.leaveRoom).toBe(2);
    });

    it('should be cleared by the shared reset helper', () => {
        checkLeaveRoomRate(testSocketId);
        expect(leaveRoomCounts.size).toBe(1);

        resetRateLimits();
        expect(leaveRoomCounts.size).toBe(0);
    });
});

describe('CHAT_MESSAGE Rate Limiter', () => {
    const socketId = 'chat-socket';

    beforeEach(resetRateLimits);

    afterEach(resetRateLimits);

    it('allows ten messages per ten-second window and blocks the next', () => {
        for (let i = 0; i < CHAT_MESSAGE_RATE_LIMIT; i++) {
            expect(checkChatMessageRate(socketId)).toBe(true);
        }
        expect(checkChatMessageRate(socketId)).toBe(false);
        expect(rateLimitDenied.chatMessages).toBe(1);
    });

    it('resets after the window expires', () => {
        for (let i = 0; i <= CHAT_MESSAGE_RATE_LIMIT; i++) checkChatMessageRate(socketId);
        const entry = chatMessageCounts.get(socketId);
        entry.resetTime = Date.now() - CHAT_MESSAGE_RATE_WINDOW_MS - 1;
        expect(checkChatMessageRate(socketId)).toBe(true);
    });
});

describe('remaining relay rate limits', () => {
    beforeEach(resetRateLimits);
    afterEach(resetRateLimits);

    it.each([
        ['connection', checkConnectionRate, CONNECTION_RATE_LIMIT, 'ip-1', 'connections'],
        ['event', checkEventRate, EVENT_RATE_LIMIT, 'socket-1', 'events'],
        ['health', checkHealthRate, 10, 'ip-2', 'health'],
        ['admin metrics auth', checkAdminMetricsAuthRate, 5, 'ip-3', 'adminMetricsAuth']
    ])('enforces the %s window and increments its denial counter', (_label, check, limit, key, counter) => {
        for (let attempt = 0; attempt < limit; attempt++) expect(check(key)).toBe(true);
        expect(check(key)).toBe(false);
        expect(rateLimitDenied[counter]).toBe(1);
        expect(check(`${key}-other`)).toBe(true);
    });

    it('scopes failed authentication attempts to IP and room', () => {
        for (let attempt = 0; attempt < 5; attempt++) recordAuthFailure('10.0.0.1', 'room-a');
        expect(checkAuthRate('10.0.0.1', 'room-a')).toBe(false);
        expect(checkAuthRate('10.0.0.1', 'room-b')).toBe(true);
        expect(failedAuthAttempts.get('10.0.0.1:room-a')).toMatchObject({ count: 5 });
    });

    it('starts cleanup only once and can stop safely', () => {
        const io = { sockets: { sockets: new Map() } };
        expect(() => {
            startRateLimitCleanup(io);
            startRateLimitCleanup(io);
            stopRateLimitCleanup();
            stopRateLimitCleanup();
        }).not.toThrow();
    });
});

describe('Rate Limit Constants', () => {
    it('should have correct rate limit values', () => {
        expect(LEAVE_ROOM_RATE_LIMIT).toBe(10);
        expect(LEAVE_ROOM_RATE_WINDOW_MS).toBe(60000); // 1 minute
    });
});
