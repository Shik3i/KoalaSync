export class WorkerContext {
    constructor(gettersSetters = null) {
        if (gettersSetters) {
            Object.keys(gettersSetters).forEach(key => {
                Object.defineProperty(this, key, {
                    get: gettersSetters[key].get,
                    set: gettersSetters[key].set
                });
            });
        } else {
            this.socket = null;
            this.isConnecting = false;
            this.peerId = null;
            this.currentRoom = null;
            this.currentTabId = null;
            this.currentTabTitle = null;
            this.logs = [];
            this.history = [];
            this.storageInitialized = false;
            this.pendingLogs = [];
            this.pendingHistory = [];
            this.eventQueue = [];
            this.isNamespaceJoined = false;
            this.lastActionState = { action: null, senderId: null, timestamp: 0, acks: [] };
            this.localSeq = 0;
            this.lastSeqBySender = {};
            this.activePorts = new Set();
            this.expectedAcksCount = 0;
            this.reconnectTimer = null;
            this.reconnectStartTime = null;
            this.reconnectFailed = false;
            this.reconnectAttempts = 0;
            this.currentServerUrl = null;
            this.roomIdleSince = null;
            this.lastContentHeartbeatAt = null;
            this.connectIntent = false;
            this.isForceSyncInitiator = false;
            this.forceSyncAcks = new Set();
            this.forceSyncTimeout = null;
            this.episodeLobby = null;
            this.episodeLobbyTimeout = null;
            this.pingInterval = null;
            this.pingTimeout = null;
            this.pendingPingT = null;
            this.currentPingMs = null;
        }
    }
}
