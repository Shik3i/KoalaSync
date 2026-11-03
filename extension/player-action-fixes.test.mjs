import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVENTS } from '../shared/constants.js';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') depth--;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} body did not terminate`);
}

function loadPlayerActionFixes() {
    return Function(
        `'use strict'; ${extractFunction(contentSource, 'getPlayerActionFixes')}; return getPlayerActionFixes();`
    )();
}

function loadActivePlayerActionFix(hostname) {
    const source = [
        extractFunction(contentSource, 'hostMatchesUrl'),
        extractFunction(contentSource, 'matchesPlayerUrls'),
        extractFunction(contentSource, 'getPlayerActionFixes'),
        extractFunction(contentSource, 'getActivePlayerActionFix')
    ].join('\n');
    return Function(
        'window',
        `'use strict'; ${source}; return getActivePlayerActionFix();`
    )({ location: { hostname } });
}

function createTryFixHarness({ buttons = {}, paused = true } = {}) {
    const clicked = [];
    const suppressed = [];
    const seekCalls = [];
    const fakeDocument = {
        querySelector(selector) {
            if (!buttons[selector]) return null;
            return {
                selector,
                click() {
                    clicked.push(selector);
                }
            };
        }
    };
    const video = { paused };
    const tryFix = Function(
        'document',
        'EVENTS',
        '_setSuppress',
        'seekVideo',
        `'use strict'; ${extractFunction(contentSource, 'tryPlayerActionFix')}; return tryPlayerActionFix;`
    )(
        fakeDocument,
        EVENTS,
        state => suppressed.push(state),
        (_video, targetTime) => seekCalls.push(targetTime)
    );
    return { tryFix, clicked, suppressed, seekCalls, video };
}

const APPLE_PLAY_SELECTOR = '.playback-play__play';
const APPLE_PAUSE_SELECTOR = '.playback-play__pause';
const APPLE_BUTTONS = {
    [APPLE_PLAY_SELECTOR]: true,
    [APPLE_PAUSE_SELECTOR]: true
};

describe('player action fixes', () => {
    it('declares Apple TV+ with separate buttons and keeps YouTube/Twitch as toggles', () => {
        const fixes = loadPlayerActionFixes();
        const byName = name => fixes.find(fix => fix.name === name);
        expect(byName('youtube-player-buttons')).toMatchObject({
            urls: ['youtube.com'],
            playPauseButtonSelector: '.ytp-play-button'
        });
        expect(byName('youtube-player-buttons').playButtonSelector).toBeUndefined();
        expect(byName('twitch-player-buttons')).toMatchObject({
            urls: ['twitch.tv'],
            playPauseButtonSelector: '[data-a-target="player-play-pause-button"]'
        });
        expect(byName('twitch-player-buttons').playButtonSelector).toBeUndefined();
        expect(byName('appletv-player-buttons')).toMatchObject({
            urls: ['tv.apple.com'],
            playButtonSelector: APPLE_PLAY_SELECTOR,
            pauseButtonSelector: APPLE_PAUSE_SELECTOR
        });
        expect(byName('appletv-player-buttons').playPauseButtonSelector).toBeUndefined();
    });

    it('resolves the Apple TV+ fix only on tv.apple.com hosts', () => {
        expect(loadActivePlayerActionFix('tv.apple.com')?.name).toBe('appletv-player-buttons');
        expect(loadActivePlayerActionFix('preview.tv.apple.com')?.name).toBe('appletv-player-buttons');
        expect(loadActivePlayerActionFix('apple.com')).toBeNull();
        expect(loadActivePlayerActionFix('www.youtube.com')?.name).toBe('youtube-player-buttons');
        expect(loadActivePlayerActionFix('netflix.com')).toBeNull();
    });

    it('drives Apple TV+ play with the site play button and suppresses the echo', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null)).toBe(true);
        expect(harness.clicked).toEqual([APPLE_PLAY_SELECTOR]);
        expect(harness.suppressed).toEqual(['playing']);
    });

    it('does not re-click Apple TV+ play while already playing', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: false });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null)).toBe(true);
        expect(harness.clicked).toEqual([]);
        expect(harness.suppressed).toEqual([]);
    });

    it('drives Apple TV+ pause with the site pause button and suppresses the echo', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: false });
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null)).toBe(true);
        expect(harness.clicked).toEqual([APPLE_PAUSE_SELECTOR]);
        expect(harness.suppressed).toEqual(['paused']);
    });

    it('does not re-click Apple TV+ pause while already paused', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null)).toBe(true);
        expect(harness.clicked).toEqual([]);
        expect(harness.suppressed).toEqual([]);
    });

    it('falls back to native controls when the Apple TV+ buttons are missing', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: {}, paused: true });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null)).toBe(false);
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null)).toBe(false);
        expect(harness.clicked).toEqual([]);
    });

    it('keeps Apple TV+ seeking on the native path', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(fix, EVENTS.SEEK, harness.video, { targetTime: 12.5 })).toBe(false);
        expect(harness.seekCalls).toEqual([]);
        expect(harness.clicked).toEqual([]);
    });

    it('keeps the YouTube toggle click for state changes only', () => {
        const fix = loadActivePlayerActionFix('www.youtube.com');
        const pausedHarness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: true
        });
        expect(pausedHarness.tryFix(fix, EVENTS.PLAY, pausedHarness.video, null)).toBe(true);
        expect(pausedHarness.clicked).toEqual(['.ytp-play-button']);
        expect(pausedHarness.suppressed).toEqual(['playing']);

        const playingHarness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: false
        });
        expect(playingHarness.tryFix(fix, EVENTS.PLAY, playingHarness.video, null)).toBe(true);
        expect(playingHarness.clicked).toEqual([]);
    });

    it('keeps YouTube seeking through the toggle fix', () => {
        const fix = loadActivePlayerActionFix('www.youtube.com');
        const harness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: true
        });
        expect(harness.tryFix(fix, EVENTS.SEEK, harness.video, { targetTime: 42 })).toBe(true);
        expect(harness.seekCalls).toEqual([42]);
    });

    it('rejects a missing fix', () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(null, EVENTS.PLAY, harness.video, null)).toBe(false);
    });

    it('still consults the player action fix before the native fallback', () => {
        const tryMediaAction = extractFunction(contentSource, 'tryMediaAction');
        expect(tryMediaAction.indexOf('tryPlayerActionFix(actionFix, action, video, data)'))
            .toBeLessThan(tryMediaAction.indexOf('video.play()'));
    });
});
