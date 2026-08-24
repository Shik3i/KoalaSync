export const MEDIA_FRAME_ACCESS_REQUIRED = 'media_frame_access_required';
export const MEDIA_FRAME_PROBE_TIMEOUT = 'media_frame_probe_timeout';

const MIN_PLAYER_FRAME_AREA = 320 * 180;
const MIN_PLAYER_ASPECT_RATIO = 1.15;
const MAX_PLAYER_ASPECT_RATIO = 2.6;
// inspectMediaFrame is synchronous DOM work: a live frame answers in tens of
// milliseconds, and anything slower is a frame that is navigating or being torn
// down. Waiting seconds for those only delays the answer — a frame dropped here
// is re-probed on the next attempt and reports itself through its monitor.
const DEFAULT_PROBE_TIMEOUT_MS = 750;

function normalizeFrameId(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeOrigin(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') ? url.origin : null;
    } catch {
        return null;
    }
}

function originPattern(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        // WebExtension match patterns intentionally omit ports. Chromium treats
        // the host pattern port-independently; Firefox rejects explicit ports.
        return `${url.protocol}//${url.hostname}/*`;
    } catch {
        return null;
    }
}

function isGoogleDrivePlayerUrl(value) {
    try {
        const url = new URL(value);
        if (url.hostname.toLowerCase() !== 'youtube.googleapis.com'
            || (url.pathname !== '/embed' && !url.pathname.startsWith('/embed/'))) {
            return false;
        }
        const parentOrigin = url.searchParams.get('origin') || url.searchParams.get('post_message_origin');
        return parentOrigin === 'https://drive.google.com';
    } catch {
        return false;
    }
}

/**
 * Runs inside every frame through chrome.scripting.executeScript. Keep this
 * function self-contained: extension functions outside its body are not
 * available in the injected isolated world.
 */
