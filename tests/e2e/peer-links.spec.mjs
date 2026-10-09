import { expect, launchExtensionContext, test, terminateServiceWorker } from './helpers/extension-fixture.mjs';
import { reservePort, startRelay, stopRelay } from './helpers/relay-process.mjs';

async function control(context, extensionId) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/audio-options.html`);
    return page;
}
const status = page => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
async function connect(page, serverUrl, username, chatKey = '') {
    await page.evaluate(async settings => {
        await chrome.storage.sync.set({ onboardingComplete: true });
        await chrome.storage.local.set({ ...settings, roomId: 'peer-links-e2e', password: '', useCustomServer: true, shareVideoUrl: true, chatEnabled: !!settings.chatKey, chatStartMode: 'open', locale: 'en' });
        await chrome.runtime.sendMessage({ type: 'CONNECT' });
    }, { serverUrl, username, chatKey });
    await expect.poll(() => status(page)).toMatchObject({ status: 'connected' });
}
async function select(page, url) {
    return page.evaluate(async target => {
        const [tab] = await chrome.tabs.query({ url: target });
        return chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: tab.id, tabTitle: tab.title });
    }, url);
}

test('video-link privacy setting defaults off and persists through popup reopening', async ({ context, extensionId }) => {
    const page = await control(context, extensionId);
    await page.evaluate(() => chrome.storage.sync.set({ onboardingComplete: true }));
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.locator('#tab-settings-button').click();
    await page.locator('summary[data-i18n="LABEL_PRIVACY_SETTINGS"]').click();
    await expect(page.locator('#shareVideoUrl')).not.toBeChecked();
    await expect(page.locator('label[for="shareVideoUrl"]')).toHaveAttribute('title', /.+/);
    await page.locator('label.toggle-switch:has(#shareVideoUrl)').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('shareVideoUrl')).shareVideoUrl)).toBe(true);
    await page.reload();
    await page.locator('#tab-settings-button').click();
    await page.locator('summary[data-i18n="LABEL_PRIVACY_SETTINGS"]').click();
    await expect(page.locator('#shareVideoUrl')).toBeChecked();
    await page.locator('label.toggle-switch:has(#shareVideoUrl)').click();
    await expect.poll(() => page.evaluate(async () => (await chrome.storage.local.get('shareVideoUrl')).shareVideoUrl)).toBe(false);
});

test('the setting explains that a relay without chat support cannot share links', async ({ context, extensionId }) => {
    let relay;
    try {
        const page = await control(context, extensionId);
        const port = await reservePort(); relay = await startRelay(port);
        await connect(page, `ws://127.0.0.1:${port}`, 'Alice');
        const open = async (chatSupported) => {
            const popup = await context.newPage();
            await popup.addInitScript(supported => {
                const original = chrome.runtime.sendMessage.bind(chrome.runtime);
                chrome.runtime.sendMessage = (message, callback) => message?.type === 'GET_STATUS' && typeof callback === 'function'
                    ? original(message, response => callback(response && supported !== null ? { ...response, chatSupported: supported } : response))
                    : original(message, callback);
            }, chatSupported);
            await popup.goto(`chrome-extension://${extensionId}/popup.html`);
            await popup.locator('#tab-settings-button').click();
            await popup.locator('summary[data-i18n="LABEL_PRIVACY_SETTINGS"]').click();
            return popup;
        };
        // A capable relay: no hint although sharing is on (the connect helper enables it).
        const capable = await open(null);
        await expect(capable.locator('#shareVideoUrl')).toBeChecked();
        await expect(capable.locator('#shareVideoUrlHint')).toBeHidden();
        await capable.close();
        // A relay that does not advertise chat: the hint appears with the toggle and goes with it.
        const unsupported = await open(false);
        await expect(unsupported.locator('#shareVideoUrl')).toBeChecked();
        await expect(unsupported.locator('#shareVideoUrlHint')).toBeVisible();
        await expect(unsupported.locator('#shareVideoUrlHint')).toContainText('does not support encrypted chat');
        await unsupported.locator('label.toggle-switch:has(#shareVideoUrl)').click();
        await expect(unsupported.locator('#shareVideoUrlHint')).toBeHidden();
        await unsupported.locator('label.toggle-switch:has(#shareVideoUrl)').click();
        await expect(unsupported.locator('#shareVideoUrlHint')).toBeVisible();
        await unsupported.evaluate(() => chrome.storage.local.set({ locale: 'de' }));
        await unsupported.reload();
        await unsupported.locator('#tab-settings-button').click();
        await unsupported.locator('summary[data-i18n="LABEL_PRIVACY_SETTINGS"]').click();
        await expect(unsupported.locator('#shareVideoUrlHint')).toContainText('Dieses Relay');
    } finally { await stopRelay(relay); }
});

