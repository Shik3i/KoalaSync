import { describe, expect, it } from 'vitest';
import { extractEpisodeId, sameEpisode } from './episode-utils.js';

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
});
