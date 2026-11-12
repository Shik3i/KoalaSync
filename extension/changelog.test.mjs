import { describe, expect, it } from 'vitest';
import {
    CHANGELOG_SYNC_KEY,
    CHANGELOG_URL,
    RELEASE_CHANGELOG,
    resolveChangelogVersion,
    shouldAutoShowChangelog
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

    it('resolves the target version from release.id when pinned or from manifest version otherwise', () => {
        expect(resolveChangelogVersion('3.4.0', { autoShow: true, items: [] })).toBe('3.4.0');
        expect(resolveChangelogVersion('v3.4.0', { autoShow: true, items: [] })).toBe('3.4.0');
        expect(resolveChangelogVersion('3.4.1', { id: '3.4.0', autoShow: true, items: [] })).toBe('3.4.0');
        expect(resolveChangelogVersion('', { autoShow: true, items: [] })).toBe('');
        expect(resolveChangelogVersion(null, null)).toBe('');
    });

    it('suppresses automatic display until onboarding is complete', () => {
        expect(shouldAutoShowChangelog({
            onboardingComplete: false,
            lastReadChangelogVersion: '',
            currentVersion: '3.4.0',
            release: { autoShow: true, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
    });

    it('shows once for a new version when onboarding is complete and autoShow is enabled', () => {
        const release = { autoShow: true, items: RELEASE_CHANGELOG.items };
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '',
            currentVersion: '3.4.0',
            release
        })).toBe(true);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.3.0',
            currentVersion: '3.4.0',
            release
        })).toBe(true);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.4.0',
            currentVersion: '3.4.0',
            release
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: 'v3.4.0',
            currentVersion: '3.4.0',
            release
        })).toBe(false);
    });

    it('suppresses automatic display when autoShow is false or items are empty', () => {
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.3.0',
            currentVersion: '3.4.1',
            release: { autoShow: false, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '3.3.0',
            currentVersion: '3.4.1',
            release: { autoShow: true, items: [] }
        })).toBe(false);
        expect(shouldAutoShowChangelog({
            onboardingComplete: true,
            lastReadChangelogVersion: '',
            currentVersion: '',
            release: { autoShow: true, items: RELEASE_CHANGELOG.items }
        })).toBe(false);
        expect(shouldAutoShowChangelog()).toBe(false);
    });
});
