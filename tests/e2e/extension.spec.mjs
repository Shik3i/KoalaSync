import { test, expect } from './helpers/extension-fixture.mjs';

/**
 * Drives the packed extension itself: real background service worker, real
 * chrome.scripting injection, real runtime messaging. The detection specs cover
 * which element gets picked; this file covers whether the extension ever gets
 * far enough to pick one.
 */

/** Runs code in an extension page, where the privileged chrome.* APIs exist. */
async function withExtensionPage(context, extensionId, fn) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await fn(page);
    await page.close();
    return result;
}

async function selectTargetTab(context, extensionId, pageUrl) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error(`no tab matched ${url}`);
        const response = await chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: tab.id });
        return { tabId: tab.id, response };
    }, pageUrl));
}

async function sendServerCommand(context, extensionId, tabId, action, payload) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async ({ tabId, action, payload }) => {
        return chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: payload || {},
            expectedTabId: tabId
        });
    }, { tabId, action, payload }));
}

async function sendServerCommandBurst(context, extensionId, tabId, commands) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async ({ tabId, commands }) => {
        return Promise.all(commands.map(({ action, payload }) => chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: payload || {},
            expectedTabId: tabId
        })));
    }, { tabId, commands }));
}

async function getExtensionState(context, extensionId, message) {
    return withExtensionPage(context, extensionId, page => page.evaluate(
        request => chrome.runtime.sendMessage(request),
        message
    ));
}

async function setAudioSettings(context, extensionId, settings) {
    return withExtensionPage(context, extensionId, page => page.evaluate(
        value => chrome.storage.local.set({ audioSettings: value }),
        settings
    ));
}

async function getAudioRouteState(context, extensionId, pageUrl) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async url => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error(`no tab matched ${url}`);
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const route = window.__koalaSyncAudioRoute;
                if (!route) {
                    return {
                        hasRoute: false,
                        contextState: null,
                        chainActive: null,
                        hasVideo: false,
                        signalLevel: 0
                    };
                }
                let analyser = route.testAnalyser;
                if (!analyser) {
                    analyser = route.audioCtx.createAnalyser();
                    analyser.fftSize = 32;
                    route.chain.limiter.connect(analyser);
                    route.testAnalyser = analyser;
                }
                if (!route.testSignal) {
                    const oscillator = route.audioCtx.createOscillator();
                    const gain = route.audioCtx.createGain();
                    gain.gain.value = 0.05;
                    oscillator.frequency.value = 440;
                    oscillator.connect(gain);
                    gain.connect(route.chain.limiter);
                    oscillator.start();
                    route.testSignal = { oscillator, gain };
                }
                const samples = new Uint8Array(analyser.fftSize);
                analyser.getByteTimeDomainData(samples);
                return {
                    hasRoute: true,
                    contextState: route.audioCtx?.state || null,
                    chainActive: route.chain?.active ?? null,
                    hasVideo: !!route.video,
                    signalLevel: Math.max(...Array.from(samples, sample => Math.abs(sample - 128)))
                };
            }
        });
        return result?.result || null;
    }, pageUrl));
}

async function getFrameMonitorState(context, extensionId, pageUrl, frameUrlPart) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async ({ pageUrl, frameUrlPart }) => {
        const [tab] = await chrome.tabs.query({ url: pageUrl });
        if (!tab) throw new Error(`no tab matched ${pageUrl}`);
        const frameResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => ({ href: location.href, cleanup: typeof window.__koalaMediaFrameMonitorCleanup })
        });
        const frame = frameResults.find(candidate => candidate.result?.href.includes(frameUrlPart));
        if (!frame) throw new Error(`no frame matched ${frameUrlPart}`);
        const target = frame.documentId
            ? { tabId: tab.id, documentIds: [frame.documentId] }
            : { tabId: tab.id, frameIds: [frame.frameId] };
        const [result] = await chrome.scripting.executeScript({
            target,
            func: () => typeof window.__koalaMediaFrameMonitorCleanup
        });
        return result?.result;
    }, { pageUrl, frameUrlPart }));
}

test('injects into the target tab and attaches to a same-origin frame player', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/iframe-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { response } = await selectTargetTab(context, extensionId, url);
    expect(response?.status, 'SET_TARGET_TAB should not report a failure').not.toBe('error');

    await expect.poll(
        () => page.evaluate(() => {
            const video = document.querySelector('iframe').contentDocument.querySelector('video');
            return video ? video.dataset.koalaAttached : null;
        }),
        { message: 'content script should attach to the video inside the frame' }
    ).toBe('true');
});

