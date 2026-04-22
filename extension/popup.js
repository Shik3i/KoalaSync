import { EVENTS, OFFICIAL_LANDING_PAGE_URL } from './shared/constants.js';
import { BLACKLIST_DOMAINS } from './shared/blacklist.js';


const elements = {
    tabs: document.querySelectorAll('.tabs .tab-btn'),
    contents: document.querySelectorAll('.tab-content'),
    copyInvite: document.getElementById('copyInvite'),
    targetTab: document.getElementById('targetTab'),
    forceSyncBtn: document.getElementById('forceSyncBtn'),
    peerList: document.getElementById('peerList'),
    logList: document.getElementById('logList'),
    clearLogs: document.getElementById('clearLogs'),
    connDot: document.getElementById('connDot'),
    connText: document.getElementById('connText'),
    serverUrl: document.getElementById('serverUrl'),
    serverOfficial: document.getElementById('serverOfficial'),
    serverCustom: document.getElementById('serverCustom'),
    roomId: document.getElementById('roomId'),
    password: document.getElementById('password'),
    username: document.getElementById('username'),
    joinBtn: document.getElementById('joinBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    roomInfo: document.getElementById('roomInfo'),
    inviteLink: document.getElementById('inviteLink'),
    filterNoise: document.getElementById('filterNoise'),
    regenId: document.getElementById('regenId'),
    lastActionCard: document.getElementById('lastActionCard'),
    historyList: document.getElementById('historyList'),
    copyLogs: document.getElementById('copyLogs'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    publicRooms: document.getElementById('publicRooms'),
    refreshRooms: document.getElementById('refreshRooms'),
    roomError: document.getElementById('roomError'),
    retryBtn: document.getElementById('retryBtn'),
    sectionJoin: document.getElementById('section-join'),
    sectionActive: document.getElementById('section-active'),
    activeRoomId: document.getElementById('activeRoomId'),
    activeServer: document.getElementById('activeServer'),
    peerListSync: document.getElementById('peerListSync'),
    videoDebug: document.getElementById('videoDebug'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn')
};

let localPeerId = null;
let lastPeersJson = null;

// --- Initialization ---
async function init() {
    // Load Settings
    const data = await chrome.storage.sync.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'targetTabId', 'filterNoise', 'username']);
    elements.serverUrl.value = data.serverUrl || '';
    elements.roomId.value = data.roomId || '';
    elements.password.value = data.password || '';
    elements.username.value = data.username || '';
    elements.filterNoise.checked = data.filterNoise !== false;

    if (data.useCustomServer) {
        setServerMode(true);
    } else {
        setServerMode(false);
    }

    // Populate Tabs
    await populateTabs();

    toggleUIState(!!data.roomId);
    updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
    refreshLogs();
    refreshHistory();

    // Initial Status Check
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
        if (res) {
            localPeerId = res.peerId;
            applyConnectionStatus(res.status);
            updatePeerList(res.peers);
            if (res.lastActionState) updateLastActionUI(res.lastActionState, res.peers);
        }
    });

    // Check for invite link on landing page
    checkInviteLink();

    // Initial room list fetch
    chrome.runtime.sendMessage({ type: 'GET_ROOM_LIST' });

    // Debug Info Refresh
    setInterval(refreshDebugInfo, 2000);
}

// --- UI Logic ---
function toggleUIState(inRoom) {
    if (elements.sectionJoin) elements.sectionJoin.style.display = inRoom ? 'none' : 'block';
    if (elements.sectionActive) elements.sectionActive.style.display = inRoom ? 'block' : 'none';
}

function updateUI(roomId, password, useCustomServer = false, serverUrl = '') {
    const inRoom = !!roomId;
    toggleUIState(inRoom);
    if (inRoom) {
        const serverFlag = useCustomServer ? '1' : '0';
        const encodedUrl = encodeURIComponent(serverUrl || '');
        const invite = `${OFFICIAL_LANDING_PAGE_URL}/join.html#join:${roomId}:${password}:${serverFlag}:${encodedUrl}`;
        elements.inviteLink.value = invite;
        if (elements.activeRoomId) elements.activeRoomId.textContent = roomId;
        if (elements.activeServer) {
            elements.activeServer.textContent = useCustomServer ? (serverUrl || 'Custom Server') : 'Official Server';
            elements.activeServer.title = useCustomServer ? (serverUrl || '') : 'sync.shik3i.net';
        }
    } else {
        updatePeerList([]);
    }
}

