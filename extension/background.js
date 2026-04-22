import { EVENTS, PROTOCOL_VERSION, OFFICIAL_SERVER_URL, OFFICIAL_SERVER_TOKEN, APP_VERSION } from './shared/constants.js';

// --- State Management ---
let socket = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let isConnecting = false;
let peerId = null; // initialized via getPeerId()
let currentRoom = null;
let lastPeersJson = null;
let heartbeatInterval = null;
let currentTabId = null;
let currentTabTitle = null; // New: for Smart Matching
let logs = [];
let history = []; // New: for Action History
let storageInitialized = false;
let pendingLogs = [];
let pendingHistory = [];
let eventQueue = [];
let isNamespaceJoined = false;

// Restore state from session storage
chrome.storage.session.get(['logs', 'history', 'currentRoom'], (data) => {
    if (data.logs) logs = data.logs;
    if (data.history) history = data.history;
    if (data.currentRoom) currentRoom = data.currentRoom;
    storageInitialized = true;
    
    if (pendingLogs.length > 0) {
        logs.unshift(...pendingLogs);
        if (logs.length > 50) logs = logs.slice(0, 50);
        chrome.storage.session.set({ logs });
        pendingLogs = [];
    }
    if (pendingHistory.length > 0) {
        history.unshift(...pendingHistory);
        if (history.length > 20) history = history.slice(0, 20);
        chrome.storage.session.set({ history });
        pendingHistory = [];
    }
});

let reconnectTimer = null;
let reconnectStartTime = null; // New: track when reconnection started
let reconnectFailed = false; // New: true if we hit the 5-min cap

// Force Sync Coordination
let isForceSyncInitiator = false;
let forceSyncAcks = new Set();
let forceSyncTimeout = null;