export function inspectMediaFrame(expectedVisibilityToken = null) {
    const elementIsVisible = (element, rect) => {
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const view = element.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }
        if (typeof element.checkVisibility === 'function'
            && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
            return false;
        }
        const layoutWidth = Math.max(view.innerWidth, element.ownerDocument?.documentElement?.scrollWidth || 0);
        const layoutHeight = Math.max(view.innerHeight, element.ownerDocument?.documentElement?.scrollHeight || 0);
        const scrollX = Number(view.scrollX) || 0;
        const scrollY = Number(view.scrollY) || 0;
        return rect.bottom + scrollY > 0
            && rect.right + scrollX > 0
            && rect.top + scrollY < layoutHeight
            && rect.left + scrollX < layoutWidth;
    };

    const collectVideos = (doc, depth = 0, ancestorVisible = true, videos = [], seen = new Set()) => {
        if (depth >= 4 || typeof doc.querySelectorAll !== 'function') return videos;
        for (const video of doc.querySelectorAll('video')) {
            if (!seen.has(video)) {
                seen.add(video);
                videos.push({ video, ancestorVisible });
            }
        }
        const hosts = doc.querySelectorAll('[id*="player" i], [class*="player" i], [id*="video" i], [class*="video" i], [id*="media" i], [class*="media" i], [id*="stream" i], [class*="stream" i], ytd-player, netflix-player, emby-player, jellyfin-player, video-player');
        for (const host of hosts) {
            if (!host.shadowRoot) continue;
            for (const video of host.shadowRoot.querySelectorAll('video')) {
                if (!seen.has(video)) {
                    seen.add(video);
                    videos.push({ video, ancestorVisible });
                }
            }
        }

        for (const frame of doc.querySelectorAll('iframe, frame')) {
            try {
                const frameRect = frame.getBoundingClientRect();
                const frameVisible = ancestorVisible && elementIsVisible(frame, frameRect);
                const frameDoc = frame.contentDocument;
                if (frameDoc) collectVideos(frameDoc, depth + 1, frameVisible, videos, seen);
            } catch {
                // Cross-origin media is inspected in its own execution result.
            }
        }
        return videos;
    };

    const videoDetails = collectVideos(document).map(({ video, ancestorVisible }) => {
        const rect = video.getBoundingClientRect();
        const rendered = ancestorVisible && elementIsVisible(video, rect);
        const hasSource = !!(video.currentSrc || video.src || video.srcObject
            || video.querySelector?.('source[src]'));
        const background = !!video.loop && !!video.muted && !video.controls;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const shortUncontrolled = !video.controls && duration > 0 && duration < 300;
        const renderedArea = Math.max(0, rect.width) * Math.max(0, rect.height);
        return {
            hasSource,
            rendered,
            background,
            shortUncontrolled,
            sizeBucket: Math.round(Math.sqrt(renderedArea) / 40),
            playing: video.paused === false && video.ended !== true,
            controls: !!video.controls,
            readyState: Number.isInteger(video.readyState) ? video.readyState : 0,
            duration,
            renderedArea
        };
    });

    const compareVideo = (left, right) => {
        const leftRank = [
            left.hasSource ? 1 : 0,
            left.rendered ? 1 : 0,
            left.background ? 0 : 1,
            left.shortUncontrolled ? 0 : 1,
            left.playing ? 1 : 0,
            left.controls ? 1 : 0,
            left.readyState,
            left.duration,
            left.sizeBucket
        ];
        const rightRank = [
            right.hasSource ? 1 : 0,
            right.rendered ? 1 : 0,
            right.background ? 0 : 1,
            right.shortUncontrolled ? 0 : 1,
            right.playing ? 1 : 0,
            right.controls ? 1 : 0,
            right.readyState,
            right.duration,
            right.sizeBucket
        ];
        for (let index = 0; index < leftRank.length; index++) {
            if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
        }
        return 0;
    };
    videoDetails.sort(compareVideo);

    // Recursively list direct and same-origin-descendant frame elements. This
    // lets the background identify a large inaccessible player origin even if
    // an all-frame probe is rejected by the browser's site-access policy.
    const embeddedFrames = [];
    const collectEmbeddedFrames = (doc, depth = 0, ancestorVisible = true) => {
        if (depth >= 4 || typeof doc.querySelectorAll !== 'function') return;
        for (const frame of doc.querySelectorAll('iframe, frame')) {
            const rect = frame.getBoundingClientRect();
            const directVisible = elementIsVisible(frame, rect);
            const visible = ancestorVisible && directVisible;
            // An iframe without src resolves to the *parent* document's URL, so
            // record whether the element really carried one. Treating a srcless
            // ad slot's href as its own would let a hidden slot mark the page
            // that contains it as hidden.
            const rawSrc = frame.getAttribute?.('src') || '';
            let href = '';
            try { href = new URL(frame.src || '', doc.location.href).href; } catch { href = ''; }
            embeddedFrames.push({
                href,
                explicitSrc: rawSrc.trim().length > 0,
                origin: (() => { try { return new URL(href).origin; } catch { return null; } })(),
                area: Math.max(0, rect.width) * Math.max(0, rect.height),
                width: Math.max(0, rect.width),
                height: Math.max(0, rect.height),
                visible,
                depth: depth + 1,
                mediaHint: frame.allowFullscreen === true
                    || frame.hasAttribute?.('allowfullscreen')
                    || /autoplay|fullscreen|picture-in-picture|encrypted-media/i.test(frame.getAttribute('allow') || '')
                    || /player|video|stream|watch|embed|media|xfp/i.test([
                        frame.id,
                        frame.name,
                        frame.className,
                        frame.title,
                        href
                    ].join(' '))
            });
            try {
                const frameDoc = frame.contentDocument;
                if (frameDoc) collectEmbeddedFrames(frameDoc, depth + 1, visible);
            } catch {
                // Cross-origin descendants are represented by their frame URL.
            }
        }
    };
    collectEmbeddedFrames(document);

    const storedParentVisibility = window.__koalaParentFrameVisibility;
    const parentVisibility = expectedVisibilityToken
        && storedParentVisibility?.token === expectedVisibilityToken
        ? storedParentVisibility
        : null;
    return {
        href: window.location.href,
        origin: window.location.origin,
        isTop: window.top === window,
        videoCount: videoDetails.length,
        bestVideo: videoDetails[0] || null,
        frameArea: Math.max(0, window.innerWidth) * Math.max(0, window.innerHeight),
        parentFrameVisible: window.top === window
            ? true
            : parentVisibility?.visible ?? null,
        parentFrameArea: window.top === window
            ? Math.max(0, window.innerWidth) * Math.max(0, window.innerHeight)
            : (Number.isFinite(parentVisibility?.area) ? parentVisibility.area : null),
        embeddedFrames
    };
}

