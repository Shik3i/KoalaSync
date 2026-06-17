export class TabManager {
    constructor(context, callbacks) {
        this.context = context;
        this.addLog = callbacks.addLog;
        this.updateBadgeStatus = callbacks.updateBadgeStatus;
        this.leaveRoomAfterIdleGrace = callbacks.leaveRoomAfterIdleGrace;
        this.emit = callbacks.emit;
    }

    resetAudioProcessingInTab(tabId) {
        if (!tabId) return;
        chrome.tabs.sendMessage(tabId, { action: 'RESET_AUDIO_PROCESSING' }).catch(() => {});
    }

    async applyAudioSettingsToTab(tabId) {
        if (!tabId) return;
        let data = (await chrome.storage.local.get(['audioSettings']));
        if (!data.audioSettings) {
            const syncData = await chrome.storage.sync.get(['audioSettings']);
            if (syncData.audioSettings) {
                data = syncData;
                await chrome.storage.local.set({ audioSettings: syncData.audioSettings });
            }
        }
        chrome.tabs.sendMessage(tabId, {
            action: 'APPLY_AUDIO_SETTINGS',
            settings: data.audioSettings
        }).catch(() => {});
    }

    clearTargetTabForIdle() {
        this.context.currentTabId = null;
        this.context.currentTabTitle = null;
        this.context.lastContentHeartbeatAt = null;
        if (this.context.currentRoom) {
            this.context.roomIdleSince = Date.now();
        }
        chrome.storage.session.set({
            currentTabId: null,
            currentTabTitle: null,
            roomIdleSince: this.context.roomIdleSince,
            lastContentHeartbeatAt: null
        }).catch(() => {});
        this.updateBadgeStatus();
    }

    async routeToContent(action, payload) {
        if (!this.context.currentTabId) return;
        const tabId = parseInt(this.context.currentTabId);
        if (isNaN(tabId)) return;

        const actionTimestamp = payload?.actionTimestamp || Date.now();
        const commandSenderId = payload?.senderId || null;

        this._routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, 0);
    }

    _routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, retries) {
        chrome.tabs.sendMessage(tabId, {
            type: 'SERVER_COMMAND',
            action,
            payload,
            actionTimestamp,
            commandSenderId
        }).catch(err => {
            if (retries >= 3) {
                this.addLog(`Content Script not responding in tab ${tabId} after ${retries} retries`, 'warn');
                this.clearTargetTabForIdle();
                return;
            }
            const errMsg = err && err.message ? err.message : '';
            if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Extension context invalidated')) {
                chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content.js']
                }).then(() => {
                    setTimeout(() => this._routeToContentInternal(tabId, action, payload, actionTimestamp, commandSenderId, retries + 1), 500);
                }).catch(() => {
                    this.addLog(`Auto-reinject failed for tab ${tabId}`, 'warn');
                });
            } else {
                this.addLog(`Content Script not responding in tab ${tabId}`, 'warn');
                this.clearTargetTabForIdle();
            }
        });
    }

    async handleTabRemoved(tabId) {
        if (tabId === this.context.currentTabId) {
            const wasInRoom = !!this.context.currentRoom;
            this.context.currentTabId = null;
            this.context.currentTabTitle = null;
            this.context.lastContentHeartbeatAt = null;
            this.context.roomIdleSince = Date.now();
            chrome.storage.session.set({
                currentTabId: null,
                currentTabTitle: null,
                roomIdleSince: this.context.roomIdleSince,
                lastContentHeartbeatAt: null
            });
            this.updateBadgeStatus();
            this.addLog('Target tab closed.', 'warn');

            if (wasInRoom) {
                const roomAtClose = this.context.currentRoom;
                try {
                    const settings = await chrome.storage.local.get(['username']);
                    if (this.context.currentRoom !== roomAtClose) return;

                    this.emit('PEER_STATUS', {
                        peerId: this.context.peerId,
                        playbackState: 'paused',
                        currentTime: null,
                        mediaTitle: null,
                        username: settings.username,
                        tabTitle: null
                    });

                    if (this.context.currentRoom && Array.isArray(this.context.currentRoom.peers)) {
                        const me = this.context.currentRoom.peers.find(p => (p.peerId || p) === this.context.peerId);
                        if (me && typeof me === 'object') {
                            me.playbackState = 'paused';
                            me.currentTime = null;
                            me.mediaTitle = null;
                            me.tabTitle = null;
                            me.lastHeartbeat = Date.now();
                            if (this.context.storageInitialized) {
                                await chrome.storage.session.set({ currentRoom: this.context.currentRoom });
                            }
                            chrome.runtime.sendMessage({ type: 'PEER_UPDATE', peers: this.context.currentRoom.peers }).catch(() => {});
                        }
                    }
                } catch (_) {
                    void 0;
                }
            }
        }
    }

    async handleTabUpdated(tabId, changeInfo) {
        if (this.context.currentTabId && tabId === parseInt(this.context.currentTabId) && changeInfo.status === 'complete') {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }).then(() => this.applyAudioSettingsToTab(tabId))
              .catch(() => {});
        }
    }
}
