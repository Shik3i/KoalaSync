import { describe, expect, it } from 'vitest';
import {
    CHANGELOG_SYNC_KEY,
    CHANGELOG_URL,
    RELEASE_CHANGELOG,
    resolveChangelogVersion,
    shouldAutoShowChangelog,
    toMajorMinorVersion
} from './changelog.js';

describe('extension changelog release gating', () => {
    it('exports expected sync key, GitHub changelog URL, and default release items', () => {
        expect(CHANGELOG_SYNC_KEY).toBe('lastReadChangelogVersion');
        expect(CHANGELOG_URL).toBe('https://github.com/Shik3i/KoalaSync/blob/main/docs/CHANGELOG.md');
        expect(typeof RELEASE_CHANGELOG.autoShow).toBe('boolean');
        expect(RELEASE_CHANGELOG.items.length).toBeGreaterThan(0);
        for (const item of RELEASE_CHANGELOG.items) {
            expect(item.badgeKey).toMatch(/^CHANGELOG_BADGE_/);
            expect(item.titleKey).toMatch(/^CHANGELOG_ITEM_\d+_TITLE$/);
            expect(item.descKey).toMatch(/^CHANGELOG_ITEM_\d+_DESC$/);
        }
    });

    it('normalizes versions to MAJOR.MINOR and ignores PATCH segments', () => {
        expect(toMajorMinorVersion('3.5.0')).toBe('3.5');
        expect(toMajorMinorVersion('v3.5.9')).toBe('3.5');
        expect(toMajorMinorVersion('3.5')).toBe('3.5');
        expect(toMajorMinorVersion('invalid')).toBe('');
        expect(toMajorMinorVersion(null)).toBe('');

        expect(resolveChangelogVersion('3.4.0', { autoShow: true, items: [] })).toBe('3.4');
        expect(resolveChangelogVersion('v3.4.7', { autoShow: true, items: [] })).toBe('3.4');
        expect(resolveChangelogVersion('3.5.1', { id: '3.5.0', autoShow: true, items: [] })).toBe('3.5');
        expect(resolveChangelogVersion('3.5.1', { id: 'custom-id', autoShow: true, items: [] })).toBe('custom-id');
        expect(resolveChangelogVersion('', { autoShow: true, items: [] })).toBe('');
        expect(resolveChangelogVersion(null, null)).toBe('');
    });

    it('suppresses automatic display until onboarding is complete', () => {
        expect(shouldAutoShowChangelog({
            onboardingComplete: false,
            lastReadChangelogVersion: '',
            currentVersion: '3.5.0',
            release: { autoShow: true, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
    });

    it('shows once per MAJOR.MINOR release and ignores PATCH bugfix bumps', () => {
        const release = { autoShow: true, items: RELEASE_CHANGELOG.items };
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '',
            currentVersion: '3.5.0',
            release
        })).toBe(true);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.4',
            currentVersion: '3.5.0',
            release
        })).toBe(true);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.5',
            currentVersion: '3.5.0',
            release
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.5',
            currentVersion: '3.5.1',
            release
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.5.0',
            currentVersion: '3.5.4',
            release
        })).toBe(false);
    });

    it('suppresses automatic display when autoShow is false or items are empty', () => {
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.4',
            currentVersion: '3.5.0',
            release: { autoShow: false, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.4',
            currentVersion: '3.5.0',
            release: { autoShow: true, items: [] }
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '',
            currentVersion: '',
            release: { autoShow: true, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: null,
            currentVersion: '3.5.0',
            release: { autoShow: true, items: RELEASE_CHANGELOG.items }
        })).toBe(true);
        expect(shouldAutoShowChangelog()).toBe(false);
    });
});
