import { EVENTS, ERROR_CODES, CONTROL_MODES, CAPABILITIES, PROTOCOL_VERSION, OFFICIAL_SERVER_URL, OFFICIAL_SERVER_TOKEN, EPISODE_LOBBY_TIMEOUT, FORCE_SYNC_TIMEOUT, HEARTBEAT_INTERVAL } from './shared/constants.js';
import { generateUsername } from './shared/names.js';
import { loadLocale, getMessage, getSystemLanguage } from './i18n.js';
import { sameEpisode, sameEpisodeStrict, extractEpisodeId } from './episode-utils.js';
import { applyTitlePrivacyToPayload, sanitizeSharedTitle, sanitizeTabTitle, normalizeSendTabTitle, normalizeTitlePrivacyMode } from './title-privacy.js';
import { initTabManager } from './modules/tab-manager.js';
import { clearChatKeyCache, decryptChatMessage, encryptChatMessage, generateChatSecret, validateChatSecret } from './chat-crypto.js';
import { buildChatRelayPayload, encodeSocketEvent } from './chat-wire.js';
import { createChatEchoTracker, createChatSendLimiter, createLatestTaskQueue, normalizeRoomId, shouldShowChatNotification } from './chat-session.js';
import { createChatActivityStore } from './chat-activity.js';
import { canonicalMediaStateFromRoomData, createCanonicalMediaStateTracker } from './canonical-media-state.js';
import {
    drainQueuedBatch,
    enqueueQueuedEvent,
    isMediaQueueEvent,
    isQueuedMediaIntent,
    maxQueuedSequence,
    mediaIntentNeedsSequenceReservation,
    normalizePersistedEventQueue,
    queuedMediaIntentCount,
    queuedWireCount,
    reconcileQueuedRoomIntent,
    reserveLatestMediaIntentSequence
} from './offline-media-intent.js';
import { HOST_ACCESS_REQUIRED_STATUS, normalizeTabId, inspectTabHostAccess, isHostAccessError, addTabHostAccessRequest, removeTabHostAccessRequest } from './host-access.js';
import {
    MEDIA_FRAME_ACCESS_REQUIRED,
    listMediaFrameScriptTargets,
    resolveMediaContentTarget
} from './media-frame-target.js';
import './page-api-seek-overrides.js';

// --- Uninstall URL Initialization ---
let uninstallURLInitPromise = null;

async function initUninstallURL() {
    if (uninstallURLInitPromise) {
        return uninstallURLInitPromise;
    }
    
    uninstallURLInitPromise = (async () => {
        // --- UNINSTALL_URL_INJECT_START ---
        const UNINSTALL_URL = ""; // Populated during build
        const BROWSER_TYPE = "unknown";
        // --- UNINSTALL_URL_INJECT_END ---
        
        if (UNINSTALL_URL && UNINSTALL_URL.trim() !== '') {
            try {
                const url = new URL(UNINSTALL_URL);
                url.searchParams.set("browser", BROWSER_TYPE);
                
                const runtimeAPI = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
                if (runtimeAPI && runtimeAPI.setUninstallURL) {
                    const result = runtimeAPI.setUninstallURL(url.href);
                    // browser.runtime.setUninstallURL returns a Promise, handle rejection silently
                    if (result && typeof result.catch === 'function') {
                        result.catch(err => console.warn('Failed to set uninstall URL:', err));
                    }
                }
            } catch (err) {
                console.error("Failed to initialize uninstall URL:", err);
            }
        }
    })();

    return uninstallURLInitPromise;
}

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install' || details.reason === 'update') {
        initUninstallURL();
        purgeLegacySyncKeys();
    }
});

chrome.runtime.onStartup.addListener(() => {
    initUninstallURL();
    purgeLegacySyncKeys();
});

// --- State Management ---
let socket = null;
let connectionGeneration = 0;
let isConnecting = false;
let peerId = null; // initialized via getPeerId()
let currentRoom = null;
let currentTabId = null;
let currentTabTitle = null; // New: for Smart Matching
// The tab the user picked, kept separately from the tab we managed to inject
// into. A failed or refused activation is a state of the selection, not a
// reason to silently discard it: dropping it here is what made the popup show
// no target again as soon as it was reopened.
let userSelectedTabId = null;
let userSelectedTabTitle = null;
let userSelectionErrorTabId = null;
let userSelectionErrorMessage = null;
let currentTargetFrameId = 0;
let currentTargetDocumentId = null;
let currentTargetHasVideo = false;
let targetActivationGeneration = 0;
let activeTargetActivation = null;
// Frame ids seen in this tab, learned from script results and from the frames
// that message us. An allFrames sweep is all-or-nothing — one ad frame tearing
// down while it runs makes Chromium reject the whole call, and the resolver
// then sees nothing but the top frame. v3.1.2 avoided that by listing frames
// through webNavigation; this registry rebuilds the same knowledge from
// sender.frameId, which every content script hands us for free.
const knownFrameIdsByTab = new Map();
const MAX_KNOWN_FRAMES_PER_TAB = 24;

function rememberFrameId(tabId, frameId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null || !Number.isInteger(frameId) || frameId < 0) return;
    let frames = knownFrameIdsByTab.get(normalizedTabId);
    if (!frames) {
        frames = new Set();
        knownFrameIdsByTab.set(normalizedTabId, frames);
    }
    frames.add(frameId);
    // Every id in here is probed individually when a sweep is rejected, so the
    // set is also a cost ceiling. Keep it small: a page with more media-bearing
    // frames than this is not a player page, and the sweep still covers the
    // normal case. The top frame is never evicted.
    while (frames.size > MAX_KNOWN_FRAMES_PER_TAB) {
        const evictable = Array.from(frames).find(candidate => candidate !== 0);
        if (evictable === undefined) break;
        frames.delete(evictable);
    }
}

/**
 * Replaces the registry when a probe actually saw the tab's frame layout.
 *
 * Clearing on navigation looked right and was wrong: tabs.onUpdated reports
 * status 'loading' for same-document History API navigations too, which is
 * exactly what these sites do when you switch mirror or episode part. The wipe
 * therefore landed the moment the player frame was being built, leaving the
 * recovery probe with nothing. A successful multi-frame probe is authoritative
 * and current, so it supersedes whatever was there instead.
 */
function refreshFrameIds(tabId, frameIds) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) return;
    const ids = (Array.isArray(frameIds) ? frameIds : [])
        .filter(frameId => Number.isInteger(frameId) && frameId >= 0);
    if (ids.length > 1) {
        knownFrameIdsByTab.set(normalizedTabId, new Set(ids.slice(0, MAX_KNOWN_FRAMES_PER_TAB)));
        return;
    }
    // A probe that only reached the top frame proves nothing about the rest.
    for (const frameId of ids) rememberFrameId(normalizedTabId, frameId);
}

function listKnownFrameIds(tabId) {
    const frames = knownFrameIdsByTab.get(normalizeTabId(tabId));
    return frames ? Array.from(frames) : [];
}

function forgetFrameIds(tabId) {
    knownFrameIdsByTab.delete(normalizeTabId(tabId));
}

// A frame that was rebuilt is a new document: it carries neither the content
// script nor a monitor, so nothing in it can report the player that appears
// there later. Reinstalling monitors is cheap, bounded and idempotent, unlike a
// full reactivation — but it still needs a floor so page churn cannot turn it
// into a storm.
// Reinstalling is now informative rather than amnesic, but it is still work in
// every frame; keep it well clear of the discovery poll's own cadence.
const MONITOR_REFRESH_INTERVAL_MS = 1200;
const lastMonitorRefreshByTab = new Map();
const pendingMonitorRefreshByTab = new Map();

async function refreshMediaFrameMonitors(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) return false;
    const last = lastMonitorRefreshByTab.get(normalizedTabId) || 0;
    const waited = Date.now() - last;
    if (waited < MONITOR_REFRESH_INTERVAL_MS) {
        // Run once more after the cooldown instead of dropping this call. A
        // rebuilt frame announces itself while its new document is still
        // loading, so the reinstall that matters is usually the one a
        // leading-edge-only debounce throws away.
        if (!pendingMonitorRefreshByTab.has(normalizedTabId)) {
            const timer = setTimeout(() => {
                pendingMonitorRefreshByTab.delete(normalizedTabId);
                refreshMediaFrameMonitors(normalizedTabId).catch(() => {});
            }, MONITOR_REFRESH_INTERVAL_MS - waited);
            pendingMonitorRefreshByTab.set(normalizedTabId, timer);
        }
        return false;
    }
    lastMonitorRefreshByTab.set(normalizedTabId, Date.now());
    await injectMediaFrameMonitors(normalizedTabId, currentContentTarget()).catch(() => {});
    return true;
}

/**
 * Bounded poll for a player that no monitor can announce.
 *
 * Discovery is event-driven, and events come from monitors — so a frame that was
 * rebuilt without one is invisible, and the video created there is never
 * reported. Nothing then triggers the upkeep that would install the monitor:
 * that is a deadlock, and it is what a real player does on a quality or part
 * change. This runs only while a tab is selected and no video has been found,
 * stops the moment one is, and costs a resolve that is fast precisely because
 * there is no video to rank.
 */
const MEDIA_DISCOVERY_POLL_MS = 2000;
const MEDIA_DISCOVERY_POLL_LIMIT = 20;
let mediaDiscoveryPollTimer = null;
let mediaDiscoveryPollTicks = 0;

function stopMediaDiscoveryPoll() {
    if (mediaDiscoveryPollTimer !== null) {
        clearTimeout(mediaDiscoveryPollTimer);
        mediaDiscoveryPollTimer = null;
    }
    mediaDiscoveryPollTicks = 0;
}

function startMediaDiscoveryPoll(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) return;
    stopMediaDiscoveryPoll();
    const tick = async () => {
        mediaDiscoveryPollTimer = null;
        if (normalizeTabId(currentTabId) !== normalizedTabId) return;
        if (currentTargetHasVideo === true) return;
        if (++mediaDiscoveryPollTicks > MEDIA_DISCOVERY_POLL_LIMIT) return;
        await refreshCurrentMediaTarget(normalizedTabId, { onlyIfTargetMoved: true })
            .catch(() => {});
        if (normalizeTabId(currentTabId) !== normalizedTabId) return;
        if (currentTargetHasVideo === true) return;
        mediaDiscoveryPollTimer = setTimeout(tick, MEDIA_DISCOVERY_POLL_MS);
    };
    mediaDiscoveryPollTimer = setTimeout(tick, MEDIA_DISCOVERY_POLL_MS);
}

let mediaTargetRefreshTask = null;
let mediaTargetRefreshTabId = null;
let mediaTargetRefreshDirty = false;
let mediaTargetRefreshFollowupTimer = null;
let contentCommandQueue = Promise.resolve();
let logs = [];
let history = []; // New: for Action History
let storageInitialized = false;
let pendingLogs = [];
let pendingHistory = [];
let eventQueue = [];
let eventQueueVersion = 0;
let flushTimer = null; // paces draining of eventQueue after (re)connect
let flushInProgress = null;
let isNamespaceJoined = false;
let awaitingRoomData = false;
let pendingRoomDataRoomId = null;
let lastActionState = { action: null, senderId: null, timestamp: 0, acks: [] };
let localSeq = 0;                         // Monotonically increasing command sequence for this peer
const lastSeqBySender = {};               // senderId → last received seq (stale command guard)
const canonicalMediaStateTracker = createCanonicalMediaStateTracker();
const CANONICAL_RECOVERY_RETRY_DELAYS = Object.freeze([250, 750, 1500, 3000]);
const CANONICAL_RECOVERY_RETRYABLE = new Set([
    'no_video',
    'apply_failed',
    'no_response',
    'pending_unreachable',
    'stale_target',
    'superseded'
]);
let canonicalRecoveryRetryTimer = null;
let canonicalRecoveryRetryAttempt = 0;
let canonicalRecoveryApplyInProgress = null;

// --- Host Control Mode ---
let controlMode = CONTROL_MODES.EVERYONE;  // 'everyone' | 'host-only'
let hostPeerId = null;                     // peerId of the room host (creator / fallback)
// Features the connected relay advertises in ROOM_DATA. Empty against an older
// relay (no capabilities field) → host-control UI/behavior stays unavailable.
let serverCapabilities = [];
let chatSecretGuard = '';
let chatSessionGeneration = 0;
let chatReceiveQueue = Promise.resolve();
const chatSendLimiter = createChatSendLimiter();
const chatEchoTracker = createChatEchoTracker();
const chatActivityStore = createChatActivityStore();
const webJoinCoordinator = createLatestTaskQueue();
function serverSupports(cap) { return Array.isArray(serverCapabilities) && serverCapabilities.includes(cap); }
function serverSupportsChat() {
    return serverSupports(CAPABILITIES.CHAT_V1) || serverSupports(CAPABILITIES.CHAT);
}
const CLIENT_CAPABILITIES = Object.freeze([
    CAPABILITIES.CHAT_V1,
    CAPABILITIES.MEDIA_STATE_V1,
    CAPABILITIES.EPISODE_SYNC_V2
]);

function persistCanonicalMediaRecovery() {
    if (!storageInitialized) return;
    chrome.storage.session.set({
        canonicalMediaRecovery: canonicalMediaStateTracker.snapshot()
    }).catch(() => {});
}

function resetCanonicalMediaRecoveryRetries() {
    if (canonicalRecoveryRetryTimer) {
        clearTimeout(canonicalRecoveryRetryTimer);
        canonicalRecoveryRetryTimer = null;
    }
    canonicalRecoveryRetryAttempt = 0;
}

function scheduleCanonicalMediaRecoveryRetry(reason) {
    const roomId = currentRoom?.roomId;
    const pending = canonicalMediaStateTracker.getPending(roomId);
    if (!pending
        || canonicalRecoveryRetryTimer
        || canonicalRecoveryApplyInProgress
        || canonicalRecoveryRetryAttempt >= CANONICAL_RECOVERY_RETRY_DELAYS.length) {
        return false;
    }
    const expectedRevision = pending.mediaState.revision;
    const delay = CANONICAL_RECOVERY_RETRY_DELAYS[canonicalRecoveryRetryAttempt++];
    canonicalRecoveryRetryTimer = setTimeout(() => {
        canonicalRecoveryRetryTimer = null;
        const latest = canonicalMediaStateTracker.getPending(roomId);
        if (currentRoom?.roomId !== roomId || latest?.mediaState.revision !== expectedRevision) return;
        addLog(`Retrying canonical media state r${expectedRevision} after ${reason}`, 'info');
        tryApplyPendingCanonicalMediaState().catch(error => {
            addLog(`Canonical media state retry failed: ${error.message}`, 'warn');
        });
    }, delay);
    return true;
}

function requestCanonicalMediaRecoveryAttempt() {
    if (canonicalRecoveryRetryTimer
        || canonicalRecoveryApplyInProgress
        || canonicalRecoveryRetryAttempt >= CANONICAL_RECOVERY_RETRY_DELAYS.length
        || !canonicalMediaStateTracker.getPending(currentRoom?.roomId)) {
        return false;
    }
    tryApplyPendingCanonicalMediaState().catch(error => {
        addLog(`Canonical media state retry failed: ${error.message}`, 'warn');
    });
    return true;
}

function clearCanonicalMediaRecovery() {
    resetCanonicalMediaRecoveryRetries();
    // The content command itself may still finish, but it belongs to the room
    // being cleared and must not block the first recovery attempt of a new room.
    canonicalRecoveryApplyInProgress = null;
    canonicalMediaStateTracker.clear();
    persistCanonicalMediaRecovery();
}

function invalidateChatSession() {
    chatSessionGeneration++;
    chatReceiveQueue = Promise.resolve();
    chatSendLimiter.reset();
    chatEchoTracker.reset();
    clearChatKeyCache();
}

function clearChatActivity() {
    chatActivityStore.clear();
    if (storageInitialized) chrome.storage.session.set({ chatActivityTimeline: [] }).catch(() => {});
}

async function clearFailedJoinCredentials() {
    webJoinCoordinator.invalidate();
    connectIntent = false;
    clearEventQueue();
    clearCanonicalMediaRecovery();
    chatSecretGuard = '';
    invalidateChatSession();
    await chrome.storage.local.set({ roomId: '', password: '', chatKey: '' }).catch(() => {});
}
// Local peer's desync state (content.js reports it via HCM_DESYNC_STATE). Relayed
// in heartbeats so the host's popup UI can show "Solo" instead of silently
// appearing un-ACK'd.
let hcmDesynced = false;
// Co-Host: peerIds allowed to drive in host-only (always includes the owner).
let controllers = [];
function amHost() { return !!peerId && hostPeerId === peerId; }            // owner: can toggle mode / promote
function amController() { return amHost() || (!!peerId && controllers.includes(peerId)); } // can drive the room
// Room-moving actions a guest may not initiate while in host-only mode.
const HOST_ONLY_GATED_ACTIONS = [
    EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK,
    EVENTS.FORCE_SYNC_PREPARE, EVENTS.FORCE_SYNC_EXECUTE,
    EVENTS.EPISODE_LOBBY, EVENTS.EPISODE_LOBBY_CANCEL
];
// Best-effort estimate of where the room (host) is right now, for guest snap-back.
// Extrapolates from the host peer's last known state. Used by content.js.
function getHostSyncTarget() {
    if (!currentRoom || !Array.isArray(currentRoom.peers)) return null;
    const host = currentRoom.peers.find(p => (typeof p === 'object' ? p.peerId : p) === hostPeerId);
    if (!host || typeof host !== 'object') return null;
    let targetTime = typeof host.currentTime === 'number' ? host.currentTime : null;
    if (targetTime !== null && host.playbackState === 'playing' && host.lastHeartbeat) {
        // M-4: clamp extrapolation. lastHeartbeat is the *arrival* time of the host's
        // last heartbeat — beyond ~2 heartbeat intervals the host's true state is too
        // stale (they may have paused without the next heartbeat landing yet) and the
        // linear extrapolation would overshoot by tens of seconds. Cap it so the
        // guest snaps to a position within plausibility; the next heartbeat corrects.
        const elapsedSec = (Date.now() - host.lastHeartbeat) / 1000;
        if (elapsedSec > 0 && elapsedSec <= 2 * HEARTBEAT_INTERVAL / 1000) {
            targetTime += elapsedSec;
        }
    }
    return { playbackState: host.playbackState || null, targetTime };
}
const activePorts = new Set();            // New: track active content ports for keep-alive
let expectedAcksCount = 0;                // Snapshot of peerCount when initiating Force Sync

// --- Ping / Latency ---
let pingInterval = null;
let pingTimeout = null;
let pendingPingT = null;
let currentPingMs = null;
let missedPongs = 0;

// --- Keep-Alive Port Listener ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepAlive') {
        activePorts.add(port);
        port.onDisconnect.addListener(() => {
            activePorts.delete(port);
        });
    }
});

let _persistLastSeqTimer = null;
function _persistLastSeq() {
    if (!storageInitialized) return;
    if (_persistLastSeqTimer) clearTimeout(_persistLastSeqTimer);
    _persistLastSeqTimer = setTimeout(() => {
        _persistLastSeqTimer = null;
        chrome.storage.session.set({ lastSeqBySender });
    }, 500);
}

// --- Boot Sequence Lock ---
let restorationTask = null;

function ensureState() {
    if (!restorationTask) {
        restorationTask = new Promise(resolve => {
            let resolved = false;
            let restorationTimedOut = false;
            const done = () => { if (!resolved) { resolved = true; resolve(); } };

            const storageTimeout = setTimeout(() => {
                restorationTimedOut = true;
                addLog('Storage restoration timed out, continuing with defaults', 'warn');
                storageInitialized = true;
                done();
            }, 10000);

            chrome.storage.session.get([
                'logs', 'history', 'currentRoom', 'lastActionState', 
                'eventQueue', 'isForceSyncInitiator', 'forceSyncAcks', 
                'forceSyncDeadline', 'reconnectFailed', 'reconnectStartTime', 'reconnectAttempts', 'currentTabId', 'currentTabTitle',
                'currentTargetFrameId', 'currentTargetDocumentId', 'currentTargetHasVideo',
                'selectedTabId', 'selectedTabTitle', 'selectionErrorTabId', 'selectionErrorMessage',
                'episodeLobby', 'episodeSyncV2', 'localSeq', 'lastSeqBySender', 'expectedAcksCount', 'roomIdleSince', 'lastContentHeartbeatAt',
                'hcmDesynced', 'chatActivityTimeline', 'canonicalMediaRecovery'
            ], (data) => {
                // A late callback must not resurrect a room, queue or canonical
                // snapshot after the worker already continued with defaults.
                if (restorationTimedOut) return;
                clearTimeout(storageTimeout);
                if (Number.isSafeInteger(data.expectedAcksCount) && data.expectedAcksCount >= 0) {
                    expectedAcksCount = data.expectedAcksCount;
                }
                if (data.currentTabId !== undefined) currentTabId = normalizeTabId(data.currentTabId);
                userSelectedTabId = normalizeTabId(data.selectedTabId);
                userSelectedTabTitle = userSelectedTabId !== null && typeof data.selectedTabTitle === 'string'
                    ? data.selectedTabTitle
                    : null;
                userSelectionErrorTabId = normalizeTabId(data.selectionErrorTabId);
                userSelectionErrorMessage = userSelectionErrorTabId !== null
                    && typeof data.selectionErrorMessage === 'string'
                    ? data.selectionErrorMessage
                    : null;
                currentTargetFrameId = currentTabId !== null
                    && Number.isInteger(data.currentTargetFrameId)
                    && data.currentTargetFrameId >= 0
                    ? data.currentTargetFrameId
                    : 0;
                currentTargetDocumentId = currentTabId !== null
                    && typeof data.currentTargetDocumentId === 'string'
                    && data.currentTargetDocumentId
                    ? data.currentTargetDocumentId
                    : null;
                currentTargetHasVideo = currentTabId !== null && data.currentTargetHasVideo === true;
                if (data.currentTabTitle !== undefined) {
                    currentTabTitle = currentTabId !== null && typeof data.currentTabTitle === 'string'
                        ? data.currentTabTitle
                        : null;
                }
                // Merge data from storage with any early-arriving state
                // New entries (added during boot) must stay at the top (index 0)
                if (Array.isArray(data.logs)) logs = [...logs, ...data.logs].slice(0, 200);
                if (Array.isArray(data.history)) history = [...history, ...data.history].slice(0, 20);
                if (data.currentRoom
                    && typeof data.currentRoom === 'object'
                    && typeof data.currentRoom.roomId === 'string'
                    && data.currentRoom.roomId) {
                    currentRoom = { ...data.currentRoom };
                    currentRoom.peers = (Array.isArray(data.currentRoom.peers) ? data.currentRoom.peers : [])
                        .map(createPeerData)
                        .filter(candidate => candidate.peerId);
                    const restoredPeerIds = new Set(currentRoom.peers.map(candidate => candidate.peerId));
                    currentRoom.activeLobby = normalizeEpisodeLobby(
                        data.currentRoom.activeLobby,
                        Date.now(),
                        restoredPeerIds
                    );
                    // Host Control Mode: restore role/mode/capabilities from persisted room.
                    controlMode = currentRoom.controlMode || CONTROL_MODES.EVERYONE;
                    hostPeerId = currentRoom.hostPeerId || null;
                    controllers = Array.isArray(currentRoom.controllers) ? currentRoom.controllers : [];
                    serverCapabilities = Array.isArray(currentRoom.capabilities) ? currentRoom.capabilities : [];
                    chatActivityStore.restore(data.chatActivityTimeline);
                }
                if (data.hcmDesynced !== undefined) hcmDesynced = data.hcmDesynced;
                // L-2: enforce the desync invariant on restore — a persisted hcmDesynced=true
                // is stale if our restored role is no longer "gated guest" (e.g. we became
                // the host, or the room is in 'everyone'). Without this, the first heartbeat
                // after SW restart would broadcast a bogus Solo flag for up to 15s.
                hcmEnforceDesyncInvariant();
                canonicalMediaStateTracker.restore(
                    data.canonicalMediaRecovery,
                    currentRoom?.roomId || null
                );
                if (data.lastActionState && typeof data.lastActionState === 'object') {
                    lastActionState = data.lastActionState;
                }
                
                if (currentRoom && data.isForceSyncInitiator === true && isForceSyncInitiator === false) {
                    isForceSyncInitiator = true;
                }
                if (currentRoom && isForceSyncInitiator && Array.isArray(data.forceSyncAcks)) {
                    const mergedAcks = new Set([...forceSyncAcks, ...data.forceSyncAcks]);
                    forceSyncAcks = mergedAcks;
                }
                if (data.reconnectFailed !== undefined) reconnectFailed = data.reconnectFailed;
                if (data.reconnectStartTime) reconnectStartTime = data.reconnectStartTime;
                if (data.reconnectAttempts !== undefined) reconnectAttempts = data.reconnectAttempts;
                if (data.roomIdleSince !== undefined) roomIdleSince = data.roomIdleSince;
                if (data.lastContentHeartbeatAt !== undefined) lastContentHeartbeatAt = data.lastContentHeartbeatAt;

                // Recover Force Sync Timeout
                if (currentRoom && Number.isFinite(data.forceSyncDeadline)) {
                    const remaining = data.forceSyncDeadline - Date.now();
                    if (remaining > 0 && isForceSyncInitiator) {
                        forceSyncTimeout = setTimeout(() => {
                            if (isForceSyncInitiator) {
                                addLog('Force Sync: Recovered timeout triggered, executing...', 'warn');
                                executeForceSync();
                            }
                        }, remaining);
                    } else if (remaining <= 0 && isForceSyncInitiator) {
                        executeForceSync();
                    }
                }

                // Recover Episode Lobby
                const restoredEpisodeLobby = currentRoom
                    ? normalizeEpisodeLobby(
                        data.episodeLobby,
                        Date.now(),
                        new Set(currentRoom.peers.map(candidate => candidate.peerId))
                    )
                    : null;
                if (restoredEpisodeLobby && !episodeLobby) {
                    episodeLobby = restoredEpisodeLobby;
                    const lobbyRemaining = (episodeLobby.createdAt + EPISODE_LOBBY_TIMEOUT) - Date.now();
                    if (lobbyRemaining > 0) {
                        episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout'), lobbyRemaining);
                    } else {
                        cancelEpisodeLobby('Timeout (recovered)');
                    }
                }

                const restoredEpisodeSyncV2 = currentRoom
                    ? normalizeEpisodeSyncV2(
                        data.episodeSyncV2 || currentRoom.episodeSyncV2,
                        new Set(currentRoom.peers.map(candidate => candidate.peerId))
                    )
                    : null;
                if (restoredEpisodeSyncV2) {
                    episodeSyncV2 = restoredEpisodeSyncV2;
                    if (episodeLobbyTimeout) clearTimeout(episodeLobbyTimeout);
                    episodeLobbyTimeout = null;
                    episodeLobby = null;
                    currentRoom.activeLobby = null;
                }

                if (Number.isSafeInteger(data.localSeq) && data.localSeq >= 0) localSeq = data.localSeq;
                eventQueue = normalizePersistedEventQueue(
                    [...eventQueue, ...(Array.isArray(data.eventQueue) ? data.eventQueue : [])],
                    currentRoom?.roomId || null
                );
                eventQueueVersion++;
                // An MV3 restart can restore queue and sequence writes in either
                // order. Never let the sender sequence fall behind persisted work.
                localSeq = Math.max(localSeq, maxQueuedSequence(eventQueue));
                if (data.lastSeqBySender && typeof data.lastSeqBySender === 'object') Object.assign(lastSeqBySender, data.lastSeqBySender);

                storageInitialized = true;
                chrome.storage.session.set({ eventQueue, localSeq }).catch(() => {});
                
                // Process any early logs/history that weren't captured in the spread
                if (pendingLogs.length > 0) {
                    logs = [...pendingLogs, ...logs].slice(0, 200);
                    chrome.storage.session.set({ logs });
                    pendingLogs = [];
                }
                if (pendingHistory.length > 0) {
                    history = [...pendingHistory, ...history].slice(0, 20);
                    chrome.storage.session.set({ history });
                    pendingHistory = [];
                }

                done();
            });
        });
    }
    return restorationTask;
}

// Start restoration immediately
ensureState();

