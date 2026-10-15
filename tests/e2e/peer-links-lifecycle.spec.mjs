import { expect, launchExtensionContext, test } from './helpers/extension-fixture.mjs';
import { reservePort, startRelay, stopRelay } from './helpers/relay-process.mjs';

async function control(context, extensionId) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/audio-options.html`);
    return page;
}
const status = page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
const link = async (page, name) => (await status(page)).peers.find(p => p.username === name)?.tabUrl ?? null;
const setSharing = (page, value) => page.evaluate(shareVideoUrl => chrome.storage.local.set({ shareVideoUrl }), value);
async function connect(page, serverUrl, username, chatKey) {
    await page.evaluate(async settings => {
        await chrome.storage.sync.set({ onboardingComplete: true });
        await chrome.storage.local.set({ ...settings, roomId: 'peer-links-lifecycle', password: '', useCustomServer: true, chatEnabled: !!settings.chatKey, chatStartMode: 'open', locale: 'en' });
        await chrome.runtime.sendMessage({ type: 'CONNECT' });
    }, { serverUrl, username, chatKey });
    await expect.poll(() => status(page)).toMatchObject({ status: 'connected' });
}
const select = (page, url) => page.evaluate(async target => {
    const [tab] = await chrome.tabs.query({ url: target });
    return chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: tab.id, tabTitle: tab.title });
}, url);

for (const keyed of [true, false]) {
    test(`shared video links follow the setting, selection, navigation, reconnects and departures (${keyed ? 'with' : 'without'} chat secret)`, async ({ baseURL }) => {
        test.setTimeout(240000);
        const others = []; let relay;
        try {
            const alice = await launchExtensionContext(); others.push(alice);
            const bob = await launchExtensionContext(); others.push(bob);
            const port = await reservePort(); relay = await startRelay(port);
            const relayUrl = `ws://127.0.0.1:${port}`;
            const chatKey = keyed ? 'AQEBAQEBAQEBAQEBAQEBAQ' : '';
            const ac = await control(alice.context, alice.extensionId); const bc = await control(bob.context, bob.extensionId);
            await connect(ac, relayUrl, 'Alice', chatKey); await connect(bc, relayUrl, 'Bob', chatKey);
            const a1 = `${baseURL}/pages/simple-player.html?a=1`; const a2 = `${baseURL}/pages/simple-player.html?a=2`; const b1 = `${baseURL}/pages/simple-player.html?b=1`;
            const pageA1 = await alice.context.newPage(); await pageA1.goto(a1);
            const pageA2 = await alice.context.newPage(); await pageA2.goto(a2);
            const pageB = await bob.context.newPage(); await pageB.goto(b1);
            await select(ac, a1); await select(bc, b1);
            await expect.poll(async () => (await status(bc)).peers.length).toBe(2);

            // Off by default. Bob's link arriving proves the pipeline works; Alice's never does.
            await setSharing(bc, true);
            await expect.poll(() => link(ac, 'Bob'), { timeout: 30000 }).toBe(b1);
            expect(await link(bc, 'Alice')).toBeNull();
            await setSharing(bc, false);
            await expect.poll(() => link(ac, 'Bob'), { timeout: 30000 }).toBeNull();

            // Enable, disable, enable.
            await setSharing(ac, true);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(a1);
            await setSharing(ac, false);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBeNull();
            await setSharing(ac, true);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(a1);

            // Switching the selected tab updates the link; clearing the selection withdraws it.
            await select(ac, a2);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(a2);
            await ac.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: null }));
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBeNull();

            // Navigating the selected tab updates the link; closing it withdraws it.
            await select(ac, a1);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(a1);
            const navigated = `${a1}&nav=1`; await pageA1.goto(navigated);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(navigated);
            // A page without a video is never shared, even on another site in the selected tab.
            await pageA1.goto(`${baseURL.replace('localhost', '127.0.0.1')}/pages/no-video.html?mail=inbox&token=private`);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBeNull();
            await pageA1.goto(navigated);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(navigated);
            await pageA1.close();
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBeNull();

            // A relay restart makes both clients reconnect and handshake again.
            await select(ac, a2);
            await expect.poll(() => link(bc, 'Alice'), { timeout: 30000 }).toBe(a2);
            await stopRelay(relay); relay = await startRelay(port);
            await expect.poll(async () => (await status(ac)).status, { timeout: 90000 }).toBe('connected');
            await expect.poll(async () => (await status(bc)).status, { timeout: 90000 }).toBe('connected');
            await expect.poll(() => link(bc, 'Alice'), { timeout: 90000 }).toBe(a2);

            // Leaving the room removes the participant and its link.
            await ac.evaluate(() => chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' }));
            await expect.poll(async () => (await status(bc)).peers.length, { timeout: 30000 }).toBe(1);
            expect(await link(bc, 'Alice')).toBeNull();
        } finally {
            for (const other of others) await other.close();
            await stopRelay(relay);
        }
    });
}
