import { expect, openPopup, test } from './helpers/extension-fixture.mjs';

test('popup exposes names and keyboard access for every visible control', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId, { openEditor: false });
    const unnamed = await page.locator('button, input, select, textarea, a[href]').evaluateAll(elements => elements
        .filter(element => {
            const style = window.getComputedStyle(element);
            return !element.disabled && style.display !== 'none' && style.visibility !== 'hidden'
                && element.getClientRects().length > 0;
        })
        .filter(element => {
            const label = element.getAttribute('aria-label')
                || element.getAttribute('aria-labelledby')
                || element.getAttribute('title')
                || element.labels?.[0]?.textContent
                || element.textContent;
            return !String(label || '').trim();
        })
        .map(element => `${element.tagName.toLowerCase()}#${element.id || '<no-id>'}`));
    expect(unnamed).toEqual([]);

    await page.locator('body').press('Tab');
    await expect(page.locator(':focus')).not.toHaveCount(0);
    const settingsTab = page.locator('.tab-btn[data-tab="tab-settings"]');
    await settingsTab.focus();
    await page.keyboard.press('Enter');
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tab-settings')).toBeVisible();
});