/** Runs inside every frame before the visibility dispatch. */
export function installParentFrameVisibilityProbe(token) {
    try { window.__koalaFrameVisibilityCleanup?.(); } catch { /* stale probe */ }
    window.__koalaParentFrameVisibility = { token, visible: null, area: null };
    let timeout = null;
    const cleanup = () => {
        window.removeEventListener('message', handler);
        if (timeout !== null) clearTimeout(timeout);
        if (window.__koalaFrameVisibilityCleanup === cleanup) {
            delete window.__koalaFrameVisibilityCleanup;
        }
    };
    const handler = (event) => {
        if (event.source !== window.parent
            || event.data?.type !== 'KOALASYNC_FRAME_VISIBILITY'
            || event.data?.token !== token) {
            return;
        }
        window.__koalaParentFrameVisibility = {
            token,
            visible: event.data.visible === true,
            area: Number.isFinite(event.data.area) ? event.data.area : 0
        };
    };
    window.addEventListener('message', handler);
    // The listener has to outlive the whole probe sequence: install, four
    // dispatch passes and the final inspection, each a separate executeScript
    // round trip. On a heavy page those add up well past a second, and a
    // listener that expired first left every frame's visibility unknown — which
    // is exactly the state that makes two players look equally ranked.
    timeout = setTimeout(cleanup, 15000);
    window.__koalaFrameVisibilityCleanup = cleanup;
}

/** Runs inside every frame; each parent reports geometry to its direct children. */
export function dispatchParentFrameVisibilityProbe(token) {
    const ancestor = window.top === window ? { visible: true, area: Infinity } : window.__koalaParentFrameVisibility;
    for (const frame of document.querySelectorAll('iframe, frame')) {
        try {
            const rect = frame.getBoundingClientRect();
            const style = window.getComputedStyle(frame);
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            const layoutWidth = Math.max(window.innerWidth, document.documentElement?.scrollWidth || 0);
            const layoutHeight = Math.max(window.innerHeight, document.documentElement?.scrollHeight || 0);
            const scrollX = Number(window.scrollX) || 0;
            const scrollY = Number(window.scrollY) || 0;
            const intersectsLayout = rect.bottom + scrollY > 0
                && rect.right + scrollX > 0
                && rect.top + scrollY < layoutHeight
                && rect.left + scrollX < layoutWidth;
            const browserReportsVisible = typeof frame.checkVisibility === 'function'
                ? frame.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                : true;
            const directlyVisible = area > 0
                && intersectsLayout
                && browserReportsVisible
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity) !== 0;
            const visible = directlyVisible && ancestor?.visible !== false;
            const inheritedArea = Number.isFinite(ancestor?.area) ? ancestor.area : area;
            const effectiveArea = Math.min(area, inheritedArea);
            frame.contentWindow?.postMessage({
                type: 'KOALASYNC_FRAME_VISIBILITY',
                token,
                visible,
                area: effectiveArea
            }, '*');
        } catch {
            // A detached or browser-owned frame is not a candidate.
        }
    }
}

function mediaCandidateRank(entry) {
    const result = entry.result;
    const video = result.bestVideo;
    const visibility = result.parentFrameVisible === true
        ? 2
        : result.parentFrameVisible === false
            ? 0
            : 1;
    return [
        visibility,
        video.hasSource ? 1 : 0,
        video.rendered ? 1 : 0,
        video.background ? 0 : 1,
        video.shortUncontrolled ? 0 : 1,
        video.playing ? 1 : 0,
        video.controls ? 1 : 0,
        video.readyState,
        video.duration,
        video.sizeBucket,
        result.isTop ? 1 : 0,
        Number.isFinite(result.parentFrameArea) ? result.parentFrameArea : result.frameArea
    ];
}

function compareRanks(left, right) {
    const leftRank = mediaCandidateRank(left);
    const rightRank = mediaCandidateRank(right);
    for (let index = 0; index < leftRank.length; index++) {
        if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index];
    }
    return 0;
}