test('keeps the selected tab after the popup page closes and reopens', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });

    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: tabId,
        targetReady: true,
        targetActivationState: 'ready'
    });
});

test('keeps a selected target even when the page has no video element', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/no-video.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', tabId });

    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: tabId,
        targetReady: true,
        targetActivationState: 'ready',
        targetHasVideo: false
    });
});

test('keeps a previously selected player audible after switching targets', async ({ context, extensionId, baseURL }) => {
    const firstUrl = `${baseURL}/pages/simple-player.html`;
    const secondUrl = `${baseURL}/pages/no-video.html`;
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(firstUrl);
    await first.waitForFunction(() => window.__fixtureReady === true);
    await second.goto(secondUrl);
    await second.waitForFunction(() => window.__fixtureReady === true);

    await setAudioSettings(context, extensionId, {
        enabled: true,
        boostDb: 1,
        compressor: { enabled: false, preset: 'recommended', customParams: {} }
    });
    const { tabId: firstTabId } = await selectTargetTab(context, extensionId, firstUrl);
    await first.evaluate(() => document.getElementById('player').play());
    await expect.poll(
        () => getAudioRouteState(context, extensionId, firstUrl),
        { message: 'the selected player must have a live audio route' }
    ).toMatchObject({ hasRoute: true, contextState: 'running', hasVideo: true });
    await expect.poll(
        () => getAudioRouteState(context, extensionId, firstUrl).then(state => state?.signalLevel || 0),
        { message: 'the selected player must produce a signal through the audio route' }
    ).toBeGreaterThan(1);

    const { response } = await selectTargetTab(context, extensionId, secondUrl);
    expect(response).toMatchObject({ status: 'ok' });
    await first.evaluate(() => document.getElementById('player').play());
    await expect.poll(() => first.locator('#player').evaluate(video => ({
        paused: video.paused,
        muted: video.muted,
        volume: video.volume
    }))).toMatchObject({ paused: false, muted: false });
    await expect.poll(
        () => getAudioRouteState(context, extensionId, firstUrl).then(state => state?.signalLevel || 0),
        { message: 'switching targets must not mute the previous audio route' }
    ).toBeGreaterThan(1);

    await selectTargetTab(context, extensionId, firstUrl);
    await expect.poll(
        () => getAudioRouteState(context, extensionId, firstUrl),
        { message: 'reselecting the player must reuse its live audio route' }
    ).toMatchObject({ hasRoute: true, contextState: 'running', hasVideo: true });
    await expect.poll(
        () => getAudioRouteState(context, extensionId, firstUrl).then(state => state?.signalLevel || 0),
        { message: 'reselecting the player must keep the audio signal alive' }
    ).toBeGreaterThan(1);
    const playResponse = await sendServerCommand(context, extensionId, firstTabId, 'play');
    expect(playResponse).toMatchObject({ status: 'ok_solo' });
    await expect.poll(() => first.locator('#player').evaluate(video => video.paused)).toBe(false);
});

test('applies remote play, pause and seek to the framed player', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/iframe-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId } = await selectTargetTab(context, extensionId, url);
    await expect.poll(() => page.evaluate(() => {
        const video = document.querySelector('iframe').contentDocument.querySelector('video');
        return video ? video.dataset.koalaAttached : null;
    })).toBe('true');

    const playResponse = await sendServerCommand(context, extensionId, tabId, 'play');
    expect(playResponse).toMatchObject({ status: 'ok_solo' });
    await expect.poll(() => page.evaluate(FRAMED_VIDEO_PAUSED), { message: 'remote play should start playback' }).toBe(false);

    await sendServerCommand(context, extensionId, tabId, 'pause');
    await expect.poll(() => page.evaluate(FRAMED_VIDEO_PAUSED), { message: 'remote pause should stop playback' }).toBe(true);

    await sendServerCommand(context, extensionId, tabId, 'seek', { targetTime: 6 });
    await expect.poll(
        () => page.evaluate(() => document.querySelector('iframe').contentDocument.querySelector('video').currentTime),
        { message: 'remote seek should move the framed player' }
    ).toBeGreaterThan(5);
});

