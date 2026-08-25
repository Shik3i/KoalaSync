import { describe, expect, it } from 'vitest';
import {
    canonicalMediaStateFromRoomData,
    createCanonicalMediaStateTracker,
    projectCanonicalMediaState,
    validateCanonicalMediaState
} from './canonical-media-state.js';

const state = (revision, currentTime = revision * 10, playbackState = 'playing') => ({
    revision,
    currentTime,
    playbackState,
    updatedBy: 'peer-a'
});

describe('canonical media state validation', () => {
    it('accepts a bounded canonical snapshot', () => {
        expect(validateCanonicalMediaState(state(2))).toEqual(state(2));
    });

    it('preserves an optional bounded media title and rejects invalid title types', () => {
        expect(validateCanonicalMediaState({ ...state(2), mediaTitle: 'Series S01E02' }))
            .toMatchObject({ mediaTitle: 'Series S01E02' });
        expect(validateCanonicalMediaState({ ...state(2), mediaTitle: 'x'.repeat(120) }).mediaTitle)
            .toHaveLength(100);
        expect(validateCanonicalMediaState({ ...state(2), mediaTitle: 42 })).toBeNull();
    });

    it.each([
        null,
        [],
        {},
        { revision: 0, playbackState: 'playing', currentTime: 1 },
        { revision: 1.5, playbackState: 'playing', currentTime: 1 },
        { revision: 1, playbackState: 'buffering', currentTime: 1 },
        { revision: 1, playbackState: 'playing', currentTime: NaN },
        { revision: 1, playbackState: 'playing', currentTime: Infinity },
        { revision: 1, playbackState: 'playing', currentTime: -1 },
        { revision: 1, playbackState: 'playing', currentTime: 86401 },
        { revision: 1, playbackState: 'playing', currentTime: '1' }
    ])('rejects malformed snapshot %#', value => {
        expect(validateCanonicalMediaState(value)).toBeNull();
    });
});

describe('ROOM_DATA capability compatibility', () => {
    const legacyRoomData = {
        roomId: 'room-a',
        peers: [],
        activeLobby: null,
        hostPeerId: 'peer-a',
        controlMode: 'everyone',
        controllers: ['peer-a'],
        capabilities: ['host-control', 'co-host', 'chat-v1']
    };

    it('treats an old relay without capability or mediaState as the unchanged fallback', () => {
        expect(canonicalMediaStateFromRoomData(legacyRoomData)).toEqual({
            status: 'unsupported',
            mediaState: null
        });
        expect(canonicalMediaStateFromRoomData({ ...legacyRoomData, capabilities: undefined })).toEqual({
            status: 'unsupported',
            mediaState: null
        });
    });

    it('does not consume a stray mediaState unless the relay advertises support', () => {
        expect(canonicalMediaStateFromRoomData({ ...legacyRoomData, mediaState: state(4) })).toEqual({
            status: 'unsupported',
            mediaState: null
        });
    });

    it('accepts null as a valid capable-relay state without creating pending recovery', () => {
        expect(canonicalMediaStateFromRoomData({
            ...legacyRoomData,
            capabilities: [...legacyRoomData.capabilities, 'media-state-v1'],
            mediaState: null
        })).toEqual({ status: 'empty', mediaState: null });
    });

    it('returns a validated snapshot only for a capable relay', () => {
        expect(canonicalMediaStateFromRoomData({
            ...legacyRoomData,
            capabilities: [...legacyRoomData.capabilities, 'media-state-v1'],
            mediaState: state(4)
        })).toEqual({ status: 'available', mediaState: state(4) });
    });
});

describe('canonical media state tracker', () => {
    it('projects a deferred playing snapshot from local receipt time and clamps it', () => {
        expect(projectCanonicalMediaState(state(1, 100, 'playing'), 1_000, 31_000))
            .toMatchObject({ currentTime: 130, playbackState: 'playing' });
        expect(projectCanonicalMediaState(state(1, 100, 'paused'), 1_000, 31_000))
            .toMatchObject({ currentTime: 100, playbackState: 'paused' });
        expect(projectCanonicalMediaState(state(1, 86_390, 'playing'), 1_000, 31_000).currentTime)
            .toBe(86_400);
    });

    it('accepts a valid snapshot and applies each revision once', () => {
        const tracker = createCanonicalMediaStateTracker();
        expect(tracker.receive('room-a', state(1)).status).toBe('pending');
        expect(tracker.markHandled('room-a', 1)).toBe(true);
        expect(tracker.receive('room-a', state(1)).status).toBe('duplicate');
    });

    it('ignores stale revisions and lets a newer snapshot replace pending state', () => {
        const tracker = createCanonicalMediaStateTracker();
        tracker.receive('room-a', state(3));
        expect(tracker.receive('room-a', state(2)).status).toBe('stale');
        expect(tracker.receive('room-a', state(4)).status).toBe('pending');
        expect(tracker.getPending('room-a').mediaState).toEqual(state(4));
    });

    it('never exposes room A state after switching to room B or leaving', () => {
        const tracker = createCanonicalMediaStateTracker();
        tracker.receive('room-a', state(5));
        tracker.adoptRoom('room-b');
        expect(tracker.getPending('room-a')).toBeNull();
        expect(tracker.getPending('room-b')).toBeNull();
        tracker.receive('room-b', state(1));
        tracker.clear();
        expect(tracker.snapshot()).toEqual({ roomId: null, knownRevision: 0, appliedRevision: 0, pending: null });
    });

    it('allows the same revision once in a new reconnect recovery cycle', () => {
        const tracker = createCanonicalMediaStateTracker();
        tracker.receive('room-a', state(8, 80));
        tracker.markHandled('room-a', 8);
        tracker.beginRecovery('room-a');
        expect(tracker.receive('room-a', state(8, 100)).status).toBe('pending');
        expect(tracker.getPending().mediaState.currentTime).toBe(100);
    });

    it('accepts a lower revision from a new relay or room epoch after reconnect', () => {
        const tracker = createCanonicalMediaStateTracker();
        tracker.receive('room-a', state(12), 1_000);
        tracker.markHandled('room-a', 12);
        tracker.beginRecovery('room-a');
        expect(tracker.receive('room-a', state(1), 2_000).status).toBe('pending');
        expect(tracker.getPending('room-a').mediaState.revision).toBe(1);
    });

    it('persists receipt time so MV3 recovery projects only playing snapshots', () => {
        const first = createCanonicalMediaStateTracker();
        first.receive('room-a', state(4, 50, 'playing'), 10_000);
        const restored = createCanonicalMediaStateTracker();
        expect(restored.restore(first.snapshot(), 'room-a')).toBe(true);
        expect(restored.getPendingProjected('room-a', 15_000).mediaState.currentTime).toBe(55);
    });

    it('restores only room-scoped session state', () => {
        const first = createCanonicalMediaStateTracker();
        first.receive('room-a', state(9));
        const stored = first.snapshot();

        const sameRoom = createCanonicalMediaStateTracker();
        expect(sameRoom.restore(stored, 'room-a')).toBe(true);
        expect(sameRoom.getPending('room-a').mediaState.revision).toBe(9);

        const otherRoom = createCanonicalMediaStateTracker();
        expect(otherRoom.restore(stored, 'room-b')).toBe(false);
        expect(otherRoom.getPending('room-b')).toBeNull();
    });
});
