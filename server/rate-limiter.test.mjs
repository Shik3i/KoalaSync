import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    connectionCounts,
    eventCounts,
    healthCounts,
    adminMetricsAuthCounts,
    roomListCooldowns,
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

    it('clears every rate-limit map', () => {
        const maps = [
            connectionCounts,
            failedAuthAttempts,
            eventCounts,
            chatMessageCounts,
            healthCounts,
            adminMetricsAuthCounts,
            roomListCooldowns,
            leaveRoomCounts
        ];
        maps.forEach((map, index) => map.set(`key-${index}`, { count: 1 }));
        clearRateLimitMaps();
        maps.forEach(map => expect(map.size).toBe(0));
    });

    it('removes expired and disconnected entries in both cleanup intervals', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-21T10:00:00Z'));
        const now = Date.now();
        const sockets = new Map([['connected', {}]]);
        connectionCounts.set('expired-ip', { count: 1, resetTime: now - 1 });
        connectionCounts.set('live-ip', { count: 1, resetTime: now + 120000 });
        eventCounts.set('disconnected', { count: 1, resetTime: now + 120000 });
        eventCounts.set('connected', { count: 1, resetTime: now + 120000 });
        chatMessageCounts.set('disconnected', { count: 1, resetTime: now + 120000 });
        leaveRoomCounts.set('disconnected', { count: 1, resetTime: now + 120000 });
        healthCounts.set('expired-health', { count: 1, resetTime: now - 1 });
        adminMetricsAuthCounts.set('expired-admin', { count: 1, resetTime: now - 1 });
        roomListCooldowns.set('disconnected', now);
        roomListCooldowns.set('connected', now);
        failedAuthAttempts.set('expired-auth', { count: 1, lastAttempt: now - (16 * 60 * 1000) });
        failedAuthAttempts.set('live-auth', { count: 1, lastAttempt: now });

        startRateLimitCleanup({ sockets: { sockets } });
        await vi.advanceTimersByTimeAsync(60000);
        expect([...connectionCounts.keys()]).toEqual(['live-ip']);
        expect([...eventCounts.keys()]).toEqual(['connected']);
        expect(chatMessageCounts.size).toBe(0);
        expect(leaveRoomCounts.size).toBe(0);
        expect(healthCounts.size).toBe(0);
        expect(adminMetricsAuthCounts.size).toBe(0);
        expect([...roomListCooldowns.keys()]).toEqual(['connected']);

        await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
        expect([...failedAuthAttempts.keys()]).toEqual(['live-auth']);
        stopRateLimitCleanup();
        vi.useRealTimers();
    });
});

describe('Rate Limit Constants', () => {
    it('should have correct rate limit values', () => {
        expect(LEAVE_ROOM_RATE_LIMIT).toBe(10);
        expect(LEAVE_ROOM_RATE_WINDOW_MS).toBe(60000); // 1 minute
    });
});
