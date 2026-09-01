/**
 * KoalaSync Episode Title Utilities
 * Single source of truth — synced to content.js by build-extension.cjs.
 * Keep in sync with the injection block in content.js!
 */

// The relay clamps episode titles to 100 UTF-16 code units. Clamp before the
// wire and before strict comparison as well; otherwise a valid long local title
// can never match the relay's authoritative value.
export const EPISODE_WIRE_TITLE_LENGTH = 100;

export function toEpisodeWireTitle(title) {
    if (typeof title !== 'string' || title.length === 0) return null;
    return title.substring(0, EPISODE_WIRE_TITLE_LENGTH);
}

export function extractEpisodeId(title) {
    if (!title || typeof title !== 'string') return null;
    const se = title.match(/S(?:eason\s*)?(\d+)[^a-zA-Z0-9]*E(?:pisode\s*)?(\d+)/i);
    if (se) return `S${String(se[1]).padStart(2, '0')}E${String(se[2]).padStart(2, '0')}`;
    const ep = title.match(/(?:Episode|Folge|Ep\.?|#)\s*(\d+)/i);
    if (ep) return `EP${String(ep[1]).padStart(3, '0')}`;
    return null;
}

export function sameEpisode(titleA, titleB) {
    if (!titleA && !titleB) return true;
    if (!titleA || !titleB) return false;
    const idA = extractEpisodeId(titleA);
    const idB = extractEpisodeId(titleB);
    if (idA && idB) return idA === idB;
    if (idA || idB) return false;
    return titleA === titleB;
}

function episodeContext(title) {
    if (!title || typeof title !== 'string') return '';
    return title
        .replace(/S(?:eason\s*)?\d+[^a-zA-Z0-9]*E(?:pisode\s*)?\d+/ig, ' ')
        .replace(/(?:Episode|Folge|Ep\.?)\s*\d+|#\s*\d+/ig, ' ')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

// Transactional episode sync is deliberately stricter than ordinary playback
// filtering: if both peers expose contextual text (episode/show name), require
// it to agree so two unrelated S01E06 videos cannot cross-sync. Privacy-reduced
// S/E-only titles still fall back to the canonical episode ID.
export function sameEpisodeStrict(titleA, titleB) {
    const wireTitleA = toEpisodeWireTitle(titleA);
    const wireTitleB = toEpisodeWireTitle(titleB);
    if (!sameEpisode(wireTitleA, wireTitleB)) return false;
    const contextA = episodeContext(wireTitleA);
    const contextB = episodeContext(wireTitleB);
    if (!contextA || !contextB || contextA === contextB) return true;
    // Players disagree about whether MediaSession.title contains the series,
    // episode title, or both. Accept a complete token-boundary subset while
    // still rejecting unrelated contextual titles for the same S/E number.
    const [shorter, longer] = contextA.length <= contextB.length
        ? [contextA, contextB]
        : [contextB, contextA];
    return shorter.length >= 4 && ` ${longer} `.includes(` ${shorter} `);
}

export function createEpisodeWireIdentity(title) {
    const expectedEpisodeId = extractEpisodeId(title);
    const expectedTitle = toEpisodeWireTitle(title);
    if (!expectedTitle || !expectedEpisodeId) return null;
    return { expectedTitle, expectedEpisodeId };
}

export function sameEpisodeIdentity(localTitle, expectedTitle, expectedEpisodeId = null) {
    const normalizedExpectedId = typeof expectedEpisodeId === 'string'
        ? expectedEpisodeId.trim().toUpperCase().substring(0, 16)
        : null;
    if (normalizedExpectedId && extractEpisodeId(localTitle) !== normalizedExpectedId) return false;
    return sameEpisodeStrict(localTitle, expectedTitle);
}

export function createLocalEpisodeDeadline(remainingMs, fallbackMs, now = Date.now()) {
    const safeFallback = Number.isFinite(fallbackMs) && fallbackMs > 0 ? fallbackMs : 0;
    const safeRemaining = Number.isFinite(remainingMs)
        ? Math.max(0, Math.min(safeFallback, remainingMs))
        : safeFallback;
    return {
        remainingMs: safeRemaining,
        deadlineAt: now + safeRemaining
    };
}

export function isEpisodeSyncV2StartContextCurrent(pending, current, now = Date.now()) {
    return !!pending
        && !!current
        && now - pending.requestedAt >= 0
        && now - pending.requestedAt <= 15000
        && pending.roomId === current.roomId
        && pending.connectionGeneration === current.connectionGeneration
        && pending.targetGeneration === current.targetGeneration
        && pending.tabId === current.tabId;
}

export function matchesEpisodeSyncV2StartRejection(pending, current, rejection, now = Date.now()) {
    if (!isEpisodeSyncV2StartContextCurrent(pending, current, now)) return false;
    const rejectionTitle = toEpisodeWireTitle(rejection?.expectedTitle);
    const rejectionEpisodeId = typeof rejection?.expectedEpisodeId === 'string'
        ? rejection.expectedEpisodeId.trim().toUpperCase().substring(0, 16)
        : extractEpisodeId(rejectionTitle);
    return rejectionTitle === pending.expectedTitle
        && (!rejectionEpisodeId || rejectionEpisodeId === pending.expectedEpisodeId);
}