test('chat appears on first selection and URL clicks work for every peer without invitation keys', async ({ context, extensionId, baseURL }) => {
    test.setTimeout(150000);
    const others = [];
    let relay;
    try {
        const second = await launchExtensionContext(); others.push(second);
        const third = await launchExtensionContext(); others.push(third);
        const pages = await Promise.all([control(context, extensionId), control(second.context, second.extensionId), control(third.context, third.extensionId)]);
        const port = await reservePort(); relay = await startRelay(port);
        const relayUrl = `ws://127.0.0.1:${port}`;
        const chatKey = 'AQEBAQEBAQEBAQEBAQEBAQ';
        await connect(pages[0], relayUrl, 'Alice', chatKey);
        await connect(pages[1], relayUrl, 'Bob', chatKey);
        const aUrl = `${baseURL}/pages/simple-player.html?peer=alice`;
        const bUrl = `${baseURL}/pages/iframe-player.html?peer=bob`;
        const a = await context.newPage(); const b = await second.context.newPage();
        await a.goto(aUrl); await b.goto(bUrl);
        expect(await select(pages[0], aUrl)).toMatchObject({ status: 'ok' });
        expect(await select(pages[1], bUrl)).toMatchObject({ status: 'ok' });
        // No reload or repeated selection: both top-level and iframe players.
        await expect(a.locator('#koalasync-chat-overlay-host')).toBeVisible();
        await expect(b.locator('#koalasync-chat-overlay-host')).toBeVisible();
        await expect(b.locator('#koalasync-chat-overlay-host textarea')).toBeEnabled();
        await b.locator('#koalasync-chat-overlay-host textarea').fill('First-selection chat');
        await b.locator('#koalasync-chat-overlay-host textarea').press('Enter');
        await expect(a.getByText('First-selection chat', { exact: true })).toBeVisible();

        // Late manual join, chat disabled, no target selected.
        await connect(pages[2], relayUrl, 'Charlie');
        await expect.poll(async () => (await status(pages[2])).peers.filter(p => p.tabUrl).length, { timeout: 25000 }).toBe(2);
        const aliceId = (await status(pages[0])).peerId;
        const bobId = (await status(pages[1])).peerId;
        expect((await status(pages[2])).targetTabId).toBeNull();
        const popup = await third.context.newPage();
        await popup.goto(`chrome-extension://${third.extensionId}/popup.html`);
        await popup.locator('#tab-sync-button').click();
        const aliceLink = popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Alice' });
        await expect(aliceLink).toHaveAttribute('title', `Open this participant’s video: ${aUrl}`);
        await aliceLink.hover();
        await popup.keyboard.press('Tab');
        await aliceLink.focus();
        await expect(aliceLink).toBeFocused();
        expect(await aliceLink.evaluate(el => globalThis.getComputedStyle(el).outlineStyle)).toBe('solid');
        await popup.locator('#tab-settings-button').click();
        await popup.locator('#langSelector').selectOption('de');
        await popup.locator('#tab-sync-button').click();
        await expect(aliceLink).toHaveAttribute('title', `Video dieses Teilnehmers öffnen: ${aUrl}`);
        await expect(aliceLink).toHaveAttribute('aria-label', 'Video dieses Teilnehmers öffnen: Alice');
        const newPageEvent = third.context.waitForEvent('page');
        await popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Alice' }).click();
        const created = await newPageEvent;
        await expect(created).toHaveURL(aUrl);
        await expect.poll(() => status(pages[2])).toMatchObject({ targetReady: true });
        const selectedId = (await status(pages[2])).targetTabId;

        // Every participant row names the destination host.
        await expect(popup.locator('#peerListSync [data-peer-link-host]').first()).toContainText('localhost');

        // A tab is now selected, so a click asks before replacing it. Cancel keeps the page.
        await popup.bringToFront();
        const confirmation = popup.locator('#peerListSync [data-peer-link-confirm]');
        await popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Bob' }).press('Enter');
        await expect(confirmation).toContainText('localhost');
        await expect(confirmation.locator('button[data-action="cancel"]')).toBeFocused();
        await confirmation.locator('button[data-action="cancel"]').click();
        await expect(confirmation).toHaveCount(0);
        await expect(created).toHaveURL(aUrl);

        // Escape also cancels; a changed link can never be opened by an old confirmation.
        await popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Bob' }).press('Enter');
        await expect(confirmation).toHaveCount(1);
        await confirmation.press('Escape');
        await expect(confirmation).toHaveCount(0);
        expect(await pages[2].evaluate(([peerId, url]) => chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_PEER', peerId, url }), [bobId, `${bUrl}&stale=1`])).toMatchObject({ status: 'changed' });
        await expect(created).toHaveURL(aUrl);

        // Confirming reuses that selected tab, not the popup/active tab.
        await popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Bob' }).press('Enter');
        await confirmation.locator('button[data-action="confirm"]').click();
        await expect(created).toHaveURL(bUrl);
        await expect.poll(() => status(pages[2])).toMatchObject({ targetTabId: selectedId, targetReady: true });
        await expect.poll(async () => (await status(pages[0])).peers.find(p => p.username === 'Charlie')?.tabUrl, { timeout: 20000 }).toBe(bUrl);
        await aliceLink.press('Space');
        await confirmation.locator('button[data-action="confirm"]').click();
        await expect(created).toHaveURL(aUrl);
        await expect.poll(() => status(pages[2])).toMatchObject({ targetTabId: selectedId, targetReady: true });
        await popup.locator('#peerListSync [role="button"]').filter({ hasText: 'Bob' }).click();
        await confirmation.locator('button[data-action="confirm"]').click();
        await expect(created).toHaveURL(bUrl);
        await expect.poll(() => status(pages[2])).toMatchObject({ targetTabId: selectedId, targetReady: true });

        // Same-document URL changes are published without reloading the video.
        const updated = `${aUrl}#episode-two`;
        await a.evaluate(url => history.pushState({}, '', url), updated);
        await expect.poll(async () => (await status(pages[1])).peers.find(p => p.peerId === aliceId)?.tabUrl, { timeout: 20000 }).toBe(updated);
        await expect.poll(async () => (await status(pages[2])).peers.find(p => p.peerId === aliceId)?.tabUrl).toBe(updated);
        await pages[1].evaluate(() => chrome.storage.local.set({ shareVideoUrl: false }));
        await expect.poll(async () => (await status(pages[2])).peers.find(p => p.peerId === bobId)?.tabUrl, { timeout: 20000 }).toBeNull();

        // Stop the worker while the destination is still loading. Its pending
        // navigation and selection must survive independently of the popup.
        let releaseNavigation;
        let navigationReached;
        const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
        const reached = new Promise(resolve => { navigationReached = resolve; });
        await third.context.route(aUrl, async route => {
            navigationReached();
            await navigationGate;
            await route.continue();
        });
        await pages[2].evaluate(id => chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_PEER', peerId: id }), aliceId);
        await reached;
        await terminateServiceWorker(third.context, third.extensionId);
        releaseNavigation();
        await expect(created).toHaveURL(updated);
        await expect.poll(() => status(pages[2]), { timeout: 30000 }).toMatchObject({ targetTabId: selectedId, targetReady: true });
        await expect.poll(async () => (await status(pages[2])).peers.find(p => p.peerId === aliceId)?.tabUrl, { timeout: 30000 }).toBe(updated);
    } finally {
        for (const other of others) await other.close();
        await stopRelay(relay);
    }
});