let reconnectTimer = null;
let reconnectStartTime = null;
let reconnectFailed = false;
let reconnectAttempts = 0;
let currentServerUrl = null;
let roomIdleSince = null;
let lastContentHeartbeatAt = null;
let connectIntent = false;
let roomTeardownPromise = null;
const MAX_RECONNECT_ATTEMPTS = 20;
// Backoff tuned so that at most ~8 connection attempts land in any 60s window,
// keeping a single client comfortably under the server's per-IP connection
// budget (10/min) even before jitter. Cumulative (no jitter): 1, 2.8, 6, 11.9,
// 22.4, 34.4, 46.4, 58.4s → 8th attempt at ~58s.
const _RECONNECT_BASE_DELAY = 1000;
const _RECONNECT_MAX_DELAY = 12000;
const _RECONNECT_FACTOR = 1.8;
const _RECONNECT_GIVEUP_MS = 300000;  // switch to slow mode after 5 min of fast retries
const _RECONNECT_SLOW_DELAY = 300000; // slow-mode interval: every 5 min
const _RECONNECT_JITTER = 0.2;        // ±20% randomization to de-synchronize reconnect herds
// Paced queue flush: after a (re)connect we drain the offline event backlog in
// small batches instead of one synchronous burst, so we stay well under the
// server's per-socket event budget (50 / 10s) and leave headroom for the
// heartbeats/pings/commands that also count toward it. 10 per 3s ≈ 33/10s.
const FLUSH_BATCH_SIZE = 10;
const FLUSH_BATCH_INTERVAL_MS = 3000;
// Ping liveness: a single unanswered ping is tolerated (transient network
// blip); only MAX_MISSED_PONGS consecutive misses force a reconnect. With a
// 15s interval and 5s timeout that means ~20s to detect a genuinely dead link.
const PING_INTERVAL_MS = 15000;
const PING_TIMEOUT_MS = 5000;
const MAX_MISSED_PONGS = 2;
const ROOM_IDLE_AUTO_LEAVE_MS = 2 * 60 * 60 * 1000;

// Force Sync Coordination
let isForceSyncInitiator = false;
let forceSyncAcks = new Set();
let forceSyncTimeout = null;

// Episode Auto-Sync Lobby
let episodeLobby = null; // { expectedTitle, initiatorPeerId, readyPeers: [], createdAt }
let episodeLobbyTimeout = null;
let episodeSyncV2 = null;

// --- Storage Utils ---

/**
 * Canonical peer data factory. All peer object construction must go through
 * here to guarantee a consistent shape with predictable null defaults.
 * @param {object} raw - Raw data from server event or heartbeat payload.
 * @returns {object} Normalized peer data object.
 */
function createPeerData(raw) {
    const source = raw && typeof raw === 'object'
        ? raw
        : (typeof raw === 'string' ? { peerId: raw } : {});
    return {
        peerId:        typeof source.peerId === 'string' && source.peerId ? source.peerId.substring(0, 16) : null,
        username:      typeof source.username === 'string' ? source.username.substring(0, 30) : null,
        tabTitle:      typeof source.tabTitle === 'string' ? source.tabTitle.substring(0, 100) : null,
        mediaTitle:    typeof source.mediaTitle === 'string' ? source.mediaTitle.substring(0, 100) : null,
        playbackState: source.playbackState === 'playing' || source.playbackState === 'paused' ? source.playbackState : null,
        currentTime:   Number.isFinite(source.currentTime) ? source.currentTime : null,
        volume:        Number.isFinite(source.volume) ? source.volume : null,
        muted:         typeof source.muted === 'boolean' ? source.muted : null,
        desynced:      source.desynced === true,   // HCM: peer is watching on their own
        lastHeartbeat: Date.now()
    };
}

function normalizeEpisodeLobby(value, fallbackCreatedAt = Date.now(), allowedPeerIds = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const expectedTitle = typeof value.expectedTitle === 'string'
        ? value.expectedTitle.substring(0, 100)
        : '';
    const initiatorPeerId = typeof value.initiatorPeerId === 'string'
        ? value.initiatorPeerId.substring(0, 16)
        : '';
    if (!expectedTitle
        || !initiatorPeerId
        || !Array.isArray(value.readyPeers)
        || (allowedPeerIds && !allowedPeerIds.has(initiatorPeerId))) return null;
    const readyPeers = [...new Set(value.readyPeers
        .filter(candidate => typeof candidate === 'string' && candidate)
        .map(candidate => candidate.substring(0, 16))
        .filter(candidate => !allowedPeerIds || allowedPeerIds.has(candidate)))];
    if (!readyPeers.includes(initiatorPeerId)) readyPeers.unshift(initiatorPeerId);
    return {
        expectedTitle,
        initiatorPeerId,
        readyPeers,
        createdAt: Number.isFinite(value.createdAt) && value.createdAt > 0
            ? value.createdAt
            : fallbackCreatedAt
    };
}

/**
 * Updates properties of a peer in the room and instantly broadcasts the changes to the popup UI.
 * Also tracks lastReactiveUpdate to guard against older heartbeats in transit overwriting state.
 */
function updateLocalPeerState(targetPeerId, updates) {
    if (!currentRoom || !Array.isArray(currentRoom.peers)) return;
    const peer = currentRoom.peers.find(p => typeof p === 'object' ? p.peerId === targetPeerId : p === targetPeerId);
    if (peer && typeof peer === 'object') {
        Object.keys(updates).forEach(key => {
            if (updates[key] !== undefined && updates[key] !== null) {
                peer[key] = updates[key];
            }
        });
        peer.lastReactiveUpdate = Date.now(); // Race condition guard lock
        if (updates.currentTime !== undefined && updates.currentTime !== null) {
            peer.lastHeartbeat = Date.now(); // reset time interpolation baseline
        }
        if (storageInitialized) chrome.storage.session.set({ currentRoom });
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
    }
}

async function getPeerId() {
    const data = await chrome.storage.local.get(['peerId']);
    if (data.peerId) return data.peerId;
    // 16 hex chars = 64 bits. At a busy relay (25k concurrent peers) the 32-bit
    // (8-hex) generation would hit ~7% collision probability per snapshot —
    // and a same-room collision triggers our dedup path, kicking the older
    // session with a confusing error. 16 hex chars drops the probability to
    // ~1e-10 even at a million peers, and the server already clamps peerId to
    // 16 chars (server/index.js JOIN_ROOM sanitizer). Existing persisted 8-char
    // IDs continue to work — this only affects newly-generated IDs.
    const newId = self.crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    await chrome.storage.local.set({ peerId: newId });
    return newId;
}

async function getSettings() {
    // Local-only by design. Room credentials (roomId/password) and identity
    // (username) must NEVER come from storage.sync — syncing them across devices
    // both leaks them and resurrects dead rooms on reinstall (a fresh install
    // has empty local storage but sync survives in the user's Google account).
    const data = await chrome.storage.local.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'chatKey', 'chatEnabled', 'chatNotifications', 'username', 'sendTabTitle', 'mediaTitlePrivacyMode', 'titlePrivacyMode']);
    let username = data.username;
    if (!username) {
        username = generateUsername();
        await chrome.storage.local.set({ username });
    }
    const legacyTitlePrivacyMode = normalizeTitlePrivacyMode(data.titlePrivacyMode);
    const mediaTitlePrivacyMode = normalizeTitlePrivacyMode(data.mediaTitlePrivacyMode || legacyTitlePrivacyMode);
    const chatKey = validateChatSecret(data.chatKey);
    chatSecretGuard = chatKey;
    const roomId = normalizeRoomId(data.roomId);
    if (data.roomId && data.roomId !== roomId) chrome.storage.local.set({ roomId }).catch(() => {});
    return {
        serverUrl: data.serverUrl || '',
        useCustomServer: data.useCustomServer || false,
        roomId,
        password: data.password || '',
        chatKey,
        chatEnabled: data.chatEnabled === true,
        chatNotifications: data.chatNotifications !== false,
        username,
        sendTabTitle: normalizeSendTabTitle(data.sendTabTitle, legacyTitlePrivacyMode),
        mediaTitlePrivacyMode
    };
}

function getSharedTitleFields(settings, mediaTitle = null) {
    return {
        tabTitle: sanitizeTabTitle(currentTabTitle, settings?.sendTabTitle),
        mediaTitle: sanitizeSharedTitle(mediaTitle, settings?.mediaTitlePrivacyMode)
    };
}

function withTitlePrivacy(payload, settings, keys) {
    return applyTitlePrivacyToPayload(payload, settings?.mediaTitlePrivacyMode, keys);
}

function emitEpisodeLobbyForCurrentPrivacy() {
    if (!episodeLobby || episodeLobby.initiatorPeerId !== peerId) return;
    const lobby = episodeLobby;
    const roomId = currentRoom?.roomId || null;
    getSettings().then(settings => {
        if (episodeLobby !== lobby
            || currentRoom?.roomId !== roomId
            || settings.roomId !== roomId) return;
        const expectedTitle = sanitizeSharedTitle(lobby.expectedTitle, settings.mediaTitlePrivacyMode);
        if (expectedTitle) {
            emit(EVENTS.EPISODE_LOBBY, { peerId, expectedTitle });
        }
    }).catch(err => {
        addLog('Episode lobby privacy error: ' + err.message, 'error');
    });
}

// Privacy + correctness: only onboardingComplete and dismissedHints belong in
// storage.sync. Everything else is per-device local storage. This actively
// removes legacy keys that older versions wrote to sync (and that would
// otherwise be redistributed across devices and resurrected on reinstall).
const LEGACY_SYNC_KEYS = [
    'serverUrl', 'useCustomServer', 'roomId', 'password', 'chatKey',
    'chatEnabled', 'chatNotifications', 'chatPosition', 'chatSize', 'chatStartMode', 'chatReactionDisplay', 'username',
    'filterNoise', 'customBlacklistDomains', 'blacklistOverrides', 'autoSyncNextEpisode', 'forceSyncMode',
    'browserNotifications', 'autoCopyInvite', 'locale', 'audioSettings',
    'titlePrivacyMode', 'sendTabTitle', 'mediaTitlePrivacyMode'
];
function purgeLegacySyncKeys() {
    chrome.storage.sync.remove(LEGACY_SYNC_KEYS).catch(() => {});
}

function addLog(message, type = 'info') {
    const log = {
        timestamp: new Date().toISOString(),
        message,
        type
    };
    if (!storageInitialized) {
        pendingLogs.unshift(log);
    } else {
        logs.unshift(log);
        if (logs.length > 200) logs.pop();
        chrome.storage.session.set({ logs });
    }
    chrome.runtime.sendMessage({ type: 'LOG_UPDATE', log }).catch(() => {});
}

// --- WebSocket Client ---
function resolveServerUrl(settings) {
    return (settings.serverUrl && settings.useCustomServer) ? settings.serverUrl : OFFICIAL_SERVER_URL;
}

function forceDisconnect({ preserveEventQueue = false } = {}) {
    connectionGeneration++;
    resetCanonicalMediaRecoveryRetries();
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (episodeLobbyTimeout) {
        clearTimeout(episodeLobbyTimeout);
        episodeLobbyTimeout = null;
    }
    episodeLobby = null;
    if (forceSyncTimeout) {
        clearTimeout(forceSyncTimeout);
        forceSyncTimeout = null;
    }
    stopPing();
    if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        socket = null;
    }
    currentServerUrl = null;
    isConnecting = false;
    isNamespaceJoined = false;
    awaitingRoomData = false;
    pendingRoomDataRoomId = null;
    invalidateChatSession();
    isForceSyncInitiator = false;
    expectedAcksCount = 0;
    roomIdleSince = null;
    lastContentHeartbeatAt = null;
    forceSyncAcks.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushInProgress = null;
    if (!preserveEventQueue) {
        eventQueue = [];
        eventQueueVersion++;
    }
    chrome.storage.session.set({
        isForceSyncInitiator: false,
        forceSyncAcks: [],
        forceSyncDeadline: null,
        expectedAcksCount: 0,
        eventQueue,
        episodeLobby: null,
        roomIdleSince: null,
        lastContentHeartbeatAt: null
    }).catch(() => {});
    if (currentRoom) {
        currentRoom.peers = [];
        if (storageInitialized) chrome.storage.session.set({ currentRoom });
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
    }
    broadcastConnectionStatus('disconnected');
}

function persistRoomIdleState() {
    chrome.storage.session.set({ roomIdleSince, lastContentHeartbeatAt }).catch(() => {});
}

function markRoomUseful() {
    roomIdleSince = null;
    lastContentHeartbeatAt = Date.now();
    persistRoomIdleState();
}

function markRoomPotentiallyIdle() {
    if (!currentRoom) {
        roomIdleSince = null;
        lastContentHeartbeatAt = null;
        persistRoomIdleState();
        return;
    }
    if (!roomIdleSince) {
        roomIdleSince = Date.now();
        persistRoomIdleState();
    }
}

function invalidateTargetActivations() {
    targetActivationGeneration++;
    activeTargetActivation = null;
    mediaTargetRefreshDirty = false;
    if (mediaTargetRefreshFollowupTimer !== null) {
        clearTimeout(mediaTargetRefreshFollowupTimer);
        mediaTargetRefreshFollowupTimer = null;
    }
    return targetActivationGeneration;
}

function isCurrentTargetIdentity(tabId, generation) {
    return normalizeTabId(currentTabId) === normalizeTabId(tabId)
        && targetActivationGeneration === generation;
}

function normalizeFrameId(value) {
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function currentContentTarget() {
    return {
        frameId: normalizeFrameId(currentTargetFrameId),
        documentId: typeof currentTargetDocumentId === 'string' && currentTargetDocumentId
            ? currentTargetDocumentId
            : null,
        hasVideo: currentTargetHasVideo
    };
}

function targetMessageOptions(frameId, documentId = null) {
    return typeof documentId === 'string' && documentId
        ? { documentId }
        : { frameId: normalizeFrameId(frameId) };
}

function sendMessageToFrame(tabId, frameId, message, callback = null, documentId = null) {
    const options = targetMessageOptions(frameId, documentId);
    if (typeof callback === 'function') {
        return chrome.tabs.sendMessage(tabId, message, options, callback);
    }
    return chrome.tabs.sendMessage(tabId, message, options);
}

function sendMessageToCurrentContent(message, callback = null) {
    const tabId = normalizeTabId(currentTabId);
    if (tabId === null) {
        return typeof callback === 'function' ? undefined : Promise.reject(new Error('No target tab selected'));
    }
    return sendMessageToFrame(
        tabId,
        currentTargetFrameId,
        message,
        callback,
        currentTargetDocumentId
    );
}

/**
 * Chat is page UI, not player UI. The controlled video can live in a nested
 * cross-origin frame (Drive, YummyAnime), but the overlay always belongs to the
 * tab's top document: inside the player frame it renders on top of the video,
 * and closing or minimizing it only affects that frame.
 */
function sendMessageToChatOverlay(message) {
    const tabId = normalizeTabId(currentTabId);
    if (tabId === null) return Promise.reject(new Error('No target tab selected'));
    return sendMessageToFrame(tabId, 0, message);
}

/**
 * Delivers a command to every frame in the tab instead of the elected one.
 *
 * Frame election is an intervention: executeScript has to enter each frame, it
 * is all-or-nothing, and a player that renavigates or rebuilds its video — Kodik
 * does both constantly — reliably lands in the window where that fails. The
 * election then names the top frame, which holds no video, and playback commands
 * go nowhere. webNavigation.getAllFrames() had no such window because it only
 * observed; without it, the robust move is to stop needing the answer.
 *
 * Every content-script command handler already begins with findVideo() and
 * returns when there is none, so exactly the frame that owns the video acts.
 */
function broadcastCommandToTab(tabId, message) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) {
        return Promise.reject(new Error('Invalid tab ID'));
    }
    return chrome.tabs.sendMessage(normalizedTabId, message);
}

function sendMessageToContentTab(tabId, message, callback = null) {
    if (normalizeTabId(tabId) === normalizeTabId(currentTabId)) {
        return sendMessageToCurrentContent(message, callback);
    }
    if (typeof callback === 'function') {
        return chrome.tabs.sendMessage(tabId, message, callback);
    }
    return chrome.tabs.sendMessage(tabId, message);
}

function isCurrentContentSender(sender) {
    if (!sender?.tab) return false;
    const senderTabId = normalizeTabId(sender.tab.id);
    const senderFrameId = normalizeFrameId(sender.frameId);
    const matchesActivation = senderTabId === normalizeTabId(activeTargetActivation?.tabId)
        && senderFrameId === normalizeFrameId(activeTargetActivation?.frameId)
        && (!activeTargetActivation?.documentId
            || sender.documentId === activeTargetActivation.documentId);
    if (Number.isInteger(activeTargetActivation?.frameId)) return matchesActivation;
    if (senderTabId !== normalizeTabId(currentTabId)) return false;
    const matchesElectedFrame = senderFrameId === normalizeFrameId(currentTargetFrameId)
        && (!currentTargetDocumentId || sender.documentId === currentTargetDocumentId);
    if (matchesElectedFrame) return true;
    // Any frame in the selected target tab reporting playback activity
    // is a valid content sender (e.g. user interacted with or switched to another mirror).
    return true;
}

/**
 * Adopts the frame an accepted media event came from.
 *
 * This is the self-healing counterpart to the check above: once the real player
 * frame identifies itself, later commands can be addressed to it directly
 * instead of broadcast.
 */
function adoptReportingFrame(sender) {
    if (!sender?.tab) return false;
    const senderTabId = normalizeTabId(sender.tab.id);
    if (senderTabId === null || senderTabId !== normalizeTabId(currentTabId)) return false;
    const senderFrameId = normalizeFrameId(sender.frameId);
    if (senderFrameId === normalizeFrameId(currentTargetFrameId)
        && (!currentTargetDocumentId || sender.documentId === currentTargetDocumentId)) {
        if (currentTargetHasVideo === true) return false;
        currentTargetHasVideo = true;
        stopMediaDiscoveryPoll();
        chrome.storage.session.set({ currentTargetHasVideo }).catch(() => {});
        requestCanonicalMediaRecoveryAttempt();
        return true;
    }

    currentTargetFrameId = senderFrameId;
    currentTargetDocumentId = typeof sender.documentId === 'string' ? sender.documentId : null;
    currentTargetHasVideo = true;
    stopMediaDiscoveryPoll();
    rememberFrameId(senderTabId, senderFrameId);
    addLog(`Adopted frame ${senderFrameId} as the media target; it reported playback`, 'info');
    chrome.storage.session.set({
        currentTargetFrameId,
        currentTargetDocumentId,
        currentTargetHasVideo
    }).catch(() => {});
    requestCanonicalMediaRecoveryAttempt();
    return true;
}

function isExtensionPageSender(sender) {
    const extensionRoot = chrome.runtime.getURL('');
    return typeof sender?.url === 'string' && sender.url.startsWith(extensionRoot);
}

function sameContentTarget(left, right) {
    return normalizeFrameId(left?.frameId) === normalizeFrameId(right?.frameId)
        && (!left?.documentId || !right?.documentId || left.documentId === right.documentId);
}

function clearCurrentContentTarget() {
    stopMediaDiscoveryPoll();
    currentTargetFrameId = 0;
    currentTargetDocumentId = null;
    currentTargetHasVideo = false;
}

/** The elected frame is gone, as opposed to merely holding no video. */
function isContentUnreachableError(error) {
    const message = String(typeof error === 'string' ? error : (error?.message || ''));
    return message.includes('Receiving end does not exist')
        || message.includes('Extension context invalidated')
        || message.includes('No document with id')
        || message.includes('No document with ID');
}

/**
 * Gives up the frame election — never the tab selection — when the frame it
 * names no longer exists.
 *
 * A player that rebuilds its frame (Kodik does this on quality and part
 * changes) invalidates the documentId the election is pinned to. Without this,
 * the pointer stayed dead forever: the guarded refresh reports "unchanged"
 * because no video is reachable, and adoption had already set hasVideo, so
 * nothing would move the target back. Clearing hasVideo re-opens both the
 * ordinary promotion path and adoption.
 */
function releaseUnreachableFrameTarget(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null || normalizedTabId !== normalizeTabId(currentTabId)) return false;
    if (normalizeFrameId(currentTargetFrameId) === 0
        && currentTargetDocumentId === null
        && currentTargetHasVideo !== true) {
        return false;
    }
    addLog(`Media frame ${currentTargetFrameId} is unreachable; releasing the frame election`, 'warn');
    clearCurrentContentTarget();
    startMediaDiscoveryPoll(normalizedTabId);
    chrome.storage.session.set({
        currentTargetFrameId: 0,
        currentTargetDocumentId: null,
        currentTargetHasVideo: false
    }).catch(() => {});
    return true;
}

async function clearTargetSelectionForLifecycle({
    expectedTabId = null,
    expectedGeneration = null,
    markRoomIdle = false
} = {}) {
    if (expectedTabId !== null && normalizeTabId(currentTabId) !== normalizeTabId(expectedTabId)) {
        return false;
    }
    if (expectedGeneration !== null && targetActivationGeneration !== expectedGeneration) {
        return false;
    }

    const previousTabId = normalizeTabId(currentTabId);
    const previousContentTarget = currentContentTarget();
    const clearedTabId = normalizeTabId(userSelectedTabId) ?? previousTabId;

    completeForceSyncBeforeTargetChange(null);
    invalidateTargetActivations();
    currentTabId = null;
    currentTabTitle = null;
    clearCurrentContentTarget();
    lastContentHeartbeatAt = null;
    if (markRoomIdle && currentRoom) {
        roomIdleSince = Date.now();
    }

    resetUserSelectionState();
    // Persist the terminal selection state before any frame messaging or host
    // permission cleanup can yield. A worker stop or a concurrent new target
    // must never resurrect the selection this lifecycle transition removed.
    await chrome.storage.session.set({
        currentTabId,
        currentTabTitle,
        currentTargetFrameId,
        currentTargetDocumentId,
        currentTargetHasVideo,
        roomIdleSince,
        lastContentHeartbeatAt,
        selectedTabId: null,
        selectedTabTitle: null,
        selectionErrorTabId: null,
        selectionErrorMessage: null
    });

    const cleanupTasks = [clearPendingTarget()];
    if (previousTabId !== null) {
        cleanupTasks.push(deactivateTargetTab(previousTabId, previousContentTarget));
    }
    await Promise.all(cleanupTasks);
    updateBadgeStatus();
    chrome.runtime.sendMessage({ type: 'TARGET_TAB_CLEARED', tabId: clearedTabId }).catch(() => {});
    return true;
}

function normalizeEpisodeSyncV2(value, allowedPeerIds = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const transactionId = typeof value.transactionId === 'string'
        ? value.transactionId.substring(0, 64)
        : '';
    const phase = value.phase === 'lobby' || value.phase === 'prepare' ? value.phase : '';
    const expectedTitle = typeof value.expectedTitle === 'string'
        ? value.expectedTitle.substring(0, 100)
        : '';
    const initiatorPeerId = typeof value.initiatorPeerId === 'string'
        ? value.initiatorPeerId.substring(0, 16)
        : '';
    if (!transactionId || !phase || !expectedTitle || !initiatorPeerId
        || !Array.isArray(value.participants)
        || !Array.isArray(value.loadedPeers)
        || !Array.isArray(value.preparedPeers)) return null;
    const normalizePeers = peers => [...new Set(peers
        .filter(candidate => typeof candidate === 'string' && candidate)
        .map(candidate => candidate.substring(0, 16)))];
    const participants = normalizePeers(value.participants);
    const participantSet = new Set(participants);
    const loadedPeers = normalizePeers(value.loadedPeers).filter(candidate => participantSet.has(candidate));
    const preparedPeers = normalizePeers(value.preparedPeers).filter(candidate => participantSet.has(candidate));
    if (participants.length < 2
        || !participantSet.has(initiatorPeerId)
        || (allowedPeerIds && participants.some(candidate => !allowedPeerIds.has(candidate)))) return null;
    return {
        transactionId,
        phase,
        expectedTitle,
        initiatorPeerId,
        participants,
        loadedPeers,
        preparedPeers,
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
        deadlineAt: Number.isFinite(value.deadlineAt) ? value.deadlineAt : null,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1
    };
}

function clearTargetTabForIdle(expectedTabId = null, expectedGeneration = null) {
    return clearTargetSelectionForLifecycle({
        expectedTabId,
        expectedGeneration,
        markRoomIdle: true
    });
}

async function performRoomSessionTeardown({ notifyServer = false, reason = 'Left Room' } = {}) {
    webJoinCoordinator.invalidate();
    connectIntent = false;
    reconnectFailed = false;
    reconnectAttempts = 0;
    reconnectStartTime = null;
    completeForceSyncBeforeTargetChange(null);
    if (notifyServer) emit(EVENTS.LEAVE_ROOM, { peerId });

    // Stop room-specific polling before the content script itself is removed.
    // Every terminal room exit must pass through the exact target identity while
    // it is still available, regardless of who initiated the exit.
    if (notifyServer) cancelEpisodeSyncV2('room_exit');
    else clearEpisodeSyncV2State({ reason: 'room_exit' });
    clearEpisodeLobbyState();
    currentRoom = null;
    clearCanonicalMediaRecovery();
    clearChatActivity();
    controlMode = CONTROL_MODES.EVERYONE;
    hostPeerId = null;
    controllers = [];
    serverCapabilities = [];
    hcmDesynced = false;
    // Notify content.js/popup BEFORE currentTabId is cleared so they can reset
    // any stale guest-side HCM state (dialog/badge/desync) — H-2.
    broadcastControlMode();
    roomIdleSince = null;
    await clearTargetSelectionForLifecycle();

    isForceSyncInitiator = false;
    forceSyncAcks.clear();
    expectedAcksCount = 0;
    if (forceSyncTimeout) {
        clearTimeout(forceSyncTimeout);
        forceSyncTimeout = null;
    }
    await chrome.storage.session.set({
        currentRoom: null,
        chatActivityTimeline: [],
        currentTabId: null,
        currentTabTitle: null,
        currentTargetFrameId: 0,
        currentTargetDocumentId: null,
        currentTargetHasVideo: false,
        roomIdleSince: null,
        lastContentHeartbeatAt: null,
        isForceSyncInitiator: false,
        forceSyncAcks: [],
        forceSyncDeadline: null,
        expectedAcksCount: 0,
        episodeLobby: null,
        episodeSyncV2: null,
        hcmDesynced: false,
        reconnectFailed: false,
        reconnectAttempts: 0,
        reconnectStartTime: null
    }).catch(() => {});
    chatSecretGuard = '';
    invalidateChatSession();
    await chrome.storage.local.set({ roomId: '', password: '', chatKey: '' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
    forceDisconnect();
    addLog(reason, 'info');
    updateBadgeStatus();
}

async function endRoomSession(options = {}) {
    if (roomTeardownPromise) return roomTeardownPromise;

    const teardown = performRoomSessionTeardown(options);
    roomTeardownPromise = teardown;
    try {
        return await teardown;
    } finally {
        if (roomTeardownPromise === teardown) roomTeardownPromise = null;
    }
}

async function waitForRoomTeardown() {
    if (roomTeardownPromise) await roomTeardownPromise;
}

async function leaveRoomAfterIdleGrace(reason) {
    if (!currentRoom) return;
    await endRoomSession({ notifyServer: true, reason });
}

async function connect() {
    if (isConnecting) return;
    isConnecting = true;
    const startingGeneration = connectionGeneration;
    let attemptGeneration = startingGeneration;
    let handedOffToSocket = false;

    let finalUrl = '';
    try {
        // --- Phase 1: Storage ---
        let settings;
        try {
            if (!peerId) peerId = await getPeerId();
            settings = await getSettings();
            if (startingGeneration !== connectionGeneration) return;
            pendingRoomDataRoomId = settings.roomId || currentRoom?.roomId || null;
        } catch (e) {
            throw new Error(`[Storage Error] ${e.message}`);
        }

        // --- Phase 2: Connection Guard ---
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            if (isNamespaceJoined) {
                isConnecting = false;
                return;
            }
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.close();
        }

        if (!navigator.onLine) {
            addLog('Browser is offline. Waiting...', 'warn');
            broadcastConnectionStatus('offline');
            isConnecting = false;
            if (currentRoom || connectIntent) {
                scheduleReconnect();
            }
            return;
        }

        broadcastConnectionStatus('reconnecting');
        const isCustomServer = settings.serverUrl && settings.useCustomServer;
        finalUrl = isCustomServer ? settings.serverUrl : OFFICIAL_SERVER_URL;

        // --- Phase 3: URL Validation ---
        try {
            if (isCustomServer) {
                finalUrl = finalUrl.trim();
                if (!finalUrl.includes('://')) {
                    finalUrl = 'ws://' + finalUrl;
                }
                const urlObj = new URL(finalUrl);
                const isLocal = urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1';
                if (urlObj.protocol !== 'wss:' && !isLocal) {
                    urlObj.protocol = 'wss:';
                    finalUrl = urlObj.toString();
                    addLog('Security: Upgraded to wss:// for remote host.', 'warn');
                }
            }
        } catch (e) {
            throw new Error(`[URL Error] ${e.message}`);
        }

        addLog(`Connecting to ${isCustomServer ? finalUrl : 'Official Server'}... (attempt ${reconnectAttempts + 1})`, 'info');

        currentServerUrl = finalUrl;

        // --- Phase 4: WebSocket Init ---
        try {
            canonicalMediaStateTracker.beginRecovery(settings.roomId || currentRoom?.roomId || null);
            persistCanonicalMediaRecovery();
            const url = new URL(finalUrl);
            url.pathname = '/socket.io/';
            url.searchParams.set('EIO', '4');
            url.searchParams.set('transport', 'websocket');
            url.searchParams.set('version', chrome.runtime.getManifest().version);
            url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);

            const generation = ++connectionGeneration;
            attemptGeneration = generation;
            const connectionSocket = new WebSocket(url.toString());
            socket = connectionSocket;

            // --- Phase 5: Event Listeners ---
            connectionSocket.onopen = () => {
                if (generation !== connectionGeneration || socket !== connectionSocket) return;
                reconnectAttempts = 0;
                reconnectStartTime = null;
                reconnectFailed = false;
                addLog('WebSocket Connection Opened', 'success');
                chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null }).catch(() => {});
                isNamespaceJoined = false;
                connectionSocket.send('40');
            };

            connectionSocket.onmessage = async (event) => {
                if (generation !== connectionGeneration || socket !== connectionSocket) return;
                await ensureState();
                if (generation !== connectionGeneration || socket !== connectionSocket) return;
                const msg = event.data;
                if (msg === '2') {
                    connectionSocket.send('3');
                    return;
                }
                if (msg.startsWith('0')) {
                    addLog(`Socket.IO Handshake: ${msg}`, 'info');
                } else if (msg.startsWith('40')) {
                    isConnecting = false;
                    isNamespaceJoined = true;
                    broadcastConnectionStatus('connected');
                    startPing();
                    addLog('Joined Namespace /', 'success');
                    const joinedSettings = await getSettings();
                    if (generation !== connectionGeneration || socket !== connectionSocket) return;
                    if (joinedSettings.roomId) {
                        awaitingRoomData = true;
                        pendingRoomDataRoomId = joinedSettings.roomId;
                        const sharedTitles = getSharedTitleFields(joinedSettings);
                        emit(EVENTS.JOIN_ROOM, {
                            roomId: joinedSettings.roomId,
                            password: joinedSettings.password,
                            peerId,
                            username: joinedSettings.username,
                            tabTitle: sharedTitles.tabTitle,
                            clientCapabilities: CLIENT_CAPABILITIES,
                            protocolVersion: PROTOCOL_VERSION
                        });
                    } else {
                        awaitingRoomData = false;
                        pendingRoomDataRoomId = null;
                        flushEventQueue().catch(error => addLog(`Queue replay failed: ${error.message}`, 'warn'));
                    }
                } else if (msg.startsWith('42')) {
                    try {
                        const payload = JSON.parse(msg.substring(2));
                        try {
                            await handleServerEvent(payload[0], payload[1], generation);
                        } catch (handlerErr) {
                            addLog(`Handler error for ${payload[0]}: ${handlerErr.message}`, 'error');
                        }
                    } catch (_e) {
                        addLog(`Failed to parse message: ${msg}`, 'error');
                    }
                }
            };

            connectionSocket.onclose = () => {
                if (generation !== connectionGeneration || socket !== connectionSocket) return;
                // Invalidate any async message handler that began before the
                // close event and is still suspended at an await boundary.
                connectionGeneration++;
                isConnecting = false;
                isNamespaceJoined = false;
                awaitingRoomData = false;
                pendingRoomDataRoomId = null;
                invalidateChatSession();
                stopPing();
                if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

                if (!connectIntent && !currentRoom) {
                    isForceSyncInitiator = false;
                    forceSyncAcks.clear();
                    if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
                    chrome.storage.session.set({
                        isForceSyncInitiator: false,
                        forceSyncAcks: [],
                        forceSyncDeadline: null
                    }).catch(() => {});
                }

                if (currentRoom && !connectIntent) {
                    currentRoom.peers = [];
                    if (storageInitialized) chrome.storage.session.set({ currentRoom }).catch(() => {});
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
                }
                broadcastConnectionStatus('disconnected');
                socket = null;
                if (currentRoom || connectIntent) {
                    addLog('Disconnected. Scheduling reconnect...', 'warn');
                    scheduleReconnect();
                } else {
                    addLog('Disconnected. No active session — staying disconnected.', 'info');
                }
            };

            connectionSocket.onerror = () => {
                if (generation !== connectionGeneration || socket !== connectionSocket) return;
                broadcastConnectionStatus('disconnected');
                const logType = reconnectAttempts > 1 ? 'error' : 'warn';
                addLog('WebSocket Error: Connection failed', logType);
            };
            handedOffToSocket = true;
        } catch (e) {
            throw new Error(`[Connection Error] ${e.message}`);
        }

    } catch (e) {
        if (attemptGeneration !== connectionGeneration) return;
        isConnecting = false;
        const logType = reconnectAttempts > 1 ? 'error' : 'warn';
        const errMsg = (e && e.message) ? e.message : String(e || 'Unknown connection error');
        addLog(errMsg, logType);
        broadcastConnectionStatus('disconnected');
        if (currentRoom || connectIntent) {
            scheduleReconnect();
        }
    } finally {
        if (!handedOffToSocket) isConnecting = false;
    }
}