function sameMeaningfulRank(left, right) {
    const leftRank = mediaCandidateRank(left);
    const rightRank = mediaCandidateRank(right);
    // Ignore duration, size, top-frame preference, and raw frame area. Two
    // otherwise identical frames are unsafe to distinguish by preload metadata.
    return leftRank.slice(0, 8).every((value, index) => value === rightRank[index]);
}

/**
 * Frames whose own element was seen as hidden by an ancestor that could inspect
 * it directly. A same-origin wrapper collapsed to 0x0 — the usual way an anime
 * host parks the mirrors you are not watching — is reported here by the top
 * frame itself, so the hidden player can be ruled out without waiting for the
 * postMessage visibility handshake to complete.
 */
function hiddenFrameHrefs(injectionResults) {
    const visibility = new Map();
    for (const entry of Array.isArray(injectionResults) ? injectionResults : []) {
        for (const frame of entry?.result?.embeddedFrames || []) {
            if (typeof frame?.href !== 'string' || !frame.href) continue;
            // Without an explicit src the href is the parent's, not this frame's.
            if (frame.explicitSrc !== true) continue;
            // A frame cannot testify about the document that reported it.
            if (frame.href === entry?.result?.href) continue;
            // Any ancestor reporting it visible wins over one reporting it hidden.
            visibility.set(frame.href, (visibility.get(frame.href) === true) || frame.visible === true);
        }
    }
    const hidden = new Set();
    for (const [href, visible] of visibility) if (!visible) hidden.add(href);
    return hidden;
}

export function selectMediaFrame(injectionResults) {
    const hidden = hiddenFrameHrefs(injectionResults);
    const candidates = (Array.isArray(injectionResults) ? injectionResults : [])
        .filter(entry => Number.isInteger(entry?.frameId)
            && entry?.result?.bestVideo?.rendered === true)
        .filter(entry => entry.result.parentFrameVisible !== false)
        .filter(entry => !hidden.has(entry.result.href))
        .sort(compareRanks);
    if (candidates.length === 0) return null;
    if (candidates.length > 1
        && candidates[0].result.parentFrameVisible !== true
        && candidates[1].result.parentFrameVisible !== true
        && sameMeaningfulRank(candidates[0], candidates[1])) {
        return null;
    }
    return candidates[0];
}

function findMissingPlayerAccess(results) {
    const accessibleOrigins = new Set();
    for (const entry of results) {
        const origin = safeOrigin(entry?.result?.href);
        if (origin) accessibleOrigins.add(origin);
    }

    const missingByOrigin = new Map();
    for (const entry of results) {
        for (const frame of entry?.result?.embeddedFrames || []) {
            if (!frame.visible || accessibleOrigins.has(frame.origin) || !frame.origin) continue;
            const aspectRatio = frame.height > 0 ? frame.width / frame.height : 0;
            const drivePlayer = isGoogleDrivePlayerUrl(frame.href);
            const looksLikePlayer = frame.mediaHint === true
                && frame.area >= MIN_PLAYER_FRAME_AREA
                && aspectRatio >= MIN_PLAYER_ASPECT_RATIO
                && aspectRatio <= MAX_PLAYER_ASPECT_RATIO;
            if (!drivePlayer && !looksLikePlayer) continue;
            const previous = missingByOrigin.get(frame.origin);
            if (!previous || frame.area > previous.area || drivePlayer) {
                missingByOrigin.set(frame.origin, { ...frame, drivePlayer });
            }
        }
    }

    const missing = Array.from(missingByOrigin.values()).sort((left, right) => {
        if (left.drivePlayer !== right.drivePlayer) return left.drivePlayer ? -1 : 1;
        return right.area - left.area;
    });
    if (missing.length === 0) return null;
    if (!missing[0].drivePlayer && missing.length > 1 && missing[0].area < missing[1].area * 1.5) {
        return null;
    }
    return {
        host: new URL(missing[0].origin).hostname,
        originPattern: originPattern(missing[0].origin),
        area: missing[0].area,
        drivePlayer: missing[0].drivePlayer === true
    };
}

