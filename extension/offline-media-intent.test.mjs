import { describe, expect, it } from 'vitest';
import { EVENTS, MAX_MEDIA_TIME } from '../shared/constants.js';
import { canonicalMediaStateFromRoomData } from './canonical-media-state.js';
import {
    discardQueuedMediaIntents,
    drainQueuedBatch,
    enqueueQueuedEvent,
    hasQueuedMediaIntent,
    materializeMediaIntent,
    maxQueuedSequence,
    normalizePersistedEventQueue,
    queuedEntryWireCount,
    queuedMediaIntentCount,
    queuedWireCount,
    reconcileQueuedRoomIntent,
    reserveLatestMediaIntentSequence
} from './offline-media-intent.js';

const roomId = 'room-a';
const media = (event, data, queue = []) => enqueueQueuedEvent(queue, event, data, { roomId }).queue;

function reserve(queue, sequence) {
    return reserveLatestMediaIntentSequence(queue, roomId, sequence).queue;
}

describe('offline media intent coalescing', () => {
    it('normalizes an empty or roomless persisted queue to empty', () => {
        expect(normalizePersistedEventQueue([], roomId)).toEqual([]);
        expect(normalizePersistedEventQueue([{ event: EVENTS.PLAY, data: { seq: 1 } }], null)).toEqual([]);
    });

    it('creates a PLAY intent and reserves ordered legacy SEEK + PLAY frames', () => {
        let queue = media(EVENTS.PLAY, { currentTime: 10, seq: 5, actionTimestamp: 100 });
        queue = reserve(queue, 6);
        expect(queue).toHaveLength(1);
        expect(materializeMediaIntent(queue[0])).toEqual([
            { event: EVENTS.SEEK, data: { seq: 5, currentTime: 10, targetTime: 10 } },
            { event: EVENTS.PLAY, data: { seq: 6, actionTimestamp: 100, currentTime: 10 } }
        ]);
    });

    it('collapses repeated PLAY and SEEK while preserving final state and monotonic sequences', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 10, seq: 1 }), 2);
        queue = media(EVENTS.PLAY, { currentTime: 20, seq: 3 }, queue);
        queue = media(EVENTS.SEEK, { targetTime: 30, seq: 4 }, queue);
        expect(queue).toHaveLength(1);
        expect(queue[0].intent).toMatchObject({
            playbackState: 'playing',
            currentTime: 30,
            latestEvent: EVENTS.SEEK,
            previousSeq: 3,
            latestSeq: 4,
            sourceEventCount: 3
        });
        expect(materializeMediaIntent(queue[0]).map(frame => frame.data.seq)).toEqual([3, 4]);
    });

    it('drops a regressing queued sequence instead of emitting stale ordering', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 10, seq: 10 }), 11);
        const result = enqueueQueuedEvent(queue, EVENTS.PAUSE, { currentTime: 20, seq: 9 }, { roomId });
        expect(result.droppedStale).toBe(1);
        expect(result.queue).toEqual(queue);
        expect(maxQueuedSequence(result.queue)).toBe(11);
    });

    it('merges PLAY -> SEEK -> PAUSE into paused at the final position', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 500, seq: 1 }), 2);
        queue = media(EVENTS.SEEK, { targetTime: 600, seq: 3 }, queue);
        queue = media(EVENTS.PAUSE, { currentTime: 605, seq: 4 }, queue);
        expect(materializeMediaIntent(queue[0])).toEqual([
            { event: EVENTS.SEEK, data: { seq: 3, currentTime: 605, targetTime: 605 } },
            { event: EVENTS.PAUSE, data: { seq: 4, currentTime: 605 } }
        ]);
    });

    it('merges PAUSE -> SEEK -> PLAY into playing at the final position', () => {
        let queue = reserve(media(EVENTS.PAUSE, { currentTime: 100, seq: 10 }), 11);
        queue = media(EVENTS.SEEK, { targetTime: 200, seq: 12 }, queue);
        queue = media(EVENTS.PLAY, { currentTime: 205, seq: 13 }, queue);
        expect(materializeMediaIntent(queue[0]).map(frame => frame.event)).toEqual([EVENTS.SEEK, EVENTS.PLAY]);
        expect(queue[0].intent).toMatchObject({ playbackState: 'playing', currentTime: 205 });
    });

    it('clamps finite positions and rejects a SEEK with no trustworthy position', () => {
        expect(media(EVENTS.SEEK, { targetTime: NaN, seq: 1 })).toEqual([]);
        expect(media(EVENTS.SEEK, { targetTime: -50, seq: 1 })[0].intent.currentTime).toBe(0);
        expect(media(EVENTS.SEEK, { targetTime: MAX_MEDIA_TIME + 50, seq: 1 })[0].intent.currentTime).toBe(MAX_MEDIA_TIME);
    });

    it('keeps title metadata bounded and never retains arbitrary payload fields', () => {
        const queue = media(EVENTS.PAUSE, {
            currentTime: 10,
            seq: 1,
            mediaTitle: 'x'.repeat(200),
            password: 'secret',
            chatKey: 'secret'
        });
        expect(queue[0].intent.mediaTitle).toHaveLength(100);
        expect(JSON.stringify(queue)).not.toContain('password');
        expect(JSON.stringify(queue)).not.toContain('chatKey');
    });

    it('keeps a thousand-event media burst at one logical entry', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 0, seq: 1 }), 2);
        for (let index = 1; index <= 1000; index++) {
            queue = media(EVENTS.SEEK, { targetTime: index, seq: index + 2 }, queue);
        }
        queue = media(EVENTS.PAUSE, { currentTime: 1000, seq: 1003 }, queue);
        expect(queue).toHaveLength(1);
        expect(queue[0].intent).toMatchObject({ playbackState: 'paused', currentTime: 1000, sourceEventCount: 1002 });
    });

    it('treats retained coordination events as barriers', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 10, seq: 1 }), 2);
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_PREPARE, { targetTime: 50, seq: 3 }, { roomId }).queue;
        queue = media(EVENTS.SEEK, { targetTime: 100, seq: 4 }, queue);
        queue = media(EVENTS.PAUSE, { currentTime: 120, seq: 5 }, queue);
        expect(queue).toHaveLength(3);
        expect(queue[0].kind).toBe('media-intent');
        expect(queue[1].event).toBe(EVENTS.FORCE_SYNC_PREPARE);
        expect(queue[2].kind).toBe('media-intent');
        expect(queue[2].intent).toMatchObject({ playbackState: 'paused', currentTime: 120 });
    });

    it('does not persist stale liveness and command ACK frames as ordering barriers', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 10, seq: 1 }), 2);
        for (const event of [EVENTS.PING, EVENTS.PONG, EVENTS.PEER_STATUS, EVENTS.EVENT_ACK]) {
            const result = enqueueQueuedEvent(queue, event, { seq: 99 }, { roomId });
            expect(result.droppedStale).toBe(1);
            queue = result.queue;
        }
        queue = media(EVENTS.PAUSE, { currentTime: 20, seq: 3 }, queue);
        expect(queue).toHaveLength(1);
        expect(queue[0].intent).toMatchObject({ playbackState: 'paused', currentTime: 20 });
    });

    it('preserves the bounded logical queue cap', () => {
        let queue = [];
        for (let index = 0; index < 60; index++) {
            queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_READY, { index }, { roomId }).queue;
        }
        expect(queue).toHaveLength(50);
        expect(queue[0].data.index).toBe(10);
        expect(queue.at(-1).data.index).toBe(59);
    });

    it('migrates old raw media entries without crossing transactional barriers', () => {
        const restored = normalizePersistedEventQueue([
            { event: EVENTS.PLAY, data: { currentTime: 10, seq: 1 } },
            { event: EVENTS.SEEK, data: { targetTime: 20, seq: 2 } },
            { event: EVENTS.PAUSE, data: { currentTime: 25, seq: 3 } },
            { event: EVENTS.EPISODE_LOBBY, data: { expectedTitle: 'S01E02' } },
            { event: EVENTS.PLAY, data: { currentTime: 30, seq: 4 } }
        ], roomId);
        expect(restored).toHaveLength(3);
        expect(restored[0].intent).toMatchObject({ playbackState: 'paused', currentTime: 25 });
        expect(restored[1].event).toBe(EVENTS.EPISODE_LOBBY);
        expect(restored[2].intent).toMatchObject({ playbackState: 'playing', currentTime: 30 });
        expect(maxQueuedSequence(restored)).toBe(4);
    });

    it('enforces the cap while restoring consecutive persisted media intents', () => {
        const persisted = [10, 20, 30].map((currentTime, index) => ({
            kind: 'media-intent',
            roomId,
            intent: {
                playbackState: 'paused',
                currentTime,
                latestEvent: EVENTS.PAUSE,
                previousSeq: null,
                latestSeq: index + 1,
                actionTimestamp: index + 1,
                mediaTitle: null,
                sourceEventCount: 1
            }
        }));
        const restored = normalizePersistedEventQueue(persisted, roomId, 2);
        expect(restored).toHaveLength(2);
        expect(restored.map(entry => entry.intent.currentTime)).toEqual([20, 30]);
    });

    it('drops room-scoped barriers from another room and unknown persisted events', () => {
        const restored = normalizePersistedEventQueue([
            { kind: 'event', roomId: 'room-b', event: EVENTS.FORCE_SYNC_EXECUTE, data: { seq: 1 } },
            { kind: 'event', roomId, event: 'unexpected_event', data: { secret: 'nope' } },
            { kind: 'event', roomId, event: EVENTS.EPISODE_READY, data: { seq: 2 } }
        ], roomId);
        expect(restored).toEqual([{
            kind: 'event', roomId, event: EVENTS.EPISODE_READY, data: { seq: 2 }
        }]);
    });

    it('discards stale-room intent without affecting the new room', () => {
        const queue = reserve(media(EVENTS.PAUSE, { currentTime: 500, seq: 1 }), 2);
        expect(hasQueuedMediaIntent(queue, roomId)).toBe(true);
        expect(discardQueuedMediaIntents(queue, roomId)).toEqual([]);
        expect(hasQueuedMediaIntent(queue, 'room-b')).toBe(false);
    });

    it('drops queued shared intent after controller role loss so canonical recovery can proceed', () => {
        let queue = reserve(media(EVENTS.PAUSE, { currentTime: 1200, seq: 1 }), 2);
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_PREPARE, { targetTime: 1300, seq: 3 }, { roomId }).queue;
        const result = reconcileQueuedRoomIntent(queue, { roomId, canControl: false });
        expect(result.queue).toEqual([]);
        expect(result.discarded).toBe(2);
        expect(result.hasPendingLocalIntent).toBe(false);
    });

    it('keeps an active Episode Lobby authoritative over queued media and Force Sync', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 100, seq: 1 }), 2);
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_PREPARE, { targetTime: 500, seq: 3 }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_READY, { title: 'S01E02' }, { roomId }).queue;
        const result = reconcileQueuedRoomIntent(queue, { roomId, activeLobby: true });
        expect(result.queue).toEqual([{
            kind: 'event',
            roomId,
            event: EVENTS.EPISODE_READY,
            data: { title: 'S01E02' }
        }]);
        expect(result.hasPendingLocalIntent).toBe(false);
    });

    it('drops stale queued Episode Lobby coordination when ROOM_DATA has an authoritative lobby', () => {
        let queue = enqueueQueuedEvent([], EVENTS.EPISODE_LOBBY, { expectedTitle: 'S02E01' }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_READY, { title: 'S02E01' }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_LOBBY_CANCEL, {}, { roomId }).queue;
        const result = reconcileQueuedRoomIntent(queue, {
            roomId,
            activeLobby: true,
            authoritativeLobby: true
        });
        expect(result.queue).toEqual([]);
        expect(result.discarded).toBe(3);
    });

    it('does not let intentional solo mode retain future room-driving intent', () => {
        const queue = reserve(media(EVENTS.SEEK, { targetTime: 600, playbackState: 'paused', seq: 1 }), 2);
        const result = reconcileQueuedRoomIntent(queue, { roomId, desynced: true });
        expect(result.queue).toEqual([]);
        expect(result.hasPendingLocalIntent).toBe(false);
    });

    it('materializes legacy events normally when an old relay has no media-state capability', () => {
        expect(canonicalMediaStateFromRoomData({
            roomId,
            capabilities: ['host-control', 'chat-v1']
        })).toEqual({ status: 'unsupported', mediaState: null });
        const queue = reserve(media(EVENTS.PAUSE, { currentTime: 75, seq: 20 }), 21);
        expect(materializeMediaIntent(queue[0]).map(frame => frame.event)).toEqual([EVENTS.SEEK, EVENTS.PAUSE]);
        expect(materializeMediaIntent(queue[0]).every(frame =>
            frame.data.mediaState === undefined && frame.data.revision === undefined
        )).toBe(true);
    });
});

