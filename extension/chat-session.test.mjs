import { describe, expect, it } from 'vitest';
import { CHAT_MESSAGE_RATE_LIMIT } from '../server/rate-limiter.js';
import {
    CHAT_ECHO_TIMEOUT_MS,
    CHAT_SEND_LIMIT,
    createChatEchoTracker,
    createChatSendLimiter,
    createLatestTaskQueue,
    MAX_ROOM_ID_LENGTH,
    normalizeRoomId,
    shouldShowChatNotification
} from './chat-session.js';

describe('chat session boundaries', () => {
    it('matches the relay room ID sanitizer and length limit', () => {
        expect(normalizeRoomId('  ROOM_!42  ')).toBe('ROOM42');
        expect(normalizeRoomId('A'.repeat(MAX_ROOM_ID_LENGTH + 10))).toBe('A'.repeat(MAX_ROOM_ID_LENGTH));
        expect(normalizeRoomId(null)).toBe('');
    });

    it('allows ten-message client bursts without exceeding the relay threshold', () => {
        expect(CHAT_SEND_LIMIT).toBe(CHAT_MESSAGE_RATE_LIMIT);
        let current = 1000;
        const limiter = createChatSendLimiter({ now: () => current });
        for (let index = 0; index < CHAT_SEND_LIMIT; index++) {
            expect(limiter.take()).toEqual({ allowed: true, retryAfterMs: 0 });
        }
        expect(limiter.take()).toEqual({ allowed: false, retryAfterMs: 10000 });
        current += 10000;
        expect(limiter.take()).toEqual({ allowed: true, retryAfterMs: 0 });
        limiter.reset();
        expect(limiter.take()).toEqual({ allowed: true, retryAfterMs: 0 });
    });

    it('keeps reserved slots free for chat while background traffic is limited', () => {
        const limiter = createChatSendLimiter({ now: () => 1000 });
        for (let index = 0; index < CHAT_SEND_LIMIT - 4; index++) expect(limiter.take({ reserve: 4 }).allowed).toBe(true);
        expect(limiter.take({ reserve: 4 }).allowed).toBe(false);
        for (let index = 0; index < 4; index++) expect(limiter.take().allowed).toBe(true);
        expect(limiter.take().allowed).toBe(false);
    });

    it('waits for the matching relay echo and clears pending sends on reset or timeout', async () => {
        const timers = new Map();
        let nextTimerId = 1;
        const tracker = createChatEchoTracker({
            setTimer(callback, timeoutMs) {
                const id = nextTimerId++;
                timers.set(id, { callback, timeoutMs });
                return id;
            },
            clearTimer(id) {
                timers.delete(id);
            }
        });

        const acknowledged = tracker.waitFor('ciphertext-1');
        expect(tracker.acknowledge('ciphertext-1')).toBe(true);
        await expect(acknowledged).resolves.toBe(true);

        const reset = tracker.waitFor('ciphertext-2');
        tracker.reset();
        await expect(reset).resolves.toBe(false);

        const timedOut = tracker.waitFor('ciphertext-3');
        const timeout = [...timers.values()][0];
        expect(timeout.timeoutMs).toBe(CHAT_ECHO_TIMEOUT_MS);
        timeout.callback();
        await expect(timedOut).resolves.toBe(false);
    });

    it('suppresses chat notifications only while the target tab and its window are focused', () => {
        const focused = {
            enabled: true,
            targetTabId: 7,
            tab: { id: 7, active: true, windowId: 3 },
            windowInfo: { id: 3, focused: true }
        };
        expect(shouldShowChatNotification(focused)).toBe(false);
        expect(shouldShowChatNotification({ ...focused, windowInfo: { id: 3, focused: false } })).toBe(true);
        expect(shouldShowChatNotification({ ...focused, tab: { id: 7, active: false, windowId: 3 } })).toBe(true);
        expect(shouldShowChatNotification({ ...focused, targetTabId: 8 })).toBe(true);
        expect(shouldShowChatNotification({ ...focused, enabled: false })).toBe(false);
    });

    it('serializes join work and prevents an older request from winning storage races', async () => {
        const queue = createLatestTaskQueue();
        let releaseFirst;
        const writes = [];
        const first = queue.run(async isCurrent => {
            await new Promise(resolve => { releaseFirst = resolve; });
            if (isCurrent()) writes.push('first');
            return { status: isCurrent() ? 'ok' : 'superseded' };
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        const second = queue.run(async isCurrent => {
            if (isCurrent()) writes.push('second');
            return { status: 'ok' };
        });
        releaseFirst();
        await expect(first).resolves.toEqual({ status: 'superseded' });
        await expect(second).resolves.toEqual({ status: 'ok' });
        expect(writes).toEqual(['second']);
    });
});