function shouldPreferMissingAccess(access, selected) {
    if (!access) return false;
    if (!selected?.result?.bestVideo) return true;
    const video = selected.result.bestVideo;
    if (!video.hasSource || !video.rendered || video.background) return true;
    const selectedArea = Number.isFinite(video.renderedArea) ? video.renderedArea : 0;
    const weakAccessibleCandidate = !video.controls
        && video.duration > 0
        && video.duration < 300;
    // Drive never plays the file in its own document, so its embedded player
    // outranks a weak local candidate. It must not outrank a real one: a Drive
    // tab can host an ordinary accessible video next to a file preview.
    if (access.drivePlayer) {
        return weakAccessibleCandidate || selectedArea < MIN_PLAYER_FRAME_AREA;
    }
    return weakAccessibleCandidate
        && access.area >= Math.max(MIN_PLAYER_FRAME_AREA, selectedArea * 1.5);
}

function accessRequiredError(access) {
    const error = new Error(`Embedded player access is required for ${access.host}`);
    error.code = MEDIA_FRAME_ACCESS_REQUIRED;
    error.host = access.host;
    error.originPattern = access.originPattern;
    return error;
}

function contentTarget(tabId, selected, discoveredFrameIds = null) {
    const frameId = normalizeFrameId(selected?.frameId);
    const documentId = typeof selected?.documentId === 'string' ? selected.documentId : null;
    return {
        frameId,
        // Every frame this probe reached, so the caller can remember them and
        // recover directly next time the all-frames sweep is rejected.
        discoveredFrameIds: Array.isArray(discoveredFrameIds) ? discoveredFrameIds : [],
        documentId,
        frameUrl: typeof selected?.result?.href === 'string' ? selected.result.href : null,
        hasVideo: !!selected?.result?.bestVideo,
        visibilityConfirmed: selected?.result?.parentFrameVisible === true,
        scriptTarget: documentId
            ? { tabId, documentIds: [documentId] }
            : (frameId === 0 ? { tabId } : { tabId, frameIds: [frameId] })
    };
}

export function listMediaFrameScriptTargets(tabId) {
    return [{ tabId, allFrames: true }];
}

/** Pins one probe to one frame, preferring the exact document when known. */
function frameScriptTarget(tabId, entry) {
    const frameId = normalizeFrameId(entry?.frameId);
    return typeof entry?.documentId === 'string' && entry.documentId
        ? { tabId, documentIds: [entry.documentId] }
        : { tabId, frameIds: [frameId] };
}

/**
 * Later results replace earlier ones for the same frame. A frame that navigated
 * between two probes must not appear twice, because two stale copies of one
 * frame look exactly like two competing players.
 */
function mergeFrameResults(...groups) {
    const merged = new Map();
    for (const group of groups) {
        for (const entry of Array.isArray(group) ? group : []) {
            if (!Number.isInteger(entry?.frameId)) continue;
            merged.set(`frame:${entry.frameId}`, entry);
        }
    }
    return Array.from(merged.values());
}

function probeTimeoutError(label, timeoutMs) {
    const error = new Error(`${label} timed out after ${timeoutMs}ms`);
    error.code = MEDIA_FRAME_PROBE_TIMEOUT;
    return error;
}

function executeWithTimeout(task, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task();
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(probeTimeoutError(label, timeoutMs)), timeoutMs);
    });
    const taskPromise = Promise.resolve().then(task);
    taskPromise.catch(() => {});
    return Promise.race([taskPromise, timeout]).finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
    });
}

async function executeInAccessibleFrames(chromeApi, targets, func, args, timeoutMs) {
    const errors = [];
    const settled = await Promise.all(targets.map(async target => {
        try {
            const result = await executeWithTimeout(
                () => chromeApi.scripting.executeScript({ target, func, args }),
                timeoutMs,
                `Frame probe ${JSON.stringify(target)}`
            );
            return Array.isArray(result) ? result : [];
        } catch (error) {
            // A failed probe is recorded, never silently dropped. Only the
            // caller can tell "withheld origin" from "frame is still loading",
            // and guessing that difference is what produced false permission
            // prompts for players the extension was already allowed to touch.
            errors.push({ target, error });
            return [];
        }
    }));
    return { results: settled.flat(), errors };
}

/**
 * Asks the browser whether an origin is genuinely withheld.
 *
 * Returns true when the grant is missing, false when it is held, and null when
 * the browser cannot answer. A frame that did not respond to a probe is not
 * evidence of a missing grant: that inference is what made Drive and
 * YummyAnime demand access for an origin the extension already had.
 */
