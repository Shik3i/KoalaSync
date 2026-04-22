import { EVENTS, OFFICIAL_LANDING_PAGE_URL } from './shared/constants.js';
import { BLACKLIST_DOMAINS } from './shared/blacklist.js';

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
    joinBtn: document.getElementById('joinBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    roomInfo: document.getElementById('roomInfo'),
    inviteLink: document.getElementById('inviteLink'),
    filterNoise: document.getElementById('filterNoise'),
    historyList: document.getElementById('historyList'),
    copyLogs: document.getElementById('copyLogs'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    publicRooms: document.getElementById('publicRooms'),
    refreshRooms: document.getElementById('refreshRooms'),
    roomError: document.getElementById('roomError'),
    retryBtn: document.getElementById('retryBtn'),
    sectionJoin: document.getElementById('section-join'),
    sectionActive: document.getElementById('section-active'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn')
};

let localPeerId = null;
let lastPeersJson = null;

// --- Initialization ---
async function init() {
    // Load Settings
    const data = await chrome.storage.sync.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'targetTabId', 'filterNoise']);
    elements.serverUrl.value = data.serverUrl || '';
    elements.roomId.value = data.roomId || '';
    elements.password.value = data.password || '';
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
        }
    });

    // Check for invite link on landing page
    checkInviteLink();

    // Initial room list fetch
    chrome.runtime.sendMessage({ type: 'GET_ROOM_LIST' });
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
    }
}

function updatePeerList(peers) {
    if (!peers || !elements.peerList) return;
    
    // UI Throttle: Only re-render if the peer state actually changed
    const currentPeersJson = JSON.stringify(peers);
    if (currentPeersJson === lastPeersJson) return;
    lastPeersJson = currentPeersJson;

    elements.peerList.innerHTML = peers.map(p => {
        const id = escapeHtml(typeof p === 'object' ? p.peerId : p);
        const titleText = (typeof p === 'object' && p.tabTitle) ? escapeHtml(p.tabTitle) : '';
        const title = titleText ? `<div style="font-size:10px; color:var(--text-muted);">${titleText}</div>` : '';
        return `
            <div class="peer-item" style="display:block; padding: 6px 0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:600;">👤 ${id}</span>
                    ${id === escapeHtml(localPeerId) ? '<span style="font-size:10px; color:var(--accent)">YOU</span>' : ''}
                </div>
                ${title}
            </div>
        `;
    }).join('');
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
    
    // Custom colors for states
    if (connecting) elements.connDot.style.background = '#fbbf24';
    else if (failed) elements.connDot.style.background = '#ef4444';
    else elements.connDot.style.background = '';

    elements.connText.textContent = connected ? 'Connected' : (connecting ? 'Connecting...' : (failed ? 'Failed' : 'Disconnected'));
    elements.retryBtn.style.display = failed ? 'block' : 'none';
}

function updateHistory(history) {
    if (!history || !elements.historyList) return;
    if (history.length === 0) {
        elements.historyList.innerHTML = '<div style="text-align:center; padding: 10px;">No activity yet</div>';
        return;
    }
    elements.historyList.innerHTML = history.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const actionLabel = escapeHtml(item.action.toUpperCase().replace('FORCE_SYNC_', ''));
        const senderIdEscaped = escapeHtml(item.senderId);
        const sender = item.senderId === 'You' ? '<span style="color:var(--accent)">You</span>' : senderIdEscaped;
        return `<div style="margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 2px;">
            <span style="color:#64748b">[${time}]</span> <b>${actionLabel}</b> by ${sender}
        </div>`;
    }).join('');
}

function refreshHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (res) => {
        if (res) updateHistory(res);
    });
}

function updateRoomList(rooms) {
    if (!rooms || rooms.length === 0) {
        elements.publicRooms.innerHTML = '<div style="text-align:center; padding: 10px; color:var(--text-muted);">No active rooms</div>';
        return;
    }
    elements.publicRooms.innerHTML = rooms.map(r => `
        <div class="room-item" style="display:flex; justify-content:space-between; align-items:center; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor:pointer;" data-id="${escapeHtml(r.id)}">
            <div style="display:flex; align-items:center; gap: 6px;">
                <span style="font-weight:600;">${escapeHtml(r.id)}</span>
                ${r.hasPassword ? '<span title="Password Protected">🔒</span>' : ''}
            </div>
            <span style="font-size:11px; color:var(--accent)">${parseInt(r.peerCount)} peers</span>
        </div>
    `).join('');

    elements.publicRooms.querySelectorAll('.room-item').forEach(item => {
        item.addEventListener('click', () => {
            elements.roomId.value = item.dataset.id;
            elements.password.value = '';
            elements.password.focus();
        });
    });
}

function checkInviteLink() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab && tab.url && tab.url.includes(OFFICIAL_LANDING_PAGE_URL) && tab.url.includes('#join:')) {
            const parts = tab.url.split('#join:')[1].split(':');
            if (parts.length >= 2) {
                const roomId = parts[0];
                const password = parts[1];
                let useCustomServer = false;
                let serverUrl = '';

                // Smart Link: Parse Server Config if present
                if (parts.length >= 4) {
                    useCustomServer = parts[2] === '1';
                    serverUrl = decodeURIComponent(parts[3]);
                }

                elements.roomId.value = roomId;
                elements.password.value = password;
                
                if (parts.length >= 4) {
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
    const serverUrl = elements.serverUrl.value;
    const roomId = elements.roomId.value || Math.random().toString(36).substring(2, 8).toUpperCase();
    const password = elements.password.value;

    await chrome.storage.sync.set({ serverUrl, roomId, password });
    elements.roomId.value = roomId;

    // Tell background to connect
    chrome.runtime.sendMessage({ type: 'CONNECT' });
    
    // UI Feedback: Immediately switch state for better responsiveness
    const data = await chrome.storage.sync.get(['useCustomServer']);
    updateUI(roomId, password, data.useCustomServer, serverUrl);
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
    const settings = await chrome.storage.sync.get(['targetTabId']);
    if (!settings.targetTabId) return;

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
        if (logs) {
            elements.logList.innerHTML = logs.map(log => `
                <div class="log-entry log-${log.type}">
                    [${log.timestamp.split('T')[1].split('.')[0]}] ${escapeHtml(log.message)}
                </div>
            `).join('');
        }
    });
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LOG_UPDATE') {
        refreshLogs();
    } else if (msg.type === 'PEER_UPDATE') {
        updatePeerList(msg.peers);
    } else if (msg.type === 'CONNECTION_STATUS') {
        applyConnectionStatus(msg.status);
    } else if (msg.type === 'HISTORY_UPDATE') {
        updateHistory(msg.history);
    } else if (msg.type === 'ROOM_LIST') {
        updateRoomList(msg.rooms);
    } else if (msg.type === 'LOG_UPDATE' && msg.log && msg.log.type === 'error') {
        showError(msg.log.message);
    } else if (msg.type === 'JOIN_STATUS' && msg.success) {
        // Final confirmation of join from background
        chrome.storage.sync.get(['roomId', 'password', 'useCustomServer', 'serverUrl'], (data) => {
            updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
        });
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

init();
setInterval(refreshLogs, 5000);