// Invariant: only a gated guest (host-only room AND not the host) can be
// "desynced". Any role/mode change that makes us the host, or switches the room
// to 'everyone', must clear the persisted flag — otherwise a stale value would
// mislabel us as "Solo" to peers and (in content) keep us ignoring host commands
// after the reason to is gone. Call after any controlMode/hostPeerId change.
function hcmEnforceDesyncInvariant() {
    if (hcmDesynced && !(controlMode === CONTROL_MODES.HOST_ONLY && !amController())) {
        hcmDesynced = false;
        if (storageInitialized) chrome.storage.session.set({ hcmDesynced: false });
    }
}

function broadcastControlMode() {
    // Notify popup (role badge / host toggle) and the active content tab
    // (so it can enable/disable the host-only guest gate).
    const payload = { type: 'CONTROL_MODE', controlMode, hostPeerId, controllers, amHost: amHost(), amController: amController(), hostControlSupported: serverSupports(CAPABILITIES.HOST_CONTROL), coHostSupported: serverSupports(CAPABILITIES.CO_HOST) };
    chrome.runtime.sendMessage(payload).catch(() => {});
    if (currentTabId) {
        const tabId = parseInt(currentTabId);
        if (!isNaN(tabId)) sendMessageToCurrentContent(payload).catch(() => {});
    }
}

function broadcastConnectionStatus(status) {
    // No room and no intent to connect → this isn't a failure, it's the normal
    // resting state. Surface a distinct 'idle' status so the UI can say
    // "ready to connect" instead of a misleading red "Disconnected".
    if (status === 'disconnected' && !currentRoom && !connectIntent) {
        status = 'idle';
    }
    chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS', status }).catch(() => {});
    if (currentTabId) sendMessageToCurrentContent({ type: 'CONNECTION_STATUS', status }).catch(() => {});
    updateBadgeStatus();
}

async function broadcastJoinStatus(message, shouldSend = () => true) {
    let websiteTabs = [];
    try {
        websiteTabs = await chrome.tabs.query({ url: 'https://sync.koalastuff.net/*' });
    } catch (_) {
        // The website bridge is optional and may be unavailable.
    }
    if (!shouldSend()) return false;
    chrome.runtime.sendMessage(message).catch(() => {});
    await Promise.all(websiteTabs.map(tab =>
        chrome.tabs.sendMessage(tab.id, message).catch(() => {})
    ));
    return true;
}

function updateBadgeStatus() {
    const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
    const isReconnecting = !isConnected && reconnectAttempts > 0;
    const status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : (isReconnecting ? 'reconnecting' : 'disconnected'));

    if (status === 'reconnecting') {
        chrome.action.setBadgeText({ text: '...' });
        chrome.action.setBadgeBackgroundColor({ color: '#c96736' });
    } else if (status === 'connecting') {
        chrome.action.setBadgeText({ text: '...' });
        chrome.action.setBadgeBackgroundColor({ color: '#de7949' });
    } else if (status === 'connected' && currentRoom && currentTabId) {
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#56ae6c' });
    } else {
        chrome.action.setBadgeText({ text: '' });
    }
}

function showNotification(senderName, action) {
    chrome.storage.local.get(['browserNotifications', 'locale'], async (settings) => {
        if (!settings.browserNotifications) return;

        const lang = settings.locale || getSystemLanguage();
        await loadLocale(lang);

        let labelKey = '';
        if (action === 'play') labelKey = 'NOTIF_PLAY';
        else if (action === 'pause') labelKey = 'NOTIF_PAUSE';
        else if (action === 'seek') labelKey = 'NOTIF_SEEK';
        else if (action === 'force_sync_prepare') labelKey = 'NOTIF_FORCE_PREPARE';
        else if (action === 'force_sync_execute') labelKey = 'NOTIF_FORCE_EXECUTE';

        const label = labelKey ? getMessage(labelKey) : action;

        let displayName = senderName || 'A peer';
        if (currentRoom && Array.isArray(currentRoom.peers)) {
            const peer = currentRoom.peers.find(p => (p.peerId || p) === senderName);
            if (peer && peer.username) displayName = peer.username;
        }

        if (displayName === 'You' || displayName === 'YOU') {
            displayName = getMessage('LABEL_YOU') || 'YOU';
        }

        const message = action === 'joined'
            ? getMessage('TOAST_PEER_JOINED', { name: displayName })
            : action === 'left'
                ? getMessage('TOAST_PEER_LEFT', { name: displayName })
                : getMessage('TOAST_PEER_ACTION', { name: displayName, action: label }) + '.';

        chrome.notifications.create(`sync_${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'KoalaSync',
            message: message,
            priority: 1
        });
    });
}

function getTabForNotification(tabId) {
    return new Promise(resolve => {
        try {
            chrome.tabs.get(tabId, tab => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(tab || null);
            });
        } catch (_) {
            resolve(null);
        }
    });
}

function getWindowForNotification(windowId) {
    return new Promise(resolve => {
        try {
            chrome.windows.get(windowId, windowInfo => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(windowInfo || null);
            });
        } catch (_) {
            resolve(null);
        }
    });
}

function showChatNotification(displayName, text) {
    chrome.storage.local.get(['chatNotifications', 'locale'], async (settings) => {
        const enabled = settings.chatNotifications !== false;
        if (!enabled) return;
        const targetTabId = normalizeTabId(currentTabId);
        const tab = targetTabId === null ? null : await getTabForNotification(targetTabId);
        const windowInfo = Number.isInteger(tab?.windowId)
            ? await getWindowForNotification(tab.windowId)
            : null;
        if (!shouldShowChatNotification({ enabled, targetTabId, tab, windowInfo })) return;

        await loadLocale(settings.locale || getSystemLanguage());
        chrome.notifications.create(`chat_${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: getMessage('CHAT_TITLE') || 'KoalaSync',
            message: `${displayName || getMessage('CHAT_TITLE') || 'Room Chat'}: ${text}`,
            priority: 1
        });
    });
}

function chatActivityDisplayName(senderId) {
    if (senderId === peerId) return '';
    const peer = currentRoom?.peers?.find(candidate =>
        (typeof candidate === 'object' ? candidate.peerId : candidate) === senderId
    );
    return typeof peer === 'object' ? peer.username || senderId : senderId;
}

function sendChatActivity(action, senderId, timestamp = Date.now()) {
    if (!currentRoom || !serverSupportsChat()) return;
    if (![EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK, EVENTS.FORCE_SYNC_PREPARE, EVENTS.FORCE_SYNC_EXECUTE, 'joined', 'left'].includes(action)) return;
    const entry = chatActivityStore.add({
        action,
        senderId,
        username: chatActivityDisplayName(senderId),
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now()
    });
    if (!entry) return;
    if (storageInitialized) chrome.storage.session.set({ chatActivityTimeline: chatActivityStore.snapshot() }).catch(() => {});
    if (!currentTabId) return;
    sendMessageToChatOverlay({
        type: 'CHAT_EVENT',
        event: entry
    }).catch(error => addLog(`Chat activity delivery failed: ${error.message}`, 'warn'));
}

function scheduleReconnect() {
    if (reconnectTimer) return;

    if (!reconnectStartTime) reconnectStartTime = Date.now();

    const elapsed = Date.now() - reconnectStartTime;
    reconnectAttempts++;

    if (!reconnectFailed && (elapsed > _RECONNECT_GIVEUP_MS || reconnectAttempts > MAX_RECONNECT_ATTEMPTS)) {
        reconnectFailed = true;
        addLog('Switching to slow reconnect mode (every 5 minutes)', 'warn');
    }

    const baseDelay = reconnectFailed
        ? _RECONNECT_SLOW_DELAY
        : Math.min(_RECONNECT_BASE_DELAY * Math.pow(_RECONNECT_FACTOR, reconnectAttempts - 1), _RECONNECT_MAX_DELAY);
    // Jitter de-synchronizes herds: many clients dropped by the same server
    // blip won't all reconnect on the same tick and exhaust the connection
    // budget in lockstep. Applied in both fast and slow mode.
    const jitterFactor = 1 - _RECONNECT_JITTER + Math.random() * 2 * _RECONNECT_JITTER;
    const delay = Math.round(baseDelay * jitterFactor);

    if (reconnectFailed) {
        addLog(`Slow reconnect in ~5min (attempt ${reconnectAttempts})`, 'info');
    } else {
        addLog(`Reconnect in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`, 'warn');
    }

    chrome.storage.session.set({ reconnectFailed, reconnectAttempts, reconnectStartTime }).catch(() => {});

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

// Slow reconnect logic is now handled in the keepAlive alarm

function emit(event, data) {
    const mustWaitForRoomData = awaitingRoomData
        && event !== EVENTS.JOIN_ROOM
        && event !== EVENTS.GET_ROOMS;
    if (socket && socket.readyState === WebSocket.OPEN
        && isNamespaceJoined
        && !mustWaitForRoomData
        && !flushInProgress) {
        try {
            const msg = encodeSocketEvent(event, data, chatSecretGuard);
            socket.send(msg);
        } catch (e) {
            if (e.message === 'Refusing to send chat secret to relay') {
                addLog(e.message, 'error');
                return;
            }
            // The socket can close between the readyState check and send()
            // (race with a server-side disconnect). Re-queue so the event is
            // retried on the next successful (re)connect instead of being lost.
            addLog(`Send failed, re-queueing ${event}: ${e.message}`, 'warn');
            queueEvent(event, data);
        }
    } else {
        queueEvent(event, data);
    }
}

function emitLive(event, data) {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) return false;
    try {
        socket.send(encodeSocketEvent(event, data, chatSecretGuard));
        return true;
    } catch (e) {
        addLog(e.message === 'Refusing to send chat secret to relay' ? e.message : `Live send failed for ${event}: ${e.message}`, 'error');
        return false;
    }
}

function queueEvent(event, data) {
    const queueRoomId = currentRoom?.roomId || pendingRoomDataRoomId;
    const queued = enqueueQueuedEvent(eventQueue, event, data, { roomId: queueRoomId });
    eventQueue = queued.queue;
    eventQueueVersion++;

    if (isMediaQueueEvent(event)) {
        const latest = eventQueue.at(-1);
        if (mediaIntentNeedsSequenceReservation(latest)) {
            const nextSequence = Math.max(localSeq, maxQueuedSequence(eventQueue)) + 1;
            const reserved = reserveLatestMediaIntentSequence(eventQueue, queueRoomId, nextSequence);
            eventQueue = reserved.queue;
            if (reserved.reserved) {
                localSeq = nextSequence;
                chrome.storage.session.set({ localSeq }).catch(() => {});
            }
        }
        const sourceCount = isQueuedMediaIntent(eventQueue.at(-1))
            ? eventQueue.at(-1).intent.sourceEventCount
            : 0;
        if (sourceCount === 1) {
            addLog('Offline media intent queued; replay deferred until ROOM_DATA', 'info');
        } else if ([10, 50, 100, 500, 1000].includes(sourceCount)) {
            addLog(`Collapsed ${sourceCount} queued media commands into one intent`, 'info');
        }
    }
    if (queued.dropped > 0) {
        addLog('Event queue cap reached, dropping oldest event', 'warn');
    }
    chrome.storage.session.set({ eventQueue }).catch(() => {});
}

function clearEventQueue() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    eventQueue = [];
    eventQueueVersion++;
    chrome.storage.session.set({ eventQueue: [] }).catch(() => {});
}

function applyQueuedRoomPolicy(roomId, policy, reason) {
    const result = reconcileQueuedRoomIntent(eventQueue, { roomId, ...policy });
    eventQueue = result.queue;
    eventQueueVersion++;
    const { discarded } = result;
    if (discarded > 0) {
        chrome.storage.session.set({ eventQueue }).catch(() => {});
        addLog(`${reason}: discarded ${discarded} queued room action${discarded === 1 ? '' : 's'}`, 'warn');
    }
    return result;
}

/**
 * Drain logical queue entries only after ROOM_DATA confirms the current room,
 * role and lobby. Pacing counts materialized wire frames, not logical entries.
 * A two-frame media intent is kept whole at a batch boundary and retained in
 * full if either send fails. Replaying its first legacy frame can repeat a
 * canonical revision/activity side effect, but the ordered full retry remains
 * final-state recoverable without a new delivery-ACK protocol.
 */
async function flushEventQueue(replaySettingsOverride = undefined) {
    if (flushTimer || flushInProgress || awaitingRoomData) return;
    if (!socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) return;
    const flushToken = {};
    const flushConnectionGeneration = connectionGeneration;
    const flushSocket = socket;
    const flushRoomId = currentRoom?.roomId || null;
    flushInProgress = flushToken;
    try {
        // Resolve privacy settings before taking queue ownership. If new work
        // arrives during the drain, keep it behind the original logical entries;
        // final-state retry is safer than losing concurrent intent.
        const replaySettings = replaySettingsOverride !== undefined
            ? replaySettingsOverride
            : (eventQueue.some(isQueuedMediaIntent) ? await getSettings() : null);
        if (flushConnectionGeneration !== connectionGeneration
            || socket !== flushSocket
            || currentRoom?.roomId !== flushRoomId
            || awaitingRoomData) {
            return;
        }
        applyQueuedRoomPolicy(flushRoomId, {
            canControl: !(controlMode === CONTROL_MODES.HOST_ONLY && hostPeerId && !amController()),
            activeLobby: !!(episodeLobby || episodeSyncV2),
            desynced: hcmDesynced,
            authoritativeLobby: !!currentRoom?.activeLobby
        }, 'Queue replay authority changed');
        const drainSource = eventQueue;
        const drainVersion = eventQueueVersion;
        const result = await drainQueuedBatch(drainSource, {
            roomId: currentRoom?.roomId || null,
            maxWireEvents: FLUSH_BATCH_SIZE,
            sendFrame: async (frame, entry) => {
                if (flushConnectionGeneration !== connectionGeneration
                    || socket !== flushSocket
                    || currentRoom?.roomId !== flushRoomId
                    || awaitingRoomData) {
                    return false;
                }
                let payload = frame.data && typeof frame.data === 'object' ? { ...frame.data } : {};
                if (isQueuedMediaIntent(entry)) {
                    payload = withTitlePrivacy(payload, replaySettings, ['mediaTitle']);
                    payload.peerId = peerId;
                }
                return emitLive(frame.event, payload);
            }
        });
        if (eventQueueVersion === drainVersion) {
            eventQueue = result.queue;
            eventQueueVersion++;
        } else {
            // enqueueQueuedEvent preserves object identity for untouched queue
            // entries. Remove only entries the drain completed, leaving any
            // concurrently appended or merged work in place. A partial intent
            // failure returns the complete entry in result.queue, so it is not
            // included in consumedEntries and remains retryable as a unit.
            const consumedCount = drainSource.length - result.queue.length;
            const consumedEntries = new Set(drainSource.slice(0, consumedCount));
            eventQueue = eventQueue.filter(entry => !consumedEntries.has(entry));
            eventQueueVersion++;
            addLog('Queue changed during replay; reconciled completed and concurrent work', 'info');
        }
        chrome.storage.session.set({ eventQueue }).catch(() => {});
        if (result.droppedStaleIntents > 0) {
            addLog(`Dropped ${result.droppedStaleIntents} stale media intent${result.droppedStaleIntents === 1 ? '' : 's'} for a previous room`, 'warn');
        }
        if (result.sentWireEvents > 0) {
            addLog(`Replayed ${result.sentWireEvents} queued wire event${result.sentWireEvents === 1 ? '' : 's'}`, 'info');
        }
        if (eventQueue.length > 0
            && flushConnectionGeneration === connectionGeneration
            && socket === flushSocket
            && socket?.readyState === WebSocket.OPEN
            && isNamespaceJoined
            && !awaitingRoomData) {
            flushTimer = setTimeout(() => {
                flushTimer = null;
                flushEventQueue().catch(error => addLog(`Queue replay failed: ${error.message}`, 'warn'));
            }, FLUSH_BATCH_INTERVAL_MS);
        }
    } finally {
        if (flushInProgress === flushToken) flushInProgress = null;
    }
}

function addToHistory(action, senderId) {
    const historyEntry = {
        action,
        senderId: senderId || 'You',
        timestamp: new Date().toISOString()
    };
    if (!storageInitialized) {
        pendingHistory.unshift(historyEntry);
    } else {
        history.unshift(historyEntry);
        if (history.length > 20) history.pop();
        chrome.storage.session.set({ history });
    }
    chrome.runtime.sendMessage({ type: 'HISTORY_UPDATE', history }).catch(() => {});
}

// --- Ping / Latency ---
function sendPing() {
    const t = Date.now();
    pendingPingT = t;
    emit(EVENTS.PING, { t });
    if (pingTimeout) clearTimeout(pingTimeout);
    pingTimeout = setTimeout(() => {
        pingTimeout = null;
        if (pendingPingT !== t) return; // a PONG arrived in time
        // This ping went unanswered. Tolerate transient blips: only force a
        // reconnect after MAX_MISSED_PONGS consecutive misses, not the first.
        pendingPingT = null;
        missedPongs++;
        if (missedPongs >= MAX_MISSED_PONGS) {
            addLog(`${missedPongs} consecutive pings unanswered — force disconnecting to trigger reconnect`, 'warn');
            missedPongs = 0;
            forceDisconnect();
            if (currentRoom || connectIntent) {
                scheduleReconnect();
            }
        } else {
            addLog(`Ping unanswered (${missedPongs}/${MAX_MISSED_PONGS}) — retrying next interval`, 'warn');
        }
    }, PING_TIMEOUT_MS);
}

function startPing() {
    if (pingInterval) clearInterval(pingInterval);
    if (pingTimeout) { clearTimeout(pingTimeout); pingTimeout = null; }
    currentPingMs = null;
    pendingPingT = null;
    missedPongs = 0;
    pingInterval = setInterval(sendPing, PING_INTERVAL_MS);
    sendPing();
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (pingTimeout) {
        clearTimeout(pingTimeout);
        pingTimeout = null;
    }
    currentPingMs = null;
    pendingPingT = null;
    missedPongs = 0;
}

function markCanonicalMediaStateHandled(roomId, revision) {
    if (!canonicalMediaStateTracker.markHandled(roomId, revision)) return false;
    resetCanonicalMediaRecoveryRetries();
    persistCanonicalMediaRecovery();
    return true;
}

function supersedeCanonicalMediaRecovery(reason, action = null, payload = null) {
    const roomId = currentRoom?.roomId;
    const pending = canonicalMediaStateTracker.getPending(roomId);
    if (!pending || !markCanonicalMediaStateHandled(roomId, pending.mediaState.revision)) {
        return false;
    }
    // Tracking cancellation alone is insufficient: content.js may still be
    // awaiting an asynchronous player action. Invalidate that operation before
    // a newer local or remote control is allowed to win.
    sendMessageToCurrentContent({
        type: 'CANCEL_CANONICAL_MEDIA_STATE',
        reason,
        action,
        payload
    }).catch(() => {});
    addLog(`Canonical media state r${pending.mediaState.revision} superseded by ${reason}`, 'info');
    return true;
}

function isCanonicalSupersedingControl(event, data) {
    if (event === EVENTS.SEEK) {
        return Number.isFinite(data?.targetTime) || Number.isFinite(data?.currentTime);
    }
    if (event === EVENTS.FORCE_SYNC_PREPARE) {
        return Number.isFinite(data?.targetTime);
    }
    return event === EVENTS.PLAY || event === EVENTS.PAUSE || event === EVENTS.FORCE_SYNC_EXECUTE;
}

async function performPendingCanonicalMediaStateApply() {
    const roomId = currentRoom?.roomId;
    const pending = canonicalMediaStateTracker.getPendingProjected(roomId);
    if (!pending || !roomId) return { status: 'none' };

    const { mediaState } = pending;
    if (hcmDesynced) {
        markCanonicalMediaStateHandled(roomId, mediaState.revision);
        addLog(`Canonical media state r${mediaState.revision} skipped: local guest is desynced`, 'info');
        return { status: 'ignored_desynced' };
    }
    if (episodeLobby || episodeSyncV2) {
        markCanonicalMediaStateHandled(roomId, mediaState.revision);
        addLog(`Canonical media state r${mediaState.revision} skipped: episode sync is active`, 'info');
        return { status: 'ignored_episode_lobby' };
    }

    const tabId = normalizeTabId(currentTabId);
    if (tabId === null || currentTargetHasVideo !== true) return { status: 'pending_no_target' };
    const targetGeneration = targetActivationGeneration;
    const targetFrameId = normalizeFrameId(currentTargetFrameId);
    const targetDocumentId = currentTargetDocumentId;

    try {
        const response = await enqueueContentCommand(async () => {
            if (currentRoom?.roomId !== roomId) return { status: 'stale_room' };
            if (!isCurrentTargetIdentity(tabId, targetGeneration)
                || normalizeFrameId(currentTargetFrameId) !== targetFrameId
                || currentTargetDocumentId !== targetDocumentId) {
                return { status: 'stale_target' };
            }
            const latest = canonicalMediaStateTracker.getPending(roomId);
            if (latest?.mediaState.revision !== mediaState.revision) {
                return { status: 'superseded' };
            }
            return sendMessageToContentTab(tabId, {
                type: 'APPLY_CANONICAL_MEDIA_STATE',
                mediaState
            });
        });
        if (currentRoom?.roomId !== roomId) return { status: 'stale_room' };
        if (!isCurrentTargetIdentity(tabId, targetGeneration)
            || normalizeFrameId(currentTargetFrameId) !== targetFrameId
            || currentTargetDocumentId !== targetDocumentId) {
            return { status: 'stale_target' };
        }
        const latestPending = canonicalMediaStateTracker.getPending(roomId);
        if (latestPending?.mediaState.revision !== mediaState.revision) return { status: 'superseded' };

        if (response?.status === 'applied') {
            markCanonicalMediaStateHandled(roomId, mediaState.revision);
            const drift = Number.isFinite(response.drift) ? ` (drift ${response.drift.toFixed(2)}s)` : '';
            addLog(`Applied canonical media state r${mediaState.revision}${drift}`, 'success');
        } else if (response?.status === 'ignored_desynced') {
            markCanonicalMediaStateHandled(roomId, mediaState.revision);
            addLog(`Canonical media state r${mediaState.revision} skipped: content is desynced`, 'info');
        } else if (response?.status === 'ignored_episode_mismatch') {
            markCanonicalMediaStateHandled(roomId, mediaState.revision);
            addLog(`Canonical media state r${mediaState.revision} skipped: content is on a different episode`, 'info');
        } else if (response?.status === 'invalid') {
            markCanonicalMediaStateHandled(roomId, mediaState.revision);
            addLog(`Canonical media state r${mediaState.revision} rejected by content validation`, 'warn');
        }
        return response || { status: 'no_response' };
    } catch (error) {
        addLog(`Canonical media state r${mediaState.revision} pending: ${error.message}`, 'warn');
        return { status: 'pending_unreachable' };
    }
}

async function tryApplyPendingCanonicalMediaState() {
    if (canonicalRecoveryApplyInProgress) return canonicalRecoveryApplyInProgress;
    const applyTask = performPendingCanonicalMediaStateApply();
    canonicalRecoveryApplyInProgress = applyTask;
    let result;
    try {
        result = await applyTask;
    } finally {
        if (canonicalRecoveryApplyInProgress === applyTask) canonicalRecoveryApplyInProgress = null;
    }
    if (CANONICAL_RECOVERY_RETRYABLE.has(result?.status)) {
        scheduleCanonicalMediaRecoveryRetry(result.status);
    }
    return result;
}

async function handleCanonicalRoomData(data, hasPendingLocalIntent) {
    canonicalMediaStateTracker.adoptRoom(data?.roomId || null);
    const canonicalSnapshot = canonicalMediaStateFromRoomData(data);
    if (canonicalSnapshot.status === 'unsupported' || canonicalSnapshot.status === 'empty') {
        persistCanonicalMediaRecovery();
        return;
    }

    if (canonicalSnapshot.status === 'invalid') {
        addLog('Ignored invalid canonical media state in ROOM_DATA', 'warn');
        persistCanonicalMediaRecovery();
        return;
    }
    const { mediaState } = canonicalSnapshot;

    const received = canonicalMediaStateTracker.receive(data.roomId, mediaState);
    if (received.status === 'stale') {
        addLog(`Canonical media state ignored: stale revision ${mediaState.revision}`, 'info');
        return;
    }
    if (received.status !== 'pending') return;

    resetCanonicalMediaRecoveryRetries();
    persistCanonicalMediaRecovery();
    addLog(`Canonical media state received: r${mediaState.revision} ${mediaState.playbackState} @ ${mediaState.currentTime.toFixed(2)}s`, 'info');

    if (hasPendingLocalIntent) {
        markCanonicalMediaStateHandled(data.roomId, mediaState.revision);
        addLog(`Canonical media state r${mediaState.revision} skipped: authorized queued local intent takes precedence`, 'info');
        return;
    }
    const result = await tryApplyPendingCanonicalMediaState();
    if (result.status === 'pending_no_target') {
        addLog(`Canonical media state r${mediaState.revision} pending: no media target`, 'info');
    }
}

