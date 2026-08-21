import { describe, expect, it } from 'vitest';
import {
    TITLE_PRIVACY_MODES,
    applyTitlePrivacyToPayload,
    normalizeSendTabTitle,
    normalizeTabTitle,
    normalizeTitlePrivacyMode,
    sanitizeSharedTitle,
    sanitizeTabTitle
} from './title-privacy.js';

describe('title privacy', () => {
    it('normalizes settings and tab notification prefixes', () => {
        expect(normalizeTitlePrivacyMode(undefined)).toBe(TITLE_PRIVACY_MODES.FULL);
        expect(normalizeTitlePrivacyMode('unknown')).toBe(TITLE_PRIVACY_MODES.FULL);
        expect(normalizeTitlePrivacyMode(TITLE_PRIVACY_MODES.HIDDEN)).toBe(TITLE_PRIVACY_MODES.HIDDEN);
        expect(normalizeSendTabTitle(undefined, TITLE_PRIVACY_MODES.FULL)).toBe(true);
        expect(normalizeSendTabTitle(undefined, TITLE_PRIVACY_MODES.EPISODE)).toBe(false);
        expect(normalizeSendTabTitle(true, TITLE_PRIVACY_MODES.HIDDEN)).toBe(true);
        expect(normalizeSendTabTitle(false, TITLE_PRIVACY_MODES.FULL)).toBe(false);
        expect(normalizeTabTitle('(12) Testvideo - YouTube')).toBe('Testvideo - YouTube');
        expect(normalizeTabTitle('[999+] Testvideo - YouTube')).toBe('Testvideo - YouTube');
        expect(normalizeTabTitle('(500) Days of Summer')).toBe('Days of Summer');
        for (const title of ['[7] Testvideo', '(99+) Testvideo', '(999+) Testvideo', '(101) Testvideo', '[101] Testvideo']) {
            expect(normalizeTabTitle(title)).toBe('Testvideo');
        }
        expect(normalizeTabTitle(null)).toBeNull();
        expect(normalizeTabTitle('   ')).toBeNull();
        expect(sanitizeTabTitle('', true)).toBeNull();
    });

    it('keeps tab-title and media-title privacy independent', () => {
        expect(sanitizeTabTitle('(12) Private Tab', true)).toBe('Private Tab');
        expect(sanitizeTabTitle('Private Tab', false)).toBeNull();
        expect(sanitizeSharedTitle('Example Movie', 'full')).toBe('Example Movie');
        expect(sanitizeSharedTitle('', 'full')).toBeNull();
        expect(sanitizeSharedTitle(null, 'full')).toBeNull();
        expect(sanitizeSharedTitle('Show Name - S01/E04 - Title', 'episode')).toBe('S01E04');
        expect(sanitizeSharedTitle('Folge 7 - Private Server', 'episode')).toBe('EP007');
        expect(sanitizeSharedTitle('Example Movie', 'episode')).toBeNull();
        expect(sanitizeSharedTitle('Show Name - S01E04', 'hidden')).toBeNull();
    });

    it('rewrites only present media keys without mutating the input', () => {
        const input = {
            tabTitle: 'Private Tab',
            mediaTitle: 'Private Media',
            expectedTitle: 'S01E04',
            title: 'S01E04',
            currentTime: 42
        };
        expect(applyTitlePrivacyToPayload(input, 'hidden')).toEqual({
            tabTitle: 'Private Tab',
            mediaTitle: null,
            expectedTitle: null,
            title: null,
            currentTime: 42
        });
        expect(input.mediaTitle).toBe('Private Media');
        expect(applyTitlePrivacyToPayload({ tabTitle: 'Private Tab', status: 'heartbeat' }, 'episode')).toEqual({
            tabTitle: 'Private Tab',
            status: 'heartbeat'
        });
    });
});
