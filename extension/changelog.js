export const CHANGELOG_SYNC_KEY = 'lastReadChangelogVersion';
export const CHANGELOG_URL = 'https://github.com/Shik3i/KoalaSync/blob/main/docs/CHANGELOG.md';

// Hardcoded per-release changelog configuration.
// Set `autoShow: true` for releases that should open the modal once after update,
// or `autoShow: false` for minor patch releases where it should only open when
// clicking the version number in the popup header.
export const RELEASE_CHANGELOG = Object.freeze({
    autoShow: true,
    items: Object.freeze([
        Object.freeze({
            badgeKey: 'CHANGELOG_BADGE_NEW',
            titleKey: 'CHANGELOG_ITEM_1_TITLE',
            descKey: 'CHANGELOG_ITEM_1_DESC'
        }),
        Object.freeze({
            badgeKey: 'CHANGELOG_BADGE_IMPROVED',
            titleKey: 'CHANGELOG_ITEM_2_TITLE',
            descKey: 'CHANGELOG_ITEM_2_DESC'
        }),
        Object.freeze({
            badgeKey: 'CHANGELOG_BADGE_IMPROVED',
            titleKey: 'CHANGELOG_ITEM_3_TITLE',
            descKey: 'CHANGELOG_ITEM_3_DESC'
        })
    ])
});

export function resolveChangelogVersion(currentVersion, release = RELEASE_CHANGELOG) {
    if (release && typeof release.id === 'string' && release.id.trim()) {
        return release.id.trim();
    }
    if (typeof currentVersion === 'string' && currentVersion.trim()) {
        return currentVersion.trim().replace(/^v/i, '');
    }
    return '';
}

export function shouldAutoShowChangelog({
    onboardingComplete = false,
    lastReadChangelogVersion = '',
    currentVersion = '',
    release = RELEASE_CHANGELOG
} = {}) {
    if (onboardingComplete !== true) return false;
    if (!release || release.autoShow !== true) return false;
    if (!Array.isArray(release.items) || release.items.length === 0) return false;
    const targetVersion = resolveChangelogVersion(currentVersion, release);
    if (!targetVersion) return false;
    const normalizedRead = typeof lastReadChangelogVersion === 'string'
        ? lastReadChangelogVersion.trim().replace(/^v/i, '')
        : '';
    return normalizedRead !== targetVersion;
}