function updateLastActionUI(state, peers) {
    if (!state || !state.action) {
        elements.lastActionCard.innerHTML = '<div style="text-align:center; color: var(--text-muted); font-size: 11px; padding-top: 20px;">No recent commands</div>';
        return;
    }

    const actionNames = {
        'play': 'PLAY',
        'pause': 'PAUSE',
        'seek': 'SEEK',
        'force_sync_prepare': 'SYNCING...',
        'force_sync_execute': 'FORCE PLAY'
    };

    let senderName = state.senderId === 'You' ? 'You' : state.senderId;
    const senderPeer = peers.find(p => (p.peerId || p) === state.senderId);
    if (senderPeer && senderPeer.username) senderName = senderPeer.username;

    const timeStr = new Date(state.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Clear previous content
    elements.lastActionCard.innerHTML = '';

    // Create Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:10px; align-items:baseline;';
    
    const actionSpan = document.createElement('span');
    actionSpan.style.cssText = 'font-weight:700; color:var(--accent); font-size:13px;';
    actionSpan.textContent = actionNames[state.action] || state.action.toUpperCase();
    
    const infoSpan = document.createElement('span');
    infoSpan.style.cssText = 'font-size:10px; color:var(--text-muted);';
    infoSpan.textContent = `${senderName} @ ${timeStr}`;
    
    header.appendChild(actionSpan);
    header.appendChild(infoSpan);
    elements.lastActionCard.appendChild(header);

    // Create Grid
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 6px;';

    peers.forEach(peer => {
        const pId = typeof peer === 'object' ? peer.peerId : peer;
        if (pId === localPeerId) return; // Exclude local user from acknowledgment list
        const pName = (typeof peer === 'object' && peer.username) ? peer.username : pId.substring(0, 4);
        const isAcked = state.acks.includes(pId) || pId === state.senderId;
        const color = isAcked ? 'var(--success)' : '#475569';
        const icon = isAcked ? '✓' : '...';
        
        const peerItem = document.createElement('div');
        peerItem.title = pName;
        peerItem.style.cssText = `display:flex; flex-direction:column; align-items:center; opacity: ${isAcked ? 1 : 0.6};`;
        
        const dot = document.createElement('div');
        dot.style.cssText = `width:20px; height:20px; border-radius:50%; background:${color}; color:white; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:bold; margin-bottom:2px;`;
        dot.textContent = icon;
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:8px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:40px;';
        nameSpan.textContent = pName;
        
        peerItem.appendChild(dot);
        peerItem.appendChild(nameSpan);
        grid.appendChild(peerItem);
    });

    elements.lastActionCard.appendChild(grid);
}

function updatePeerList(peers) {
    if (!peers) return;
    
    // UI Throttle: Only re-render if the peer state actually changed
    const currentPeersJson = JSON.stringify(peers);
    if (currentPeersJson === lastPeersJson) return;
    lastPeersJson = currentPeersJson;

    const renderPeers = (container) => {
        container.innerHTML = '';
        if (peers.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align:center; color: var(--text-muted); font-size: 12px;';
            empty.textContent = 'No peers connected';
            container.appendChild(empty);
            return;
        }

        peers.forEach(p => {
            const pId = typeof p === 'object' ? p.peerId : p;
            const pUsername = (typeof p === 'object' && p.username) ? p.username : '';
            const pTabTitle = (typeof p === 'object' && p.tabTitle) ? p.tabTitle : '';

            const peerItem = document.createElement('div');
            peerItem.className = 'peer-item';
            peerItem.style.cssText = 'display:block; padding: 6px 0;';

            const header = document.createElement('div');
            header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';

            const nameSpan = document.createElement('span');
            if (pUsername) {
                const u = document.createElement('span');
                u.style.cssText = 'font-weight:600; color:white;';
                u.textContent = pUsername;
                const i = document.createElement('span');
                i.style.cssText = 'font-size:10px; opacity:0.6; font-style:italic;';
                i.textContent = ` (${pId})`;
                nameSpan.appendChild(u);
                nameSpan.appendChild(i);
            } else {
                nameSpan.style.fontWeight = '600';
                nameSpan.textContent = `👤 ${pId}`;
            }

            header.appendChild(nameSpan);

            if (pId === localPeerId) {
                const you = document.createElement('span');
                you.style.cssText = 'font-size:10px; color:var(--accent)';
                you.textContent = 'YOU';
                header.appendChild(you);
            }

            peerItem.appendChild(header);

            if (pTabTitle) {
                const titleDiv = document.createElement('div');
                titleDiv.style.cssText = 'font-size:10px; color:var(--text-muted);';
                titleDiv.textContent = pTabTitle;
                peerItem.appendChild(titleDiv);
            }

            container.appendChild(peerItem);
        });
    };

    if (elements.peerList) renderPeers(elements.peerList);
    if (elements.peerListSync) renderPeers(elements.peerListSync);

    // Re-populate tabs to update Star Matching when peers change
    populateTabs(peers);
}

async function populateTabs(providedPeers = null) {
    const data = await chrome.storage.sync.get(['targetTabId', 'filterNoise']);
    const isFilterActive = data.filterNoise !== false;
    const currentTargetTabId = data.targetTabId;
 
    // Use provided peers or fetch if missing
    let peerIds = providedPeers;
    if (!peerIds) {
        const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r));
        peerIds = status?.peers || [];
    }

    const tabs = await chrome.tabs.query({});
    
    // Clear existing options except placeholder
    while (elements.targetTab.options.length > 1) {
        elements.targetTab.remove(1);
    }

    const filteredTabs = tabs.filter(tab => {
        if (!tab.url || tab.url.startsWith('chrome://')) return false;
        if (isFilterActive && tab.id !== parseInt(currentTargetTabId)) {
            const urlStr = tab.url.toLowerCase();
            if (BLACKLIST_DOMAINS.some(d => urlStr.includes(d.toLowerCase()))) return false;
        }
        return true;
    });

    filteredTabs.forEach(tab => {
        const option = document.createElement('option');
        option.value = tab.id;
        const title = (tab.title || 'Loading...');
        
        // Smart Matching Logic
        const peerTitles = peerIds.map(p => p.tabTitle).filter(t => t && t.length > 3);
        const isMatch = peerTitles.some(pt => {
            const t1 = title.toLowerCase();
            const t2 = pt.toLowerCase();
            return t1.includes(t2) || t2.includes(t1);
        });

        let label = title.substring(0, 45) + (title.length > 45 ? '...' : '');
        if (isMatch) {
            label = `⭐ MATCH: ${label}`;
            option.style.fontWeight = 'bold';
            option.style.color = 'var(--star)';
        }
        
        option.textContent = label;
        elements.targetTab.appendChild(option);
    });

    // Sort: Matches first
    const options = Array.from(elements.targetTab.options);
    const placeholder = options.shift(); // Remove placeholder
    options.sort((a, b) => (b.textContent.includes('⭐') ? 1 : 0) - (a.textContent.includes('⭐') ? 1 : 0));
    elements.targetTab.innerHTML = '';
    elements.targetTab.appendChild(placeholder);
    options.forEach(opt => elements.targetTab.appendChild(opt));

    if (currentTargetTabId) {
        elements.targetTab.value = currentTargetTabId;
    }
}

