import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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

function createTryFixHarness({ buttons = {}, paused = true, timers = 'recorded' } = {}) {
    const clicked = [];
    const suppressed = [];
    const seekCalls = [];
    const logs = [];
    const pendingTimers = [];
    const makeButton = (selector, spec) => ({
        selector,
        ...(typeof spec === 'object' && spec ? spec : {}),
        click() {
            clicked.push(selector);
        }
    });
    const fakeDocument = {
        querySelector(selector) {
            if (!buttons[selector]) return null;
            return makeButton(selector, buttons[selector]);
        }
    };
    const video = { paused, isConnected: true };
    const source = [
        'const APPLE_PLAY_WATCHDOG_WINDOW_MS = 1000;',
        'let applePlayWatchdog = null;',
        'let hcmLastUserGestureAt = 0;',
        extractFunction(contentSource, 'newCorrelationId'),
        extractFunction(contentSource, 'isButtonOperable'),
        extractFunction(contentSource, 'cancelApplePlayWatchdog'),
        extractFunction(contentSource, 'startApplePlayWatchdog'),
        extractFunction(contentSource, 'noteApplePlayEvent'),
        extractFunction(contentSource, 'consumeApplePlayRejection'),
        extractFunction(contentSource, 'tryPlayerActionFix')
    ].join('\n');
    const scheduler = timers === 'real'
        ? (callback, delay) => setTimeout(callback, delay)
        : (callback, delay) => {
            pendingTimers.push({ callback, delay });
            return pendingTimers.length;
        };
    const api = Function(
        'document',
        'EVENTS',
        '_setSuppress',
        'seekVideo',
        'reportLog',
        'scheduleLifecycleTimeout',
        `'use strict'; ${source}; return {
            tryPlayerActionFix,
            startApplePlayWatchdog,
            cancelApplePlayWatchdog,
            noteApplePlayEvent,
            consumeApplePlayRejection,
            isButtonOperable,
            setUserGestureAt: timestamp => { hcmLastUserGestureAt = timestamp; }
        };`
    )(
        fakeDocument,
        EVENTS,
        state => suppressed.push(state),
        (_video, targetTime) => seekCalls.push(targetTime),
        message => logs.push(message),
        scheduler
    );
    return { ...api, tryFix: api.tryPlayerActionFix, video, clicked, suppressed, seekCalls, logs, pendingTimers };
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
        const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'cmd1' });
        expect(result).toBeInstanceOf(Promise);
        expect(harness.clicked).toEqual([APPLE_PLAY_SELECTOR]);
        expect(harness.suppressed).toEqual(['playing']);
    });

    it('does not re-click Apple TV+ play while already playing', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: false });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'cmd2' })).toBe(true);
        expect(harness.clicked).toEqual([]);
        expect(harness.suppressed).toEqual([]);
    });

    it('drives Apple TV+ pause with the site pause button and suppresses the echo', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: false });
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null, { cmdId: 'cmd3' })).toBe(true);
        expect(harness.clicked).toEqual([APPLE_PAUSE_SELECTOR]);
        expect(harness.suppressed).toEqual(['paused']);
    });

    it('does not re-click Apple TV+ pause while already paused', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null, { cmdId: 'cmd4' })).toBe(true);
        expect(harness.clicked).toEqual([]);
        expect(harness.suppressed).toEqual([]);
    });

    it('logs a warning and falls through when the Apple TV+ buttons are missing', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: {}, paused: true });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'cmd5' })).toBe(false);
        expect(harness.tryFix(fix, EVENTS.PAUSE, harness.video, null, { cmdId: 'cmd6' })).toBe(false);
        expect(harness.clicked).toEqual([]);
        expect(harness.logs.filter(message => message.includes('control not found'))).toHaveLength(2);
    });

    it('keeps Apple TV+ seeking on the native path', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(fix, EVENTS.SEEK, harness.video, { targetTime: 12.5 }, { cmdId: 'cmd7' })).toBe(false);
        expect(harness.seekCalls).toEqual([]);
        expect(harness.clicked).toEqual([]);
    });

    it('keeps the YouTube toggle click for state changes only', () => {
        const fix = loadActivePlayerActionFix('www.youtube.com');
        const pausedHarness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: true
        });
        expect(pausedHarness.tryFix(fix, EVENTS.PLAY, pausedHarness.video, null, { cmdId: 'cmd8' })).toBe(true);
        expect(pausedHarness.clicked).toEqual(['.ytp-play-button']);
        expect(pausedHarness.suppressed).toEqual(['playing']);

        const playingHarness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: false
        });
        expect(playingHarness.tryFix(fix, EVENTS.PLAY, playingHarness.video, null, { cmdId: 'cmd9' })).toBe(true);
        expect(playingHarness.clicked).toEqual([]);
    });

    it('keeps YouTube seeking through the toggle fix', () => {
        const fix = loadActivePlayerActionFix('www.youtube.com');
        const harness = createTryFixHarness({
            buttons: { '.ytp-play-button': true },
            paused: true
        });
        expect(harness.tryFix(fix, EVENTS.SEEK, harness.video, { targetTime: 42 }, { cmdId: 'cmd10' })).toBe(true);
        expect(harness.seekCalls).toEqual([42]);
    });

    it('rejects a missing fix', () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        expect(harness.tryFix(null, EVENTS.PLAY, harness.video, null, { cmdId: 'cmd11' })).toBe(false);
    });

    it('still consults the player action fix before the native fallback', () => {
        const tryMediaAction = extractFunction(contentSource, 'tryMediaAction');
        expect(tryMediaAction.indexOf('tryPlayerActionFix(actionFix, action, video, data, meta)'))
            .toBeLessThan(tryMediaAction.indexOf('video.play()'));
    });

    it('blocks the native play fallback on separate-button platforms', () => {
        const tryMediaAction = extractFunction(contentSource, 'tryMediaAction');
        const skip = tryMediaAction.indexOf('native video.play() fallback skipped');
        expect(skip).toBeGreaterThan(-1);
        expect(skip).toBeLessThan(tryMediaAction.indexOf('video.play()'));
    });

    it('treats hidden, disabled, aria-disabled and rect-less buttons as not operable', () => {
        const harness = createTryFixHarness({});
        expect(harness.isButtonOperable({})).toBe(true);
        expect(harness.isButtonOperable(null)).toBe(false);
        expect(harness.isButtonOperable({ getClientRects: () => [] })).toBe(false);
        expect(harness.isButtonOperable({ disabled: true })).toBe(false);
        expect(harness.isButtonOperable({
            getAttribute: name => (name === 'aria-disabled' ? 'true' : null)
        })).toBe(false);
    });

    it('does not click an unoperable Apple TV+ play button', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const harness = createTryFixHarness({
            buttons: { [APPLE_PLAY_SELECTOR]: { getClientRects: () => [] } },
            paused: true
        });
        expect(harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'cmd12' })).toBe(false);
        expect(harness.clicked).toEqual([]);
        expect(harness.logs.some(message => message.includes('not operable'))).toBe(true);
    });
});

