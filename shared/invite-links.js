(function exposeInviteLinks(root) {
    const J2_PREFIX = '#j2:';
    const LEGACY_PREFIX = '#join:';

    function parseJ2Hash(hash) {
        if (typeof hash !== 'string' || !hash.startsWith(J2_PREFIX)) return null;
        const params = new URLSearchParams(hash.slice(J2_PREFIX.length));
        const roomId = params.get('r') || '';
        const password = params.get('p') || '';
        const chatKey = params.get('k') || '';
        const serverUrl = params.get('u') || '';
        if (!roomId || !password || !chatKey) return null;
        return {
            format: 'j2',
            roomId,
            password,
            chatKey,
            useCustomServer: serverUrl.length > 0,
            serverUrl
        };
    }

    function parseLegacyHash(hash) {
        if (typeof hash !== 'string' || !hash.startsWith(LEGACY_PREFIX)) return null;
        const parts = hash.slice(LEGACY_PREFIX.length).split(':');
        const roomId = parts.shift() || '';
        let useCustomServer = false;
        let serverUrl = '';

        if (parts.length >= 3) {
            const flag = parts.at(-2);
            const rawUrl = parts.at(-1) || '';
            let decodedUrl = '';
            try {
                decodedUrl = decodeURIComponent(rawUrl);
            } catch (_) {
                return null;
            }
            const custom = flag === '1' && /^(?:ws|wss):\/\//.test(decodedUrl);
            const official = flag === '0' && rawUrl === '';
            if (custom || official) {
                parts.splice(-2, 2);
                useCustomServer = custom;
                serverUrl = custom ? decodedUrl : '';
            }
        }

        const password = parts.join(':');
        if (!roomId || !password) return null;
        return {
            format: 'legacy',
            roomId,
            password,
            chatKey: '',
            useCustomServer,
            serverUrl
        };
    }

    function parseInviteHash(hash) {
        return parseJ2Hash(hash) || parseLegacyHash(hash);
    }

    // Pulls an invite out of arbitrary pasted text (full link on any domain,
    // bare hash, or a message containing the link). Only the fragment counts.
    function parseInviteText(text) {
        if (typeof text !== 'string') return null;
        for (const prefix of [J2_PREFIX, LEGACY_PREFIX]) {
            const start = text.indexOf(prefix);
            if (start === -1) continue;
            let hash = text.slice(start).split(/\s/, 1)[0];
            // j2 values are form-encoded, so trailing brackets or punctuation
            // come from the surrounding message ("(link)", "<link>", "link.").
            // Legacy passwords are raw and keep their characters.
            if (prefix === J2_PREFIX) hash = hash.replace(/[)\]}>"'.,;!?]+$/, '');
            const invite = parseInviteHash(hash);
            if (invite) return invite;
        }
        return null;
    }

    function buildJ2Hash({ roomId, password, chatKey, serverUrl = '' }) {
        if (!roomId || !password || !chatKey) throw new TypeError('roomId, password, and chatKey are required');
        const params = new URLSearchParams({ r: roomId, p: password, k: chatKey });
        if (serverUrl) params.set('u', serverUrl);
        return `${J2_PREFIX}${params.toString()}`;
    }

    root.KoalaSyncInviteLinks = Object.freeze({
        J2_PREFIX,
        LEGACY_PREFIX,
        parseInviteHash,
        parseInviteText,
        buildJ2Hash
    });
})(globalThis);
