import { test, expect } from '@playwright/test';
import { buildVideoFinderScript } from './helpers/content-source.mjs';

/**
 * Runs the shipped findVideo() against real pages in a real browser, where
 * videoWidth, offsetParent, paused and duration all carry their true values.
 * Each fixture marks the element that must win with data-expected.
 */

const SCENARIOS = [
    { page: 'simple-player.html', expected: 'player', what: 'the only visible player' },
    { page: 'iframe-player.html', expected: 'framed-player', what: 'a player inside a same-origin frame' },
    { page: 'nested-frame.html', expected: 'framed-player', what: 'a player two frame levels down' },
    { page: 'shadow-player.html', expected: 'shadow-player', what: 'a player inside a shadow root over a light-DOM teaser' },
    { page: 'muted-player.html', expected: 'player', what: 'the only player even when muted' },
    { page: 'display-contents-player.html', expected: 'player', what: 'a visible player inside a boxless display-contents wrapper' },
    { page: 'hidden-preload.html', expected: 'player', what: 'the visible player over a hidden higher-resolution preload' },
    { page: 'ad-frame.html', expected: 'player', what: 'the real player over a muted ad in a first-party frame' },
    { page: 'background-loop.html', expected: 'player', what: 'the real player over a large looping background video' },
    { page: 'multi-player.html', expected: 'watched', what: 'the player that is actually playing' },
    { page: 'sourceless.html', expected: 'player', what: 'the real player over a large sourceless placeholder' }
];

test.describe('video detection', () => {
    for (const { page: fixture, expected, what } of SCENARIOS) {
        test(`picks ${what} (${fixture})`, async ({ page }) => {
            await page.goto(`/pages/${fixture}`);
            await page.waitForFunction(() => window.__fixtureReady === true);

            // Assert the fixture is in the state it claims before judging the
            // finder, so a broken fixture never reads as a scoring regression.
            const preconditions = await page.evaluate(() => {
                const videos = [];
                const walk = (doc) => {
                    for (const v of doc.querySelectorAll('video')) videos.push(v);
                    for (const f of doc.querySelectorAll('iframe')) {
                        try { if (f.contentDocument) walk(f.contentDocument); } catch (_e) { /* cross-origin */ }
                    }
                    for (const el of doc.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
                };
                walk(document);
                return videos
                    .filter(v => v.dataset.autoplay !== undefined)
                    .map(v => ({ id: v.id, paused: v.paused, ended: v.ended }));
            });
            for (const video of preconditions) {
                expect(video.paused, `fixture video ${video.id} should be playing`).toBe(false);
                expect(video.ended, `fixture video ${video.id} should not have ended`).toBe(false);
            }

            await page.addScriptTag({ content: buildVideoFinderScript() });

            const picked = await page.evaluate(() => {
                const video = window.__koalaFindVideo();
                if (!video) return null;
                return {
                    id: video.id,
                    expected: video.dataset.expected !== undefined,
                    inFrame: video.ownerDocument !== document
                };
            });

            expect(picked, 'a video must be found at all').not.toBeNull();
            expect(picked.id).toBe(expected);
            expect(picked.expected, `${picked.id} is not the element marked data-expected`).toBe(true);
        });
    }

    test('finds a player frame that is attached later (late-frame.html)', async ({ page }) => {
        await page.goto('/pages/late-frame.html');
        await page.addScriptTag({ content: buildVideoFinderScript() });

        // Nothing to find while the slot is still empty.
        expect(await page.evaluate(() => window.__koalaFindVideo() === null)).toBe(true);

        await page.waitForFunction(() => {
            const video = window.__koalaFindVideo();
            return !!video && video.readyState >= 1;
        });
        expect(await page.evaluate(() => window.__koalaFindVideo().id)).toBe('framed-player');
    });

    test('returns null on a page without any video', async ({ page }) => {
        await page.setContent('<h1>no media here</h1>');
        await page.addScriptTag({ content: buildVideoFinderScript() });
        expect(await page.evaluate(() => window.__koalaFindVideo())).toBeNull();
    });
});
