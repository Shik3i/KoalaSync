import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BLACKLIST_DOMAINS,
    BLACKLIST_OVERRIDES_STORAGE_KEY,
    BLACKLIST_SOURCE_DEFAULT,
    BLACKLIST_SOURCE_USER,
    CUSTOM_BLACKLIST_STORAGE_KEY,
    createEmptyBlacklistOverrides,
    deriveBlacklistOverrides,
    getBlacklistEntries,
    getEffectiveBlacklistDomains,
    isUrlBlacklisted,
    normalizeBlacklistDomain,
    normalizeBlacklistOverrides,
    parseBlacklistDomains
} from './blacklist.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('blacklist behavior', () => {
    it('normalizes, deduplicates, and rejects unsafe entries', () => {
        expect(CUSTOM_BLACKLIST_STORAGE_KEY).toBe('customBlacklistDomains');
        expect(BLACKLIST_OVERRIDES_STORAGE_KEY).toBe('blacklistOverrides');
        expect(normalizeBlacklistDomain(' Example.COM. ')).toBe('example.com');
        expect(normalizeBlacklistDomain('https://Video.Example.com/watch/123')).toBe('video.example.com');
        expect(normalizeBlacklistDomain('*.example.com')).toBeNull();
        expect(normalizeBlacklistDomain('not a domain')).toBeNull();
        expect(parseBlacklistDomains('Example.com\nhttps://sub.example.com/path\nexample.com\n')).toEqual({
            domains: ['example.com', 'sub.example.com'],
            invalid: []
        });
        expect(parseBlacklistDomains('example.com\nnot a domain').invalid).toEqual(['not a domain']);
        expect(parseBlacklistDomains('# note\nvideos.example\n\n# defaults\ngoogle.com')).toEqual({
            domains: ['videos.example', 'google.com'],
            invalid: []
        });
    });

    it('matches only exact hosts and their subdomains', () => {
        expect(isUrlBlacklisted('https://mail.google.com/inbox', ['google.com'])).toBe(true);
        expect(isUrlBlacklisted('https://notgoogle.com/', ['google.com'])).toBe(false);
        expect(isUrlBlacklisted('not a url', ['example.com'])).toBe(false);
        expect(isUrlBlacklisted('https://drive.google.com/file/d/x/view', BLACKLIST_DOMAINS)).toBe(false);
        expect(isUrlBlacklisted('https://drive.google.com/file/d/x/view', ['drive.google.com'])).toBe(true);
        expect(isUrlBlacklisted('https://docs.google.com/document/d/x', BLACKLIST_DOMAINS)).toBe(true);
    });

    it('stores user edits as a delta so future defaults continue to flow in', () => {
        expect(createEmptyBlacklistOverrides()).toEqual({ removedDefaults: [], addedDomains: [] });
        const edited = BLACKLIST_DOMAINS
            .filter(domain => domain !== 'reddit.com' && domain !== 'imgur.com')
            .concat(['videos.example']);
        const overrides = deriveBlacklistOverrides(edited);
        expect(overrides).toEqual({
            removedDefaults: ['reddit.com', 'imgur.com'],
            addedDomains: ['videos.example']
        });

        const effective = new Set(getEffectiveBlacklistDomains(overrides));
        expect(effective.has('reddit.com')).toBe(false);
        expect(effective.has('videos.example')).toBe(true);
        const removed = new Set(overrides.removedDefaults);
        for (const domain of BLACKLIST_DOMAINS) {
            expect(effective.has(domain) || removed.has(domain)).toBe(true);
        }

        const readded = deriveBlacklistOverrides([...effective, 'reddit.com'], overrides);
        expect(new Set(readded.removedDefaults).has('reddit.com')).toBe(false);
        expect(deriveBlacklistOverrides(['google.com'], {
            removedDefaults: [],
            addedDomains: ['google.com']
        }).addedDomains).toEqual(['google.com']);
    });

    it('normalizes legacy and contradictory storage without losing intent', () => {
        expect(getEffectiveBlacklistDomains(undefined)).toEqual(BLACKLIST_DOMAINS);
        expect(getEffectiveBlacklistDomains([])).toEqual([]);
        expect(normalizeBlacklistOverrides({
            removedDefaults: ['example.com'],
            addedDomains: ['example.com']
        })).toEqual({ removedDefaults: [], addedDomains: ['example.com'] });
        expect(normalizeBlacklistOverrides('nonsense')).toEqual(createEmptyBlacklistOverrides());

        const overrides = { removedDefaults: ['reddit.com'], addedDomains: ['videos.example'] };
        const entries = getBlacklistEntries(overrides);
        expect(entries.find(entry => entry.domain === 'videos.example')?.source).toBe(BLACKLIST_SOURCE_USER);
        expect(entries.find(entry => entry.domain === 'google.com')?.source).toBe(BLACKLIST_SOURCE_DEFAULT);
        const rendered = [
            '# Your entries',
            ...entries.filter(entry => entry.source === BLACKLIST_SOURCE_USER).map(entry => entry.domain),
            '',
            '# Shipped defaults',
            ...entries.filter(entry => entry.source === BLACKLIST_SOURCE_DEFAULT).map(entry => entry.domain)
        ].join('\n');
        expect(deriveBlacklistOverrides(parseBlacklistDomains(rendered).domains, overrides)).toEqual(
            normalizeBlacklistOverrides(overrides)
        );
    });
});

describe('blacklist integration contracts', () => {
    it('keeps storage local and the editor present', () => {
        const popupSource = fs.readFileSync(path.join(repoRoot, 'extension/popup.js'), 'utf8');
        const popupHtml = fs.readFileSync(path.join(repoRoot, 'extension/popup.html'), 'utf8');
        expect(popupSource).toMatch(/chrome\.storage\.local\.set\(\{ \[BLACKLIST_OVERRIDES_STORAGE_KEY\]: overrides \}\)/);
        expect(popupSource).not.toMatch(/chrome\.storage\.sync\.set\(\{ \[(?:BLACKLIST_OVERRIDES|CUSTOM_BLACKLIST)_STORAGE_KEY\]/);
        expect(popupSource).toMatch(/chrome\.storage\.local\.remove\(CUSTOM_BLACKLIST_STORAGE_KEY\)/);
        expect(popupSource).toMatch(/isUrlBlacklisted\(tab\.url, blacklistDomains\)/);
        expect(popupHtml).toMatch(/id="blacklistDomains"/);
        expect(popupHtml).toMatch(/id="blacklistReset"/);
    });
});