async function originAccessIsWithheld(chromeApi, originPattern) {
    if (typeof originPattern !== 'string' || !originPattern) return null;
    if (typeof chromeApi?.permissions?.contains !== 'function') return null;
    try {
        const granted = await executeWithTimeout(
            () => Promise.resolve(chromeApi.permissions.contains({ origins: [originPattern] })),
            1000,
            `Permission check for ${originPattern}`
        );
        if (granted === true) return false;
        if (granted === false) return true;
        return null;
    } catch {
        return null;
    }
}

export async function resolveMediaContentTarget(chromeApi, tabId, {
    // v3.1.2's retry budget: a player frame can take several seconds to appear,
    // and giving up early is what turns a slow page into "no video found".
    attempts = 8,
    retryDelayMs = 200,
    probeDelayMs = 60,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    // Frame ids the background has seen in this tab. They rescue the probe when
    // the all-frames sweep is rejected wholesale by one unrelated frame.
    knownFrameIds = [],
    // ...but the budget is now wall-clock bounded, so a page whose frames all
    // time out cannot hold the activation open for minutes.
    deadlineMs = 12000
} = {}) {
    const startedAt = Date.now();
    let fallback = null;
    let missingAccess = null;
    let ambiguous = false;
    let unresolvedGrantedHost = null;
    const discovered = new Set(Array.isArray(knownFrameIds) ? knownFrameIds : []);

    for (let attempt = 0; attempt < attempts; attempt++) {
        const scriptTargets = listMediaFrameScriptTargets(tabId);
        let { results } = await executeInAccessibleFrames(
            chromeApi,
            scriptTargets,
            inspectMediaFrame,
            [null],
            probeTimeoutMs
        );
        // Any frame the sweep missed but that we know exists gets asked directly.
        // One rejected probe then costs one frame, not the whole page.
        const missingFrameIds = knownFrameIds.filter(frameId => Number.isInteger(frameId)
            && !results.some(entry => entry.frameId === frameId));
        if (missingFrameIds.length > 0) {
            const { results: recovered } = await executeInAccessibleFrames(
                chromeApi,
                missingFrameIds.map(frameId => ({ tabId, frameIds: [frameId] })),
                inspectMediaFrame,
                [null],
                probeTimeoutMs
            );
            if (recovered.length > 0) results = mergeFrameResults(results, recovered);
        }

        if (results.length === 0) {
            // The all-frames sweep answered for nothing at all, so fall back to
            // the top document alone. Every probe is time-boxed: an unreachable
            // player frame must never stall the whole activation.
            try {
                const topResults = await executeWithTimeout(
                    () => chromeApi.scripting.executeScript({
                        target: { tabId },
                        func: inspectMediaFrame,
                        args: [null]
                    }),
                    probeTimeoutMs,
                    'Top-frame probe'
                );
                results = Array.isArray(topResults) ? topResults : [];
                if (results.length === 0) return contentTarget(tabId, null);
            } catch {
                return contentTarget(tabId, null);
            }
        }

        const candidateCount = results.filter(
            entry => entry?.result?.bestVideo?.rendered === true
        ).length;
        // The visibility handshake only exists to rank and exclude video
        // candidates. With no video on the page yet there is nothing to rank, and
        // running it anyway cost several seconds on every attempt — the whole
        // reason selecting an anime tab before playback felt broken.
        if (results.length > 1 && candidateCount > 0) {
            const token = `${tabId}:${attempt}:${Date.now()}:${Math.random()}`;
            // Address each discovered frame on its own from here on. A single
            // allFrames call is all-or-nothing: one player or ad frame that
            // never answers takes the whole probe down with it. v3.1.2 avoided
            // that by listing frames through webNavigation — but the sweep
            // above already reports frameId and documentId for every frame it
            // reached, so the same isolation costs no permission at all.
            // A leaf frame with no video and no nested frames can never be a
            // candidate nor an ancestor of one. Ad slots are exactly that, and
            // they churn constantly, so every phase below would otherwise wait
            // on a frame that was already being torn down.
            const relevant = results.filter(entry => (entry?.result?.videoCount || 0) > 0
                || (entry?.result?.embeddedFrames?.length || 0) > 0
                || entry?.result?.isTop === true);
            const frameTargets = (relevant.length > 0 ? relevant : results)
                .map(entry => frameScriptTarget(tabId, entry));
            try {
                const visibilityTimeoutMs = Math.min(probeTimeoutMs, 750);
                await executeInAccessibleFrames(
                    chromeApi,
                    frameTargets,
                    installParentFrameVisibilityProbe,
                    [token],
                    visibilityTimeoutMs
                );
                // One pass per nesting level actually present. Four was the
                // worst case, not the common one; these players sit two levels
                // down and each surplus pass is a full round trip.
                const observedDepth = results.reduce((deepest, entry) => Math.max(
                    deepest,
                    ...(entry?.result?.embeddedFrames || []).map(frame => frame.depth || 1)
                ), 1);
                const passes = Math.min(4, Math.max(2, observedDepth));
                for (let pass = 0; pass < passes; pass++) {
                    await executeInAccessibleFrames(
                        chromeApi,
                        frameTargets,
                        dispatchParentFrameVisibilityProbe,
                        [token],
                        visibilityTimeoutMs
                    );
                    await new Promise(resolve => setTimeout(resolve, probeDelayMs));
                }
                const { results: inspected } = await executeInAccessibleFrames(
                    chromeApi,
                    frameTargets,
                    inspectMediaFrame,
                    [token],
                    probeTimeoutMs
                );
                if (inspected.length > 0) results = mergeFrameResults(results, inspected);
            } catch {
                // Initial results remain usable, but equally-ranked unknown
                // frames will be rejected below rather than guessed.
            }
        }

        for (const entry of results) {
            if (Number.isInteger(entry?.frameId)) discovered.add(entry.frameId);
        }
        const selected = selectMediaFrame(results);
        const videoCandidates = results.filter(entry => entry?.result?.bestVideo?.rendered === true
            && entry.result.parentFrameVisible !== false);
        let currentMissingAccess = findMissingPlayerAccess(results);
        if (currentMissingAccess) {
            const withheld = await originAccessIsWithheld(
                chromeApi,
                currentMissingAccess.originPattern
            );
            if (withheld === false) {
                // The grant is already held, so the player frame is merely slow,
                // still navigating, or gone. Retrying is correct here; prompting
                // for a permission the user already gave is not.
                unresolvedGrantedHost = currentMissingAccess.host;
                currentMissingAccess = null;
            }
        }
        missingAccess = currentMissingAccess;
        fallback = selected;
        ambiguous = !selected && videoCandidates.length > 1;
        if (selected) {
            if (selected.result.bestVideo.hasSource
                && selected.result.bestVideo.rendered
                && !shouldPreferMissingAccess(currentMissingAccess, selected)) {
                return contentTarget(tabId, selected, Array.from(discovered));
            }
        }

        if (Number.isFinite(deadlineMs) && deadlineMs > 0 && Date.now() - startedAt >= deadlineMs) {
            break;
        }
        // Nothing on the page has a video element yet. Spending the retry budget
        // cannot change that; the injected monitor reports the player the moment
        // it is created, so return now and let selection be instant.
        const anyVideo = results.some(entry => (entry?.result?.videoCount || 0) > 0);
        if (!anyVideo) {
            // Discovery worked and simply found no player yet, so stop: the
            // monitor reports one within a fraction of a second once it exists.
            // Retry only when the sweep itself came back thin, which is the case
            // a second pass can actually fix.
            if (results.length > 1) break;
            if (attempt >= 1) break;
        }
        if (attempt < attempts - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
    }

    if (missingAccess) throw accessRequiredError(missingAccess);
    if (fallback) return contentTarget(tabId, fallback, Array.from(discovered));
    // A player whose origin is already granted but which never answered is a
    // timing problem, not a user decision. Keep the tab selected on its top
    // frame so the injected monitor can promote the real player once it loads,
    // instead of failing the activation or prompting for nothing.
    if (unresolvedGrantedHost) return contentTarget(tabId, null, Array.from(discovered));
    // Several equally-ranked players — anime mirrors, alternative dubs — are a
    // normal page layout, not an error. Refusing to activate made those pages
    // unusable, and flipping between candidates restarted the target forever.
    // Hold the top frame and let the monitor promote the one that starts
    // playing, which is the signal that breaks the tie.
    if (ambiguous) return { ...contentTarget(tabId, null, Array.from(discovered)), ambiguous: true };
    return contentTarget(tabId, null, Array.from(discovered));
}
