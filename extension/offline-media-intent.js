import { EVENTS, MAX_MEDIA_TIME } from './shared/constants.js';

export const MEDIA_INTENT_KIND = 'media-intent';
export const MAX_LOGICAL_QUEUE_SIZE = 50;

const MEDIA_EVENTS = new Set([EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK]);
const STALE_OFFLINE_EVENTS = new Set([EVENTS.PING, EVENTS.PONG, EVENTS.PEER_STATUS, EVENTS.EVENT_ACK]);
const FORCE_SYNC_EVENTS = new Set([EVENTS.FORCE_SYNC_PREPARE, EVENTS.FORCE_SYNC_EXECUTE]);
const HOST_GATED_EVENTS = new Set([
    ...MEDIA_EVENTS,
    ...FORCE_SYNC_EVENTS,
    EVENTS.EPISODE_LOBBY,
    EVENTS.EPISODE_LOBBY_CANCEL
]);

function validSequence(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function mediaTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(MAX_MEDIA_TIME, value));
}

function playbackStateFor(event, data) {
    if (event === EVENTS.PLAY) return 'playing';
    if (event === EVENTS.PAUSE) return 'paused';
    return data?.playbackState === 'playing' || data?.playbackState === 'paused'
        ? data.playbackState
        : null;
}

function mediaPositionFor(event, data) {
    if (event === EVENTS.SEEK) {
        return mediaTime(data?.targetTime) ?? mediaTime(data?.currentTime);
    }
    return mediaTime(data?.currentTime);
}

function sanitizedMediaTitle(value) {
    return typeof value === 'string' && value ? value.substring(0, 100) : null;
}

function trimQueue(queue, maxEntries) {
    const trimmed = queue.slice();
    let dropped = 0;
    while (trimmed.length > maxEntries) {
        trimmed.shift();
        dropped++;
    }
    return { queue: trimmed, dropped };
}

function createIntentEntry(event, data, roomId) {
    const currentTime = mediaPositionFor(event, data);
    const playbackState = playbackStateFor(event, data);
    if (event === EVENTS.SEEK && currentTime === null) return null;
    if (playbackState === null && currentTime === null) return null;
    return {
        kind: MEDIA_INTENT_KIND,
        roomId,
        intent: {
            playbackState,
            currentTime,
            latestEvent: event,
            previousSeq: null,
            latestSeq: validSequence(data?.seq),
            actionTimestamp: validTimestamp(data?.actionTimestamp),
            mediaTitle: sanitizedMediaTitle(data?.mediaTitle),
            sourceEventCount: 1
        }
    };
}

function mergeIntentEntry(entry, event, data) {
    const incomingSeq = validSequence(data?.seq);
    const previousLatestSeq = validSequence(entry.intent.latestSeq);
    if (incomingSeq !== null && previousLatestSeq !== null && incomingSeq <= previousLatestSeq) {
        return null;
    }

    const incomingPosition = mediaPositionFor(event, data);
    if (event === EVENTS.SEEK && incomingPosition === null) return entry;
    const incomingState = playbackStateFor(event, data);
    const merged = {
        ...entry,
        intent: {
            ...entry.intent,
            playbackState: incomingState ?? entry.intent.playbackState,
            currentTime: incomingPosition ?? entry.intent.currentTime,
            latestEvent: event,
            actionTimestamp: validTimestamp(data?.actionTimestamp) ?? entry.intent.actionTimestamp,
            mediaTitle: sanitizedMediaTitle(data?.mediaTitle) ?? entry.intent.mediaTitle,
            sourceEventCount: entry.intent.sourceEventCount + 1
        }
    };
    if (incomingSeq !== null) {
        merged.intent.previousSeq = previousLatestSeq ?? validSequence(entry.intent.previousSeq);
        merged.intent.latestSeq = incomingSeq;
    }
    return merged;
}

export function isMediaQueueEvent(event) {
    return MEDIA_EVENTS.has(event);
}

export function isQueuedMediaIntent(entry) {
    return entry?.kind === MEDIA_INTENT_KIND
        && typeof entry.roomId === 'string'
        && entry.roomId
        && entry.intent
        && typeof entry.intent === 'object';
}

export function enqueueQueuedEvent(queue, event, data, {
    roomId,
    maxEntries = MAX_LOGICAL_QUEUE_SIZE
} = {}) {
    const next = Array.isArray(queue) ? queue.slice() : [];
    let collapsed = 0;

    if (STALE_OFFLINE_EVENTS.has(event)) {
        return { queue: next, collapsed: 0, dropped: 0, droppedStale: 1 };
    }
    if (!isMediaQueueEvent(event)) {
        next.push({ event, data });
    } else if (typeof roomId === 'string' && roomId) {
        const last = next.at(-1);
        const hasMergeTarget = isQueuedMediaIntent(last) && last.roomId === roomId;
        const merged = hasMergeTarget
            ? mergeIntentEntry(last, event, data)
            : null;
        if (merged) {
            next[next.length - 1] = merged;
            collapsed = 1;
        } else if (!hasMergeTarget) {
            const entry = createIntentEntry(event, data, roomId);
            if (entry) next.push(entry);
        } else {
            return { queue: next, collapsed: 0, dropped: 0, droppedStale: 1 };
        }
    }

    const trimmed = trimQueue(next, maxEntries);
    return { queue: trimmed.queue, collapsed, dropped: trimmed.dropped, droppedStale: 0 };
}

