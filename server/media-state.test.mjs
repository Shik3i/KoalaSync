import { describe, expect, it } from 'vitest';
import { EVENTS, MAX_MEDIA_TIME } from '../shared/constants.js';
import {
    commitForceSyncMediaState,
    effectiveMediaPosition,
    snapshotMediaState,
    updateMediaStateFromControl
} from './media-state.js';

function room(mediaState = null) {
    return { mediaState };
}

describe('canonical media state', () => {
    it('starts null and snapshots null', () => {
        expect(snapshotMediaState(null, 1000)).toBeNull();
    });

    it('projects playing state and clamps elapsed time', () => {
        const state = { revision: 1, playbackState: 'playing', currentTime: 10, updatedAt: 1000, updatedBy: 'a' };
        expect(effectiveMediaPosition(state, 3500)).toBe(12.5);
        expect(effectiveMediaPosition(state, 500)).toBe(10);
        expect(effectiveMediaPosition({ ...state, currentTime: MAX_MEDIA_TIME }, 3500)).toBe(MAX_MEDIA_TIME);
    });

    it('keeps paused state fixed', () => {
        const state = { revision: 1, playbackState: 'paused', currentTime: 10, updatedAt: 1000, updatedBy: 'a' };
        expect(effectiveMediaPosition(state, 601000)).toBe(10);
        expect(snapshotMediaState(state, 601000)).toEqual({
            revision: 1,
            playbackState: 'paused',
            currentTime: 10,
            updatedBy: 'a'
        });
    });

    it('initializes and updates PLAY with server-owned revisions', () => {
        const target = room();
        expect(updateMediaStateFromControl(target, EVENTS.PLAY, { currentTime: 12, revision: 999 }, 'a', { now: 1000 })).toBe(true);
        expect(target.mediaState).toEqual({ revision: 1, playbackState: 'playing', currentTime: 12, updatedAt: 1000, updatedBy: 'a' });
        expect(updateMediaStateFromControl(target, EVENTS.PLAY, { currentTime: 20 }, 'b', { now: 2000 })).toBe(true);
        expect(target.mediaState.revision).toBe(2);
        expect(target.mediaState.updatedBy).toBe('b');
    });

    it('does not invent an initial PLAY position and preserves a known effective position', () => {
        const target = room();
        expect(updateMediaStateFromControl(target, EVENTS.PLAY, {}, 'a', { now: 1000 })).toBe(false);
        expect(target.mediaState).toBeNull();
        target.mediaState = { revision: 1, playbackState: 'playing', currentTime: 5, updatedAt: 1000, updatedBy: 'a' };
        expect(updateMediaStateFromControl(target, EVENTS.PLAY, {}, 'a', { now: 3000 })).toBe(true);
        expect(target.mediaState.currentTime).toBe(7);
    });

    it('freezes PAUSE at its event or effective canonical position', () => {
        const target = room({ revision: 1, playbackState: 'playing', currentTime: 10, updatedAt: 1000, updatedBy: 'a' });
        expect(updateMediaStateFromControl(target, EVENTS.PAUSE, {}, 'a', { now: 4000 })).toBe(true);
        expect(target.mediaState).toEqual({ revision: 2, playbackState: 'paused', currentTime: 13, updatedAt: 4000, updatedBy: 'a' });
        expect(effectiveMediaPosition(target.mediaState, 9000)).toBe(13);
    });

    it('uses SEEK targetTime, preserves playback state, and lets the second controller win', () => {
        const target = room({ revision: 3, playbackState: 'playing', currentTime: 10, updatedAt: 1000, updatedBy: 'a' });
        expect(updateMediaStateFromControl(target, EVENTS.SEEK, { currentTime: 50, targetTime: 100 }, 'a', { now: 2000 })).toBe(true);
        expect(target.mediaState).toMatchObject({ revision: 4, playbackState: 'playing', currentTime: 100, updatedBy: 'a' });
        expect(updateMediaStateFromControl(target, EVENTS.SEEK, { targetTime: 200 }, 'b', { now: 2001 })).toBe(true);
        expect(target.mediaState).toMatchObject({ revision: 5, currentTime: 200, updatedBy: 'b' });
    });

    it('uses an observed sender state only to establish an otherwise ambiguous first SEEK', () => {
        const target = room();
        expect(updateMediaStateFromControl(target, EVENTS.SEEK, { targetTime: 50 }, 'a', { now: 1000 })).toBe(false);
        expect(updateMediaStateFromControl(target, EVENTS.SEEK, { targetTime: 50 }, 'a', { now: 1000, senderPlaybackState: 'paused' })).toBe(true);
        expect(target.mediaState).toMatchObject({ revision: 1, playbackState: 'paused', currentTime: 50 });
    });

    it('rejects non-finite/missing controls without corruption and clamps existing protocol bounds', () => {
        const original = { revision: 2, playbackState: 'paused', currentTime: 30, updatedAt: 1000, updatedBy: 'a' };
        for (const payload of [{ targetTime: NaN }, { targetTime: Infinity }, { targetTime: '50' }, {}]) {
            const target = room({ ...original });
            expect(updateMediaStateFromControl(target, EVENTS.SEEK, payload, 'b', { now: 2000 })).toBe(false);
            expect(target.mediaState).toEqual(original);
        }
        const low = room({ ...original });
        updateMediaStateFromControl(low, EVENTS.SEEK, { targetTime: -5 }, 'b', { now: 2000 });
        expect(low.mediaState.currentTime).toBe(0);
        const high = room({ ...original });
        updateMediaStateFromControl(high, EVENTS.SEEK, { targetTime: MAX_MEDIA_TIME + 5 }, 'b', { now: 2000 });
        expect(high.mediaState.currentTime).toBe(MAX_MEDIA_TIME);
    });

    it('commits Force Sync only at execute time', () => {
        const target = room({ revision: 4, playbackState: 'paused', currentTime: 90, updatedAt: 1000, updatedBy: 'a' });
        expect(commitForceSyncMediaState(target, 500, 'b', 2000)).toBe(true);
        expect(target.mediaState).toEqual({ revision: 5, playbackState: 'playing', currentTime: 500, updatedAt: 2000, updatedBy: 'b' });
    });
});