// --- Event Handlers ---
async function handleServerEvent(event, data, expectedConnectionGeneration = connectionGeneration) {
    if (expectedConnectionGeneration !== connectionGeneration) return;
    if (!data) {
        addLog(`Ignored server event ${event} due to empty payload`, 'warn');
        return;
    }
    // Host Control Mode (receiver-side backstop): in host-only mode, ignore
    // room-moving events from any non-controller. The server already drops these,
    // so this covers old/buggy/modified clients that slipped through.
    // Defensive: require a known hostPeerId — if the server ever sends host-only
    // without a host (state inconsistency), gate-everyone would lock the owner
    // out of their own room (L-6).
    if (controlMode === CONTROL_MODES.HOST_ONLY &&
        hostPeerId &&
        HOST_ONLY_GATED_ACTIONS.includes(event) &&
        data.senderId && data.senderId !== hostPeerId && !controllers.includes(data.senderId)) {
        addLog(`Ignored ${event} from non-controller ${data.senderId} (host-only)`, 'warn');
        return;
    }
    switch (event) {
        case EVENTS.ROOM_DATA: {
            if (typeof data.roomId !== 'string' || !data.roomId) {
                addLog('Ignored malformed ROOM_DATA without a room ID', 'warn');
                return;
            }
            if (pendingRoomDataRoomId && data.roomId !== pendingRoomDataRoomId) {
                addLog(`Ignored stale ROOM_DATA for ${data.roomId}`, 'warn');
                return;
            }
            if (currentRoom?.roomId !== data.roomId) {
                invalidateChatSession();
                clearChatActivity();
            }
            currentRoom = data;
            // Host Control Mode: adopt room role/mode on (re)join.
            controlMode = data.controlMode || CONTROL_MODES.EVERYONE;
            hostPeerId = data.hostPeerId || null;
            controllers = Array.isArray(data.controllers) ? data.controllers : [];
            serverCapabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
            if (currentTabId) sendMessageToChatOverlay({ type: 'CHAT_CONTEXT_UPDATE' }).catch(() => {});
            hcmEnforceDesyncInvariant();
            broadcastControlMode();
            markRoomPotentiallyIdle();
            if (currentRoom && Array.isArray(currentRoom.peers)) {
                currentRoom.peers = currentRoom.peers
                    .map(createPeerData)
                    .filter(candidate => candidate.peerId);
                
                // Clear sequence tracking for peers that are no longer in the room
                const activePeerIds = new Set(currentRoom.peers.map(p => typeof p === 'object' ? p.peerId : p));
                Object.keys(lastSeqBySender).forEach(pId => {
                    if (!activePeerIds.has(pId)) {
                        delete lastSeqBySender[pId];
                    }
                });
                _persistLastSeq();
            } else if (currentRoom) {
                currentRoom.peers = [];
            }

            const roomPeerIds = new Set(currentRoom.peers.map(candidate => candidate.peerId));
            const authoritativeEpisodeSyncV2 = serverSupports(CAPABILITIES.EPISODE_SYNC_V2)
                ? normalizeEpisodeSyncV2(data.episodeSyncV2, roomPeerIds)
                : null;
            if (data.episodeSyncV2 && !authoritativeEpisodeSyncV2) {
                addLog('Ignored malformed Episode Sync v2 transaction in ROOM_DATA', 'warn');
            }
            if (authoritativeEpisodeSyncV2) {
                const shouldNotifyContent = !episodeSyncV2
                    || episodeSyncV2.transactionId !== authoritativeEpisodeSyncV2.transactionId
                    || episodeSyncV2.phase !== authoritativeEpisodeSyncV2.phase;
                if (episodeLobby) clearEpisodeLobbyState();
                episodeSyncV2 = authoritativeEpisodeSyncV2;
                currentRoom.episodeSyncV2 = authoritativeEpisodeSyncV2;
                persistEpisodeSyncV2();
                broadcastLobbyUpdate();
                if (shouldNotifyContent) sendEpisodeSyncV2ToContent().catch(() => {});
            } else if (episodeSyncV2) {
                clearEpisodeSyncV2State({ reason: 'relay_state_ended' });
            } else {
                currentRoom.episodeSyncV2 = null;
            }

            // ROOM_DATA is authoritative for an already-active server lobby,
            // but a locally-created offline lobby has not reached the relay
            // yet and must remain owned by its initiator until queued replay.
            const hasQueuedLocalLobby = eventQueue.some(entry =>
                entry?.event === EVENTS.EPISODE_LOBBY
                && (!entry.roomId || entry.roomId === data.roomId)
            );
            const authoritativeLobby = authoritativeEpisodeSyncV2 ? null : normalizeEpisodeLobby(
                data.activeLobby,
                Date.now(),
                new Set(currentRoom.peers.map(candidate => candidate.peerId))
            );
            if (data.activeLobby && !authoritativeLobby) {
                addLog('Ignored malformed active Episode Lobby in ROOM_DATA', 'warn');
            }
            currentRoom.activeLobby = authoritativeLobby;
            if (!authoritativeLobby && episodeLobby && !hasQueuedLocalLobby) {
                clearEpisodeLobbyState();
                addLog('Discarded stale local Episode Lobby after ROOM_DATA confirmed it ended', 'info');
            } else if (authoritativeLobby) {
                const sameLobby = episodeLobby
                    && episodeLobby.expectedTitle === authoritativeLobby.expectedTitle
                    && episodeLobby.initiatorPeerId === authoritativeLobby.initiatorPeerId;
                if (!sameLobby && episodeLobbyTimeout) {
                    clearTimeout(episodeLobbyTimeout);
                    episodeLobbyTimeout = null;
                }
                episodeLobby = {
                    ...authoritativeLobby,
                    createdAt: sameLobby && Number.isFinite(episodeLobby.createdAt)
                        ? episodeLobby.createdAt
                        : authoritativeLobby.createdAt
                };
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                if (!sameLobby) {
                    addLog(`Recovered active episode lobby from server: "${episodeLobby.expectedTitle}"`, 'info');
                }

                // Notify content script to start polling
                if (!sameLobby && currentTabId) {
                    const tabId = parseInt(currentTabId);
                    if (!isNaN(tabId)) {
                        sendMessageToCurrentContent({
                            type: 'EPISODE_LOBBY',
                            expectedTitle: episodeLobby.expectedTitle
                        }).catch(() => {});
                    }
                }

                // Schedule timeout if we don't already have one
                if (!episodeLobbyTimeout) {
                    episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout'), EPISODE_LOBBY_TIMEOUT);
                }
            }
            if (storageInitialized) chrome.storage.session.set({ currentRoom });
            addLog(`Joined Room: ${data?.roomId || 'unknown'}`, 'success');
            chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: data.peers }).catch(() => {});
                        
            // Inform Website Bridge & Popup
            const joinStatusMsg = { type: 'JOIN_STATUS', success: true, message: 'Joined' };
            await broadcastJoinStatus(joinStatusMsg);
            if (expectedConnectionGeneration !== connectionGeneration
                || currentRoom?.roomId !== data.roomId) return;
            // Resolve replay privacy before declaring ROOM_DATA complete. Local
            // commands remain queued during this await, and any intervening
            // role/lobby event is reflected by the policy below before the
            // canonical precedence decision is made.
            const replaySettings = eventQueue.some(isQueuedMediaIntent)
                ? await getSettings()
                : null;
            if (expectedConnectionGeneration !== connectionGeneration
                || currentRoom?.roomId !== data.roomId) return;
            awaitingRoomData = false;
            pendingRoomDataRoomId = null;

            const lostRoomAuthority = controlMode === CONTROL_MODES.HOST_ONLY
                && hostPeerId
                && !amController();
            const queuePolicy = applyQueuedRoomPolicy(data.roomId, {
                canControl: !lostRoomAuthority,
                activeLobby: !!(episodeLobby || episodeSyncV2),
                desynced: hcmDesynced,
                authoritativeLobby: !!(authoritativeLobby || authoritativeEpisodeSyncV2)
            }, lostRoomAuthority
                ? 'Host Control role changed while offline'
                : ((episodeLobby || episodeSyncV2) ? 'Active Episode Sync takes precedence' : 'Reconnect queue policy'));

            await handleCanonicalRoomData(data, queuePolicy.hasPendingLocalIntent);
            await flushEventQueue(replaySettings);
            break;
        }
        case EVENTS.CONTROL_MODE:
            // Terminal room teardown is authoritative. Older/custom relays may
            // still emit a trailing role update after ROOM_CLOSED.
            if (!currentRoom) break;
            // Host Control Mode changed (toggle or host-leave fallback).
            controlMode = data.controlMode || CONTROL_MODES.EVERYONE;
            hostPeerId = data.hostPeerId || null;
            controllers = Array.isArray(data.controllers) ? data.controllers : [];
            hcmEnforceDesyncInvariant();
            if (currentRoom) {
                currentRoom.controlMode = controlMode;
                currentRoom.hostPeerId = hostPeerId;
                currentRoom.controllers = controllers;
                if (storageInitialized) chrome.storage.session.set({ currentRoom });
            }
            addLog(`Control mode: ${controlMode}${amHost() ? ' (you are owner)' : (amController() ? ' (you are controller)' : '')}`, 'info');
            broadcastControlMode();
            break;
        case EVENTS.ROOM_LIST:
            chrome.runtime.sendMessage({ type: 'ROOM_LIST', rooms: data.rooms }).catch(() => {});
            break;
        case EVENTS.CHAT_MESSAGE: {
            if (!currentRoom || !serverSupportsChat() || !currentTabId) break;
            const generation = chatSessionGeneration;
            const roomId = currentRoom.roomId;
            const tabId = Number(currentTabId);
            const received = { ...data };
            const isCurrentSession = () => generation === chatSessionGeneration &&
                currentRoom?.roomId === roomId && Number(currentTabId) === tabId;
            chatReceiveQueue = chatReceiveQueue.catch(() => {}).then(async () => {
                if (!isCurrentSession()) return;
                const settings = await getSettings();
                if (!settings.chatEnabled || !settings.chatKey || settings.roomId !== roomId || !isCurrentSession()) return;
                const chatKey = settings.chatKey;
                try {
                    const text = await decryptChatMessage({
                        ciphertext: received.ciphertext,
                        roomId,
                        senderId: received.senderId,
                        secret: chatKey
                    });
                    if (!isCurrentSession() || chatSecretGuard !== chatKey) return;
                    if (received.senderId === peerId) chatEchoTracker.acknowledge(received.ciphertext);
                    const senderPeer = currentRoom.peers?.find(candidate =>
                        (typeof candidate === 'object' ? candidate.peerId : candidate) === received.senderId
                    );
                    if (Number.isInteger(tabId)) {
                        sendMessageToChatOverlay({
                            type: 'CHAT_MESSAGE',
                            message: {
                                id: received.id,
                                senderId: received.senderId,
                                username: typeof senderPeer === 'object' ? senderPeer.username : null,
                                timestamp: received.timestamp,
                                text
                            }
                        }).catch(() => {});
                    }
                    if (received.senderId !== peerId) {
                        showChatNotification(
                            typeof senderPeer === 'object' ? senderPeer.username : received.senderId,
                            text
                        );
                    }
                } catch (_) {
                    if (isCurrentSession()) addLog('Discarded chat message that failed authentication', 'warn');
                }
            });
            await chatReceiveQueue;
            break;
        }
        case EVENTS.ERROR: {
            isConnecting = false;
            const terminalRoomError = data.code === ERROR_CODES.ROOM_CLOSED
                || data.code === ERROR_CODES.PEER_TIMED_OUT
                || data.message === 'Room closed'
                || data.message === 'Removed from room after inactivity';
            if (currentRoom && terminalRoomError) {
                await endRoomSession({ reason: `Room session ended: ${data.message}` });
            }
            // If we get a server error before successfully joining a room,
            // clear persisted credentials as well, otherwise service-worker
            // restart would immediately retry the rejected room.
            if (!currentRoom && connectIntent) {
                await clearFailedJoinCredentials();
                if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                reconnectAttempts = 0;
                reconnectFailed = false;
            }
            broadcastConnectionStatus('disconnected');
            addLog(`Server Error: ${data.message}`, 'error');
            chrome.storage.local.get(['browserNotifications', 'locale'], async (settings) => {
                if (!settings.browserNotifications) return;
                const lang = settings.locale || getSystemLanguage();
                await loadLocale(lang);
                chrome.notifications.create(`error_${Date.now()}`, {
                    type: 'basic',
                    iconUrl: 'icons/icon128.png',
                    title: getMessage('NOTIF_ERROR_TITLE') || 'KoalaSync Error',
                    message: data.message
                });
            });
            // Inform Website Bridge & Popup
            const errStatusMsg = { type: 'JOIN_STATUS', success: false, message: data.message };
            await broadcastJoinStatus(errStatusMsg);
            break;
        }
        case EVENTS.PLAY:
        case EVENTS.PAUSE:
        case EVENTS.SEEK:
        case EVENTS.FORCE_SYNC_PREPARE:
            if (event === EVENTS.FORCE_SYNC_PREPARE && episodeLobby) {
                if (currentRoom) currentRoom.activeLobby = null;
                clearEpisodeLobbyState();
            }
            if (data.senderId && typeof data.seq === 'number') {
                const lastSeq = lastSeqBySender[data.senderId];
                if (lastSeq !== undefined && data.seq <= lastSeq) {
                    addLog(`Ignored stale ${event} from ${data.senderId} (seq ${data.seq} <= ${lastSeq})`, 'warn');
                    break;
                }
                lastSeqBySender[data.senderId] = data.seq;
                _persistLastSeq();
            }
            if (isCanonicalSupersedingControl(event, data)) {
                supersedeCanonicalMediaRecovery(`newer ${event}`, event, data);
            }
            if (data.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);
                sendChatActivity(event, data.senderId, data.actionTimestamp);
                updateLastAction(event, data.senderId);
                lastActionState.targetTime = data.targetTime !== undefined ? data.targetTime : data.currentTime;
                if (storageInitialized) chrome.storage.session.set({ lastActionState });

                // Remote Reactive Update
                updateLocalPeerState(data.senderId, {
                    playbackState: event === EVENTS.PLAY ? 'playing' : (event === EVENTS.PAUSE ? 'paused' : undefined),
                    currentTime: data.currentTime !== undefined ? data.currentTime : (data.targetTime !== undefined ? data.targetTime : undefined)
                });
            }
            routeToContent(event, data);
            break;
        case EVENTS.FORCE_SYNC_ACK:
            if (data.senderId && typeof data.seq === 'number') {
                const lastSeq = lastSeqBySender[data.senderId];
                if (lastSeq !== undefined && data.seq <= lastSeq) break;
                lastSeqBySender[data.senderId] = data.seq;
                _persistLastSeq();
            }
            if (isForceSyncInitiator) {
                forceSyncAcks.add(data.senderId);
                chrome.storage.session.set({ forceSyncAcks: Array.from(forceSyncAcks) });
                addLog(`Received ACK from ${data.senderId} (${forceSyncAcks.size})`, 'info');
                
                // Update UI state for buffering progress
                if (lastActionState && lastActionState.action === EVENTS.FORCE_SYNC_PREPARE) {
                    if (!Array.isArray(lastActionState.acks)) lastActionState.acks = [];
                    if (!lastActionState.acks.includes(data.senderId)) {
                        lastActionState.acks.push(data.senderId);
                        if (storageInitialized) chrome.storage.session.set({ lastActionState });
                        chrome.runtime.sendMessage({ type: 'ACTION_UPDATE', state: lastActionState }).catch(() => {});
                    }

                    // Force Sync ACK Reactive Update
                    updateLocalPeerState(data.senderId, {
                        playbackState: 'paused', // Preparing for force sync always pauses the player
                        currentTime: lastActionState.targetTime
                    });
                }

                // Check if all peers responded using the snapshot count
                const targetCount = expectedAcksCount > 0 ? expectedAcksCount : (currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.length : 1);
                if (forceSyncAcks.size >= targetCount) {
                    executeForceSync();
                }
            }
            break;
        case EVENTS.FORCE_SYNC_EXECUTE:
            if (episodeLobby) {
                if (currentRoom) currentRoom.activeLobby = null;
                clearEpisodeLobbyState();
            }
            if (data?.senderId && typeof data.seq === 'number') {
                const lastSeq = lastSeqBySender[data.senderId];
                if (lastSeq !== undefined && data.seq <= lastSeq) break;
                lastSeqBySender[data.senderId] = data.seq;
                _persistLastSeq();
            }
            supersedeCanonicalMediaRecovery(`newer ${event}`, event, data);
            if (data?.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);
                sendChatActivity(event, data.senderId, data.actionTimestamp);

                // (The sender's state is updated below with everyone else)
            }

            // Force Sync Execute Remote Reactive Update:
            // Set all peers to playing and apply a reactive lock to block stale heartbeats
            if (currentRoom && Array.isArray(currentRoom.peers)) {
                currentRoom.peers.forEach(peer => {
                    if (peer && typeof peer === 'object') {
                        peer.playbackState = 'playing';
                        peer.lastReactiveUpdate = Date.now();
                    }
                });
                if (storageInitialized) chrome.storage.session.set({ currentRoom });
                chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
            }

            routeToContent(event, data);
            break;
        case EVENTS.PING:
            if (data && typeof data.t === 'number' && Number.isFinite(data.t) && data.sender) {
                emit(EVENTS.PONG, { t: data.t, target: data.sender });
            }
            break;
        case EVENTS.EVENT_ACK:
            if (lastActionState && lastActionState.action && data?.senderId) {
                // Correlation Check: Only accept ACK if it matches our current action's timestamp
                if (data.actionTimestamp === lastActionState.timestamp) {
                    if (!Array.isArray(lastActionState.acks)) lastActionState.acks = [];
                    if (!lastActionState.acks.includes(data.senderId)) {
                        lastActionState.acks.push(data.senderId);
                        if (storageInitialized) chrome.storage.session.set({ lastActionState });
                        chrome.runtime.sendMessage({ type: 'ACTION_UPDATE', state: lastActionState }).catch(() => {});

                        // ACK Reactive Update
                        updateLocalPeerState(data.senderId, {
                            playbackState: lastActionState.action === EVENTS.PLAY ? 'playing' : (lastActionState.action === EVENTS.PAUSE ? 'paused' : undefined),
                            currentTime: (lastActionState.action === EVENTS.SEEK || lastActionState.action === EVENTS.FORCE_SYNC_PREPARE) ? lastActionState.targetTime : undefined
                        });
                    }
                }
            }
            break;
        case EVENTS.PEER_STATUS:
            if (currentRoom) {
                if (!Array.isArray(currentRoom.peers)) currentRoom.peers = [];
                if (data.status === 'joined') {
                    if (!currentRoom.peers.find(p => (p.peerId || p) === data.peerId)) {
                        const wasSolo = currentRoom.peers.filter(p => (p.peerId || p) !== peerId).length === 0;
                        delete lastSeqBySender[data.peerId];
                        _persistLastSeq();

                        currentRoom.peers.push(createPeerData(data));
                        if (storageInitialized) chrome.storage.session.set({ currentRoom });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                        sendChatActivity('joined', data.peerId, Date.now());
                        showNotification(data.username || data.peerId, 'joined');

                        // We were alone and now we're not — proactively push our
                        // current playback state so the newcomer syncs immediately
                        // instead of waiting up to a full heartbeat interval.
                        if (wasSolo && currentTabId) {
                            sendMessageToCurrentContent({ type: 'REQUEST_HEARTBEAT' }).catch(() => {});
                        }

                        if (episodeLobby && episodeLobby.initiatorPeerId === peerId) {
                            emitEpisodeLobbyForCurrentPrivacy();
                        }
                    }
                } else if (data.status === 'left') {
                    const departedDisplayName = chatActivityDisplayName(data.peerId);
                    sendChatActivity('left', data.peerId, Date.now());
                    showNotification(departedDisplayName, 'left');
                    currentRoom.peers = currentRoom.peers.filter(p => (p.peerId || p) !== data.peerId);
                    if (storageInitialized) chrome.storage.session.set({ currentRoom });
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});

                    if (episodeLobby) {
                        checkEpisodeLobbyPeerDeparture();
                    }

                    if (isForceSyncInitiator) {
                        forceSyncAcks.delete(data.peerId);
                        chrome.storage.session.set({ forceSyncAcks: Array.from(forceSyncAcks) });
                        expectedAcksCount = Math.max(1, currentRoom.peers ? currentRoom.peers.length : 1);
                        chrome.storage.session.set({ expectedAcksCount });
                        if (forceSyncAcks.size >= expectedAcksCount) {
                            executeForceSync();
                        }
                    }
                } else {
                    const peer = currentRoom.peers.find(p => (typeof p === 'object' ? p.peerId : p) === data.peerId);
                    if (peer) {
                        if (typeof peer === 'object') {
                            peer.tabTitle = data.tabTitle;
                            peer.username = data.username;
                            peer.mediaTitle = data.mediaTitle !== undefined ? data.mediaTitle : peer.mediaTitle;
                            peer.volume = data.volume !== undefined ? data.volume : peer.volume;
                            peer.muted = data.muted !== undefined ? data.muted : peer.muted;
                            // Only update when present. Our own heartbeats now carry
                            // 'desynced', but other PEER_STATUS variants (server join
                            // broadcast, future/old clients) omit it — and clobbering it
                            // to false there would flicker the host's "Solo" badge.
                            if (data.desynced !== undefined) peer.desynced = data.desynced === true;

                            const timeSinceReactive = peer.lastReactiveUpdate ? (Date.now() - peer.lastReactiveUpdate) : Infinity;
                            const ignoreStatus = timeSinceReactive < 300;

                            if (!ignoreStatus) {
                                peer.playbackState = data.playbackState !== undefined ? data.playbackState : peer.playbackState;
                                peer.currentTime = data.currentTime !== undefined ? data.currentTime : peer.currentTime;
                                if (data.playbackState !== undefined || data.currentTime !== undefined) {
                                    peer.lastHeartbeat = Date.now();
                                }
                            }
                        } else {
                            // Migration: replace string peer with normalized object
                            const idx = currentRoom.peers.indexOf(peer);
                            currentRoom.peers[idx] = createPeerData(data);
                        }
                        if (storageInitialized) chrome.storage.session.set({ currentRoom });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                        if (episodeLobby) {
                            checkEpisodeLobbyCompletion();
                        }
                    }
                }
            }
            break;
        case EVENTS.EPISODE_SYNC_V2: {
            if (!serverSupports(CAPABILITIES.EPISODE_SYNC_V2)) {
                addLog('Ignored Episode Sync v2 event from relay without advertised capability', 'warn');
                break;
            }
            const phase = data.phase;
            if (phase === 'cancel' && !data.transactionId) {
                addLog(`Episode Sync v2 unavailable: ${data.reason || 'rejected'}`, 'warn');
                break;
            }
            if (phase === 'lobby' || phase === 'prepare') {
                const activePeerIds = new Set((currentRoom?.peers || []).map(candidate =>
                    typeof candidate === 'object' ? candidate.peerId : candidate
                ));
                const incoming = normalizeEpisodeSyncV2(data, activePeerIds);
                if (!incoming
                    || !incoming.participants.includes(peerId)
                    || data.senderId !== incoming.initiatorPeerId) {
                    addLog('Ignored malformed Episode Sync v2 state', 'warn');
                    break;
                }
                if (episodeSyncV2
                    && episodeSyncV2.transactionId === incoming.transactionId
                    && incoming.revision < episodeSyncV2.revision) {
                    addLog(`Ignored stale Episode Sync v2 revision ${incoming.revision}`, 'warn');
                    break;
                }
                const shouldNotifyContent = !episodeSyncV2
                    || episodeSyncV2.transactionId !== incoming.transactionId
                    || episodeSyncV2.phase !== incoming.phase;
                if (episodeSyncV2 && episodeSyncV2.transactionId !== incoming.transactionId) {
                    clearEpisodeSyncV2State({ reason: 'transaction_replaced' });
                }
                if (episodeLobby) clearEpisodeLobbyState();
                episodeSyncV2 = incoming;
                if (currentRoom) currentRoom.episodeSyncV2 = incoming;
                persistEpisodeSyncV2();
                broadcastLobbyUpdate();
                if (shouldNotifyContent) sendEpisodeSyncV2ToContent().catch(() => {});
                addLog(`Episode Sync v2 ${incoming.phase}: "${incoming.expectedTitle}" (${incoming.transactionId.substring(0, 8)})`, 'info');
                break;
            }
            if ((phase === 'execute' || phase === 'cancel')
                && episodeSyncV2
                && data.transactionId === episodeSyncV2.transactionId) {
                const completed = episodeSyncV2;
                if (phase === 'execute') {
                    sendMessageToCurrentContent({
                        type: 'EPISODE_SYNC_V2',
                        transaction: { ...completed, phase: 'execute', targetTime: 0 }
                    }).catch(() => {});
                    if (currentRoom && Array.isArray(currentRoom.peers)) {
                        currentRoom.peers.forEach(candidate => {
                            if (candidate && typeof candidate === 'object') {
                                candidate.playbackState = 'playing';
                                candidate.currentTime = 0;
                                candidate.lastReactiveUpdate = Date.now();
                            }
                        });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                    }
                    clearEpisodeSyncV2State({ notifyContent: false, reason: 'executed' });
                    addLog(`Episode Sync v2 executed for "${completed.expectedTitle}"`, 'success');
                } else {
                    clearEpisodeSyncV2State({ reason: data.reason || 'cancelled' });
                    addLog(`Episode Sync v2 cancelled: ${data.reason || 'cancelled'}`, 'warn');
                }
            }
            break;
        }
        case EVENTS.EPISODE_LOBBY:
            if (typeof data.senderId === 'string'
                && typeof data.expectedTitle === 'string'
                && data.expectedTitle
                && currentRoom?.peers?.some(peer => (typeof peer === 'object' ? peer.peerId : peer) === data.senderId)) {
                const expectedTitle = data.expectedTitle.substring(0, 100);
                const incomingLobby = normalizeEpisodeLobby({
                    expectedTitle,
                    initiatorPeerId: data.senderId,
                    readyPeers: data.authoritative === true && Array.isArray(data.readyPeers)
                        ? data.readyPeers
                        : [data.senderId],
                    createdAt: Date.now()
                }, Date.now(), new Set(currentRoom.peers.map(peer => peer.peerId)));
                if (!incomingLobby) {
                    addLog(`Ignored malformed Episode lobby from ${data.senderId}`, 'warn');
                    break;
                }
                supersedeCanonicalMediaRecovery(`newer ${event}`);
                if (currentRoom) {
                    currentRoom.activeLobby = incomingLobby;
                    if (storageInitialized) chrome.storage.session.set({ currentRoom });
                }
                addLog(`Episode lobby from ${data.senderId}: "${expectedTitle}"`, 'info');
                // If we already have a lobby for this same title, treat as dedup
                if (episodeLobby
                    && episodeLobby.initiatorPeerId === data.senderId
                    && sameEpisode(episodeLobby.expectedTitle, expectedTitle)) {
                    break; // Already tracking this lobby
                }
                // Cancel any existing lobby before starting a new one
                if (episodeLobby) clearEpisodeLobbyState();
                
                episodeLobby = {
                    ...incomingLobby,
                    createdAt: Date.now()
                };
                persistEpisodeLobby();
                broadcastLobbyUpdate();

                // Start timeout
                episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout'), EPISODE_LOBBY_TIMEOUT);

                // Forward to content script to start polling
                if (currentTabId) {
                    const tabId = parseInt(currentTabId);
                    if (!isNaN(tabId)) {
                        sendMessageToCurrentContent({
                            type: 'EPISODE_LOBBY',
                            expectedTitle
                        }).catch(() => {});
                    }
                }
            }
            break;
        case EVENTS.EPISODE_READY:
            {
                const lobby = episodeLobby;
                if (!lobby || !data.senderId) break;
                const senderPresent = currentRoom?.peers?.some(peer =>
                    (typeof peer === 'object' ? peer.peerId : peer) === data.senderId
                );
                if (!senderPresent
                    || (data.expectedTitle
                        && !sameEpisode(data.expectedTitle, lobby.expectedTitle))) {
                    addLog(`Ignored stale Episode ready from ${data.senderId}`, 'warn');
                    break;
                }
                let readyAdded = false;
                if (!lobby.readyPeers.includes(data.senderId)) {
                    lobby.readyPeers.push(data.senderId);
                    readyAdded = true;
                    persistEpisodeLobby();
                    broadcastLobbyUpdate();
                    addLog(`Episode ready from ${data.senderId} (${lobby.readyPeers.length})`, 'info');
                }
                const readyPeers = [...lobby.readyPeers];
                if (currentRoom?.activeLobby) {
                    currentRoom.activeLobby.readyPeers = readyPeers;
                    if (storageInitialized) chrome.storage.session.set({ currentRoom });
                }
                if (readyAdded) checkEpisodeLobbyCompletion();
            }
            break;
        case EVENTS.EPISODE_LOBBY_CANCEL:
            if (typeof data.senderId !== 'string' || !currentRoom?.peers?.some(peer =>
                (typeof peer === 'object' ? peer.peerId : peer) === data.senderId)) {
                addLog(`Ignored Episode lobby cancellation from unknown peer ${data.senderId || 'unknown'}`, 'warn');
                break;
            }
            supersedeCanonicalMediaRecovery(`newer ${event}`);
            if (currentRoom) {
                currentRoom.activeLobby = null;
                if (storageInitialized) chrome.storage.session.set({ currentRoom });
            }
            if (episodeLobby) {
                const title = episodeLobby.expectedTitle;
                clearEpisodeLobbyState();
                addLog(`Episode lobby for "${title}" cancelled by ${data.senderId || 'peer'}`, 'warn');
            }
            break;
        case EVENTS.PONG:
            if (data && typeof data.t === 'number' && Number.isFinite(data.t)) {
                if (pendingPingT === data.t) {
                    pendingPingT = null;
                    missedPongs = 0;
                    if (pingTimeout) {
                        clearTimeout(pingTimeout);
                        pingTimeout = null;
                    }
                    const rtt = Date.now() - data.t;
                    currentPingMs = (rtt >= 0 && rtt < 30000) ? rtt : null;
                    chrome.runtime.sendMessage({ type: 'PING_UPDATE', ping: currentPingMs }).catch(() => {});
                }
            }
            break;
        default:
            addLog(`Received unknown event from server: ${event}`, 'warn');
            break;
    }
}

