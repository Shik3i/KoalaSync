import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { test as base, chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const extensionPath = path.join(repoRoot, 'dist/chrome');

function isLocalTestUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return true;
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    } catch (_error) {
        return false;
    }
}

export async function launchExtensionContext() {
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
        throw new Error('dist/chrome is missing. Run: npm run build:extension');
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koalasync-e2e-'));
    let context;
    try {
        context = await chromium.launchPersistentContext(userDataDir, {
            channel: 'chromium',
            headless: true,
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--autoplay-policy=no-user-gesture-required',
                '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1'
            ]
        });
        await context.route('**/*', route => {
            if (isLocalTestUrl(route.request().url())) return route.continue();
            return route.abort('blockedbyclient');
        });
        if (typeof context.routeWebSocket === 'function') {
            await context.routeWebSocket(/.*/u, webSocketRoute => {
                if (isLocalTestUrl(webSocketRoute.url())) {
                    webSocketRoute.connectToServer();
                } else {
                    webSocketRoute.close({ code: 1008, reason: 'External network blocked by E2E harness' });
                }
            });
        }
        let [worker] = context.serviceWorkers();
        if (!worker) worker = await context.waitForEvent('serviceworker');
        const extensionId = worker.url().split('/')[2];
        return {
            context,
            extensionId,
            async close() {
                try {
                    await context.close();
                } finally {
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
            }
        };
    } catch (error) {
        if (context) await context.close().catch(() => {});
        if (fs.existsSync(userDataDir)) {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * A browser with the packed extension loaded, plus its extension id. Each test
 * gets a throwaway profile so storage from one test cannot leak into the next.
 */
export const test = base.extend({
    context: async ({}, use) => {
        // The headless shell does not run MV3 service workers; the full
        // Chromium build in new headless mode does.
        const launched = await launchExtensionContext();
        try {
            await use(launched.context);
        } finally {
            await launched.close();
        }
    },
    extensionId: async ({ context }, use) => {
        let [worker] = context.serviceWorkers();
        if (!worker) worker = await context.waitForEvent('serviceworker');
        await use(worker.url().split('/')[2]);
    }
});

export { expect } from '@playwright/test';

/**
 * Opens the real popup page, waits for its settings to be populated and expands
 * the domain editor, which ships collapsed and therefore has no clickable
 * buttons until it is opened.
 */
export async function openPopup(context, extensionId, { openEditor = true } = {}) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForFunction(() => {
        const textarea = document.getElementById('blacklistDomains');
        return !!textarea && textarea.value.length > 0;
    });

    if (!openEditor) return page;

    // A fresh profile has never seen onboarding, and its overlay sits on top of
    // the whole popup. Dismiss it the same way the tour's last step does.
    await page.evaluate(() => new Promise(resolve => {
        chrome.storage.sync.set({ onboardingComplete: true }, () => {
            const overlay = document.getElementById('onboarding-overlay');
            if (overlay) overlay.style.display = 'none';
            resolve();
        });
    }));

    // The controls live on the Settings tab, inside a collapsed accordion.
    await page.click('.tab-btn[data-tab="tab-settings"]');
    await page.evaluate(() => {
        const details = document.getElementById('blacklistEdit')?.closest('details');
        if (details) details.open = true;
    });

    await page.click('#blacklistEdit');
    await page.waitForSelector('#blacklistSave', { state: 'visible' });
    return page;
}

export async function readStorage(page, keys) {
    return page.evaluate(k => chrome.storage.local.get(k), keys);
}

export async function writeStorage(page, values) {
    return page.evaluate(v => chrome.storage.local.set(v), values);
}

export async function terminateServiceWorker(context, extensionId) {
    const page = await context.newPage();
    let session;
    try {
        await page.goto(`chrome-extension://${extensionId}/audio-options.html`);
        session = await context.newCDPSession(page);
        const { targetInfos } = await session.send('Target.getTargets');
        const worker = targetInfos.find(target => target.type === 'service_worker'
            && target.url.startsWith(`chrome-extension://${extensionId}/`));
        if (!worker) throw new Error(`service worker target missing for ${extensionId}`);
        await session.send('Target.closeTarget', { targetId: worker.targetId });
    } finally {
        if (session) await session.detach().catch(() => {});
        await page.close().catch(() => {});
    }
}
