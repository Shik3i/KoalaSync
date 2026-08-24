import { describe, expect, it } from 'vitest';
import {
    buildHealthPayload,
    checkCooldown,
    getCachedPayload,
    isAdminMetricsAuthorized,
    isAdminMetricsTokenStrong
} from './ops.js';

describe('server operational helpers', () => {
    it('authorizes only an exact configured bearer token', () => {
        expect(isAdminMetricsAuthorized(undefined, 'secret-token')).toBe(false);
        expect(isAdminMetricsAuthorized('Bearer wrong-token', 'secret-token')).toBe(false);
        expect(isAdminMetricsAuthorized('Bearer secret-token', 'secret-token')).toBe(true);
        expect(isAdminMetricsAuthorized('Bearer secret-token', '')).toBe(false);
    });

    it('allows disabled metrics or strong admin tokens', () => {
        expect(isAdminMetricsTokenStrong('')).toBe(true);
        expect(isAdminMetricsTokenStrong('short-token')).toBe(false);
        expect(isAdminMetricsTokenStrong('a'.repeat(32))).toBe(true);
    });

    it('tracks cooldowns and expires cached payloads deterministically', () => {
        const cooldowns = new Map();
        expect(checkCooldown(cooldowns, 'socket-1', 10_000, 100_000)).toBe(true);
        expect(checkCooldown(cooldowns, 'socket-1', 10_000, 105_000)).toBe(false);
        expect(checkCooldown(cooldowns, 'socket-1', 10_000, 110_000)).toBe(true);

        const cache = new Map();
        let buildCalls = 0;
        const first = getCachedPayload(cache, 'health', 60_000, () => ({ value: ++buildCalls }), 1_000);
        const cached = getCachedPayload(cache, 'health', 60_000, () => ({ value: ++buildCalls }), 30_000);
        const expired = getCachedPayload(cache, 'health', 60_000, () => ({ value: ++buildCalls }), 61_001);
        expect(cached).toBe(first);
        expect(expired).toEqual({ value: 2 });
    });

    it('keeps public health minimal and exposes aggregate admin metrics', () => {
        const rooms = new Map([
            ['room-a', { peers: new Set(['a', 'b']), activeLobby: null }],
            ['room-b', { peers: new Set(['c', 'd', 'e']), activeLobby: { expectedTitle: 'Episode 2' } }]
        ]);
        const input = {
            rooms,
            connections: 5,
            now: 1234,
            uptime: 99,
            memoryUsage: () => ({ rss: 10, heapUsed: 5, heapTotal: 8 }),
            rateLimitSizes: {
                connections: 1,
                events: 2,
                health: 3,
                adminMetricsAuth: 4,
                authFailures: 5,
                roomList: 6,
                leaveRoom: 7
            }
        };

        expect(Object.keys(buildHealthPayload({ ...input, includeMetrics: false })).sort()).toEqual(
            ['connections', 'rooms', 'status', 'timestamp', 'uptime'].sort()
        );
        expect(buildHealthPayload({
            ...input,
            includeMetrics: true,
            rateLimitDenied: { leaveRoom: 8 }
        })).toMatchObject({
            peers: 5,
            roomsWithLobby: 1,
            avgPeersPerRoom: 2.5,
            maxPeersInRoom: 3,
            memory: { rss: 10, heapUsed: 5, heapTotal: 8 },
            rateLimits: {
                trackedClients: input.rateLimitSizes,
                denied: {
                    connections: 0,
                    events: 0,
                    health: 0,
                    adminMetricsAuth: 0,
                    roomList: 0,
                    leaveRoom: 8
                }
            }
        });
    });
});
