import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { EVENTS } from '../shared/constants.js';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

function extractBlock(source, declarationPrefix) {
    const start = source.indexOf(declarationPrefix);
    expect(start).toBeGreaterThan(-1);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}') depth--;
        if (depth === 0) {
            const tail = source[index + 1] === ';' ? index + 2 : index + 1;
            return source.slice(start, tail);
        }
    }
    throw new Error(`${declarationPrefix} body did not terminate`);
}

function extractFunction(source, name) {
    return extractBlock(source, `function ${name}(`);
}

function extractConstArrow(source, name) {
    return extractBlock(source, `const ${name} =`);
}

function extractWatchdogWindowDeclaration(source) {
    const match = source.match(/const APPLE_PLAY_WATCHDOG_WINDOW_MS = (\d+);/);
    expect(match).not.toBeNull();
    return {
        declaration: match[0],
        windowMs: Number(match[1])
    };
}

const {
    declaration: WATCHDOG_WINDOW_DECLARATION,
    windowMs: APPLE_PLAY_WATCHDOG_WINDOW_MS
} = extractWatchdogWindowDeclaration(contentSource);

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

function createTryFixHarness({
    hostname = 'tv.apple.com',
    buttons = {},
    paused = true,
    currentTime = 12,
    timers = 'recorded'
} = {}) {
    const clicked = [];
    const suppressed = [];
    const seekCalls = [];
    const logs = [];
    const pendingTimers = [];
    const relayedEvents = [];
    const runtimeMessages = [];
    let proactiveHeartbeats = 0;

    const makeButton = (selector, spec) => ({
        selector,
        ...(typeof spec === 'object' && spec ? spec : {}),
        click() {
            clicked.push(selector);
            if (typeof spec === 'object' && spec && typeof spec.onClick === 'function') {
                spec.onClick();
            }
        }
    });
    const fakeDocument = {
        querySelector(selector) {
            if (!buttons[selector]) return null;
            return makeButton(selector, buttons[selector]);
        }
    };
    const fakeWindow = { location: { hostname } };
    const listeners = new Map();
    const video = {
        paused,
        currentTime,
        isConnected: true,
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        dispatch(type) {
            const handler = listeners.get(type);
            if (handler) handler({ currentTarget: video });
        },
        play: vi.fn(() => Promise.resolve()),
        pause: vi.fn(() => {
            video.paused = true;
        })
    };

    const source = [
        WATCHDOG_WINDOW_DECLARATION,
        'let applePlayWatchdog = null;',
        'let hcmLastUserGestureAt = 0;',
        'let activeVideo = video;',
        'const lifecycleTimeouts = new Set();',
        'const _suppressTimers = { playing: null, paused: null, seek: null };',
        'function _setSuppress(state) { recordSuppress(state); if (_suppressTimers[state]) clearTimeout(_suppressTimers[state]); _suppressTimers[state] = scheduleSuppressTimeout(() => { _suppressTimers[state] = null; }, 300); }',
        'function _clearSuppress(state) { if (_suppressTimers[state]) { clearTimeout(_suppressTimers[state]); _suppressTimers[state] = null; } }',
        'function reportEvent(action) { const eventState = action === EVENTS.PLAY ? "playing" : (action === EVENTS.PAUSE ? "paused" : (action === EVENTS.SEEK ? "seek" : null)); if (eventState && _suppressTimers[eventState]) { _clearSuppress(eventState); return; } recordRelayedEvent(action); }',
        extractFunction(contentSource, 'hostMatchesUrl'),
        extractFunction(contentSource, 'matchesPlayerUrls'),
        extractFunction(contentSource, 'getPlayerActionFixes'),
        extractFunction(contentSource, 'getActivePlayerActionFix'),
        extractFunction(contentSource, 'newCorrelationId'),
        extractFunction(contentSource, 'sanitizeLogToken'),
        extractFunction(contentSource, 'isButtonOperable'),
        extractFunction(contentSource, 'cancelApplePlayWatchdog'),
        extractFunction(contentSource, 'startApplePlayWatchdog'),
        extractFunction(contentSource, 'noteApplePlayEvent'),
        extractFunction(contentSource, 'consumeApplePlayEcho'),
        extractFunction(contentSource, 'consumeApplePlayRejection'),
        extractFunction(contentSource, 'tryPlayerActionFix'),
        extractFunction(contentSource, 'tryMediaAction'),
        extractFunction(contentSource, 'applyServerMediaAction'),
        extractFunction(contentSource, 'isCurrentVideoEvent'),
        extractConstArrow(contentSource, 'handlePlay'),
        extractConstArrow(contentSource, 'handlePlaying'),
        extractConstArrow(contentSource, 'handlePause'),
        'video.addEventListener("play", handlePlay);',
        'video.addEventListener("playing", handlePlaying);',
        'video.addEventListener("pause", handlePause);'
    ].join('\n');

    const scheduler = timers === 'real'
        ? (callback, delay) => setTimeout(callback, delay)
        : (callback, delay) => {
            pendingTimers.push({ callback, delay });
            return pendingTimers.length;
        };

    const api = Function(
        'window',
        'document',
        'video',
        'EVENTS',
        'recordSuppress',
        'scheduleSuppressTimeout',
        'recordRelayedEvent',
        'findVideo',
        'getSyncCurrentTime',
        'pageApiActionRequired',
        'requestPageApiAction',
        'seekVideo',
        'reportLog',
        'runtimeMessage',
        'scheduleProactiveHeartbeat',
        'scheduleLifecycleTimeout',
        `'use strict'; ${source}; return {
            tryPlayerActionFix,
            tryMediaAction,
            applyServerMediaAction,
            startApplePlayWatchdog,
            cancelApplePlayWatchdog,
            noteApplePlayEvent,
            consumeApplePlayEcho,
            consumeApplePlayRejection,
            isButtonOperable,
            sanitizeLogToken,
            setUserGestureAt: timestamp => { hcmLastUserGestureAt = timestamp; }
        };`
    )(
        fakeWindow,
        fakeDocument,
        video,
        EVENTS,
        state => suppressed.push(state),
        scheduler,
        action => relayedEvents.push(action),
        () => (video.isConnected === false ? null : video),
        targetVideo => (Number.isFinite(targetVideo?.currentTime) ? targetVideo.currentTime : null),
        () => false,
        () => Promise.resolve(false),
        (_video, targetTime) => {
            seekCalls.push(targetTime);
            return true;
        },
        message => logs.push(message),
        payload => {
            runtimeMessages.push(payload);
            return Promise.resolve({ ok: true });
        },
        () => { proactiveHeartbeats++; },
        scheduler
    );

    return {
        ...api,
        tryFix: api.tryPlayerActionFix,
        video,
        clicked,
        suppressed,
        seekCalls,
        logs,
        pendingTimers,
        relayedEvents,
        runtimeMessages,
        getProactiveHeartbeats: () => proactiveHeartbeats
    };
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

    it('treats redundant Apple TV+ play/pause as applied even when the inactive control is hidden', () => {
        const fix = loadActivePlayerActionFix('tv.apple.com');
        const playingHarness = createTryFixHarness({
            buttons: {
                [APPLE_PLAY_SELECTOR]: { getClientRects: () => [] },
                [APPLE_PAUSE_SELECTOR]: true
            },
            paused: false
        });
        expect(playingHarness.tryFix(fix, EVENTS.PLAY, playingHarness.video, null, { cmdId: 'cmd2b' })).toBe(true);
        expect(playingHarness.clicked).toEqual([]);
        expect(playingHarness.logs.some(message => message.includes('not operable'))).toBe(false);

        const pausedHarness = createTryFixHarness({
            buttons: {
                [APPLE_PLAY_SELECTOR]: true,
                [APPLE_PAUSE_SELECTOR]: { getClientRects: () => [] }
            },
            paused: true
        });
        expect(pausedHarness.tryFix(fix, EVENTS.PAUSE, pausedHarness.video, null, { cmdId: 'cmd2c' })).toBe(true);
        expect(pausedHarness.clicked).toEqual([]);
        expect(pausedHarness.logs.some(message => message.includes('not operable'))).toBe(false);
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
            hostname: 'www.youtube.com',
            buttons: { '.ytp-play-button': true },
            paused: true
        });
        expect(pausedHarness.tryFix(fix, EVENTS.PLAY, pausedHarness.video, null, { cmdId: 'cmd8' })).toBe(true);
        expect(pausedHarness.clicked).toEqual(['.ytp-play-button']);
        expect(pausedHarness.suppressed).toEqual(['playing']);

        const playingHarness = createTryFixHarness({
            hostname: 'www.youtube.com',
            buttons: { '.ytp-play-button': true },
            paused: false
        });
        expect(playingHarness.tryFix(fix, EVENTS.PLAY, playingHarness.video, null, { cmdId: 'cmd9' })).toBe(true);
        expect(playingHarness.clicked).toEqual([]);
    });

    it('keeps YouTube seeking through the toggle fix', () => {
        const fix = loadActivePlayerActionFix('www.youtube.com');
        const harness = createTryFixHarness({
            hostname: 'www.youtube.com',
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
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS);
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
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS);
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
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS / 2);
            await Promise.resolve();
            expect(settled).toBe(false);
            harness.video.paused = false;
            harness.noteApplePlayEvent(harness.video);
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS / 2);
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

    it('suppresses both play and pre-playback rejection pause on the real listener path', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd7' });
            // HTML5 media spec: clicking play transitions paused->false and fires `play`,
            // then MediaKit rejects before `playing` and transitions back to paused, firing `pause`.
            harness.video.paused = false;
            harness.video.dispatch('play');
            harness.video.paused = true;
            harness.video.dispatch('pause');

            expect(harness.relayedEvents).toEqual([]);
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS);
            expect(await result).toBe(false);
            expect(harness.logs.some(message => message.includes('auto-pause artifact suppressed'))).toBe(true);
            expect(harness.logs.some(message => message.includes('watchdog window closed: no_playback'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('suppresses late programmatic play echoes after 300ms while relaying user-gesture play during the window', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd8' });

            // Advance past the 300ms _setSuppress('playing') window; a delayed programmatic
            // `play` event inside the 1000ms watchdog window must still be suppressed.
            await vi.advanceTimersByTimeAsync(400);
            harness.video.dispatch('play');
            expect(harness.relayedEvents).toEqual([]);

            // A user gesture strictly after dispatch cancels the watchdog and relays PLAY.
            harness.setUserGestureAt(Date.now() + 1);
            harness.video.dispatch('play');
            expect(harness.relayedEvents).toEqual([EVENTS.PLAY]);
            expect(await result).toBe(false);
            expect(harness.logs.some(message => message.includes('watchdog stopped (user_play_during_window)'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('relays a non-gesture pause after playing started and resolves false (ended_after_play) if still paused at window close', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });
            const result = harness.tryFix(fix, EVENTS.PLAY, harness.video, null, { cmdId: 'wd9' });

            harness.video.paused = false;
            harness.video.dispatch('play');
            harness.video.dispatch('playing');
            harness.video.paused = true;
            harness.video.dispatch('pause');

            expect(harness.relayedEvents).toEqual([EVENTS.PAUSE]);
            expect(harness.logs.some(message => message.includes('stop after confirmed playback - relaying'))).toBe(true);

            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS);
            expect(await result).toBe(false);
            expect(harness.logs.some(message => message.includes('watchdog window closed: ended_after_play'))).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('gates CMD_ACK in applyServerMediaAction on the Apple TV+ watchdog outcome and supersedes on newer commands', async () => {
        vi.useFakeTimers();
        try {
            const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true, timers: 'real' });

            // 1. Rejected remote PLAY -> no CMD_ACK sent.
            harness.applyServerMediaAction(
                EVENTS.PLAY,
                { targetTime: 12 },
                { actionTimestamp: 101, commandSenderId: 'peer-a' }
            );
            harness.video.paused = false;
            harness.video.dispatch('play');
            harness.video.paused = true;
            harness.video.dispatch('pause');
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS);
            await Promise.resolve();
            expect(harness.runtimeMessages).toEqual([]);
            expect(harness.logs.some(message => message.includes('Remote play was not applied'))).toBe(true);

            // 2. Confirmed remote PLAY -> CMD_ACK sent only after the watchdog window closes.
            harness.applyServerMediaAction(
                EVENTS.PLAY,
                { targetTime: 12 },
                { actionTimestamp: 102, commandSenderId: 'peer-b' }
            );
            harness.video.paused = false;
            harness.video.dispatch('play');
            harness.video.dispatch('playing');
            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS / 2);
            await Promise.resolve();
            expect(harness.runtimeMessages).toEqual([]);

            await vi.advanceTimersByTimeAsync(APPLE_PLAY_WATCHDOG_WINDOW_MS / 2);
            await Promise.resolve();
            expect(harness.runtimeMessages).toEqual([
                { type: 'CMD_ACK', actionTimestamp: 102, commandSenderId: 'peer-b' }
            ]);
            expect(harness.getProactiveHeartbeats()).toBe(1);

            // 3. In-flight remote PLAY superseded by a newer PAUSE command -> only PAUSE ACKs.
            harness.video.paused = true;
            harness.applyServerMediaAction(
                EVENTS.PLAY,
                { targetTime: 12 },
                { actionTimestamp: 103, commandSenderId: 'peer-c' }
            );
            harness.video.paused = false;
            harness.applyServerMediaAction(
                EVENTS.PAUSE,
                { targetTime: 12 },
                { actionTimestamp: 104, commandSenderId: 'peer-d' }
            );
            await Promise.resolve();
            await Promise.resolve();
            expect(harness.runtimeMessages).toEqual([
                { type: 'CMD_ACK', actionTimestamp: 102, commandSenderId: 'peer-b' },
                { type: 'CMD_ACK', actionTimestamp: 104, commandSenderId: 'peer-d' }
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending play watchdog when tryMediaAction executes a non-play action', async () => {
        const harness = createTryFixHarness({ buttons: APPLE_BUTTONS, paused: true });
        const playPromise = harness.tryMediaAction(EVENTS.PLAY, null, { cmdId: 'wd10' });
        expect(playPromise).toBeInstanceOf(Promise);
        harness.video.paused = false;
        expect(harness.tryMediaAction(EVENTS.PAUSE, null, { cmdId: 'wd11' })).toBe(true);
        expect(await playPromise).toBe(false);
        expect(harness.logs.some(message => message.includes('watchdog stopped (superseded_by_action)'))).toBe(true);
    });

    it('sanitizes untrusted command log tokens and formats unknown sync time as ?s', () => {
        const harness = createTryFixHarness({
            buttons: APPLE_BUTTONS,
            paused: false,
            currentTime: Number.NaN
        });
        harness.applyServerMediaAction(
            EVENTS.PLAY,
            {},
            { actionTimestamp: 'bad-ts', commandSenderId: 'peer\nwith\r\tinjection' }
        );
        const traceLog = harness.logs.find(message => message.includes('play from'));
        expect(traceLog).toBeDefined();
        expect(traceLog).toContain('from peer with injection (t=-) local=playing@?s');
        expect(traceLog).not.toMatch(/[\r\n\t]/);
    });

    it('keeps play/pause button state labels free of duplicate leading icon glyphs across all locales', () => {
        const localesDir = path.join(extensionDir, 'locales');
        const localeFiles = fs.readdirSync(localesDir).filter(file => file.endsWith('.json'));
        expect(localeFiles.length).toBeGreaterThan(0);

        for (const file of localeFiles) {
            const dict = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
            for (const key of ['BTN_PLAY', 'BTN_PAUSE', 'BTN_STATE_PLAYING', 'BTN_STATE_PAUSING']) {
                expect(dict[key], `${file}:${key}`).toBeTypeOf('string');
                expect(dict[key], `${file}:${key} should not prefix duplicate ▶/⏸ glyphs`).not.toMatch(/^[▶⏸]/u);
            }
        }
    });

    it('renders popup logs chronologically and auto-scrolls logList to the newest entry', async () => {
        const popupSource = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
        const refreshLogsCode = extractBlock(popupSource, 'async function refreshLogs(');
        const appended = [];
        const logList = {
            innerHTML: 'stale',
            scrollTop: 0,
            scrollHeight: 240,
            appendChild(node) {
                appended.push(node.textContent);
            }
        };
        const chromeMock = {
            runtime: {
                sendMessage(msg, cb) {
                    expect(msg).toEqual({ type: 'GET_LOGS' });
                    cb([
                        { timestamp: '2026-11-07T12:00:03.000Z', message: 'Newest entry', type: 'info' },
                        { timestamp: '2026-11-07T12:00:02.000Z', message: 'Middle entry', type: 'info' },
                        { timestamp: '2026-11-07T12:00:01.000Z', message: 'Oldest entry', type: 'info' }
                    ]);
                }
            }
        };
        const documentMock = {
            createElement() {
                return { className: '', textContent: '' };
            }
        };
        const runRefreshLogs = new Function(
            'chrome',
            'document',
            'elements',
            'renderEmpty',
            `"use strict";\n${refreshLogsCode}\nreturn refreshLogs();`
        );

        await runRefreshLogs(chromeMock, documentMock, { logList }, vi.fn());

        expect(appended).toEqual([
            '[12:00:01] Oldest entry',
            '[12:00:02] Middle entry',
            '[12:00:03] Newest entry'
        ]);
        expect(logList.scrollTop).toBe(240);
    });
});