describe('Apple TV+ play watchdog', () => {
    const fix = loadActivePlayerActionFix('tv.apple.com');

    it('suppresses the auto-pause artifact and reports the start as unapplied when playback never started', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd1' });
            expect(result).toBeInstanceOf(Promise);
            expect(harness.clicked).toEqual([APPLE_PLAY_SELECTOR]);
            // The player rejects the start before playback begins.
            expect(harness.consumeApplePlayRejection(harness.video)).toBe(true);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await result).toBe(false);
            expect(harness.logs.some(message => message.includes('watchdog window closed: no_playback'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('confirms a delayed start when playing arrives after the pause artifact', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd2' });
            expect(harness.consumeApplePlayRejection(harness.video)).toBe(true);
            harness.video.paused = false;
            harness.noteApplePlayEvent(harness.video);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await result).toBe(true);
            expect(harness.logs.some(message => message.includes('watchdog window closed: confirmed'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not resolve before the observation window closes', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd3' });
            let settled = false;
            result.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(500);
            await Promise.resolve();
            expect(settled).toBe(false);
            harness.video.paused = false;
            harness.noteApplePlayEvent(harness.video);
            await vi.advanceTimersByTimeAsync(500);
            expect(await result).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('aborts a pending play when a newer command supersedes it', async () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd4' });
        expect(result).toBeInstanceOf(Promise);
        harness.cancelApplePlayWatchdog('superseded_by_command');
        expect(await result).toBe(false);
        // The window is over: a later pause is a normal relay, not an artifact.
        expect(harness.consumeApplePlayRejection(harness.video)).toBe(false);
    });

    it('relays a genuine user pause during the window and does not confirm the play', async () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd5' });
        // A gesture strictly after the dispatch (startedAt) counts as user input.
        harness.setUserGestureAt(Date.now() + 1);
        expect(harness.consumeApplePlayRejection(harness.video)).toBe(false);
        expect(await result).toBe(false);
    });

    it('counts the play as applied when the user pauses after playback started', async () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd6' });
        harness.video.paused = false;
        harness.noteApplePlayEvent(harness.video);
        harness.video.paused = true;
        // A gesture strictly after the dispatch (startedAt) counts as user input.
        harness.setUserGestureAt(Date.now() + 1);
        expect(harness.consumeApplePlayRejection(harness.video)).toBe(false);
        expect(await result).toBe(true);
    });
});
