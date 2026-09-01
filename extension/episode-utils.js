/**
 * KoalaSync Episode Title Utilities
 * Single source of truth — synced to content.js by build-extension.cjs.
 * Keep in sync with the injection block in content.js!
 */

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
    if (!sameEpisode(titleA, titleB)) return false;
    const contextA = episodeContext(titleA);
    const contextB = episodeContext(titleB);
    return !contextA || !contextB || contextA === contextB;
}
