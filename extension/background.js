import { EVENTS, PROTOCOL_VERSION, EPISODE_LOBBY_TIMEOUT, FORCE_SYNC_TIMEOUT } from './shared/constants.js';
import { generateUsername } from './shared/names.js';
import { loadLocale, getMessage, getSystemLanguage } from './i18n.js';
import { sameEpisode } from './episode-utils.js';
import { WorkerContext } from './modules/worker-context.js';
import { SocketManager } from './modules/socket-manager.js';
import { TabManager } from './modules/tab-manager.js';

// --- Uninstall URL Initialization ---
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install' || details.reason === 'update') {
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
                console.error("Invalid uninstall URL provided:", err);
            }
        }
    }
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
let isNamespaceJoined = false;
let lastActionState = { action: null, senderId: null, timestamp: 0, acks: [] };
let localSeq = 0;                         // Monotonically increasing command sequence for this peer
const lastSeqBySender = {};               // senderId → last received seq (stale command guard)
const activePorts = new Set();            // New: track active content ports for keep-alive
let expectedAcksCount = 0;                // Snapshot of peerCount when initiating Force Sync

// --- Ping / Latency ---
let pingInterval = null;
let pingTimeout = null;
let pendingPingT = null;
let currentPingMs = null;

const context = new WorkerContext({
    socket: { get: () => socket, set: (val) => socket = val },
    isConnecting: { get: () => isConnecting, set: (val) => isConnecting = val },
    peerId: { get: () => peerId, set: (val) => peerId = val },
    currentRoom: { get: () => currentRoom, set: (val) => currentRoom = val },
    currentTabId: { get: () => currentTabId, set: (val) => currentTabId = val },
    currentTabTitle: { get: () => currentTabTitle, set: (val) => currentTabTitle = val },
    logs: { get: () => logs, set: (val) => logs = val },
    history: { get: () => history, set: (val) => history = val },
    storageInitialized: { get: () => storageInitialized, set: (val) => storageInitialized = val },
    pendingLogs: { get: () => pendingLogs, set: (val) => pendingLogs = val },
    pendingHistory: { get: () => pendingHistory, set: (val) => pendingHistory = val },
    eventQueue: { get: () => eventQueue, set: (val) => eventQueue = val },
    isNamespaceJoined: { get: () => isNamespaceJoined, set: (val) => isNamespaceJoined = val },
    lastActionState: { get: () => lastActionState, set: (val) => lastActionState = val },
    localSeq: { get: () => localSeq, set: (val) => localSeq = val },
    lastSeqBySender: { get: () => lastSeqBySender },
    activePorts: { get: () => activePorts },
    expectedAcksCount: { get: () => expectedAcksCount, set: (val) => expectedAcksCount = val },
    reconnectTimer: { get: () => reconnectTimer, set: (val) => reconnectTimer = val },
    reconnectStartTime: { get: () => reconnectStartTime, set: (val) => reconnectStartTime = val },
    reconnectFailed: { get: () => reconnectFailed, set: (val) => reconnectFailed = val },
    reconnectAttempts: { get: () => reconnectAttempts, set: (val) => reconnectAttempts = val },
    currentServerUrl: { get: () => currentServerUrl, set: (val) => currentServerUrl = val },
    roomIdleSince: { get: () => roomIdleSince, set: (val) => roomIdleSince = val },
    lastContentHeartbeatAt: { get: () => lastContentHeartbeatAt, set: (val) => lastContentHeartbeatAt = val },
    connectIntent: { get: () => connectIntent, set: (val) => connectIntent = val },
    isForceSyncInitiator: { get: () => isForceSyncInitiator, set: (val) => isForceSyncInitiator = val },
    forceSyncAcks: { get: () => forceSyncAcks, set: (val) => forceSyncAcks = val },
    forceSyncTimeout: { get: () => forceSyncTimeout, set: (val) => forceSyncTimeout = val },
    episodeLobby: { get: () => episodeLobby, set: (val) => episodeLobby = val },
    episodeLobbyTimeout: { get: () => episodeLobbyTimeout, set: (val) => episodeLobbyTimeout = val },
    pingInterval: { get: () => pingInterval, set: (val) => pingInterval = val },
    pingTimeout: { get: () => pingTimeout, set: (val) => pingTimeout = val },
    pendingPingT: { get: () => pendingPingT, set: (val) => pendingPingT = val },
    currentPingMs: { get: () => currentPingMs, set: (val) => currentPingMs = val }
});

