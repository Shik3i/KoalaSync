import { EVENTS, CONTROL_MODES, CAPABILITIES, PROTOCOL_VERSION, OFFICIAL_SERVER_URL, OFFICIAL_SERVER_TOKEN, EPISODE_LOBBY_TIMEOUT, FORCE_SYNC_TIMEOUT, HEARTBEAT_INTERVAL } from './shared/constants.js';
import { generateUsername } from './shared/names.js';
import { loadLocale, getMessage, getSystemLanguage } from './i18n.js';
import { sameEpisode } from './episode-utils.js';
import { applyTitlePrivacyToPayload, sanitizeSharedTitle, sanitizeTabTitle, normalizeSendTabTitle, normalizeTitlePrivacyMode } from './title-privacy.js';
import { initTabManager } from './modules/tab-manager.js';
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
let isConnecting = false;
let peerId = null; // initialized via getPeerId()
let currentRoom = null;
let currentTabId = null;
let currentTabTitle = null; // New: for Smart Matching
let logs = [];
let history = []; // New: for Action History
let storageInitialized = false;
let pendingLogs = [];
let pendingHistory = [];
let eventQueue = [];
let flushTimer = null; // paces draining of eventQueue after (re)connect
let isNamespaceJoined = false;
let lastActionState = { action: null, senderId: null, timestamp: 0, acks: [] };
let localSeq = 0;                         // Monotonically increasing command sequence for this peer
const lastSeqBySender = {};               // senderId → last received seq (stale command guard)