test('reinjects after the target tab navigates', async ({ context, extensionId, baseURL }) => {
    const first = `${baseURL}/pages/iframe-player.html`;
    const page = await context.newPage();
    await page.goto(first);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await selectTargetTab(context, extensionId, first);
    await expect.poll(() => page.evaluate(() => {
        const video = document.querySelector('iframe').contentDocument.querySelector('video');
        return video ? video.dataset.koalaAttached : null;
    })).toBe('true');

    await page.goto(`${baseURL}/pages/simple-player.html`);
    await page.waitForFunction(() => window.__fixtureReady === true);

    await expect.poll(
        () => page.evaluate(() => {
            const video = document.getElementById('player');
            return video ? video.dataset.koalaAttached : null;
        }),
        { message: 'the content script should come back after a navigation' }
    ).toBe('true');
});

test('re-attaches after the player frame swaps its document', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/reloading-frame.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await selectTargetTab(context, extensionId, url);

    await expect.poll(() => page.evaluate(() => {
        const video = document.querySelector('iframe').contentDocument.getElementById('framed-player');
        return video ? video.dataset.koalaAttached : null;
    })).toBe('true');

    // Navigating the frame replaces its document without touching the top one,
    // so nothing but a load hook on the frame can notice the new player.
    await page.evaluate(() => {
        document.querySelector('iframe').src = 'frames/player-frame-2.html';
    });

    await expect.poll(
        () => page.evaluate(() => {
            const video = document.querySelector('iframe').contentDocument.getElementById('framed-player-2');
            return video ? video.dataset.koalaAttached : null;
        }),
        { message: 'the content script should follow the frame to its new document' }
    ).toBe('true');
});

test('re-attaches when a nested player frame swaps its document', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/nested-frame.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await selectTargetTab(context, extensionId, url);

    const innerVideo = (id) => page.evaluate((videoId) => {
        const outer = document.querySelector('iframe').contentDocument;
        const inner = outer.querySelector('iframe').contentDocument;
        const video = inner.getElementById(videoId);
        return video ? video.dataset.koalaAttached : null;
    }, id);

    await expect.poll(() => innerVideo('framed-player')).toBe('true');

    // The reloading frame sits at depth two. A load hook that only covers
    // top-level frames would never fire for it.
    await page.evaluate(() => {
        const outer = document.querySelector('iframe').contentDocument;
        outer.querySelector('iframe').src = 'player-frame-2.html';
    });

    await expect.poll(
        () => innerVideo('framed-player-2'),
        { message: 'a frame two levels down should be watched for reloads too' }
    ).toBe('true');
});

test('moves local event listeners after a CSS-only player switch', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/player-css-switch.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    await selectTargetTab(context, extensionId, url);

    await expect.poll(() => page.locator('#first').getAttribute('data-koala-attached')).toBe('true');
    await page.waitForTimeout(250);
    const beforeBurst = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    await page.evaluate(() => {
        const first = document.getElementById('first');
        first.dispatchEvent(new window.Event('play'));
        first.dispatchEvent(new window.Event('pause'));
        window.switchPlayer();
    });
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.lastActionState.action === 'play'
            && status.lastActionState.timestamp > beforeBurst.lastActionState.timestamp;
    }).toBe(true);
    const leading = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    await expect.poll(
        () => page.locator('#second').getAttribute('data-koala-attached'),
        { message: 'attribute-only visibility changes must move the active controller' }
    ).toBe('true');
    expect(await page.locator('#first').getAttribute('data-koala-attached')).toBeNull();
    const afterSwitch = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(afterSwitch.lastActionState.action).toBe('play');
    expect(afterSwitch.lastActionState.timestamp).toBe(leading.lastActionState.timestamp);

    const before = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    await page.locator('#first').evaluate(video => video.dispatchEvent(new window.Event('play')));
    await page.waitForTimeout(250);
    const afterStale = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(afterStale.lastActionState.timestamp).toBe(before.lastActionState.timestamp);

    await page.locator('#second').evaluate(video => video.dispatchEvent(new window.Event('play')));
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.lastActionState.timestamp;
    }).toBeGreaterThan(afterStale.lastActionState.timestamp);
});

test('re-elects after a wrapper-only change inside an unselected cross-origin frame', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-internal-switching.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const first = page.frames().find(frame => frame.url().includes('slot=first'));
    const second = page.frames().find(frame => frame.url().includes('slot=second'));
    await selectTargetTab(context, extensionId, url);

    await expect.poll(() => first.locator('video').getAttribute('data-koala-attached')).toBe('true');
    expect(await second.locator('video').getAttribute('data-koala-attached')).toBeNull();
    await page.evaluate(() => window.switchInternalPlayer());
    await expect.poll(
        () => second.locator('video').getAttribute('data-koala-attached'),
        { message: 'an unselected frame must announce its internally-visible player' }
    ).toBe('true');
    expect(await first.locator('video').getAttribute('data-koala-attached')).toBeNull();
});

