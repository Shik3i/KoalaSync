import { test, expect } from './helpers/extension-fixture.mjs';

async function withExtensionPage(context, extensionId, fn) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/audio-options.html`);
    try {
        return await fn(page);
    } finally {
        await page.close();
    }
}

async function selectTargetTab(context, extensionId, pageUrl) {
    return withExtensionPage(context, extensionId, page => page.evaluate(async url => {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error(`no tab matched ${url}`);
        await chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: tab.id });
        return tab.id;
    }, pageUrl));
}

async function extensionMessage(context, extensionId, message) {
    return withExtensionPage(context, extensionId, page => page.evaluate(
        payload => chrome.runtime.sendMessage(payload),
        message
    ));
}

async function prepareEpisodePage(page, title, currentTime) {
    await page.waitForFunction(() => window.__fixtureReady === true);
    await page.evaluate(async ({ title, currentTime }) => {
        navigator.mediaSession.metadata = new window.MediaMetadata({ title });
        const video = document.querySelector('#player');
        video.muted = true;
        video.playbackRate = 0.1;
        video.currentTime = currentTime;
        await video.play();
    }, { title, currentTime });
}

async function contentLogs(context, extensionId) {
    const logs = await extensionMessage(context, extensionId, { type: 'GET_LOGS' });
    return logs.filter(entry => entry.message.includes('[Content]')).map(entry => entry.message);
}

test('keeps ordinary play/pause outside an episode boundary on the immediate path @episode-transition', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await prepareEpisodePage(page, 'Series S01E05', 3);
    await selectTargetTab(context, extensionId, url);
    await expect.poll(() => page.locator('#player').getAttribute('data-koala-attached')).toBe('true');

    const before = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
    await page.locator('#player').evaluate(video => video.pause());
    await expect.poll(async () => {
        const history = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
        return history.length;
    }, { timeout: 750 }).toBe(before.length + 1);
});

test('quarantines a suspicious boundary pause, then relays the final intent when no episode changes @episode-transition', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await prepareEpisodePage(page, 'Series S01E05', 9.25);
    await selectTargetTab(context, extensionId, url);
    await expect.poll(() => page.locator('#player').getAttribute('data-koala-attached')).toBe('true');

    const before = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
    await page.locator('#player').evaluate(video => video.pause());

    await page.waitForTimeout(500);
    expect(await extensionMessage(context, extensionId, { type: 'GET_HISTORY' })).toEqual(before);
    await expect.poll(async () => {
        const history = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
        return history.length;
    }, { timeout: 4000 }).toBe(before.length + 1);
    const after = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
    expect(after[0]).toMatchObject({ action: 'pause' });
});

test('relays a deliberate boundary pause immediately @episode-transition', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await prepareEpisodePage(page, 'Series S01E05', 9.25);
    await selectTargetTab(context, extensionId, url);
    await expect.poll(() => page.locator('#player').getAttribute('data-koala-attached')).toBe('true');

    const before = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
    await page.locator('#player').dispatchEvent('pointerdown');
    await page.locator('#player').evaluate(video => video.pause());
    await expect.poll(async () => {
        const history = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });
        return history.length;
    }, { timeout: 750 }).toBe(before.length + 1);
});

test('does not consume title-before-loadeddata or loadeddata-before-title transitions @episode-transition', async ({ context, extensionId, baseURL }) => {
    const runOrdering = async ordering => {
        const url = `${baseURL}/pages/simple-player.html?ordering=${ordering}-${Date.now()}`;
        const page = await context.newPage();
        await page.goto(url);
        await prepareEpisodePage(page, 'Series S01E05', 1);
        await selectTargetTab(context, extensionId, url);
        await expect.poll(() => page.locator('#player').getAttribute('data-koala-attached')).toBe('true');

        if (ordering === 'title-first') {
            await page.evaluate(() => {
                navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'Series S01E06' });
                document.querySelector('#player').dispatchEvent(new window.Event('loadeddata'));
            });
        } else {
            await page.evaluate(() => document.querySelector('#player').dispatchEvent(new window.Event('loadeddata')));
            await page.waitForTimeout(150);
            await page.evaluate(() => {
                navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'Series S01E06' });
            });
        }

        await expect.poll(async () => {
            const logs = await contentLogs(context, extensionId);
            return logs.some(line => line.includes('Episode transition detected: "Series S01E06"'));
        }, { timeout: 3000 }).toBe(true);
        await page.close();
        await extensionMessage(context, extensionId, { type: 'CLEAR_LOGS' });
    };

    await runOrdering('title-first');
    await runOrdering('loadeddata-first');
});

test('discards source-swap pause/play churn after the episode is confirmed @episode-transition', async ({ context, extensionId, baseURL }) => {
    const url = `${baseURL}/pages/simple-player.html`;
    const page = await context.newPage();
    await page.goto(url);
    await prepareEpisodePage(page, 'Series S01E05', 11);
    await selectTargetTab(context, extensionId, url);
    await expect.poll(() => page.locator('#player').getAttribute('data-koala-attached')).toBe('true');
    const before = await extensionMessage(context, extensionId, { type: 'GET_HISTORY' });

    await page.evaluate(async () => {
        const video = document.querySelector('#player');
        video.pause();
        navigator.mediaSession.metadata = new window.MediaMetadata({ title: 'Series S01E06' });
        video.src = '../media/player-1080p-30s.mp4';
        video.load();
        await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
        await video.play();
    });

    await expect.poll(async () => {
        const logs = await contentLogs(context, extensionId);
        return logs.some(line => line.includes('Episode transition detected: "Series S01E06"'));
    }).toBe(true);
    await page.waitForTimeout(2300);
    expect(await extensionMessage(context, extensionId, { type: 'GET_HISTORY' })).toEqual(before);
});
