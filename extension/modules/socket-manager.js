import { EVENTS, PROTOCOL_VERSION, OFFICIAL_SERVER_URL, OFFICIAL_SERVER_TOKEN } from '../shared/constants.js';

export class SocketManager {
    constructor(context, callbacks) {
        this.context = context;
        this.addLog = callbacks.addLog;
        this.addToHistory = callbacks.addToHistory;
        this.handleServerEvent = callbacks.handleServerEvent;
        this.updateBadgeStatus = callbacks.updateBadgeStatus;
        this.getSettings = callbacks.getSettings;
        this.getPeerId = callbacks.getPeerId;
        this.maxReconnectAttempts = 20;
        this.reconnectBaseDelay = 500;
        this.reconnectMaxDelay = 5000;
    }

    resolveServerUrl(settings) {
        return (settings.serverUrl && settings.useCustomServer) ? settings.serverUrl : OFFICIAL_SERVER_URL;
    }

    forceDisconnect() {
        if (this.context.reconnectTimer) {
            clearTimeout(this.context.reconnectTimer);
            this.context.reconnectTimer = null;
        }
        if (this.context.episodeLobbyTimeout) {
            clearTimeout(this.context.episodeLobbyTimeout);
            this.context.episodeLobbyTimeout = null;
        }
        this.context.episodeLobby = null;
        if (this.context.forceSyncTimeout) {
            clearTimeout(this.context.forceSyncTimeout);
            this.context.forceSyncTimeout = null;
        }
        this.stopPing();
        if (this.context.socket) {
            this.context.socket.onopen = null;
            this.context.socket.onmessage = null;
            this.context.socket.onclose = null;
            this.context.socket.onerror = null;
            this.context.socket.close();
            this.context.socket = null;
        }
        this.context.currentServerUrl = null;
        this.context.isConnecting = false;
        this.context.isNamespaceJoined = false;
        this.context.isForceSyncInitiator = false;
        this.context.expectedAcksCount = 0;
        this.context.roomIdleSince = null;
        this.context.lastContentHeartbeatAt = null;
        this.context.forceSyncAcks.clear();
        this.context.eventQueue = [];
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
        if (this.context.currentRoom) {
            this.context.currentRoom.peers = [];
            if (this.context.storageInitialized) {
                chrome.storage.session.set({ currentRoom: this.context.currentRoom });
            }
            chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
        }
        this.broadcastConnectionStatus('disconnected');
    }