// --- Host Control Mode ---
let controlMode = CONTROL_MODES.EVERYONE;  // 'everyone' | 'host-only'
let hostPeerId = null;                     // peerId of the room host (creator / fallback)
// Features the connected relay advertises in ROOM_DATA. Empty against an older
// relay (no capabilities field) → host-control UI/behavior stays unavailable.
let serverCapabilities = [];
function serverSupports(cap) { return Array.isArray(serverCapabilities) && serverCapabilities.includes(cap); }
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
            const done = () => { if (!resolved) { resolved = true; resolve(); } };

            const storageTimeout = setTimeout(() => {
                addLog('Storage restoration timed out, continuing with defaults', 'warn');
                storageInitialized = true;
                done();
            }, 10000);

            chrome.storage.session.get([
                'logs', 'history', 'currentRoom', 'lastActionState', 
                'eventQueue', 'isForceSyncInitiator', 'forceSyncAcks', 
                'forceSyncDeadline', 'reconnectFailed', 'reconnectStartTime', 'reconnectAttempts', 'currentTabId', 'currentTabTitle',
                'episodeLobby', 'localSeq', 'lastSeqBySender', 'expectedAcksCount', 'roomIdleSince', 'lastContentHeartbeatAt',
                'hcmDesynced'
            ], (data) => {
                clearTimeout(storageTimeout);
                if (data.expectedAcksCount !== undefined) expectedAcksCount = data.expectedAcksCount;
                if (data.currentTabId !== undefined) currentTabId = data.currentTabId;
                if (data.currentTabTitle !== undefined) currentTabTitle = data.currentTabTitle;
                // Merge data from storage with any early-arriving state
                // New entries (added during boot) must stay at the top (index 0)
                if (data.logs) logs = [...logs, ...data.logs].slice(0, 200);
                if (data.history) history = [...history, ...data.history].slice(0, 20);
                if (data.currentRoom) {
                    currentRoom = data.currentRoom;
                    // Host Control Mode: restore role/mode/capabilities from persisted room.
                    controlMode = currentRoom.controlMode || CONTROL_MODES.EVERYONE;
                    hostPeerId = currentRoom.hostPeerId || null;
                    controllers = Array.isArray(currentRoom.controllers) ? currentRoom.controllers : [];
                    serverCapabilities = Array.isArray(currentRoom.capabilities) ? currentRoom.capabilities : [];
                }
                if (data.hcmDesynced !== undefined) hcmDesynced = data.hcmDesynced;
                // L-2: enforce the desync invariant on restore — a persisted hcmDesynced=true
                // is stale if our restored role is no longer "gated guest" (e.g. we became
                // the host, or the room is in 'everyone'). Without this, the first heartbeat
                // after SW restart would broadcast a bogus Solo flag for up to 15s.
                hcmEnforceDesyncInvariant();
                if (data.lastActionState) lastActionState = data.lastActionState;
                
                if (data.eventQueue) eventQueue = [...eventQueue, ...data.eventQueue].slice(0, 50);
                if (data.isForceSyncInitiator !== undefined && isForceSyncInitiator === false) {
                    isForceSyncInitiator = data.isForceSyncInitiator;
                }
                if (data.forceSyncAcks) {
                    const mergedAcks = new Set([...forceSyncAcks, ...data.forceSyncAcks]);
                    forceSyncAcks = mergedAcks;
                }
                if (data.reconnectFailed !== undefined) reconnectFailed = data.reconnectFailed;
                if (data.reconnectStartTime) reconnectStartTime = data.reconnectStartTime;
                if (data.reconnectAttempts !== undefined) reconnectAttempts = data.reconnectAttempts;
                if (data.roomIdleSince !== undefined) roomIdleSince = data.roomIdleSince;
                if (data.lastContentHeartbeatAt !== undefined) lastContentHeartbeatAt = data.lastContentHeartbeatAt;

                // Recover Force Sync Timeout
                if (data.forceSyncDeadline) {
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
                if (data.episodeLobby && !episodeLobby) {
                    episodeLobby = data.episodeLobby;
                    const lobbyRemaining = (episodeLobby.createdAt + EPISODE_LOBBY_TIMEOUT) - Date.now();
                    if (lobbyRemaining > 0) {
                        episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout'), lobbyRemaining);
                    } else {
                        cancelEpisodeLobby('Timeout (recovered)');
                    }
                }

                if (data.localSeq !== undefined && !isNaN(data.localSeq)) localSeq = data.localSeq;
                if (data.lastSeqBySender && typeof data.lastSeqBySender === 'object') Object.assign(lastSeqBySender, data.lastSeqBySender);

                storageInitialized = true;
                
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

// --- Storage Utils ---

/**
 * Canonical peer data factory. All peer object construction must go through
 * here to guarantee a consistent shape with predictable null defaults.
 * @param {object} raw - Raw data from server event or heartbeat payload.
 * @returns {object} Normalized peer data object.
 */
function createPeerData(raw) {
    return {
        peerId:        raw.peerId        || null,
        username:      raw.username      || null,
        tabTitle:      raw.tabTitle      || null,
        mediaTitle:    raw.mediaTitle    || null,
        playbackState: raw.playbackState || null,
        currentTime:   raw.currentTime   != null ? raw.currentTime : null,
        volume:        raw.volume        != null ? raw.volume       : null,
        muted:         raw.muted         != null ? raw.muted        : null,
        desynced:      raw.desynced === true,   // HCM: peer is watching on their own
        lastHeartbeat: Date.now()
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
    const data = await chrome.storage.local.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'username', 'sendTabTitle', 'mediaTitlePrivacyMode', 'titlePrivacyMode']);
    let username = data.username;
    if (!username) {
        username = generateUsername();
        await chrome.storage.local.set({ username });
    }
    const legacyTitlePrivacyMode = normalizeTitlePrivacyMode(data.titlePrivacyMode);
    const mediaTitlePrivacyMode = normalizeTitlePrivacyMode(data.mediaTitlePrivacyMode || legacyTitlePrivacyMode);
    return {
        serverUrl: data.serverUrl || '',
        useCustomServer: data.useCustomServer || false,
        roomId: data.roomId || '',
        password: data.password || '',
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
    getSettings().then(settings => {
        if (!episodeLobby || episodeLobby.initiatorPeerId !== peerId) return;
        const expectedTitle = sanitizeSharedTitle(episodeLobby.expectedTitle, settings.mediaTitlePrivacyMode);
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
    'serverUrl', 'useCustomServer', 'roomId', 'password', 'username',
    'filterNoise', 'autoSyncNextEpisode', 'forceSyncMode',
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

function forceDisconnect() {
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
    isForceSyncInitiator = false;
    expectedAcksCount = 0;
    roomIdleSince = null;
    lastContentHeartbeatAt = null;
    forceSyncAcks.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    eventQueue = [];
    chrome.storage.session.set({
        isForceSyncInitiator: false,
        forceSyncAcks: [],
        forceSyncDeadline: null,
        expectedAcksCount: 0,
        eventQueue: [],
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

function clearTargetTabForIdle() {
    currentTabId = null;
    currentTabTitle = null;
    lastContentHeartbeatAt = null;
    if (currentRoom) {
        roomIdleSince = Date.now();
    }
    chrome.storage.session.set({ currentTabId, currentTabTitle, roomIdleSince, lastContentHeartbeatAt }).catch(() => {});
    updateBadgeStatus();
}

async function leaveRoomAfterIdleGrace(reason) {
    if (!currentRoom) return;
    connectIntent = false;
    reconnectFailed = false;
    reconnectAttempts = 0;
    chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
    emit(EVENTS.LEAVE_ROOM, { peerId });
    forceDisconnect();
    currentRoom = null;
    controlMode = CONTROL_MODES.EVERYONE;
    hostPeerId = null;
    controllers = [];
    serverCapabilities = [];
    hcmDesynced = false;
    // Notify content.js/popup BEFORE currentTabId is cleared so they can reset
    // any stale guest-side HCM state (dialog/badge/desync) — H-2.
    broadcastControlMode();
    currentTabId = null;
    currentTabTitle = null;
    roomIdleSince = null;
    lastContentHeartbeatAt = null;
    clearEpisodeLobbyState();
    await chrome.storage.session.set({
        currentRoom: null,
        currentTabId: null,
        currentTabTitle: null,
        roomIdleSince: null,
        lastContentHeartbeatAt: null,
        episodeLobby: null,
        hcmDesynced: false
    }).catch(() => {});
    await chrome.storage.local.set({ roomId: '', password: '' }).catch(() => {});
    addLog(reason, 'info');
    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
    updateBadgeStatus();
}

async function connect() {
    if (isConnecting) return;
    isConnecting = true;

    let finalUrl = '';
    try {
        // --- Phase 1: Storage ---
        let settings;
        try {
            if (!peerId) peerId = await getPeerId();
            settings = await getSettings();
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
            const url = new URL(finalUrl);
            url.pathname = '/socket.io/';
            url.searchParams.set('EIO', '4');
            url.searchParams.set('transport', 'websocket');
            url.searchParams.set('version', chrome.runtime.getManifest().version);
            url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);

            socket = new WebSocket(url.toString());
        } catch (e) {
            throw new Error(`[Connection Error] ${e.message}`);
        }

        // --- Phase 5: Event Listeners ---
        socket.onopen = () => {
            reconnectAttempts = 0;
            reconnectStartTime = null;
            reconnectFailed = false;
            addLog('WebSocket Connection Opened', 'success');
            chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null }).catch(() => {});
            isNamespaceJoined = false;
            socket.send('40');
        };

        socket.onmessage = async (event) => {
            await ensureState();
            const msg = event.data;
            if (msg === '2') {
                socket.send('3');
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
                const settings = await getSettings();
                if (settings.roomId) {
                    const sharedTitles = getSharedTitleFields(settings);
                    emit(EVENTS.JOIN_ROOM, { 
                        roomId: settings.roomId, 
                        password: settings.password,
                        peerId,
                        username: settings.username,
                        tabTitle: sharedTitles.tabTitle,
                        protocolVersion: PROTOCOL_VERSION
                    });
                }
                flushEventQueue();
            } else if (msg.startsWith('42')) {
                try {
                    const payload = JSON.parse(msg.substring(2));
                    try {
                        handleServerEvent(payload[0], payload[1]);
                    } catch (handlerErr) {
                        addLog(`Handler error for ${payload[0]}: ${handlerErr.message}`, 'error');
                    }
                } catch (_e) {
                    addLog(`Failed to parse message: ${msg}`, 'error');
                }
            }
        };

        socket.onclose = () => {
            isConnecting = false;
            isNamespaceJoined = false;
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
            if (currentRoom || connectIntent) {
                addLog('Disconnected. Scheduling reconnect...', 'warn');
                socket = null;
                scheduleReconnect();
            } else {
                addLog('Disconnected. No active session — staying disconnected.', 'info');
                socket = null;
            }
        };

        socket.onerror = () => {
            broadcastConnectionStatus('disconnected');
            const logType = reconnectAttempts > 1 ? 'error' : 'warn';
            addLog('WebSocket Error: Connection failed', logType);
        };

    } catch (e) {
        isConnecting = false;
        const logType = reconnectAttempts > 1 ? 'error' : 'warn';
        const errMsg = (e && e.message) ? e.message : String(e || 'Unknown connection error');
        addLog(errMsg, logType);
        broadcastConnectionStatus('disconnected');
        if (currentRoom || connectIntent) {
            scheduleReconnect();
        }
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
        if (!isNaN(tabId)) chrome.tabs.sendMessage(tabId, payload).catch(() => {});
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
    updateBadgeStatus();
}

function updateBadgeStatus() {
    const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
    const isReconnecting = !isConnected && reconnectAttempts > 0;
    const status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : (isReconnecting ? 'reconnecting' : 'disconnected'));

    if (status === 'reconnecting') {
        chrome.action.setBadgeText({ text: '...' });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else if (status === 'connecting') {
        chrome.action.setBadgeText({ text: '...' });
        chrome.action.setBadgeBackgroundColor({ color: '#fbbf24' });
    } else if (status === 'connected' && currentRoom && currentTabId) {
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
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

        const message = getMessage('TOAST_PEER_ACTION', { name: displayName, action: label }) + '.';

        chrome.notifications.create(`sync_${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'KoalaSync',
            message: message,
            priority: 1
        });
    });
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
    if (socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined) {
        const msg = `42${JSON.stringify([event, data])}`;
        try {
            socket.send(msg);
        } catch (e) {
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

function queueEvent(event, data) {
    eventQueue.push({ event, data });
    if (eventQueue.length > 50) {
        eventQueue.shift();
        addLog('Event queue cap reached, dropping oldest event', 'warn');
    }
    chrome.storage.session.set({ eventQueue });
}

/**
 * Drain the offline event queue in paced batches. A reconnect after a long
 * outage can leave up to 50 queued events; dumping them in one tick would
 * exceed the server's per-socket event budget and get us disconnected right
 * after rejoining. We send FLUSH_BATCH_SIZE events, then wait
 * FLUSH_BATCH_INTERVAL_MS before the next batch. Remaining events drain across
 * subsequent batches; if the connection drops mid-drain, the rest stay queued.
 */
function flushEventQueue() {
    if (flushTimer) return; // a drain is already in progress
    const drainBatch = () => {
        flushTimer = null;
        if (!socket || socket.readyState !== WebSocket.OPEN || !isNamespaceJoined) {
            return; // lost the connection — leave the rest queued for next connect
        }
        let sent = 0;
        while (eventQueue.length > 0 && sent < FLUSH_BATCH_SIZE) {
            const queuedMsg = eventQueue.shift();
            emit(queuedMsg.event, queuedMsg.data);
            sent++;
        }
        chrome.storage.session.set({ eventQueue }).catch(() => {});
        if (eventQueue.length > 0) {
            flushTimer = setTimeout(drainBatch, FLUSH_BATCH_INTERVAL_MS);
        }
    };
    drainBatch();
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

// --- Event Handlers ---
function handleServerEvent(event, data) {
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
        case EVENTS.ROOM_DATA:
            // Forward ROOM_DATA to popup (includes chatHistory)
            chrome.runtime.sendMessage({ type: 'ROOM_DATA', data }).catch(() => {});
            currentRoom = data;
            // Host Control Mode: adopt room role/mode on (re)join.
            controlMode = data.controlMode || CONTROL_MODES.EVERYONE;
            hostPeerId = data.hostPeerId || null;
            controllers = Array.isArray(data.controllers) ? data.controllers : [];
            serverCapabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
            hcmEnforceDesyncInvariant();
            broadcastControlMode();
            markRoomPotentiallyIdle();
            if (currentRoom && Array.isArray(currentRoom.peers)) {
                currentRoom.peers = currentRoom.peers.map(p => typeof p === 'object' ? createPeerData(p) : { peerId: p, username: null, tabTitle: null, mediaTitle: null, playbackState: null, currentTime: null, volume: null, muted: null, lastHeartbeat: Date.now() });
                
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

            // Recover server-tracked active Episode Lobby if present
            if (data && data.activeLobby && !episodeLobby) {
                episodeLobby = {
                    expectedTitle: data.activeLobby.expectedTitle,
                    initiatorPeerId: data.activeLobby.initiatorPeerId,
                    readyPeers: data.activeLobby.readyPeers,
                    createdAt: Date.now()
                };
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                addLog(`Recovered active episode lobby from server: "${episodeLobby.expectedTitle}"`, 'info');

                // Notify content script to start polling
                if (currentTabId) {
                    const tabId = parseInt(currentTabId);
                    if (!isNaN(tabId)) {
                        chrome.tabs.sendMessage(tabId, {
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
            chrome.runtime.sendMessage(joinStatusMsg).catch(() => {});
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, joinStatusMsg).catch(() => {});
                });
            });
            break;
        case EVENTS.CONTROL_MODE:
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
        case EVENTS.ERROR:
            isConnecting = false;
            // If we get a server error before successfully joining a room,
            // clear connectIntent to prevent an infinite reconnect loop.
            if (!currentRoom) {
                connectIntent = false;
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
            chrome.runtime.sendMessage(errStatusMsg).catch(() => {});
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, errStatusMsg).catch(() => {});
                });
            });
            break;
        case EVENTS.PLAY:
        case EVENTS.PAUSE:
        case EVENTS.SEEK:
        case EVENTS.FORCE_SYNC_PREPARE:
            if (data.senderId && typeof data.seq === 'number') {
                const lastSeq = lastSeqBySender[data.senderId];
                if (lastSeq !== undefined && data.seq <= lastSeq) {
                    addLog(`Ignored stale ${event} from ${data.senderId} (seq ${data.seq} <= ${lastSeq})`, 'warn');
                    break;
                }
                lastSeqBySender[data.senderId] = data.seq;
                _persistLastSeq();
            }
            if (data.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);
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
            if (data?.senderId && typeof data.seq === 'number') {
                const lastSeq = lastSeqBySender[data.senderId];
                if (lastSeq !== undefined && data.seq <= lastSeq) break;
                lastSeqBySender[data.senderId] = data.seq;
                _persistLastSeq();
            }
            if (data?.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);

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

                        // We were alone and now we're not — proactively push our
                        // current playback state so the newcomer syncs immediately
                        // instead of waiting up to a full heartbeat interval.
                        if (wasSolo && currentTabId) {
                            chrome.tabs.sendMessage(currentTabId, { type: 'REQUEST_HEARTBEAT' }).catch(() => {});
                        }

                        if (episodeLobby && episodeLobby.initiatorPeerId === peerId) {
                            emitEpisodeLobbyForCurrentPrivacy();
                        }
                    }
                } else if (data.status === 'left') {
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
                    }
                }
            }
            break;
        case EVENTS.EPISODE_LOBBY:
            if (data.senderId && data.expectedTitle) {
                addLog(`Episode lobby from ${data.senderId}: "${data.expectedTitle}"`, 'info');
                // If we already have a lobby for this same title, treat as dedup
                if (episodeLobby && sameEpisode(episodeLobby.expectedTitle, data.expectedTitle)) {
                    break; // Already tracking this lobby
                }
                // Cancel any existing lobby before starting a new one
                if (episodeLobby) clearEpisodeLobbyState();
                
                episodeLobby = {
                    expectedTitle: data.expectedTitle,
                    initiatorPeerId: data.senderId,
                    readyPeers: [data.senderId], // Initiator is already ready
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
                        chrome.tabs.sendMessage(tabId, {
                            type: 'EPISODE_LOBBY',
                            expectedTitle: data.expectedTitle
                        }).catch(() => {});
                    }
                }
            }
            break;
        case EVENTS.EPISODE_READY:
            if (episodeLobby && data.senderId) {
                if (!episodeLobby.readyPeers.includes(data.senderId)) {
                    episodeLobby.readyPeers.push(data.senderId);
                    persistEpisodeLobby();
                    broadcastLobbyUpdate();
                    addLog(`Episode ready from ${data.senderId} (${episodeLobby.readyPeers.length})`, 'info');
                    checkEpisodeLobbyCompletion();
                }
            }
            break;
        case EVENTS.EPISODE_LOBBY_CANCEL:
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
        case EVENTS.CHAT_MESSAGE:
            if (currentRoom && currentRoom.peers && data.senderId && data.text) {
                // Forward to popup
                const messagePayload = {
                    type: 'CHAT_MESSAGE_RECEIVED',
                    payload: {
                        id: data.id,
                        senderId: data.senderId,
                        username: data.username,
                        text: data.text,
                        timestamp: data.timestamp
                    }
                };
                chrome.runtime.sendMessage(messagePayload).catch(() => {});
            }
            break;
        case EVENTS.CHAT_TYPING:
            if (currentRoom && currentRoom.peers && data.senderId) {
                // Forward to popup
                const typingPayload = {
                    type: 'CHAT_TYPING_RECEIVED',
                    payload: {
                        senderId: data.senderId,
                        username: data.username,
                        isTyping: data.isTyping
                    }
                };
                chrome.runtime.sendMessage(typingPayload).catch(() => {});
            }
            break;
        case EVENTS.CHAT_READ:
            if (currentRoom && currentRoom.peers && data.senderId && data.targetId && data.messageId) {
                // Forward to popup
                const readPayload = {
                    type: 'CHAT_READ_RECEIVED',
                    payload: {
                        senderId: data.senderId,
                        targetId: data.targetId,
                        messageId: data.messageId
                    }
                };
                chrome.runtime.sendMessage(readPayload).catch(() => {});
            }
            break;
        case EVENTS.CHAT_SYSTEM:
            if (currentRoom && currentRoom.peers && data.text) {
                // Forward to popup
                const systemPayload = {
                    type: 'CHAT_SYSTEM_RECEIVED',
                    payload: {
                        id: data.id,
                        text: data.text,
                        timestamp: data.timestamp
                    }
                };
                chrome.runtime.sendMessage(systemPayload).catch(() => {});
            }
            break;
        case EVENTS.CHAT_BAN:
            if (currentRoom && currentRoom.peers && data.senderId && data.targetId) {
                currentRoom.chatBannedPeerIds = Array.isArray(data.chatBannedPeerIds) ? data.chatBannedPeerIds : [];
                if (storageInitialized) chrome.storage.session.set({ currentRoom });
                chrome.runtime.sendMessage({ type: 'CHAT_BAN_RECEIVED', payload: data }).catch(() => {});
            }
            break;
        case EVENTS.CHAT_UNBAN:
            if (currentRoom && currentRoom.peers && data.senderId && data.targetId) {
                currentRoom.chatBannedPeerIds = Array.isArray(data.chatBannedPeerIds) ? data.chatBannedPeerIds : [];
                if (storageInitialized) chrome.storage.session.set({ currentRoom });
                chrome.runtime.sendMessage({ type: 'CHAT_UNBAN_RECEIVED', payload: data }).catch(() => {});
            }
            break;
        default:
            addLog(`Received unknown event from server: ${event}`, 'warn');
            break;
    }
}

function executeForceSync() {
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
    addLog('Force Sync Executed', 'success');
}

// --- Episode Auto-Sync Lobby Functions ---
function persistEpisodeLobby() {
    if (storageInitialized) chrome.storage.session.set({ episodeLobby });
}

function broadcastLobbyUpdate() {
    chrome.runtime.sendMessage({ type: 'LOBBY_UPDATE', lobby: episodeLobby }).catch(() => {});
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
            chrome.tabs.sendMessage(tabId, { type: 'EPISODE_LOBBY_CANCEL' }).catch(() => {});
        }
    }
}

function cancelEpisodeLobby(reason) {
    if (!episodeLobby) return;
    const title = episodeLobby.expectedTitle;
    
    // Broadcast cancellation to room
    emit(EVENTS.EPISODE_LOBBY_CANCEL, { peerId });

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

    const syncPayload = { targetTime: 0.0 };
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
    const peers = Array.isArray(currentRoom.peers) ? currentRoom.peers : [];
    // M-3: desynced peers (watching on their own) sit out the lobby — their content
    // script ignores EPISODE_LOBBY and never reports ready. Don't let them block
    // completion: count only peers who actually participate.
    const participatingCount = peers.filter(p => !(typeof p === 'object' && p.desynced)).length;
    if (episodeLobby.readyPeers.length >= participatingCount) {
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

async function routeToContent(action, payload) {
    if (!currentTabId) return;

    const tabId = parseInt(currentTabId);
    if (isNaN(tabId)) return;

    const actionTimestamp = payload?.actionTimestamp || Date.now();
    const commandSenderId = payload?.senderId || null;

    _routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, 0);
}

function getTabVideoState(tabId) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_STATE' }, (res) => {
            if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
                return;
            }
            resolve(res);
        });
    });
}

async function getReadyTabVideoState(tabId) {
    let state = await getTabVideoState(tabId);
    if (!state || state.error) {
        await injectContentScript(tabId);
        await new Promise(resolve => setTimeout(resolve, 250));
        state = await getTabVideoState(tabId);
    }
    return state;
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

function shouldUsePageApiSeek(url) {
    return typeof globalThis.koalaFindPageApiSeekProvider === 'function' &&
        !!globalThis.koalaFindPageApiSeekProvider(url);
}

function installPageApiSeekBridge() {
    if (window.__koalaPageApiSeekBridgeInstalled) return;
    window.__koalaPageApiSeekBridgeInstalled = true;

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

    function seekWithPageApi(time) {
        const match = currentMatch();
        if (!match) return;

        try {
            if (match.provider === 'netflix') {
                const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
                const ids = videoPlayer?.getAllPlayerSessionIds?.();
                const sessionId = ids ? ids[0] : null;
                const player = sessionId ? videoPlayer.getVideoPlayerBySessionId(sessionId) : null;
                player?.seek(Math.round(time * 1000));
            } else if (match.provider === 'disney') {
                const mp = disneyMediaPlayer();
                if (mp && typeof mp.seek === 'function') mp.seek(Math.round(time * 1000));
            }
        } catch (_e) {
            // Player not ready or private API changed; the next sync tick can retry.
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__koalaPageApiSeek !== 1 || data.kind !== 'seek' || typeof data.time !== 'number') return;
        seekWithPageApi(data.time);
    });

    // Disney+'s <video> currentTime is blob-relative and its scrubber lags, so
    // the isolated-world content script can't read an accurate position. Push
    // the real playhead/duration (seconds) from the page's media player.
    setInterval(() => {
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
}

function setPageApiSeekEnabled(enabled) {
    window.KOALA_PAGE_API_SEEK_ENABLED = enabled === true;
}

async function injectContentScript(tabId) {
    let needsPageApiSeek = false;
    let pageApiSeekReady = false;
    try {
        const tab = await chrome.tabs.get(tabId);
        const url = tab?.url || '';
        needsPageApiSeek = shouldUsePageApiSeek(url);
    } catch (_e) {
        // Fall through to the generic content script injection.
    }

    if (needsPageApiSeek) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                files: ['page-api-seek-overrides.js']
            });
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: installPageApiSeekBridge
            });
            pageApiSeekReady = true;
        } catch (err) {
            addLog(`Page API seek bridge injection failed: ${err.message}`, 'warn');
        }
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['page-api-seek-overrides.js']
    });
    await chrome.scripting.executeScript({
        target: { tabId },
        func: setPageApiSeekEnabled,
        args: [pageApiSeekReady]
    });
    return chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
    });
}

function _routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, retries) {
    chrome.tabs.sendMessage(tabId, { 
        type: 'SERVER_COMMAND',
        action,
        payload,
        actionTimestamp,
        commandSenderId
    }).catch(err => {
        if (retries >= 3) {
            addLog(`Content Script not responding in tab ${tabId} after ${retries} retries`, 'warn');
            clearTargetTabForIdle();
            return;
        }
        if (err.message.includes('Receiving end does not exist') || err.message.includes('Extension context invalidated')) {
            injectContentScript(tabId).then(() => {
                setTimeout(() => _routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, retries + 1), 500);
            }).catch(_err => {
                addLog(`Auto-reinject failed for tab ${tabId}`, 'warn');
            });
        } else {
            addLog(`Content Script not responding in tab ${tabId}`, 'warn');
            clearTargetTabForIdle();
        }
    });
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
        addLog(`Switching rooms: leaving ${currentRoom.roomId} to join ${newRoomId}`, 'info');
        forceDisconnect();
        currentRoom = null;
        controlMode = CONTROL_MODES.EVERYONE;
        hostPeerId = null;
        controllers = [];
        serverCapabilities = [];
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

function resetAudioProcessingInTab(tabId) {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { action: 'RESET_AUDIO_PROCESSING' }).catch(() => {});
}

async function applyAudioSettingsToTab(tabId) {
    if (!tabId) return;
    // Local-only: audioSettings are never read from storage.sync.
    const data = await chrome.storage.local.get(['audioSettings']);
    chrome.tabs.sendMessage(tabId, {
        action: 'APPLY_AUDIO_SETTINGS',
        settings: data.audioSettings
    }).catch(() => {});
}

// --- Extension Message Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleAsyncMessage(message, sender, sendResponse);
    return true; // Keep channel open for async responses
});

async function handleAsyncMessage(message, sender, sendResponse) {
    if (!message) return;
    await ensureState();

    if (message.type === 'CONNECT') {
        const settings = await getSettings();
        connectIntent = !!settings.roomId;
        const desiredUrl = resolveServerUrl(settings);

        if (settings.roomId && currentRoom && currentRoom.roomId === settings.roomId && socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined && desiredUrl === currentServerUrl) {
            broadcastConnectionStatus('connected');
            const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, { type: 'JOIN_STATUS', success: true, message: 'Already in room' }).catch(() => {});
            }
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
                protocolVersion: PROTOCOL_VERSION
            });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'RETRY_CONNECT') {
        connectIntent = true;
        reconnectFailed = false;
        reconnectStartTime = null;
        reconnectAttempts = 0;
        chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
        forceDisconnect();
        connect();
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_STATUS') {
        const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
        const isReconnecting = !isConnected && reconnectAttempts > 0;
        let status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : (isReconnecting ? 'reconnecting' : 'disconnected'));
        // Distinguish the normal "not in a room" resting state from a real drop.
        if (status === 'disconnected' && !currentRoom && !connectIntent) status = 'idle';
        sendResponse({ 
            status, 
            peerId, 
            peers: currentRoom ? currentRoom.peers : [],
            lastActionState,
            targetTabId: currentTabId,
            episodeLobby: episodeLobby,
            reconnectAttempts,
            reconnectSlowMode: reconnectFailed,
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
            chatSupported: serverSupports(CAPABILITIES.CHAT),
            chatHistory: currentRoom ? (currentRoom.chatHistory || []) : [],
            chatBannedPeerIds: currentRoom ? (currentRoom.chatBannedPeerIds || []) : []
        });
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
        if (sender.tab && currentTabId && currentTabId !== sender.tab.id) {
            sendResponse({ status: 'ignored_unselected_tab' });
            return;
        }
        // Mirrored into heartbeats so the host's UI can show "Solo" instead of
        // silently waiting for ACKs that will never come. Persisted so the
        // heartbeat survives SW restarts (idle timeout, crash).
        hcmDesynced = !!message.desynced;
        if (storageInitialized) chrome.storage.session.set({ hcmDesynced });
        sendResponse({ status: 'ok' });
    } else if (message.type === 'LEAVE_ROOM') {
        connectIntent = false;
        reconnectFailed = false;
        reconnectAttempts = 0;
        chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
        resetAudioProcessingInTab(currentTabId);
        emit(EVENTS.LEAVE_ROOM, { peerId });
        currentRoom = null;
        controlMode = CONTROL_MODES.EVERYONE;
        hostPeerId = null;
        controllers = [];
        serverCapabilities = [];
        hcmDesynced = false;
        // Notify content.js/popup BEFORE currentTabId is cleared so they drop any
        // stale guest-side HCM state (dialog/badge/desync) — H-2/H-3.
        broadcastControlMode();
        currentTabId = null;
        currentTabTitle = null;
        roomIdleSince = null;
        lastContentHeartbeatAt = null;

        updateBadgeStatus();
        
        isForceSyncInitiator = false;
        forceSyncAcks.clear();
        expectedAcksCount = 0;
        if (forceSyncTimeout) clearTimeout(forceSyncTimeout);

        // Cancel any active episode lobby
        clearEpisodeLobbyState();

        chrome.storage.session.set({ 
            currentRoom: null,
            currentTabId: null,
            currentTabTitle: null,
            roomIdleSince: null,
            lastContentHeartbeatAt: null,
            isForceSyncInitiator: false,
            forceSyncAcks: [],
            forceSyncDeadline: null,
            episodeLobby: null,
            expectedAcksCount: 0,
            hcmDesynced: false
        });
        chrome.storage.local.set({ roomId: '', password: '' }).catch(() => {});
        addLog('Left Room', 'info');
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
        forceDisconnect();
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
        const { roomId: rawRoomId, password, useCustomServer, serverUrl } = message;
        const roomId = typeof rawRoomId === 'string' ? rawRoomId.replace(/[^a-zA-Z0-9\-]/g, '') : '';
        if (!roomId) {
            const errMsg = { type: 'JOIN_STATUS', success: false, message: 'Invalid room ID' };
            chrome.runtime.sendMessage(errMsg).catch(() => {});
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, errMsg).catch(() => {}));
            });
            sendResponse({ status: 'invalid_room_id' });
            return;
        }
        connectIntent = true;
        chrome.storage.local.set({ 
            roomId, 
            password,
            useCustomServer: !!useCustomServer,
            serverUrl: serverUrl || ''
        }, async () => {
            const settings = await getSettings();
            const desiredUrl = resolveServerUrl(settings);

            if (roomId && currentRoom && currentRoom.roomId === roomId && socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined && desiredUrl === currentServerUrl) {
                broadcastConnectionStatus('connected');
                const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
                for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, { type: 'JOIN_STATUS', success: true, message: 'Already in room' }).catch(() => {});
                }
                sendResponse({ status: 'already_joined' });
                return;
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
                    protocolVersion: PROTOCOL_VERSION
                });
            }
            addLog(`Joining room via link: ${roomId}`, 'info');
            sendResponse({ status: 'ok' });
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
        const { tabId } = message;
        if (!tabId) {
            sendResponse({ error: 'No tabId provided' });
            return;
        }
        chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_STATE' }, (res) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse(res);
            }
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
        const processEvent = async () => {
            // Host Control Mode (sender-side): a non-controller in host-only mode must
            // not drive the room. Don't broadcast; hand the action back to content.js so
            // it can snap the local player back / offer desync.
            // Defensive: require a known hostPeerId (L-6) — otherwise the actual
            // owner would gate themselves if state ever becomes inconsistent.
            if (controlMode === CONTROL_MODES.HOST_ONLY && hostPeerId && !amController() &&
                HOST_ONLY_GATED_ACTIONS.includes(message.action)) {
                addLog(`Host-only: blocked local ${message.action} (you are a guest)`, 'warn');
                if (sender.tab && sender.tab.id) {
                    chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'HOST_BLOCKED',
                        action: message.action,
                        target: getHostSyncTarget()
                    }).catch(() => {});
                }
                sendResponse({ status: 'blocked_host_only' });
                return;
            }

            // Live solo check — recomputed from the current peer list on every
            // event (the list is updated synchronously on PEER_STATUS join/leave),
            // never cached, so the instant a peer joins we resume sending.
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            const hasOtherPeers = otherCount > 0;

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

            const timestamp = Date.now();
            localSeq++;
            chrome.storage.session.set({ localSeq });
            updateLastAction(message.action, 'You', timestamp);
            
            const hasPlaybackTime = Number.isFinite(payload.currentTime) || Number.isFinite(payload.targetTime);
            if (!sender?.tab && (message.action === EVENTS.PLAY || message.action === EVENTS.PAUSE) && !hasPlaybackTime) {
                const tabId = currentTabId ? parseInt(currentTabId) : NaN;
                if (!isNaN(tabId)) {
                    const state = await getReadyTabVideoState(tabId);
                    if (state && !state.error && state.found && Number.isFinite(state.currentTime)) {
                        payload.currentTime = state.currentTime;
                    }
                }
            }
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

            if (!sender?.tab && (message.action === EVENTS.PLAY || message.action === EVENTS.PAUSE || message.action === EVENTS.SEEK)) {
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

            const isNonEssentialEvent = message.action === EVENTS.PLAY || message.action === EVENTS.PAUSE || message.action === EVENTS.SEEK;
            if (isNonEssentialEvent && !hasOtherPeers) {
                sendResponse({ status: 'ok_solo' });
                return;
            }
            
            const settings = await getSettings();
            const outboundPayload = withTitlePrivacy(message.payload, settings, ['mediaTitle']);
            emit(message.action, { ...outboundPayload, peerId });
            sendResponse({ status: 'ok' });
        };

        if (sender.tab) {
            const senderTabId = sender.tab.id;
            
            if (!currentTabId || currentTabId !== senderTabId) {
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
            emit(EVENTS.FORCE_SYNC_ACK, { peerId, seq: localSeq });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CMD_ACK') {
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
            const senderTabId = sender.tab.id;
            
            if (!currentTabId || currentTabId !== senderTabId) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
            
            currentTabTitle = sender.tab.title ? sender.tab.title.substring(0, 50) : null;
            chrome.storage.session.set({ currentTabTitle });
            updateBadgeStatus();
        }

        markRoomUseful();
        getSettings().then(settings => {
            const sharedTitles = getSharedTitleFields(settings, message.payload?.mediaTitle);
            const statusPayload = {
                ...message.payload,
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
                    me.playbackState = message.payload?.playbackState;
                    me.currentTime = message.payload?.currentTime;
                    me.volume = message.payload?.volume;
                    me.muted = message.payload?.muted;
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
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId)) {
            sendResponse({ status: 'invalid_tab' });
            return true;
        }

        injectContentScript(tabId).then(() => {
            sendResponse({ status: 'ok' });
        }).catch(err => {
            addLog(`Failed to inject into tab: ${err.message}`, 'warn');
            sendResponse({ status: 'error', message: err.message });
        });
        return true;
    } else if (message.type === 'SET_TARGET_TAB') {
        const previousTabId = currentTabId;
        currentTabId = message.tabId;
        currentTabTitle = message.tabTitle;
        lastContentHeartbeatAt = null;
        if (currentRoom) {
            roomIdleSince = Date.now();
        }
        chrome.storage.session.set({ currentTabId, currentTabTitle, roomIdleSince, lastContentHeartbeatAt });
        updateBadgeStatus();

        if (previousTabId && previousTabId !== currentTabId) {
            resetAudioProcessingInTab(previousTabId);
        }
        
        if (currentTabId) {
            const selectedTabId = currentTabId;
            injectContentScript(selectedTabId)
                .then(() => applyAudioSettingsToTab(selectedTabId))
                .catch(err => {
                    addLog(`Failed to inject into tab: ${err.message}`, 'warn');
                });
        }
        
        sendResponse({ status: 'ok' });
    } else if (message.type === 'LOG') {
        addLog(`[Content] ${message.message}`, message.level || 'info');
        sendResponse({ status: 'ok' });
    } else if (message.type === 'EPISODE_CHANGED') {
        // Content script detected an episode transition
        if (sender.tab) {
            const senderTabId = sender.tab.id;
            if (!currentTabId || currentTabId !== senderTabId) {
                sendResponse({ status: 'ignored_unselected_tab' });
                return;
            }
        }

        const newTitle = message.payload && message.payload.newTitle;
        if (!newTitle) {
            sendResponse({ status: 'no_title' });
            return;
        }

        const settings = await getSettings();
        const lobbyTitle = sanitizeSharedTitle(newTitle, settings.mediaTitlePrivacyMode);
        if (!lobbyTitle) {
            addLog(`Episode change detected but media title sharing is ${settings.mediaTitlePrivacyMode}; not creating a lobby.`, 'info');
            sendResponse({ status: 'title_privacy_no_lobby' });
            return;
        }

        // Check setting
        const epSettings = await chrome.storage.local.get(['autoSyncNextEpisode']);
        if (epSettings.autoSyncNextEpisode === false) {
            addLog(`Episode change detected ("${lobbyTitle}") but Auto-Sync is disabled.`, 'info');
            sendResponse({ status: 'disabled' });
            return;
        }

        // Host Control Mode: a gated guest must NOT initiate an episode lobby — the
        // server drops the guest's EPISODE_LOBBY, so the lobby would never complete
        // and the guest would self-pause (PAUSE_FOR_LOBBY) into a 60s freeze. In
        // host-only the controllers (owner + co-hosts) drive episode sync; a plain
        // guest just follows / snaps back. Use amController() for parity with the
        // CONTENT_EVENT gate and the server's controllers-based check.
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

        // If lobby already exists for this title, just mark self ready
        if (episodeLobby && sameEpisode(episodeLobby.expectedTitle, lobbyTitle)) {
            if (!episodeLobby.readyPeers.includes(peerId)) {
                episodeLobby.readyPeers.push(peerId);
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                emit(EVENTS.EPISODE_READY, { peerId, title: lobbyTitle });
                checkEpisodeLobbyCompletion();
            }
            sendResponse({ status: 'ready_sent' });
            return;
        }

        // Cancel any existing lobby for a different episode
        if (episodeLobby) clearEpisodeLobbyState();

        // Create new lobby
        episodeLobby = {
            expectedTitle: lobbyTitle,
            initiatorPeerId: peerId,
            readyPeers: [peerId], // We are already ready
            createdAt: Date.now()
        };
        persistEpisodeLobby();
        broadcastLobbyUpdate();
        addLog(`Episode lobby created: "${lobbyTitle}"`, 'info');

        // Tell content script to pause the video and start polling
        // (This is the only place we pause — after confirming the feature is enabled)
        if (sender.tab && sender.tab.id) {
            chrome.tabs.sendMessage(sender.tab.id, {
                type: 'PAUSE_FOR_LOBBY',
                expectedTitle: lobbyTitle
            }).catch(() => {});
        }

        // Broadcast to room
        emit(EVENTS.EPISODE_LOBBY, { peerId, expectedTitle: lobbyTitle });

        // Start timeout (Q1: Option B — cancel on timeout)
        episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout — not all peers loaded the episode'), EPISODE_LOBBY_TIMEOUT);

        // Immediate check — maybe we're the only one in the room
        checkEpisodeLobbyCompletion();

        sendResponse({ status: 'lobby_created' });
    } else if (message.type === 'EPISODE_READY_LOCAL') {
        // Content script confirmed it loaded the lobby episode
        if (episodeLobby && message.payload && sameEpisode(message.payload.title, episodeLobby.expectedTitle)) {
            if (!episodeLobby.readyPeers.includes(peerId)) {
                const settings = await getSettings();
                const readyTitle = sanitizeSharedTitle(message.payload.title, settings.mediaTitlePrivacyMode);
                episodeLobby.readyPeers.push(peerId);
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                emit(EVENTS.EPISODE_READY, { peerId, title: readyTitle });
                addLog(`Local episode ready: "${readyTitle || episodeLobby.expectedTitle}"`, 'success');
                checkEpisodeLobbyCompletion();
            }
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'TITLE_PRIVACY_CHANGED') {
        const settings = await getSettings();
        if (episodeLobby && episodeLobby.initiatorPeerId === peerId) {
            const nextLobbyTitle = sanitizeSharedTitle(episodeLobby.expectedTitle, settings.mediaTitlePrivacyMode);
            if (!nextLobbyTitle || nextLobbyTitle !== episodeLobby.expectedTitle) {
                cancelEpisodeLobby('Title privacy changed');
            }
        }
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
            chrome.tabs.sendMessage(currentTabId, { type: 'REQUEST_HEARTBEAT' }).catch(() => {});
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CONTENT_BOOT') {
        // Content script re-injected, check if there's an active lobby
        if (episodeLobby) {
            sendResponse({ lobbyActive: true, expectedTitle: episodeLobby.expectedTitle });
        } else {
            sendResponse({ lobbyActive: false });
        }
    } else if (message.type === 'CANCEL_EPISODE_LOBBY') {
        if (episodeLobby) {
            cancelEpisodeLobby('Cancelled by user');
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ error: 'No active lobby' });
        }
    } else if (message.type === 'CHAT_MESSAGE') {
        // Forward chat message to the server
        if (currentRoom && message.payload && message.payload.text) {
            const payload = {
                username: message.payload.username,
                text: message.payload.text
            };
            emit(EVENTS.CHAT_MESSAGE, payload);
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ status: 'error', message: 'Not in a room or invalid payload' });
        }
    } else if (message.type === 'CHAT_TYPING') {
        // Forward typing indicator to the server
        if (currentRoom && message.payload) {
            const payload = {
                username: message.payload.username,
                isTyping: message.payload.isTyping
            };
            emit(EVENTS.CHAT_TYPING, payload);
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ status: 'error', message: 'Not in a room or invalid payload' });
        }
    } else if (message.type === 'CHAT_READ') {
        // Forward read receipt to the server
        if (currentRoom && message.payload) {
            const payload = {
                targetId: message.payload.targetId,
                messageId: message.payload.messageId
            };
            emit(EVENTS.CHAT_READ, payload);
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ status: 'error', message: 'Not in a room or invalid payload' });
        }
    } else if (message.type === 'CHAT_BAN' || message.type === 'CHAT_UNBAN') {
        if (!amHost() && !amController()) {
            sendResponse({ status: 'error', message: 'Insufficient permissions' });
            return;
        }
        if (currentRoom && message.payload) {
            const payload = {
                targetId: message.payload.targetId
            };
            emit(message.type === 'CHAT_BAN' ? EVENTS.CHAT_BAN : EVENTS.CHAT_UNBAN, payload);
            sendResponse({ status: 'ok' });
        } else {
            sendResponse({ status: 'error', message: 'Not in a room or invalid payload' });
        }
    } else {
        // Final fallback to prevent channel hanging
        sendResponse({ error: 'unhandled_message' });
    }
}

initTabManager({
    getCurrentTabId: () => currentTabId,
    setCurrentTabId: (val) => { currentTabId = val; },
    setCurrentTabTitle: (val) => { currentTabTitle = val; },
    setLastContentHeartbeatAt: (val) => { lastContentHeartbeatAt = val; },
    setRoomIdleSince: (val) => { roomIdleSince = val; },
    getCurrentRoom: () => currentRoom,
    getPeerId: () => peerId,
    getStorageInitialized: () => storageInitialized,
    updateBadgeStatus,
    addLog,
    getSettings,
    emit,
    applyAudioSettingsToTab,
    injectContentScript,
    ensureState,
    EVENTS
});

// Initial Connect — only if user has an active room configuration
getSettings().then(settings => {
    connectIntent = !!settings.roomId;
    if (connectIntent) connect();
}).catch(() => connectIntent = false);