test('targets a visible nested cross-origin player and keeps top-page debug context', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-nested.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const visiblePlayer = () => page.frames().find(frame => frame.url().includes('/frames/player-frame.html?visible=1'));
    await expect.poll(async () => visiblePlayer()?.locator('video').getAttribute('src')).toContain('player-480p-12s.mp4');

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });
    expect(response.frameId).toBeGreaterThan(0);

    await expect.poll(() => visiblePlayer()?.locator('video').getAttribute('data-koala-attached')).toBe('true');
    const hiddenPlayer = page.frames().find(frame => frame.url().includes('/frames/player-frame-2.html?hidden=1'));
    expect(await hiddenPlayer.locator('video').getAttribute('data-koala-attached')).toBeNull();

    const playResponse = await sendServerCommand(context, extensionId, tabId, 'play');
    expect(playResponse).toMatchObject({ status: 'ok_solo' });
    await expect.poll(() => visiblePlayer().locator('video').evaluate(video => video.paused)).toBe(false);
    await sendServerCommand(context, extensionId, tabId, 'pause');
    await expect.poll(() => visiblePlayer().locator('video').evaluate(video => video.paused)).toBe(true);
    await sendServerCommand(context, extensionId, tabId, 'seek', { targetTime: 6 });
    await expect.poll(() => visiblePlayer().locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(5);

    await sendServerCommand(context, extensionId, tabId, 'pause');
    await sendServerCommandBurst(context, extensionId, tabId, [
        { action: 'seek', payload: { targetTime: 8 } },
        { action: 'play', payload: { currentTime: 8 } }
    ]);
    await expect.poll(() => visiblePlayer().locator('video').evaluate(video => ({
        paused: video.paused,
        currentTime: video.currentTime
    }))).toMatchObject({ paused: false, currentTime: expect.any(Number) });
    await expect.poll(() => visiblePlayer().locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(7);

    const state = await getExtensionState(context, extensionId, { type: 'GET_VIDEO_STATE', tabId });
    expect(state).toMatchObject({
        found: true,
        url,
        pageTitle: 'Nested cross-origin player',
        frameOrigin: new URL(baseURL.replace('localhost', '127.0.0.1')).origin,
        inIframe: true
    });
});

test('re-elects the visible cross-origin player after an iframe switch', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-switching.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const first = page.frames().find(frame => frame.url().includes('/frames/player-frame.html?slot=first'));
    const second = page.frames().find(frame => frame.url().includes('/frames/player-frame-2.html?slot=second'));
    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });
    const firstFrameId = response.frameId;

    await expect.poll(() => first.locator('video').getAttribute('data-koala-attached')).toBe('true');
    await page.evaluate(() => window.switchPlayer());
    await expect.poll(() => second.locator('video').getAttribute('data-koala-attached')).toBe('true');
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.targetFrameId;
    }).not.toBe(firstFrameId);

    const playResponse = await sendServerCommand(context, extensionId, tabId, 'play');
    expect(playResponse).toMatchObject({ status: 'ok_solo' });
    await expect.poll(() => second.locator('video').evaluate(video => video.paused)).toBe(false);
    expect(await first.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('immediately adopts and syncs when switching mirrors while first mirror was active and playing', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-switching.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const first = page.frames().find(frame => frame.url().includes('/frames/player-frame.html?slot=first'));
    const second = page.frames().find(frame => frame.url().includes('/frames/player-frame-2.html?slot=second'));
    const { tabId } = await selectTargetTab(context, extensionId, url);

    await expect.poll(() => first.locator('video').getAttribute('data-koala-attached')).toBe('true');
    await sendServerCommand(context, extensionId, tabId, 'play');
    await expect.poll(() => first.locator('video').evaluate(video => !video.paused)).toBe(true);

    const firstStatus = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(firstStatus.targetHasVideo).toBe(true);

    // Switch mirror and play second video directly in the new frame
    await page.evaluate(() => window.switchPlayer());
    await second.locator('video').evaluate(video => video.play());

    // Should immediately adopt the second mirror
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.targetFrameId;
    }).not.toBe(firstStatus.targetFrameId);

    // Commands must now control the second frame without delay
    await sendServerCommand(context, extensionId, tabId, 'pause');
    await expect.poll(() => second.locator('video').evaluate(video => video.paused)).toBe(true);
});