function applyConnectionStatus(status) {
    const connected = status === 'connected';
    const connecting = status === 'connecting';
    const failed = status === 'reconnect_failed';

    elements.connDot.className = 'status-dot ' + (connected ? 'status-online' : (failed ? 'status-offline' : (connecting ? 'status-online' : 'status-offline')));
    
    if (connecting) {
        elements.connDot.style.background = '#fbbf24';
        elements.connDot.style.boxShadow = '0 0 8px #fbbf24';
    } else if (failed) {
        elements.connDot.style.background = '#ef4444';
        elements.connDot.style.boxShadow = 'none';
    } else {
        elements.connDot.style.background = '';
        elements.connDot.style.boxShadow = '';
    }

    elements.connText.textContent = connected ? 'Connected' : (connecting ? 'Connecting...' : (failed ? 'Failed' : 'Disconnected'));
    elements.retryBtn.style.display = failed ? 'block' : 'none';

    // Update Join Button during auto-transition
    if (connecting) {
        elements.joinBtn.disabled = true;
        elements.joinBtn.textContent = '🚀 Joining...';
    } else {
        elements.joinBtn.disabled = false;
        elements.joinBtn.textContent = 'Join Room';
    }

    // Preserve icons for Remote Control buttons
    elements.playBtn.textContent = '▶ Play';
    elements.pauseBtn.textContent = '⏸ Pause';
    elements.forceSyncBtn.textContent = '⚡ Force Sync Everyone';
}

