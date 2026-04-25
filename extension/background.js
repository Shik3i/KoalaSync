import { EVENTS, PROTOCOL_VERSION, OFFICIAL_SERVER_URL, OFFICIAL_SERVER_TOKEN, APP_VERSION } from './shared/constants.js';

// --- State Management ---
let socket = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let isConnecting = false;
let peerId = null; // initialized via getPeerId()
let currentRoom = null;
let lastPeersJson = null;
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
let currentCommandSenderId = null; // Track who sent the last command we are executing

// --- Boot Sequence Lock ---
let restorationTask = null;

function ensureState() {
    if (!restorationTask) {
        restorationTask = new Promise(resolve => {
            chrome.storage.session.get([
                'logs', 'history', 'currentRoom', 'lastActionState', 
                'eventQueue', 'isForceSyncInitiator', 'forceSyncAcks', 
                'forceSyncDeadline', 'reconnectFailed', 'reconnectStartTime', 'currentTabId', 'currentTabTitle'
            ], (data) => {
                if (data.currentTabId !== undefined) currentTabId = data.currentTabId;
                if (data.currentTabTitle !== undefined) currentTabTitle = data.currentTabTitle;
                // Merge data from storage with any early-arriving state
                // New entries (added during boot) must stay at the top (index 0)
                if (data.logs) logs = [...logs, ...data.logs].slice(0, 50);
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

                storageInitialized = true;
                
                // Process any early logs/history that weren't captured in the spread
                if (pendingLogs.length > 0) {
                    logs = [...pendingLogs, ...logs].slice(0, 50);
                    chrome.storage.session.set({ logs });
                    pendingLogs = [];
                }
                if (pendingHistory.length > 0) {
                    history = [...pendingHistory, ...history].slice(0, 20);
                    chrome.storage.session.set({ history });
                    pendingHistory = [];
                }

                resolve();
            });
        });
    }
    return restorationTask;
}

// Start restoration immediately
ensureState();

let reconnectTimer = null;
let reconnectStartTime = null; // New: track when reconnection started
let reconnectFailed = false; // New: true if we hit the 5-min cap

// Force Sync Coordination
let isForceSyncInitiator = false;
let forceSyncAcks = new Set();
let forceSyncTimeout = null;

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

async function getPeerId() {
    const data = await chrome.storage.local.get(['peerId']);
    if (data.peerId) return data.peerId;
    const newId = self.crypto.randomUUID().substring(0, 8);
    await chrome.storage.local.set({ peerId: newId });
    return newId;
}

async function getSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'username'], (data) => {
            resolve({
                serverUrl: data.serverUrl || '',
                useCustomServer: data.useCustomServer || false,
                roomId: data.roomId || '',
                password: data.password || '',
                username: data.username || ''
            });
        });
    });
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
        if (logs.length > 50) logs.pop();
        chrome.storage.session.set({ logs });
    }
    chrome.runtime.sendMessage({ type: 'LOG_UPDATE', log }).catch(() => {});
}

// --- WebSocket Client ---
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
            return;
        }

        if (reconnectFailed) {
            isConnecting = false;
            return;
        }

        broadcastConnectionStatus('connecting');
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

        addLog(`Connecting to ${isCustomServer ? finalUrl : 'Official Server'}...`, 'info');

        // --- Phase 4: WebSocket Init ---
        try {
            const url = new URL(finalUrl);
            url.pathname = '/socket.io/';
            url.searchParams.set('EIO', '4');
            url.searchParams.set('transport', 'websocket');
            url.searchParams.set('version', APP_VERSION);
            url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);

            socket = new WebSocket(url.toString());
        } catch (e) {
            throw new Error(`[Connection Error] ${e.message}`);
        }

        // --- Phase 5: Event Listeners ---
        socket.onopen = () => {
            reconnectDelay = 1000;
            addLog('WebSocket Connection Opened', 'success');
            reconnectStartTime = null;
            reconnectFailed = false;
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
                addLog('Joined Namespace /', 'success');
                const settings = await getSettings();
                if (settings.roomId) {
                    emit(EVENTS.JOIN_ROOM, { 
                        roomId: settings.roomId, 
                        password: settings.password,
                        peerId,
                        username: settings.username,
                        tabTitle: currentTabTitle,
                        protocolVersion: PROTOCOL_VERSION
                    });
                }
                while (eventQueue.length > 0) {
                    const queuedMsg = eventQueue.shift();
                    emit(queuedMsg.event, queuedMsg.data);
                }
                eventQueue = [];
                chrome.storage.session.set({ eventQueue: [] });
            } else if (msg.startsWith('42')) {
                try {
                    const payload = JSON.parse(msg.substring(2));
                    handleServerEvent(payload[0], payload[1]);
                } catch (e) {
                    addLog(`Failed to parse message: ${msg}`, 'error');
                }
            }
        };

        socket.onclose = () => {
            isConnecting = false;
            isNamespaceJoined = false;
            
            // Clear Force Sync state
            isForceSyncInitiator = false;
            forceSyncAcks.clear();
            if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
            chrome.storage.session.set({ 
                isForceSyncInitiator: false, 
                forceSyncAcks: [], 
                forceSyncDeadline: null 
            });
            
            if (currentRoom) {
                currentRoom.peers = [];
                chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
            }
            broadcastConnectionStatus('disconnected');
            addLog(`Disconnected. Retrying in ${reconnectDelay / 1000}s...`, 'warn');
            scheduleReconnect();
        };

        socket.onerror = (err) => {
            broadcastConnectionStatus('disconnected');
            addLog(`WebSocket Error: ${err.message || 'Handshake failed or server unreachable'}`, 'error');
            socket.close();
        };

    } catch (e) {
        isConnecting = false;
        addLog(e.message, 'error');
        broadcastConnectionStatus('disconnected');
        scheduleReconnect();
    }
}


