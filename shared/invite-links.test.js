import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
    await import('./invite-links.js');
});

describe('invite links', () => {
    it('round-trips official and custom j2 links', () => {
        const api = globalThis.KoalaSyncInviteLinks;
        const official = api.buildJ2Hash({
            roomId: 'SAPPHIRE-DUCK-49',
            password: '0X:UK3C',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw'
        });
        expect(api.parseInviteHash(official)).toEqual({
            format: 'j2',
            roomId: 'SAPPHIRE-DUCK-49',
            password: '0X:UK3C',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw',
            useCustomServer: false,
            serverUrl: ''
        });

        const custom = api.buildJ2Hash({
            roomId: 'SILENT-EAGLE-90',
            password: '30PXPD',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw',
            serverUrl: 'wss://sync.example.test/socket?region=eu'
        });
        expect(api.parseInviteHash(custom)).toMatchObject({
            useCustomServer: true,
            serverUrl: 'wss://sync.example.test/socket?region=eu'
        });
    });

    it('keeps legacy links compatible, including colons in passwords', () => {
        const parse = globalThis.KoalaSyncInviteLinks.parseInviteHash;
        expect(parse('#join:ROOM-1:pass:with:colons')).toMatchObject({
            format: 'legacy',
            password: 'pass:with:colons',
            chatKey: '',
            useCustomServer: false
        });
        expect(parse('#join:ROOM-1:pass:with:colons:1:wss%3A%2F%2Frelay.example')).toMatchObject({
            password: 'pass:with:colons',
            useCustomServer: true,
            serverUrl: 'wss://relay.example'
        });
    });

    it('rejects incomplete or malformed invite hashes', () => {
        const parse = globalThis.KoalaSyncInviteLinks.parseInviteHash;
        expect(parse('#j2:r=ROOM&p=PASS')).toBeNull();
        expect(parse('#join:ROOM')).toBeNull();
        expect(parse('#join:ROOM:PASS:1:%E0%A4%A')).toBeNull();
        expect(parse('#other:r=ROOM&p=PASS&k=KEY')).toBeNull();
    });
    it('extracts invites from pasted text regardless of domain', () => {
        const api = globalThis.KoalaSyncInviteLinks;
        const hash = api.buildJ2Hash({
            roomId: 'SILENT-EAGLE-90',
            password: '30PXPD',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw',
            serverUrl: 'wss://relay.example.test'
        });
        const expected = {
            format: 'j2',
            roomId: 'SILENT-EAGLE-90',
            password: '30PXPD',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw',
            useCustomServer: true,
            serverUrl: 'wss://relay.example.test'
        };
        expect(api.parseInviteText(`https://sync.koalastuff.net/join.html${hash}`)).toEqual(expected);
        expect(api.parseInviteText(`https://sync.my-server.example/join${hash}`)).toEqual(expected);
        expect(api.parseInviteText(`  join us: https://any.example/x${hash}\nsee you  `)).toEqual(expected);
        expect(api.parseInviteText(hash)).toEqual(expected);
        expect(api.parseInviteText(`(https://any.example/join${hash})`)).toEqual(expected);
        expect(api.parseInviteText(`<https://any.example/join${hash}>`)).toEqual(expected);
        expect(api.parseInviteText(`Join here: https://any.example/join${hash}.`)).toEqual(expected);
        const official = api.buildJ2Hash({
            roomId: 'SILENT-EAGLE-90',
            password: '30PXPD',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw'
        });
        expect(api.parseInviteText(`[invite](https://sync.koalastuff.net/join.html${official})`))
            .toMatchObject({ chatKey: 'R5Ti1nxp0crfAFHf3gVncw', useCustomServer: false });
        expect(api.parseInviteText('https://other.example/join#join:ROOM-1:PASS')).toMatchObject({
            format: 'legacy',
            roomId: 'ROOM-1',
            password: 'PASS'
        });
    });

    it('skips broken fragments and unwraps wrapped legacy links', () => {
        const api = globalThis.KoalaSyncInviteLinks;
        const hash = api.buildJ2Hash({
            roomId: 'SILENT-EAGLE-90',
            password: '30PXPD',
            chatKey: 'R5Ti1nxp0crfAFHf3gVncw'
        });
        expect(api.parseInviteText(`format is #j2:r=ROOM&p=PASS, mine: https://x.example/join${hash}`))
            .toMatchObject({ roomId: 'SILENT-EAGLE-90', chatKey: 'R5Ti1nxp0crfAFHf3gVncw' });
        expect(api.parseInviteText('#join:BROKEN then https://x.example/#join:ROOM-1:PASS'))
            .toMatchObject({ roomId: 'ROOM-1', password: 'PASS' });

        expect(api.parseInviteText('<https://example.com/#join:ROOM-1:PASS>')).toMatchObject({ password: 'PASS' });
        expect(api.parseInviteText('(https://example.com/#join:ROOM-1:PASS)')).toMatchObject({ password: 'PASS' });
        expect(api.parseInviteText('[invite](https://example.com/#join:ROOM-1:PASS)')).toMatchObject({ password: 'PASS' });
        expect(api.parseInviteText('(#join:ROOM-1:PASS)')).toMatchObject({ password: 'PASS' });
        expect(api.parseInviteText('https://example.com/#join:ROOM-1:pass!)')).toMatchObject({ password: 'pass!)' });
        expect(api.parseInviteText('https://example.com/#join:ROOM-1:pass.')).toMatchObject({ password: 'pass.' });
    });

    it('ignores pasted text without a valid invite', () => {
        const parse = globalThis.KoalaSyncInviteLinks.parseInviteText;
        expect(parse('SILENT-EAGLE-90')).toBeNull();
        expect(parse('https://example.com/#section')).toBeNull();
        expect(parse('https://example.com/join#j2:r=ROOM&p=PASS')).toBeNull();
        expect(parse('')).toBeNull();
        expect(parse(null)).toBeNull();
    });
});
