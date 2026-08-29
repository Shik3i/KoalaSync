import { EVENTS, MAX_MEDIA_TIME } from '../shared/constants.js';

function clampMediaTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(MAX_MEDIA_TIME, value));
}

function normalizeMediaTitle(value) {
    if (typeof value !== 'string' || !value) return null;
    return value.substring(0, 100);
}

export function effectiveMediaPosition(mediaState, now = Date.now()) {
    if (!mediaState) return null;
    const currentTime = clampMediaTime(mediaState.currentTime);
    if (currentTime === null) return null;
    if (mediaState.playbackState !== 'playing') return currentTime;
    const updatedAt = typeof mediaState.updatedAt === 'number' && Number.isFinite(mediaState.updatedAt)
        ? mediaState.updatedAt
        : now;
    return clampMediaTime(currentTime + Math.max(0, now - updatedAt) / 1000);
}

export function snapshotMediaState(mediaState, now = Date.now()) {
    if (!mediaState) return null;
    const currentTime = effectiveMediaPosition(mediaState, now);
    if (currentTime === null
        || !Number.isSafeInteger(mediaState.revision)
        || mediaState.revision < 1
        || (mediaState.playbackState !== 'playing' && mediaState.playbackState !== 'paused')) {
        return null;
    }
    const snapshot = {
        revision: mediaState.revision,
        playbackState: mediaState.playbackState,
        currentTime,
        updatedBy: mediaState.updatedBy
    };
    const mediaTitle = normalizeMediaTitle(mediaState.mediaTitle);
    if (mediaTitle) snapshot.mediaTitle = mediaTitle;
    return snapshot;
}

function commitMediaState(room, playbackState, currentTime, updatedBy, now, mediaTitle = null) {
    const normalizedTime = clampMediaTime(currentTime);
    if (normalizedTime === null
        || (playbackState !== 'playing' && playbackState !== 'paused')
        || typeof updatedBy !== 'string'
        || !updatedBy) {
        return false;
    }
    const nextState = {
        revision: (room.mediaState?.revision || 0) + 1,
        playbackState,
        currentTime: normalizedTime,
        updatedAt: now,
        updatedBy
    };
    const normalizedTitle = normalizeMediaTitle(mediaTitle);
    if (normalizedTitle) nextState.mediaTitle = normalizedTitle;
    room.mediaState = nextState;
    return true;
}

export function updateMediaStateFromControl(room, eventName, payload, senderPeerId, {
    now = Date.now(),
    senderPlaybackState = null,
    senderMediaTitle = null
} = {}) {
    if (!room || !payload || typeof payload !== 'object') return false;
    const mediaTitle = payload.mediaTitle === null
        ? null
        : (normalizeMediaTitle(payload.mediaTitle) || normalizeMediaTitle(senderMediaTitle));

    if (eventName === EVENTS.PLAY || eventName === EVENTS.PAUSE) {
        const eventPosition = clampMediaTime(payload.currentTime);
        const currentTime = eventPosition ?? effectiveMediaPosition(room.mediaState, now);
        if (currentTime === null) return false;
        return commitMediaState(
            room,
            eventName === EVENTS.PLAY ? 'playing' : 'paused',
            currentTime,
            senderPeerId,
            now,
            mediaTitle
        );
    }

    if (eventName === EVENTS.SEEK) {
        const targetTime = clampMediaTime(payload.targetTime) ?? clampMediaTime(payload.currentTime);
        const playbackState = room.mediaState?.playbackState || senderPlaybackState;
        if (targetTime === null) return false;
        return commitMediaState(room, playbackState, targetTime, senderPeerId, now, mediaTitle);
    }

    return false;
}

export function commitForceSyncMediaState(room, targetTime, senderPeerId, now = Date.now(), mediaTitle = null) {
    return commitMediaState(room, 'playing', targetTime, senderPeerId, now, mediaTitle);
}