function updateHistory(history) {
    if (!history || !elements.historyList) return;
    elements.historyList.innerHTML = '';

    if (history.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center; padding: 10px;';
        empty.textContent = 'No activity yet';
        elements.historyList.appendChild(empty);
        return;
    }

    history.forEach(item => {
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const actionLabel = item.action.toUpperCase().replace('FORCE_SYNC_', '');
        
        const entry = document.createElement('div');
        entry.style.cssText = 'margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 2px;';
        
        const timeSpan = document.createElement('span');
        timeSpan.style.color = '#64748b';
        timeSpan.textContent = `[${time}] `;
        
        const actionBold = document.createElement('b');
        actionBold.textContent = actionLabel;
        
        const textNode1 = document.createTextNode(' by ');
        
        const senderSpan = document.createElement('span');
        if (item.senderId === 'You') {
            senderSpan.style.color = 'var(--accent)';
            senderSpan.textContent = 'You';
        } else {
            senderSpan.textContent = item.senderId;
        }
        
        entry.appendChild(timeSpan);
        entry.appendChild(actionBold);
        entry.appendChild(textNode1);
        entry.appendChild(senderSpan);
        
        elements.historyList.appendChild(entry);
    });
}

function refreshHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
        if (res) updateHistory(res);
    });
}

function updateRoomList(rooms) {
    if (!elements.publicRooms) return;
    elements.publicRooms.innerHTML = '';

    if (!rooms || rooms.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center; padding: 10px; color:var(--text-muted);';
        empty.textContent = 'No active rooms';
        elements.publicRooms.appendChild(empty);
        return;
    }

    rooms.forEach(r => {
        const item = document.createElement('div');
        item.className = 'room-item';
        item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor:pointer;';
        item.dataset.id = r.id;

        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display:flex; align-items:center; gap: 6px;';

        const idSpan = document.createElement('span');
        idSpan.style.fontWeight = '600';
        idSpan.textContent = r.id;

        leftSide.appendChild(idSpan);

        if (r.hasPassword) {
            const lock = document.createElement('span');
            lock.title = 'Password Protected';
            lock.textContent = '🔒';
            leftSide.appendChild(lock);
        }

        const peerCount = document.createElement('span');
        peerCount.style.cssText = 'font-size:11px; color:var(--accent)';
        peerCount.textContent = `${parseInt(r.peerCount)} peers`;

        item.appendChild(leftSide);
        item.appendChild(peerCount);

        item.addEventListener('click', () => {
            elements.roomId.value = r.id;
            elements.password.value = '';
            elements.password.focus();
        });

        elements.publicRooms.appendChild(item);
    });
}

