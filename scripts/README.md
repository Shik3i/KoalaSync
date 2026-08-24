# Development Scripts

This directory contains build, synchronization, and verification scripts for the KoalaSync workspace. Run all commands from the repository root unless a script says otherwise.

## Main Commands

```bash
npm run build:extension
npm run verify
npm run lint
npm run test:unit
npm run test:coverage
npm run prepare:release -- 3.1.5
```

- `npm run build:extension` runs `scripts/build-extension.cjs`.
- `npm run verify` runs the full release-safety suite in `scripts/verify-release.mjs`.
- `npm run lint` runs ESLint across the repository.
- `npm run test:unit` runs Vitest tests.
- `npm run test:coverage` runs the same tests with the enforced coverage floor.
- `npm run prepare:release -- MAJOR.MINOR.PATCH` updates every release-version source consistently before the release PR.

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

- Vitest unit tests with coverage thresholds for importable source modules.
- Server route and WebSocket integration checks.
- Episode parser, title privacy, host access, blacklist, names, rate limiting, audio settings, popup cooldown, and content-video-finder checks.
- JavaScript syntax checks for server and extension entry points.
- Extension and website locale coverage checks.
- ESLint.
- Production `npm audit` checks for root and server dependencies.
- Extension build and website build.

## Focused Scripts

| Script | Purpose |
|:---|:---|
| `test-server-routes.mjs` | HTTP health routes, caching, and admin metrics access |
| `test-server-ws.mjs` | Socket.IO relay integration, including host-control behavior |
| `test-audio-settings.mjs` | Audio settings defaults and normalization |
| `test-popup-refresh-cooldown.mjs` | Popup refresh throttling behavior |
| `test-content-video-finder.cjs` | Content-script video selection helpers |
| `test-locales.cjs` | Extension runtime and browser-store locale coverage |
| `test-website-locales.mjs` | Website locale coverage |

## Coverage Boundary

`vitest.config.mjs` covers importable modules executed by Vitest and enforces
both global and risk-specific per-module floors. Browser entry points
(`background.js`, `content.js`, and `popup.js`) and server process startup are
deliberately measured by extension E2E and integration tests instead of being
reported as zero-coverage unit code.
`scripts/check-coverage-inventory.mjs` additionally requires every JavaScript
source file to be classified as V8-covered or assigned to a named external
integration gate. New unclassified files fail `npm run verify`.

## Published Release Verification

Before publication, the release workflow validates the exact annotated SemVer
tag, requires it to point at current `origin/main`, requires successful
`verify`, `node20`, and `e2e` checks, and runs the complete gates again. It then
creates a draft release, publishes and smoke-tests the relay image, and only
afterwards makes the GitHub Release public. The published-asset gate runs:

```bash
node scripts/verify-published-release.mjs vMAJOR.MINOR.PATCH --repo Shik3i/KoalaSync
```

The verifier requires the exact three release assets, validates SHA-256 hashes,
annotated-tag ancestry, Chrome/Firefox manifest versions and runtime injection,
archive parity, unsafe/development-only paths, and GitHub attestations. For a
local archive-only diagnosis, pass `--asset-dir PATH`; this deliberately skips
GitHub inventory and attestation checks.

## Do Not Break

- Keep scripts runnable from the repository root.
- Keep build output under `dist/` and generated website output under `website/www/`.
- Keep shared protocol sync automated; do not add manual copy steps.
- Treat warnings in verification scripts as release blockers unless the script explicitly documents them as informational.
