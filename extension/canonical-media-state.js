import { CAPABILITIES, MAX_MEDIA_TIME } from '../shared/constants.js';

export function validateCanonicalMediaState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (value.playbackState !== 'playing' && value.playbackState !== 'paused') return null;
    if (typeof value.currentTime !== 'number'
        || !Number.isFinite(value.currentTime)
        || value.currentTime < 0
        || value.currentTime > MAX_MEDIA_TIME) {
        return null;
    }
    if (value.mediaTitle !== undefined
        && value.mediaTitle !== null
        && typeof value.mediaTitle !== 'string') {
        return null;
    }
    const normalized = {
        revision: value.revision,
        playbackState: value.playbackState,
        currentTime: value.currentTime
    };
    if (typeof value.updatedBy === 'string' && value.updatedBy) {
        normalized.updatedBy = value.updatedBy.substring(0, 16);
    }
    if (typeof value.mediaTitle === 'string' && value.mediaTitle) {
        normalized.mediaTitle = value.mediaTitle.substring(0, 100);
    }
    return normalized;
}

export function canonicalMediaStateFromRoomData(roomData) {
    const capabilities = Array.isArray(roomData?.capabilities) ? roomData.capabilities : [];
    if (!capabilities.includes(CAPABILITIES.MEDIA_STATE_V1)) {
        return { status: 'unsupported', mediaState: null };
    }
    if (roomData.mediaState === null || roomData.mediaState === undefined) {
        return { status: 'empty', mediaState: null };
    }
    const mediaState = validateCanonicalMediaState(roomData.mediaState);
    return mediaState
        ? { status: 'available', mediaState }
        : { status: 'invalid', mediaState: null };
}

export function projectCanonicalMediaState(mediaState, receivedAt, now = Date.now()) {
    const validated = validateCanonicalMediaState(mediaState);
    if (!validated) return null;
    if (validated.playbackState !== 'playing') return validated;
    const received = typeof receivedAt === 'number' && Number.isFinite(receivedAt)
        ? receivedAt
        : now;
    return {
        ...validated,
        currentTime: Math.min(
            MAX_MEDIA_TIME,
            validated.currentTime + Math.max(0, now - received) / 1000
        )
    };
}

function normalizeRoomId(roomId) {
    return typeof roomId === 'string' && roomId ? roomId : null;
}

export function createCanonicalMediaStateTracker() {
    let roomId = null;
    let knownRevision = 0;
    let appliedRevision = 0;
    let pending = null;

    function adoptRoom(nextRoomId) {
        const normalizedRoomId = normalizeRoomId(nextRoomId);
        if (normalizedRoomId === roomId) return false;
        roomId = normalizedRoomId;
        knownRevision = 0;
        appliedRevision = 0;
        pending = null;
        return true;
    }

    return {
        adoptRoom,

        beginRecovery(nextRoomId) {
            adoptRoom(nextRoomId);
            // A relay restart or an empty-room recreation starts a new in-memory
            // revision epoch. ROOM_DATA belongs to this fresh connection, so a
            // lower revision is current truth rather than a stale packet from
            // the previous epoch.
            knownRevision = 0;
            appliedRevision = 0;
            pending = null;
        },

        receive(nextRoomId, value, receivedAt = Date.now()) {
            adoptRoom(nextRoomId);
            const mediaState = validateCanonicalMediaState(value);
            if (!roomId || !mediaState) return { status: 'invalid' };
            if (mediaState.revision < knownRevision) return { status: 'stale' };
            if (mediaState.revision === knownRevision
                && (appliedRevision === mediaState.revision || pending?.mediaState.revision === mediaState.revision)) {
                return { status: 'duplicate' };
            }
            knownRevision = Math.max(knownRevision, mediaState.revision);
            pending = {
                roomId,
                mediaState,
                receivedAt: typeof receivedAt === 'number' && Number.isFinite(receivedAt)
                    ? receivedAt
                    : Date.now()
            };
            return { status: 'pending', mediaState };
        },

        getPending(nextRoomId = roomId) {
            return pending && pending.roomId === normalizeRoomId(nextRoomId)
                ? { roomId: pending.roomId, mediaState: { ...pending.mediaState } }
                : null;
        },

        getPendingProjected(nextRoomId = roomId, now = Date.now()) {
            if (!pending || pending.roomId !== normalizeRoomId(nextRoomId)) return null;
            const mediaState = projectCanonicalMediaState(
                pending.mediaState,
                pending.receivedAt,
                now
            );
            return mediaState ? { roomId: pending.roomId, mediaState } : null;
        },

        markHandled(nextRoomId, revision) {
            if (normalizeRoomId(nextRoomId) !== roomId
                || !Number.isSafeInteger(revision)
                || revision < 1) {
                return false;
            }
            knownRevision = Math.max(knownRevision, revision);
            appliedRevision = Math.max(appliedRevision, revision);
            if (pending?.mediaState.revision <= revision) pending = null;
            return true;
        },

        clear() {
            adoptRoom(null);
        },

        restore(value, currentRoomId) {
            adoptRoom(currentRoomId);
            if (!value || typeof value !== 'object' || value.roomId !== roomId || !roomId) return false;
            knownRevision = Number.isSafeInteger(value.knownRevision) && value.knownRevision >= 0
                ? value.knownRevision
                : 0;
            appliedRevision = Number.isSafeInteger(value.appliedRevision) && value.appliedRevision >= 0
                ? Math.min(value.appliedRevision, knownRevision)
                : 0;
            const restoredPending = validateCanonicalMediaState(value.pending?.mediaState);
            if (value.pending?.roomId === roomId
                && restoredPending
                && restoredPending.revision >= appliedRevision
                && restoredPending.revision >= knownRevision) {
                pending = {
                    roomId,
                    mediaState: restoredPending,
                    receivedAt: typeof value.pending.receivedAt === 'number'
                        && Number.isFinite(value.pending.receivedAt)
                        ? value.pending.receivedAt
                        : Date.now()
                };
                knownRevision = restoredPending.revision;
            }
            return true;
        },

        snapshot() {
            return {
                roomId,
                knownRevision,
                appliedRevision,
                pending: pending ? {
                    roomId: pending.roomId,
                    mediaState: { ...pending.mediaState },
                    receivedAt: pending.receivedAt
                } : null
            };
        }
    };
}