// --- Storage Utils ---
function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (currentRoom) {
            emit(EVENTS.PEER_STATUS, { peerId, status: 'heartbeat' });
        } else {
            stopHeartbeat();
        }
    }, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
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
    return new Promise(resolve => {
        chrome.storage.sync.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'targetTabId', 'username'], (data) => {
            resolve({
                serverUrl: data.serverUrl || '',
                useCustomServer: data.useCustomServer || false,
                roomId: data.roomId || '',
                password: data.password || '',
                targetTabId: data.targetTabId || null,
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
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (!navigator.onLine) {
        addLog('Browser is offline. Waiting...', 'warn');
        broadcastConnectionStatus('offline');
        return;
    }

    if (reconnectFailed) return; // Wait for manual retry
    
    if (!peerId) peerId = await getPeerId();
    const settings = await getSettings();

    isConnecting = true;
    broadcastConnectionStatus('connecting');
    const isCustomServer = settings.serverUrl && settings.useCustomServer;
    let finalUrl = isCustomServer ? settings.serverUrl : OFFICIAL_SERVER_URL;

    // Robustness: Ensure finalUrl is not empty and has a protocol
    if (isCustomServer) {
        finalUrl = finalUrl.trim();
        if (!finalUrl.includes('://')) {
            finalUrl = 'ws://' + finalUrl;
        }

        // Strict WSS Enforcement
        const urlObj = new URL(finalUrl);
        const isLocal = urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1';
        if (urlObj.protocol !== 'wss:' && !isLocal) {
            urlObj.protocol = 'wss:';
            finalUrl = urlObj.toString();
            addLog('Security: Upgraded to wss:// for remote host.', 'warn');
        }
    }

    addLog(`Connecting to ${isCustomServer ? finalUrl : 'Official Server'}...`, 'info');

    try {
        const url = new URL(finalUrl);
        url.pathname = '/socket.io/';
        url.searchParams.set('EIO', '4');
        url.searchParams.set('transport', 'websocket');
        url.searchParams.set('version', APP_VERSION);

        if (!isCustomServer) {
            url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);
        } else {
            // Self-hosted servers use the same official token by design.
            // This allows users to run their own relay while still using
            // the official extension — the token is public and not a secret.
            url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);
        }

        socket = new WebSocket(url.toString());

        socket.onopen = () => {
            isConnecting = false;
            reconnectDelay = 1000;
            addLog('WebSocket Connection Opened', 'success');
            reconnectStartTime = null;
            reconnectFailed = false;
            isNamespaceJoined = false;
            
            // Socket.IO Handshake: Send "40" to join default namespace
            socket.send('40');
        };
    } catch (e) {
        isConnecting = false;
        addLog(`Invalid Server URL: ${finalUrl}`, 'error');
        broadcastConnectionStatus('disconnected');
        scheduleReconnect();
        return;
    }

    socket.onmessage = (event) => {
        const msg = event.data;
        
        // Engine.IO Ping/Pong
        if (msg === '2') {
            socket.send('3'); // Pong
            return;
        }

        // Socket.IO Handshake / Packet parsing
        if (msg.startsWith('0')) {
            addLog(`Socket.IO Handshake: ${msg}`, 'info');
        } else if (msg.startsWith('40')) {
            isNamespaceJoined = true;
            broadcastConnectionStatus('connected');
            addLog('Joined Namespace /', 'success');
            // Auto-rejoin room if we have one in settings
            if (settings.roomId) {
                emit(EVENTS.JOIN_ROOM, { 
                    roomId: settings.roomId, 
                    password: settings.password,
                    peerId,
                    username: settings.username,
                    protocolVersion: PROTOCOL_VERSION
                });
            }
            while (eventQueue.length > 0) {
                const queuedMsg = eventQueue.shift();
                emit(queuedMsg.event, queuedMsg.data);
            }
            eventQueue = []; // Explicitly reset to avoid memory leaks
        } else if (msg.startsWith('42')) {
            // Event: 42["event", data]
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
        addLog('WebSocket Error', 'error');
        socket.close();
    };
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
    } else if (currentTabId) {
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
            
            // Start background heartbeat
            startHeartbeat();
            
            // Inform Website Bridge
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { type: 'JOIN_STATUS', success: true, message: 'Joined' }).catch(() => {});
                });
            });
            break;
        case EVENTS.ROOM_LIST:
            chrome.runtime.sendMessage({ type: 'ROOM_LIST', rooms: data.rooms }).catch(() => {});
            break;
        case EVENTS.ERROR:
            addLog(`Server Error: ${data.message}`, 'error');
            chrome.notifications.create(`error_${Date.now()}`, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'KoalaSync Error',
                message: data.message
            });
            // Inform Website Bridge
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { type: 'JOIN_STATUS', success: false, message: data.message }).catch(() => {});
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
            }
            routeToContent(event, data);
            break;
        case EVENTS.FORCE_SYNC_ACK:
            if (isForceSyncInitiator) {
                forceSyncAcks.add(data.senderId);
                addLog(`Received ACK from ${data.senderId} (${forceSyncAcks.size})`, 'info');
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
        case EVENTS.PEER_STATUS:
            if (currentRoom) {
                if (data.status === 'joined') {
                    if (!currentRoom.peers.find(p => (p.peerId || p) === data.peerId)) {
                        currentRoom.peers.push({ peerId: data.peerId, username: data.username, tabTitle: data.tabTitle });
                        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                    }
                } else if (data.status === 'left') {
                    currentRoom.peers = currentRoom.peers.filter(p => (p.peerId || p) !== data.peerId);
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: currentRoom.peers }).catch(() => {});
                } else {
                    // Heartbeat/Update: Update tabTitle for matching
                    const peer = currentRoom.peers.find(p => (p.peerId || p) === data.peerId);
                    if (peer) {
                        if (typeof peer === 'object') {
                            peer.tabTitle = data.tabTitle;
                            peer.username = data.username;
                        } else {
                            // Migration: replace string with object
                            const idx = currentRoom.peers.indexOf(peer);
                            currentRoom.peers[idx] = { peerId: data.peerId, username: data.username, tabTitle: data.tabTitle };
                        }
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
    emit(EVENTS.FORCE_SYNC_EXECUTE, {});
    routeToContent(EVENTS.FORCE_SYNC_EXECUTE, {});
    addLog('Force Sync Executed', 'success');
}

async function routeToContent(action, payload) {
    if (!currentTabId) {
        const settings = await getSettings();
        currentTabId = settings.targetTabId;
    }
    if (!currentTabId) return;

    const tabId = parseInt(currentTabId);
    if (isNaN(tabId)) return;

    chrome.tabs.sendMessage(tabId, { 
        type: 'SERVER_COMMAND',
        action,
        payload
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
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
        chrome.storage.session.get('keepAlive', () => {});
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            connect();
        }
    }
});

setInterval(() => {
    // Calling a chrome API keeps the SW alive in MV3 (Chrome 110+)
    chrome.storage.session.get('keepAlive', () => {});
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        connect();
    }
}, 20000); // every 20s

