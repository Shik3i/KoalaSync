import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { createPeerLinkSession, normalizePeerUrl, peerLinkHost, readPeerLinkPacket } from './peer-links.js';
import { createChatEnvelope } from '../server/chat.js';
import { decryptChatMessage, generateChatSecret } from './chat-crypto.js';
import { createChatSendLimiter } from './chat-session.js';

async function network(secrets = ['', '', ''], cryptoOverrides = []) {
    const sessions = [];
    const seen = [];
    const wire = [];
    const observations = [];
    async function add(secret = '') {
        const id = String(sessions.length + 1);
        const urls = new Map();
        seen.push(urls);
        const session = await createPeerLinkSession({ roomId: 'test-room', peerId: id, chatSecret: secret,
            cryptoImpl: cryptoOverrides[sessions.length] || globalThis.crypto,
            onUrl: (peer, url) => { urls.set(peer, url); observations.push({ recipient: id, peer, url }); }
        });
        sessions.push(session);
        for (const s of sessions) s.setPeers(sessions.map((_, i) => String(i + 1)));
        session.announce();
        return session;
    }
    async function drain() {
        let frames = 0;
        while (sessions.some(s => s.pending)) {
            for (let i = 0; i < sessions.length; i++) {
                const ciphertext = sessions[i].nextPacket();
                if (!ciphertext) continue;
                expect(++frames).toBeLessThan(2000);
                const envelope = createChatEnvelope({ ciphertext, senderId: 'spoof' }, String(i + 1));
                expect(envelope).not.toBeNull();
                const packet = readPeerLinkPacket(envelope.ciphertext);
                wire.push({ id: envelope.senderId, ciphertext, packet });
                for (const session of sessions) await session.receive(envelope.senderId, packet);
            }
        }
    }
    for (const secret of secrets) await add(secret);
    return { sessions, seen, wire, drain, add, observations };
}