describe('offline media intent drain', () => {
    it('counts actual wire frames and never splits an intent at a batch boundary', async () => {
        let queue = enqueueQueuedEvent([], EVENTS.EPISODE_READY, { seq: 1 }, { roomId }).queue;
        queue = reserve(media(EVENTS.PAUSE, { currentTime: 50, seq: 2 }, queue), 3);
        const sent = [];
        const first = await drainQueuedBatch(queue, {
            roomId,
            maxWireEvents: 2,
            sendFrame: async frame => { sent.push(frame); return true; }
        });
        expect(first.sentWireEvents).toBe(1);
        expect(first.queue).toHaveLength(1);
        expect(sent.map(frame => frame.event)).toEqual([EVENTS.EPISODE_READY]);

        const second = await drainQueuedBatch(first.queue, {
            roomId,
            maxWireEvents: 2,
            sendFrame: async frame => { sent.push(frame); return true; }
        });
        expect(second.sentWireEvents).toBe(2);
        expect(second.queue).toEqual([]);
        expect(sent.slice(1).map(frame => frame.event)).toEqual([EVENTS.SEEK, EVENTS.PAUSE]);
    });

    it('retains the whole logical intent after a partial send failure', async () => {
        const queue = reserve(media(EVENTS.PLAY, { currentTime: 90, seq: 5, actionTimestamp: 500 }), 6);
        let calls = 0;
        const result = await drainQueuedBatch(queue, {
            roomId,
            maxWireEvents: 10,
            sendFrame: async () => ++calls === 1
        });
        expect(result.status).toBe('send_failed');
        expect(result.sentWireEvents).toBe(1);
        expect(result.queue).toEqual(queue);
        expect(materializeMediaIntent(result.queue[0]).map(frame => frame.data.seq)).toEqual([5, 6]);
        expect(materializeMediaIntent(result.queue[0]).map(frame => frame.data.actionTimestamp))
            .toEqual([undefined, 500]);
    });

    it('drops stale-room intent during drain and preserves unrelated events', async () => {
        let queue = reserve(media(EVENTS.PAUSE, { currentTime: 40, seq: 1 }), 2);
        queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_READY, { seq: 3 }, { roomId }).queue;
        const sent = [];
        const result = await drainQueuedBatch(queue, {
            roomId: 'room-b',
            maxWireEvents: 10,
            sendFrame: async frame => { sent.push(frame); return true; }
        });
        expect(result.droppedStaleIntents).toBe(2);
        expect(sent).toEqual([]);
    });

    it('repairs regressing sequences across malformed persisted intent entries', () => {
        const restored = normalizePersistedEventQueue([
            {
                kind: 'media-intent',
                roomId,
                intent: {
                    playbackState: 'playing', currentTime: 10, latestEvent: EVENTS.PLAY,
                    previousSeq: 99, latestSeq: 100, actionTimestamp: 1, mediaTitle: null, sourceEventCount: 1
                }
            },
            {
                kind: 'media-intent',
                roomId,
                intent: {
                    playbackState: 'paused', currentTime: 20, latestEvent: EVENTS.PAUSE,
                    previousSeq: 49, latestSeq: 50, actionTimestamp: 2, mediaTitle: null, sourceEventCount: 1
                }
            }
        ], roomId);
        expect(materializeMediaIntent(restored[0]).map(frame => frame.data.seq)).toEqual([99, 100]);
        expect(materializeMediaIntent(restored[1]).map(frame => frame.data.seq)).toEqual([101, 102]);
        expect(maxQueuedSequence(restored)).toBe(102);
    });

    it('preserves a valid legacy single-frame intent during sequence repair', () => {
        const restored = normalizePersistedEventQueue([{
            kind: 'media-intent',
            roomId,
            intent: {
                playbackState: 'paused', currentTime: 20, latestEvent: EVENTS.PAUSE,
                previousSeq: null, latestSeq: 50, actionTimestamp: 2, mediaTitle: null, sourceEventCount: 1
            }
        }], roomId);
        expect(materializeMediaIntent(restored[0])).toEqual([{
            event: EVENTS.PAUSE,
            data: { seq: 50, actionTimestamp: 2, currentTime: 20 }
        }]);
    });

    it('evicts a complete Force Sync transaction instead of orphaning EXECUTE at the cap', () => {
        let queue = enqueueQueuedEvent([], EVENTS.FORCE_SYNC_PREPARE, { targetTime: 100, seq: 1 }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_EXECUTE, { seq: 2 }, { roomId }).queue;
        for (let index = 0; index < 49; index++) {
            queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_ACK, { seq: index + 3 }, { roomId }).queue;
        }
        expect(queue).toHaveLength(49);
        expect(queue.some(entry => entry.event === EVENTS.FORCE_SYNC_PREPARE)).toBe(false);
        expect(queue.some(entry => entry.event === EVENTS.FORCE_SYNC_EXECUTE)).toBe(false);
    });

    it('keeps adjacent Force Sync PREPARE and EXECUTE in the same replay batch', async () => {
        let queue = [];
        for (let index = 0; index < 9; index++) {
            queue = enqueueQueuedEvent(queue, EVENTS.EPISODE_READY, { seq: index + 1 }, { roomId }).queue;
        }
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_PREPARE, { targetTime: 100, seq: 10 }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_EXECUTE, { seq: 11 }, { roomId }).queue;
        const sent = [];
        const result = await drainQueuedBatch(queue, {
            roomId,
            maxWireEvents: 10,
            sendFrame: async frame => { sent.push(frame.event); return true; }
        });
        expect(sent).toEqual(Array(9).fill(EVENTS.EPISODE_READY));
        expect(result.queue.map(entry => entry.event)).toEqual([
            EVENTS.FORCE_SYNC_PREPARE,
            EVENTS.FORCE_SYNC_EXECUTE
        ]);
    });

    it('retains the full Force Sync transaction if EXECUTE replay fails', async () => {
        let queue = enqueueQueuedEvent([], EVENTS.FORCE_SYNC_PREPARE, { targetTime: 100, seq: 1 }, { roomId }).queue;
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_EXECUTE, { seq: 2 }, { roomId }).queue;
        const result = await drainQueuedBatch(queue, {
            roomId,
            maxWireEvents: 10,
            sendFrame: async frame => frame.event !== EVENTS.FORCE_SYNC_EXECUTE
        });
        expect(result.status).toBe('send_failed');
        expect(result.sentWireEvents).toBe(1);
        expect(result.queue).toEqual(queue);
    });

    it('reports logical and actual-wire queue sizes separately', () => {
        let queue = reserve(media(EVENTS.PLAY, { currentTime: 10, seq: 1 }), 2);
        queue = enqueueQueuedEvent(queue, EVENTS.FORCE_SYNC_PREPARE, { seq: 3 }, { roomId }).queue;
        expect(queuedMediaIntentCount(queue, roomId)).toBe(1);
        expect(queuedEntryWireCount(queue[0])).toBe(2);
        expect(queuedWireCount(queue)).toBe(3);
    });
});
