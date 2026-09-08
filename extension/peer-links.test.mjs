import { Buffer } from 'node:buffer';
import { describe, it, expect } from 'vitest';
import { createPeerLinkSession, normalizePeerUrl, readPeerLinkPacket } from './peer-links.js';
import { createChatEnvelope } from '../server/chat.js';
import { decryptChatMessage, generateChatSecret } from './chat-crypto.js';

async function network(secrets = ['', '', '']) {
    const sessions = [];
    const seen = [];
    const wire = [];
    async function add(secret = '') {
        const id = String(sessions.length + 1);
        const urls = new Map();
        seen.push(urls);
        const session = await createPeerLinkSession({ roomId: 'test-room', peerId: id, chatSecret: secret, onUrl: (peer, url) => urls.set(peer, url) });
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
                expect(++frames).toBeLessThan(500);
                const envelope = createChatEnvelope({ ciphertext, senderId: 'spoof' }, String(i + 1));
                expect(envelope).not.toBeNull();
                const packet = readPeerLinkPacket(envelope.ciphertext);
                wire.push({ id: envelope.senderId, ciphertext, packet });
                for (const session of sessions) await session.receive(envelope.senderId, packet);
            }
        }
    }
    for (const secret of secrets) await add(secret);
    return { sessions, seen, wire, drain, add };
}

describe('encrypted room-wide peer links through the unchanged chat envelope', () => {
    it.each(['manual', 'shared', 'mixed'])('exchanges dynamic links for every pair: %s', async mode => {
        const secret = generateChatSecret();
        const n = await network(mode === 'manual' ? ['', '', ''] : mode === 'shared' ? [secret, secret, secret] : [secret, '', secret]);
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
        await n.sessions[0].publish('https://example.org/old');
        await n.drain();
        const old = n.wire.find(f => f.id === '1' && f.packet.t === 'url');
        await n.sessions[0].publish('https://example.org/middle');
        await n.sessions[0].publish('https://example.org/new');
        await n.drain();
        expect(n.wire.filter(f => f.packet.t === 'url')).toHaveLength(2);
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

    it('bounds URLs and packets; retains content-identifying query and hash', async () => {
        expect(normalizePeerUrl('https://example.org/watch?v=1#/item/2')).toBe('https://example.org/watch?v=1#/item/2');
        for (const bad of [null, '', 'javascript:alert(1)', 'file:///secret', 'https://user:pass@example.org', 'https://example.org/\n', 'https://example.org/' + 'a'.repeat(901)]) expect(normalizePeerUrl(bad)).toBeNull();
        for (const bad of [null, 'a', '%%%%', 'A'.repeat(3000), Buffer.from('ordinary chat bytes'.repeat(200)).toString('base64url')]) expect(readPeerLinkPacket(bad)).toBeNull();
        const n = await network(['', '']);
        await n.sessions[0].publish('https://example.org/' + 'a'.repeat(850)); await n.drain();
        expect(n.seen[1].get('1')).toHaveLength(870);
    });
});
