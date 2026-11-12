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

test('popup root remains 360px when a dynamic child overflows', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId, { openEditor: false });
    const geometry = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.id = 'popup-overflow-probe';
        probe.style.width = '1200px';
        probe.style.height = '1px';
        document.body.appendChild(probe);

        const htmlStyle = window.getComputedStyle(document.documentElement);
        const bodyStyle = window.getComputedStyle(document.body);
        return {
            htmlWidth: document.documentElement.getBoundingClientRect().width,
            bodyWidth: document.body.getBoundingClientRect().width,
            htmlOverflowX: htmlStyle.overflowX,
            bodyOverflowX: bodyStyle.overflowX,
            bodyContain: bodyStyle.contain,
            probeWidth: probe.getBoundingClientRect().width
        };
    });

    expect(geometry).toEqual({
        htmlWidth: 360,
        bodyWidth: 360,
        htmlOverflowX: 'hidden',
        bodyOverflowX: 'hidden',
        bodyContain: 'inline-size',
        probeWidth: 1200
    });
});

test('changelog modal stays suppressed during onboarding, opens once on version update, and reopens on version click', async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId, { openEditor: false });

    // 1. Fresh install before onboarding completes: changelog must remain hidden.
    await expect(page.locator('#changelog-overlay')).toBeHidden();

    // 2. Simulate an existing user (onboardingComplete: true) upgrading from an older version.
    await page.evaluate(() => new Promise(resolve => {
        chrome.storage.sync.set({ onboardingComplete: true, lastReadChangelogVersion: '0.0.1' }, resolve);
    }));
    await page.reload();
    await expect(page.locator('#changelog-overlay')).toBeVisible();
    await expect(page.locator('#changelogList .changelog-item')).toHaveCount(3);
    await expect(page.locator('#changelogGithubLink')).toHaveAttribute(
        'href',
        'https://github.com/Shik3i/KoalaSync/blob/main/docs/CHANGELOG.md'
    );

    // Dismissing marks the current version as read in storage.sync and prevents re-showing on reload.
    await page.click('#changelogDismissBtn');
    await expect(page.locator('#changelog-overlay')).toBeHidden();

    const storedVersion = await page.evaluate(() => new Promise(resolve => {
        chrome.storage.sync.get(['lastReadChangelogVersion'], data => resolve(data.lastReadChangelogVersion));
    }));
    const expectedMajorMinor = await page.evaluate(() => chrome.runtime.getManifest().version.split('.').slice(0, 2).join('.'));
    expect(storedVersion).toBe(expectedMajorMinor);

    await page.reload();
    await expect(page.locator('#changelog-overlay')).toBeHidden();

    // 3. Clicking the version number in the header reopens the changelog anytime.
    await page.click('#popupVersionBtn');
    await expect(page.locator('#changelog-overlay')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#changelog-overlay')).toBeHidden();
});
