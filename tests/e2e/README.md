# Extension E2E smoke tests

Browser-level tests for the parts that unit tests cannot reach: which `<video>`
the extension picks on a real page, and whether the packed extension gets far
enough to control it.

```bash
npm run test:e2e:install   # once, downloads the browsers
npm run build:extension    # extension.spec.mjs loads dist/chrome
npm run test:e2e
npm run test:e2e:detection # finder only: Chromium, Firefox, WebKit
npm run test:e2e:extension # packed extension only: Chromium MV3
npm run test:e2e:race      # @race scenarios, repeated 20 times
```

## Layout

| Path | Purpose |
| :--- | :--- |
| `detection.spec.mjs` | Runs the shipped `findVideo()` against the fixture pages |
| `extension.spec.mjs` | Loads `dist/chrome`, injects into a tab, applies remote play/pause/seek |
| `fixture-server.mjs` | Static server for the fixtures, with byte-range support for media |
| `fixtures/pages/` | One page per scenario |
| `fixtures/media/` | Small generated clips (see below) |
| `helpers/content-source.mjs` | Lifts the real finder out of `extension/content.js` |

The detection fixtures run as three Playwright projects: Chromium, Firefox,
and WebKit. Packed-extension tests remain Chromium-only because they exercise
Chrome MV3 APIs and a persistent service-worker context. The scheduled
`.github/workflows/race-tests.yml` lane repeats tests marked `@race` and uploads
traces/results on failure.

## Two rules worth keeping

**The specs run the shipped source, not a copy.** `helpers/content-source.mjs`
extracts `findVideo` and its ranking helpers straight out of
`extension/content.js`. A fixture that passes against a reimplementation would
prove nothing about the extension. If you split the finder into more functions,
add them to `VIDEO_FINDER_EXPORTS` there and to `VIDEO_FINDER_PARTS` in
`scripts/test-content-video-finder.cjs`, or the extraction fails loudly.

**Each fixture marks its own answer.** The element that must win carries
`data-expected`; videos that have to be playing carry `data-autoplay`, and
`ready.js` holds the page back until metadata and playback have settled. The
specs assert those preconditions before judging the finder, so a broken fixture
reads as a broken fixture instead of a scoring regression.

## Scenarios

| Fixture | What it pins down |
| :--- | :--- |
| `simple-player.html` | The ordinary case |
| `iframe-player.html` | Player inside a same-origin frame, empty top document |
| `late-frame.html` | Player frame attached after the page settled |
| `shadow-player.html` | Player in a shadow root, tiny teaser in the light DOM |
| `muted-player.html` | Mute must not disqualify the only player |
| `display-contents-player.html` | A visible player survives a boxless `display: contents` wrapper |
| `hidden-preload.html` | A `display:none` preload still reports 1080p; it must lose |
| `ad-frame.html` | 1080p asset in a 300x250 ad slot must lose to the real player |
| `background-loop.html` | Silent looping hero must lose despite being the largest |
| `multi-player.html` | Between equal players, the playing one wins |
| `sourceless.html` | A large `<video>` with no source can never be the player |
| `nested-frame.html` | Player two frame levels down |
| `reloading-frame.html` | Frame that swaps its document, with no mutation in the top one |

## Benchmark

`bench-finder.mjs` is not a spec, because timings are machine dependent and
would only add noise to CI. Run it by hand when the finder changes:

```bash
node tests/e2e/fixture-server.mjs 4173 & node tests/e2e/bench-finder.mjs
```

It measures the shipped finder (lifted from `content.js`) against the
pre-v3.1.0 formula, which is transcribed inside the script since that code no
longer exists in the tree.

## Regenerating the media

Solid-colour clips, a few KB each, committed so the suite needs no network:

```bash
ffmpeg -y -f lavfi -i "color=c=blue:s=1920x1080:d=30:r=10" -c:v libx264 -preset veryfast -crf 45 -pix_fmt yuv420p -movflags +faststart fixtures/media/player-1080p-30s.mp4
```

Same command with `green/854x480/12`, `red/640x360/5` and `gray/1280x720/3` for
the other three.
