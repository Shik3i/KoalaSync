export const CHANGELOG_SYNC_KEY = 'lastReadChangelogVersion';
export const CHANGELOG_URL = 'https://github.com/Shik3i/KoalaSync/blob/main/docs/CHANGELOG.md';

// Hardcoded per-release changelog configuration.
// Only MAJOR.MINOR is tracked in storage.sync so PATCH bugfix releases (x.y.z)
// never re-trigger the modal automatically.
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

export function toMajorMinorVersion(version) {
    if (typeof version !== 'string') return '';
    const trimmed = version.trim().replace(/^v/i, '');
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(trimmed);
    if (!match) return '';
    return `${match[1]}.${match[2]}`;
}

export function resolveChangelogVersion(currentVersion, release = RELEASE_CHANGELOG) {
    if (release && typeof release.id === 'string' && release.id.trim()) {
        return toMajorMinorVersion(release.id) || release.id.trim();
    }
    return toMajorMinorVersion(currentVersion);
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
    const normalizedRead = toMajorMinorVersion(lastReadChangelogVersion)
        || (typeof lastReadChangelogVersion === 'string' ? lastReadChangelogVersion.trim() : '');
    return normalizedRead !== targetVersion;
}