const socketManager = new SocketManager(context, {
    addLog,
    addToHistory,
    handleServerEvent,
    updateBadgeStatus,
    getSettings,
    getPeerId
});

const tabManager = new TabManager(context, {
    addLog,
    updateBadgeStatus,
    leaveRoomAfterIdleGrace,
    emit
});

// --- Keep-Alive Port Listener ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepAlive') {
        activePorts.add(port);
        port.onDisconnect.addListener(() => {
            activePorts.delete(port);
        });
    }
});

function _persistLastSeq() {
    if (storageInitialized) chrome.storage.session.set({ lastSeqBySender });
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
                'episodeLobby', 'localSeq', 'lastSeqBySender', 'expectedAcksCount', 'roomIdleSince', 'lastContentHeartbeatAt'
            ], (data) => {
                clearTimeout(storageTimeout);
                if (data.expectedAcksCount !== undefined) expectedAcksCount = data.expectedAcksCount;
                if (data.currentTabId !== undefined) currentTabId = data.currentTabId;
                if (data.currentTabTitle !== undefined) currentTabTitle = data.currentTabTitle;
                // Merge data from storage with any early-arriving state
                // New entries (added during boot) must stay at the top (index 0)
                if (data.logs) logs = [...logs, ...data.logs].slice(0, 200);
                if (data.history) history = [...history, ...data.history].slice(0, 20);
                if (data.currentRoom) currentRoom = data.currentRoom;
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
    const newId = self.crypto.randomUUID().substring(0, 8);
    await chrome.storage.local.set({ peerId: newId });
    return newId;
}

async function getSettings() {
    // Try local (per-device) first, fall back to sync for migration
    let data = await chrome.storage.local.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'username']);
    let migrated = false;
    if (!data.username) {
        const syncData = await chrome.storage.sync.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'username']);
        if (syncData.username || syncData.roomId) {
            data = syncData;
            migrated = true;
        }
    }
    let username = data.username;
    if (!username) {
        username = generateUsername();
    }
    if (migrated) {
        await chrome.storage.local.set({ 
            serverUrl: data.serverUrl || '',
            useCustomServer: data.useCustomServer || false,
            roomId: data.roomId || '',
            password: data.password || '',
            username
        });
    } else if (!data.username) {
        await chrome.storage.local.set({ username });
    }
    return {
        serverUrl: data.serverUrl || '',
        useCustomServer: data.useCustomServer || false,
        roomId: data.roomId || '',
        password: data.password || '',
        username
    };
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
    return socketManager.resolveServerUrl(settings);
}

function forceDisconnect() {
    socketManager.forceDisconnect();
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


async function leaveRoomAfterIdleGrace(reason) {
    if (!currentRoom) return;
    connectIntent = false;
    reconnectFailed = false;
    reconnectAttempts = 0;
    chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
    emit(EVENTS.LEAVE_ROOM, { peerId });
    forceDisconnect();
    currentRoom = null;
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
        episodeLobby: null
    }).catch(() => {});
    await chrome.storage.local.set({ roomId: '', password: '' }).catch(() => {});
    addLog(reason, 'info');
    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
    updateBadgeStatus();
}

async function connect() {
    await socketManager.connect();
}


