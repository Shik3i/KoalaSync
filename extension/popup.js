import { EVENTS } from './shared/constants.js';
import { BLACKLIST_DOMAINS } from './shared/blacklist.js';

const elements = {
    tabs: document.querySelectorAll('.tab-btn'),
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
    copyLogs: document.getElementById('copyLogs')
};

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

    updateUI(data.roomId, data.password);
    refreshLogs();
    refreshHistory();

    // Initial Status Check
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
        if (res) {
            applyConnectionStatus(res.status);
            updatePeerList(res.peers);
        }
    });
}

// --- UI Logic ---
function updateUI(roomId, password) {
    const inRoom = !!roomId;
    elements.roomInfo.style.display = inRoom ? 'block' : 'none';
    if (inRoom) {
        elements.inviteLink.value = `${roomId}${password ? '#' + password : ''}`;
    }
}

function updatePeerList(peers) {
    if (!peers) return;
    elements.peerList.innerHTML = peers.map(id => `
        <div class="peer-item">
            <span>👤 ${id}</span>
        </div>
    `).join('');
    // Re-populate tabs to update Star Matching when peers change
    populateTabs();
}

async function populateTabs() {
    const data = await chrome.storage.sync.get(['targetTabId', 'filterNoise']);
    const isFilterActive = data.filterNoise !== false;
    const currentTargetTabId = data.targetTabId;

    // Get current peers from background to do matching
    const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r));
    const peerIds = status?.peers || [];

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
    elements.connDot.className = 'status-dot ' + (connected ? 'status-online' : 'status-offline');
    elements.connText.textContent = connected ? 'Connected' : (connecting ? 'Connecting...' : 'Disconnected');
}

function updateHistory(history) {
    if (!history || !elements.historyList) return;
    if (history.length === 0) {
        elements.historyList.innerHTML = '<div style="text-align:center; padding: 10px;">No activity yet</div>';
        return;
    }
    elements.historyList.innerHTML = history.map(item => {
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const actionLabel = item.action.toUpperCase().replace('FORCE_SYNC_', '');
        const sender = item.senderId === 'You' ? '<span style="color:var(--accent)">You</span>' : item.senderId;
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

elements.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
        elements.tabs.forEach(b => b.classList.remove('active'));
        elements.contents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        if (btn.dataset.tab === 'tab-sync') refreshHistory();
    });
});

// --- Action Handlers ---
elements.joinBtn.addEventListener('click', async () => {
    const serverUrl = elements.serverUrl.value;
    const roomId = elements.roomId.value || Math.random().toString(36).substring(2, 8).toUpperCase();
    const password = elements.password.value;

    await chrome.storage.sync.set({ serverUrl, roomId, password });
    elements.roomId.value = roomId;

    // Tell background to connect
    chrome.runtime.sendMessage({ type: 'CONNECT' });
    updateUI(roomId, password);
});

elements.leaveBtn.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
    await chrome.storage.sync.set({ roomId: '', password: '' });
    elements.roomId.value = '';
    elements.password.value = '';
    updateUI(null, null);
});

elements.targetTab.addEventListener('change', async () => {
    await chrome.storage.sync.set({ targetTabId: elements.targetTab.value });
});

elements.forceSyncBtn.addEventListener('click', async () => {
    const settings = await chrome.storage.sync.get(['targetTabId']);
    if (!settings.targetTabId) return;

    chrome.tabs.sendMessage(parseInt(settings.targetTabId), { action: 'get_current_time' }, (response) => {
        if (response && response.currentTime !== undefined) {
            const time = parseFloat(response.currentTime);
            chrome.runtime.sendMessage({
                type: 'CONTENT_EVENT',
                action: EVENTS.FORCE_SYNC_PREPARE,
                payload: { targetTime: time }
            });
        }
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
                    [${log.timestamp.split('T')[1].split('.')[0]}] ${log.message}
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
