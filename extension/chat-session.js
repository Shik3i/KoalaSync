export const MAX_ROOM_ID_LENGTH = 64;
export const CHAT_SEND_LIMIT = 10;
export const CHAT_SEND_WINDOW_MS = 10000;
export const CHAT_ECHO_TIMEOUT_MS = 4000;
// The relay disconnects a socket above CHAT_SEND_LIMIT per fixed window, while
// the client window slides; the margin absorbs network jitter between sends.
export const CHAT_SEND_JITTER_MARGIN_MS = 500;
// Relay budget kept free for user chat; background peer-link frames never use it.
export const PEER_LINK_CHAT_RESERVE = 4;

export function normalizeRoomId(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/[^a-zA-Z0-9\-]/g, '').slice(0, MAX_ROOM_ID_LENGTH);
}

export function createChatSendLimiter({
    limit = CHAT_SEND_LIMIT,
    windowMs = CHAT_SEND_WINDOW_MS,
    now = () => Date.now()
} = {}) {
    let timestamps = [];

    return {
        // reserve keeps that many slots free for higher-priority senders sharing
        // the same relay budget (background traffic must not starve user chat).
        take({ reserve = 0 } = {}) {
            const current = now();
            timestamps = timestamps.filter(timestamp => current - timestamp < windowMs);
            if (timestamps.length >= limit - reserve) {
                return {
                    allowed: false,
                    retryAfterMs: Math.max(1, windowMs - (current - timestamps[0]))
                };
            }
            timestamps.push(current);
            return { allowed: true, retryAfterMs: 0 };
        },
        reset() {
            timestamps = [];
        }
    };
}

export function createChatEchoTracker({
    timeoutMs = CHAT_ECHO_TIMEOUT_MS,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout
} = {}) {
    const pending = new Map();

    function settle(ciphertext, acknowledged) {
        const entry = pending.get(ciphertext);
        if (!entry) return false;
        pending.delete(ciphertext);
        clearTimer(entry.timer);
        entry.resolve(acknowledged);
        return true;
    }

    return {
        waitFor(ciphertext) {
            if (typeof ciphertext !== 'string' || !ciphertext) return Promise.resolve(false);
            settle(ciphertext, false);
            return new Promise(resolve => {
                const timer = setTimer(() => {
                    pending.delete(ciphertext);
                    resolve(false);
                }, timeoutMs);
                pending.set(ciphertext, { resolve, timer });
            });
        },
        acknowledge(ciphertext) {
            return settle(ciphertext, true);
        },
        cancel(ciphertext) {
            return settle(ciphertext, false);
        },
        reset() {
            for (const ciphertext of [...pending.keys()]) settle(ciphertext, false);
        }
    };
}

export function shouldShowChatNotification({ enabled, targetTabId, tab, windowInfo }) {
    if (!enabled) return false;
    const normalizedTargetTabId = Number(targetTabId);
    const targetIsFocused = Number.isInteger(normalizedTargetTabId)
        && tab?.id === normalizedTargetTabId
        && tab.active === true
        && Number.isInteger(tab.windowId)
        && windowInfo?.id === tab.windowId
        && windowInfo.focused === true;
    return !targetIsFocused;
}

export function createLatestTaskQueue() {
    let generation = 0;
    let tail = Promise.resolve();

    return {
        invalidate() {
            generation++;
        },
        async run(task) {
            const requestGeneration = ++generation;
            const previous = tail;
            let release;
            tail = new Promise(resolve => { release = resolve; });
            await previous.catch(() => {});
            const isCurrent = () => requestGeneration === generation;
            try {
                return await task(isCurrent);
            } finally {
                release();
            }
        }
    };
}
