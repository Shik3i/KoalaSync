import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPeerNavigator } from './peer-navigation.js';

function setup(selected = 1) {
    let selection = selected;
    let room = 'room';
    let time = 100;
    const storage = {};
    const tabs = new Map(selected ? [[1, { id: 1, url: 'https://example.org/old', status: 'complete', title: 'Old' }]] : []);
    const api = {
        storage: { session: {
            get: vi.fn(async () => ({ ...storage })),
            set: vi.fn(async value => Object.assign(storage, value)),
            remove: vi.fn(async key => { delete storage[key]; })
        } },
        tabs: {
            get: vi.fn(async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return { ...tabs.get(id) }; }),
            create: vi.fn(async props => { const tab = { id: 2, status: 'complete', ...props }; tabs.set(2, tab); return tab; }),
            update: vi.fn(async (id, props) => Object.assign(tabs.get(id), props, props.url ? { status: 'loading' } : {}))
        }
    };
    const activate = vi.fn(async () => ({ status: 'ok' }));
    const failure = vi.fn();
    const suspend = vi.fn();
    const options = { api, getSelection: () => selection, getRoomId: () => room, select: async id => { selection = id; }, suspend, activate, failure, now: () => time };
    const navigator = createPeerNavigator(options);
    return { navigator, options, api, tabs, storage, activate, failure, suspend, setRoom: v => { room = v; }, setTime: v => { time = v; }, setSelection: v => { selection = v; } };
}

