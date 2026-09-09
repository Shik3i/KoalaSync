import { normalizePeerUrl } from './peer-links.js';

// The job is stored before navigation. Closing the popup or restarting the
// service worker cannot lose the user's target selection.
export function createPeerNavigator({ api, getSelection, getRoomId, select, suspend, activate, failure, now = () => Date.now() }) {
    let generation = 0;
    let completing = false;
    let queuedCompletion = null;
    let starting = null;
    const key = 'pendingPeerNavigation';
    const isCurrent = (job, expected) => expected === generation
        && job.roomId === getRoomId() && job.tabId === getSelection();
    async function cancel() {
        const token = ++generation;
        await api.storage.session.remove(key);
        return token;
    }
    async function complete(tabId) {
        if (completing) { queuedCompletion = tabId; return; }
        completing = true;
        const expected = generation;
        let job;
        try {
            job = (await api.storage.session.get(key))[key];
            if (!job || job.tabId !== tabId) return;
            if (expected !== generation) return;
            if (job.roomId !== getRoomId() || job.tabId !== getSelection()) {
                await cancel();
                return;
            }
            if (now() - job.started > 45000) throw new Error('Peer navigation timed out');
            if (!job.issued) return;
            const tab = await api.tabs.get(tabId);
            if (!isCurrent(job, expected)) return;
            if (tab.status !== 'complete' || tab.url === 'about:blank' || tab.pendingUrl) return;
            if (!normalizePeerUrl(tab.url)) throw new Error('Invalid navigation destination');
            const response = await activate(tabId, tab.title || null);
            if (!isCurrent(job, expected)) return;
            await api.storage.session.remove(key);
            if (response.status !== 'ok' && response.status !== 'superseded') await failure(tabId, response);
        } catch (error) {
            if (job && isCurrent(job, expected)) {
                await api.storage.session.remove(key);
                await failure(tabId, error);
            }
        } finally {
            completing = false;
            const pending = queuedCompletion;
            queuedCompletion = null;
            if (pending !== null) await complete(pending);
        }
    }
    return {
        cancel,
        complete,
        async resume() {
            if (starting !== null) return;
            const expected = generation;
            const job = (await api.storage.session.get(key))[key];
            if (!job || expected !== generation) return;
            if (!job.issued && job.roomId === getRoomId() && job.tabId === getSelection()
                && now() - job.started <= 45000 && normalizePeerUrl(job.url)) {
                try {
                    await api.tabs.update(job.tabId, { url: job.url, active: true });
                    if (!isCurrent(job, expected)) return;
                    await api.storage.session.set({ [key]: { ...job, issued: true } });
                } catch (error) {
                    if (isCurrent(job, expected)) {
                        await api.storage.session.remove(key);
                        await failure(job.tabId, error);
                    }
                    return;
                }
            }
            await complete(job.tabId);
        },
        async navigate(rawUrl) {
            const url = normalizePeerUrl(rawUrl);
            if (!url || !getRoomId()) return { status: 'unavailable' };
            const expected = await cancel();
            if (expected !== generation) return { status: 'superseded' };
            const roomId = getRoomId();
            let tabId = getSelection();
            let expectedSelection = tabId;
            const current = () => expected === generation && roomId === getRoomId() && expectedSelection === getSelection();
            starting = expected;
            try {
                const originalSelection = tabId;
                let tab = tabId ? await api.tabs.get(tabId).catch(() => null) : null;
                if (expected !== generation || roomId !== getRoomId() || originalSelection !== getSelection()) return { status: 'superseded' };
                if (!tab) tab = await api.tabs.create({ url: 'about:blank', active: true });
                tabId = tab.id;
                if (!current()) return { status: 'superseded' };
                await suspend(current);
                if (!current()) return { status: 'superseded' };
                expectedSelection = tabId;
                await select(tabId, tab.title || null);
                if (!current()) return { status: 'superseded' };
                await api.storage.session.set({ [key]: { tabId, roomId, started: now(), url } });
                if (!current()) return { status: 'superseded' };
                await api.tabs.update(tabId, tab.url === url ? { active: true } : { url, active: true });
                if (!current()) return { status: 'superseded' };
                await api.storage.session.set({ [key]: { tabId, roomId, started: now(), url, issued: true } });
                await complete(tabId);
                return { status: 'navigating', tabId };
            } catch (error) {
                if (current()) {
                    await api.storage.session.remove(key);
                    if (tabId) await failure(tabId, error);
                }
                return { status: 'error' };
            } finally { if (starting === expected) starting = null; }
        }
    };
}