describe('encrypted room-wide peer links through the unchanged chat envelope', () => {
    function backgroundHarness({ confirmed = true } = {}) {
        const source = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');
        const block = source.slice(source.indexOf('const peerUrls ='), source.indexOf('const peerNavigator ='));
        const callbacks = [];
        let published = null;
        const session = {
            publish: vi.fn(async value => { published = value; }),
            pending: true, urgent: false, setPeers() {}, announce() {}, close() {},
            nextPacket: vi.fn(() => published === null ? 'withdrawn' : 'url'),
            receive: vi.fn()
        };
        const env = {
            connectionGeneration: 1, currentRoom: { roomId: 'room', peers: [] }, peerId: 'me',
            currentTabId: 1, userSelectedTabId: 1, currentTargetHasVideo: true, normalizeTabId: v => v, normalizePeerUrl,
            serverSupportsChat: () => true, getSettings: async () => ({ roomId: 'room', chatKey: '' }),
            createPeerLinkSession: async () => session, addLog: vi.fn(),
            setTimeout: fn => { callbacks.push(fn); return callbacks.length; }, clearTimeout() {},
            chrome: { storage: { local: { get: vi.fn(async () => ({ roomId: 'room', shareVideoUrl: true })) } },
                tabs: { get: vi.fn(async () => ({ url: 'https://example.org/private' })) },
                runtime: { sendMessage: async () => {} } },
            socket: { readyState: 1 }, WebSocket: { OPEN: 1 }, isNamespaceJoined: true,
            chatSendLimiter: { take: vi.fn(() => ({ allowed: true })) }, PEER_LINK_CHAT_RESERVE: 4, EVENTS: { CHAT_MESSAGE: 'chat' }, emitLive: vi.fn()
        };
        vm.runInNewContext(block + `\nlinkDocumentConfirmed = ${confirmed};\nglobalThis.harness = { updatePeerLinks, revokeLocalPeerUrl };`, env);
        return { ...env.harness, env, session, callbacks };
    }
    it('does not republish a tab URL whose lookup finishes after privacy revocation', async () => {
        const h = backgroundHarness();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let reached;
        const started = new Promise(resolve => { reached = resolve; });
        h.env.chrome.tabs.get.mockImplementationOnce(async () => { reached(); await gate; return { url: 'https://example.org/private' }; });
        const updating = h.updatePeerLinks();
        await started;
        h.revokeLocalPeerUrl();
        release(); await updating;
        expect(h.session.publish.mock.calls).toEqual([[null]]);
    });
    it('stays inert when the relay does not advertise chat support', async () => {
        const h = backgroundHarness();
        const create = vi.fn(async () => h.session);
        h.env.createPeerLinkSession = create;
        h.env.serverSupportsChat = () => false;
        await h.updatePeerLinks();
        expect(create).not.toHaveBeenCalled();
        expect(h.env.chrome.tabs.get).not.toHaveBeenCalled();
        expect(h.env.emitLive).not.toHaveBeenCalled();
    });
    it.each([undefined, false, 'true', 1])('never reads the tab URL unless sharing is exactly enabled (%s)', async value => {
        const h = backgroundHarness();
        h.env.chrome.storage.local.get.mockResolvedValue({ roomId: 'room', shareVideoUrl: value });
        await h.updatePeerLinks();
        expect(h.env.chrome.tabs.get).not.toHaveBeenCalled();
        expect(h.session.publish).toHaveBeenCalledWith(null);
        expect(h.session.publish).not.toHaveBeenCalledWith(expect.any(String));
    });
    it.each([
        ['the selected target has no video', { currentTargetHasVideo: false }, true],
        ['the current document never showed a video', {}, false],
        ['activation of the selection is still pending', { currentTabId: null }, true]
    ])('does not read or share the tab URL while %s', async (_, overrides, confirmed) => {
        const h = backgroundHarness({ confirmed });
        Object.assign(h.env, overrides);
        await h.updatePeerLinks();
        expect(h.env.chrome.tabs.get).not.toHaveBeenCalled();
        expect(h.session.publish).not.toHaveBeenCalledWith(expect.any(String));
    });
    it('lets a queued withdrawal use the budget reserved for chat', async () => {
        const h = backgroundHarness();
        await h.updatePeerLinks();
        h.session.urgent = true;
        await h.callbacks[0]();
        expect(h.env.chatSendLimiter.take).toHaveBeenLastCalledWith({ reserve: 0 });
        h.session.urgent = false;
        await h.callbacks[1]();
        expect(h.env.chatSendLimiter.take).toHaveBeenLastCalledWith({ reserve: 4 });
    });
    it('publishes the tab URL once sharing is enabled (control)', async () => {
        const h = backgroundHarness();
        await h.updatePeerLinks();
        expect(h.env.chrome.tabs.get).toHaveBeenCalledOnce();
        expect(h.session.publish).toHaveBeenCalledWith('https://example.org/private');
    });
    it('checks the persisted privacy setting again before dispatching a queued URL', async () => {
        const h = backgroundHarness();
        await h.updatePeerLinks();
        h.env.chrome.storage.local.get.mockResolvedValue({ roomId: 'room', shareVideoUrl: false });
        await h.callbacks[0]();
        expect(h.env.emitLive).toHaveBeenCalledWith('chat', { ciphertext: 'withdrawn' });
    });
    it('converges for 25 participants with bounded key distribution', async () => {
        const n = await network(Array(25).fill(''));
        for (let i = 0; i < 25; i++) await n.sessions[i].publish(`https://example.org/${i}`);
        await n.drain();
        for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) {
            if (i !== j) expect(n.seen[i].get(String(j + 1))).toBe(`https://example.org/${j}`);
        }
        expect(n.wire.length).toBeLessThan(750);
    });
    it('does not disclose a withdrawn URL through a queued sender-key snapshot', async () => {
        const n = await network(['', '']);
        await n.sessions[0].publish('https://example.org/withdrawn');
        const hello0 = readPeerLinkPacket(n.sessions[0].nextPacket());
        const hello1 = readPeerLinkPacket(n.sessions[1].nextPacket());
        await n.sessions[0].receive('2', hello1);
        await n.sessions[1].receive('1', hello0);
        await n.sessions[0].publish(null);
        await n.drain();
        expect(n.observations.some(o => o.url === 'https://example.org/withdrawn')).toBe(false);
    });

    it('keeps the newest URL if older encryption finishes last', async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const real = globalThis.crypto;
        const delayed = {
            getRandomValues: bytes => real.getRandomValues(bytes),
            subtle: new Proxy(real.subtle, { get(target, key) {
                if (key === 'encrypt') return async (...args) => {
                    if (new globalThis.TextDecoder().decode(args[2]).includes('/older')) await gate;
                    return target.encrypt(...args);
                };
                return target[key].bind(target);
            } })
        };
        const n = await network(['', ''], [delayed]);
        await n.drain();
        const old = n.sessions[0].publish('https://example.org/older');
        await n.sessions[0].publish('https://example.org/newest');
        release(); await old; await n.drain();
        expect(n.seen[1].get('1')).toBe('https://example.org/newest');
    });

    it('does not replenish the socket send budget when chat settings change', () => {
        const source = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');
        const start = source.indexOf('function invalidateChatSession()');
        const code = source.slice(start, source.indexOf('\n}', start) + 2);
        const limiter = createChatSendLimiter({ now: () => 100 });
        for (let i = 0; i < 10; i++) expect(limiter.take().allowed).toBe(true);
        vm.runInNewContext(code + '\ninvalidateChatSession();', {
            chatSessionGeneration: 0, chatReceiveQueue: null, chatSendLimiter: limiter,
            chatEchoTracker: { reset() {} }, clearChatKeyCache() {}
        });
        expect(limiter.take().allowed).toBe(false);
    });
    it.each(['manual', 'shared'])('exchanges dynamic links for every pair: %s', async mode => {
        const secret = generateChatSecret();
        const n = await network(mode === 'manual' ? ['', '', ''] : [secret, secret, secret]);
        for (let i = 0; i < 3; i++) await n.sessions[i].publish(`https://example.org/video/${i}`);
        await n.drain();
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) expect(n.seen[i].get(String(j + 1))).toBe(`https://example.org/video/${j}`);
        await n.sessions[1].publish('https://example.org/changed#video');
        await n.drain();
        expect(n.seen[0].get('2')).toBe('https://example.org/changed#video');
        expect(n.seen[2].get('2')).toBe('https://example.org/changed#video');
        for (const frame of n.wire) {
            expect(Buffer.from(frame.ciphertext, 'base64url').toString()).not.toContain('example.org');
            await expect(decryptChatMessage({ ciphertext: frame.ciphertext, roomId: 'test-room', senderId: frame.id, secret })).rejects.toThrow();
        }
    });

    it('uses O(1) frames per peer when every participant holds the chat secret', async () => {
        const secret = generateChatSecret();
        const n = await network(Array(25).fill(secret));
        for (let i = 0; i < 25; i++) await n.sessions[i].publish(`https://example.org/${i}`);
        await n.drain();
        for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) {
            if (i !== j) expect(n.seen[i].get(String(j + 1))).toBe(`https://example.org/${j}`);
        }
        expect(n.wire.some(f => f.packet.t === 'key')).toBe(false);
        for (let i = 1; i <= 25; i++) expect(n.wire.filter(f => f.id === String(i)).length).toBeLessThanOrEqual(4);
        // A late joiner costs each peer one coalesced hello, group key, and URL; its own publish adds one.
        const before = n.wire.length;
        await n.add(secret);
        await n.sessions[25].publish('https://example.org/late');
        await n.drain();
        expect(n.wire.length - before).toBeLessThanOrEqual(26 * 3 + 1);
        for (let i = 0; i < 25; i++) expect(n.seen[i].get('26')).toBe('https://example.org/late');
        expect(n.seen[25].get('1')).toBe('https://example.org/0');
    });

    it('keeps secret holders and unkeyed peers apart instead of trusting the relay', async () => {
        const secret = generateChatSecret();
        const n = await network([secret, secret, '']);
        for (let i = 0; i < 3; i++) await n.sessions[i].publish(`https://example.org/${i}`);
        await n.drain();
        expect(n.seen[0].get('2')).toBe('https://example.org/1');
        expect(n.seen[1].get('1')).toBe('https://example.org/0');
        for (const [recipient, sender] of [[0, '3'], [1, '3'], [2, '1'], [2, '2']]) expect(n.seen[recipient].get(sender) ?? null).toBeNull();
        expect(n.wire.filter(f => f.packet.t === 'gkey').map(f => f.id).sort()).toEqual(['1', '2']);
        expect(n.wire.some(f => f.packet.t === 'key')).toBe(false);
    });

    it('does not exchange links between different chat secrets', async () => {
        const n = await network([generateChatSecret(), generateChatSecret()]);
        await n.sessions[0].publish('https://example.org/a');
        await n.sessions[1].publish('https://example.org/b');
        await n.drain();
        expect(n.wire.some(f => f.packet.t === 'gkey' || f.packet.t === 'key')).toBe(false);
        expect(n.seen[0].get('2') ?? null).toBeNull();
        expect(n.seen[1].get('1') ?? null).toBeNull();
    });

    it('never hands a sender key to a relay that strips the tag from a forged hello', async () => {
        const secret = generateChatSecret();
        const n = await network([secret, secret]);
        await n.sessions[1].publish('https://example.org/private?session=1');
        await n.drain();
        expect(n.seen[0].get('2')).toBe('https://example.org/private?session=1');
        const relayKeys = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const p = Buffer.from(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', relayKeys.publicKey))).toString('base64url');
        // The relay impersonates peer 1 with its own key and no tag.
        await n.sessions[1].receive('1', { t: 'hello', s: 'F'.repeat(22), p, a: '' });
        const answered = [];
        while (n.sessions[1].pending) answered.push(readPeerLinkPacket(n.sessions[1].nextPacket()).t);
        expect(answered).not.toContain('key');
        // The genuine session is left intact.
        await n.sessions[1].publish('https://example.org/private?session=2');
        await n.drain();
        expect(n.seen[0].get('2')).toBe('https://example.org/private?session=2');
    });

    it('drops a peer that restarts without the shared secret', async () => {
        const secret = generateChatSecret();
        const n = await network([secret, secret]);
        await n.sessions[0].publish('https://example.org/keyed');
        await n.drain();
        expect(n.seen[1].get('1')).toBe('https://example.org/keyed');
        const unkeyed = await createPeerLinkSession({ roomId: 'test-room', peerId: '1' });
        unkeyed.setPeers(['1', '2']);
        unkeyed.announce();
        await n.sessions[1].receive('1', readPeerLinkPacket(unkeyed.nextPacket()));
        expect(n.seen[1].get('1')).toBeNull();
    });

    it('rejects a participant that copies a chat-secret tag without knowing the secret', async () => {
        const secret = generateChatSecret();
        const n = await network([secret, '']);
        const hello0 = readPeerLinkPacket(n.sessions[0].nextPacket());
        const hello1 = readPeerLinkPacket(n.sessions[1].nextPacket());
        await n.sessions[1].receive('1', hello0);
        await n.sessions[0].receive('2', { ...hello1, a: hello0.a });
        await n.sessions[1].publish('https://example.org/forged');
        let rejected = 0;
        while (n.sessions[1].pending) {
            try { await n.sessions[0].receive('2', readPeerLinkPacket(n.sessions[1].nextPacket())); } catch (_) { rejected++; }
        }
        expect(rejected).toBe(0);
        expect(n.seen[0].get('2')).toBeNull();
    });

    it('rejects tampered, replayed, or misaddressed group keys', async () => {
        const secret = generateChatSecret();
        const n = await network([secret, secret]);
        await n.drain();
        const group = n.wire.find(f => f.id === '1' && f.packet.t === 'gkey');
        const bytes = Buffer.from(group.packet.c, 'base64url'); bytes[20] ^= 1;
        n.sessions[1].setPeers(['2']);
        n.sessions[1].setPeers(['1', '2']);
        await n.sessions[1].receive('1', readPeerLinkPacket(n.wire.find(f => f.id === '1' && f.packet.t === 'hello').ciphertext));
        await expect(n.sessions[1].receive('1', { ...group.packet, c: bytes.toString('base64url') })).rejects.toThrow();
        await n.sessions[1].receive('1', { ...group.packet, s: 'B'.repeat(22) });
        await n.sessions[1].receive('1', group.packet);
        await n.sessions[0].publish('https://example.org/after-tamper');
        await n.drain();
        expect(n.seen[1].get('1')).toBe('https://example.org/after-tamper');
    });

    it('sends a withdrawal ahead of queued handshake frames', async () => {
        const n = await network(['', '', '']);
        await n.sessions[0].publish('https://example.org/revoked');
        expect(n.sessions[0].urgent).toBe(false);
        await n.sessions[0].publish(null);
        expect(n.sessions[0].urgent).toBe(true);
        const first = readPeerLinkPacket(n.sessions[0].nextPacket());
        expect(first.t).toBe('url');
        expect(n.sessions[0].urgent).toBe(false);
        const second = readPeerLinkPacket(n.sessions[0].nextPacket());
        expect(second.t).toBe('hello');
        // Once sent, the withdrawal no longer outranks later handshakes.
        await n.sessions[0].publish('https://example.org/again');
        n.sessions[0].announce();
        expect(readPeerLinkPacket(n.sessions[0].nextPacket()).t).toBe('hello');
        expect(readPeerLinkPacket(n.sessions[0].nextPacket()).t).toBe('url');
    });

    it('supplies a late joiner without a selected video and clears withdrawn links', async () => {
        const n = await network(['', '']);
        await n.sessions[0].publish('https://example.org/first');
        await n.drain();
        await n.add();
        await n.drain();
        expect(n.seen[2].get('1')).toBe('https://example.org/first');
        await n.sessions[0].publish(null);
        await n.drain();
        expect(n.seen[1].get('1')).toBeNull();
        expect(n.seen[2].get('1')).toBeNull();
    });

    it('rejects tampering and replay, coalesces updates, and ignores departed peers', async () => {
        const n = await network(['', '']);
        await n.drain();
        const firstUpdate = n.wire.length;
        await n.sessions[0].publish('https://example.org/old');
        await n.drain();
        const old = n.wire.slice(firstUpdate).find(f => f.id === '1' && f.packet.t === 'url');
        await n.sessions[0].publish('https://example.org/middle');
        await n.sessions[0].publish('https://example.org/new');
        await n.drain();
        expect(n.wire.slice(firstUpdate).filter(f => f.packet.t === 'url')).toHaveLength(2);
        await n.sessions[1].receive('1', old.packet);
        expect(n.seen[1].get('1')).toBe('https://example.org/new');
        const bytes = Buffer.from(old.packet.c, 'base64url'); bytes[20] ^= 1;
        await expect(n.sessions[1].receive('1', { ...old.packet, c: bytes.toString('base64url') })).rejects.toThrow();
        n.sessions[1].setPeers(['2']);
        await n.sessions[1].receive('1', old.packet);
        expect(n.seen[1].get('1')).toBeNull();
        for (const s of n.sessions) { s.close(); s.announce(); await s.publish('https://example.org/closed'); expect(s.nextPacket()).toBeNull(); }
    });

    it('recovers a restarted peer with a new ephemeral key and refuses unrelated epochs', async () => {
        const n = await network(['', '']);
        await n.sessions[0].publish('https://example.org/old'); await n.drain();
        n.sessions[0].close();
        n.sessions[0] = await createPeerLinkSession({ roomId: 'test-room', peerId: '1' });
        n.sessions[0].setPeers(['1', '2']);
        n.sessions[0].announce();
        await n.sessions[0].publish('https://example.org/restarted'); await n.drain();
        expect(n.seen[1].get('1')).toBe('https://example.org/restarted');
        await n.sessions[1].receive('1', { t: 'url', s: 'A'.repeat(22), c: 'invalid' });
        expect(n.seen[1].get('1')).toBe('https://example.org/restarted');
    });

    it('holds a URL received before its encrypted sender key', async () => {
        const n = await network(['', '']);
        const hello0 = readPeerLinkPacket(n.sessions[0].nextPacket());
        const hello1 = readPeerLinkPacket(n.sessions[1].nextPacket());
        await n.sessions[0].receive('2', hello1);
        await n.sessions[1].receive('1', hello0);
        await n.sessions[0].publish('https://example.org/out-of-order');
        const packets = [];
        while (n.sessions[0].pending) packets.push(readPeerLinkPacket(n.sessions[0].nextPacket()));
        await n.sessions[1].receive('1', packets.find(p => p.t === 'url'));
        await n.sessions[1].receive('1', packets.find(p => p.t === 'key'));
        expect(n.seen[1].get('1')).toBe('https://example.org/out-of-order');
    });

    it('names the destination host, flags insecure schemes, and exposes look-alike domains', () => {
        expect(peerLinkHost('https://www.example.org/watch?v=1#t=2')).toBe('www.example.org');
        expect(peerLinkHost('https://example.org:8443/x')).toBe('example.org:8443');
        expect(peerLinkHost('http://192.168.0.5/video')).toBe('http://192.168.0.5');
        expect(peerLinkHost('https://exаmple.org/')).toBe('xn--exmple-4nf.org');
        for (const bad of [null, '', 'javascript:alert(1)', 'https://user:pw@example.org/']) expect(peerLinkHost(bad)).toBe('');
    });

    it('bounds URLs and packets; retains content-identifying query and hash', async () => {
        expect(normalizePeerUrl('https://example.org/watch?v=1#/item/2')).toBe('https://example.org/watch?v=1#/item/2');
        for (const bad of [null, '', 'javascript:alert(1)', 'file:///secret', 'https://user:pass@example.org', 'https://example.org/\n', 'https://example.org/' + 'a'.repeat(901)]) expect(normalizePeerUrl(bad)).toBeNull();
        for (const bad of [null, 'a', '%%%%', 'A'.repeat(3000), Buffer.from('ordinary chat bytes'.repeat(200)).toString('base64url')]) expect(readPeerLinkPacket(bad)).toBeNull();
        const n = await network(['', '']);
        await n.sessions[0].publish('https://example.org/' + 'a'.repeat(850)); await n.drain();
        expect(n.seen[1].get('1')).toHaveLength(870);
    });
});
