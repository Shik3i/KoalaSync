import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
const providerSource = fs.readFileSync(path.join(extensionDir, 'page-api-seek-overrides.js'), 'utf8');

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

function createBridgeHarness({ sessionIds = ['watch-main'], players = {} } = {}) {
    const listeners = new Set();
    const posted = [];
    const fakeWindow = {
        location: { hostname: 'www.netflix.com' },
        koalaFindPageApiSeekProvider: () => ({
            provider: 'netflix',
            actions: ['play', 'pause', 'seek']
        }),
        netflix: {
            appContext: {
                state: {
                    playerApp: {
                        getAPI: () => ({
                            videoPlayer: {
                                getAllPlayerSessionIds: () => sessionIds,
                                getVideoPlayerBySessionId: id => players[id] || null
                            }
                        })
                    }
                }
            }
        },
        addEventListener(type, listener) {
            if (type === 'message') listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === 'message') listeners.delete(listener);
        },
        postMessage(data) {
            posted.push(data);
        }
    };
    const installSource = extractFunction(backgroundSource, 'installPageApiPlayerBridge');
    const install = Function(
        'window',
        'document',
        'setInterval',
        'clearInterval',
        `'use strict'; ${installSource}; return installPageApiPlayerBridge;`
    )(
        fakeWindow,
        { querySelector: () => null },
        () => 1,
        () => {}
    );
    install();
    return {
        fakeWindow,
        posted,
        dispatch(data) {
            for (const listener of [...listeners]) listener({ source: fakeWindow, data });
        }
    };
}

async function sendCommand(harness, action, time = null) {
    const requestId = `request-${action}`;
    harness.dispatch({
        __koalaPageApiPlayer: 1,
        kind: 'command',
        requestId,
        action,
        time
    });
    await vi.waitFor(() => {
        expect(harness.posted.some(message => message.kind === 'result' && message.requestId === requestId)).toBe(true);
    });
    return harness.posted.find(message => message.kind === 'result' && message.requestId === requestId);
}

describe('page API player bridge', () => {
    it('declares every Netflix write as bridge-only while Disney remains seek-only', () => {
        const root = {};
        vm.runInNewContext(providerSource, { globalThis: root, URL });
        expect(root.koalaFindPageApiSeekProvider('https://www.netflix.com/watch/1')).toMatchObject({
            provider: 'netflix',
            actions: ['play', 'pause', 'seek']
        });
        expect(root.koalaFindPageApiSeekProvider('www.disneyplus.com')).toMatchObject({
            provider: 'disney',
            actions: ['seek']
        });
    });

    it('prefers the Netflix watch session and confirms play, pause, and seek', async () => {
        const preview = { seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
        const player = { seek: vi.fn(), play: vi.fn(), pause: vi.fn() };
        const harness = createBridgeHarness({
            sessionIds: ['motion-billboard-1', 'watch-main'],
            players: { 'motion-billboard-1': preview, 'watch-main': player }
        });

        await expect(sendCommand(harness, 'seek', 12.345)).resolves.toMatchObject({ ok: true });
        await expect(sendCommand(harness, 'pause')).resolves.toMatchObject({ ok: true });
        await expect(sendCommand(harness, 'play')).resolves.toMatchObject({ ok: true });
        expect(player.seek).toHaveBeenCalledWith(12345);
        expect(player.pause).toHaveBeenCalledOnce();
        expect(player.play).toHaveBeenCalledOnce();
        expect(preview.seek).not.toHaveBeenCalled();
    });

    it('returns an explicit failure when the Netflix player is unavailable', async () => {
        const harness = createBridgeHarness({ sessionIds: ['watch-missing'], players: {} });
        await expect(sendCommand(harness, 'seek', 10)).resolves.toMatchObject({
            ok: false,
            reason: 'player_unavailable'
        });
    });

    it('keeps provider actions fail-closed and ACKs only applied remote commands', () => {
        const seekVideo = extractFunction(contentSource, 'seekVideo');
        const request = extractFunction(contentSource, 'requestPageApiAction');
        const remote = extractFunction(contentSource, 'applyServerMediaAction');
        expect(seekVideo.indexOf('pageApiActionRequired(EVENTS.SEEK)'))
            .toBeLessThan(seekVideo.indexOf('video.currentTime ='));
        expect(seekVideo).toContain('return requestPageApiAction(EVENTS.SEEK, targetTime)');
        expect(request).toContain('refusing unsafe native fallback');
        expect(remote.indexOf('if (!applied)')).toBeLessThan(remote.indexOf("type: 'CMD_ACK'"));
        expect(backgroundSource).toContain('target: { tabId },\n                    world: \'MAIN\'');
    });
});
