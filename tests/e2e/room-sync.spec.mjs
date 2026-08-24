import {
    expect,
    launchExtensionContext,
    terminateServiceWorker,
    test
} from './helpers/extension-fixture.mjs';
import { reservePort, startRelay, stopRelay } from './helpers/relay-process.mjs';

// popup.html intentionally performs connection setup. Use a neutral extension
// page for privileged test messages so opening the test transport cannot race
// the server settings being exercised.
async function withExtensionPage(context, extensionId, fn) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/audio-options.html`);
    try {
        return await fn(page);
    } finally {
        await page.close();
    }
}

function getStatus(context, extensionId) {
    return withExtensionPage(context, extensionId, page => page.evaluate(
        () => chrome.runtime.sendMessage({ type: 'GET_STATUS' })
    ));
}

async function selectTarget(context, extensionId, url) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async targetUrl => {
        const [tab] = await chrome.tabs.query({ url: targetUrl });
        if (!tab) throw new Error(`target tab missing: ${targetUrl}`);
        const result = await chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: tab.id, tabTitle: tab.title });
        return { tabId: tab.id, result };
    }, url));
}

async function connect(context, extensionId, { relayUrl, roomId, username }) {
    await withExtensionPage(context, extensionId, page => page.evaluate(async settings => {
        await chrome.storage.local.set({
            roomId: settings.roomId,
            password: '',
            chatKey: '',
            username: settings.username,
            useCustomServer: true,
            serverUrl: settings.relayUrl
        });
        await chrome.runtime.sendMessage({ type: 'CONNECT' });
    }, { relayUrl, roomId, username }));
}

test('@race synchronizes two packed clients across relay and service-worker restarts', async ({ context, extensionId, baseURL }) => {
    test.setTimeout(120000);
    const second = await launchExtensionContext();
    let relay = null;
    try {
        const port = await reservePort();
        relay = await startRelay(port);
        const firstUrl = `${baseURL}/pages/simple-player.html?client=first`;
        const secondUrl = `${baseURL}/pages/simple-player.html?client=second`;
        const firstPage = await context.newPage();
        const secondPage = await second.context.newPage();
        await Promise.all([firstPage.goto(firstUrl), secondPage.goto(secondUrl)]);
        await Promise.all([
            firstPage.waitForFunction(() => window.__fixtureReady === true),
            secondPage.waitForFunction(() => window.__fixtureReady === true)
        ]);
        await selectTarget(context, extensionId, firstUrl);
        await selectTarget(second.context, second.extensionId, secondUrl);

        const connection = { relayUrl: `ws://127.0.0.1:${port}`, roomId: 'E2E-ROOM-42' };
        await connect(context, extensionId, { ...connection, username: 'First' });
        await expect.poll(() => getStatus(context, extensionId)).toMatchObject({
            status: 'connected',
            roomId: connection.roomId,
            peers: [expect.objectContaining({ username: 'First' })]
        });
        await connect(second.context, second.extensionId, { ...connection, username: 'Second' });
        let latestStates = [];
        try {
            await expect.poll(async () => {
                latestStates = await Promise.all([
                    getStatus(context, extensionId),
                    getStatus(second.context, second.extensionId)
                ]);
                return latestStates.map(state => state.peers.length);
            }).toEqual([2, 2]);
        } catch (error) {
            console.error(`Two-client join diagnostics: ${JSON.stringify(latestStates)}`);
            console.error(`Relay diagnostics: ${relay.output.join('')}`);
            throw error;
        }
        for (const state of latestStates) expect(state.serverUrl).toBe(connection.relayUrl);

        await firstPage.locator('video').evaluate(video => video.play());
        await expect.poll(() => secondPage.locator('video').evaluate(video => video.paused)).toBe(false);
        await firstPage.locator('video').evaluate(video => video.pause());
        await expect.poll(() => secondPage.locator('video').evaluate(video => video.paused)).toBe(true);

        await stopRelay(relay);
        relay = null;
        await expect.poll(() => getStatus(context, extensionId).then(status => status.status))
            .not.toBe('connected');
        relay = await startRelay(port);
        await expect.poll(() => Promise.all([
            getStatus(context, extensionId),
            getStatus(second.context, second.extensionId)
        ]).then(states => states.map(state => state.status)), { timeout: 45000 }).toEqual(['connected', 'connected']);

        await terminateServiceWorker(second.context, second.extensionId);
        await expect.poll(() => getStatus(second.context, second.extensionId), { timeout: 45000 })
            .toMatchObject({ status: 'connected', roomId: connection.roomId });
        await expect.poll(() => getStatus(context, extensionId).then(status => status.peers.length), { timeout: 45000 })
            .toBe(2);
    } finally {
        await stopRelay(relay);
        await second.close();
    }
});
