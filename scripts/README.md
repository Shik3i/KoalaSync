# Development Scripts

This directory contains build, synchronization, and verification scripts for the KoalaSync workspace. Run all commands from the repository root unless a script says otherwise.

## Main Commands

```bash
npm run build:extension
npm run verify
npm run lint
npm run test:unit
```

- `npm run build:extension` runs `scripts/build-extension.cjs`.
- `npm run verify` runs the full release-safety suite in `scripts/verify-release.mjs`.
- `npm run lint` runs ESLint across the repository.
- `npm run test:unit` runs Vitest tests.

## build-extension.cjs

The primary extension build tool performs these steps:

1. Recreates `dist/`.
2. Copies `shared/constants.js`, `shared/blacklist.js`, `shared/names.js`, and `shared/README.md` into `extension/shared/`.
3. Injects synchronous shared values into `content.js`.
4. Injects browser-specific uninstall URL constants into `background.js`.
5. Injects the build timestamp into `popup.html`.
6. Generates browser-specific manifests for Chrome and Firefox.
7. Creates `dist/koalasync-chrome.zip` and `dist/koalasync-firefox.zip`.

Usage:
```bash
node scripts/build-extension.cjs
# or
npm run build:extension
```

## Injection Markers

The build script uses marker comments/placeholders. Missing markers are a hard build failure so release artifacts cannot silently contain stale protocol data.

| Target | Marker / Placeholder | Injected Value | Source |
|:---|:---|:---|:---|
| `content.js` | `SHARED_EVENTS_INJECT_START` / `END` | Full `EVENTS` object | `shared/constants.js` |
| `content.js` | `SHARED_HEARTBEAT_INJECT_START` / `END` | `HEARTBEAT_INTERVAL` | `shared/constants.js` |
| `content.js` | `SHARED_EPISODE_UTILS_INJECT_START` / `END` | `extractEpisodeId()` and `sameEpisode()` | `extension/episode-utils.js` |
| `background.js` | `UNINSTALL_URL_INJECT_START` / `END` | Uninstall URL and browser type | `scripts/build-extension.cjs` |
| `popup.html` | `__BUILD_TIMESTAMP__` | UTC build timestamp | Build time |

Do not remove or rename these markers without updating the build script and tests.

## Verification Suite

`scripts/verify-release.mjs` is the best single command before release, PR review, or handoff:

```bash
npm run verify
```

It currently runs:

- Vitest unit tests.
- Server ops, route, WebSocket, and rate-limiter checks.
- Episode parser, title privacy, audio settings, popup cooldown, names, and content-video-finder checks.
- JavaScript syntax checks for server and extension entry points.
- Extension and website locale coverage checks.
- ESLint.
- Production `npm audit` checks for root and server dependencies.
- Extension build and website build.

## Focused Scripts

| Script | Purpose |
|:---|:---|
| `test-server-ops.mjs` | Health payload and admin metrics helpers |
| `test-server-routes.mjs` | HTTP health routes, caching, and admin metrics access |
| `test-server-ws.mjs` | Socket.IO relay integration, including host-control behavior |
| `test-rate-limiter.mjs` | Rate-limiter map and cooldown behavior |
| `test-episode-utils.mjs` | Episode-title extraction and comparison |
| `test-title-privacy.mjs` | Tab/media title privacy sanitization |
| `test-audio-settings.mjs` | Audio settings defaults and normalization |
| `test-popup-refresh-cooldown.mjs` | Popup refresh throttling behavior |
| `test-names.mjs` | Generated username format and coverage |
| `test-content-video-finder.cjs` | Content-script video selection helpers |
| `test-locales.cjs` | Extension runtime and browser-store locale coverage |
| `test-website-locales.mjs` | Website locale coverage |

## Do Not Break

- Keep scripts runnable from the repository root.
- Keep build output under `dist/` and generated website output under `website/www/`.
- Keep shared protocol sync automated; do not add manual copy steps.
- Treat warnings in verification scripts as release blockers unless the script explicitly documents them as informational.