// --- Extension Message Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CONNECT') {
        reconnectFailed = false;
        reconnectStartTime = null;
        if (socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined) {
            // Already connected, but maybe room changed or we need to refresh room state
            getSettings().then(settings => {
                if (settings.roomId) {
                    emit(EVENTS.JOIN_ROOM, { 
                        roomId: settings.roomId, 
                        password: settings.password,
                        peerId,
                        protocolVersion: PROTOCOL_VERSION
                    });
                }
            });
        } else {
            connect();
        }
    } else if (message.type === 'RETRY_CONNECT') {
        reconnectFailed = false;
        reconnectStartTime = null;
        reconnectDelay = 1000;
        connect();
    } else if (message.type === 'GET_STATUS') {
        const isConnected = socket && socket.readyState === WebSocket.OPEN && isNamespaceJoined;
        let status = isConnected ? 'connected' : (isConnecting || (socket && socket.readyState === WebSocket.CONNECTING) ? 'connecting' : 'disconnected');
        if (reconnectFailed) status = 'reconnect_failed';
        sendResponse({ status, peerId, peers: currentRoom ? currentRoom.peers : [] });
        // Global return true at the end handles this
    } else if (message.type === 'LEAVE_ROOM') {
        emit(EVENTS.LEAVE_ROOM, { peerId });
        currentRoom = null;
        stopHeartbeat();
        if (storageInitialized) chrome.storage.session.set({ currentRoom: null });
        addLog('Left Room', 'info');
        chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
    } else if (message.type === 'CLEAR_LOGS') {
        logs = [];
        sendResponse({ status: 'ok' });
    } else if (message.type === 'GET_LOGS') {
        sendResponse(storageInitialized ? logs : pendingLogs);
    } else if (message.type === 'GET_HISTORY') {
        sendResponse(storageInitialized ? history : pendingHistory);
    } else if (message.type === 'GET_ROOM_LIST') {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(`42${JSON.stringify([EVENTS.GET_ROOMS])}`);
        }
    } else if (message.type === 'WEB_JOIN_REQUEST') {
        const { roomId, password, useCustomServer, serverUrl } = message;
        chrome.storage.sync.set({ 
            roomId, 
            password,
            useCustomServer: !!useCustomServer,
            serverUrl: serverUrl || ''
        }, () => {
            connect();
            // We wait for status update in handleServerEvent
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
        return true; // Keep channel open
    } else if (message.type === 'CONTENT_EVENT') {
        if (sender.tab) {
            currentTabId = sender.tab.id;
            currentTabTitle = sender.tab.title ? sender.tab.title.substring(0, 50) : null;
            updateBadgeStatus();
        }
        // Events coming from content script (manual play/pause)
        if (message.action === EVENTS.FORCE_SYNC_PREPARE) {
            isForceSyncInitiator = true;
            forceSyncAcks.clear();
            addLog('Initiating Force Sync...', 'info');
            
            // Route to our own content script so we pause and seek
            routeToContent(EVENTS.FORCE_SYNC_PREPARE, message.payload);

            // Timeout if not everyone ACKs
            forceSyncTimeout = setTimeout(() => {
                if (isForceSyncInitiator) {
                    addLog('Force Sync: Timeout waiting for ACKs, executing anyway...', 'warn');
                    executeForceSync();
                }
            }, 5000);
        }
        addToHistory(message.action, 'You');
        emit(message.action, { ...message.payload, peerId });
    } else if (message.type === 'FORCE_SYNC_ACK') {
        if (isForceSyncInitiator) {
            forceSyncAcks.add(peerId);
            addLog(`Local ACK received (${forceSyncAcks.size})`, 'info');
            const peerCount = currentRoom ? currentRoom.peers.length : 1;
            if (forceSyncAcks.size >= peerCount) {
                executeForceSync();
            }
        } else {
            emit(EVENTS.FORCE_SYNC_ACK, { peerId });
        }
    } else if (message.type === 'HEARTBEAT') {
        if (sender.tab) {
            currentTabId = sender.tab.id;
            currentTabTitle = sender.tab.title ? sender.tab.title.substring(0, 50) : null;
        }
        // Peer status heartbeat from content script
        getSettings().then(settings => {
            emit(EVENTS.PEER_STATUS, { ...message.payload, peerId, username: settings.username, tabTitle: currentTabTitle });
        });
    }
    return true; // Keep channel open for async responses
});

// Tab removal listener
chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === currentTabId) {
        currentTabId = null;
        currentTabTitle = null;
        chrome.storage.sync.set({ targetTabId: null });
        updateBadgeStatus();
        addLog('Target tab closed.', 'warn');
    }
});

// Initial Connect
connect();