test('keeps commands flowing during continuous player-frame geometry changes', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-switching.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const first = page.frames().find(frame => frame.url().includes('/frames/player-frame.html?slot=first'));
    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });
    await expect.poll(() => first.locator('video').getAttribute('data-koala-attached')).toBe('true');

    await page.evaluate(() => window.startGeometryChurn());
    try {
        await page.waitForTimeout(300);
        await sendServerCommand(context, extensionId, tabId, 'play', { currentTime: 1 });
        await expect.poll(
            () => first.locator('video').evaluate(video => video.paused),
            { timeout: 3000, message: 'bounded refresh passes must not starve commands' }
        ).toBe(false);
    } finally {
        await page.evaluate(() => window.stopGeometryChurn());
    }
});

test('deactivates media monitors in child frames after a target-tab switch', async ({ context, extensionId, baseURL }) => {
    const firstUrl = `${baseURL}/pages/cross-origin-nested.html`;
    const secondUrl = `${baseURL}/pages/simple-player.html`;
    const firstPage = await context.newPage();
    const secondPage = await context.newPage();
    await firstPage.goto(firstUrl);
    await firstPage.waitForFunction(() => window.__fixtureReady === true);
    await secondPage.goto(secondUrl);
    await secondPage.waitForFunction(() => window.__fixtureReady === true);
    await selectTargetTab(context, extensionId, firstUrl);
    await expect.poll(() => getFrameMonitorState(
        context,
        extensionId,
        firstUrl,
        '/frames/player-frame.html?visible=1'
    )).toBe('function');
    await selectTargetTab(context, extensionId, secondUrl);
    await expect.poll(
        () => getFrameMonitorState(
            context,
            extensionId,
            firstUrl,
            '/frames/player-frame.html?visible=1'
        ),
        { message: 'child-frame monitor should be destroyed with the old target tab' }
    ).toBe('undefined');
});

test('re-attaches after a selected cross-origin frame navigates', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-reloading.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const first = page.frames().find(frame => frame.url().includes('generation=first'));
    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });
    await expect.poll(() => first.locator('video').getAttribute('data-koala-attached')).toBe('true');
    const firstDocumentId = (await getExtensionState(context, extensionId, { type: 'GET_STATUS' })).targetDocumentId;

    await page.evaluate(() => window.reloadPlayer());
    await expect.poll(() => page.frames().find(frame => frame.url().includes('generation=second'))?.locator('video').getAttribute('data-koala-attached')).toBe('true');
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.targetDocumentId;
    }).not.toBe(firstDocumentId);

    const state = await getExtensionState(context, extensionId, { type: 'GET_VIDEO_STATE', tabId });
    expect(state).toMatchObject({ found: true, inIframe: true });
});

test('discovers a video inserted late inside a cross-origin frame', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/cross-origin-late.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const lateFrame = page.frames().find(frame => frame.url().includes('/frames/late-player-frame.html'));
    const { response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', hasVideo: false });

    await expect.poll(
        () => lateFrame.locator('#late-player').getAttribute('data-koala-attached'),
        { timeout: 12_000, message: 'late cross-origin video should trigger target re-election' }
    ).toBe('true');
    await expect.poll(async () => {
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        return status.targetHasVideo;
    }).toBe(true);
});

test('rejects a cross-origin player hidden three frame levels deep', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/deep-hidden-cross-origin.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const hiddenFrame = page.frames().find(frame => frame.url().includes('deep=hidden'));
    await expect.poll(() => hiddenFrame?.locator('video').getAttribute('src')).toContain('player-1080p-30s.mp4');

    const { response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', frameId: 0, hasVideo: false });
    expect(await hiddenFrame.locator('video').getAttribute('data-koala-attached')).toBeNull();
});

test('rejects a player inside a hidden same-origin frame', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/hidden-same-origin.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const hiddenFrame = page.frames().find(frame => frame.url().includes('hidden=same-origin'));
    await expect.poll(() => hiddenFrame?.locator('video').getAttribute('src')).toContain('player-480p-12s.mp4');

    const { response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', frameId: 0, hasVideo: false });
    expect(await hiddenFrame.locator('video').getAttribute('data-koala-attached')).toBeNull();
});

