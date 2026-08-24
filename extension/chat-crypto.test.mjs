import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import {
    clearChatKeyCache,
    countCodePoints,
    decryptChatMessage,
    deriveChatKey,
    encryptChatMessage,
    generateChatSecret,
    normalizeOutgoingChatText,
    validateChatSecret
} from './chat-crypto.js';

afterEach(clearChatKeyCache);

describe('chat crypto', () => {
    it('generates canonical 128-bit secrets', () => {
        const secret = generateChatSecret(webcrypto);
        expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(validateChatSecret(secret)).toBe(secret);
        expect(validateChatSecret(`${secret}=`)).toBe('');
    });

    it('round-trips Unicode with a cached room key and fresh IVs', async () => {
        const secret = generateChatSecret(webcrypto);
        const firstKey = await deriveChatKey('ROOM-1', secret, webcrypto);
        const secondKey = await deriveChatKey('ROOM-1', secret, webcrypto);
        expect(secondKey).toBe(firstKey);

        const input = { text: 'Hello 🐨 **world**', roomId: 'ROOM-1', senderId: 'alice', secret };
        const first = await encryptChatMessage(input, webcrypto);
        const second = await encryptChatMessage(input, webcrypto);
        expect(second).not.toBe(first);
        await expect(decryptChatMessage({ ciphertext: first, ...input }, webcrypto)).resolves.toBe(input.text);
    });

    it('deduplicates in-flight key derivations without restoring a cleared cache', async () => {
        const secret = generateChatSecret(webcrypto);
        let deriveCalls = 0;
        let releaseDerive;
        let markDeriveStarted;
        const deriveStarted = new Promise(resolve => { markDeriveStarted = resolve; });
        const delayedCrypto = {
            ...webcrypto,
            subtle: {
                importKey: (...args) => webcrypto.subtle.importKey(...args),
                deriveKey: async (...args) => {
                    deriveCalls++;
                    markDeriveStarted();
                    await new Promise(resolve => { releaseDerive = resolve; });
                    return webcrypto.subtle.deriveKey(...args);
                }
            }
        };
        const first = deriveChatKey('ROOM-1', secret, delayedCrypto);
        const second = deriveChatKey('ROOM-1', secret, delayedCrypto);
        await deriveStarted;
        expect(deriveCalls).toBe(1);
        clearChatKeyCache();
        releaseDerive();
        await Promise.all([first, second]);
        const fresh = deriveChatKey('ROOM-1', secret, webcrypto);
        expect(fresh).not.toBe(first);
        await fresh;
    });

    it('rejects relabeling, cross-room replay, and the wrong secret', async () => {
        const secret = generateChatSecret(webcrypto);
        const ciphertext = await encryptChatMessage({ text: 'secret', roomId: 'ROOM-1', senderId: 'alice', secret }, webcrypto);
        clearChatKeyCache();
        await expect(decryptChatMessage({ ciphertext, roomId: 'ROOM-1', senderId: 'bob', secret }, webcrypto)).rejects.toThrow();
        clearChatKeyCache();
        await expect(decryptChatMessage({ ciphertext, roomId: 'ROOM-2', senderId: 'alice', secret }, webcrypto)).rejects.toThrow();
        clearChatKeyCache();
        await expect(decryptChatMessage({ ciphertext, roomId: 'ROOM-1', senderId: 'alice', secret: generateChatSecret(webcrypto) }, webcrypto)).rejects.toThrow();
    });

    it('enforces 500 Unicode code points before encryption', () => {
        expect(countCodePoints('😀'.repeat(500))).toBe(500);
        expect(normalizeOutgoingChatText(`  ${'😀'.repeat(500)}  `)).toBe('😀'.repeat(500));
        expect(() => normalizeOutgoingChatText('😀'.repeat(501))).toThrow(RangeError);
        expect(() => normalizeOutgoingChatText('   ')).toThrow(TypeError);
    });

    it('keeps the worst-case 500-codepoint payload within the relay byte bound', async () => {
        const secret = generateChatSecret(webcrypto);
        const ciphertext = await encryptChatMessage({
            text: '😀'.repeat(500), roomId: 'ROOM-1', senderId: 'alice', secret
        }, webcrypto);
        const bytes = Buffer.from(ciphertext, 'base64url');
        expect(bytes).toHaveLength(2028);
    });

    it('rejects non-canonical plaintext and malformed UTF-8 after authentication', async () => {
        const secret = generateChatSecret(webcrypto);
        const roomId = 'ROOM-1';
        const senderId = 'alice';
        const key = await deriveChatKey(roomId, secret, webcrypto);
        const encoder = new globalThis.TextEncoder();

        async function encryptRaw(plaintext) {
            const iv = webcrypto.getRandomValues(new Uint8Array(12));
            const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({
                name: 'AES-GCM',
                iv,
                additionalData: encoder.encode(`${roomId}|${senderId}`)
            }, key, plaintext));
            return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64url');
        }

        const whitespace = await encryptRaw(encoder.encode('   '));
        await expect(decryptChatMessage({ ciphertext: whitespace, roomId, senderId, secret }, webcrypto)).rejects.toThrow(TypeError);
        const malformed = await encryptRaw(Uint8Array.of(0xff));
        await expect(decryptChatMessage({ ciphertext: malformed, roomId, senderId, secret }, webcrypto)).rejects.toThrow();
    });
});