function checkInviteLink() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab && tab.url && tab.url.includes(OFFICIAL_LANDING_PAGE_URL) && tab.url.includes('#join:')) {
            const rawHash = tab.url.split('#join:')[1];
            const parts = rawHash.split(':');
            if (parts.length >= 2) {
                const roomId = parts.shift();
                let useCustomServer = false;
                let serverUrl = '';

                // Smart Link: Parse Server Config if present
                const last = parts[parts.length - 1];
                const secondToLast = parts[parts.length - 2];
                const decodedLast = decodeURIComponent(last || '');
                const isCustom = secondToLast === '1' && (decodedLast.startsWith('ws://') || decodedLast.startsWith('wss://'));
                const isOfficial = secondToLast === '0' && last === '';

                if (parts.length >= 3 && (isCustom || isOfficial)) {
                    serverUrl = decodeURIComponent(parts.pop());
                    useCustomServer = parts.pop() === '1';
                }

                const password = parts.join(':');

                elements.roomId.value = roomId;
                elements.password.value = password;
                
                if (serverUrl || useCustomServer) {
                    elements.serverUrl.value = serverUrl;
                    setServerMode(useCustomServer);
                    chrome.storage.sync.set({ serverUrl, useCustomServer });
                }

                // Visual feedback
                elements.joinBtn.style.boxShadow = '0 0 15px var(--accent)';
                setTimeout(() => elements.joinBtn.style.boxShadow = '', 2000);
            }
        }
    });
}

function setServerMode(custom) {
    elements.serverOfficial.classList.toggle('active', !custom);
    elements.serverCustom.classList.toggle('active', custom);
    elements.serverUrl.style.display = custom ? 'block' : 'none';
    chrome.storage.sync.set({ useCustomServer: custom });
}

elements.serverOfficial.addEventListener('click', () => setServerMode(false));
elements.serverCustom.addEventListener('click', () => setServerMode(true));

elements.filterNoise.addEventListener('change', () => {
    chrome.storage.sync.set({ filterNoise: elements.filterNoise.checked }, () => {
        populateTabs();
    });
});

elements.serverUrl.addEventListener('input', () => {
    chrome.storage.sync.set({ serverUrl: elements.serverUrl.value });
});

elements.username.addEventListener('change', () => {
    chrome.storage.sync.set({ username: elements.username.value });
});

elements.serverUrl.addEventListener('change', () => {
    let url = elements.serverUrl.value.trim();
    if (url && !url.includes('://')) {
        url = 'ws://' + url;
        elements.serverUrl.value = url;
        chrome.storage.sync.set({ serverUrl: url });
    }
});

elements.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
        elements.tabs.forEach(b => b.classList.remove('active'));
        elements.contents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'tab-sync') refreshHistory();
    });
});

function showError(msg) {
    if (!elements.roomError) return;
    elements.roomError.textContent = msg;
    elements.roomError.style.display = 'block';
    elements.roomId.style.borderColor = 'var(--error)';
    elements.password.style.borderColor = 'var(--error)';
    
    // Shake effect
    const activeTab = document.querySelector('.tab-content.active');
    if (activeTab) {
        activeTab.animate([
            { transform: 'translateX(0)' },
            { transform: 'translateX(-5px)' },
            { transform: 'translateX(5px)' },
            { transform: 'translateX(0)' }
        ], { duration: 200, iterations: 2 });
    }

    setTimeout(() => {
        if (elements.roomError) elements.roomError.style.display = 'none';
        elements.roomId.style.borderColor = '';
        elements.password.style.borderColor = '';
    }, 5000);
}

// --- Action Handlers ---
elements.joinBtn.addEventListener('click', async () => {
    if (elements.joinBtn.disabled) return;
    const roomIdInput = elements.roomId.value.trim();
    const isCreating = !roomIdInput;
    
    elements.joinBtn.disabled = true;
    elements.joinBtn.textContent = isCreating ? 'Creating Room...' : 'Joining...';
    
    const serverUrl = elements.serverUrl.value.trim();
    const useCustom = elements.serverCustom.classList.contains('active');

    // Proactive URL Validation
    if (useCustom && serverUrl) {
        try {
            const urlToCheck = serverUrl.includes('://') ? serverUrl : 'ws://' + serverUrl;
            new URL(urlToCheck);
        } catch (e) {
            showError('Invalid Server URL format.');
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = 'Join Room';
            return;
        }
    }

    const roomId = roomIdInput || Math.random().toString(36).substring(2, 8).toUpperCase();
    const password = elements.password.value;

    await chrome.storage.sync.set({ serverUrl, roomId, password });
    elements.roomId.value = roomId;

    // Tell background to connect
    chrome.runtime.sendMessage({ type: 'CONNECT' });
    
    // UI Feedback: Immediately switch state for better responsiveness
    updateUI(roomId, password, useCustom, serverUrl);
});