test('rejects a hidden cross-origin player after its iframe URL redirects', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/hidden-redirect-cross-origin.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);
    const redirectedFrame = page.frames().find(frame => frame.url().includes('redirected=hidden'));
    await expect.poll(() => redirectedFrame?.locator('video').getAttribute('src')).toContain('player-1080p-30s.mp4');

    const { response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', frameId: 0, hasVideo: false });
    expect(await redirectedFrame.locator('video').getAttribute('data-koala-attached')).toBeNull();
});

test('selects the visible anime player nested behind a same-origin wrapper', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/yummy-style-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', hasVideo: true });
    expect(response.frameId).not.toBe(0);

    // The playable element is the one inside the visible wrapper. The two
    // zero-sized mirrors must be ignored, not treated as equal candidates.
    const playerFrame = suffix => page.frames()
        .find(frame => frame.url().endsWith(`/frames/${suffix}`));
    await expect
        .poll(() => playerFrame('player-frame.html').locator('video').getAttribute('data-koala-attached'))
        .toBe('true');
    expect(await playerFrame('player-frame-2.html').locator('video')
        .getAttribute('data-koala-attached')).toBeNull();

    // And the selection has to settle, not keep re-resolving.
    await page.waitForTimeout(1500);
    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: tabId,
        targetReady: true,
        targetActivationState: 'ready'
    });
});

test('selects an anime tab before playback and promotes the player once it appears', async ({ context, extensionId, baseURL }) => {
    // The live case: at selection time the page has no video anywhere, because
    // the host only builds the player when the viewer presses play.
    const url = `${baseURL}/pages/yummy-deferred-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    // Selecting must succeed and settle even with nothing to control yet.
    expect(response).toMatchObject({ status: 'ok', frameId: 0, hasVideo: false });

    await page.waitForTimeout(1200);
    const idle = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(idle).toMatchObject({
        targetTabId: tabId,
        targetReady: true,
        targetActivationState: 'ready'
    });

    const deferred = page.frames().find(frame => frame.url().endsWith('/frames/deferred-player-frame.html'));
    await deferred.locator('#poster').click();

    // The monitor has to hand the target over to the frame that now owns the
    // video, without the user touching the popup again.
    await expect
        .poll(() => deferred.locator('video').getAttribute('data-koala-attached'), { timeout: 15000 })
        .toBe('true');
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => ({ ready: state.targetReady, frame: state.targetFrameId })), { timeout: 15000 })
        .toMatchObject({ ready: true });
    const promoted = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(promoted.targetFrameId).not.toBe(0);
    expect(promoted).toMatchObject({ targetTabId: tabId, targetActivationState: 'ready' });
});

test('polling video state on a page with no video does not restart the target', async ({ context, extensionId, baseURL }) => {
    // The dev panel polls GET_VIDEO_STATE on a timer. On an anime page the
    // answer is legitimately "no video" until playback starts, and treating
    // that as a broken injection reactivated the target on every poll — which
    // is what pinned the popup on "activating" forever.
    const url = `${baseURL}/pages/yummy-deferred-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId } = await selectTargetTab(context, extensionId, url);

    for (let poll = 0; poll < 6; poll++) {
        const state = await getExtensionState(context, extensionId, { type: 'GET_VIDEO_STATE', tabId });
        expect(state?.error, 'reading video state must not report a target change').toBeFalsy();
        expect(state).toMatchObject({ found: false });
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        expect(status, `poll ${poll} must leave the target ready`).toMatchObject({
            targetTabId: tabId,
            targetReady: true,
            targetActivationState: 'ready'
        });
    }

    // And the player is still picked up once it exists.
    const deferred = page.frames().find(frame => frame.url().endsWith('/frames/deferred-player-frame.html'));
    await deferred.locator('#poster').click();
    await expect
        .poll(() => deferred.locator('video').getAttribute('data-koala-attached'), { timeout: 15000 })
        .toBe('true');
});

