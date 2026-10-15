// An extension-only subprotocol inside the existing opaque chat relay envelope.
// URLs and sender keys are encrypted; only ephemeral public keys and routing
// metadata are public. Peers holding the same chat secret receive the sender key
// through one broadcast frame wrapped under a secret-derived group key, so the
// handshake costs O(1) frames per peer. Only rooms without any chat secret use
// per-pair ECDH, which trusts relay identity; secret holders never fall back to it.
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

// The destination a click would open, for display next to the participant. The
// scheme is shown only when insecure; IDN hosts appear in punycode, which keeps
// look-alike domains distinguishable.
export function peerLinkHost(value) {
    const href = normalizePeerUrl(value);
    if (!href) return '';
    const url = new URL(href);
    return (url.protocol === 'http:' ? 'http://' : '') + url.host;
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
    const groupKey = secret.length ? await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(roomId), info: encoder.encode('KoalaSyncLinks1 group key') },
        await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) : null;
    let revision = 0;
    let url = null;
    let withdrawing = false;
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
    const groupPacket = groupKey ? { t: 'gkey', s: epoch, c: await encrypt(groupKey, { k: encode(senderRaw) }, aad(peerId, epoch, 'gkey')) } : null;
    async function pairKey(id, packet) {
        const remote = await subtle.importKey('raw', decode(packet.p), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: remote }, keys.privateKey, 256));
        const material = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
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
            const shared = groupKey !== null && packet.a === tag;
            // A chat-secret holder never falls back to relay-trusted ECDH: a relay
            // could otherwise strip the tag from a forged hello and receive the
            // sender key. Peers exchange links only within one secret group, or
            // pairwise when neither side holds a secret.
            if (!shared && (groupKey !== null || packet.a !== '')) {
                if (previous) {
                    peers.delete(id);
                    outbox.delete(`key:${id}`);
                    onUrl(id, null);
                }
                return;
            }
            const pair = shared ? null : await pairKey(id, packet);
            if (closed || !members.has(id)) return;
            const entry = { epoch: packet.s, pair, shared, key: null, revision: -1, pending: null };
            peers.set(id, entry);
            onUrl(id, null);
            queue('hello', hello);
            if (shared) {
                // One coalesced broadcast serves every peer with the chat secret.
                queue('gkey', groupPacket);
                await queueUrl();
            } else await sendKey(id, entry);
            return;
        }
        const entry = peers.get(id);
        if (!entry || entry.epoch !== packet.s) return;
        if (packet.t === 'gkey' || (packet.t === 'key' && packet.to === peerId && packet.d === epoch)) {
            const shared = packet.t === 'gkey';
            if (entry.shared !== shared || entry.key) return;
            const value = shared
                ? await decrypt(groupKey, packet.c, aad(id, packet.s, 'gkey'))
                : await decrypt(entry.pair, packet.c, aad(id, packet.s, 'key', `${peerId}|${epoch}`));
            const raw = decode(value.k);
            if (raw.length !== 32) return;
            const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
            if (closed || peers.get(id) !== entry) return;
            entry.key = key;
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
            withdrawing = next === null;
            revision++;
            outbox.delete('url');
            await queueUrl();
        },
        receive,
        nextPacket() {
            // Public identity must precede keys, and keys must precede URLs.
            // A withdrawal overtakes the handshake so revoking a link is never
            // queued behind key distribution.
            const id = withdrawing && outbox.has('url') ? 'url'
                : outbox.has('hello') ? 'hello'
                : outbox.has('gkey') ? 'gkey'
                : [...outbox.keys()].find(key => key.startsWith('key:')) || (outbox.has('url') ? 'url' : null);
            if (id === null) return null;
            const packet = outbox.get(id);
            outbox.delete(id);
            if (id === 'url') withdrawing = false;
            return packet;
        },
        get pending() { return outbox.size > 0; },
        // A queued withdrawal must not wait behind user chat for relay budget.
        get urgent() { return withdrawing && outbox.has('url'); },
        close() { closed = true; outbox.clear(); peers.clear(); members.clear(); senderRaw.fill(0); }
    };
}