function executeForceSync() {
    supersedeCanonicalMediaRecovery('local force_sync_execute', EVENTS.FORCE_SYNC_EXECUTE);
    if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
    isForceSyncInitiator = false;
    forceSyncAcks.clear();
    expectedAcksCount = 0;
    chrome.storage.session.set({ 
        isForceSyncInitiator: false, 
        forceSyncAcks: [], 
        forceSyncDeadline: null,
        expectedAcksCount: 0
    });

    // Set all peers to playing and apply a reactive lock to block stale heartbeats
    if (currentRoom && Array.isArray(currentRoom.peers)) {
        currentRoom.peers.forEach(peer => {
            if (peer && typeof peer === 'object') {
                peer.playbackState = 'playing';
                peer.lastReactiveUpdate = Date.now();
            }
        });
        if (storageInitialized) chrome.storage.session.set({ currentRoom });
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
    }

    const executionTimestamp = Date.now();
    updateLastAction(EVENTS.FORCE_SYNC_EXECUTE, 'You', executionTimestamp);

    localSeq++;
    chrome.storage.session.set({ localSeq });

    emit(EVENTS.FORCE_SYNC_EXECUTE, { actionTimestamp: executionTimestamp, seq: localSeq });
    routeToContent(EVENTS.FORCE_SYNC_EXECUTE, { actionTimestamp: executionTimestamp, seq: localSeq });
    sendChatActivity(EVENTS.FORCE_SYNC_EXECUTE, peerId, executionTimestamp);
    addLog('Force Sync Executed', 'success');
}

function completeForceSyncBeforeTargetChange(nextTabId) {
    const selectedTabId = normalizeTabId(currentTabId);
    const normalizedNextTabId = normalizeTabId(nextTabId);
    if (selectedTabId !== null && selectedTabId === normalizedNextTabId) return;

    if (episodeSyncV2) cancelEpisodeSyncV2('target_changed');
    if (!isForceSyncInitiator) return;

    addLog('Finishing Force Sync before target change', 'info');
    executeForceSync();
}

// --- Episode Auto-Sync Lobby Functions ---
function persistEpisodeLobby() {
    if (storageInitialized) chrome.storage.session.set({ episodeLobby });
}

function episodeLobbyForUi() {
    if (!episodeSyncV2) return episodeLobby;
    return {
        expectedTitle: episodeSyncV2.expectedTitle,
        initiatorPeerId: episodeSyncV2.initiatorPeerId,
        readyPeers: episodeSyncV2.phase === 'prepare'
            ? [...episodeSyncV2.preparedPeers]
            : [...episodeSyncV2.loadedPeers],
        createdAt: episodeSyncV2.createdAt,
        mode: 'v2',
        phase: episodeSyncV2.phase,
        transactionId: episodeSyncV2.transactionId
    };
}

function broadcastLobbyUpdate() {
    chrome.runtime.sendMessage({ type: 'LOBBY_UPDATE', lobby: episodeLobbyForUi() }).catch(() => {});
}

function persistEpisodeSyncV2() {
    if (!storageInitialized) return;
    chrome.storage.session.set({ episodeSyncV2, currentRoom }).catch(() => {});
}

function sendEpisodeSyncV2ToContent(transaction = episodeSyncV2) {
    if (!transaction || !currentTabId) return Promise.resolve();
    return sendMessageToCurrentContent({
        type: 'EPISODE_SYNC_V2',
        transaction: { ...transaction }
    });
}

function clearEpisodeSyncV2State({ notifyContent = true, reason = 'cancelled' } = {}) {
    const previous = episodeSyncV2;
    episodeSyncV2 = null;
    if (currentRoom) currentRoom.episodeSyncV2 = null;
    persistEpisodeSyncV2();
    broadcastLobbyUpdate();
    if (notifyContent && previous && currentTabId) {
        sendMessageToCurrentContent({
            type: 'EPISODE_SYNC_V2',
            transaction: {
                ...previous,
                phase: 'cancel',
                reason
            }
        }).catch(() => {});
    }
}

function cancelEpisodeSyncV2(reason = 'cancelled') {
    if (!episodeSyncV2) return false;
    const transaction = episodeSyncV2;
    emitLive(EVENTS.EPISODE_SYNC_V2, {
        phase: 'cancel',
        transactionId: transaction.transactionId,
        reason
    });
    clearEpisodeSyncV2State({ reason });
    return true;
}

function clearEpisodeLobbyState() {
    if (episodeLobbyTimeout) clearTimeout(episodeLobbyTimeout);
    episodeLobbyTimeout = null;
    episodeLobby = null;
    if (storageInitialized) chrome.storage.session.set({ episodeLobby: null });
    broadcastLobbyUpdate();

    // Notify content script to stop polling
    if (currentTabId) {
        const tabId = parseInt(currentTabId);
        if (!isNaN(tabId)) {
            sendMessageToCurrentContent({ type: 'EPISODE_LOBBY_CANCEL' }).catch(() => {});
        }
    }
}

