import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    HOST_ACCESS_REQUIRED_STATUS,
    addTabHostAccessRequest,
    describeTabUrl,
    inspectTabHostAccess,
    isHostAccessError,
    normalizeTabId,
    removeTabHostAccessRequest,
    requestOriginPermission
} from './host-access.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('host access helpers', () => {
    afterEach(() => vi.useRealTimers());

    it('normalizes only positive safe tab IDs', () => {
        expect(HOST_ACCESS_REQUIRED_STATUS).toBe('host_permission_required');
        for (const invalid of [null, undefined, '', 0, true, [42], '42.5', Number.MAX_SAFE_INTEGER + 1]) {
            expect(normalizeTabId(invalid)).toBeNull();
        }
        expect(normalizeTabId('42')).toBe(42);
        expect(normalizeTabId(' 42 ')).toBe(42);
    });

    it('describes supported origins with Firefox-compatible localhost permissions', () => {
        expect(describeTabUrl('https://emby.example:8443/web/index.html')).toEqual({
            url: 'https://emby.example:8443/web/index.html',
            host: 'emby.example:8443',
            originPattern: 'https://emby.example:8443/*'
        });
        expect(describeTabUrl('http://localhost:8096/web/', { includePort: false })).toEqual({
            url: 'http://localhost:8096/web/',
            host: 'localhost:8096',
            originPattern: 'http://localhost/*'
        });
        expect(describeTabUrl('chrome://extensions/')).toBeNull();
        expect(describeTabUrl('not a url')).toBeNull();
        expect(describeTabUrl('file:///Users/koala/movie.mp4')).toEqual({
            url: 'file:///Users/koala/movie.mp4',
            host: 'local file',
            originPattern: 'file:///*'
        });
    });

    it('checks the selected tab origin and preserves an unknown callback result', async () => {
        let containsRequest;
        const deniedChrome = {
            tabs: { get: async tabId => ({ id: tabId, url: 'https://video.example/watch' }) },
            permissions: {
                contains: async request => {
                    containsRequest = request;
                    return false;
                }
            }
        };
        await expect(inspectTabHostAccess(deniedChrome, 42)).resolves.toMatchObject({
            granted: false,
            host: 'video.example',
            originPattern: 'https://video.example/*'
        });
        expect(containsRequest).toEqual({ origins: ['https://video.example/*'] });

        const unknownChrome = {
            runtime: {},
            tabs: { get: async tabId => ({ id: tabId, url: 'https://video.example/watch' }) },
            permissions: { contains: (_request, callback) => callback(undefined) }
        };
        await expect(inspectTabHostAccess(unknownChrome, 42)).resolves.toMatchObject({ granted: null });
    });

    it('uses Firefox host patterns without ports', async () => {
        let containsRequest;
        const chromeApi = {
            runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) },
            tabs: {
                get: async tabId => ({
                    id: tabId,
                    url: 'http://localhost:8096/web/',
                    pendingUrl: 'https://different.example/loading'
                })
            },
            permissions: {
                contains: async request => {
                    containsRequest = request;
                    return false;
                }
            }
        };
        await expect(inspectTabHostAccess(chromeApi, 42)).resolves.toMatchObject({
            host: 'localhost:8096',
            originPattern: 'http://localhost/*'
        });
        expect(containsRequest).toEqual({ origins: ['http://localhost/*'] });
    });

    it('adds, removes, and requests permissions through promise and callback APIs', async () => {
        let added;
        expect(await addTabHostAccessRequest({
            permissions: { addHostAccessRequest: async request => { added = request; } }
        }, 42, 'https://video.example/*')).toBe(true);
        expect(added).toEqual({ tabId: 42, pattern: 'https://video.example/*' });
        expect(await addTabHostAccessRequest({ permissions: {} }, 42)).toBe(false);

        let removed;
        expect(await removeTabHostAccessRequest({
            permissions: { removeHostAccessRequest: async request => { removed = request; } }
        }, 42, 'https://video.example/*')).toBe(true);
        expect(removed).toEqual({ tabId: 42, pattern: 'https://video.example/*' });
        expect(await removeTabHostAccessRequest({ permissions: {} }, 42)).toBe(false);

        const callbackChrome = {
            runtime: {},
            permissions: { request: (_request, callback) => callback(true) }
        };
        await expect(requestOriginPermission(callbackChrome, 'https://video.example/*')).resolves.toBe(true);
        await expect(requestOriginPermission({ permissions: {} }, 'https://video.example/*')).resolves.toBeNull();
        await expect(requestOriginPermission(callbackChrome, '')).resolves.toBeNull();
        await expect(requestOriginPermission({
            permissions: { request: async () => { throw new Error('denied'); } }
        }, 'https://video.example/*')).resolves.toBe(false);
        await expect(addTabHostAccessRequest({
            permissions: { addHostAccessRequest: async () => { throw new Error('denied'); } }
        }, 42)).resolves.toBe(false);
        await expect(removeTabHostAccessRequest({
            permissions: { removeHostAccessRequest: async () => { throw new Error('denied'); } }
        }, 42)).resolves.toBe(false);
        expect(isHostAccessError(new Error('Missing host permission for the tab'))).toBe(true);
        expect(isHostAccessError(new Error('No tab with id: 42'))).toBe(false);
    });

    it('treats permission inspection errors and timeouts as advisory unknowns', async () => {
        const base = {
            tabs: { get: async () => ({ url: 'https://video.example/watch' }) }
        };
        await expect(inspectTabHostAccess({
            ...base,
            permissions: { contains: async () => { throw new Error('permission API failed'); } }
        }, 42)).resolves.toMatchObject({ granted: null });

        await expect(inspectTabHostAccess({
            ...base,
            runtime: { lastError: { message: 'permission callback failed' } },
            permissions: { contains: (_request, callback) => callback(false) }
        }, 42)).resolves.toMatchObject({ granted: null });

        vi.useFakeTimers();
        const pending = inspectTabHostAccess({
            ...base,
            permissions: { contains: () => undefined }
        }, 42);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toMatchObject({ granted: null });
    });
});

