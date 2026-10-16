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
        const wrappers = { '(': ')', '<': '>', '[': ']', '{': '}', '"': '"', "'": "'" };
        const candidates = /#(?:j2|join):/g;
        let match;
        // Try every fragment in text order, so a broken example earlier in the
        // message does not hide the real link.
        while ((match = candidates.exec(text)) !== null) {
            let hash = text.slice(match.index).split(/\s/, 1)[0];
            // Drop a closing delimiter only when the link itself was wrapped
            // ("<link>", "(link)"), so raw legacy passwords keep punctuation.
            const before = text.slice(0, match.index);
            const linkStart = before.search(/(?:[a-z][a-z0-9+.-]*:\/\/\S*)?$/i);
            const closer = wrappers[before[linkStart - 1]];
            if (closer && hash.endsWith(closer)) hash = hash.slice(0, -1);
            // j2 values are form-encoded, so any trailing brackets or
            // punctuation come from the surrounding message ("link.").
            if (hash.startsWith(J2_PREFIX)) hash = hash.replace(/[)\]}>"'.,;!?]+$/, '');
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