test('@race stays ready on a page whose ad frames keep mutating', async ({ context, extensionId, baseURL }) => {
    test.setTimeout(90000);
    // Live ad churn wakes the media-frame monitor several times a second. Each
    // wake used to schedule a trailing refresh that rebuilt the target
    // unconditionally, and rebuilding produced more churn — a loop that never
    // let the activation settle and pinned the popup on "activating".
    const url = `${baseURL}/pages/yummy-churning-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId } = await selectTargetTab(context, extensionId, url);

    for (let sample = 0; sample < 8; sample++) {
        await page.waitForTimeout(700);
        const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
        expect(status, `sample ${sample} must not be stuck activating`).toMatchObject({
            targetTabId: tabId,
            targetReady: true,
            targetActivationState: 'ready'
        });
    }

    // The player still has to be picked up while the churn continues.
    const deferred = page.frames().find(frame => frame.url().endsWith('/frames/deferred-player-frame.html'));
    await deferred.locator('#poster').click();
    await expect
        .poll(() => deferred.locator('video').getAttribute('data-koala-attached'), { timeout: 20000 })
        .toBe('true');
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => state.targetActivationState), { timeout: 20000 })
        .toBe('ready');
});

test('controls and adopts a nested player even while the top frame is elected', async ({ context, extensionId, baseURL }) => {
    // The failure mode reported from the live site: the election names the top
    // frame, which holds no video, so commands go nowhere and the user's own
    // play/pause from the real player frame is discarded as a stale sender.
    const url = `${baseURL}/pages/yummy-deferred-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok', frameId: 0, hasVideo: false });

    // Build the player without giving the monitor a chance to promote first.
    const deferred = page.frames().find(frame => frame.url().endsWith('/frames/deferred-player-frame.html'));
    await deferred.locator('#poster').click();
    await expect.poll(() => deferred.locator('video').count()).toBe(1);

    // A command must reach the frame that owns the video regardless of election.
    await sendServerCommand(context, extensionId, tabId, 'play', { time: 1 });
    await expect
        .poll(() => deferred.locator('video').evaluate(video => video.paused), { timeout: 15000 })
        .toBe(false);

    // And once that frame reports playback, it becomes the addressed target.
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => state.targetFrameId), { timeout: 15000 })
        .not.toBe(0);
    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({ targetTabId: tabId, targetHasVideo: true });
});