function broadcastConnectionStatus(status) {
    socketManager.broadcastConnectionStatus(status);
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



// Slow reconnect logic is now handled in the keepAlive alarm

function emit(event, data) {
    socketManager.emit(event, data);
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


// --- Event Handlers ---
function handleServerEvent(event, data) {
    if (!data) {
        addLog(`Ignored server event ${event} due to empty payload`, 'warn');
        return;
    }
    switch (event) {
        case EVENTS.ROOM_DATA:
            currentRoom = data;
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
                        delete lastSeqBySender[data.peerId];
                        _persistLastSeq();
                        
                        currentRoom.peers.push(createPeerData(data));
                        if (storageInitialized) chrome.storage.session.set({ currentRoom });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});

                        if (episodeLobby && episodeLobby.initiatorPeerId === peerId) {
                            emit(EVENTS.EPISODE_LOBBY, { peerId, expectedTitle: episodeLobby.expectedTitle });
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
    const peerCount = currentRoom.peers ? currentRoom.peers.length : 1;
    if (episodeLobby.readyPeers.length >= peerCount) {
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
    await tabManager.routeToContent(action, payload);
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
            // Heartbeat Logic: Always include identity metadata
            const settings = await getSettings();
            emit(EVENTS.PEER_STATUS, { 
                peerId, 
                status: 'heartbeat',
                username: settings.username,
                tabTitle: currentTabTitle
            });
        }
    }
});