function normalizeIntentEntry(entry, roomId) {
    if (!isQueuedMediaIntent(entry) || entry.roomId !== roomId) return null;
    const intent = entry.intent;
    const playbackState = intent.playbackState === 'playing' || intent.playbackState === 'paused'
        ? intent.playbackState
        : null;
    const currentTime = mediaTime(intent.currentTime);
    const latestEvent = isMediaQueueEvent(intent.latestEvent) ? intent.latestEvent : null;
    if (!latestEvent || (playbackState === null && currentTime === null)) return null;
    return {
        kind: MEDIA_INTENT_KIND,
        roomId,
        intent: {
            playbackState,
            currentTime,
            latestEvent,
            previousSeq: validSequence(intent.previousSeq),
            latestSeq: validSequence(intent.latestSeq),
            actionTimestamp: validTimestamp(intent.actionTimestamp),
            mediaTitle: sanitizedMediaTitle(intent.mediaTitle),
            sourceEventCount: Number.isSafeInteger(intent.sourceEventCount) && intent.sourceEventCount > 0
                ? intent.sourceEventCount
                : 1
        }
    };
}

export function normalizePersistedEventQueue(value, roomId, maxEntries = MAX_LOGICAL_QUEUE_SIZE) {
    if (!Array.isArray(value) || typeof roomId !== 'string' || !roomId) return [];
    let normalized = [];
    for (const entry of value) {
        if (isQueuedMediaIntent(entry)) {
            const intentEntry = normalizeIntentEntry(entry, roomId);
            if (intentEntry) normalized.push(intentEntry);
            continue;
        }
        if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string') continue;
        if (STALE_OFFLINE_EVENTS.has(entry.event)) continue;
        if (isMediaQueueEvent(entry.event)) {
            normalized = enqueueQueuedEvent(normalized, entry.event, entry.data, { roomId, maxEntries }).queue;
        } else {
            normalized.push({ event: entry.event, data: entry.data });
        }
        normalized = trimQueue(normalized, maxEntries).queue;
    }
    return normalized;
}

export function mediaIntentNeedsSequenceReservation(entry) {
    if (!isQueuedMediaIntent(entry)) return false;
    const { playbackState, currentTime, previousSeq, latestSeq } = entry.intent;
    return playbackState !== null
        && currentTime !== null
        && validSequence(latestSeq) !== null
        && validSequence(previousSeq) === null;
}

export function reserveLatestMediaIntentSequence(queue, roomId, nextSequence) {
    const next = Array.isArray(queue) ? queue.slice() : [];
    const index = next.length - 1;
    const entry = next[index];
    if (!isQueuedMediaIntent(entry)
        || entry.roomId !== roomId
        || !mediaIntentNeedsSequenceReservation(entry)
        || validSequence(nextSequence) === null
        || nextSequence <= entry.intent.latestSeq) {
        return { queue: next, reserved: false };
    }
    next[index] = {
        ...entry,
        intent: {
            ...entry.intent,
            previousSeq: entry.intent.latestSeq,
            latestSeq: nextSequence
        }
    };
    return { queue: next, reserved: true };
}

function frameData(intent, seq) {
    const data = {};
    if (seq !== null) data.seq = seq;
    if (intent.actionTimestamp !== null) data.actionTimestamp = intent.actionTimestamp;
    if (intent.mediaTitle !== null) data.mediaTitle = intent.mediaTitle;
    return data;
}

export function materializeMediaIntent(entry) {
    if (!isQueuedMediaIntent(entry)) return [];
    const intent = entry.intent;
    const currentTime = mediaTime(intent.currentTime);
    const playbackState = intent.playbackState === 'playing' || intent.playbackState === 'paused'
        ? intent.playbackState
        : null;
    const latestSeq = validSequence(intent.latestSeq);
    const previousSeq = validSequence(intent.previousSeq);
    const stateEvent = playbackState === 'playing' ? EVENTS.PLAY : EVENTS.PAUSE;

    if (playbackState === null && currentTime !== null) {
        return [{
            event: EVENTS.SEEK,
            data: { ...frameData(intent, latestSeq), currentTime, targetTime: currentTime }
        }];
    }
    if (playbackState !== null && currentTime === null) {
        return [{ event: stateEvent, data: frameData(intent, latestSeq) }];
    }
    if (playbackState === null || currentTime === null) return [];

    // Both materialized frames carry the latest genuine action timestamp: it is
    // correlation metadata for existing ACK/activity paths, not scheduled wall
    // time. A previous-format single PLAY/PAUSE has only one reserved sequence. Keep
    // its original one-frame behavior during migration rather than inventing a
    // sequence that could overtake a later transactional barrier.
    if (previousSeq === null || latestSeq === null || previousSeq >= latestSeq) {
        if (intent.latestEvent === EVENTS.SEEK) {
            return [{
                event: EVENTS.SEEK,
                data: { ...frameData(intent, latestSeq), currentTime, targetTime: currentTime }
            }];
        }
        return [{
            event: stateEvent,
            data: { ...frameData(intent, latestSeq), currentTime }
        }];
    }

    const seekFrame = {
        event: EVENTS.SEEK,
        data: { ...frameData(intent, intent.latestEvent === EVENTS.SEEK ? latestSeq : previousSeq), currentTime, targetTime: currentTime }
    };
    const stateFrame = {
        event: stateEvent,
        data: { ...frameData(intent, intent.latestEvent === EVENTS.SEEK ? previousSeq : latestSeq), currentTime }
    };
    return intent.latestEvent === EVENTS.SEEK
        ? [stateFrame, seekFrame]
        : [seekFrame, stateFrame];
}