    async connect() {
        if (this.context.isConnecting) return;
        this.context.isConnecting = true;

        let finalUrl = '';
        try {
            let settings;
            try {
                if (!this.context.peerId) {
                    this.context.peerId = await this.getPeerId();
                }
                settings = await this.getSettings();
            } catch (e) {
                throw new Error(`[Storage Error] ${e.message}`);
            }

            if (this.context.socket && (this.context.socket.readyState === WebSocket.OPEN || this.context.socket.readyState === WebSocket.CONNECTING)) {
                if (this.context.isNamespaceJoined) {
                    this.context.isConnecting = false;
                    return;
                }
                this.context.socket.onopen = null;
                this.context.socket.onmessage = null;
                this.context.socket.onclose = null;
                this.context.socket.onerror = null;
                this.context.socket.close();
            }

            if (!navigator.onLine) {
                this.addLog('Browser is offline. Waiting...', 'warn');
                this.broadcastConnectionStatus('offline');
                this.context.isConnecting = false;
                if (this.context.currentRoom || this.context.connectIntent) {
                    this.scheduleReconnect();
                }
                return;
            }

            this.broadcastConnectionStatus('reconnecting');
            const isCustomServer = settings.serverUrl && settings.useCustomServer;
            finalUrl = isCustomServer ? settings.serverUrl : OFFICIAL_SERVER_URL;

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
                        this.addLog('Security: Upgraded to wss:// for remote host.', 'warn');
                    }
                }
            } catch (e) {
                throw new Error(`[URL Error] ${e.message}`);
            }

            this.addLog(`Connecting to ${isCustomServer ? finalUrl : 'Official Server'}... (attempt ${this.context.reconnectAttempts + 1})`, 'info');

            this.context.currentServerUrl = finalUrl;

            try {
                const url = new URL(finalUrl);
                url.pathname = '/socket.io/';
                url.searchParams.set('EIO', '4');
                url.searchParams.set('transport', 'websocket');
                url.searchParams.set('version', chrome.runtime.getManifest().version);
                url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);

                this.context.socket = new WebSocket(url.toString());
            } catch (e) {
                throw new Error(`[Connection Error] ${e.message}`);
            }

            this.context.socket.onopen = () => {
                this.context.reconnectAttempts = 0;
                this.context.reconnectStartTime = null;
                this.context.reconnectFailed = false;
                this.addLog('WebSocket Connection Opened', 'success');
                chrome.storage.session.set({ reconnectFailed: false, reconnectAttempts: 0, reconnectStartTime: null }).catch(() => {});
                this.context.isNamespaceJoined = false;
                this.context.socket.send('40');
            };

            this.context.socket.onmessage = async (event) => {
                const msg = event.data;
                if (msg === '2') {
                    this.context.socket.send('3');
                    return;
                }
                if (msg.startsWith('0')) {
                    this.addLog(`Socket.IO Handshake: ${msg}`, 'info');
                } else if (msg.startsWith('40')) {
                    this.context.isConnecting = false;
                    this.context.isNamespaceJoined = true;
                    this.broadcastConnectionStatus('connected');
                    this.startPing();
                    this.addLog('Joined Namespace /', 'success');
                    const settings = await this.getSettings();
                    if (settings.roomId) {
                        this.emit(EVENTS.JOIN_ROOM, { 
                            roomId: settings.roomId, 
                            password: settings.password,
                            peerId: this.context.peerId,
                            username: settings.username,
                            tabTitle: this.context.currentTabTitle,
                            protocolVersion: PROTOCOL_VERSION
                        });
                    }
                    while (this.context.eventQueue.length > 0) {
                        const queuedMsg = this.context.eventQueue.shift();
                        this.emit(queuedMsg.event, queuedMsg.data);
                    }
                    this.context.eventQueue = [];
                    chrome.storage.session.set({ eventQueue: [] });
                } else if (msg.startsWith('42')) {
                    try {
                        const payload = JSON.parse(msg.substring(2));
                        try {
                            await this.handleServerEvent(payload[0], payload[1]);
                        } catch (handlerErr) {
                            this.addLog(`Handler error for ${payload[0]}: ${handlerErr.message}`, 'error');
                        }
                    } catch (_e) {
                        this.addLog(`Failed to parse message: ${msg}`, 'error');
                    }
                }
            };

            this.context.socket.onclose = () => {
                this.context.isConnecting = false;
                this.context.isNamespaceJoined = false;
                this.stopPing();
                
                if (!this.context.connectIntent && !this.context.currentRoom) {
                    this.context.isForceSyncInitiator = false;
                    this.context.forceSyncAcks.clear();
                    if (this.context.forceSyncTimeout) clearTimeout(this.context.forceSyncTimeout);
                    chrome.storage.session.set({ 
                        isForceSyncInitiator: false, 
                        forceSyncAcks: [], 
                        forceSyncDeadline: null 
                    }).catch(() => {});
                }

                if (this.context.currentRoom && !this.context.connectIntent) {
                    this.context.currentRoom.peers = [];
                    if (this.context.storageInitialized) {
                        chrome.storage.session.set({ currentRoom: this.context.currentRoom }).catch(() => {});
                    }
                    chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: [] }).catch(() => {});
                }
                this.broadcastConnectionStatus('disconnected');
                if (this.context.currentRoom || this.context.connectIntent) {
                    this.addLog('Disconnected. Scheduling reconnect...', 'warn');
                    this.context.socket = null;
                    this.scheduleReconnect();
                } else {
                    this.addLog('Disconnected. No active session — staying disconnected.', 'info');
                    this.context.socket = null;
                }
            };

            this.context.socket.onerror = () => {
                this.broadcastConnectionStatus('disconnected');
                const logType = this.context.reconnectAttempts > 1 ? 'error' : 'warn';
                this.addLog('WebSocket Error: Connection failed', logType);
            };

        } catch (e) {
            this.context.isConnecting = false;
            const logType = this.context.reconnectAttempts > 1 ? 'error' : 'warn';
            const errMsg = (e && e.message) ? e.message : String(e || 'Unknown connection error');
            this.addLog(errMsg, logType);
            this.broadcastConnectionStatus('disconnected');
            if (this.context.currentRoom || this.context.connectIntent) {
                this.scheduleReconnect();
            }
        }
    }

    broadcastConnectionStatus(status) {
        chrome.runtime.sendMessage({ type: 'CONNECTION_STATUS', status }).catch(() => {});
        this.updateBadgeStatus();
    }

    scheduleReconnect() {
        if (this.context.reconnectTimer) return;

        if (!this.context.reconnectStartTime) {
            this.context.reconnectStartTime = Date.now();
        }

        const elapsed = Date.now() - this.context.reconnectStartTime;
        this.context.reconnectAttempts++;

        if (!this.context.reconnectFailed && (elapsed > 300000 || this.context.reconnectAttempts > this.maxReconnectAttempts)) {
            this.context.reconnectFailed = true;
            this.addLog('Switching to slow reconnect mode (every 5 minutes)', 'warn');
        }

        const delay = this.context.reconnectFailed
            ? 300000
            : Math.min(this.reconnectBaseDelay * Math.pow(1.5, this.context.reconnectAttempts - 1), this.reconnectMaxDelay);

        if (this.context.reconnectFailed) {
            this.addLog(`Slow reconnect in 5min (attempt ${this.context.reconnectAttempts})`, 'info');
        } else {
            this.addLog(`Reconnect in ${Math.round(delay)}ms (attempt ${this.context.reconnectAttempts})`, 'warn');
        }

        chrome.storage.session.set({
            reconnectFailed: this.context.reconnectFailed,
            reconnectAttempts: this.context.reconnectAttempts,
            reconnectStartTime: this.context.reconnectStartTime
        }).catch(() => {});

        this.context.reconnectTimer = setTimeout(() => {
            this.context.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    emit(event, data) {
        if (this.context.socket && this.context.socket.readyState === WebSocket.OPEN && this.context.isNamespaceJoined) {
            const msg = `42${JSON.stringify([event, data])}`;
            this.context.socket.send(msg);
        } else {
            this.context.eventQueue.push({ event, data });
            if (this.context.eventQueue.length > 50) {
                this.context.eventQueue.shift();
                this.addLog('Event queue cap reached, dropping oldest event', 'warn');
            }
            chrome.storage.session.set({ eventQueue: this.context.eventQueue });
        }
    }

    sendPing() {
        const t = Date.now();
        this.context.pendingPingT = t;
        this.emit(EVENTS.PING, { t });
        if (this.context.pingTimeout) clearTimeout(this.context.pingTimeout);
        this.context.pingTimeout = setTimeout(() => {
            if (this.context.pendingPingT === t) {
                this.addLog('Ping timeout reached, force disconnecting to trigger reconnect', 'warn');
                this.context.pendingPingT = null;
                this.forceDisconnect();
                if (this.context.currentRoom || this.context.connectIntent) {
                    this.scheduleReconnect();
                }
            }
            this.context.pingTimeout = null;
        }, 5000);
    }

    startPing() {
        if (this.context.pingInterval) clearInterval(this.context.pingInterval);
        if (this.context.pingTimeout) {
            clearTimeout(this.context.pingTimeout);
            this.context.pingTimeout = null;
        }
        this.context.currentPingMs = null;
        this.context.pendingPingT = null;
        this.context.pingInterval = setInterval(() => this.sendPing(), 15000);
        this.sendPing();
    }

    stopPing() {
        if (this.context.pingInterval) {
            clearInterval(this.context.pingInterval);
            this.context.pingInterval = null;
        }
        if (this.context.pingTimeout) {
            clearTimeout(this.context.pingTimeout);
            this.context.pingTimeout = null;
        }
        this.context.currentPingMs = null;
        this.context.pendingPingT = null;
    }
}