describe('peer click navigation', () => {
    it.each(['monitor', 'target'])('stops old cleanup when selection changes during %s deactivation', async phase => {
        const source = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');
        const start = source.indexOf('async function deactivateTargetTab(');
        const code = source.slice(start, source.indexOf('\nfunction createHostAccessRequiredError', start));
        let current = true;
        const sendMessageToFrame = vi.fn(async () => { if (phase === 'target') current = false; });
        const env = {
            normalizeTabId: id => id, normalizeFrameId: id => id,
            deactivateMediaFrameMonitors: async () => { if (phase === 'monitor') current = false; },
            resetAudioProcessingInTab: vi.fn(), sendMessageToFrame,
            shouldContinue: () => current
        };
        await vm.runInNewContext(code + '\ndeactivateTargetTab(1, { frameId: 2 }, { shouldContinue });', env);
        expect(sendMessageToFrame.mock.calls.some(call => call[2].type === 'CHAT_DESTROY')).toBe(false);
        expect(sendMessageToFrame).toHaveBeenCalledTimes(phase === 'monitor' ? 0 : 1);
    });
    it('ignores a late tab error after switching rooms', async () => {
        const h = setup();
        await h.navigator.navigate('https://example.org/new');
        h.api.tabs.get.mockImplementationOnce(async () => { h.setRoom('other'); throw new Error('Tab closed'); });
        await h.navigator.complete(1);
        expect(h.failure).not.toHaveBeenCalled();
    });
    it('does not override a selection made while creating the new tab', async () => {
        const h = setup(null);
        h.api.tabs.create.mockImplementationOnce(async () => { h.setSelection(3); return { id: 2 }; });
        expect(await h.navigator.navigate('https://example.org/new')).toMatchObject({ status: 'superseded' });
        expect(h.options.getSelection()).toBe(3);
        expect(h.suspend).not.toHaveBeenCalled();
        expect(h.api.tabs.update).not.toHaveBeenCalled();
    });
    it.each(['room', 'selection'])('revalidates %s after the browser tab lookup', async changed => {
        const h = setup();
        await h.navigator.navigate('https://example.org/new');
        h.tabs.get(1).status = 'complete';
        h.api.tabs.get.mockImplementationOnce(async () => {
            if (changed === 'room') h.setRoom('other'); else h.setSelection(2);
            return { ...h.tabs.get(1) };
        });
        await h.navigator.complete(1);
        expect(h.activate).not.toHaveBeenCalled();
    });
    it.each([1, null])('navigates and activates the requested target, selection=%s', async selection => {
        const h = setup(selection);
        const response = await h.navigator.navigate('https://example.org/new');
        const id = selection || 2;
        expect(response).toEqual({ status: 'navigating', tabId: id });
        expect(h.options.getSelection()).toBe(id);
        expect(h.activate).not.toHaveBeenCalled();
        expect(h.storage.pendingPeerNavigation.tabId).toBe(id);
        h.tabs.get(id).status = 'complete';
        await h.navigator.complete(id);
        expect(h.activate).toHaveBeenCalledWith(id, selection ? 'Old' : null);
        expect(h.storage.pendingPeerNavigation).toBeUndefined();
        expect(h.api.tabs.create).toHaveBeenCalledTimes(selection ? 0 : 1);
    });
    it('does not reload an already matching URL', async () => {
        const h = setup();
        await h.navigator.navigate('https://example.org/old');
        expect(h.api.tabs.update).toHaveBeenCalledWith(1, { active: true });
        expect(h.activate).toHaveBeenCalledOnce();
    });
    it('recovers after popup/worker shutdown using the stored job', async () => {
        const h = setup();
        await h.navigator.navigate('https://example.org/new');
        h.tabs.get(1).status = 'complete';
        await createPeerNavigator(h.options).resume();
        expect(h.activate).toHaveBeenCalledOnce();
    });
    it('creates a target when a previously selected tab disappeared', async () => {
        const h = setup(); h.tabs.clear();
        expect(await h.navigator.navigate('https://example.org/new')).toMatchObject({ tabId: 2 });
    });
    it('resumes a worker stopped between saving the job and issuing navigation', async () => {
        const h = setup();
        h.storage.pendingPeerNavigation = { tabId: 1, roomId: 'room', started: 100, url: 'https://example.org/new' };
        await h.navigator.resume();
        expect(h.api.tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.org/new', active: true });
        expect(h.activate).not.toHaveBeenCalled();
        h.tabs.get(1).status = 'complete';
        await h.navigator.resume();
        expect(h.activate).toHaveBeenCalledOnce();
    });
    it.each(['room', 'selection', 'cancel'])('does not activate a superseded navigation: %s', async change => {
        const h = setup(); await h.navigator.navigate('https://example.org/new');
        if (change === 'room') h.setRoom('other');
        if (change === 'selection') h.setSelection(3);
        if (change === 'cancel') await h.navigator.cancel();
        h.tabs.get(1).status = 'complete'; await h.navigator.complete(1);
        expect(h.activate).not.toHaveBeenCalled();
    });
    it('bounds load time and reports a closed or forbidden destination', async () => {
        for (const mode of ['timeout', 'closed', 'forbidden']) {
            const h = setup(); await h.navigator.navigate('https://example.org/new');
            if (mode === 'timeout') h.setTime(50000);
            if (mode === 'closed') h.tabs.clear();
            if (mode === 'forbidden') Object.assign(h.tabs.get(1), { status: 'complete', url: 'chrome://settings' });
            await h.navigator.complete(1);
            expect(h.failure).toHaveBeenCalledOnce();
            expect(h.storage.pendingPeerNavigation).toBeUndefined();
        }
    });
    it('retains access errors for the existing site-access flow', async () => {
        const h = setup(); h.activate.mockResolvedValue({ status: 'host_permission_required' });
        await h.navigator.navigate('https://example.org/old');
        expect(h.failure).toHaveBeenCalledWith(1, { status: 'host_permission_required' });
    });
    it('rejects unsafe links and does nothing outside a room', async () => {
        const h = setup();
        expect(await h.navigator.navigate('javascript:alert(1)')).toEqual({ status: 'unavailable' });
        h.setRoom(null);
        expect(await h.navigator.navigate('https://example.org/new')).toEqual({ status: 'unavailable' });
        expect(h.suspend).not.toHaveBeenCalled();
    });
    it('allows only the latest simultaneous click to navigate', async () => {
        const h = setup();
        const results = await Promise.all([h.navigator.navigate('https://example.org/a'), h.navigator.navigate('https://example.org/b')]);
        expect(results[0].status).toBe('superseded');
        expect(h.api.tabs.update).toHaveBeenCalledTimes(1);
        expect(h.tabs.get(1).url).toBe('https://example.org/b');
    });
    it('does not save an obsolete job when the room changes while selection is being saved', async () => {
        const h = setup();
        const navigator = createPeerNavigator({ ...h.options, select: async () => { h.setRoom('other'); } });
        expect(await navigator.navigate('https://example.org/new')).toMatchObject({ status: 'superseded' });
        expect(h.storage.pendingPeerNavigation).toBeUndefined();
        expect(h.api.tabs.update).not.toHaveBeenCalled();
    });
});
