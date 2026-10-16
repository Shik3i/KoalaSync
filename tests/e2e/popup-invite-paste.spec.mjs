import { expect, openPopup, test } from './helpers/extension-fixture.mjs';

const INVITE = 'Join: https://sync.my-server.example/join#j2:r=SILENT-EAGLE-90&p=30PXPD'
    + '&k=R5Ti1nxp0crfAFHf3gVncw&u=wss%3A%2F%2Frelay.example.test';

async function openJoinView(context, extensionId) {
    const page = await openPopup(context, extensionId, { openEditor: false });
    await page.evaluate(() => new Promise(resolve => {
        chrome.storage.sync.set({ onboardingComplete: true }, () => {
            const overlay = document.getElementById('onboarding-overlay');
            if (overlay) overlay.style.display = 'none';
            resolve();
        });
    }));
    return page;
}

async function pasteWithKeyboard(page, text) {
    await page.evaluate(value => navigator.clipboard.writeText(value), text);
    await page.keyboard.press('ControlOrMeta+V');
}

async function expectInviteApplied(page) {
    await expect(page.locator('#roomId')).toHaveValue('SILENT-EAGLE-90');
    await expect(page.locator('#password')).toHaveValue('30PXPD');
    await expect(page.locator('#serverUrl')).toHaveValue('wss://relay.example.test');
    await expect(page.locator('#serverUrl')).toBeVisible();
    await expect(page.locator('#serverCustom')).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => chrome.storage.local.get(['serverUrl', 'useCustomServer'])))
        .toEqual({ serverUrl: 'wss://relay.example.test', useCustomServer: true });
}

test('pasting an invite link with nothing focused opens and fills the join form', async ({ context, extensionId }) => {
    const page = await openJoinView(context, extensionId);
    await expect(page.locator('#roomId')).toBeHidden();
    await page.evaluate(() => document.activeElement?.blur());

    await pasteWithKeyboard(page, INVITE);
    await expect(page.locator('#roomId')).toBeVisible();
    await expectInviteApplied(page);
});

test('pasting an invite link from any domain into the room field fills the join form', async ({ context, extensionId }) => {
    const page = await openJoinView(context, extensionId);
    await page.locator('#section-join summary').click();
    await page.locator('#roomId').focus();

    await pasteWithKeyboard(page, INVITE);
    await expectInviteApplied(page);
});

test('plain text and other fields keep the default paste behavior', async ({ context, extensionId }) => {
    const page = await openJoinView(context, extensionId);
    await page.locator('#section-join summary').click();

    await page.locator('#roomId').focus();
    await pasteWithKeyboard(page, 'SILENT-EAGLE-90');
    await expect(page.locator('#roomId')).toHaveValue('SILENT-EAGLE-90');
    await expect(page.locator('#password')).toHaveValue('');

    await page.locator('#serverCustom').click();
    await page.locator('#serverUrl').fill('');
    await page.locator('#serverUrl').focus();
    await pasteWithKeyboard(page, INVITE);
    await expect(page.locator('#serverUrl')).toHaveValue(INVITE);
    await expect(page.locator('#password')).toHaveValue('');
});

test('pasting an invite link on another popup tab does nothing', async ({ context, extensionId }) => {
    const page = await openJoinView(context, extensionId);
    await page.click('.tab-btn[data-tab="tab-settings"]');
    await page.evaluate(() => document.activeElement?.blur());

    await pasteWithKeyboard(page, INVITE);
    await expect(page.locator('#roomId')).toHaveValue('');
    await expect(page.locator('#password')).toHaveValue('');
});