export function queuedEntryWireCount(entry) {
    return isQueuedMediaIntent(entry) ? materializeMediaIntent(entry).length : 1;
}

export function queuedWireCount(queue) {
    return Array.isArray(queue)
        ? queue.reduce((total, entry) => total + queuedEntryWireCount(entry), 0)
        : 0;
}

export function queuedMediaIntentCount(queue, roomId = null) {
    return Array.isArray(queue)
        ? queue.filter(entry => isQueuedMediaIntent(entry) && (!roomId || entry.roomId === roomId)).length
        : 0;
}

export function hasQueuedMediaIntent(queue, roomId) {
    return queuedMediaIntentCount(queue, roomId) > 0;
}

export function discardQueuedMediaIntents(queue, roomId) {
    return Array.isArray(queue)
        ? queue.filter(entry => !isQueuedMediaIntent(entry) || entry.roomId !== roomId)
        : [];
}

export function reconcileQueuedRoomIntent(queue, {
    roomId,
    canControl = true,
    activeLobby = false,
    desynced = false
} = {}) {
    const source = Array.isArray(queue) ? queue : [];
    const blockedEvents = !canControl
        ? HOST_GATED_EVENTS
        : (activeLobby || desynced ? FORCE_SYNC_EVENTS : null);
    const reconciled = source.filter(entry => {
        if (isQueuedMediaIntent(entry) && entry.roomId === roomId) {
            return canControl && !activeLobby && !desynced;
        }
        return !blockedEvents?.has(entry?.event);
    });
    const hasPendingLocalIntent = reconciled.some(entry =>
        (isQueuedMediaIntent(entry) && entry.roomId === roomId)
        || (!isQueuedMediaIntent(entry) && FORCE_SYNC_EVENTS.has(entry?.event))
    );
    return {
        queue: reconciled,
        discarded: source.length - reconciled.length,
        hasPendingLocalIntent
    };
}

export function maxQueuedSequence(queue) {
    let max = 0;
    for (const entry of Array.isArray(queue) ? queue : []) {
        if (isQueuedMediaIntent(entry)) {
            max = Math.max(max, validSequence(entry.intent.previousSeq) ?? 0, validSequence(entry.intent.latestSeq) ?? 0);
        } else {
            max = Math.max(max, validSequence(entry?.data?.seq) ?? 0);
        }
    }
    return max;
}

export async function drainQueuedBatch(queue, {
    roomId,
    maxWireEvents,
    sendFrame
}) {
    const remaining = Array.isArray(queue) ? queue.slice() : [];
    let sentWireEvents = 0;
    let droppedStaleIntents = 0;

    while (remaining.length > 0) {
        const entry = remaining[0];
        if (isQueuedMediaIntent(entry) && entry.roomId !== roomId) {
            remaining.shift();
            droppedStaleIntents++;
            continue;
        }
        const frames = isQueuedMediaIntent(entry)
            ? materializeMediaIntent(entry)
            : [{ event: entry.event, data: entry.data }];
        if (frames.length === 0) {
            remaining.shift();
            continue;
        }
        if (sentWireEvents > 0 && sentWireEvents + frames.length > maxWireEvents) {
            return { queue: remaining, sentWireEvents, droppedStaleIntents, status: 'batch_full' };
        }
        if (frames.length > maxWireEvents) {
            return { queue: remaining, sentWireEvents, droppedStaleIntents, status: 'entry_exceeds_batch' };
        }

        let sentEntryFrames = 0;
        for (const frame of frames) {
            if (!await sendFrame(frame, entry)) {
                return {
                    queue: remaining,
                    sentWireEvents: sentWireEvents + sentEntryFrames,
                    droppedStaleIntents,
                    status: 'send_failed'
                };
            }
            sentEntryFrames++;
        }
        sentWireEvents += sentEntryFrames;
        remaining.shift();
        if (sentWireEvents >= maxWireEvents) {
            return { queue: remaining, sentWireEvents, droppedStaleIntents, status: 'batch_full' };
        }
    }
    return { queue: remaining, sentWireEvents, droppedStaleIntents, status: 'drained' };
}