test('recovers when the adopted player frame is torn down and rebuilt', async ({ context, extensionId, baseURL }) => {
    test.setTimeout(90000);
    // Kodik rebuilds its player frame on quality and part changes, which kills
    // the documentId the election is pinned to. The election has to be given up,
    // otherwise every later message fails with "Receiving end does not exist"
    // and nothing moves the target back.
    const url = `${baseURL}/pages/yummy-deferred-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId } = await selectTargetTab(context, extensionId, url);
    // After the rebuild both the detached and the live frame carry the same URL,
    // so take the most recent attached one or the test drives a dead document.
    const deferredFrame = () => page.frames()
        .filter(frame => !frame.isDetached()
            && frame.url().endsWith('/frames/deferred-player-frame.html'))
        .pop();

    await deferredFrame().locator('#poster').click();
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => state.targetHasVideo), { timeout: 20000 })
        .toBe(true);
    const adoptedFrameId = (await getExtensionState(context, extensionId, { type: 'GET_STATUS' })).targetFrameId;
    expect(adoptedFrameId).not.toBe(0);

    // Destroy the elected document the way the real player does.
    const wrapper = page.frames().find(frame => frame.url().includes('xfp-wrapper.html?player=deferred'));
    await wrapper.evaluate(() => {
        const inner = document.getElementById('inner');
        inner.src = inner.src;
    });
    await expect.poll(() => deferredFrame()?.locator('#poster').count().catch(() => 0)).toBe(1);

    // The dead election must be released rather than kept forever.
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_VIDEO_STATE', tabId })
            .then(state => state?.error || null), { timeout: 20000 })
        .toBeNull();
    const released = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(released).toMatchObject({ targetTabId: tabId, targetHasVideo: false });

    // And the rebuilt player is picked up again without touching the popup. The
    // rebuilt document wires its poster from an inline script, so a click can
    // land before the handler exists — retry until the player is really built.
    await expect.poll(async () => {
        const frame = deferredFrame();
        if (!frame) return 0;
        if (await frame.locator('video').count() > 0) return 1;
        await frame.locator('#poster').click({ timeout: 2000 }).catch(() => {});
        return 0;
    }, { timeout: 20000 }).toBe(1);
    await expect
        .poll(() => deferredFrame().locator('video').getAttribute('data-koala-attached'), { timeout: 20000 })
        .toBe('true');
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => state.targetHasVideo), { timeout: 20000 })
        .toBe(true);
});

test('keeps the tab selected when its activation fails', async ({ context, extensionId }) => {
    // A page the extension is not allowed to script stands in for any activation
    // failure the user can act on. Losing the selection here is what made the
    // popup come back empty after it was closed and reopened.
    const page = await context.newPage();
    await page.goto('chrome://version');

    const { tabId, response } = await selectTargetTab(context, extensionId, 'chrome://version/*');
    expect(response?.status).not.toBe('ok');

    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: tabId,
        targetReady: false,
        targetActivationState: 'error'
    });
    expect(status.targetActivationError).toBeTruthy();

    // Reopening the popup must not quietly retry and must not lose the choice.
    const second = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(second).toMatchObject({ targetTabId: tabId, targetActivationState: 'error' });
});

test('drops the selection only when the user clears it', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId } = await selectTargetTab(context, extensionId, url);
    await expect
        .poll(() => getExtensionState(context, extensionId, { type: 'GET_STATUS' })
            .then(state => state.targetTabId))
        .toBe(tabId);

    const cleared = await getExtensionState(context, extensionId, {
        type: 'SET_TARGET_TAB',
        tabId: null
    });
    expect(cleared).toMatchObject({ status: 'ok', tabId: null });

    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: null,
        targetReady: false,
        targetActivationState: 'none'
    });
});

/**
 * Reads one global from the top document and from the player frame separately,
 * so a test can prove which frame a script was installed in.
 */
async function readPerFrameGlobal(context, extensionId, pageUrl, globalName) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async ({ pageUrl, globalName }) => {
        const [tab] = await chrome.tabs.query({ url: pageUrl });
        if (!tab) throw new Error(`no tab matched ${pageUrl}`);
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: name => ({
                href: location.href,
                isTop: window.top === window,
                present: typeof window[name] !== 'undefined' && window[name] !== null
            }),
            args: [globalName]
        });
        const entries = results.map(entry => entry.result).filter(Boolean);
        return {
            top: entries.find(entry => entry.isTop)?.present ?? null,
            player: entries.find(entry => !entry.isTop && entry.href.includes('player-frame'))?.present ?? null
        };
    }, { pageUrl, globalName }));
}

test('controls a Drive-style cross-origin player without moving the chat into it', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/drive-style-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { response } = await selectTargetTab(context, extensionId, url);
    // The top document hosts no video, so the target must be the player frame.
    expect(response).toMatchObject({ status: 'ok', hasVideo: true });
    expect(response.frameId).not.toBe(0);

    const playerFrame = page.frames().find(frame => frame.url().includes('player-frame'));
    await expect
        .poll(() => playerFrame.locator('video').getAttribute('data-koala-attached'))
        .toBe('true');

    // The controller belongs in the player frame...
    await expect
        .poll(() => readPerFrameGlobal(context, extensionId, url, 'koalaSyncInjected'))
        .toMatchObject({ player: true });
    // ...and the chat overlay belongs in the top document, never inside the
    // video. Installing it in the player frame is what rendered the chat on top
    // of the picture and made closing it affect only that frame.
    await expect
        .poll(() => readPerFrameGlobal(context, extensionId, url, 'koalaSyncChatOverlay'))
        .toMatchObject({ top: true, player: false });
});

test('keeps controlling a Drive-style player across an ordinary play and pause', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/drive-style-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__fixtureReady === true);

    const { tabId, response } = await selectTargetTab(context, extensionId, url);
    expect(response).toMatchObject({ status: 'ok' });
    const selectedFrameId = response.frameId;

    const playerFrame = page.frames().find(frame => frame.url().includes('player-frame'));
    await playerFrame.locator('video').evaluate(video => video.play());
    await playerFrame.locator('video').evaluate(video => video.pause());
    await page.waitForTimeout(750);

    // Playback state changes are not frame layout changes. If they were treated
    // as such, the target would be torn down and re-injected mid-playback.
    const status = await getExtensionState(context, extensionId, { type: 'GET_STATUS' });
    expect(status).toMatchObject({
        targetTabId: tabId,
        targetReady: true,
        targetActivationState: 'ready',
        targetFrameId: selectedFrameId
    });

    const command = await sendServerCommand(context, extensionId, tabId, 'play', { time: 1 });
    expect(command).toMatchObject({ status: 'ok_solo' });
    await expect.poll(() => playerFrame.locator('video').evaluate(video => video.paused)).toBe(false);
});

function FRAMED_VIDEO_PAUSED() {
    return document.querySelector('iframe').contentDocument.querySelector('video').paused;
}
