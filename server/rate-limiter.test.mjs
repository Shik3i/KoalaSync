import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    checkLeaveRoomRate,
    checkChatMessageRate,
    checkChatReadRate,
    CHAT_MESSAGE_RATE_LIMIT,
    CHAT_MESSAGE_RATE_WINDOW_MS,
    chatMessageCounts,
    chatReadCounts,
    LEAVE_ROOM_RATE_LIMIT,
    LEAVE_ROOM_RATE_WINDOW_MS,
    rateLimitDenied,
    leaveRoomCounts,
    clearRateLimitMaps
} from './rate-limiter.js';

describe('LEAVE_ROOM Rate Limiter', () => {
    const testSocketId = 'test-socket-123';

    beforeEach(() => {
        clearRateLimitMaps();
        rateLimitDenied.leaveRoom = 0;
    });

    afterEach(() => {
        clearRateLimitMaps();
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

        clearRateLimitMaps();
        expect(leaveRoomCounts.size).toBe(0);
    });
});

describe('CHAT_MESSAGE Rate Limiter', () => {
    const socketId = 'chat-socket';

    beforeEach(() => clearRateLimitMaps());
    afterEach(() => clearRateLimitMaps());

    it('allows ten messages per ten seconds and rejects the eleventh', () => {
        for (let index = 0; index < CHAT_MESSAGE_RATE_LIMIT; index += 1) {
            expect(checkChatMessageRate(socketId)).toBe(true);
        }
        expect(checkChatMessageRate(socketId)).toBe(false);
        expect(CHAT_MESSAGE_RATE_LIMIT).toBe(10);
        expect(CHAT_MESSAGE_RATE_WINDOW_MS).toBe(10000);
    });

    it('resets and clears chat message counters', () => {
        checkChatMessageRate(socketId);
        chatMessageCounts.get(socketId).resetTime = Date.now() - 1;
        expect(checkChatMessageRate(socketId)).toBe(true);
        clearRateLimitMaps();
        expect(chatMessageCounts.size).toBe(0);
    });
});

describe('CHAT_READ Rate Limiter', () => {
    const socketId = 'history-reader';
    beforeEach(() => clearRateLimitMaps());
    afterEach(() => clearRateLimitMaps());

    it('allows receipts for a full 100-message history but still caps abuse', () => {
        for (let index = 0; index < 100; index += 1) expect(checkChatReadRate(socketId)).toBe(true);
        for (let index = 100; index < 120; index += 1) expect(checkChatReadRate(socketId)).toBe(true);
        expect(checkChatReadRate(socketId)).toBe(false);
        expect(chatReadCounts.get(socketId).count).toBe(121);
    });
});

describe('Rate Limit Constants', () => {
    it('should have correct rate limit values', () => {
        expect(LEAVE_ROOM_RATE_LIMIT).toBe(10);
        expect(LEAVE_ROOM_RATE_WINDOW_MS).toBe(60000); // 1 minute
    });
});