describe('host access recovery contracts', () => {
    it('keeps activation, permission recovery, and target identity guarded', () => {
        const background = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');
        const popup = fs.readFileSync(path.join(repoRoot, 'extension/popup.js'), 'utf8');
        const popupHtml = fs.readFileSync(path.join(repoRoot, 'extension/popup.html'), 'utf8');
        const tabManager = fs.readFileSync(path.join(repoRoot, 'extension/modules/tab-manager.js'), 'utf8');

        expect(background).toMatch(/await activateTargetTab\((?:message\.tabId|selectedTabId), message\.tabTitle\)/);
        expect(background).toMatch(/addTabHostAccessRequest\(chrome, tabId, access\.originPattern\)/);
        expect(background).toMatch(/retryPendingTarget\(\)/);
        expect(background).toMatch(/activationGeneration !== targetActivationGeneration/);
        expect(background).toMatch(/pendingTargetRequestId/);
        expect(background).toMatch(/addedOrigins\.includes\(pending\.originPattern\)/);
        expect(background).toMatch(/isCurrentTargetIdentity\(tabId, targetGeneration\)/);
        expect(background).toMatch(/message\.expectedTabId/);
        expect(background).toMatch(/completeForceSyncBeforeTargetChange\(selectedTabId\)/);
        expect(background).toMatch(/FORCE_SYNC_ACK'[\s\S]*ignored_unselected_tab/);
        expect(background).toMatch(/removeTabHostAccessRequest\([\s\S]*pendingTabId/);

        const activationBody = background.slice(
            background.indexOf('async function activateTargetTab'),
            background.indexOf('async function retryPendingTarget')
        );
        expect(activationBody.indexOf('await injectContentScript')).toBeLessThan(
            activationBody.indexOf('currentTabId = selectedTabId')
        );
        expect(popup).toMatch(/response\?\.status === 'host_permission_required'/);
        expect(popup).toMatch(/requestOriginPermission\(chrome, requestedOriginPattern\)/);
        expect(popup).toMatch(/expectedCurrentTabId: tabId/);
        expect(popup).toMatch(/expectedTabId: tabId/);
        expect(tabManager).not.toMatch(/injectContentScript/);
        expect((background.match(/tabs\.onRemoved\.addListener/g) || []).length
            + (tabManager.match(/tabs\.onRemoved\.addListener/g) || []).length).toBe(1);
        expect(popupHtml).toMatch(/id="siteAccessNotice"/);
    });
});