elements.leaveBtn.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
    await chrome.storage.sync.set({ roomId: '', password: '' });
    elements.roomId.value = '';
    elements.password.value = '';
    updateUI(null, null);
});

elements.createRoomBtn.addEventListener('click', () => {
    const animals = ['koala', 'panda', 'tiger', 'eagle', 'fox', 'bear'];
    const adj = ['happy', 'cool', 'fast', 'smart', 'brave', 'calm'];
    const id = `${adj[Math.floor(Math.random() * adj.length)]}-${animals[Math.floor(Math.random() * animals.length)]}-${Math.floor(Math.random() * 100)}`;
    const pass = Math.random().toString(36).substring(2, 8);
    
    elements.roomId.value = id;
    elements.password.value = pass;
    elements.joinBtn.click();
});

elements.refreshRooms.addEventListener('click', () => {
    elements.publicRooms.innerHTML = '<div style="text-align:center; padding: 10px; color:var(--text-muted);">Refreshing...</div>';
    chrome.runtime.sendMessage({ type: 'GET_ROOM_LIST' });
});

elements.retryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RETRY_CONNECT' });
});

elements.targetTab.addEventListener('change', async () => {
    await chrome.storage.sync.set({ targetTabId: elements.targetTab.value });
});

elements.forceSyncBtn.addEventListener('click', async () => {
    if (elements.forceSyncBtn.disabled) return;
    
    const settings = await chrome.storage.sync.get(['targetTabId']);
    if (!settings.targetTabId) return;

    // Lockout to prevent spamming
    const originalText = elements.forceSyncBtn.textContent;
    elements.forceSyncBtn.disabled = true;
    elements.forceSyncBtn.textContent = 'Syncing...';
    setTimeout(() => {
        elements.forceSyncBtn.disabled = false;
        elements.forceSyncBtn.textContent = originalText;
    }, 5000);

    const tabId = parseInt(settings.targetTabId);

    const sendForceSync = (time) => {
        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action: EVENTS.FORCE_SYNC_PREPARE,
            payload: { targetTime: parseFloat(time) }
        });
    };

    chrome.tabs.sendMessage(tabId, { action: 'get_current_time' }, (response) => {
        if (chrome.runtime.lastError || !response || response.currentTime === undefined) {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }).then(() => {
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { action: 'get_current_time' }, (retryResponse) => {
                        if (retryResponse && retryResponse.currentTime !== undefined) {
                            sendForceSync(retryResponse.currentTime);
                        }
                    });
                }, 500);
            }).catch(() => {
                showError('Could not connect to video tab.');
            });
            return;
        }
        sendForceSync(response.currentTime);
    });
});

elements.playBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({
        type: 'CONTENT_EVENT',
        action: EVENTS.PLAY,
        payload: {}
    });
});

elements.pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({
        type: 'CONTENT_EVENT',
        action: EVENTS.PAUSE,
        payload: {}
    });
});

elements.clearLogs.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
        elements.logList.innerHTML = '';
    });
});

elements.copyInvite.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.inviteLink.value);
    elements.copyInvite.textContent = '✅';
    setTimeout(() => { elements.copyInvite.textContent = '📋'; }, 2000);
});