function leaveOldRoomIfSwitching(newRoomId) {
    if (currentRoom && currentRoom.roomId !== newRoomId) {
        addLog(`Switching rooms: leaving ${currentRoom.roomId} to join ${newRoomId}`, 'info');
        forceDisconnect();
        currentRoom = null;
        if (storageInitialized) chrome.storage.session.set({ currentRoom: null });
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
    tabManager.resetAudioProcessingInTab(tabId);
}

async function applyAudioSettingsToTab(tabId) {
    await tabManager.applyAudioSettingsToTab(tabId);
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
            emit(EVENTS.JOIN_ROOM, { 
                roomId: settings.roomId, 
                password: settings.password,
                peerId,
                username: settings.username,
                tabTitle: currentTabTitle,
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
            roomPassword: currentRoom ? currentRoom.password : null,
            ping: currentPingMs
        });
    } else if (message.type === 'LEAVE_ROOM') {
        connectIntent = false;
        reconnectFailed = false;
        reconnectAttempts = 0;
        chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null });
        resetAudioProcessingInTab(currentTabId);
        emit(EVENTS.LEAVE_ROOM, { peerId });
        currentRoom = null;
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
            expectedAcksCount: 0
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
                emit(EVENTS.JOIN_ROOM, { 
                    roomId, 
                    password,
                    peerId,
                    username: settings.username,
                    tabTitle: currentTabTitle,
                    protocolVersion: PROTOCOL_VERSION
                });
            }
            addLog(`Joining room via link: ${roomId}`, 'info');
            sendResponse({ status: 'ok' });
        });
    } else if (message.type === 'REGENERATE_ID') {
        const newId = self.crypto.randomUUID().substring(0, 8);
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
    } else if (message.type === 'CONTENT_EVENT') {
        const processEvent = () => {
            const timestamp = Date.now();
            localSeq++;
            chrome.storage.session.set({ localSeq });
            updateLastAction(message.action, 'You', timestamp);
            
            const payload = message.payload || {};
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
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            const hasOtherPeers = otherCount > 0;
            
            if (isNonEssentialEvent && !hasOtherPeers) {
                sendResponse({ status: 'ok_solo' });
                return;
            }
            
            emit(message.action, { ...message.payload, peerId });
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
            processEvent();
        } else {
            routeToContent(message.action, message.payload);
            processEvent();
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
        if (commandSenderId && commandSenderId !== peerId) {
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
            const statusPayload = { ...message.payload, peerId, username: settings.username, tabTitle: currentTabTitle };
            const otherCount = currentRoom && Array.isArray(currentRoom.peers) ? currentRoom.peers.filter(p => (typeof p === 'object' ? p.peerId : p) !== peerId).length : 0;
            if (otherCount > 0) emit(EVENTS.PEER_STATUS, statusPayload);

            if (currentRoom && Array.isArray(currentRoom.peers)) {
                const me = currentRoom.peers.find(p => (p.peerId || p) === peerId);
                if (me && typeof me === 'object') {
                    me.tabTitle = currentTabTitle;
                    me.username = settings.username;
                    me.mediaTitle = message.payload?.mediaTitle;
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
            chrome.scripting.executeScript({
                target: { tabId: selectedTabId },
                files: ['content.js']
            })
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

        // Check setting
        const epSettings = await chrome.storage.local.get(['autoSyncNextEpisode']);
        if (epSettings.autoSyncNextEpisode === false) {
            addLog(`Episode change detected ("${newTitle}") but Auto-Sync is disabled.`, 'info');
            sendResponse({ status: 'disabled' });
            return;
        }

        // If lobby already exists for this title, just mark self ready
        if (episodeLobby && sameEpisode(episodeLobby.expectedTitle, newTitle)) {
            if (!episodeLobby.readyPeers.includes(peerId)) {
                episodeLobby.readyPeers.push(peerId);
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                emit(EVENTS.EPISODE_READY, { peerId, title: newTitle });
                checkEpisodeLobbyCompletion();
            }
            sendResponse({ status: 'ready_sent' });
            return;
        }

        // Cancel any existing lobby for a different episode
        if (episodeLobby) clearEpisodeLobbyState();

        // Create new lobby
        episodeLobby = {
            expectedTitle: newTitle,
            initiatorPeerId: peerId,
            readyPeers: [peerId], // We are already ready
            createdAt: Date.now()
        };
        persistEpisodeLobby();
        broadcastLobbyUpdate();
        addLog(`Episode lobby created: "${newTitle}"`, 'info');

        // Tell content script to pause the video and start polling
        // (This is the only place we pause — after confirming the feature is enabled)
        if (sender.tab && sender.tab.id) {
            chrome.tabs.sendMessage(sender.tab.id, {
                type: 'PAUSE_FOR_LOBBY',
                expectedTitle: newTitle
            }).catch(() => {});
        }

        // Broadcast to room
        emit(EVENTS.EPISODE_LOBBY, { peerId, expectedTitle: newTitle });

        // Start timeout (Q1: Option B — cancel on timeout)
        episodeLobbyTimeout = setTimeout(() => cancelEpisodeLobby('Timeout — not all peers loaded the episode'), EPISODE_LOBBY_TIMEOUT);

        // Immediate check — maybe we're the only one in the room
        checkEpisodeLobbyCompletion();

        sendResponse({ status: 'lobby_created' });
    } else if (message.type === 'EPISODE_READY_LOCAL') {
        // Content script confirmed it loaded the lobby episode
        if (episodeLobby && message.payload && sameEpisode(message.payload.title, episodeLobby.expectedTitle)) {
            if (!episodeLobby.readyPeers.includes(peerId)) {
                episodeLobby.readyPeers.push(peerId);
                persistEpisodeLobby();
                broadcastLobbyUpdate();
                emit(EVENTS.EPISODE_READY, { peerId, title: message.payload.title });
                addLog(`Local episode ready: "${message.payload.title}"`, 'success');
                checkEpisodeLobbyCompletion();
            }
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
    } else {
        // Final fallback to prevent channel hanging
        sendResponse({ error: 'unhandled_message' });
    }
}

chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.audioSettings) return;
    await ensureState();
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, {
        action: 'APPLY_AUDIO_SETTINGS',
        settings: changes.audioSettings.newValue
    }).catch(() => {});
});

// Tab removal listener
chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureState();
    await tabManager.handleTabRemoved(tabId);
});

// Re-inject on full page refresh
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
    await ensureState();
    await tabManager.handleTabUpdated(tabId, changeInfo);
});

// Initial Connect — only if user has an active room configuration
getSettings().then(settings => {
    connectIntent = !!settings.roomId;
    if (connectIntent) connect();
}).catch(() => connectIntent = false);
