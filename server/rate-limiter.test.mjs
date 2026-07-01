import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    checkLeaveRoomRate,
    LEAVE_ROOM_RATE_LIMIT,
    LEAVE_ROOM_RATE_WINDOW_MS,
    rateLimitDenied,
    leaveRoomCounts
} from './rate-limiter.js';

describe('LEAVE_ROOM Rate Limiter', () => {
    const testSocketId = 'test-socket-123';

    beforeEach(() => {
        // Reset state before each test
        leaveRoomCounts.clear();
        rateLimitDenied.leaveRoom = 0;
    });

    afterEach(() => {
        // Clean up after each test
        leaveRoomCounts.clear();
    });

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
        // Fill up to the limit
        for (let i = 0; i < LEAVE_ROOM_RATE_LIMIT; i++) {
            checkLeaveRoomRate(testSocketId);
        }

        // First block
        checkLeaveRoomRate(testSocketId);
        expect(rateLimitDenied.leaveRoom).toBe(1);

        // Second block
        checkLeaveRoomRate(testSocketId);
        expect(rateLimitDenied.leaveRoom).toBe(2);
    });
});

describe('Rate Limit Constants', () => {
    it('should have correct rate limit values', () => {
        expect(LEAVE_ROOM_RATE_LIMIT).toBe(10);
        expect(LEAVE_ROOM_RATE_WINDOW_MS).toBe(60000); // 1 minute
    });
});