import { describe, expect, it } from 'vitest';
import {
    EPISODE_WIRE_TITLE_LENGTH,
    createLocalEpisodeDeadline,
    createEpisodeWireIdentity,
    extractEpisodeId,
    sameEpisode,
    sameEpisodeIdentity,
    sameEpisodeStrict,
    isEpisodeSyncV2StartContextCurrent,
    matchesEpisodeSyncV2StartRejection,
    toEpisodeWireTitle
} from './episode-utils.js';

describe('episode title matching', () => {
    it.each([
        ['S01E01', 'S01E01'],
        ['S1E1', 'S01E01'],
        ['s01e01', 'S01E01'],
        ['Season 1 Episode 2', 'S01E02'],
        ['season 01 episode 02', 'S01E02'],
        ['S01 - E01', 'S01E01'],
        ['S01.E01', 'S01E01'],
        ['S01/E01', 'S01E01'],
        ['S01:E01', 'S01E01'],
        ['S01,E01', 'S01E01'],
        ['S01 E01', 'S01E01'],
        ['Folge 5', 'EP005'],
        ['Episode 12', 'EP012'],
        ['Ep. 3', 'EP003'],
        ['#42', 'EP042'],
        ['S01E001', 'S01E001']
    ])('extracts %s as %s', (title, expected) => {
        expect(extractEpisodeId(title)).toBe(expected);
    });

    it.each([null, undefined, '', 123, 'Some Movie Title', 'Breaking Bad'])(
        'returns null for non-episode input %j',
        input => expect(extractEpisodeId(input)).toBeNull()
    );

    it.each([
        ['S01E01', 'S01E01'],
        ['S01E01 - Pilot', 'S01E01'],
        ['Folge 5', 'Episode 5'],
        ['Episode 12', 'Ep. 12'],
        ['#42', 'Folge 42'],
        [null, null],
        ['', ''],
        ['Some Movie', 'Some Movie']
    ])('matches equivalent titles %j and %j', (left, right) => {
        expect(sameEpisode(left, right)).toBe(true);
    });

    it.each([
        ['S01E01', 'S01E02'],
        ['S01E01', 'S02E01'],
        ['Folge 1', 'Folge 2'],
        ['Some Movie', 'Other Movie'],
        ['S01E01', null],
        [null, 'Episode 5'],
        ['S01E05', 'Episode 5'],
        ['S01E01', 'EP001']
    ])('rejects different titles %j and %j', (left, right) => {
        expect(sameEpisode(left, right)).toBe(false);
    });

    it('keeps transactional matching strict when both titles expose context', () => {
        expect(sameEpisodeStrict('S1:E6 - Visiting Ours', 'S01E06 - Visiting Ours')).toBe(true);
        expect(sameEpisodeStrict('S1:E6 - Visiting Ours', 'S1:E6 - Another Show')).toBe(false);
        expect(sameEpisodeStrict('S1:E6', 'S01E06 - Visiting Ours')).toBe(true);
        expect(sameEpisodeStrict(
            'Arrested Development - S1:E6 - Visiting Ours',
            'S01E06 - Visiting Ours'
        )).toBe(true);
        expect(sameEpisodeStrict(
            'Arrested Development - S1:E6 - Visiting Ours',
            'Different Series - S01E06 - Visiting Ours'
        )).toBe(false);
    });

    it('mirrors the relay title clamp before strict comparison', () => {
        const title = `S01E06 - ${'Very Long Episode Context '.repeat(8)}`;
        const wireTitle = toEpisodeWireTitle(title);

        expect(EPISODE_WIRE_TITLE_LENGTH).toBe(100);
        expect(wireTitle).toHaveLength(100);
        expect(sameEpisodeStrict(title, wireTitle)).toBe(true);
    });

    it('keeps the full-title episode id in a bounded wire identity', () => {
        const title = `${'Long Series Context '.repeat(8)} S01E06`;
        const identity = createEpisodeWireIdentity(title);

        expect(identity).toEqual({
            expectedTitle: title.substring(0, 100),
            expectedEpisodeId: 'S01E06'
        });
        expect(sameEpisodeIdentity(title, identity.expectedTitle, identity.expectedEpisodeId)).toBe(true);
        expect(sameEpisodeIdentity(title.replace('S01E06', 'S01E07'), identity.expectedTitle, identity.expectedEpisodeId)).toBe(false);
    });

    it('bounds oversized and UTF-16 titles exactly like relay substring sanitization', () => {
        const title = `${'x'.repeat(99)}😀S01E06${'y'.repeat(5000)}`;
        expect(toEpisodeWireTitle(title)).toBe(title.substring(0, 100));
        expect(toEpisodeWireTitle(title).length).toBe(100);
        expect(toEpisodeWireTitle(null)).toBeNull();
    });

    it('converts relay remaining duration to a bounded local deadline without wall-clock trust', () => {
        expect(createLocalEpisodeDeadline(30_000, 120_000, 1_000)).toEqual({
            remainingMs: 30_000,
            deadlineAt: 31_000
        });
        expect(createLocalEpisodeDeadline(undefined, 120_000, 1_000)).toEqual({
            remainingMs: 120_000,
            deadlineAt: 121_000
        });
        expect(createLocalEpisodeDeadline(999_999, 120_000, 1_000).remainingMs).toBe(120_000);
        expect(createLocalEpisodeDeadline(-1, 120_000, 1_000).remainingMs).toBe(0);
    });

    it('rejects stale or mismatched capability fallback responses', () => {
        const pending = {
            roomId: 'ROOM-A',
            connectionGeneration: 4,
            targetGeneration: 7,
            tabId: 12,
            expectedTitle: 'S01E06 - Visiting Ours',
            expectedEpisodeId: 'S01E06',
            requestedAt: 10_000
        };
        const current = {
            roomId: 'ROOM-A',
            connectionGeneration: 4,
            targetGeneration: 7,
            tabId: 12
        };
        const rejection = {
            expectedTitle: 'S01E06 - Visiting Ours',
            expectedEpisodeId: 's01e06'
        };

        expect(isEpisodeSyncV2StartContextCurrent(pending, current, 20_000)).toBe(true);
        expect(matchesEpisodeSyncV2StartRejection(pending, current, rejection, 20_000)).toBe(true);
        expect(matchesEpisodeSyncV2StartRejection(pending, { ...current, targetGeneration: 8 }, rejection, 20_000)).toBe(false);
        expect(matchesEpisodeSyncV2StartRejection(pending, current, rejection, 25_001)).toBe(false);
        expect(matchesEpisodeSyncV2StartRejection(pending, current, {
            ...rejection,
            expectedTitle: 'S01E07 - Different'
        }, 20_000)).toBe(false);
    });
});
