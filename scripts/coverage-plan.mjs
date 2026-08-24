export const VITEST_COVERAGE_INCLUDE = Object.freeze([
    'server/chat.js',
    'server/ops.js',
    'server/rate-limiter.js',
    'shared/blacklist.js',
    'shared/invite-links.js',
    'shared/names.js',
    'extension/chat-activity.js',
    'extension/chat-crypto.js',
    'extension/chat-format.js',
    'extension/chat-session.js',
    'extension/chat-wire.js',
    'extension/episode-utils.js',
    'extension/host-access.js',
    'extension/media-frame-target.js',
    'extension/title-privacy.js',
    'scripts/release-artifact-checks.mjs'
]);

// Exact list by design: adding a runtime/tooling module requires choosing its
// automated gate instead of silently leaving it unmeasured.
export const EXTERNALLY_GATED_SOURCES = Object.freeze({
    'packed extension E2E': Object.freeze([
        'extension/audio-options.js',
        'extension/background.js',
        'extension/bridge.js',
        'extension/chat-overlay.js',
        'extension/content.js',
        'extension/i18n.js',
        'extension/media-frame-monitor.js',
        'extension/modules/tab-manager.js',
        'extension/page-api-seek-overrides.js',
        'extension/popup.js',
        'extension/theme-init.js',
        'shared/constants.js'
    ]),
    'relay integration': Object.freeze([
        'server/index.js'
    ]),
    'release and repository integration': Object.freeze([
        'scripts/build-extension.cjs',
        'scripts/check-coverage-inventory.mjs',
        'scripts/coverage-plan.mjs',
        'scripts/prepare-release.mjs',
        'scripts/release-preflight.mjs',
        'scripts/test-audio-settings.mjs',
        'scripts/test-chat-settings.mjs',
        'scripts/test-content-video-finder.cjs',
        'scripts/test-locales.cjs',
        'scripts/test-popup-refresh-cooldown.mjs',
        'scripts/test-server-routes.mjs',
        'scripts/test-server-ws.mjs',
        'scripts/test-website-locales.mjs',
        'scripts/test-website-theme.mjs',
        'scripts/translate-locales-tool.cjs',
        'scripts/validate-brand-names.cjs',
        'scripts/verify-published-release.mjs',
        'scripts/verify-release.mjs'
    ]),
    'website build and contract checks': Object.freeze([
        'website/app.js',
        'website/build.cjs',
        'website/flag-font-utils.cjs',
        'website/lang-init.js',
        'website/submit-indexnow.cjs',
        'website/tools/subset-flag-font.mjs'
    ])
});
