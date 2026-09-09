// An extension-only subprotocol inside the existing opaque chat relay envelope.
// URLs and sender keys are encrypted; only ephemeral public keys and routing
// metadata are public. Without a shared chat secret, ECDH trusts relay identity.
const PREFIX = 'KoalaSyncLinks1:';
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
const encode = bytes => globalThis.btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value) {
    if (typeof value !== 'string' || value.length > 2800 || !/^[\w-]+$/.test(value)) throw new Error('Invalid encoding');
    const bytes = Uint8Array.from(globalThis.atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (encode(bytes) !== value) throw new Error('Noncanonical encoding');
    return bytes;
}

export function normalizePeerUrl(value) {
    if (typeof value !== 'string' || encoder.encode(value).length > 900 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
        return encoder.encode(url.href).length <= 900 ? url.href : null;
    } catch (_) { return null; }
}

export function readPeerLinkPacket(ciphertext) {
    try {
        const bytes = decode(ciphertext);
        if (bytes.length > 2028) return null;
        const text = decoder.decode(bytes);
        if (!text.startsWith(PREFIX)) return null;
        const data = JSON.parse(text.slice(PREFIX.length));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) { return null; }
}

export async function createPeerLinkSession({ roomId, peerId, chatSecret = '', onUrl = () => {}, cryptoImpl = globalThis.crypto }) {
    const subtle = cryptoImpl.subtle;
    const random = length => cryptoImpl.getRandomValues(new Uint8Array(length));
    const epoch = encode(random(16));
    const keys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKey = encode(new Uint8Array(await subtle.exportKey('raw', keys.publicKey)));
    const secret = chatSecret ? decode(chatSecret) : new Uint8Array();
    const tag = secret.length ? encode(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(`${roomId}|${chatSecret}`))).slice(0, 16)) : '';
    const senderRaw = random(32);
    const senderKey = await subtle.importKey('raw', senderRaw, 'AES-GCM', false, ['encrypt']);
    let revision = 0;
    let url = null;
    let closed = false;
    const members = new Set();
    const peers = new Map();
    const outbox = new Map();
    const hello = { t: 'hello', s: epoch, p: publicKey, a: tag };

    function queue(id, packet) {
        if (closed) return;
        const bytes = encoder.encode(PREFIX + JSON.stringify(packet));
        if (bytes.length > 2028) throw new Error('Peer link envelope too large');
        outbox.set(id, encode(bytes));
    }
    const aad = (sender, session, kind, recipient = '') => encoder.encode(JSON.stringify(['peer-links-v1', roomId, sender, session, kind, recipient]));
    async function encrypt(key, value, additionalData) {
        const iv = random(12);
        const body = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, encoder.encode(JSON.stringify(value))));
        return encode(new Uint8Array([...iv, ...body]));
    }
    async function decrypt(key, value, additionalData) {
        const bytes = decode(value);
        return JSON.parse(decoder.decode(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData }, key, bytes.slice(12))));
    }
    async function pairKey(id, packet) {
        const remote = await subtle.importKey('raw', decode(packet.p), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: remote }, keys.privateKey, 256));
        const sharedChat = tag && packet.a === tag ? secret : new Uint8Array();
        const material = await subtle.importKey('raw', new Uint8Array([...bits, ...sharedChat]), 'HKDF', false, ['deriveKey']);
        const participants = [[peerId, epoch], [id, packet.s]].sort((a, b) => a[0] < b[0] ? -1 : 1);
        return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(roomId), info: encoder.encode(JSON.stringify(['peer-links-v1', participants])) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    function accept(id, entry, value) {
        if (closed || peers.get(id) !== entry || !Number.isSafeInteger(value.r) || value.r < 0 || value.r <= entry.revision) return;
        if (value.u !== null && normalizePeerUrl(value.u) !== value.u) return;
        entry.revision = value.r;
        onUrl(id, value.u);
    }
    async function queueUrl() {
        const expectedRevision = revision;
        const c = await encrypt(senderKey, { r: revision, u: url }, aad(peerId, epoch, 'url'));
        if (expectedRevision === revision) queue('url', { t: 'url', s: epoch, c });
    }
    async function sendKey(id, entry) {
        // Key distribution must never retain a URL that can subsequently be
        // withdrawn. The separately coalesced URL frame supplies late joiners.
        const c = await encrypt(entry.pair, { k: encode(senderRaw) }, aad(peerId, epoch, 'key', `${id}|${entry.epoch}`));
        if (peers.get(id) === entry) {
            queue(`key:${id}`, { t: 'key', s: epoch, to: id, d: entry.epoch, c });
            await queueUrl();
        }
    }
    async function receive(id, packet) {
        if (closed || !members.has(id) || id === peerId || !packet || typeof packet.s !== 'string' || !/^[\w-]{22}$/.test(packet.s)) return;
        if (packet.t === 'hello') {
            if (typeof packet.p !== 'string' || decode(packet.p).length !== 65 || typeof packet.a !== 'string' || packet.a.length > 22) return;
            const previous = peers.get(id);
            if (previous?.epoch === packet.s) return;
            const pair = await pairKey(id, packet);
            if (closed || !members.has(id)) return;
            const entry = { epoch: packet.s, pair, key: null, revision: -1, pending: null };
            peers.set(id, entry);
            onUrl(id, null);
            queue('hello', hello);
            await sendKey(id, entry);
            return;
        }
        const entry = peers.get(id);
        if (!entry || entry.epoch !== packet.s) return;
        if (packet.t === 'key' && packet.to === peerId && packet.d === epoch) {
            const value = await decrypt(entry.pair, packet.c, aad(id, packet.s, 'key', `${peerId}|${epoch}`));
            const raw = decode(value.k);
            if (raw.length !== 32) return;
            entry.key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
            if (entry.pending) {
                const pending = entry.pending;
                entry.pending = null;
                await receive(id, pending);
            }
        } else if (packet.t === 'url') {
            if (!entry.key) { entry.pending = packet; return; }
            accept(id, entry, await decrypt(entry.key, packet.c, aad(id, packet.s, 'url')));
        }
    }
    return {
        announce() { queue('hello', hello); },
        setPeers(ids) {
            members.clear();
            for (const id of ids.slice(0, 50)) if (typeof id === 'string' && id.length <= 16) members.add(id);
            for (const id of peers.keys()) if (!members.has(id)) {
                peers.delete(id);
                outbox.delete(`key:${id}`);
                onUrl(id, null);
            }
        },
        async publish(value) {
            const next = normalizePeerUrl(value);
            if (next === url || closed) return;
            url = next;
            revision++;
            outbox.delete('url');
            await queueUrl();
        },
        receive,
        nextPacket() {
            // Public identity must precede keys, and keys must precede URLs.
            const id = outbox.has('hello') ? 'hello'
                : [...outbox.keys()].find(key => key.startsWith('key:')) || (outbox.has('url') ? 'url' : null);
            if (id === null) return null;
            const packet = outbox.get(id);
            outbox.delete(id);
            return packet;
        },
        get pending() { return outbox.size > 0; },
        close() { closed = true; outbox.clear(); peers.clear(); members.clear(); senderRaw.fill(0); }
    };
}