// --- Logs & Status ---
async function refreshLogs() {
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (logs) => {
        if (logs && elements.logList) {
            elements.logList.innerHTML = '';
            logs.forEach(log => {
                const entry = document.createElement('div');
                entry.className = `log-entry log-${log.type}`;
                const timeStr = log.timestamp.split('T')[1].split('.')[0];
                entry.textContent = `[${timeStr}] ${log.message}`;
                elements.logList.appendChild(entry);
            });
        }
    });
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LOG_UPDATE') {
        refreshLogs();
    } else if (msg.type === 'ACTION_UPDATE') {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
            if (res && res.peers) updateLastActionUI(msg.state, res.peers);
        });
    } else if (msg.type === 'PEER_UPDATE') {
        updatePeerList(msg.peers);
    } else if (msg.type === 'CONNECTION_STATUS') {
        applyConnectionStatus(msg.status);
        if (msg.status === 'connected') {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
                if (res && res.peers) updatePeerList(res.peers);
                if (res && res.lastActionState) updateLastActionUI(res.lastActionState, res.peers);
            });
        }
        if (msg.status === 'disconnected' || msg.status === 'reconnect_failed') {
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = 'Join Room';
        }
    } else if (msg.type === 'HISTORY_UPDATE') {
        updateHistory(msg.history);
    } else if (msg.type === 'ROOM_LIST') {
        updateRoomList(msg.rooms);
    } else if (msg.type === 'LOG_UPDATE' && msg.log && msg.log.type === 'error') {
        showError(msg.log.message);
    } else if (msg.type === 'JOIN_STATUS') {
        if (msg.success) {
            // Final confirmation of join from background
            chrome.storage.sync.get(['roomId', 'password', 'useCustomServer', 'serverUrl'], (data) => {
                updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
            });
        } else {
            // Join failed: reset UI state
            updateUI(null, null);
        }
    }
});

elements.copyLogs.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (logs) => {
        if (!logs || logs.length === 0) return;
        const text = logs.map(l => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const original = elements.copyLogs.textContent;
            elements.copyLogs.textContent = 'Copied!';
            setTimeout(() => elements.copyLogs.textContent = original, 2000);
        });
    });
});

function refreshDebugInfo() {
    // Only refresh if Dev tab is visible
    const devTab = document.getElementById('tab-dev');
    if (!devTab || devTab.style.display === 'none') return;

    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
        if (!res || !res.targetTabId) {
            if (elements.videoDebug) elements.videoDebug.textContent = 'No target tab selected.';
            return;
        }

        // Request direct state from the content script via background
        chrome.runtime.sendMessage({ type: 'GET_VIDEO_STATE', tabId: res.targetTabId }, (state) => {
            if (!state || state.error) {
                if (elements.videoDebug) elements.videoDebug.textContent = 'Could not communicate with tab video.';
                return;
            }

            if (elements.videoDebug) {
                elements.videoDebug.innerHTML = '';
                
                const status = document.createElement('div');
                status.style.cssText = 'color:var(--accent); margin-bottom:4px;';
                status.textContent = `VIDEO STATE: ${state.paused ? 'PAUSED' : 'PLAYING'}`;
                
                const time = document.createElement('div');
                time.style.fontSize = '11px';
                time.textContent = `Time: ${state.currentTime.toFixed(2)}s / ${state.duration.toFixed(2)}s`;
                
                const readyState = document.createElement('div');
                readyState.style.fontSize = '11px';
                readyState.textContent = `ReadyState: ${state.readyState}`;
                
                const misc = document.createElement('div');
                misc.style.fontSize = '11px';
                misc.textContent = `Muted: ${state.muted} | PlaybackRate: ${state.playbackRate}`;
                
                const url = document.createElement('div');
                url.style.cssText = 'font-size:9px; margin-top:4px; opacity:0.7;';
                url.textContent = `URL: ${state.url.substring(0, 40)}...`;
                
                elements.videoDebug.appendChild(status);
                elements.videoDebug.appendChild(time);
                elements.videoDebug.appendChild(readyState);
                elements.videoDebug.appendChild(misc);
                elements.videoDebug.appendChild(url);
            }
        });
    });
}

init();
setInterval(refreshLogs, 5000);