function broadcastConnectionStatus(status) {
    chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS', status }).catch(() => {});
    updateBadgeStatus();
}

function updateBadgeStatus() {
    const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
    const status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : 'disconnected');

    if (reconnectFailed) {
        chrome.action.setBadgeText({ text: 'ERR' });
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
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
    const label = action === 'play' ? 'started playback' : 
                  action === 'pause' ? 'paused playback' : 
                  action === 'seek' ? 'seeked the video' :
                  action === 'force_sync_execute' ? 'synchronized everyone' : action;
    
    // Find username in current room if available
    let displayName = senderName || 'A peer';
    if (currentRoom && currentRoom.peers) {
        const peer = currentRoom.peers.find(p => (p.peerId || p) === senderName);
        if (peer && peer.username) displayName = peer.username;
    }

    chrome.notifications.create(`sync_${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'KoalaSync',
        message: `${displayName} ${label}.`,
        priority: 1
    });
}

function scheduleReconnect() {
    if (reconnectTimer || reconnectFailed) return;
    
    if (!reconnectStartTime) reconnectStartTime = Date.now();

    // Check 5 minute cap (300,000ms)
    if (Date.now() - reconnectStartTime > 300000) {
        reconnectFailed = true;
        chrome.storage.session.set({ reconnectFailed: true });
        addLog('Reconnection failed after 5 minutes. Please try again manually.', 'error');
        broadcastConnectionStatus('reconnect_failed');
        return;
    }
    
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connect();
    }, reconnectDelay);
}

function emit(event, data) {
    if (socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined) {
        const msg = `42${JSON.stringify([event, data])}`;
        socket.send(msg);
    } else {
        eventQueue.push({ event, data });
        if (eventQueue.length > 50) {
            eventQueue.shift();
            addLog('Event queue cap reached, dropping oldest event', 'warn');
        }
        chrome.storage.session.set({ eventQueue });
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

// --- Event Handlers ---
function handleServerEvent(event, data) {
    
    switch (event) {
        case EVENTS.ROOM_DATA:
            currentRoom = data;
            if (storageInitialized) chrome.storage.session.set({ currentRoom });
            addLog(`Joined Room: ${data.roomId}`, 'success');
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
            broadcastConnectionStatus('disconnected');
            addLog(`Server Error: ${data.message}`, 'error');
            chrome.notifications.create(`error_${Date.now()}`, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'KoalaSync Error',
                message: data.message
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
            if (data.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);
                updateLastAction(event, data.senderId);
            }
            routeToContent(event, data);
            break;
        case EVENTS.FORCE_SYNC_ACK:
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
                }

                // Check if all peers responded
                const peerCount = currentRoom ? currentRoom.peers.length : 1;
                if (forceSyncAcks.size >= peerCount) {
                    executeForceSync();
                }
            }
            break;
        case EVENTS.FORCE_SYNC_EXECUTE:
            if (data.senderId) {
                addToHistory(event, data.senderId);
                showNotification(data.senderId, event);
            }
            routeToContent(event, data);
            break;
        case EVENTS.EVENT_ACK:
            if (lastActionState && lastActionState.action && data.senderId) {
                // Correlation Check: Only accept ACK if it matches our current action's timestamp
                if (data.actionTimestamp === lastActionState.timestamp) {
                    if (!Array.isArray(lastActionState.acks)) lastActionState.acks = [];
                    if (!lastActionState.acks.includes(data.senderId)) {
                        lastActionState.acks.push(data.senderId);
                        if (storageInitialized) chrome.storage.session.set({ lastActionState });
                        chrome.runtime.sendMessage({ type: 'ACTION_UPDATE', state: lastActionState }).catch(() => {});
                    }
                }
            }
            break;
        case EVENTS.PEER_STATUS:
            if (currentRoom) {
                if (!Array.isArray(currentRoom.peers)) currentRoom.peers = [];
                if (data.status === 'joined') {
                    if (!currentRoom.peers.find(p => (p.peerId || p) === data.peerId)) {
                        currentRoom.peers.push(createPeerData(data));
                        if (storageInitialized) chrome.storage.session.set({ currentRoom });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                    }
                } else if (data.status === 'left') {
                    currentRoom.peers = currentRoom.peers.filter(p => (p.peerId || p) !== data.peerId);
                    if (storageInitialized) chrome.storage.session.set({ currentRoom });
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                } else {
                    // Heartbeat/Update: Update tabTitle for matching
                    const peer = currentRoom.peers.find(p => (p.peerId || p) === data.peerId);
                    if (peer) {
                        if (typeof peer === 'object') {
                            peer.tabTitle = data.tabTitle;
                            peer.username = data.username;
                            peer.mediaTitle = data.mediaTitle !== undefined ? data.mediaTitle : peer.mediaTitle;
                            peer.playbackState = data.playbackState !== undefined ? data.playbackState : peer.playbackState;
                            peer.currentTime = data.currentTime !== undefined ? data.currentTime : peer.currentTime;
                            peer.volume = data.volume !== undefined ? data.volume : peer.volume;
                            peer.muted = data.muted !== undefined ? data.muted : peer.muted;
                            peer.lastHeartbeat = Date.now();
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
        default:
            addLog(`Received unknown event from server: ${event}`, 'warn');
            break;
    }
}

function executeForceSync() {
    if (forceSyncTimeout) clearTimeout(forceSyncTimeout);
    isForceSyncInitiator = false;
    forceSyncAcks.clear();
    chrome.storage.session.set({ 
        isForceSyncInitiator: false, 
        forceSyncAcks: [], 
        forceSyncDeadline: null 
    });
    emit(EVENTS.FORCE_SYNC_EXECUTE, {});
    routeToContent(EVENTS.FORCE_SYNC_EXECUTE, {});
    addLog('Force Sync Executed', 'success');
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

    currentCommandSenderId = payload.senderId || null;
    const actionTimestamp = payload.actionTimestamp || Date.now();

    chrome.tabs.sendMessage(tabId, { 
        type: 'SERVER_COMMAND',
        action,
        payload,
        actionTimestamp
    }).catch(err => {
        // Auto-Reinject if content script is missing or extension was reloaded
        if (err.message.includes('Receiving end does not exist') || err.message.includes('Extension context invalidated')) {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }).then(() => {
                setTimeout(() => routeToContent(action, payload), 500);
            }).catch(err => {
                addLog(`Auto-reinject failed for tab ${tabId}`, 'warn');
            });
        } else {
            addLog(`Content Script not responding in tab ${tabId}`, 'warn');
            currentTabId = null;
            updateBadgeStatus();
        }
    });
}

// --- Keep-Alive Mechanism ---
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    await ensureState();
    if (alarm.name === 'keepAlive') {
        chrome.storage.session.get('keepAlive', () => {});
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connect();
        } else if (currentRoom) {
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



// --- Extension Message Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleAsyncMessage(message, sender, sendResponse);
    return true; // Keep channel open for async responses
});

async function handleAsyncMessage(message, sender, sendResponse) {
    await ensureState();

    if (message.type === 'CONNECT') {
        reconnectFailed = false;
        reconnectStartTime = null;
        if (socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined) {
            // Already connected, but maybe room changed or we need to refresh room state
            const settings = await getSettings();
            if (settings.roomId) {
                emit(EVENTS.JOIN_ROOM, { 
                    roomId: settings.roomId, 
                    password: settings.password,
                    peerId,
                    username: settings.username,
                    tabTitle: currentTabTitle,
                    protocolVersion: PROTOCOL_VERSION
                });
            }
        } else {
            connect();
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'RETRY_CONNECT') {
        reconnectFailed = false;
        reconnectStartTime = null;
        reconnectDelay = 1000;
        connect();
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_STATUS') {
        const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
        let status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : 'disconnected');
        if (reconnectFailed) status = 'reconnect_failed';
        sendResponse({ 
            status, 
            peerId, 
            peers: currentRoom ? currentRoom.peers : [],
            lastActionState,
            targetTabId: currentTabId
        });
    } else if (message.type === 'LEAVE_ROOM') {
        emit(EVENTS.LEAVE_ROOM, { peerId });
        currentRoom = null;
        currentTabId = null;

        updateBadgeStatus();
        
        isForceSyncInitiator = false;
        forceSyncAcks.clear();
        if (forceSyncTimeout) clearTimeout(forceSyncTimeout);

        chrome.storage.session.set({ 
            currentRoom: null,
            isForceSyncInitiator: false,
            forceSyncAcks: [],
            forceSyncDeadline: null
        });
        addLog('Left Room', 'info');
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CLEAR_LOGS') {
        logs = [];
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_LOGS') {
        sendResponse(logs);
    } else if (message.type === 'GET_HISTORY') {
        sendResponse(history);
    } else if (message.type === 'GET_ROOM_LIST') {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(`42${JSON.stringify([EVENTS.GET_ROOMS])}`);
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'WEB_JOIN_REQUEST') {
        const { roomId, password, useCustomServer, serverUrl } = message;
        chrome.storage.sync.set({ 
            roomId, 
            password,
            useCustomServer: !!useCustomServer,
            serverUrl: serverUrl || ''
        }, async () => {
            broadcastConnectionStatus('connecting');
            if (socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined) {
                // FORCE TRANSITION: Emit Join Room directly if already connected
                const settings = await getSettings();
                emit(EVENTS.JOIN_ROOM, { 
                    roomId, 
                    password,
                    peerId,
                    username: settings.username,
                    tabTitle: currentTabTitle,
                    protocolVersion: PROTOCOL_VERSION
                });
                addLog(`Joining room via link: ${roomId}`, 'info');
            } else {
                connect();
            }
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
            updateLastAction(message.action, 'You', timestamp);
            message.payload.actionTimestamp = timestamp;
            
            if (message.action === EVENTS.FORCE_SYNC_PREPARE) {
                isForceSyncInitiator = true;
                forceSyncAcks.clear();
                const deadline = Date.now() + 5000;
                chrome.storage.session.set({ 
                    isForceSyncInitiator: true, 
                    forceSyncAcks: [], 
                    forceSyncDeadline: deadline 
                });
                addLog('Initiating Force Sync...', 'info');
                
                routeToContent(EVENTS.FORCE_SYNC_PREPARE, message.payload);
     
                forceSyncTimeout = setTimeout(() => {
                    if (isForceSyncInitiator) {
                        addLog('Force Sync: Timeout waiting for ACKs, executing anyway...', 'warn');
                        executeForceSync();
                    }
                }, 5000);
            }
            addToHistory(message.action, 'You');
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
            const peerCount = currentRoom ? currentRoom.peers.length : 1;
            if (forceSyncAcks.size >= peerCount) {
                executeForceSync();
            }
        } else {
            emit(EVENTS.FORCE_SYNC_ACK, { peerId });
        }
        sendResponse({ status: 'ok' });
    } else if (message.type === 'CMD_ACK') {
        // Content script successfully ran a command. Send ACK back to the initiator.
        if (currentCommandSenderId && currentCommandSenderId !== peerId) {
            emit(EVENTS.EVENT_ACK, { 
                senderId: peerId, 
                targetId: currentCommandSenderId,
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

        getSettings().then(settings => {
            const statusPayload = { ...message.payload, peerId, username: settings.username, tabTitle: currentTabTitle };
            emit(EVENTS.PEER_STATUS, statusPayload);

            if (currentRoom && currentRoom.peers) {
                const me = currentRoom.peers.find(p => (p.peerId || p) === peerId);
                if (me && typeof me === 'object') {
                    me.tabTitle = currentTabTitle;
                    me.username = settings.username;
                    me.mediaTitle = message.payload.mediaTitle;
                    me.playbackState = message.payload.playbackState;
                    me.currentTime = message.payload.currentTime;
                    me.volume = message.payload.volume;
                    me.muted = message.payload.muted;
                    me.lastHeartbeat = Date.now();
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                }
            }
            sendResponse({ status: 'ok' });
        });
    } else if (message.type === 'SET_TARGET_TAB') {
        currentTabId = message.tabId;
        currentTabTitle = message.tabTitle;
        chrome.storage.session.set({ currentTabId, currentTabTitle });
        updateBadgeStatus();
        
        if (currentTabId) {
            chrome.scripting.executeScript({
                target: { tabId: currentTabId },
                files: ['content.js']
            }).catch(err => {
                addLog(`Failed to inject into tab: ${err.message}`, 'warn');
            });
        }
        
        sendResponse({ status: 'ok' });
    } else if (message.type === 'LOG') {
        addLog(`[Content] ${message.message}`, message.level || 'info');
        sendResponse({ status: 'ok' });
    } else {
        // Final fallback to prevent channel hanging
        sendResponse({ error: 'unhandled_message' });
    }
}

// Tab removal listener
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === currentTabId) {
        currentTabId = null;
        currentTabTitle = null;
        chrome.storage.session.set({ currentTabId: null, currentTabTitle: null });
        updateBadgeStatus();
        addLog('Target tab closed.', 'warn');
    }
});

// Re-inject on full page refresh
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (currentTabId && tabId === parseInt(currentTabId) && changeInfo.status === 'complete') {
        chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
        }).catch(() => {});
    }
});

// Initial Connect
connect();
