import { expect, openPopup, test } from './helpers/extension-fixture.mjs';

async function pasteInto(page, selector, text) {
    return page.locator(selector).evaluate((input, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event.defaultPrevented;
    }, text);
}

test('pasting an invite link from any domain fills the join form', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId, { openEditor: false });
    const link = 'Join: https://sync.my-server.example/join#j2:r=SILENT-EAGLE-90&p=30PXPD'
        + '&k=R5Ti1nxp0crfAFHf3gVncw&u=wss%3A%2F%2Frelay.example.test';

    expect(await pasteInto(page, '#roomId', link)).toBe(true);
    await expect(page.locator('#roomId')).toHaveValue('SILENT-EAGLE-90');
    await expect(page.locator('#password')).toHaveValue('30PXPD');
    await expect(page.locator('#serverUrl')).toHaveValue('wss://relay.example.test');
    await expect(page.locator('#serverCustom')).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => chrome.storage.local.get(['serverUrl', 'useCustomServer'])))
        .toEqual({ serverUrl: 'wss://relay.example.test', useCustomServer: true });
});

test('pasting plain text into the room field keeps default paste behavior', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId, { openEditor: false });
    expect(await pasteInto(page, '#roomId', 'SILENT-EAGLE-90')).toBe(false);
    expect(await pasteInto(page, '#password', 'https://example.com/#section')).toBe(false);
});