function cancelEpisodeLobby(reason) {
    if (!episodeLobby) return;
    const title = episodeLobby.expectedTitle;
    supersedeCanonicalMediaRecovery('local episode_lobby_cancel');
    
    // Broadcast cancellation to room
    emitLive(EVENTS.EPISODE_LOBBY_CANCEL, { peerId });

    clearEpisodeLobbyState();
    addLog(`Episode lobby cancelled: ${reason} for "${title}"`, 'warn');

    const reasonKeys = {
        'Timeout': 'LOBBY_CANCEL_TIMEOUT',
        'Timeout (recovered)': 'LOBBY_CANCEL_TIMEOUT_RECOVERED',
        'All other peers left': 'LOBBY_CANCEL_PEERS_LEFT',
        'Timeout — not all peers loaded the episode': 'LOBBY_CANCEL_TIMEOUT_PEERS_LOAD',
        'Cancelled by user': 'LOBBY_CANCEL_USER'
    };

    // Chrome notification on failure (per Q2: only notify on failure)
    chrome.storage.local.get(['browserNotifications', 'locale'], async (settings) => {
        if (!settings.browserNotifications) return;

        const lang = settings.locale || getSystemLanguage();
        await loadLocale(lang);

        const reasonKey = reasonKeys[reason];
        const localizedReason = reasonKey ? getMessage(reasonKey) : reason;

        const titleText = getMessage('NOTIF_LOBBY_CANCEL_TITLE') || 'KoalaSync — Episode Sync Failed';
        const messageText = getMessage('NOTIF_LOBBY_CANCEL_MSG', { reason: localizedReason }) || `Auto-sync cancelled: ${localizedReason}. You may need to manually sync.`;

        chrome.notifications.create(`episode_${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: titleText,
            message: messageText,
            priority: 1
        });
    });
}

function executeEpisodeLobby() {
    if (!episodeLobby) return;
    const title = episodeLobby.expectedTitle;
    if (currentRoom) {
        currentRoom.activeLobby = null;
        if (storageInitialized) chrome.storage.session.set({ currentRoom });
    }
    clearEpisodeLobbyState();
    addLog(`Episode lobby complete: Starting "${title}" via Force Sync`, 'success');

    isForceSyncInitiator = true;
    forceSyncAcks.clear();
    expectedAcksCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.length : 1;
    const deadline = Date.now() + FORCE_SYNC_TIMEOUT;
    const timestamp = Date.now();
    updateLastAction(EVENTS.FORCE_SYNC_PREPARE, 'You', timestamp);
    lastActionState.targetTime = 0.0;
    if (storageInitialized) chrome.storage.session.set({ lastActionState });
    chrome.storage.session.set({ 
        isForceSyncInitiator: true, 
        forceSyncAcks: [], 
        forceSyncDeadline: deadline,
        expectedAcksCount: expectedAcksCount
    });

    const syncPayload = { targetTime: 0.0, mediaTitle: title };
    localSeq++;
    chrome.storage.session.set({ localSeq });
    emit(EVENTS.FORCE_SYNC_PREPARE, { ...syncPayload, peerId, actionTimestamp: timestamp, seq: localSeq });
    routeToContent(EVENTS.FORCE_SYNC_PREPARE, { ...syncPayload, actionTimestamp: timestamp, seq: localSeq });

    forceSyncTimeout = setTimeout(() => {
        if (isForceSyncInitiator) {
            addLog('Force Sync (Episode): Timeout waiting for ACKs, executing anyway...', 'warn');
            executeForceSync();
        }
    }, FORCE_SYNC_TIMEOUT);
}

function checkEpisodeLobbyCompletion() {
    if (!episodeLobby || !currentRoom) return;
    if (episodeLobby.initiatorPeerId !== peerId) return;
    const peers = Array.isArray(currentRoom.peers) ? currentRoom.peers : [];
    // M-3: desynced peers (watching on their own) sit out the lobby — their content
    // script ignores EPISODE_LOBBY and never reports ready. Don't let them block
    // completion: count only peers who actually participate.
    const participatingPeerIds = new Set(peers
        .filter(candidate => !(typeof candidate === 'object' && candidate.desynced))
        .map(candidate => typeof candidate === 'object' ? candidate.peerId : candidate)
        .filter(Boolean));
    const readyParticipatingCount = episodeLobby.readyPeers
        .filter(candidate => participatingPeerIds.has(candidate)).length;
    if (participatingPeerIds.size > 0 && readyParticipatingCount >= participatingPeerIds.size) {
        executeEpisodeLobby();
    }
}

function checkEpisodeLobbyPeerDeparture() {
    if (!episodeLobby || !currentRoom) return;
    if (!Array.isArray(currentRoom.peers)) return;
    const remainingPeerIds = currentRoom.peers.map(p => typeof p === 'object' ? p.peerId : p);
    
    // If only we remain, cancel the lobby
    if (remainingPeerIds.length <= 1) {
        cancelEpisodeLobby('All other peers left');
        return;
    }

    // Filter readyPeers to only include peers still in the room
    episodeLobby.readyPeers = episodeLobby.readyPeers.filter(id => remainingPeerIds.includes(id));
    persistEpisodeLobby();
    broadcastLobbyUpdate();

    // Re-check if all remaining peers are now ready
    checkEpisodeLobbyCompletion();
}

function updateLastAction(action, senderId, timestamp = Date.now()) {
    lastActionState = {
        action,
        senderId,
        timestamp,
        acks: []
    };
    if (storageInitialized) chrome.storage.session.set({ lastActionState });
    chrome.runtime.sendMessage({ type: 'ACTION_UPDATE', state: lastActionState }).catch(() => {});
}

function routeToContent(action, payload) {
    const tabId = normalizeTabId(currentTabId);
    if (tabId === null) return Promise.resolve();
    const actionTimestamp = payload?.actionTimestamp || Date.now();
    const commandSenderId = payload?.senderId || null;
    const deliver = () => _routeToContentInternal(
        tabId,
        action,
        payload,
        actionTimestamp,
        commandSenderId,
        0
    );
    return enqueueContentCommand(deliver);
}

function enqueueContentCommand(deliver) {
    const queued = contentCommandQueue.catch(() => {}).then(deliver);
    contentCommandQueue = queued;
    return queued;
}

function getTabVideoState(tabId) {
    return new Promise((resolve) => {
        sendMessageToContentTab(tabId, { type: 'GET_VIDEO_STATE' }, (res) => {
            if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
                return;
            }
            resolve(res);
        });
    });
}

async function decorateVideoState(tabId, state) {
    if (!state || state.error) return state;
    try {
        const tab = await chrome.tabs.get(tabId);
        const frameUrl = state.url;
        let frameOrigin = null;
        try { frameOrigin = new URL(frameUrl).origin; } catch { /* unavailable */ }
        const topUrl = tab?.url || state.url;
        let platform = state.platform;
        try {
            if (new URL(topUrl).hostname.toLowerCase() === 'drive.google.com') platform = 'Google Drive';
        } catch { /* keep the content-reported platform */ }
        return {
            ...state,
            url: topUrl,
            pageTitle: tab?.title || state.pageTitle,
            frameOrigin,
            frameId: normalizeFrameId(currentTargetFrameId),
            inIframe: normalizeFrameId(currentTargetFrameId) !== 0 || state.inIframe === true,
            platform
        };
    } catch {
        return state;
    }
}

async function getReadyTabVideoState(tabId, expectedGeneration = targetActivationGeneration) {
    if (!isCurrentTargetIdentity(tabId, expectedGeneration)) {
        return { error: 'Target tab changed before video state could be read' };
    }
    let state = await getTabVideoState(tabId);
    // "No video" is a legitimate answer, not a broken injection: an anime or
    // Drive page has no video element until the viewer starts playback. Forcing
    // a reactivation for it made every poll of this function tear the content
    // script down and reinject it, which kept the target permanently activating.
    // Only an unreachable content script justifies recovery.
    if (!state || state.error) {
        // Distinguish "this frame is gone" from "this page has no video yet".
        // Only the former invalidates the election — and it also means there is
        // no content script left to talk to: switching the target away from a
        // frame tears its script down deliberately, so releasing the election
        // alone would point at an empty frame. That needs a real rebuild, which
        // cannot loop because only an unreachable script triggers it.
        if (isContentUnreachableError(state?.error)) releaseUnreachableFrameTarget(tabId);
        const activation = await refreshCurrentMediaTarget(tabId, { onlyIfTargetMoved: true });
        if (activation?.status !== 'ok' && activation?.status !== 'unchanged') {
            return { error: 'Target tab changed before content script recovery completed' };
        }
        // An unchanged target reports no generation of its own.
        const generation = Number.isInteger(activation.generation)
            ? activation.generation
            : targetActivationGeneration;
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!isCurrentTargetIdentity(tabId, generation)) {
            return { error: 'Target tab changed before video state could be read' };
        }
        state = await getTabVideoState(tabId);
        if (!isCurrentTargetIdentity(tabId, generation)) {
            return { error: 'Target tab changed while video state was being read' };
        }
    }
    if (currentTargetHasVideo !== true) refreshMediaFrameMonitors(tabId).catch(() => {});
    return decorateVideoState(tabId, state);
}

async function simulateRemoteSeek(delta, explicitTargetTime = null) {
    if (!currentTabId) return { status: 'no_tab' };
    const tabId = parseInt(currentTabId);
    if (isNaN(tabId)) return { status: 'no_tab' };

    const state = await getReadyTabVideoState(tabId);
    if (!state || state.error) return { status: 'error', message: state?.error || 'No video state' };
    if (!state.found || !Number.isFinite(state.currentTime)) return { status: 'no_video' };

    let targetTime = explicitTargetTime !== null ? explicitTargetTime : Math.max(0, state.currentTime + (delta || 0));
    if (Number.isFinite(state.duration) && state.duration > 0) {
        targetTime = Math.min(targetTime, Math.max(0, state.duration - 0.1));
    }

    const senderId = 'KoalaDev';
    const timestamp = Date.now();
    const payload = {
        senderId,
        actionTimestamp: timestamp,
        currentTime: targetTime,
        targetTime
    };

    addToHistory(EVENTS.SEEK, senderId);
    showNotification(senderId, EVENTS.SEEK);
    updateLastAction(EVENTS.SEEK, senderId, timestamp);
    lastActionState.targetTime = targetTime;
    if (storageInitialized) chrome.storage.session.set({ lastActionState });
    updateLocalPeerState(senderId, { currentTime: targetTime });
    routeToContent(EVENTS.SEEK, payload);

    return { status: 'ok', targetTime };
}

async function devRemoteToolsAllowed() {
    const data = await chrome.storage.local.get(['username']);
    return data.username === 'KoalaDev';
}

function shouldUsePageApiPlayer(url) {
    return typeof globalThis.koalaFindPageApiSeekProvider === 'function' &&
        !!globalThis.koalaFindPageApiSeekProvider(url);
}

function installPageApiPlayerBridge() {
    if (window.__koalaPageApiPlayerBridge?.activate) {
        window.__koalaPageApiPlayerBridge.activate();
        return;
    }

    let active = true;

    function currentMatch() {
        return typeof window.koalaFindPageApiSeekProvider === 'function'
            ? window.koalaFindPageApiSeekProvider(window.location.hostname)
            : null;
    }

    // Disney+ ("hive"/BAM) player: the real media player hangs off the
    // <disney-web-player> custom element as `.mediaPlayer`, exposing precise
    // seek(ms) and timeline.info (playhead/duration in ms).
    function disneyMediaPlayer() {
        const el = document.querySelector('disney-web-player');
        return el && el.mediaPlayer ? el.mediaPlayer : null;
    }

    function netflixPlayer() {
        const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
        const ids = videoPlayer?.getAllPlayerSessionIds?.();
        if (!Array.isArray(ids) || ids.length === 0) return null;
        // Netflix may expose preview/billboard sessions beside the actual title.
        // Prefer the watch session, retaining the single/first-session fallback
        // for older player builds whose identifiers used a different shape.
        const sessionId = ids.find(id => typeof id === 'string' && /(?:^|-)watch(?:-|$)/i.test(id))
            || ids.find(id => typeof id === 'string' && id.toLowerCase().includes('watch'))
            || ids[0];
        return sessionId ? videoPlayer.getVideoPlayerBySessionId?.(sessionId) : null;
    }

    async function applyPageApiAction(action, time) {
        const match = currentMatch();
        if (!match || !Array.isArray(match.actions) || !match.actions.includes(action)) {
            return { ok: false, reason: 'unsupported_action' };
        }

        try {
            if (match.provider === 'netflix') {
                const player = netflixPlayer();
                if (!player) return { ok: false, reason: 'player_unavailable' };
                if (action === 'seek') {
                    if (!Number.isFinite(time) || typeof player.seek !== 'function') {
                        return { ok: false, reason: 'seek_unavailable' };
                    }
                    await player.seek(Math.round(time * 1000));
                } else if (action === 'play') {
                    if (typeof player.play !== 'function') return { ok: false, reason: 'play_unavailable' };
                    await player.play();
                } else if (action === 'pause') {
                    if (typeof player.pause !== 'function') return { ok: false, reason: 'pause_unavailable' };
                    await player.pause();
                }
            } else if (match.provider === 'disney') {
                const mp = disneyMediaPlayer();
                if (action !== 'seek' || !Number.isFinite(time) || !mp || typeof mp.seek !== 'function') {
                    return { ok: false, reason: 'seek_unavailable' };
                }
                await mp.seek(Math.round(time * 1000));
            } else {
                return { ok: false, reason: 'provider_unavailable' };
            }
            return { ok: true };
        } catch (_error) {
            return { ok: false, reason: 'player_api_error' };
        }
    }

    function postResult(requestId, action, result) {
        window.postMessage({
            __koalaPageApiPlayer: 1,
            kind: 'result',
            requestId,
            action,
            ok: result?.ok === true,
            reason: result?.ok === true ? null : (result?.reason || 'player_api_error')
        }, '*');
    }

    function handleBridgeMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__koalaPageApiPlayer !== 1) return;
        if (data.kind === 'destroy') {
            destroy();
            return;
        }
        if (!active || data.kind !== 'command'
            || typeof data.requestId !== 'string'
            || !['play', 'pause', 'seek'].includes(data.action)) return;
        Promise.resolve(applyPageApiAction(data.action, data.time))
            .then(result => postResult(data.requestId, data.action, result))
            .catch(() => postResult(data.requestId, data.action, { ok: false, reason: 'player_api_error' }));
    }

    // Disney+'s <video> currentTime is blob-relative and its scrubber lags, so
    // the isolated-world content script can't read an accurate position. Push
    // the real playhead/duration (seconds) from the page's media player.
    const timelineInterval = setInterval(() => {
        if (!active) return;
        try {
            const match = currentMatch();
            if (!match || match.provider !== 'disney') return;
            const mp = disneyMediaPlayer();
            const info = mp && mp.timeline && mp.timeline.info;
            if (!info || typeof info.playheadPositionMs !== 'number' || typeof info.programDurationMs !== 'number') return;
            if (info.programDurationMs <= 0) return;
            window.postMessage({
                __koalaPlayerTime: 1,
                provider: 'disney',
                position: info.playheadPositionMs / 1000,
                duration: info.programDurationMs / 1000
            }, '*');
        } catch (_e) {
            // Ignore transient errors (player teardown / element swap).
        }
    }, 250);

    function destroy() {
        if (!active) return;
        active = false;
        clearInterval(timelineInterval);
        window.removeEventListener('message', handleBridgeMessage);
        delete window.__koalaPageApiPlayerBridge;
    }

    window.addEventListener('message', handleBridgeMessage);
    window.__koalaPageApiPlayerBridge = {
        activate() {
            active = true;
        },
        destroy
    };
}

function setPageApiPlayerEnabled(enabled) {
    window.KOALA_PAGE_API_PLAYER_ENABLED = enabled === true;
}

async function deactivateMediaFrameMonitors(tabId) {
    // Same reasoning as the injection: a rejected sweep must not leave a monitor
    // running in a deep frame, or the old target keeps reporting after a switch.
    const targets = [
        ...listMediaFrameScriptTargets(tabId),
        ...listKnownFrameIds(tabId)
            .filter(frameId => frameId !== 0)
            .map(frameId => ({ tabId, frameIds: [frameId] }))
    ];
    await Promise.all(targets.map(async target => {
        const documentId = target.documentIds?.[0];
        const frameId = target.frameIds?.[0];
        try {
            if (typeof documentId === 'string') {
                await chrome.tabs.sendMessage(
                    tabId,
                    { type: 'MEDIA_MONITOR_DEACTIVATE' },
                    { documentId }
                );
            } else if (Number.isInteger(frameId)) {
                await chrome.tabs.sendMessage(
                    tabId,
                    { type: 'MEDIA_MONITOR_DEACTIVATE' },
                    { frameId }
                );
            } else {
                await chrome.tabs.sendMessage(tabId, { type: 'MEDIA_MONITOR_DEACTIVATE' });
            }
        } catch {
            // Denied or already-navigated frames have no installed monitor.
        }
    }));
}

async function deactivateTargetTab(tabId, contentTarget = null, { deactivateMonitor = true } = {}) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) return;
    if (deactivateMonitor) {
        await deactivateMediaFrameMonitors(normalizedTabId);
    }
    const target = contentTarget
        || (normalizedTabId === normalizeTabId(currentTabId) ? currentContentTarget() : null)
        || (normalizedTabId === normalizeTabId(activeTargetActivation?.tabId)
            ? {
                frameId: activeTargetActivation.frameId,
                documentId: activeTargetActivation.documentId
            }
            : null)
        || { frameId: 0, documentId: null };
    resetAudioProcessingInTab(normalizedTabId, target);
    await sendMessageToFrame(
        normalizedTabId,
        target.frameId,
        { type: 'TARGET_DEACTIVATE' },
        null,
        target.documentId
    ).catch(() => {});
    await sendMessageToFrame(
        normalizedTabId,
        target.frameId,
        { type: 'CHAT_DESTROY' },
        null,
        target.documentId
    ).catch(() => {});
    // The overlay lives in the top document whenever the player is nested, so
    // clearing only the media frame would leave a stale chat behind on Drive.
    if (normalizeFrameId(target.frameId) !== 0) {
        await sendMessageToFrame(
            normalizedTabId,
            0,
            { type: 'CHAT_DESTROY' }
        ).catch(() => {});
    }
}

function createHostAccessRequiredError(access, requestAdded, cause) {
    const error = new Error(`Host access required for ${access.host || 'this website'}`);
    error.code = HOST_ACCESS_REQUIRED_STATUS;
    error.tabId = access.tab?.id || null;
    error.host = access.host || null;
    error.originPattern = access.originPattern || null;
    error.requestAdded = requestAdded === true;
    error.cause = cause;
    return error;
}

function injectionFailureResponse(error) {
    if (error?.code === HOST_ACCESS_REQUIRED_STATUS) {
        return {
            status: HOST_ACCESS_REQUIRED_STATUS,
            tabId: error.tabId,
            host: error.host,
            originPattern: error.originPattern,
            requestAdded: error.requestAdded === true
        };
    }
    return { status: 'error', message: error?.message || 'Script injection failed' };
}

function isMediaTargetNavigationError(error) {
    const message = String(error?.message || '');
    return error?.code === 'media_target_navigated'
        || message.includes('No document with id')
        || message.includes('No document with ID');
}

function isTargetActivationSuperseded(tabId, activationGeneration) {
    if (!Number.isInteger(activationGeneration)) return false;
    return targetActivationGeneration !== activationGeneration
        || activeTargetActivation?.generation !== activationGeneration
        || normalizeTabId(activeTargetActivation?.tabId) !== normalizeTabId(tabId);
}

function createTargetActivationSupersededError() {
    const error = new Error('Target activation was superseded');
    error.code = 'target_activation_superseded';
    return error;
}

const SCRIPT_INJECTION_TIMEOUT_MS = 5000;

/**
 * chrome.scripting.executeScript can stay pending indefinitely when a target
 * frame is busy or navigating — an embedded player or ad frame is enough, and
 * an allFrames call only needs one of them. An activation that never settles
 * leaves the popup on "activating" forever, so every injection is bounded.
 */
function executeScriptWithTimeout(options, timeoutMs = SCRIPT_INJECTION_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return chrome.scripting.executeScript(options);
    }
    let timeoutId = null;
    const label = Array.isArray(options?.files) && options.files.length > 0
        ? options.files.join(', ')
        : 'function injection';
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const error = new Error(`Script injection timed out after ${timeoutMs}ms (${label})`);
            error.code = 'script_injection_timeout';
            reject(error);
        }, timeoutMs);
    });
    const scriptPromise = chrome.scripting.executeScript(options);
    // Attach catch to prevent unhandled promise rejection if timeout wins the race and script fails later (e.g. on tab close)
    scriptPromise.catch(() => {});
    return Promise.race([
        scriptPromise,
        timeout
    ]).finally(() => {
        if (timeoutId !== null) clearTimeout(timeoutId);
    });
}

/**
 * Runs as a tiny all-frame beacon before the heavier monitor injection.
 * Chromium can reject an allFrames result wholesale when one unrelated ad
 * frame disappears mid-sweep, even though stable frames already executed the
 * function. Those stable frames announce their ids through the sender metadata,
 * letting the next step address them individually without webNavigation.
 */
async function announcePotentialMediaFrame() {
    let relevant = false;
    try {
        const identity = `${window.location.href} ${window.name || ''}`;
        relevant = !!document.querySelector('video, iframe, frame')
            || /player|video|stream|watch|embed|media|xfp/i.test(identity);
    } catch { /* inaccessible or already-detached document */ }
    if (!relevant) return false;
    try {
        await chrome.runtime.sendMessage({ type: 'MEDIA_FRAME_DISCOVERED' });
    } catch { /* extension context or document disappeared */ }
    return true;
}

async function injectMediaFrameMonitors(tabId, contentTarget) {
    // The sweep is best effort; the known frames are addressed individually so a
    // rejected sweep cannot leave the deep player frame without a monitor — and
    // therefore without any way to report itself later.
    try {
        const discoveries = await executeScriptWithTimeout({
            target: { tabId, allFrames: true },
            func: announcePotentialMediaFrame
        }, 750);
        for (const entry of discoveries || []) {
            if (entry?.result === true) rememberFrameId(tabId, entry.frameId);
        }
    } catch {
        // Stable frames still announce themselves if a disappearing ad frame
        // makes Chromium reject the aggregate allFrames result.
    }
    // Give those sender messages one task boundary to update the registry before
    // taking the snapshot used for individual monitor injections below.
    await new Promise(resolve => setTimeout(resolve, 0));
    const targets = [
        ...listMediaFrameScriptTargets(tabId),
        ...listKnownFrameIds(tabId)
            .filter(frameId => frameId !== 0)
            .map(frameId => ({ tabId, frameIds: [frameId] }))
    ];
    let injectedCount = 0;
    await Promise.all(targets.map(async target => {
        try {
            await executeScriptWithTimeout({
                target,
                files: ['media-frame-monitor.js']
            }, 750);
            injectedCount++;
        } catch {
            // One denied widget frame must not block the selected player.
        }
    }));
    if (injectedCount > 0) return;

    const fallbackTargets = [{ tabId }, contentTarget.scriptTarget];
    const seen = new Set();
    for (const target of fallbackTargets) {
        const key = JSON.stringify(target);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
            await executeScriptWithTimeout({
                target,
                files: ['media-frame-monitor.js']
            }, 750);
            injectedCount++;
        } catch {
            // Main injection below reports a real selected-target failure.
        }
    }
}

async function injectContentScript(tabId, {
    requestHostAccess = true,
    navigationRetries = 2,
    activationGeneration = null
} = {}) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) throw new Error('Invalid tab ID');
    tabId = normalizedTabId;
    let needsPageApiPlayer = false;
    let pageApiPlayerReady = false;
    let access = null;
    let contentTarget = {
        frameId: 0,
        documentId: null,
        frameUrl: null,
        hasVideo: false,
        scriptTarget: { tabId }
    };
    try {
        access = await inspectTabHostAccess(chrome, tabId);
        const url = access.url || '';
        needsPageApiPlayer = shouldUsePageApiPlayer(url);
        contentTarget = await resolveMediaContentTarget(chrome, tabId, {
            knownFrameIds: listKnownFrameIds(tabId)
        });
        // The probe reached these frames; remember them before anything is
        // injected. Waiting for a content script to message us first would leave
        // the registry empty exactly when it is needed most — the first
        // activation, before any script exists to report itself.
        refreshFrameIds(tabId, contentTarget.discoveredFrameIds);
        if (!isTargetActivationSuperseded(tabId, activationGeneration)
            && activeTargetActivation?.tabId === tabId) {
            activeTargetActivation.frameId = contentTarget.frameId;
            activeTargetActivation.documentId = contentTarget.documentId;
        }
    } catch (error) {
        if (error?.code === MEDIA_FRAME_ACCESS_REQUIRED) {
            // addHostAccessRequest() only grants the tab's top origin. Embedded
            // player origins must be requested explicitly by the popup.
            const requestAdded = false;
            throw createHostAccessRequiredError({
                tab: { id: tabId },
                host: error.host,
                originPattern: error.originPattern
            }, requestAdded, error);
        }
        // MEDIA_FRAME_AMBIGUOUS is no longer fatal: the resolver falls back to
        // the top frame and the monitor promotes the player that starts playing.
        addLog(`Media frame probe fell back to the top frame: ${error.message}`, 'warn');
    }

    const scriptTarget = contentTarget.scriptTarget;
    const selectedDocumentId = contentTarget.documentId;

    try {
        if (isTargetActivationSuperseded(tabId, activationGeneration)) {
            throw createTargetActivationSupersededError();
        }
        await injectMediaFrameMonitors(tabId, contentTarget);
        if (isTargetActivationSuperseded(tabId, activationGeneration)) {
            const replacementTabId = normalizeTabId(activeTargetActivation?.tabId);
            if (replacementTabId !== tabId) {
                await deactivateMediaFrameMonitors(tabId);
            }
            throw createTargetActivationSupersededError();
        }
        if (needsPageApiPlayer) {
            try {
                await executeScriptWithTimeout({
                    // Netflix/Disney expose their private player on the top page.
                    // Keep this bridge independent of iframe election so a nested
                    // player refactor can never redirect it into the wrong realm.
                    target: { tabId },
                    world: 'MAIN',
                    files: ['page-api-seek-overrides.js']
                });
                await executeScriptWithTimeout({
                    target: { tabId },
                    world: 'MAIN',
                    func: installPageApiPlayerBridge
                });
                pageApiPlayerReady = true;
            } catch (err) {
                addLog(`Page API player bridge injection failed: ${err.message}`, 'warn');
            }
        }

        await executeScriptWithTimeout({
            target: scriptTarget,
            files: ['page-api-seek-overrides.js']
        });
        await executeScriptWithTimeout({
            target: scriptTarget,
            func: setPageApiPlayerEnabled,
            args: [pageApiPlayerReady]
        });
        // The chat overlay is standalone page UI and carries its own runtime
        // message listener, so it is installed in the top document regardless of
        // where the player lives. Only the playback controller goes into the
        // selected media frame.
        let injectionResults;
        if (contentTarget.frameId === 0) {
            injectionResults = await executeScriptWithTimeout({
                target: scriptTarget,
                files: ['chat-format.js', 'chat-overlay.js', 'content.js']
            });
        } else {
            try {
                await executeScriptWithTimeout({
                    target: { tabId, frameIds: [0] },
                    files: ['chat-format.js', 'chat-overlay.js']
                });
            } catch (err) {
                addLog(`Chat overlay injection failed in the top frame: ${err.message}`, 'warn');
            }
            // A pre-3.1.3 build may have left an overlay inside the player.
            await sendMessageToFrame(
                tabId,
                contentTarget.frameId,
                { type: 'CHAT_DESTROY' },
                null,
                contentTarget.documentId
            ).catch(() => {});
            injectionResults = await executeScriptWithTimeout({
                target: scriptTarget,
                files: ['content.js']
            });
        }
        const frameResult = Array.isArray(injectionResults)
            ? injectionResults.find(result => normalizeFrameId(result?.frameId) === contentTarget.frameId)
            : null;
        if (selectedDocumentId && frameResult?.documentId !== selectedDocumentId) {
            const navigationError = new Error('Selected media document navigated during injection');
            navigationError.code = 'media_target_navigated';
            throw navigationError;
        }
        contentTarget.documentId = typeof frameResult?.documentId === 'string'
            ? frameResult.documentId
            : contentTarget.documentId;
        if (!isTargetActivationSuperseded(tabId, activationGeneration)
            && activeTargetActivation?.tabId === tabId) {
            activeTargetActivation.frameId = contentTarget.frameId;
            activeTargetActivation.documentId = contentTarget.documentId;
        }
        return contentTarget;
    } catch (error) {
        if (error?.code === 'target_activation_superseded') {
            try { error.contentTarget = contentTarget; } catch { /* immutable browser error */ }
            throw error;
        }
        // Name the frame the injection was aimed at. Without it every failure
        // reads the same in the log and there is no way to tell a denied player
        // frame from a document that navigated mid-injection.
        addLog(
            `Content injection failed in frame ${contentTarget.frameId}`
            + `${contentTarget.frameUrl ? ` (${contentTarget.frameUrl})` : ''}: ${error?.message}`,
            'warn'
        );
        if (navigationRetries > 0 && isMediaTargetNavigationError(error)) {
            return injectContentScript(tabId, {
                requestHostAccess,
                navigationRetries: navigationRetries - 1,
                activationGeneration
            });
        }
        try { error.contentTarget = contentTarget; } catch { /* immutable browser error */ }
        // A temporary activeTab grant is intentionally allowed to win: even if
        // permissions.contains() reports false, a successful injection above is
        // valid. Only convert an actual injection failure into a host-access UX.
        try {
            // The tab may have crossed origins between the initial permission
            // check and executeScript(). Always report/request the current URL.
            access = await inspectTabHostAccess(chrome, tabId);
        } catch (_inspectionError) {
            access = null;
        }
        const accessIsMissing = access?.granted === false
            || (access?.granted === null && isHostAccessError(error));
        if (access?.originPattern && accessIsMissing) {
            const requestAdded = requestHostAccess
                ? await addTabHostAccessRequest(chrome, tabId, access.originPattern)
                : false;
            throw createHostAccessRequiredError(access, requestAdded, error);
        }
        throw error;
    }
}

let pendingTargetMutation = Promise.resolve();

const PENDING_TARGET_KEYS = [
    'pendingTargetTabId',
    'pendingTargetTabTitle',
    'pendingTargetHost',
    'pendingTargetOriginPattern',
    'pendingTargetRequestId'
];

function createPendingTargetRequestId() {
    return globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyPendingTargetState() {
    return {
        pendingTargetTabId: null,
        pendingTargetTabTitle: null,
        pendingTargetHost: null,
        pendingTargetOriginPattern: null,
        pendingTargetRequestId: null
    };
}

function mutatePendingTarget(operation) {
    const result = pendingTargetMutation.catch(() => {}).then(operation);
    pendingTargetMutation = result.catch(() => {});
    return result;
}

async function readPendingTarget() {
    return mutatePendingTarget(async () => {
        const stored = await chrome.storage.session.get(PENDING_TARGET_KEYS);
        const tabId = normalizeTabId(stored.pendingTargetTabId);
        const originPattern = typeof stored.pendingTargetOriginPattern === 'string'
            && stored.pendingTargetOriginPattern.length > 0
            ? stored.pendingTargetOriginPattern
            : null;

        if (tabId === null || originPattern === null) {
            if (Object.values(stored).some(value => value !== null && value !== undefined)) {
                if (tabId !== null) {
                    await removeTabHostAccessRequest(chrome, tabId, originPattern);
                }
                await chrome.storage.session.set(emptyPendingTargetState());
            }
            return null;
        }

        const requestId = typeof stored.pendingTargetRequestId === 'string'
            && stored.pendingTargetRequestId.length > 0
            ? stored.pendingTargetRequestId
            : createPendingTargetRequestId();
        if (stored.pendingTargetRequestId !== requestId) {
            await chrome.storage.session.set({ pendingTargetRequestId: requestId });
        }

        return {
            tabId,
            tabTitle: typeof stored.pendingTargetTabTitle === 'string'
                ? stored.pendingTargetTabTitle
                : null,
            host: typeof stored.pendingTargetHost === 'string'
                ? stored.pendingTargetHost
                : null,
            originPattern,
            requestId
        };
    });
}

async function rememberPendingTarget(tabId, tabTitle, error, expectedGeneration) {
    return mutatePendingTarget(async () => {
        if (targetActivationGeneration !== expectedGeneration) return null;
        const previous = await chrome.storage.session.get(PENDING_TARGET_KEYS);
        const previousTabId = normalizeTabId(previous.pendingTargetTabId);
        const nextOriginPattern = error?.originPattern || null;
        if (previousTabId !== null && (
            previousTabId !== tabId
            || previous.pendingTargetOriginPattern !== nextOriginPattern
        )) {
            await removeTabHostAccessRequest(
                chrome,
                previousTabId,
                previous.pendingTargetOriginPattern || null
            );
        }
        if (targetActivationGeneration !== expectedGeneration) return null;
        const requestId = previousTabId === tabId
            && previous.pendingTargetOriginPattern === nextOriginPattern
            && typeof previous.pendingTargetRequestId === 'string'
            && previous.pendingTargetRequestId.length > 0
            ? previous.pendingTargetRequestId
            : createPendingTargetRequestId();
        await chrome.storage.session.set({
            pendingTargetTabId: tabId,
            pendingTargetTabTitle: typeof tabTitle === 'string' ? tabTitle : null,
            pendingTargetHost: error?.host || null,
            pendingTargetOriginPattern: nextOriginPattern,
            pendingTargetRequestId: requestId
        });
        if (targetActivationGeneration !== expectedGeneration) {
            const current = await chrome.storage.session.get(PENDING_TARGET_KEYS);
            if (current.pendingTargetRequestId === requestId) {
                await removeTabHostAccessRequest(chrome, tabId, nextOriginPattern);
                await chrome.storage.session.set(emptyPendingTargetState());
            }
            return null;
        }
        return {
            tabId,
            tabTitle: typeof tabTitle === 'string' ? tabTitle : null,
            host: error?.host || null,
            originPattern: nextOriginPattern,
            requestId
        };
    });
}

async function clearPendingTarget({ expectedRequestId = null, expectedTabId = null } = {}) {
    return mutatePendingTarget(async () => {
        const pending = await chrome.storage.session.get(PENDING_TARGET_KEYS);
        const pendingTabId = normalizeTabId(pending.pendingTargetTabId);
        if (expectedRequestId !== null && pending.pendingTargetRequestId !== expectedRequestId) {
            return false;
        }
        if (expectedTabId !== null && pendingTabId !== normalizeTabId(expectedTabId)) {
            return false;
        }
        if (pendingTabId !== null) {
            await removeTabHostAccessRequest(
                chrome,
                pendingTabId,
                pending.pendingTargetOriginPattern || null
            );
        }
        await chrome.storage.session.set(emptyPendingTargetState());
        return true;
    });
}

const ACTIVATION_DEADLINE_MS = 30000;

/**
 * Last line of defence for the "activating" state.
 *
 * Every known way an activation can stall is bounded by now, but a browser call
 * that never settles would still pin activeTargetActivation and leave the popup
 * spinning with nothing in the log. Past the deadline the attempt is declared
 * dead so the selection can report a real error and be retried deliberately.
 */
function expireStuckActivation() {
    const startedAt = activeTargetActivation?.startedAt;
    if (!Number.isFinite(startedAt) || Date.now() - startedAt < ACTIVATION_DEADLINE_MS) {
        return false;
    }
    const stalledTabId = normalizeTabId(activeTargetActivation.tabId);
    addLog(`Target activation for tab ${stalledTabId} exceeded ${ACTIVATION_DEADLINE_MS}ms; abandoning it`, 'warn');
    activeTargetActivation = null;
    if (stalledTabId !== null && normalizeTabId(userSelectedTabId) === stalledTabId) {
        userSelectionErrorTabId = stalledTabId;
        userSelectionErrorMessage = 'The page never finished responding to script injection';
        chrome.storage.session.set({
            selectionErrorTabId: userSelectionErrorTabId,
            selectionErrorMessage: userSelectionErrorMessage
        }).catch(() => {});
    }
    return true;
}

async function rememberUserSelection(tabId, tabTitle) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) return false;
    userSelectedTabId = normalizedTabId;
    userSelectedTabTitle = typeof tabTitle === 'string' ? tabTitle : null;
    userSelectionErrorTabId = null;
    userSelectionErrorMessage = null;
    await chrome.storage.session.set({
        selectedTabId: userSelectedTabId,
        selectedTabTitle: userSelectedTabTitle,
        selectionErrorTabId: null,
        selectionErrorMessage: null
    });
    return true;
}

/**
 * Records why a selection could not be activated, without discarding it. The
 * popup keeps showing the chosen tab and can explain the problem or offer the
 * host-access grant; nothing retries on its own.
 */
async function recordUserSelectionFailure(tabId, error) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null || normalizeTabId(userSelectedTabId) !== normalizedTabId) {
        return false;
    }
    userSelectionErrorTabId = normalizedTabId;
    userSelectionErrorMessage = error?.code === HOST_ACCESS_REQUIRED_STATUS
        ? null
        : (error?.message || 'Script injection failed');
    await chrome.storage.session.set({
        selectionErrorTabId: userSelectionErrorTabId,
        selectionErrorMessage: userSelectionErrorMessage
    });
    return true;
}

async function clearUserSelection(expectedTabId = null) {
    if (expectedTabId !== null
        && normalizeTabId(userSelectedTabId) !== normalizeTabId(expectedTabId)) {
        return false;
    }
    resetUserSelectionState();
    await chrome.storage.session.set({
        selectedTabId: null,
        selectedTabTitle: null,
        selectionErrorTabId: null,
        selectionErrorMessage: null
    });
    return true;
}

function resetUserSelectionState() {
    userSelectedTabId = null;
    userSelectedTabTitle = null;
    userSelectionErrorTabId = null;
    userSelectionErrorMessage = null;
}

async function activateTargetTab(tabId, tabTitle, {
    requestHostAccess = true,
    expectedGeneration = null,
    expectedCurrentTabId = null
} = {}) {
    const selectedTabId = normalizeTabId(tabId);
    if (selectedTabId === null) {
        return { status: 'invalid_tab' };
    }
    if (expectedGeneration !== null && targetActivationGeneration !== expectedGeneration) {
        return { status: 'superseded' };
    }
    if (expectedCurrentTabId !== null
        && normalizeTabId(currentTabId) !== normalizeTabId(expectedCurrentTabId)) {
        return { status: 'superseded' };
    }

    completeForceSyncBeforeTargetChange(selectedTabId);
    const activationGeneration = ++targetActivationGeneration;
    activeTargetActivation = {
        generation: activationGeneration,
        tabId: selectedTabId,
        startedAt: Date.now()
    };
    const previousTabId = normalizeTabId(currentTabId);
    const previousContentTarget = currentContentTarget();
    let injectedContentTarget = { frameId: 0, documentId: null, hasVideo: false };

    try {
        if (previousTabId && previousTabId !== selectedTabId) {
            await deactivateTargetTab(previousTabId);
        }
        if (activationGeneration !== targetActivationGeneration) {
            return { status: 'superseded' };
        }
        try {
            injectedContentTarget = await injectContentScript(selectedTabId, {
                requestHostAccess,
                activationGeneration
            });
        } catch (error) {
            if (activationGeneration !== targetActivationGeneration) {
                if (normalizeTabId(currentTabId) !== selectedTabId) {
                    await deactivateTargetTab(selectedTabId, error?.contentTarget || injectedContentTarget);
                }
                if (error?.code === HOST_ACCESS_REQUIRED_STATUS
                    && error.requestAdded === true
                    && activeTargetActivation?.tabId !== selectedTabId) {
                    await removeTabHostAccessRequest(
                        chrome,
                        selectedTabId,
                        error.originPattern || null
                    );
                }
                return { status: 'superseded' };
            }
            if (previousTabId === selectedTabId
                && expectedCurrentTabId === selectedTabId
                && isMediaTargetNavigationError(error)) {
                addLog('Media document changed during refresh; keeping the previous target until navigation completes', 'warn');
                throw error;
            }
            currentTabId = null;
            currentTabTitle = null;
            clearCurrentContentTarget();
            lastContentHeartbeatAt = null;
            if (currentRoom) roomIdleSince = Date.now();
            const failedContentTarget = error?.contentTarget || injectedContentTarget;
            await deactivateTargetTab(selectedTabId, failedContentTarget);
            if (previousTabId && (previousTabId !== selectedTabId
                || !sameContentTarget(previousContentTarget, failedContentTarget))) {
                await deactivateTargetTab(previousTabId, previousContentTarget);
            }
            await chrome.storage.session.set({
                currentTabId: null,
                currentTabTitle: null,
                currentTargetFrameId: 0,
                currentTargetDocumentId: null,
                currentTargetHasVideo: false,
                roomIdleSince,
                lastContentHeartbeatAt: null
            });
            if (activationGeneration !== targetActivationGeneration) {
                return { status: 'superseded' };
            }
            updateBadgeStatus();

            if (error?.code === HOST_ACCESS_REQUIRED_STATUS) {
                const pending = await rememberPendingTarget(
                    selectedTabId,
                    tabTitle,
                    error,
                    activationGeneration
                );
                if (!pending || activationGeneration !== targetActivationGeneration) {
                    return { status: 'superseded' };
                }
                chrome.runtime.sendMessage({
                    type: 'TARGET_TAB_ACCESS_REQUIRED',
                    requestId: pending.requestId,
                    ...injectionFailureResponse(error)
                }).catch(() => {});
            } else {
                await clearPendingTarget();
                if (activationGeneration !== targetActivationGeneration) {
                    return { status: 'superseded' };
                }
            }
            throw error;
        }

        if (activationGeneration !== targetActivationGeneration) {
            if (currentTabId !== selectedTabId) await deactivateTargetTab(selectedTabId, injectedContentTarget);
            return { status: 'superseded' };
        }

        await applyAudioSettingsToTab(selectedTabId, injectedContentTarget);
        if (activationGeneration !== targetActivationGeneration) {
            if (currentTabId !== selectedTabId) await deactivateTargetTab(selectedTabId, injectedContentTarget);
            return { status: 'superseded' };
        }
        await removeTabHostAccessRequest(chrome, selectedTabId);
        if (activationGeneration !== targetActivationGeneration) {
            if (currentTabId !== selectedTabId) await deactivateTargetTab(selectedTabId, injectedContentTarget);
            return { status: 'superseded' };
        }
        await clearPendingTarget();
        if (activationGeneration !== targetActivationGeneration) {
            if (currentTabId !== selectedTabId) await deactivateTargetTab(selectedTabId, injectedContentTarget);
            return { status: 'superseded' };
        }
        if (previousTabId === selectedTabId
            && !sameContentTarget(previousContentTarget, injectedContentTarget)
            && normalizeFrameId(previousContentTarget?.frameId) !== 0) {
            // A frame switch inside the same tab must not tear down the top
            // frame. It hosts the chat overlay, answers status queries, and is
            // what the frame election falls back to when a player frame dies —
            // destroying it is why chat delivery failed after promotion and why
            // that fallback pointed at an empty frame.
            await deactivateTargetTab(previousTabId, previousContentTarget, { deactivateMonitor: false });
        }
        currentTabId = selectedTabId;
        currentTabTitle = typeof tabTitle === 'string' ? tabTitle : null;
        // Activation can also start from the pending host-access flow, so keep
        // the user-facing selection in step with what actually got injected.
        await rememberUserSelection(selectedTabId, currentTabTitle);
        currentTargetFrameId = normalizeFrameId(injectedContentTarget.frameId);
        currentTargetDocumentId = typeof injectedContentTarget.documentId === 'string'
            ? injectedContentTarget.documentId
            : null;
        currentTargetHasVideo = injectedContentTarget.hasVideo === true;
        if (currentTargetHasVideo) stopMediaDiscoveryPoll();
        else startMediaDiscoveryPoll(selectedTabId);
        lastContentHeartbeatAt = null;
        if (currentRoom) roomIdleSince = Date.now();
        await chrome.storage.session.set({
            currentTabId,
            currentTabTitle,
            currentTargetFrameId,
            currentTargetDocumentId,
            currentTargetHasVideo,
            roomIdleSince,
            lastContentHeartbeatAt
        });
        if (activationGeneration !== targetActivationGeneration) {
            return { status: 'superseded' };
        }
        updateBadgeStatus();
        if (currentTargetHasVideo) {
            await tryApplyPendingCanonicalMediaState();
        }
        return {
            status: 'ok',
            tabId: selectedTabId,
            frameId: currentTargetFrameId,
            documentId: currentTargetDocumentId,
            hasVideo: currentTargetHasVideo,
            generation: activationGeneration
        };
    } finally {
        if (activeTargetActivation?.generation === activationGeneration) {
            activeTargetActivation = null;
        }
    }
}

async function reactivateCurrentTarget(tabId, { expectedGeneration = targetActivationGeneration } = {}) {
    const selectedTabId = normalizeTabId(tabId);
    if (selectedTabId === null || !isCurrentTargetIdentity(selectedTabId, expectedGeneration)) {
        return { status: 'superseded' };
    }
    if (activeTargetActivation && activeTargetActivation.tabId !== selectedTabId) {
        return { status: 'superseded' };
    }
    return activateTargetTab(selectedTabId, currentTabTitle, {
        expectedGeneration,
        expectedCurrentTabId: selectedTabId
    });
}

/**
 * Cheap pre-check for lifecycle-driven refreshes.
 *
 * Reactivation tears down and re-injects the content script, which interrupts
 * playback and audio routing. That price is only worth paying when the selected
 * frame or document actually moved — not for the constant DOM churn that pages
 * like Drive and YouTube produce while simply playing.
 */
async function selectedMediaTargetMoved(tabId) {
    let resolved;
    try {
        resolved = await resolveMediaContentTarget(chrome, tabId, {
            attempts: 1,
            knownFrameIds: listKnownFrameIds(tabId)
        });
        refreshFrameIds(tabId, resolved.discoveredFrameIds);
    } catch {
        // An access-required error must reach the full activation path so the
        // popup can surface it.
        return true;
    }
    if (normalizeTabId(currentTabId) !== normalizeTabId(tabId)) return false;
    // An inconclusive probe is not a reason to move when on top frame.
    // However, if a nested frame was elected (currentTargetFrameId !== 0) and is now
    // no longer an accessible candidate with video, the target has vacated.
    if (resolved.hasVideo !== true) {
        refreshMediaFrameMonitors(tabId).catch(() => {});
        if (normalizeFrameId(currentTargetFrameId) !== 0 || currentTargetHasVideo === true) {
            return true;
        }
        return false;
    }
    // A disappearing ad frame can make the parent-visibility handshake
    // inconclusive while still leaving one hidden mirror as the only video
    // candidate. Never rebuild toward an unconfirmed nested frame: its monitor
    // or a later clean probe will announce it again if it is genuinely visible.
    if (normalizeFrameId(resolved.frameId) !== 0 && resolved.visibilityConfirmed !== true) {
        refreshMediaFrameMonitors(tabId).catch(() => {});
        return false;
    }
    if (currentTargetHasVideo !== true) return true;
    return normalizeFrameId(resolved.frameId) !== normalizeFrameId(currentTargetFrameId)
        || (typeof resolved.documentId === 'string'
            && typeof currentTargetDocumentId === 'string'
            && resolved.documentId !== currentTargetDocumentId);
}

// Reinjection is the exception, not the default. Every caller that merely
// wants the target confirmed gets the guarded path; only a genuinely
// unreachable content script or an explicit request forces a rebuild.
function refreshCurrentMediaTarget(tabId, { queueIfRunning = false, onlyIfTargetMoved = true } = {}) {
    const selectedTabId = normalizeTabId(tabId);
    if (selectedTabId === null || normalizeTabId(currentTabId) !== selectedTabId) {
        return Promise.resolve({ status: 'superseded' });
    }
    if (mediaTargetRefreshTask && mediaTargetRefreshTabId === selectedTabId) {
        if (queueIfRunning) mediaTargetRefreshDirty = true;
        return mediaTargetRefreshTask;
    }
    if (activeTargetActivation?.tabId === selectedTabId) {
        if (!expireStuckActivation()) {
            return Promise.resolve({ status: 'activation_in_progress' });
        }
    }

    const task = (async () => {
        let result;
        let pass = 0;
        do {
            pass++;
            mediaTargetRefreshDirty = false;
            if (onlyIfTargetMoved && !(await selectedMediaTargetMoved(selectedTabId))) {
                result = { status: 'unchanged' };
                break;
            }
            const expectedGeneration = targetActivationGeneration;
            result = await reactivateCurrentTarget(selectedTabId, { expectedGeneration });
            // Let lifecycle messages queued during the final probe/injection
            // mark the refresh dirty before deciding whether a trailing pass is needed.
            await new Promise(resolve => setTimeout(resolve, 0));
        } while (mediaTargetRefreshDirty
            && pass < 2
            && normalizeTabId(currentTabId) === selectedTabId);
        return result;
    })();
    let wrappedTask;
    mediaTargetRefreshTabId = selectedTabId;
    wrappedTask = task.finally(() => {
        if (mediaTargetRefreshTask !== wrappedTask) return;
        const needsFollowup = mediaTargetRefreshDirty
            && normalizeTabId(currentTabId) === selectedTabId;
        mediaTargetRefreshTask = null;
        mediaTargetRefreshTabId = null;
        mediaTargetRefreshDirty = false;
        if (needsFollowup && mediaTargetRefreshFollowupTimer === null) {
            mediaTargetRefreshFollowupTimer = setTimeout(() => {
                mediaTargetRefreshFollowupTimer = null;
                refreshCurrentMediaTarget(selectedTabId, {
                    queueIfRunning: true,
                    onlyIfTargetMoved
                }).catch(() => {});
            }, 250);
        }
    });
    mediaTargetRefreshTask = wrappedTask;
    return wrappedTask;
}

async function waitForMediaTargetRefresh(sender) {
    const senderTabId = normalizeTabId(sender?.tab?.id);
    if (senderTabId === null
        || mediaTargetRefreshTabId !== senderTabId
        || !mediaTargetRefreshTask) {
        return;
    }
    await mediaTargetRefreshTask.catch(() => {});
}

async function retryPendingTarget({ expectedRequestId = null, requireGrantedAccess = false } = {}) {
    let pending = await readPendingTarget();
    if (!pending || (expectedRequestId !== null && pending.requestId !== expectedRequestId)) {
        return null;
    }
    if (activeTargetActivation && activeTargetActivation.tabId !== pending.tabId) {
        return { status: 'superseded' };
    }

    if (requireGrantedAccess) {
        let granted;
        try {
            granted = await chrome.permissions.contains({
                origins: [pending.originPattern]
            });
        } catch {
            return { status: 'permission_not_granted' };
        }
        if (granted !== true) {
            return { status: 'permission_not_granted' };
        }
        pending = await readPendingTarget();
        if (!pending || pending.requestId !== expectedRequestId) {
            return { status: 'superseded' };
        }
    }

    try {
        const expectedGeneration = targetActivationGeneration;
        const response = await activateTargetTab(pending.tabId, pending.tabTitle, {
            requestHostAccess: false,
            expectedGeneration
        });
        if (response.status === 'ok') {
            addLog(`Website access granted; selected tab ${pending.tabId}`, 'success');
            chrome.runtime.sendMessage({
                type: 'TARGET_TAB_READY',
                tabId: pending.tabId,
                requestId: pending.requestId
            }).catch(() => {});
        }
        return response;
    } catch (error) {
        if (error?.code !== HOST_ACCESS_REQUIRED_STATUS) {
            await clearPendingTarget({
                expectedRequestId: pending.requestId,
                expectedTabId: pending.tabId
            });
            addLog(`Pending tab activation failed: ${error.message}`, 'warn');
        }
        return injectionFailureResponse(error);
    }
}

if (chrome.permissions?.onAdded?.addListener) {
    chrome.permissions.onAdded.addListener((addedPermissions) => {
        ensureState().then(async () => {
            const pending = await readPendingTarget();
            if (!pending) return;
            const addedOrigins = Array.isArray(addedPermissions?.origins)
                ? addedPermissions.origins
                : [];
            if (!addedOrigins.includes(pending.originPattern) && !addedOrigins.includes('<all_urls>')) {
                return;
            }
            await retryPendingTarget({
                expectedRequestId: pending.requestId,
                requireGrantedAccess: true
            });
        }).catch(error => addLog(`Website access retry failed: ${error.message}`, 'warn'));
    });
}

if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((removedTabId) => {
        ensureState().then(async () => {
            const tabId = normalizeTabId(removedTabId);
            if (tabId === null) return;
            const pending = await readPendingTarget();
            const isCurrent = normalizeTabId(currentTabId) === tabId;
            const isPending = pending?.tabId === tabId;
            const isActivating = activeTargetActivation?.tabId === tabId;
            forgetFrameIds(tabId);
            lastMonitorRefreshByTab.delete(tabId);
            const pendingMonitorTimer = pendingMonitorRefreshByTab.get(tabId);
            if (pendingMonitorTimer !== undefined) {
                clearTimeout(pendingMonitorTimer);
                pendingMonitorRefreshByTab.delete(tabId);
            }
            const isSelected = normalizeTabId(userSelectedTabId) === tabId;
            if (isSelected) await clearUserSelection(tabId);
            if (!isCurrent && !isPending && !isActivating) return;

            const hasReplacementActivation = activeTargetActivation
                && activeTargetActivation.tabId !== tabId;
            if (isCurrent) completeForceSyncBeforeTargetChange(null);
            if (isActivating || (isCurrent && !hasReplacementActivation)) {
                invalidateTargetActivations();
            }
            if (isCurrent) {
                currentTabId = null;
                currentTabTitle = null;
                clearCurrentContentTarget();
                lastContentHeartbeatAt = null;
                if (currentRoom) roomIdleSince = Date.now();
            }
            if (isPending) {
                await clearPendingTarget({
                    expectedRequestId: pending.requestId,
                    expectedTabId: tabId
                });
            }
            await chrome.storage.session.set({
                currentTabId,
                currentTabTitle,
                currentTargetFrameId,
                currentTargetDocumentId,
                currentTargetHasVideo,
                roomIdleSince,
                lastContentHeartbeatAt
            });
            updateBadgeStatus();
            chrome.runtime.sendMessage({ type: 'TARGET_TAB_CLEARED', tabId }).catch(() => {});
            if (isCurrent) {
                addLog('Target tab closed.', 'warn');
                if (currentRoom) {
                    const roomAtClose = currentRoom;
                    getSettings().then(settings => {
                        if (currentRoom !== roomAtClose) return;
                        emit(EVENTS.PEER_STATUS, {
                            peerId,
                            playbackState: 'paused',
                            currentTime: null,
                            mediaTitle: null,
                            username: settings.username,
                            tabTitle: null
                        });
                        const me = currentRoom?.peers?.find(p => (p.peerId || p) === peerId);
                        if (me && typeof me === 'object') {
                            me.playbackState = 'paused';
                            me.currentTime = null;
                            me.mediaTitle = null;
                            me.tabTitle = null;
                            me.lastHeartbeat = Date.now();
                            if (storageInitialized) {
                                chrome.storage.session.set({ currentRoom });
                            }
                            chrome.runtime.sendMessage({
                                type: 'PEER_UPDATE',
                                peers: currentRoom.peers
                            }).catch(() => {});
                        }
                    }).catch(() => {});
                }
            }
        }).catch(error => addLog(`Closed target-tab cleanup failed: ${error.message}`, 'warn'));
    });
}

async function _routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, retries) {
    if (normalizeTabId(currentTabId) !== normalizeTabId(tabId)) return;
    if (mediaTargetRefreshTask && mediaTargetRefreshTabId === normalizeTabId(tabId)) {
        await mediaTargetRefreshTask.catch(() => {});
        if (normalizeTabId(currentTabId) !== normalizeTabId(tabId)) return;
    }

    const targetGeneration = targetActivationGeneration;
    const command = {
        type: 'SERVER_COMMAND',
        action,
        payload,
        actionTimestamp,
        commandSenderId
    };
    try {
        // If the elected frame reports no video, the election is wrong or stale.
        // Broadcasting reaches the frame that actually owns the player, and the
        // ones that do not own it ignore the command.
        if (currentTargetHasVideo === true) {
            await sendMessageToContentTab(tabId, command);
        } else {
            await broadcastCommandToTab(tabId, command);
        }
    } catch (error) {
        if (!isCurrentTargetIdentity(tabId, targetGeneration)) {
            if (normalizeTabId(currentTabId) === normalizeTabId(tabId) && retries < 3) {
                await _routeToContentInternal(
                    tabId,
                    action,
                    payload,
                    actionTimestamp,
                    commandSenderId,
                    retries + 1
                );
            }
            return;
        }
        if (retries >= 3) {
            addLog(`Content Script not responding in tab ${tabId} after ${retries} retries`, 'warn');
            await clearTargetTabForIdle(tabId, targetGeneration);
            return;
        }

        if (isContentUnreachableError(error)) {
            try {
                // Drop the dead election first so the rebuild is not anchored to
                // a frame that no longer exists.
                releaseUnreachableFrameTarget(tabId);
                const response = await refreshCurrentMediaTarget(tabId, { onlyIfTargetMoved: false });
                if (response?.status !== 'ok' && response?.status !== 'activation_in_progress') return;
                await new Promise(resolve => setTimeout(resolve, 150));
                await _routeToContentInternal(
                    tabId,
                    action,
                    payload,
                    actionTimestamp,
                    commandSenderId,
                    retries + 1
                );
            } catch (refreshError) {
                addLog(`Auto-reinject failed for tab ${tabId}: ${refreshError.message}`, 'warn');
            }
            return;
        }

        addLog(`Content Script not responding in tab ${tabId}`, 'warn');
        await clearTargetTabForIdle(tabId, targetGeneration);
    }
}

// --- Keep-Alive Mechanism ---
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    await ensureState();
    if (alarm.name === 'keepAlive') {
        chrome.storage.session.get('keepAlive', () => {});
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            if (!reconnectFailed && (currentRoom || connectIntent)) {
                connect();
            }
        } else if (currentRoom) {
            const now = Date.now();
            const heartbeatAge = lastContentHeartbeatAt ? (now - lastContentHeartbeatAt) : Infinity;
            if (!currentTabId || heartbeatAge > 45000) {
                markRoomPotentiallyIdle();
            }
            if (roomIdleSince && Date.now() - roomIdleSince >= ROOM_IDLE_AUTO_LEAVE_MS) {
                await leaveRoomAfterIdleGrace('Left room after 2 hours without a selected video heartbeat.');
                return;
            }
            // Heartbeat — only broadcast when someone else is in the room.
            // Recomputed live so a freshly joined peer is picked up immediately.
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            if (otherCount > 0) {
                const settings = await getSettings();
                const sharedTitles = getSharedTitleFields(settings);
                emit(EVENTS.PEER_STATUS, {
                    peerId,
                    status: 'heartbeat',
                    username: settings.username,
                    tabTitle: sharedTitles.tabTitle,
                    desynced: hcmDesynced
                });
            }
        }
    }
});

function leaveOldRoomIfSwitching(newRoomId) {
    if (currentRoom && currentRoom.roomId !== newRoomId) {
        if (currentTabId) sendMessageToChatOverlay({ type: 'CHAT_RESET' }).catch(() => {});
        addLog(`Switching rooms: leaving ${currentRoom.roomId} to join ${newRoomId}`, 'info');
        cancelEpisodeSyncV2('room_switch');
        forceDisconnect();
        currentRoom = null;
        clearCanonicalMediaRecovery();
        clearChatActivity();
        controlMode = CONTROL_MODES.EVERYONE;
        hostPeerId = null;
        controllers = [];
        serverCapabilities = [];
        invalidateChatSession();
        hcmDesynced = false;
        // Notify content.js/popup so they drop any guest-side HCM state from the
        // previous room (badge/dialog/desync) — H-2/H-3.
        broadcastControlMode();
        if (storageInitialized) chrome.storage.session.set({ currentRoom: null, hcmDesynced: false });
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});

        // Reset force sync states
        isForceSyncInitiator = false;
        forceSyncAcks.clear();
        expectedAcksCount = 0;
        if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
        chrome.storage.session.set({ 
            isForceSyncInitiator: false, 
            forceSyncAcks: [], 
            forceSyncDeadline: null,
            expectedAcksCount: 0
        });

        // Cancel any active episode lobby
        clearEpisodeLobbyState();
    }
}

function resetAudioProcessingInTab(tabId, contentTarget = null) {
    if (!tabId) return;
    if (contentTarget) {
        sendMessageToFrame(
            tabId,
            contentTarget.frameId,
            { action: 'RESET_AUDIO_PROCESSING' },
            null,
            contentTarget.documentId
        ).catch(() => {});
        return;
    }
    if (normalizeTabId(tabId) === normalizeTabId(currentTabId)) {
        sendMessageToCurrentContent({ action: 'RESET_AUDIO_PROCESSING' }).catch(() => {});
        return;
    }
    chrome.tabs.sendMessage(tabId, { action: 'RESET_AUDIO_PROCESSING' }).catch(() => {});
}

async function applyAudioSettingsToTab(tabId, contentTarget = null) {
    if (!tabId) return;
    // Local-only: audioSettings are never read from storage.sync.
    const data = await chrome.storage.local.get(['audioSettings']);
    const message = {
        action: 'APPLY_AUDIO_SETTINGS',
        settings: data.audioSettings
    };
    if (contentTarget) {
        sendMessageToFrame(
            tabId,
            contentTarget.frameId,
            message,
            null,
            contentTarget.documentId
        ).catch(() => {});
        return;
    }
    if (normalizeTabId(tabId) === normalizeTabId(currentTabId)) {
        sendMessageToCurrentContent(message).catch(() => {});
        return;
    }
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// --- Extension Message Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleAsyncMessage(message, sender, sendResponse).catch(error => {
        addLog(`Message handler failed for ${message?.type || 'unknown'}: ${error.message}`, 'error');
        try { sendResponse({ status: 'error' }); } catch (_) { /* channel already closed */ }
    });
    return true; // Keep channel open for async responses
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.browserNotifications && currentTabId) {
        sendMessageToChatOverlay({ type: 'CHAT_CONTEXT_UPDATE' }).catch(() => {});
    }
    if (!changes.roomId && !changes.chatKey && !changes.chatEnabled) return;
    if (changes.chatKey) chatSecretGuard = validateChatSecret(changes.chatKey.newValue);
    invalidateChatSession();
    if (currentTabId) sendMessageToChatOverlay({ type: 'CHAT_CONTEXT_UPDATE' }).catch(() => {});
});

async function handleAsyncMessage(message, sender, sendResponse) {
    if (!message) return;
    await ensureState();

    const senderTabId = normalizeTabId(sender?.tab?.id);
    if (senderTabId !== null) rememberFrameId(senderTabId, sender?.frameId);
    if (message.type === 'MEDIA_FRAME_DISCOVERED') {
        sendResponse({ status: 'ok' });
        return;
    }
    const mediaLifecycleMessage = message.type === 'MEDIA_FRAME_CANDIDATE_CHANGED'
        || message.type === 'MEDIA_FRAME_VISIBILITY'
        || message.type === 'MEDIA_TARGET_REFRESH';
    if (!mediaLifecycleMessage) await waitForMediaTargetRefresh(sender);

    const mustRevalidateEmbeddedSender = senderTabId !== null
        && normalizeFrameId(currentTargetFrameId) !== 0
        && isCurrentContentSender(sender)
        && (message.type === 'CONTENT_EVENT' || message.type === 'HEARTBEAT');
    if (mustRevalidateEmbeddedSender) {
        // Heartbeats and content events arrive continuously. Revalidating a
        // nested target is only about confirming the frame still holds the
        // player, so it must not reinject the content script every time: that
        // put Drive- and anime-style targets into a permanent activation loop.
        await refreshCurrentMediaTarget(senderTabId, { onlyIfTargetMoved: true }).catch(() => {});
    }

    if (message.type === 'CONNECT') {
        await waitForRoomTeardown();
        webJoinCoordinator.invalidate();
        const settings = await getSettings();
        connectIntent = !!settings.roomId;
        const desiredUrl = resolveServerUrl(settings);

        if (settings.roomId && currentRoom && currentRoom.roomId === settings.roomId && socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined && desiredUrl === currentServerUrl) {
            broadcastConnectionStatus('connected');
            if (currentTabId) sendMessageToChatOverlay({ type: 'CHAT_CONTEXT_UPDATE' }).catch(() => {});
            await broadcastJoinStatus({ type: 'JOIN_STATUS', success: true, message: 'Already in room' });
            if (typeof sendResponse === 'function') sendResponse({ status: 'ok' });
            return;
        }

        reconnectFailed = false;
        reconnectStartTime = null;
        reconnectAttempts = 0;
        chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });

        if (settings.roomId) {
            leaveOldRoomIfSwitching(settings.roomId);
        }
        if (desiredUrl !== currentServerUrl || !socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) {
            if (desiredUrl !== currentServerUrl) forceDisconnect();
            if (settings.roomId) connect();
        } else if (settings.roomId) {
            const sharedTitles = getSharedTitleFields(settings);
            emit(EVENTS.JOIN_ROOM, { 
                roomId: settings.roomId, 
                password: settings.password,
                peerId,
                username: settings.username,
                tabTitle: sharedTitles.tabTitle,
                clientCapabilities: CLIENT_CAPABILITIES,
                protocolVersion: PROTOCOL_VERSION
            });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'RETRY_CONNECT') {
        await waitForRoomTeardown();
        connectIntent = true;
        reconnectFailed = false;
        reconnectStartTime = null;
        reconnectAttempts = 0;
        chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
        forceDisconnect({ preserveEventQueue: true });
        connect();
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_STATUS') {
        if (message.retryPendingTarget === true) {
            await retryPendingTarget();
        }
        expireStuckActivation();
        const pendingTarget = await readPendingTarget();
        const settings = await getSettings();
        const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
        const isReconnecting = !isConnected && reconnectAttempts > 0;
        let status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : (isReconnecting ? 'reconnecting' : 'disconnected'));
        // Distinguish the normal "not in a room" resting state from a real drop.
        if (status === 'disconnected' && !currentRoom && !connectIntent) status = 'idle';
        // One public selection, one derived state. The selection is whatever the
        // user picked; readiness is whether we managed to inject into it. The
        // state is terminal — nothing here retries on its own.
        const publicTargetTabId = normalizeTabId(userSelectedTabId) ?? normalizeTabId(currentTabId);
        const targetReady = publicTargetTabId !== null
            && normalizeTabId(currentTabId) === publicTargetTabId
            && !activeTargetActivation;
        const targetActivationState = publicTargetTabId === null
            ? 'none'
            : targetReady
                ? 'ready'
                : activeTargetActivation
                    ? 'activating'
                    : pendingTarget?.tabId === publicTargetTabId
                        ? 'access_required'
                        // Nothing is in flight and the target is not live, so
                        // this is a settled failure. Reporting it as
                        // "activating" is what left the popup spinning forever
                        // with no way to tell that it had already given up.
                        : 'error';
        sendResponse({
            status,
            peerId,
            peers: currentRoom ? currentRoom.peers : [],
            lastActionState,
            targetTabId: publicTargetTabId,
            targetTabTitle: userSelectedTabTitle ?? currentTabTitle,
            targetReady,
            targetActivationState,
            targetActivationError: normalizeTabId(userSelectionErrorTabId) === publicTargetTabId
                ? userSelectionErrorMessage
                : null,
            targetFrameId: currentTargetFrameId,
            targetDocumentId: currentTargetDocumentId,
            targetHasVideo: currentTargetHasVideo,
            pendingTargetTabId: pendingTarget?.tabId ?? null,
            pendingTargetHost: pendingTarget?.host ?? null,
            pendingTargetOriginPattern: pendingTarget?.originPattern ?? null,
            pendingTargetRequestId: pendingTarget?.requestId ?? null,
            episodeLobby: episodeLobbyForUi(),
            reconnectAttempts,
            reconnectSlowMode: reconnectFailed,
            queuedLogicalEvents: eventQueue.length,
            queuedMediaIntents: queuedMediaIntentCount(eventQueue, currentRoom?.roomId || pendingRoomDataRoomId),
            queuedWireEvents: queuedWireCount(eventQueue),
            roomId: currentRoom ? currentRoom.roomId : null,
            serverUrl: currentServerUrl,
            version: chrome.runtime.getManifest().version,
            protocolVersion: PROTOCOL_VERSION,
            ping: currentPingMs,
            controlMode,
            hostPeerId,
            controllers,
            amHost: amHost(),
            amController: amController(),
            hostControlSupported: serverSupports(CAPABILITIES.HOST_CONTROL),
            coHostSupported: serverSupports(CAPABILITIES.CO_HOST),
            chatSupported: serverSupportsChat(),
            hasChatKey: !!settings.chatKey,
            chatEnabled: settings.chatEnabled
        });
    } else if (message.type === 'GET_CHAT_CONTEXT') {
        if (!currentRoom || !currentTabId || !isCurrentContentSender(sender)) {
            sendResponse({ supported: false, hasKey: false });
            return;
        }
        const generation = chatSessionGeneration;
        const roomId = currentRoom.roomId;
        const tabId = Number(currentTabId);
        const isCurrentSession = () => generation === chatSessionGeneration
            && currentRoom?.roomId === roomId
            && Number(currentTabId) === tabId
            && isCurrentContentSender(sender);
        const settings = await getSettings();
        const localeData = await chrome.storage.local.get(['locale', 'browserNotifications']);
        await loadLocale(localeData.locale || getSystemLanguage());
        if (!isCurrentSession() || settings.roomId !== roomId) {
            sendResponse({ supported: false, hasKey: false, status: 'session_changed' });
            return;
        }
        const translated = key => {
            const value = getMessage(key);
            return value === key ? '' : value;
        };
        sendResponse({
            supported: serverSupportsChat(),
            enabled: settings.chatEnabled,
            hasKey: !!settings.chatKey,
            connected: !!(socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined),
            eventNotifications: localeData.browserNotifications === true,
            peerId,
            roomId,
            activity: chatActivityStore.snapshot(),
            strings: {
                title: translated('CHAT_TITLE'),
                liveOnly: translated('CHAT_LIVE_ONLY'),
                open: translated('CHAT_OPEN'),
                close: translated('CHAT_CLOSE'),
                dockLeft: translated('CHAT_DOCK_LEFT'),
                dockRight: translated('CHAT_DOCK_RIGHT'),
                detached: translated('CHAT_DETACHED'),
                placeholder: translated('CHAT_PLACEHOLDER'),
                send: translated('CHAT_SEND'),
                missingKey: translated('CHAT_MISSING_KEY'),
                tooLong: translated('CHAT_TOO_LONG'),
                sendFailed: translated('CHAT_SEND_FAILED'),
                empty: translated('CHAT_EMPTY'),
                you: translated('LABEL_YOU'),
                eventPlay: translated('NOTIF_PLAY'),
                eventPause: translated('NOTIF_PAUSE'),
                eventSeek: translated('NOTIF_SEEK'),
                eventForcePrepare: translated('NOTIF_FORCE_PREPARE'),
                eventForceExecute: translated('NOTIF_FORCE_EXECUTE'),
                eventAction: translated('TOAST_PEER_ACTION'),
                eventJoined: translated('TOAST_PEER_JOINED'),
                eventLeft: translated('TOAST_PEER_LEFT'),
                quickReactions: translated('CHAT_QUICK_REACTIONS')
            }
        });
    } else if (message.type === 'CHAT_SEND') {
        if (!currentRoom || !currentTabId || !isCurrentContentSender(sender)) {
            sendResponse({ status: 'invalid_tab' });
            return;
        }
        if (!serverSupportsChat()) {
            sendResponse({ status: 'unsupported' });
            return;
        }
        if (!socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) {
            sendResponse({ status: 'disconnected' });
            return;
        }
        const generation = chatSessionGeneration;
        const roomId = currentRoom.roomId;
        const tabId = Number(currentTabId);
        const socketSnapshot = socket;
        const isCurrentSession = () => generation === chatSessionGeneration &&
            currentRoom?.roomId === roomId && Number(currentTabId) === tabId &&
            socket === socketSnapshot && socketSnapshot.readyState === WebSocket.OPEN && isNamespaceJoined;
        const settings = await getSettings();
        if (!settings.chatEnabled) {
            sendResponse({ status: 'disabled' });
            return;
        }
        if (!settings.chatKey || settings.roomId !== roomId || !isCurrentSession()) {
            sendResponse({ status: settings.chatKey ? 'session_changed' : 'missing_key' });
            return;
        }
        const chatKey = settings.chatKey;
        const rateLimit = chatSendLimiter.take();
        if (!rateLimit.allowed) {
            sendResponse({ status: 'rate_limited', retryAfterMs: rateLimit.retryAfterMs });
            return;
        }
        try {
            const ciphertext = await encryptChatMessage({
                text: message.text,
                roomId,
                senderId: peerId,
                secret: chatKey
            });
            if (!isCurrentSession() || chatSecretGuard !== chatKey) {
                sendResponse({ status: 'session_changed' });
                return;
            }
            const echoPromise = chatEchoTracker.waitFor(ciphertext);
            const sent = emitLive(EVENTS.CHAT_MESSAGE, buildChatRelayPayload(ciphertext));
            if (!sent) {
                chatEchoTracker.cancel(ciphertext);
                sendResponse({ status: 'disconnected' });
                return;
            }
            const acknowledged = await echoPromise;
            if (!isCurrentSession() || chatSecretGuard !== chatKey) {
                sendResponse({ status: 'session_changed' });
                return;
            }
            sendResponse({ status: acknowledged ? 'ok' : 'unconfirmed' });
        } catch (err) {
            sendResponse({ status: err instanceof RangeError ? 'too_long' : 'invalid_message' });
        }
    } else if (message.type === 'CREATE_CHAT_KEY') {
        const chatKey = generateChatSecret();
        chatSecretGuard = chatKey;
        invalidateChatSession();
        await chrome.storage.local.set({ chatKey });
        sendResponse({ status: 'ok', chatKey });
    } else if (message.type === 'SET_CONTROL_MODE') {
        // Popup (host) toggles the room control mode. Server validates host authority
        // and broadcasts CONTROL_MODE back, which updates our local state + UI.
        const mode = message.controlMode;
        if (mode !== CONTROL_MODES.EVERYONE && mode !== CONTROL_MODES.HOST_ONLY) {
            sendResponse({ status: 'invalid' });
            return;
        }
        if (!amHost()) {
            sendResponse({ status: 'not_host' });
            return;
        }
        emit(EVENTS.SET_CONTROL_MODE, { controlMode: mode });
        sendResponse({ status: 'ok' });
    } else if (message.type === 'SET_PEER_ROLE') {
        // Popup (owner) promotes/demotes a peer to/from controller. Server validates
        // owner authority and broadcasts CONTROL_MODE back, refreshing all clients.
        const targetPeerId = typeof message.peerId === 'string' ? message.peerId : null;
        if (!targetPeerId) {
            sendResponse({ status: 'invalid' });
            return;
        }
        if (!amHost()) {
            sendResponse({ status: 'not_owner' });
            return;
        }
        emit(EVENTS.SET_PEER_ROLE, { peerId: targetPeerId, controller: message.controller === true });
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_CONTROL_MODE') {
        // content.js asks for current mode/role on (re)injection. Include the
        // persisted desync state so a page reload re-adopts it — otherwise a fresh
        // content script would start synced while background keeps relaying us as
        // "Solo" to the host (stale-badge split-brain).
        sendResponse({ controlMode, hostPeerId, controllers, amHost: amHost(), amController: amController(), desynced: hcmDesynced, hostControlSupported: serverSupports(CAPABILITIES.HOST_CONTROL), coHostSupported: serverSupports(CAPABILITIES.CO_HOST) });
    } else if (message.type === 'REQUEST_HOST_SYNC') {
        if (sender.tab && !isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_unselected_tab', target: null });
            return;
        }
        // content.js resync: hand back the host's extrapolated current position.
        sendResponse({ target: getHostSyncTarget() });
    } else if (message.type === 'GET_HCM_STRINGS') {
        // Localized strings for the in-page host-control dialog/badge. content.js
        // has no i18n loader of its own, so background resolves them here.
        const settings = await chrome.storage.local.get(['locale']);
        const lang = settings.locale || getSystemLanguage();
        await loadLocale(lang);
        // getMessage returns the key name itself if the dictionary failed to load.
        // Return undefined in that case so content keeps its English fallback rather
        // than rendering a raw key like "HCM_DIALOG_TITLE".
        const m = (k) => { const v = getMessage(k); return v === k ? undefined : v; };
        sendResponse({
            title:  m('HCM_DIALOG_TITLE'),
            body:   m('HCM_DIALOG_BODY'),
            stay:   m('HCM_DIALOG_STAY'),
            solo:   m('HCM_DIALOG_SOLO'),
            badge:  m('HCM_BADGE_SOLO'),
            resync: m('HCM_BADGE_RESYNC')
        });
    } else if (message.type === 'HCM_DESYNC_STATE') {
        // content.js tells us whether the local user chose to watch on their own.
        // Only accept from the currently selected tab.
        if (sender.tab && !isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_unselected_tab' });
            return;
        }
        // Mirrored into heartbeats so the host's UI can show "Solo" instead of
        // silently waiting for ACKs that will never come. Persisted so the
        // heartbeat survives SW restarts (idle timeout, crash).
        hcmDesynced = !!message.desynced;
        if (storageInitialized) chrome.storage.session.set({ hcmDesynced });
        if (hcmDesynced) {
            applyQueuedRoomPolicy(currentRoom?.roomId, { desynced: true }, 'Intentional solo mode');
            const pending = canonicalMediaStateTracker.getPending(currentRoom?.roomId);
            if (pending) {
                markCanonicalMediaStateHandled(pending.roomId, pending.mediaState.revision);
                addLog(`Canonical media state r${pending.mediaState.revision} skipped: local guest chose desynced mode`, 'info');
            }
        }
        if (episodeLobby) {
            if (hcmDesynced && episodeLobby.initiatorPeerId === peerId) {
                cancelEpisodeLobby('Initiator entered solo mode');
            } else {
                checkEpisodeLobbyCompletion();
            }
        }
        if (hcmDesynced && episodeSyncV2?.participants.includes(peerId)) {
            cancelEpisodeSyncV2('desynced');
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'LEAVE_ROOM') {
        await endRoomSession({ notifyServer: true, reason: 'Left Room' });
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CLEAR_LOGS') {
        logs = [];
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_LOGS') {
        sendResponse(logs);
    } else if (message.type === 'GET_HISTORY') {
        sendResponse(history);
    } else if (message.type === 'GET_ROOM_LIST') {
        emit(EVENTS.GET_ROOMS, {});
        sendResponse({ status: 'ok' });
    } else if (message.type === 'WEB_JOIN_REQUEST') {
        await waitForRoomTeardown();
        const { roomId: rawRoomId, password, chatKey: rawChatKey, useCustomServer, serverUrl } = message;
        const roomId = normalizeRoomId(rawRoomId);
        const chatKey = validateChatSecret(rawChatKey);
        if (!roomId) {
            const errMsg = { type: 'JOIN_STATUS', success: false, message: 'Invalid room ID' };
            await broadcastJoinStatus(errMsg);
            sendResponse({ status: 'invalid_room_id' });
            return;
        }
        await webJoinCoordinator.run(async isCurrentJoin => {
            if (!isCurrentJoin()) {
                sendResponse({ status: 'superseded' });
                return { status: 'superseded' };
            }
            try {
                connectIntent = true;
                await chrome.storage.local.set({
                    roomId,
                    password: typeof password === 'string' ? password : '',
                    chatKey,
                    useCustomServer: !!useCustomServer,
                    serverUrl: typeof serverUrl === 'string' ? serverUrl : ''
                });
                if (!isCurrentJoin()) {
                    sendResponse({ status: 'superseded' });
                    return { status: 'superseded' };
                }
                chatSecretGuard = chatKey;
                invalidateChatSession();
                const settings = await getSettings();
                if (!isCurrentJoin()) {
                    sendResponse({ status: 'superseded' });
                    return { status: 'superseded' };
                }
                const desiredUrl = resolveServerUrl(settings);

                if (roomId && currentRoom && currentRoom.roomId === roomId && socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined && desiredUrl === currentServerUrl) {
                    broadcastConnectionStatus('connected');
                    if (currentTabId) sendMessageToChatOverlay({ type: 'CHAT_CONTEXT_UPDATE' }).catch(() => {});
                    const statusSent = await broadcastJoinStatus(
                        { type: 'JOIN_STATUS', success: true, message: 'Already in room' },
                        isCurrentJoin
                    );
                    if (!statusSent || !isCurrentJoin()) {
                        sendResponse({ status: 'superseded' });
                        return { status: 'superseded' };
                    }
                    sendResponse({ status: 'already_joined' });
                    return { status: 'already_joined' };
                }

                reconnectFailed = false;
                reconnectStartTime = null;
                reconnectAttempts = 0;
                chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
                broadcastConnectionStatus('connecting');
                leaveOldRoomIfSwitching(roomId);

                if (desiredUrl !== currentServerUrl || !socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) {
                    if (desiredUrl !== currentServerUrl) forceDisconnect();
                    connect();
                } else if (roomId) {
                    const sharedTitles = getSharedTitleFields(settings);
                    emit(EVENTS.JOIN_ROOM, {
                        roomId,
                        password,
                        peerId,
                        username: settings.username,
                        tabTitle: sharedTitles.tabTitle,
                        clientCapabilities: CLIENT_CAPABILITIES,
                        protocolVersion: PROTOCOL_VERSION
                    });
                }
                addLog(`Joining room via link: ${roomId}`, 'info');
                sendResponse({ status: 'ok' });
                return { status: 'ok' };
            } catch (_) {
                if (isCurrentJoin()) await clearFailedJoinCredentials();
                sendResponse({ status: 'storage_error' });
                return { status: 'storage_error' };
            }
        });
    } else if (message.type === 'REGENERATE_ID') {
        // Match getPeerId()'s 16-hex-char generation — see comment there.
        const newId = self.crypto.randomUUID().replace(/-/g, '').substring(0, 16);
        chrome.storage.local.set({ peerId: newId }, () => {
            peerId = newId;
            addLog(`Identity regenerated: ${newId}`, 'success');
            if (socket) socket.close(); // Force reconnect with new ID
            sendResponse({ peerId: newId });
        });
    } else if (message.type === 'GET_VIDEO_STATE') {
        const tabId = normalizeTabId(message.tabId);
        if (tabId === null) {
            sendResponse({ error: 'No tabId provided' });
            return;
        }
        getReadyTabVideoState(tabId).then(state => {
            sendResponse(state);
        }).catch(error => {
            sendResponse({ error: error.message });
        });
    } else if (message.type === 'DEV_SIMULATE_REMOTE_SEEK') {
        if (!(await devRemoteToolsAllowed())) {
            sendResponse({ status: 'forbidden' });
            return;
        }
        const delta = message.delta !== null && message.delta !== undefined ? Number(message.delta) : null;
        const targetTime = message.targetTime !== null && message.targetTime !== undefined ? Number(message.targetTime) : null;

        if (delta === null && targetTime === null) {
            sendResponse({ status: 'invalid_params' });
            return;
        }
        simulateRemoteSeek(delta, targetTime).then(sendResponse).catch(err => {
            addLog(`Remote seek simulation failed: ${err.message}`, 'warn');
            sendResponse({ status: 'error', message: err.message });
        });
    } else if (message.type === 'CONTENT_EVENT') {
        const senderIsContent = !!sender?.tab && !isExtensionPageSender(sender);
        // A real player frame just identified itself. Take it as the target so
        // subsequent commands can be addressed instead of broadcast.
        if (senderIsContent) adoptReportingFrame(sender);
        if (!senderIsContent && message.expectedTabId !== undefined) {
            const expectedTabId = normalizeTabId(message.expectedTabId);
            if (expectedTabId === null || normalizeTabId(currentTabId) !== expectedTabId) {
                sendResponse({ status: 'stale_target' });
                return;
            }
        }
        const processEvent = async () => {
            const eventRoomId = currentRoom?.roomId || pendingRoomDataRoomId || null;
            const eventTabId = normalizeTabId(currentTabId);
            const isCurrentEventContext = () => (currentRoom?.roomId || pendingRoomDataRoomId || null) === eventRoomId
                && normalizeTabId(currentTabId) === eventTabId
                && (!senderIsContent || isCurrentContentSender(sender));
            // Host Control Mode (sender-side): a non-controller in host-only mode must
            // not drive the room. Don't broadcast; hand the action back to content.js so
            // it can snap the local player back / offer desync.
            // Defensive: require a known hostPeerId (L-6) — otherwise the actual
            // owner would gate themselves if state ever becomes inconsistent.
            if (controlMode === CONTROL_MODES.HOST_ONLY && hostPeerId && !amController() &&
                HOST_ONLY_GATED_ACTIONS.includes(message.action)) {
                addLog(`Host-only: blocked local ${message.action} (you are a guest)`, 'warn');
                if (senderIsContent && sender.tab.id) {
                    sendMessageToFrame(sender.tab.id, sender.frameId, {
                        type: 'HOST_BLOCKED',
                        action: message.action,
                        target: getHostSyncTarget()
                    }, null, sender.documentId).catch(() => {});
                }
                sendResponse({ status: 'blocked_host_only' });
                return;
            }

            // Live solo check — recomputed from the current peer list on every
            // event (the list is updated synchronously on PEER_STATUS join/leave),
            // never cached, so the instant a peer joins we resume sending.
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            let hasOtherPeers = otherCount > 0;

            // Force Sync only makes sense with other peers. Solo it is a no-op:
            // skip the pause/seek + ACK-wait entirely (no freeze, no server traffic).
            if (message.action === EVENTS.FORCE_SYNC_PREPARE && !hasOtherPeers) {
                sendResponse({ status: 'ok_solo' });
                return;
            }

            const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
            const payloadNumber = (value) => value !== undefined && value !== null && value !== '' ? Number(value) : NaN;
            if (message.action === EVENTS.FORCE_SYNC_PREPARE) {
                const targetTime = payloadNumber(payload.targetTime);
                if (!Number.isFinite(targetTime)) {
                    sendResponse({ status: 'invalid_params' });
                    return;
                }
                payload.targetTime = targetTime;
            } else if (message.action === EVENTS.SEEK) {
                const targetTime = payloadNumber(payload.targetTime !== undefined ? payload.targetTime : payload.currentTime);
                if (!Number.isFinite(targetTime)) {
                    sendResponse({ status: 'invalid_params' });
                    return;
                }
                payload.currentTime = targetTime;
                payload.targetTime = targetTime;
            }

            const hasPlaybackTime = Number.isFinite(payload.currentTime) || Number.isFinite(payload.targetTime);
            if (!senderIsContent && (message.action === EVENTS.PLAY || message.action === EVENTS.PAUSE) && !hasPlaybackTime) {
                const tabId = currentTabId ? parseInt(currentTabId) : NaN;
                if (!isNaN(tabId)) {
                    const state = await getReadyTabVideoState(tabId);
                    if (state && !state.error && state.found && Number.isFinite(state.currentTime)) {
                        payload.currentTime = state.currentTime;
                    }
                }
            }
            if (!isCurrentEventContext()) {
                sendResponse({ status: 'ignored_stale_session' });
                return;
            }

            const isNonEssentialEvent = message.action === EVENTS.PLAY
                || message.action === EVENTS.PAUSE
                || message.action === EVENTS.SEEK;
            const settings = await getSettings();
            if (!isCurrentEventContext()
                || (eventRoomId && settings.roomId !== eventRoomId)) {
                sendResponse({ status: 'ignored_stale_session' });
                return;
            }
            const currentOtherCount = currentRoom && Array.isArray(currentRoom.peers)
                ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length
                : 0;
            hasOtherPeers = currentOtherCount > 0;
            const shouldEmit = !(isNonEssentialEvent
                && !hasOtherPeers
                && !serverSupports(CAPABILITIES.MEDIA_STATE_V1));

            if (isCanonicalSupersedingControl(message.action, payload)) {
                supersedeCanonicalMediaRecovery(`local ${message.action}`);
            }
            const timestamp = Date.now();
            localSeq++;
            chrome.storage.session.set({ localSeq });
            updateLastAction(message.action, 'You', timestamp);

            lastActionState.targetTime = payload.targetTime !== undefined ? payload.targetTime : payload.currentTime;
            if (storageInitialized) chrome.storage.session.set({ lastActionState });
            
            payload.actionTimestamp = timestamp;
            payload.seq = localSeq;
            message.payload = payload;
            
            // Local Reactive Update
            updateLocalPeerState(peerId, {
                playbackState: message.action === EVENTS.PLAY ? 'playing' : (message.action === EVENTS.PAUSE ? 'paused' : undefined),
                currentTime: payload.currentTime !== undefined ? payload.currentTime : (payload.targetTime !== undefined ? payload.targetTime : undefined)
            });

            if (!senderIsContent && (message.action === EVENTS.PLAY || message.action === EVENTS.PAUSE || message.action === EVENTS.SEEK)) {
                routeToContent(message.action, message.payload);
            }

            if (message.action === EVENTS.FORCE_SYNC_PREPARE) {
                isForceSyncInitiator = true;
                forceSyncAcks.clear();
                expectedAcksCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.length : 1;
                const deadline = Date.now() + FORCE_SYNC_TIMEOUT;
                chrome.storage.session.set({ 
                    isForceSyncInitiator: true, 
                    forceSyncAcks: [], 
                    forceSyncDeadline: deadline,
                    expectedAcksCount: expectedAcksCount
                });
                addLog('Initiating Force Sync...', 'info');
                
                routeToContent(EVENTS.FORCE_SYNC_PREPARE, message.payload);
     
                if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
                forceSyncTimeout = setTimeout(() => {
                    if (isForceSyncInitiator) {
                        addLog('Force Sync: Timeout waiting for ACKs, executing anyway...', 'warn');
                        executeForceSync();
                    }
                }, FORCE_SYNC_TIMEOUT);
            }
            addToHistory(message.action, 'You');
            sendChatActivity(message.action, peerId, timestamp);

            if (!shouldEmit) {
                sendResponse({ status: 'ok_solo' });
                return;
            }

            const outboundPayload = withTitlePrivacy(message.payload, settings, ['mediaTitle']);
            emit(message.action, { ...outboundPayload, peerId });
            sendResponse({ status: 'ok' });
        };

        if (senderIsContent) {
            if (!isCurrentContentSender(sender)) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
            
            currentTabTitle = sender.tab.title ? sender.tab.title.substring(0, 50) : null;
            chrome.storage.session.set({ currentTabTitle });
            updateBadgeStatus();
            processEvent().catch(err => {
                addLog('Content event privacy error: ' + err.message, 'error');
                sendResponse({ status: 'error' });
            });
        } else {
            processEvent().catch(err => {
                addLog('Content event privacy error: ' + err.message, 'error');
                sendResponse({ status: 'error' });
            });
        }
    } else if (message.type === 'FORCE_SYNC_ACK') {
        if (sender.tab && !isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_unselected_tab' });
            return;
        }
        if (isForceSyncInitiator) {
            forceSyncAcks.add(peerId);
            chrome.storage.session.set({ forceSyncAcks: Array.from(forceSyncAcks) });
            addLog(`Local ACK received (${forceSyncAcks.size})`, 'info');

            // Local Force Sync ACK Reactive Update
            if (lastActionState && lastActionState.action === EVENTS.FORCE_SYNC_PREPARE) {
                updateLocalPeerState(peerId, {
                    playbackState: 'paused',
                    currentTime: lastActionState.targetTime
                });
            }

            const peerCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.length : 1;
            if (forceSyncAcks.size >= peerCount) {
                executeForceSync();
            }
        } else {
            localSeq++;
            chrome.storage.session.set({ localSeq });
            emitLive(EVENTS.FORCE_SYNC_ACK, { peerId, seq: localSeq });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CMD_ACK') {
        if (sender.tab && !isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_unselected_tab' });
            return;
        }
        const commandSenderId = message.commandSenderId;
        // Only ACK if the command sender is still a known peer in our room.
        // If we've already seen their PEER_STATUS 'left', skip the ACK — it would
        // only be dropped server-side as an absent-peer ACK anyway.
        const senderStillPresent = currentRoom && Array.isArray(currentRoom.peers) &&
            currentRoom.peers.some(p => (typeof p === 'object' ? p.peerId : p) === commandSenderId);
        if (commandSenderId && commandSenderId !== peerId && senderStillPresent) {
            emit(EVENTS.EVENT_ACK, {
                senderId: peerId,
                targetId: commandSenderId,
                actionTimestamp: message.actionTimestamp
            });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'HEARTBEAT') {
        if (sender.tab) {
            if (!isCurrentContentSender(sender)) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
            
            currentTabTitle = sender.tab.title ? sender.tab.title.substring(0, 50) : null;
            chrome.storage.session.set({ currentTabTitle });
            updateBadgeStatus();
        }

        requestCanonicalMediaRecoveryAttempt();
        markRoomUseful();
        const heartbeatRoomId = currentRoom?.roomId || null;
        const heartbeatPayload = message.payload && typeof message.payload === 'object'
            ? { ...message.payload }
            : {};
        getSettings().then(settings => {
            if ((sender.tab && !isCurrentContentSender(sender))
                || currentRoom?.roomId !== heartbeatRoomId
                || settings.roomId !== heartbeatRoomId) {
                sendResponse({ status: 'ignored_stale_session' });
                return;
            }
            const sharedTitles = getSharedTitleFields(settings, heartbeatPayload.mediaTitle);
            const statusPayload = {
                ...heartbeatPayload,
                peerId,
                username: settings.username,
                tabTitle: sharedTitles.tabTitle,
                mediaTitle: sharedTitles.mediaTitle,
                desynced: hcmDesynced
            };
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            if (otherCount > 0) emit(EVENTS.PEER_STATUS, statusPayload);

            if (currentRoom && Array.isArray(currentRoom.peers)) {
                const me = currentRoom.peers.find(p => (p.peerId || p) === peerId);
                if (me && typeof me === 'object') {
                    me.tabTitle = sharedTitles.tabTitle;
                    me.username = settings.username;
                    me.mediaTitle = sharedTitles.mediaTitle;
                    me.playbackState = heartbeatPayload.playbackState;
                    me.currentTime = heartbeatPayload.currentTime;
                    me.volume = heartbeatPayload.volume;
                    me.muted = heartbeatPayload.muted;
                    me.lastHeartbeat = Date.now();
                    if (storageInitialized) chrome.storage.session.set({ currentRoom });
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                }
            }
            sendResponse({ status: 'ok' });
        }).catch(err => {
            addLog('Heartbeat settings error: ' + err.message, 'error');
            sendResponse({ status: 'ok' });
        });
    } else if (message.type === 'INJECT_CONTENT_SCRIPT') {
        const tabId = normalizeTabId(message.tabId);
        if (tabId === null) {
            sendResponse({ status: 'invalid_tab' });
            return true;
        }

        const expectedCurrentTabId = normalizeTabId(message.expectedCurrentTabId);
        if (expectedCurrentTabId === null
            || tabId !== expectedCurrentTabId
            || normalizeTabId(currentTabId) !== expectedCurrentTabId) {
            sendResponse({ status: 'stale_target' });
            return true;
        }

        refreshCurrentMediaTarget(tabId, { onlyIfTargetMoved: false }).then(response => {
            sendResponse(response);
        }).catch(err => {
            addLog(`Failed to inject into tab: ${err.message}`, 'warn');
            sendResponse(injectionFailureResponse(err));
        });
        return true;
    } else if (message.type === 'SET_TARGET_TAB') {
        await waitForRoomTeardown();
        if (message.tabId === null || message.tabId === undefined || message.tabId === '') {
            await clearTargetSelectionForLifecycle({ markRoomIdle: true });
            sendResponse({ status: 'ok', tabId: null });
            return;
        }

        // Persist the choice before activating. Injection can fail for reasons
        // the user can act on (a player frame needing host access, a page still
        // loading), and none of them mean they stopped wanting this tab.
        await rememberUserSelection(message.tabId, message.tabTitle);
        try {
            const response = await activateTargetTab(message.tabId, message.tabTitle);
            if (response?.status === 'ok') {
                chrome.runtime.sendMessage({
                    type: 'TARGET_TAB_READY',
                    tabId: response.tabId
                }).catch(() => {});
            } else if (response?.status !== 'superseded') {
                await recordUserSelectionFailure(message.tabId, {
                    message: `Activation returned ${response?.status || 'no result'}`
                });
            }
            sendResponse(response);
        } catch (error) {
            addLog(`Failed to select tab: ${error.message}`, 'warn');
            await recordUserSelectionFailure(message.tabId, error);
            sendResponse(injectionFailureResponse(error));
        }
    } else if (message.type === 'LOG') {
        addLog(`[Content] ${message.message}`, message.level || 'info');
        sendResponse({ status: 'ok' });
    } else if (message.type === 'EPISODE_CHANGED') {
        // Content script detected an episode transition
        if (sender.tab) {
            if (!isCurrentContentSender(sender)) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
        }
        const episodeRoomId = currentRoom?.roomId || null;
        const isCurrentEpisodeContext = () => currentRoom?.roomId === episodeRoomId
            && (!sender.tab || isCurrentContentSender(sender));

        const newTitle = message.payload && message.payload.newTitle;
        if (newTitle && extractEpisodeId(newTitle) === null) {
            addLog(`Episode change detected ("${newTitle}") but no episode ID was found; ignoring.`, 'info');
            sendResponse({ status: 'not_an_episode' });
            return;
        }
        if (!newTitle) {
            sendResponse({ status: 'no_title' });
            return;
        }

        const settings = await getSettings();
        if (!isCurrentEpisodeContext() || settings.roomId !== episodeRoomId) {
            sendResponse({ status: 'ignored_stale_session' });
            return;
        }
        const lobbyTitle = sanitizeSharedTitle(newTitle, settings.mediaTitlePrivacyMode);
        if (!lobbyTitle) {
            addLog(`Episode change detected but media title sharing is ${settings.mediaTitlePrivacyMode}; not creating a lobby.`, 'info');
            sendResponse({ status: 'title_privacy_no_lobby' });
            return;
        }

        // Check setting
        const epSettings = await chrome.storage.local.get(['autoSyncNextEpisode']);
        if (!isCurrentEpisodeContext()) {
            sendResponse({ status: 'ignored_stale_session' });
            return;
        }
        if (epSettings.autoSyncNextEpisode === false) {
            addLog(`Episode change detected ("${lobbyTitle}") but Auto-Sync is disabled.`, 'info');
            sendResponse({ status: 'disabled' });
            return;
        }

        if (hcmDesynced) {
            addLog(`Episode change ("${lobbyTitle}") — intentional solo mode, not creating a lobby.`, 'info');
            sendResponse({ status: 'desynced_skip' });
            return;
        }

        // Host Control Mode: only controllers may initiate the relay-owned
        // transaction. Plain guests wait for the controller's accepted lobby.
        if (controlMode === CONTROL_MODES.HOST_ONLY && !amController()) {
            addLog(`Episode change ("${lobbyTitle}") — host-only guest, not creating a lobby (controller drives).`, 'info');
            sendResponse({ status: 'host_only_guest_skip' });
            return;
        }

        // Variant A: alone in the room → no one to wait for. Skip the lobby
        // entirely so the next episode just plays through (no pause, no traffic).
        // Live peer check, so the moment someone joins the next transition syncs.
        const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
        if (otherCount === 0) {
            addLog(`Episode change ("${lobbyTitle}") — alone in room, playing through without a lobby.`, 'info');
            sendResponse({ status: 'solo_no_lobby' });
            return;
        }

        // Automatic episode sync v2 is relay-owned. Never self-pause or fall
        // back to the legacy client-owned lobby: on an old/mixed relay that path
        // can create multiple Force Sync initiators. Manual Force Sync remains
        // available and unchanged.
        if (!serverSupports(CAPABILITIES.EPISODE_SYNC_V2)) {
            addLog(`Episode change ("${lobbyTitle}") — relay lacks Episode Sync v2; automatic sync skipped safely.`, 'warn');
            sendResponse({ status: 'episode_sync_v2_unsupported' });
            return;
        }
        if (episodeSyncV2 && sameEpisode(episodeSyncV2.expectedTitle, lobbyTitle)) {
            sendResponse({ status: 'transaction_active', transactionId: episodeSyncV2.transactionId });
            return;
        }
        if (episodeSyncV2) cancelEpisodeSyncV2('new_episode');
        if (!emitLive(EVENTS.EPISODE_SYNC_V2, { phase: 'start', expectedTitle: lobbyTitle })) {
            addLog(`Episode change ("${lobbyTitle}") — not connected; automatic sync was not queued.`, 'warn');
            sendResponse({ status: 'episode_sync_v2_offline' });
            return;
        }
        addLog(`Episode Sync v2 requested: "${lobbyTitle}"`, 'info');
        sendResponse({ status: 'episode_sync_v2_requested' });
    } else if (message.type === 'EPISODE_READY_LOCAL') {
        if (sender.tab) {
            if (!isCurrentContentSender(sender)) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
        }
        // Content script confirmed it loaded the lobby episode
        const lobby = episodeLobby;
        const lobbyRoomId = currentRoom?.roomId || null;
        const isCurrentLobbyContext = () => episodeLobby === lobby
            && currentRoom?.roomId === lobbyRoomId
            && (!sender.tab || isCurrentContentSender(sender));
        if (lobby && message.payload && sameEpisode(message.payload.title, lobby.expectedTitle)) {
            if (!lobby.readyPeers.includes(peerId)) {
                const settings = await getSettings();
                if (!isCurrentLobbyContext() || settings.roomId !== lobbyRoomId) {
                    sendResponse({ status: 'ignored_stale_lobby' });
                    return;
                }
                if (lobby.readyPeers.includes(peerId)) {
                    sendResponse({ status: 'ok' });
                    return;
                }
                const readyTitle = sanitizeSharedTitle(message.payload.title, settings.mediaTitlePrivacyMode);
                lobby.readyPeers.push(peerId);
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                emitLive(EVENTS.EPISODE_READY, {
                    peerId,
                    title: readyTitle,
                    expectedTitle: lobby.expectedTitle
                });
                addLog(`Local episode ready: "${readyTitle || lobby.expectedTitle}"`, 'success');
                checkEpisodeLobbyCompletion();
            }
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'EPISODE_SYNC_V2_LOCAL') {
        if (sender.tab && !isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_stale_target' });
            return;
        }
        const transaction = episodeSyncV2;
        const localPhase = message.phase;
        const expectedLocalPhase = localPhase === 'loaded'
            ? 'lobby'
            : (localPhase === 'prepared' ? 'prepare' : null);
        if (!transaction
            || message.transactionId !== transaction.transactionId
            || (expectedLocalPhase && transaction.phase !== expectedLocalPhase)
            || !['loaded', 'prepared', 'failed'].includes(localPhase)) {
            sendResponse({ status: 'ignored_stale_transaction' });
            return;
        }
        const localTitle = message.payload?.title;
        if (localPhase !== 'failed'
            && (typeof localTitle !== 'string' || !sameEpisodeStrict(localTitle, transaction.expectedTitle))) {
            sendResponse({ status: 'ignored_episode_mismatch' });
            return;
        }
        const sent = emitLive(EVENTS.EPISODE_SYNC_V2, {
            phase: localPhase,
            transactionId: transaction.transactionId,
            reason: typeof message.reason === 'string' ? message.reason.substring(0, 32) : undefined
        });
        sendResponse({ status: sent ? 'sent' : 'offline' });
    } else if (message.type === 'TITLE_PRIVACY_CHANGED') {
        const privacyRoomId = currentRoom?.roomId || null;
        const privacyLobby = episodeLobby;
        const settings = await getSettings();
        if (currentRoom?.roomId !== privacyRoomId || settings.roomId !== privacyRoomId) {
            sendResponse({ status: 'ignored_stale_session' });
            return;
        }
        if (episodeLobby === privacyLobby && privacyLobby?.initiatorPeerId === peerId) {
            const nextLobbyTitle = sanitizeSharedTitle(privacyLobby.expectedTitle, settings.mediaTitlePrivacyMode);
            if (!nextLobbyTitle || nextLobbyTitle !== privacyLobby.expectedTitle) {
                cancelEpisodeLobby('Title privacy changed');
            }
        }
        if (episodeSyncV2) cancelEpisodeSyncV2('title_privacy_changed');
        if (currentRoom) {
            const sharedTitles = getSharedTitleFields(settings);
            emit(EVENTS.PEER_STATUS, {
                peerId,
                status: 'heartbeat',
                username: settings.username,
                tabTitle: sharedTitles.tabTitle,
                mediaTitle: sharedTitles.mediaTitle,
                desynced: hcmDesynced
            });
        }
        if (currentRoom && currentTabId) {
            sendMessageToCurrentContent({ type: 'REQUEST_HEARTBEAT' }).catch(() => {});
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'MEDIA_FRAME_CANDIDATE_CHANGED') {
        const tabId = normalizeTabId(sender.tab?.id);
        if (tabId === null || tabId !== normalizeTabId(currentTabId)) {
            sendResponse({ status: 'ignored_stale_tab' });
            return;
        }
        // A page-driven notification must never surface as a handler failure.
        // Reporting it that way turned one unreachable player frame into an
        // endless error cascade in the popup.
        const activation = await refreshCurrentMediaTarget(tabId, {
            queueIfRunning: true,
            onlyIfTargetMoved: true
        }).catch(error => {
            addLog(`Media frame candidate refresh failed: ${error.message}`, 'warn');
            return { status: 'error', message: error.message };
        });
        // A layout change is exactly the shape of a rebuilt player frame, and a
        // new document carries no monitor, so the video it creates next would go
        // unreported. Do this on DOM/layout notifications, but skip when the
        // monitor was just installed to prevent a cyclic re-injection loop.
        if (message.reason !== 'monitor_installed') {
            await refreshMediaFrameMonitors(tabId);
        }
        sendResponse(activation || { status: 'invalid_tab' });
    } else if (message.type === 'MEDIA_FRAME_VISIBILITY') {
        if (!isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_stale_frame' });
            return;
        }
        if (message.visible !== false) {
            sendResponse({ status: 'ok' });
            return;
        }
        const tabId = normalizeTabId(sender.tab?.id);
        const activation = tabId === null
            ? null
            : await refreshCurrentMediaTarget(tabId, {
                queueIfRunning: true,
                onlyIfTargetMoved: true
            }).catch(error => {
                addLog(`Media frame visibility refresh failed: ${error.message}`, 'warn');
                return { status: 'error', message: error.message };
            });
        sendResponse(activation || { status: 'invalid_tab' });
    } else if (message.type === 'MEDIA_TARGET_REFRESH') {
        if (!isCurrentContentSender(sender)) {
            sendResponse({ status: 'ignored_stale_frame' });
            return;
        }
        const tabId = normalizeTabId(sender.tab?.id);
        const activation = tabId === null
            ? null
            : await refreshCurrentMediaTarget(tabId, {
                queueIfRunning: true,
                onlyIfTargetMoved: true
            }).catch(error => {
                addLog(`Media target refresh failed: ${error.message}`, 'warn');
                return { status: 'error', message: error.message };
            });
        sendResponse(activation || { status: 'invalid_tab' });
    } else if (message.type === 'CONTENT_BOOT') {
        if (sender.tab) {
            if (!isCurrentContentSender(sender)) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
        }
        requestCanonicalMediaRecoveryAttempt();
        // Content script re-injected, check if there's an active lobby
        if (episodeSyncV2) {
            sendResponse({ episodeSyncV2: { ...episodeSyncV2 }, lobbyActive: false });
        } else if (episodeLobby) {
            sendResponse({ lobbyActive: true, expectedTitle: episodeLobby.expectedTitle });
        } else {
            sendResponse({ lobbyActive: false });
        }
    } else if (message.type === 'CANCEL_EPISODE_LOBBY') {
        if (episodeSyncV2) {
            cancelEpisodeSyncV2('cancelled_by_user');
            sendResponse({ status: 'ok' });
        } else if (episodeLobby) {
            cancelEpisodeLobby('Cancelled by user');
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ error: 'No active lobby' });
        }
    } else {
        // Final fallback to prevent channel hanging
        sendResponse({ error: 'unhandled_message' });
    }
}

initTabManager({
    getCurrentTabId: () => currentTabId,
    reactivateCurrentTarget: tabId => refreshCurrentMediaTarget(tabId, {
        queueIfRunning: true,
        onlyIfTargetMoved: false
    }),
    ensureState,
    sendToCurrentContent: sendMessageToCurrentContent
});

// Initial Connect — only if user has an active room configuration
getSettings().then(settings => {
    connectIntent = !!settings.roomId;
    if (connectIntent) connect();
}).catch(() => connectIntent = false);
