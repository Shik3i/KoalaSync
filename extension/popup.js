import { EVENTS, OFFICIAL_LANDING_PAGE_URL, SUPPORT_URL, getReviewUrl } from './shared/constants.js';
import { BLACKLIST_DOMAINS } from './shared/blacklist.js';
import { getAvatarForName, generateUsername, USERNAME_ADJECTIVES, USERNAME_NOUNS } from './shared/names.js';
import { loadLocale, translateDOM, getMessage, getSystemLanguage } from './i18n.js';
import { TITLE_PRIVACY_MODES, normalizeSendTabTitle, normalizeTabTitle } from './title-privacy.js';


const elements = {
    tabs: document.querySelectorAll('.tabs .tab-btn'),
    contents: document.querySelectorAll('.tab-content'),
    copyInvite: document.getElementById('copyInvite'),
    targetTab: document.getElementById('targetTab'),
    forceSyncBtn: document.getElementById('forceSyncBtn'),
    forceSyncMode: document.getElementById('forceSyncMode'),
    peerList: document.getElementById('peerList'),
    logList: document.getElementById('logList'),
    clearLogs: document.getElementById('clearLogs'),
    connDot: document.getElementById('connDot'),
    connText: document.getElementById('connText'),
    connInfo: document.getElementById('connInfo'),
    connPing: document.getElementById('connPing'),
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
    restartTourBtn: document.getElementById('restartTourBtn'),
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
    hostControlCard: document.getElementById('hostControlCard'),
    hostRoleBadge: document.getElementById('hostRoleBadge'),
    hostControlToggleRow: document.getElementById('hostControlToggleRow'),
    hostControlToggle: document.getElementById('hostControlToggle'),
    hostControlGuestNote: document.getElementById('hostControlGuestNote'),
    hostControlCohostHint: document.getElementById('hostControlCohostHint'),
    activeRoomId: document.getElementById('activeRoomId'),
    activeServer: document.getElementById('activeServer'),
    peerListSync: document.getElementById('peerListSync'),
    videoDebug: document.getElementById('videoDebug'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    autoSyncNextEpisode: document.getElementById('autoSyncNextEpisode'),
    sendTabTitle: document.getElementById('sendTabTitle'),
    mediaTitlePrivacyMode: document.getElementById('mediaTitlePrivacyMode'),
    episodeLobbyCard: document.getElementById('episodeLobbyCard'),
    lobbyTitle: document.getElementById('lobbyTitle'),
    lobbyPeerStatus: document.getElementById('lobbyPeerStatus'),
    browserNotifications: document.getElementById('browserNotifications'),
    autoCopyInvite: document.getElementById('autoCopyInvite'),
    cancelLobbyBtn: document.getElementById('cancelLobbyBtn'),
    langSelector: document.getElementById('langSelector'),

    audioSettingsLink: document.getElementById('audioSettingsLink'),
    settingsSupportLink: document.getElementById('settingsSupportLink'),
    settingsReviewLink: document.getElementById('settingsReviewLink'),
    settingsVersion: document.getElementById('settingsVersion'),
    devSupportLink: document.getElementById('devSupportLink'),
    devReviewLink: document.getElementById('devReviewLink'),
    syncTabCopyInvite: document.getElementById('syncTabCopyInvite'),
    devToolsTabBtn: document.getElementById('devToolsTabBtn'),
    remoteSeekBack: document.getElementById('remoteSeekBack'),
    remoteSeekForward: document.getElementById('remoteSeekForward'),
    remoteSeekFiveMin: document.getElementById('remoteSeekFiveMin'),

    // Chat elements
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    sendBtn: document.getElementById('send-btn'),
    emojiBtn: document.getElementById('emoji-btn'),
    chatTypingIndicator: document.getElementById('chat-typing-indicator')
};

let localPeerId = null;
let lastPeersJson = null;
let lastKnownPeers = [];
let isDevTabVisible = false;
let reconnectSlowMode = false;
let isProcessingConnection = false;
let joinBtnTimeout = null;
let forceSyncResetTimer = null;
let popupIntervals = [];
let populateTabsToken = null;
let errorToken = 0;
let forceSyncDone = false;
let connectionErrorTimer = null;
let pendingConnectionErrorMsg = null;

// Chat state (reserved for future implementation)
let _chatMessages = [];
let _typingDebounce = null;
let _readReceipts = new Map();

function devToolsEnabled() {
    return elements.username && elements.username.value.trim() === 'KoalaDev';
}

function syncDevToolsVisibility() {
    if (!elements.devToolsTabBtn) return;
    const enabled = devToolsEnabled();
    elements.devToolsTabBtn.style.display = enabled ? '' : 'none';
    if (!enabled && document.getElementById('tab-devtools')?.classList.contains('active')) {
        document.querySelector('.tab-btn[data-tab="tab-settings"]')?.click();
    }
}
let roomListRefreshTimer = null;
let roomListRefreshInterval = null;
const ROOM_LIST_REFRESH_COOLDOWN_MS = 11000;
const FEATURE_HINTS = [
    {
        key: 'audio_processing',
        selector: '#audioProcessingLabel',
        position: 'beforebegin',
        i18nTooltip: 'NEW_FEATURE_AUDIO'
    }
];

// --- Helpers ---
function configureFooterLinks() {
    const reviewUrl = getReviewUrl();
    [elements.settingsSupportLink, elements.devSupportLink].forEach(link => {
        if (link) link.href = SUPPORT_URL;
    });
    [elements.settingsReviewLink, elements.devReviewLink].forEach(link => {
        if (link) link.href = reviewUrl;
    });
}

function openAudioSettingsPage() {
    chrome.tabs.create({ url: chrome.runtime.getURL('audio-options.html') });
}

async function updateFeatureHints() {
    const data = await chrome.storage.sync.get(['dismissedHints']);
    const dismissed = Array.isArray(data.dismissedHints) ? data.dismissedHints : [];

    FEATURE_HINTS.forEach(feature => {
        const target = document.querySelector(feature.selector);
        if (!target) return;

        const existing = target.parentElement?.querySelector(`.feature-hint[data-feature="${feature.key}"]`);
        if (dismissed.includes(feature.key)) {
            if (existing) existing.remove();
            return;
        }

        if (!existing) {
            const hint = document.createElement('span');
            hint.className = 'feature-hint';
            hint.dataset.feature = feature.key;
            hint.title = getMessage(feature.i18nTooltip);
            target.insertAdjacentElement(feature.position || 'afterend', hint);
        } else {
            existing.title = getMessage(feature.i18nTooltip);
        }
    });
}

async function dismissFeatureHint(featureKey) {
    const data = await chrome.storage.sync.get(['dismissedHints']);
    const dismissed = Array.isArray(data.dismissedHints) ? data.dismissedHints : [];
    if (!dismissed.includes(featureKey)) {
        await chrome.storage.sync.set({ dismissedHints: [...dismissed, featureKey] });
    }
    await updateFeatureHints();
}

function clearConnectionErrorTimer() {
    if (connectionErrorTimer) {
        clearTimeout(connectionErrorTimer);
        connectionErrorTimer = null;
    }
    pendingConnectionErrorMsg = null;
}

function setRoomRefreshCooldown() {
    if (roomListRefreshTimer) clearTimeout(roomListRefreshTimer);
    if (roomListRefreshInterval) clearInterval(roomListRefreshInterval);
    const originalLabel = getMessage('BTN_REFRESH');
    const updateLabel = () => {
        const secondsLeft = Math.max(1, Math.ceil((cooldownEndsAt - Date.now()) / 1000));
        elements.refreshRooms.textContent = getMessage('BTN_REFRESH_COOLDOWN', { seconds: secondsLeft });
        elements.refreshRooms.title = getMessage('BTN_REFRESH_COOLDOWN_TOOLTIP', { seconds: secondsLeft });
    };

    const cooldownEndsAt = Date.now() + ROOM_LIST_REFRESH_COOLDOWN_MS;
    elements.refreshRooms.disabled = true;
    updateLabel();

    roomListRefreshInterval = setInterval(updateLabel, 250);
    roomListRefreshTimer = setTimeout(() => {
        elements.refreshRooms.disabled = false;
        elements.refreshRooms.textContent = originalLabel;
        elements.refreshRooms.title = getMessage('BTN_REFRESH_TOOLTIP');
        clearInterval(roomListRefreshInterval);
        roomListRefreshInterval = null;
        roomListRefreshTimer = null;
    }, ROOM_LIST_REFRESH_COOLDOWN_MS);
}

// --- Initialization ---
async function init() {
    // Local-only by design — settings and room credentials never come from
    // storage.sync (only onboardingComplete + dismissedHints live there).
    const localData = await chrome.storage.local.get(['serverUrl', 'useCustomServer', 'roomId', 'password', 'username', 'filterNoise', 'autoSyncNextEpisode', 'sendTabTitle', 'mediaTitlePrivacyMode', 'titlePrivacyMode', 'forceSyncMode', 'browserNotifications', 'autoCopyInvite', 'locale', 'audioSettings', 'activeTab']);

    let activeLang = localData.locale;
    if (!activeLang) {
        activeLang = getSystemLanguage();
        chrome.storage.local.set({ locale: activeLang });
    }

    await loadLocale(activeLang);
    translateDOM();
    
    if (elements.langSelector) elements.langSelector.value = activeLang;
    
    let username = localData.username;
    if (!username) {
        username = generateUsername();
        await chrome.storage.local.set({ username });
    }
    
    elements.serverUrl.value = localData.serverUrl || '';
    elements.roomId.value = localData.roomId || '';
    elements.password.value = localData.password || '';
    elements.username.value = username;
    syncDevToolsVisibility();
    if (elements.filterNoise) elements.filterNoise.checked = localData.filterNoise !== false;
    if (elements.autoSyncNextEpisode) elements.autoSyncNextEpisode.checked = localData.autoSyncNextEpisode !== false;
    const legacyTitlePrivacyMode = Object.values(TITLE_PRIVACY_MODES).includes(localData.titlePrivacyMode) ? localData.titlePrivacyMode : TITLE_PRIVACY_MODES.FULL;
    const mediaTitlePrivacyMode = Object.values(TITLE_PRIVACY_MODES).includes(localData.mediaTitlePrivacyMode) ? localData.mediaTitlePrivacyMode : legacyTitlePrivacyMode;
    if (elements.sendTabTitle) elements.sendTabTitle.checked = normalizeSendTabTitle(localData.sendTabTitle, legacyTitlePrivacyMode);
    if (elements.mediaTitlePrivacyMode) elements.mediaTitlePrivacyMode.value = mediaTitlePrivacyMode;
    if (elements.forceSyncMode) elements.forceSyncMode.value = localData.forceSyncMode || 'jump-to-others';
    if (elements.browserNotifications) elements.browserNotifications.checked = localData.browserNotifications === true;
    if (elements.autoCopyInvite) elements.autoCopyInvite.checked = localData.autoCopyInvite !== false;
    
    // Set Version Info
    const versionTxt = `v${chrome.runtime.getManifest().version}`;
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = versionTxt;
    const popupVerEl = document.getElementById('popupVersion');
    if (popupVerEl) popupVerEl.textContent = versionTxt;
    if (elements.settingsVersion) elements.settingsVersion.textContent = versionTxt;
    configureFooterLinks();
    await updateFeatureHints();

    if (localData.useCustomServer) {
        setServerMode(true);
    } else {
        setServerMode(false);
    }

    toggleUIState(!!localData.roomId);
    updateUI(localData.roomId, localData.password, localData.useCustomServer, localData.serverUrl);
    refreshLogs();
    refreshHistory();

    // Initial Status Check (status shows via GET_STATUS below)

    // Initial Status Check
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, async (res) => {
        if (chrome.runtime.lastError) {
            console.warn('[Popup] Background not responding:', chrome.runtime.lastError.message);
            await populateTabs();
            return;
        }
        if (res) {
            localPeerId = res.peerId;
            reconnectSlowMode = res.reconnectSlowMode || false;
            applyConnectionStatus(res.status);
            updatePingDisplay(res.ping);
            updatePeerList(res.peers);
            lastKnownPeers = res.peers || [];
            updateHostControlUI({ controlMode: res.controlMode, amHost: res.amHost, amController: res.amController, controllers: res.controllers, hostPeerId: res.hostPeerId, hostControlSupported: res.hostControlSupported, coHostSupported: res.coHostSupported, inRoom: res.status === 'connected' });
            if (res.lastActionState) updateLastActionUI(res.lastActionState, res.peers);

            // If user has a room configured but background is not connected (disconnected or idle),
            // trigger connection now — the popup opening is explicit user intent.
            if ((res.status === 'disconnected' || res.status === 'idle') && localData.roomId) {
                chrome.runtime.sendMessage({ type: 'CONNECT' }).catch(() => {});
                applyConnectionStatus('connecting');
            }
            
            // Populate Tabs using the background's targetTabId
            await populateTabs(res.peers, res.targetTabId);

            // Render lobby status if active
            if (res.episodeLobby) updateLobbyUI(res.episodeLobby, res.peers);

            if (res.status === 'connected' && !res.targetTabId && localData.roomId) {
                const syncTabBtn = document.querySelector('.tab-btn[data-tab="tab-sync"]');
                if (syncTabBtn) syncTabBtn.click();
                showSelectVideoHint();
            } else if (localData.activeTab && (localData.activeTab !== 'tab-devtools' || devToolsEnabled())) {
                const btn = document.querySelector(`.tab-btn[data-tab="${localData.activeTab}"]`);
                if (btn) btn.click();
            }
        } else {
            await populateTabs();
            if (localData.activeTab && (localData.activeTab !== 'tab-devtools' || devToolsEnabled())) {
                const btn = document.querySelector(`.tab-btn[data-tab="${localData.activeTab}"]`);
                if (btn) btn.click();
            }
        }
    });

    // Check for invite link on landing page
    checkInviteLink();

    // Initialize public rooms placeholder
    renderEmpty(elements.publicRooms, 'rooms');

    // Debug Info Refresh
    popupIntervals.push(setInterval(refreshDebugInfo, 2000));

    // Show onboarding on first visit
    chrome.storage.sync.get(['onboardingComplete'], (data) => {
        if (!data.onboardingComplete) showOnboarding();
    });
}

// --- UI Logic ---
function toggleUIState(inRoom) {
    if (elements.sectionJoin) elements.sectionJoin.style.display = inRoom ? 'none' : 'block';
    if (elements.sectionActive) elements.sectionActive.style.display = inRoom ? 'block' : 'none';
    if (elements.peerListSync) elements.peerListSync.style.display = inRoom ? 'block' : 'none';
    
    const syncActive = document.getElementById('sync-active');
    const syncInactive = document.getElementById('sync-inactive');
    if (syncActive) syncActive.style.display = inRoom ? 'block' : 'none';
    if (syncInactive) syncInactive.style.display = inRoom ? 'none' : 'block';
}

// --- Host Control Mode UI ---
// True when we're a guest in a host-only room → remote-control buttons are locked.
let hcmGuestLocked = false;

// Co-Host state mirrored for the peer-list renderer (promote/demote + role badges).
let hcmAmOwner = false;
let hcmControllers = [];
let hcmCoHostSupported = false;
let hcmOwnerPeerId = null;
let hcmRoomIsHostOnly = false;

function updateHostControlUI(state) {
    const s = state || {};
    const controlMode = s.controlMode;
    const amHost = !!s.amHost;
    const amController = !!s.amController;
    const hostOnly = controlMode === 'host-only';

    // Stash for the peer-list renderer, then force it to re-render with new roles.
    hcmAmOwner = amHost;
    hcmControllers = Array.isArray(s.controllers) ? s.controllers : [];
    hcmCoHostSupported = !!s.coHostSupported;
    hcmOwnerPeerId = s.hostPeerId || null;
    hcmRoomIsHostOnly = hostOnly;
    lastPeersJson = '';
    if (activePeers) updatePeerList(activePeers);

    const card = elements.hostControlCard;
    if (!card) return;
    // Explicit capability advertised by the relay. Against an older relay it's
    // false/absent → feature unavailable, so hide the card instead of misleading UI.
    const serverSupportsHostControl = !!s.hostControlSupported;
    // Show the card only when meaningful: owner always (to manage); a non-controller
    // guest only while host-only is active. A guest in a normal room sees nothing.
    const show = s.inRoom && serverSupportsHostControl && (amHost || hostOnly);
    if (!show) {
        card.style.display = 'none';
        hcmGuestLocked = false;
        setRemoteControlsLocked(false);
        return;
    }
    card.style.display = 'block';
    if (elements.hostRoleBadge) {
        const role = amHost ? (getMessage('BADGE_HOST') || 'Host')
                   : amController ? (getMessage('BADGE_CONTROLLER') || 'Controller')
                   : (getMessage('BADGE_GUEST') || 'Guest');
        elements.hostRoleBadge.textContent = role;
        elements.hostRoleBadge.style.background = (amHost || amController) ? 'var(--accent)' : 'var(--text-muted)';
    }
    if (elements.hostControlToggleRow) elements.hostControlToggleRow.style.display = amHost ? 'flex' : 'none';
    if (elements.hostControlToggle) elements.hostControlToggle.checked = hostOnly;
    if (elements.hostControlGuestNote) elements.hostControlGuestNote.style.display = (!amController && hostOnly) ? 'block' : 'none';
    // Owner-only discoverability hint: co-hosting is granted down in the peer list,
    // which isn't obvious from this card. Only show it when it's actionable — owner,
    // relay supports co-host, and the room is locked to host-only (the buttons only
    // render in that mode).
    if (elements.hostControlCohostHint) elements.hostControlCohostHint.style.display = (amHost && !!s.coHostSupported && hostOnly) ? 'block' : 'none';

    // Only a non-controller is locked out of the remote controls.
    hcmGuestLocked = (!amController && hostOnly);
    setRemoteControlsLocked(hcmGuestLocked);
}

function setRemoteControlsLocked(locked) {
    [elements.playBtn, elements.pauseBtn, elements.forceSyncBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = locked;
        btn.style.opacity = locked ? '0.5' : '';
        btn.style.cursor = locked ? 'not-allowed' : '';
        btn.title = locked ? (getMessage('NOTICE_HOST_CONTROLS') || 'The host controls playback for everyone.') : '';
    });
    // Always restore the default labels. The action handlers leave the text in a
    // transitional state ("Playing..." / "Pausing...") and the 2.5s safety reset
    // skips the refresh while guest-locked — so reset on BOTH transitions: on lock
    // (host enabled host-only just as the guest clicked → don't freeze "Playing...")
    // and on unlock (L-1).
    if (elements.playBtn) elements.playBtn.textContent = getMessage('BTN_PLAY') || 'Play';
    if (elements.pauseBtn) elements.pauseBtn.textContent = getMessage('BTN_PAUSE') || 'Pause';
}

if (elements.hostControlToggle) {
    elements.hostControlToggle.addEventListener('change', () => {
        const mode = elements.hostControlToggle.checked ? 'host-only' : 'everyone';
        chrome.runtime.sendMessage({ type: 'SET_CONTROL_MODE', controlMode: mode }, (res) => {
            // Server broadcasts CONTROL_MODE back to refresh the UI; revert on failure.
            if (chrome.runtime.lastError || !res || res.status !== 'ok') {
                elements.hostControlToggle.checked = (mode === 'everyone');
            }
        });
    });
}

function updateUI(roomId, password, useCustomServer = false, serverUrl = '') {
    const inRoom = !!roomId;
    toggleUIState(inRoom);
    if (inRoom) {
        let invite = `${OFFICIAL_LANDING_PAGE_URL}/join.html#join:${roomId}:${password}`;
        if (useCustomServer) {
            const encodedUrl = encodeURIComponent(serverUrl || '');
            invite += `:1:${encodedUrl}`;
        }
        elements.inviteLink.value = invite;
        
        if (window.justCreatedRoom) {
            window.justCreatedRoom = false;
            if (elements.autoCopyInvite && elements.autoCopyInvite.checked && elements.copyInvite) {
                elements.copyInvite.click();
            }
        }

        if (elements.activeRoomId) elements.activeRoomId.textContent = roomId;
        if (elements.activeServer) {
            elements.activeServer.textContent = useCustomServer ? (serverUrl || getMessage('LABEL_CUSTOM_SERVER')) : getMessage('ACTIVE_SERVER_OFFICIAL');
            elements.activeServer.title = useCustomServer ? (serverUrl || '') : 'syncserver.koalastuff.net';
        }
    } else {
        updatePeerList([]);
        if (elements.inviteLink) elements.inviteLink.value = '';
        if (elements.activeRoomId) elements.activeRoomId.textContent = '';
        if (elements.activeServer) {
            elements.activeServer.textContent = '';
            elements.activeServer.title = '';
        }
        lastKnownPeers = [];
    }
}

function updateLastActionUI(state, peers) {
    if (!state || !state.action) {
        elements.lastActionCard.replaceChildren();
        const el = document.createElement('div');
        el.style.cssText = 'text-align:center; color: var(--text-muted); font-size: 10px;';
        el.textContent = getMessage('NO_RECENT_COMMANDS');
        elements.lastActionCard.appendChild(el);
        return;
    }

    const safePeers = peers || [];
    const safeAcks = state.acks || [];

    const actionNames = {
        'play': getMessage('BTN_PLAY').replace('▶ ', '').toUpperCase(),
        'pause': getMessage('BTN_PAUSE').replace('⏸ ', '').toUpperCase(),
        'seek': getMessage('NOTIF_SEEK').toUpperCase(),
        'force_sync_prepare': getMessage('BTN_STATE_SYNCING').toUpperCase(),
        'force_sync_execute': getMessage('BTN_STATE_SYNCED').toUpperCase()
    };

    let senderName = state.senderId === 'You' ? (getMessage('LABEL_YOU') || 'YOU') : state.senderId;
    const senderPeer = safePeers.find(p => (p.peerId || p) === state.senderId);
    if (senderPeer && senderPeer.username) senderName = senderPeer.username;

    const ts = state.timestamp ? new Date(state.timestamp) : new Date();
    const timeStr = isNaN(ts.getTime()) ? '--:--' : ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    elements.lastActionCard.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px; align-items:baseline;';
    
    const actionSpan = document.createElement('span');
    actionSpan.style.cssText = 'font-weight:700; color:var(--accent); font-size:11px;';
    actionSpan.textContent = actionNames[state.action] || state.action.toUpperCase();
    
    const infoSpan = document.createElement('span');
    infoSpan.style.cssText = 'font-size:9px; color:var(--text-muted);';
    infoSpan.textContent = `${senderName} @ ${timeStr}`;
    
    header.appendChild(actionSpan);
    header.appendChild(infoSpan);
    elements.lastActionCard.appendChild(header);

    if (state.targetTime !== undefined && state.action === 'seek') {
        const timeInfo = document.createElement('div');
        timeInfo.style.cssText = 'font-size:9px; color:var(--text-muted); margin-top:4px;';
        timeInfo.textContent = `Target: ${formatTime(state.targetTime)}`;
        elements.lastActionCard.appendChild(timeInfo);
    }

    if (state.targetTime !== undefined && state.action.includes('force_sync')) {
        const timeInfo = document.createElement('div');
        timeInfo.style.cssText = 'font-size:9px; color:var(--text-muted); margin-top:4px;';
        timeInfo.textContent = `Sync to: ${formatTime(state.targetTime)}`;
        elements.lastActionCard.appendChild(timeInfo);
    }

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns: repeat(auto-fill, minmax(36px, 1fr)); gap: 5px;';

    safePeers.forEach(peer => {
        const pId = typeof peer === 'object' ? peer.peerId : peer;
        if (pId === localPeerId) return;
        const pName = (typeof peer === 'object' && peer.username) ? peer.username : pId.substring(0, 4);
        const isAcked = safeAcks.includes(pId) || pId === state.senderId;
        const color = isAcked ? 'var(--success)' : '#475569';
        const icon = isAcked ? '✓' : '...';
        const avatar = getAvatarForName(pName);
        
        const peerItem = document.createElement('div');
        peerItem.title = pName;
        peerItem.style.cssText = `display:flex; flex-direction:column; align-items:center; opacity: ${isAcked ? 1 : 0.6};`;
        
        const dot = document.createElement('div');
        dot.style.cssText = `width:18px; height:18px; border-radius:50%; background:${color}; color:white; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:bold; margin-bottom:1px;`;
        dot.textContent = icon;
        
        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'font-size:7px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:36px;';
        nameSpan.textContent = `${avatar} ${pName}`;
        
        peerItem.appendChild(dot);
        peerItem.appendChild(nameSpan);
        grid.appendChild(peerItem);
    });

    elements.lastActionCard.appendChild(grid);
}

function formatTime(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) return '--:--';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function getVolumeIcon(volume, muted) {
    if (muted || volume === 0) return '🔇';
    if (volume < 0.33) return '🔈';
    if (volume < 0.66) return '🔉';
    return '🔊';
}

let activePeers = [];
let interpolationInterval = null;

function stopInterpolation() {
    if (interpolationInterval) {
        clearInterval(interpolationInterval);
        interpolationInterval = null;
    }
}

function startInterpolation() {
    if (interpolationInterval) return;
    interpolationInterval = setInterval(() => {
        const timeElements = document.querySelectorAll('.peer-time-display');
        timeElements.forEach(el => {
            const peerId = el.dataset.peerId;
            const peer = activePeers.find(p => p.peerId === peerId);
            if (peer && peer.playbackState === 'playing' && peer.currentTime != null && peer.lastHeartbeat) {
                const elapsed = (Date.now() - peer.lastHeartbeat) / 1000;
                if (elapsed < 45) {
                    el.textContent = formatTime(peer.currentTime + elapsed);
                }
            }
        });
    }, 1000);
}

function renderEmpty(container, type) {
    const states = {
        peers: { icon: '\u{1F465}', title: getMessage('EMPTY_PEERS_TITLE'), hint: getMessage('EMPTY_PEERS_HINT') },
        history: { icon: '\u{1F4CB}', title: getMessage('EMPTY_HISTORY_TITLE'), hint: getMessage('EMPTY_HISTORY_HINT') },
        logs: { icon: '\u{1F4DD}', title: getMessage('EMPTY_LOGS_TITLE'), hint: getMessage('EMPTY_LOGS_HINT') },
        rooms: { icon: '\u{1F50D}', title: getMessage('EMPTY_ROOMS_TITLE'), hint: getMessage('EMPTY_ROOMS_HINT') }
    };
    const state = states[type] || { icon: '', title: '', hint: '' };
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'text-align:center; padding:16px 8px; color:var(--text-muted);';
    const iconDiv = document.createElement('div');
    iconDiv.style.cssText = 'font-size:24px; margin-bottom:6px;';
    iconDiv.textContent = state.icon;
    const titleDiv = document.createElement('div');
    titleDiv.style.cssText = 'font-size:12px; font-weight:600; margin-bottom:4px;';
    titleDiv.textContent = state.title;
    const hintDiv = document.createElement('div');
    hintDiv.style.cssText = 'font-size:10px; opacity:0.7;';
    hintDiv.textContent = state.hint;
    wrapper.appendChild(iconDiv);
    wrapper.appendChild(titleDiv);
    wrapper.appendChild(hintDiv);

    // "No peers yet" — turn the hint into a one-click action so the user can
    // immediately copy and share the invite link instead of hunting for it.
    if (type === 'peers' && elements.inviteLink && elements.inviteLink.value) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'primary';
        copyBtn.style.cssText = 'display:inline-block; width:auto; margin-top:12px; padding:6px 14px; font-size:11px;';
        copyBtn.textContent = getMessage('BTN_COPY_INVITE');
        copyBtn.title = getMessage('BTN_COPY_INVITE_TOOLTIP');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(elements.inviteLink.value)
                .then(() => showToast(getMessage('TOAST_INVITE_COPIED'), 'success', 2000))
                .catch(() => showToast(getMessage('TOAST_COPY_FAILED'), 'error'));
        });
        wrapper.appendChild(copyBtn);
    }

    container.replaceChildren(wrapper);
}

function updatePeerList(peers) {
    if (!peers) return;
    activePeers = peers;
    if (peers.length === 0) {
        stopInterpolation();
    } else if (!interpolationInterval) {
        startInterpolation();
    }
    
    // UI Throttle: Only re-render if the peer state actually changed (excluding time interpolation)
    const stateToHash = peers.map(p => ({
        id: p.peerId,
        user: p.username,
        tab: p.tabTitle,
        media: p.mediaTitle,
        state: p.playbackState,
        vol: p.volume,
        muted: p.muted
    }));
    const currentPeersJson = JSON.stringify(stateToHash);
    if (currentPeersJson === lastPeersJson) return;
    lastPeersJson = currentPeersJson;

    const renderPeers = (container) => {
        container.innerHTML = '';
        if (peers.length === 0) {
            renderEmpty(container, 'peers');
            return;
        }

        peers.forEach(p => {
            const pId = typeof p === 'object' ? p.peerId : p;
            const pUsername = (typeof p === 'object' && p.username) ? p.username : '';
            const pTabTitle = (typeof p === 'object' && p.tabTitle) ? p.tabTitle : '';

            const peerItem = document.createElement('div');
            peerItem.className = 'peer-item';
            peerItem.style.cssText = 'position:relative; display:block; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);';

            const header = document.createElement('div');
            header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding-right: 24px;';

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'display: inline-flex; align-items: center; max-width: 200px; overflow: hidden; white-space: nowrap;';
            const avatar = getAvatarForName(pUsername || pId);
            if (pUsername) {
                const u = document.createElement('span');
                u.style.cssText = 'font-weight:600; color:white; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px; display: inline-block;';
                u.textContent = `${avatar} ${pUsername}`;
                const i = document.createElement('span');
                i.style.cssText = 'font-size:10px; opacity:0.6; font-style:italic; white-space: nowrap; flex-shrink: 0;';
                i.textContent = ` (${pId})`;
                nameSpan.appendChild(u);
                nameSpan.appendChild(i);
            } else {
                nameSpan.style.fontWeight = '600';
                nameSpan.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px;';
                nameSpan.textContent = `${avatar} ${pId}`;
            }

            header.appendChild(nameSpan);

            // Right-side badges + actions, kept in one group so they sit together
            // on the right instead of being scattered by the header's space-between.
            const rightGroup = document.createElement('div');
            rightGroup.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';

            // Volume Icon (Top Right)
            if (p.volume !== undefined && p.volume !== null) {
                const volIcon = document.createElement('div');
                volIcon.style.cssText = 'position:absolute; top:8px; right:0; cursor:help; font-size:14px;';
                volIcon.textContent = getVolumeIcon(p.volume, p.muted);
                volIcon.title = p.muted ? 'Muted' : `Volume: ${Math.round(p.volume * 100)}%`;
                peerItem.appendChild(volIcon);
            }

            if (pId === localPeerId) {
                const you = document.createElement('span');
                you.style.cssText = 'font-size:10px; color:var(--accent); font-weight:bold;';
                you.textContent = getMessage('LABEL_YOU') || 'YOU';
                rightGroup.appendChild(you);
            }

            // Host Control Mode: show "Solo" badge for peers watching on their own.
            if (typeof p === 'object' && p.desynced) {
                const solo = document.createElement('span');
                solo.style.cssText = 'font-size:10px; color:#fff; background:#b45309; padding:2px 6px; border-radius:6px; font-weight:600;';
                const soloText = getMessage('BADGE_DESYNCED') || 'Solo';
                solo.textContent = soloText;
                solo.title = getMessage('TOOLTIP_PEER_DESYNCED') || soloText;
                rightGroup.appendChild(solo);
            }

            // Co-Host: role badges + the owner's promote/demote control. Only meaningful
            // once the room is locked to host-only — in 'everyone' mode anyone can already
            // control, so roles are moot and we show nothing (no badge/button noise).
            // The promote/demote button additionally requires owner privileges (below).
            const showRoles = !!hcmOwnerPeerId && hcmRoomIsHostOnly;
            if (showRoles) {
                const isOwner = pId === hcmOwnerPeerId;
                const isController = !isOwner && hcmControllers.includes(pId);
                if (isOwner || isController) {
                    const roleBadge = document.createElement('span');
                    roleBadge.style.cssText = 'font-size:10px; color:#fff; background:var(--accent); padding:2px 6px; border-radius:6px; font-weight:600;';
                    roleBadge.textContent = isOwner ? (getMessage('BADGE_HOST') || 'Host') : (getMessage('BADGE_CONTROLLER') || 'Controller');
                    rightGroup.appendChild(roleBadge);
                }
                // Owner can promote/demote any non-owner peer.
                if (hcmAmOwner && hcmCoHostSupported && !isOwner) {
                    const btn = document.createElement('button');
                    const revoke = isController;
                    btn.style.cssText = `font-size:10px; padding:3px 9px; border-radius:6px; cursor:pointer; white-space:nowrap; font-weight:600; transition:background .15s,color .15s; border:1px solid ${revoke ? 'var(--text-muted)' : 'var(--accent)'}; background:transparent; color:${revoke ? 'var(--text-muted)' : 'var(--accent)'};`;
                    btn.textContent = revoke ? (getMessage('BTN_REVOKE_CONTROL') || 'Revoke') : (getMessage('BTN_GIVE_CONTROL') || 'Give control');
                    btn.title = revoke ? (getMessage('BTN_REVOKE_CONTROL') || 'Revoke') : (getMessage('BTN_GIVE_CONTROL') || 'Give control');
                    btn.addEventListener('mouseenter', () => {
                        btn.style.background = revoke ? 'var(--text-muted)' : 'var(--accent)';
                        btn.style.color = '#fff';
                    });
                    btn.addEventListener('mouseleave', () => {
                        btn.style.background = 'transparent';
                        btn.style.color = revoke ? 'var(--text-muted)' : 'var(--accent)';
                    });
                    btn.addEventListener('click', () => {
                        chrome.runtime.sendMessage({ type: 'SET_PEER_ROLE', peerId: pId, controller: !isController }, () => {});
                    });
                    rightGroup.appendChild(btn);
                }
            }

            if (rightGroup.childNodes.length) header.appendChild(rightGroup);

            peerItem.appendChild(header);

            // Media Info
            if (p.mediaTitle) {
                const mediaDiv = document.createElement('div');
                mediaDiv.style.cssText = 'font-size:11px; color:var(--star); font-weight: 600; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px;';
                mediaDiv.textContent = `🎬 ${p.mediaTitle}`;
                peerItem.appendChild(mediaDiv);
            }

            // Status Line (Play/Pause + Time)
            const statusLine = document.createElement('div');
            statusLine.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:4px;';

            if (p.playbackState) {
                const stateIcon = document.createElement('span');
                stateIcon.style.fontSize = '10px';
                if (p.playbackState === 'playing') {
                    stateIcon.textContent = '▶';
                    stateIcon.style.color = 'var(--success)';
                } else {
                    stateIcon.textContent = '⏸';
                    stateIcon.style.color = 'var(--error)';
                }
                statusLine.appendChild(stateIcon);
            }

            if (p.currentTime !== undefined && p.currentTime !== null) {
                const timeSpan = document.createElement('span');
                timeSpan.className = 'peer-time-display';
                timeSpan.dataset.peerId = pId;
                timeSpan.style.cssText = 'font-size:11px; font-family:monospace; color:var(--text-muted);';
                
                let displayTime = p.currentTime;
                if (p.playbackState === 'playing' && p.lastHeartbeat && p.currentTime != null) {
                    const elapsed = (Date.now() - p.lastHeartbeat) / 1000;
                    if (elapsed < 45) {
                        displayTime += elapsed;
                    }
                }
                timeSpan.textContent = formatTime(displayTime);
                statusLine.appendChild(timeSpan);
            }

            if (pTabTitle) {
                const titleDiv = document.createElement('span');
                titleDiv.style.cssText = 'font-size:10px; color:var(--text-muted); opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: right;';
                titleDiv.textContent = pTabTitle;
                statusLine.appendChild(titleDiv);
            }

            peerItem.appendChild(statusLine);
            container.appendChild(peerItem);
        });
    };

    if (elements.peerList) renderPeers(elements.peerList);
    if (elements.peerListSync) renderPeers(elements.peerListSync);

    // Re-populate tabs to update Star Matching when peers change
    populateTabs(peers);
}

function detectPeerChanges(newPeers) {
    const oldIds = new Set(lastKnownPeers.map(p => p.peerId || p));
    const newIds = new Set(newPeers.map(p => p.peerId || p));

    for (const peer of newPeers) {
        const id = peer.peerId || peer;
        if (!oldIds.has(id)) {
            const name = peer.username || id.substring(0, 4);
            showToast(getMessage('TOAST_PEER_JOINED', { name }), 'success');
        }
    }

    for (const oldPeer of lastKnownPeers) {
        const id = oldPeer.peerId || oldPeer;
        if (!newIds.has(id)) {
            const name = oldPeer.username || id.substring(0, 4);
            showToast(getMessage('TOAST_PEER_LEFT', { name }), 'info');
        }
    }

    lastKnownPeers = newPeers;
}

async function populateTabs(providedPeers = null, providedTargetTabId = null) {
    const token = {};
    populateTabsToken = token;

    const data = await chrome.storage.local.get(['filterNoise']);
    const isFilterActive = data.filterNoise !== false;
    
    let currentTargetTabId = providedTargetTabId;
    if (currentTargetTabId === null) {
        const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r));
        if (chrome.runtime.lastError) {
            if (populateTabsToken !== token) return;
            currentTargetTabId = null;
        } else {
            currentTargetTabId = status?.targetTabId;
        }
    }
 
    let peerIds = providedPeers;
    if (!peerIds) {
        const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r));
        if (chrome.runtime.lastError) {
            if (populateTabsToken !== token) return;
            peerIds = [];
        } else {
            peerIds = status?.peers || [];
        }
    }

    let tabs = [];
    try {
        tabs = await chrome.tabs.query({});
    } catch (e) {
        console.warn('[Popup] tabs.query failed:', e.message);
        if (populateTabsToken !== token) return;
    }
    
    if (!elements.targetTab) return;
    if (populateTabsToken !== token) return;
    while (elements.targetTab.options.length > 1) {
        elements.targetTab.remove(1);
    }

    const filteredTabs = tabs.filter(tab => {
        if (!tab.url || tab.url.startsWith('chrome://')) return false;
        if (isFilterActive && tab.id !== parseInt(currentTargetTabId)) {
            const urlStr = tab.url.toLowerCase();
            if (BLACKLIST_DOMAINS.some(d => {
                const domain = d.toLowerCase();
                try {
                    const hostname = new URL(tab.url).hostname.toLowerCase();
                    if (domain.endsWith('.')) return hostname.startsWith(domain) || hostname.includes('.' + domain);
                    if (domain.includes('.')) return hostname === domain || hostname.endsWith('.' + domain);
                } catch {
                    /* ignore invalid URLs */
                }
                return urlStr.includes(domain);
            })) return false;
        }
        return true;
    });

    // Smart Matching Logic — exclude own tabTitle to prevent self-match (computed once)
    const cleanTitle = (rawTitle) => {
        if (!rawTitle) return '';
        return (normalizeTabTitle(rawTitle) || '')
            .replace(/(?:\s*[-\|•]\s*(?:YouTube|Twitch|Jellyfin|Emby|Netflix|Vimeo|Dailymotion).*)$/i, '')
            .replace(/^(?:Netflix|Twitch|YouTube|Emby|Jellyfin)\s*[-\|•]\s*/i, '')
            .trim();
    };

    const peerTitles = peerIds
        .filter(p => (typeof p === 'object' ? p.peerId : p) !== localPeerId)
        .map(p => (typeof p === 'object' ? p.tabTitle : null))
        .filter(t => t && t.length > 3)
        .map(t => cleanTitle(t).toLowerCase())
        .filter(t => t.length > 3);

    filteredTabs.forEach(tab => {
        const option = document.createElement('option');
        option.value = tab.id;
        const rawTitle = (tab.title || 'Loading...');
        const title = cleanTitle(rawTitle).toLowerCase();
        
        const isMatch = title.length > 3 && peerTitles.some(pt => {
            return title.includes(pt) || pt.includes(title);
        });

        let label = rawTitle.substring(0, 45) + (rawTitle.length > 45 ? '...' : '');
        if (isMatch) {
            label = `⭐ MATCH: ${label}`;
            option.style.fontWeight = 'bold';
            option.style.color = 'var(--star)';
        }
        
        if (tab.audible) {
            label = `[🎬] ${label}`;
        }
        
        option.textContent = label;
        option.dataset.originalTitle = tab.title;
        elements.targetTab.appendChild(option);
    });

    // Sort: 1. Current tab first, 2. Matches, 3. Rest alphabetically
    const options = Array.from(elements.targetTab.options);
    const placeholder = options.shift();
    const currentTabId = providedTargetTabId ? parseInt(providedTargetTabId) : null;

    options.sort((a, b) => {
        const aId = parseInt(a.value);
        const bId = parseInt(b.value);

        if (aId === currentTabId) return -1;
        if (bId === currentTabId) return 1;

        const aMatch = a.textContent.includes('⭐');
        const bMatch = b.textContent.includes('⭐');
        if (aMatch && !bMatch) return -1;
        if (!aMatch && bMatch) return 1;

        return a.textContent.localeCompare(b.textContent);
    });
    elements.targetTab.innerHTML = '';
    elements.targetTab.appendChild(placeholder);
    options.forEach(opt => elements.targetTab.appendChild(opt));

    if (currentTargetTabId) {
        elements.targetTab.value = currentTargetTabId;
    } else {
        const matchOpt = options.find(o => o.textContent.includes('⭐ MATCH:'));
        if (matchOpt && elements.targetTab.options.length > 1) {
            elements.targetTab.value = matchOpt.value;
            const tabTitle = matchOpt.dataset.originalTitle || null;
            chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId: parseInt(matchOpt.value), tabTitle });
        }
    }
}

function applyConnectionStatus(status) {
    // Coerce 'idle' to 'disconnected' if a room is actively configured.
    // An 'idle' status with a configured room indicates the background
    // worker dropped connection intent due to a server error.
    if (status === 'idle' && elements.sectionActive && elements.sectionActive.style.display !== 'none') {
        status = 'disconnected';
    }

    const connected = status === 'connected';
    const connecting = status === 'connecting';
    const reconnecting = status === 'reconnecting';
    // 'idle' = not in a room and not trying to connect. This is the normal
    // resting state (lazy connect), NOT an error — surface it neutrally.
    const idle = status === 'idle';

    if (elements.connDot) {
        elements.connDot.className = 'status-dot ' + (connected ? 'status-online' : ((connecting || reconnecting) ? 'status-online' : 'status-offline'));

        if (reconnecting) {
            elements.connDot.style.background = '#f59e0b';
            elements.connDot.style.boxShadow = '0 0 8px #f59e0b';
        } else if (connecting) {
            elements.connDot.style.background = '#fbbf24';
            elements.connDot.style.boxShadow = '0 0 8px #fbbf24';
        } else if (idle) {
            // Neutral grey — ready, not failed.
            elements.connDot.style.background = '#9ca3af';
            elements.connDot.style.boxShadow = 'none';
        } else if (!connected) {
            elements.connDot.style.background = '#ef4444';
            elements.connDot.style.boxShadow = 'none';
        } else {
            elements.connDot.style.background = '';
            elements.connDot.style.boxShadow = '';
        }
    }

    if (elements.connText) {
        elements.connText.textContent = connected ? getMessage('STATUS_CONNECTED') : (reconnecting ? getMessage('STATUS_RECONNECTING') : (connecting ? getMessage('STATUS_CONNECTING') : (idle ? getMessage('STATUS_IDLE') : getMessage('STATUS_DISCONNECTED'))));
    }

    // Show the info "i" + tooltip only in the idle state.
    if (elements.connInfo) {
        elements.connInfo.style.display = idle ? '' : 'none';
    }
    if (!connected) {
        updatePingDisplay(null);
    }
    if (elements.retryBtn) {
        elements.retryBtn.style.display = reconnecting && reconnectSlowMode ? 'block' : 'none';
    }

    if (elements.joinBtn) {
        if (connecting || reconnecting) {
            elements.joinBtn.disabled = !reconnectSlowMode;
            elements.joinBtn.textContent = connecting ? getMessage('BTN_STATE_JOINING') : getMessage('BTN_STATE_RECONNECTING');
        } else {
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
        }
    }

    if (elements.playBtn) elements.playBtn.textContent = getMessage('BTN_PLAY');
    if (elements.pauseBtn) elements.pauseBtn.textContent = getMessage('BTN_PAUSE');
    if (elements.forceSyncBtn) elements.forceSyncBtn.textContent = getMessage('BTN_SYNC');
}

function updatePingDisplay(pingMs) {
    if (!elements.connPing) return;
    if (pingMs === null || pingMs === undefined || typeof pingMs !== 'number' || !Number.isFinite(pingMs)) {
        elements.connPing.textContent = '';
        elements.connPing.style.color = '';
        return;
    }
    elements.connPing.textContent = `${Math.round(pingMs)}ms`;
    if (pingMs < 50) {
        elements.connPing.style.color = '#22c55e';
    } else if (pingMs < 150) {
        elements.connPing.style.color = '#f59e0b';
    } else {
        elements.connPing.style.color = '#ef4444';
    }
}

function updateHistory(history) {
    if (!history || !elements.historyList) return;
    elements.historyList.innerHTML = '';

    if (history.length === 0) {
        renderEmpty(elements.historyList, 'history');
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
            senderSpan.textContent = getMessage('LABEL_YOU') || 'You';
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
        renderEmpty(elements.publicRooms, 'rooms');
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
            lock.title = getMessage('LABEL_PASSWORD_PROTECTED');
            lock.textContent = '🔒';
            leftSide.appendChild(lock);
        }

        const peerCount = document.createElement('span');
        peerCount.style.cssText = 'font-size:11px; color:var(--accent)';
        peerCount.textContent = getMessage('LABEL_PEERS_COUNT', { count: parseInt(r.peerCount) });

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
        if (tab && tab.url && tab.url.startsWith(OFFICIAL_LANDING_PAGE_URL + '/') && tab.url.includes('#join:')) {
            try {
                const rawHash = tab.url.split('#join:')[1];
                if (!rawHash) return;
                const parts = rawHash.split(':');
                if (parts.length >= 2) {
                    const roomId = parts.shift();
                    let useCustomServer = false;
                    let serverUrl = '';

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
                        chrome.storage.local.set({ serverUrl, useCustomServer });
                    }

                    elements.joinBtn.style.boxShadow = '0 0 15px var(--accent)';
                    setTimeout(() => elements.joinBtn.style.boxShadow = '', 2000);
                }
            } catch (_e) {
                // Malformed invite link, ignore
            }
        }
    });
}

function setServerMode(custom) {
    elements.serverOfficial.classList.toggle('active', !custom);
    elements.serverCustom.classList.toggle('active', custom);
    elements.serverUrl.style.display = custom ? 'block' : 'none';
    chrome.storage.local.get(['useCustomServer', 'serverUrl'], (data) => {
        if (data.useCustomServer !== custom) {
            chrome.storage.local.set({ useCustomServer: custom });
            if (!custom || data.serverUrl) {
                chrome.runtime.sendMessage({ type: 'RETRY_CONNECT' });
            }
        }
    });
}

elements.serverOfficial.addEventListener('click', () => setServerMode(false));
elements.serverCustom.addEventListener('click', () => setServerMode(true));

elements.filterNoise.addEventListener('change', () => {
    chrome.storage.local.set({ filterNoise: elements.filterNoise.checked }, () => {
        populateTabs();
    });
});

elements.autoSyncNextEpisode.addEventListener('change', () => {
    chrome.storage.local.set({ autoSyncNextEpisode: elements.autoSyncNextEpisode.checked });
});

if (elements.sendTabTitle) {
    elements.sendTabTitle.addEventListener('change', () => {
        chrome.storage.local.set({ sendTabTitle: elements.sendTabTitle.checked }, () => {
            chrome.runtime.sendMessage({ type: 'TITLE_PRIVACY_CHANGED' }).catch(() => {});
        });
    });
}

if (elements.mediaTitlePrivacyMode) {
    elements.mediaTitlePrivacyMode.addEventListener('change', () => {
        chrome.storage.local.set({ mediaTitlePrivacyMode: elements.mediaTitlePrivacyMode.value }, () => {
            chrome.runtime.sendMessage({ type: 'TITLE_PRIVACY_CHANGED' }).catch(() => {});
        });
    });
}

elements.browserNotifications.addEventListener('change', () => {
    chrome.storage.local.set({ browserNotifications: elements.browserNotifications.checked });
});

if (elements.autoCopyInvite) {
    elements.autoCopyInvite.addEventListener('change', () => {
        chrome.storage.local.set({ autoCopyInvite: elements.autoCopyInvite.checked });
    });
}

if (elements.audioSettingsLink) {
    elements.audioSettingsLink.addEventListener('click', async (event) => {
        event.preventDefault();
        await dismissFeatureHint('audio_processing');
        openAudioSettingsPage();
    });
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.audioSettings) return;
});

elements.forceSyncMode.addEventListener('change', () => {
    chrome.storage.local.set({ forceSyncMode: elements.forceSyncMode.value });
});

elements.serverUrl.addEventListener('input', () => {
    chrome.storage.local.set({ serverUrl: elements.serverUrl.value });
});

elements.username.addEventListener('input', syncDevToolsVisibility);
elements.username.addEventListener('change', () => {
    chrome.storage.local.set({ username: elements.username.value });
    syncDevToolsVisibility();
});

if (elements.langSelector) {
    elements.langSelector.addEventListener('change', async () => {
        const selectedLang = elements.langSelector.value;
        await chrome.storage.local.set({ locale: selectedLang });
        await loadLocale(selectedLang);
        translateDOM();
        configureFooterLinks();
        await updateFeatureHints();
        
        // Re-apply connection and room UI state since translateDOM may overwrite dynamic elements
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, async (res) => {
            if (chrome.runtime.lastError) return;
            if (res) {
                localPeerId = res.peerId;
                reconnectSlowMode = res.reconnectSlowMode || false;
                applyConnectionStatus(res.status);
                updatePeerList(res.peers);
                lastKnownPeers = res.peers || [];
                if (res.lastActionState) updateLastActionUI(res.lastActionState, res.peers);
                
                const data = await chrome.storage.local.get(['roomId', 'password', 'useCustomServer', 'serverUrl']);
                updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
                
                await populateTabs(res.peers, res.targetTabId);
                if (res.episodeLobby) updateLobbyUI(res.episodeLobby, res.peers);
            } else {
                applyConnectionStatus('disconnected');
                const data = await chrome.storage.local.get(['roomId', 'password', 'useCustomServer', 'serverUrl']);
                updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
                await populateTabs();
            }
        });

        refreshLogs();
        refreshHistory();
    });
}

elements.serverUrl.addEventListener('change', () => {
    let url = elements.serverUrl.value.trim();
    if (url && !url.includes('://')) {
        // Default to secure wss:// — plain ws:// is only valid for a local relay
        // (and the background rejects/upgrades ws:// for any remote host anyway).
        const host = url.split('/')[0].split(':')[0].toLowerCase();
        const isLocal = host === 'localhost' || host === '127.0.0.1';
        url = (isLocal ? 'ws://' : 'wss://') + url;
        elements.serverUrl.value = url;
        chrome.storage.local.set({ serverUrl: url });
    }
    if (elements.serverCustom.classList.contains('active') && url) {
        chrome.runtime.sendMessage({ type: 'RETRY_CONNECT' });
    }
});

elements.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
        elements.tabs.forEach(b => b.classList.remove('active'));
        elements.contents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        
        const targetContent = document.getElementById(btn.dataset.tab);
        targetContent.classList.add('active');
        
        targetContent.classList.remove('tab-active-animate');
        void targetContent.offsetWidth; // Force reflow to restart animation
        targetContent.classList.add('tab-active-animate');
        
        isDevTabVisible = btn.dataset.tab === 'tab-dev';
        if (isDevTabVisible) refreshLogs();
        if (btn.dataset.tab === 'tab-sync') refreshHistory();
        
        chrome.storage.local.set({ activeTab: btn.dataset.tab });
    });
});

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message || '';
    toast.style.whiteSpace = 'pre-wrap';

    const delay = Math.max(0, duration - 600);
    toast.style.animation = `toastSlideIn 0.3s ease-out, toastFadeOut 0.3s ease-in ${delay}ms forwards`;

    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

function showError(msg) {
    if (!elements.roomError) return;
    const currentToken = ++errorToken;
    elements.roomError.textContent = msg;
    elements.roomError.style.display = 'block';
    elements.roomId.style.borderColor = 'var(--error)';
    elements.password.style.borderColor = 'var(--error)';
    
    showToast(msg, 'error', 5000);

    setTimeout(() => {
        if (currentToken !== errorToken) return;
        if (elements.roomError) elements.roomError.style.display = 'none';
        elements.roomId.style.borderColor = '';
        elements.password.style.borderColor = '';
    }, 5000);
}

// --- Action Handlers ---
elements.roomId.addEventListener('input', () => {
    elements.roomId.value = elements.roomId.value.replace(/[^a-zA-Z0-9\-]/g, '');
});

elements.joinBtn.addEventListener('click', async () => {
    if (isProcessingConnection) return;
    isProcessingConnection = true;
    clearConnectionErrorTimer();
    if (elements.joinBtn.disabled) {
        isProcessingConnection = false;
        return;
    }
    const roomIdInput = elements.roomId.value.trim();
    const isCreating = !roomIdInput;
    
    elements.joinBtn.disabled = true;
    elements.joinBtn.textContent = isCreating ? getMessage('BTN_STATE_CREATING') : getMessage('BTN_STATE_JOINING');
    
    if (joinBtnTimeout) clearTimeout(joinBtnTimeout);
    joinBtnTimeout = setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
            if (res && res.status === 'connecting') {
                joinBtnTimeout = setTimeout(() => {
                    elements.joinBtn.disabled = false;
                    elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
                    joinBtnTimeout = null;
                    isProcessingConnection = false;
                    showError(getMessage('ERR_CONN_TIMEOUT'));
                }, 15000);
                return;
            }
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
            joinBtnTimeout = null;
            isProcessingConnection = false;
            if (res && res.status !== 'connected') showError(getMessage('ERR_CONN_TIMEOUT'));
        });
    }, 15000);
    
    const serverUrl = elements.serverUrl.value.trim();
    const useCustom = elements.serverCustom.classList.contains('active');

    // Proactive URL Validation
    if (useCustom && !serverUrl) {
        showError(getMessage('ERR_INVALID_SERVER_URL'));
        elements.joinBtn.disabled = false;
        elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
        if (joinBtnTimeout) { clearTimeout(joinBtnTimeout); joinBtnTimeout = null; }
        isProcessingConnection = false;
        return;
    }
    if (useCustom && serverUrl) {
        try {
            const urlToCheck = serverUrl.includes('://') ? serverUrl : 'wss://' + serverUrl;
            new URL(urlToCheck);
        } catch (_e) {
            showError(getMessage('ERR_INVALID_SERVER_URL'));
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
            if (joinBtnTimeout) { clearTimeout(joinBtnTimeout); joinBtnTimeout = null; }
            isProcessingConnection = false;
            return;
        }
    }

    const roomId = roomIdInput || generateRoomId();
    let password = elements.password.value;
    if (isCreating && !password) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const array = new Uint8Array(6);
        self.crypto.getRandomValues(array);
        password = Array.from(array, byte => chars[byte % chars.length]).join('');
        elements.password.value = password;
        window.justCreatedRoom = true;
    }

    await chrome.storage.local.set({ serverUrl, roomId, password, useCustomServer: useCustom });
    elements.roomId.value = roomId;

    // Tell background to connect
    chrome.runtime.sendMessage({ type: 'CONNECT' });
    
    // UI Feedback: Immediately switch state for better responsiveness
    updateUI(roomId, password, useCustom, serverUrl);
});

elements.leaveBtn.addEventListener('click', async () => {
    if (isProcessingConnection) return;
    isProcessingConnection = true;
    clearConnectionErrorTimer();
    chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
    await chrome.storage.local.set({ roomId: '', password: '' });
    elements.roomId.value = '';
    elements.password.value = '';
    lastKnownPeers = [];
    updateUI(null, null);
    isProcessingConnection = false;
});

function generateRoomId() {
    const adj = USERNAME_ADJECTIVES[Math.floor(Math.random() * USERNAME_ADJECTIVES.length)];
    const noun = USERNAME_NOUNS[Math.floor(Math.random() * USERNAME_NOUNS.length)];
    const num = Math.floor(Math.random() * 99) + 1;
    return `${adj.toUpperCase()}-${noun.toUpperCase()}-${num}`;
}

function handleCreateRoom() {
    const secureGenerateId = (length = 6) => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const array = new Uint8Array(length);
        self.crypto.getRandomValues(array);
        return Array.from(array, byte => chars[byte % chars.length]).join('');
    };
    const roomId = generateRoomId();
    const password = secureGenerateId();
    elements.roomId.value = roomId;
    elements.password.value = password;
    window.justCreatedRoom = true;
    
    // Auto-connect
    elements.joinBtn.click();
}

elements.createRoomBtn.addEventListener('click', handleCreateRoom);
const syncTabCreateRoomBtn = document.getElementById('syncTabCreateRoomBtn');
if (syncTabCreateRoomBtn) syncTabCreateRoomBtn.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="tab-room"]').click();
    handleCreateRoom();
});

elements.refreshRooms.addEventListener('click', () => {
    if (elements.refreshRooms.disabled) return;
    setRoomRefreshCooldown();

    elements.publicRooms.replaceChildren();
    const el = document.createElement('div');
    el.style.cssText = 'text-align:center; color: var(--text-muted); font-size: 11px; padding: 10px;';
    el.textContent = getMessage('PUBLIC_ROOMS_REFRESHING_COOLDOWN', { seconds: Math.ceil(ROOM_LIST_REFRESH_COOLDOWN_MS / 1000) });
    elements.publicRooms.appendChild(el);
    chrome.runtime.sendMessage({ type: 'GET_ROOM_LIST' });
});

elements.retryBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RETRY_CONNECT' });
});

elements.targetTab.addEventListener('change', () => {
    const hint = document.getElementById('targetTabHint');
    if (hint) hint.style.display = 'none';

    const val = elements.targetTab.value;
    const tabId = val ? parseInt(val) : null;
    const tabTitle = elements.targetTab.options[elements.targetTab.selectedIndex]?.dataset.originalTitle || null;
    chrome.runtime.sendMessage({ type: 'SET_TARGET_TAB', tabId, tabTitle });
});

elements.forceSyncBtn.addEventListener('click', async () => {
    if (hcmGuestLocked) return; // guest in host-only room — backstop (M-2/L-3)
    if (elements.forceSyncBtn.disabled) return;
    
    const originalText = elements.forceSyncBtn.textContent;
    elements.forceSyncBtn.disabled = true;

    const status = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, r));
    if (chrome.runtime.lastError || !status || !status.targetTabId) {
        elements.forceSyncBtn.disabled = false;
        return;
    }

    const mode = elements.forceSyncMode.value;
    let targetTime = null;

    if (mode === 'jump-to-others') {
        if (!localPeerId) {
            showError(getMessage('ERR_IDENTITY_NOT_LOADED'));
            elements.forceSyncBtn.disabled = false;
            return;
        }
        const peers = status.peers || [];
        const otherTimes = peers
            .filter(p => typeof p === 'object' && p.peerId !== localPeerId && p.currentTime != null && p.currentTime !== '')
            .map(p => Number(p.currentTime))
            .filter(Number.isFinite);

        if (otherTimes.length === 0) {
            showError(getMessage('ERR_NO_PEERS_TIME'));
            elements.forceSyncBtn.disabled = false;
            return;
        }

        otherTimes.sort((a, b) => a - b);
        const mid = Math.floor(otherTimes.length / 2);
        targetTime = otherTimes.length % 2 !== 0 ? otherTimes[mid] : (otherTimes[mid - 1] + otherTimes[mid]) / 2;
    }

    elements.forceSyncBtn.textContent = mode === 'jump-to-others' ? getMessage('BTN_STATE_SYNCING_GROUP', { time: formatTime(targetTime) }) : getMessage('BTN_STATE_SYNCING');
    forceSyncDone = false;
    const peerCount = (status.peers || []).filter(p => (typeof p === 'object' ? p.peerId : p) !== localPeerId).length;
    const syncTimeoutMs = peerCount === 0 ? 3000 : 12000;
    const forceSyncReset = () => {
        // Don't unlock a button that's locked because we became a guest mid-flight —
        // hcmGuestLocked is the source of truth for the lock state, and the next
        // CONTROL_MODE update restores the correct label.
        if (!forceSyncDone && !hcmGuestLocked) {
            elements.forceSyncBtn.disabled = false;
            elements.forceSyncBtn.textContent = originalText;
        }
    };
    forceSyncResetTimer = setTimeout(forceSyncReset, syncTimeoutMs);
    const tabId = parseInt(status.targetTabId);

    const failForceSyncTime = () => {
        if (forceSyncResetTimer) { clearTimeout(forceSyncResetTimer); forceSyncResetTimer = null; }
        showError(getMessage('ERR_NO_VIDEO_TAB'));
        forceSyncDone = true;
        elements.forceSyncBtn.disabled = false;
        elements.forceSyncBtn.textContent = originalText;
    };

    const sendForceSync = (time) => {
        if (time === null || time === undefined) {
            failForceSyncTime();
            return;
        }
        const target = Number(time);
        if (!Number.isFinite(target)) {
            failForceSyncTime();
            return;
        }
        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action: EVENTS.FORCE_SYNC_PREPARE,
            payload: { targetTime: target }
        });
    };

    if (mode === 'jump-to-me') {
        const retryQueryTime = () => {
            chrome.tabs.sendMessage(tabId, { action: 'get_current_time' }, (retryResponse) => {
                if (chrome.runtime.lastError || !retryResponse || !Number.isFinite(retryResponse.currentTime)) {
                    failForceSyncTime();
                    return;
                }
                sendForceSync(retryResponse.currentTime);
            });
        };
        chrome.tabs.sendMessage(tabId, { action: 'get_current_time' }, (response) => {
            if (Number.isFinite(response?.currentTime)) {
                sendForceSync(response.currentTime);
                return;
            }
            if (chrome.runtime.lastError || !response) {
                chrome.runtime.sendMessage({ type: 'INJECT_CONTENT_SCRIPT', tabId }, (injectResponse) => {
                    if (chrome.runtime.lastError || !injectResponse || injectResponse.status !== 'ok') {
                        failForceSyncTime();
                        return;
                    }
                    setTimeout(retryQueryTime, 500);
                });
                return;
            }
            setTimeout(retryQueryTime, 500);
        });
    } else {
        sendForceSync(targetTime);
    }
});

elements.playBtn.addEventListener('click', () => {
    if (hcmGuestLocked) return; // guest in host-only room — backstop
    if (!elements.targetTab.value) {
        showToast(getMessage('ERR_SELECT_VIDEO'), 'warning');
        return;
    }
    elements.playBtn.textContent = getMessage('BTN_STATE_PLAYING');
    elements.playBtn.disabled = true;
    chrome.runtime.sendMessage({
        type: 'CONTENT_EVENT',
        action: EVENTS.PLAY,
        payload: {}
    }, (response) => {
        if (response && response.status === 'ok_solo') {
            elements.playBtn.textContent = getMessage('BTN_PLAY');
            elements.playBtn.disabled = false;
        }
    });
    // Safety reset: restore button after 2.5s in case no peers respond
    setTimeout(() => {
        if (elements.playBtn.disabled && !hcmGuestLocked) {
            elements.playBtn.textContent = getMessage('BTN_PLAY');
            elements.playBtn.disabled = false;
        }
    }, 2500);
});

elements.pauseBtn.addEventListener('click', () => {
    if (hcmGuestLocked) return; // guest in host-only room — backstop
    if (!elements.targetTab.value) {
        showToast(getMessage('ERR_SELECT_VIDEO'), 'warning');
        return;
    }
    elements.pauseBtn.textContent = getMessage('BTN_STATE_PAUSING');
    elements.pauseBtn.disabled = true;
    chrome.runtime.sendMessage({
        type: 'CONTENT_EVENT',
        action: EVENTS.PAUSE,
        payload: {}
    }, (response) => {
        if (response && response.status === 'ok_solo') {
            elements.pauseBtn.textContent = getMessage('BTN_PAUSE');
            elements.pauseBtn.disabled = false;
        }
    });
    // Safety reset: restore button after 2.5s in case no peers respond
    setTimeout(() => {
        if (elements.pauseBtn.disabled && !hcmGuestLocked) {
            elements.pauseBtn.textContent = getMessage('BTN_PAUSE');
            elements.pauseBtn.disabled = false;
        }
    }, 2500);
});

function simulateRemoteSeek({ delta = null, targetTime = null }) {
    chrome.runtime.sendMessage({ type: 'DEV_SIMULATE_REMOTE_SEEK', delta, targetTime }, (res) => {
        if (chrome.runtime.lastError || !res || res.status !== 'ok') {
            showToast(res?.message || 'Remote seek failed', 'error');
            return;
        }
        showToast(`Remote seek -> ${formatTime(res.targetTime)}`, 'success', 1200);
        refreshDebugInfo();
    });
}

if (elements.remoteSeekBack) {
    elements.remoteSeekBack.addEventListener('click', () => simulateRemoteSeek({ delta: -30 }));
}
if (elements.remoteSeekForward) {
    elements.remoteSeekForward.addEventListener('click', () => simulateRemoteSeek({ delta: 30 }));
}
if (elements.remoteSeekFiveMin) {
    elements.remoteSeekFiveMin.addEventListener('click', () => simulateRemoteSeek({ targetTime: 300 }));
}

elements.clearLogs.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
        elements.logList.innerHTML = '';
    });
});

if (elements.regenId) {
    elements.regenId.addEventListener('click', () => {
        elements.regenId.disabled = true;
        chrome.runtime.sendMessage({ type: 'REGENERATE_ID' }, (res) => {
            elements.regenId.disabled = false;
            if (chrome.runtime.lastError || !res || !res.peerId) {
                showToast(getMessage('TOAST_ID_REGENERATED') || 'Failed to regenerate identity', 'error');
                return;
            }
            showToast(getMessage('TOAST_ID_REGENERATED') || 'Identity regenerated — reconnecting…', 'success', 3000);
        });
    });
}

elements.copyInvite.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.inviteLink.value).then(() => {
        const original = elements.copyInvite.textContent;
        elements.copyInvite.textContent = '✓';
        elements.copyInvite.style.background = 'var(--success)';
        elements.copyInvite.style.color = 'white';
        showToast(getMessage('TOAST_INVITE_COPIED'), 'success', 2000);
        setTimeout(() => {
            elements.copyInvite.textContent = original;
            elements.copyInvite.style.background = '';
            elements.copyInvite.style.color = '';
        }, 2000);
    }).catch(() => {
        showToast(getMessage('TOAST_COPY_FAILED'), 'error');
    });
});

if (elements.syncTabCopyInvite) {
    elements.syncTabCopyInvite.addEventListener('click', () => {
        navigator.clipboard.writeText(elements.inviteLink.value).then(() => {
            const original = elements.syncTabCopyInvite.textContent;
            elements.syncTabCopyInvite.textContent = '✓';
            elements.syncTabCopyInvite.style.color = 'var(--success)';
            showToast(getMessage('TOAST_INVITE_COPIED'), 'success', 2000);
            setTimeout(() => {
                elements.syncTabCopyInvite.textContent = original;
                elements.syncTabCopyInvite.style.color = '';
            }, 2000);
        });
    });
}

if (elements.cancelLobbyBtn) {
    elements.cancelLobbyBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CANCEL_EPISODE_LOBBY' }, (response) => {
            if (response && response.status === 'ok') {
                showToast(getMessage('TOAST_LOBBY_SKIPPED'), 'info');
                if (elements.episodeLobbyCard) {
                    elements.episodeLobbyCard.style.display = 'none';
                }
            } else {
                showToast(getMessage('TOAST_LOBBY_SKIP_FAILED'), 'error');
            }
        });
    });
}

// --- Logs & Status ---
async function refreshLogs() {
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (logs) => {
        if (elements.logList) {
            if (!logs || logs.length === 0) {
                renderEmpty(elements.logList, 'logs');
                return;
            }
            elements.logList.innerHTML = '';
            logs.forEach(log => {
                const entry = document.createElement('div');
                entry.className = `log-entry log-${log.type}`;
                const timeStr = log.timestamp?.split('T')?.[1]?.split('.')[0] || '?';
                entry.textContent = `[${timeStr}] ${log.message}`;
                elements.logList.appendChild(entry);
            });
        }
    });
}

chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'LOG_UPDATE') {
        refreshLogs();
        if (msg.log && msg.log.type === 'error') {
            const errMsg = msg.log.message || '';
            const isConnErr = typeof errMsg === 'string' && (
                errMsg.toLowerCase().includes('connection') ||
                errMsg.toLowerCase().includes('websocket')
            );
            if (isConnErr) {
                pendingConnectionErrorMsg = msg.log.message;
                if (!connectionErrorTimer) {
                    connectionErrorTimer = setTimeout(() => {
                        if (pendingConnectionErrorMsg) {
                            showError(pendingConnectionErrorMsg);
                        }
                        connectionErrorTimer = null;
                        pendingConnectionErrorMsg = null;
                    }, 5000);
                }
            } else {
                showError(msg.log.message);
            }
        }
    } else if (msg.type === 'ACTION_UPDATE') {
        const state = msg.state;
        if (state && state.senderId && state.senderId !== 'You') {
            const actionNames = {
                'play': getMessage('NOTIF_PLAY'),
                'pause': getMessage('NOTIF_PAUSE'),
                'seek': getMessage('NOTIF_SEEK'),
                'force_sync_prepare': getMessage('NOTIF_FORCE_PREPARE'),
                'force_sync_execute': getMessage('NOTIF_FORCE_EXECUTE')
            };
            const action = actionNames[state.action] || state.action;
            let displayName = state.senderId;
            const peer = lastKnownPeers.find(p => (p.peerId || p) === state.senderId);
            if (peer && peer.username) displayName = peer.username;
            showToast(getMessage('TOAST_PEER_ACTION', { name: displayName, action }), 'info', 2000);
        }

        if (state && (state.action === 'play' || state.action === 'pause')) {
            const btn = state.action === 'play' ? elements.playBtn : elements.pauseBtn;
            if (btn && btn.disabled) {
                chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
                    const peerCount = res && res.peers ? res.peers.length : 1;
                    if (state.acks && state.acks.length >= peerCount) {
                        btn.textContent = getMessage('BTN_STATE_SYNCED');
                        setTimeout(() => {
                            btn.disabled = false;
                            btn.textContent = state.action === 'play' ? getMessage('BTN_PLAY') : getMessage('BTN_PAUSE');
                        }, 2000);
                    }
                });
            }
        }

        if (state && state.action === 'force_sync_execute') {
            forceSyncDone = true;
            if (forceSyncResetTimer) {
                clearTimeout(forceSyncResetTimer);
                forceSyncResetTimer = null;
            }
            if (elements.forceSyncBtn) {
                elements.forceSyncBtn.disabled = false;
                elements.forceSyncBtn.textContent = getMessage('BTN_STATE_SYNCED');
                setTimeout(() => {
                    elements.forceSyncBtn.textContent = getMessage('BTN_SYNC');
                }, 2000);
            }
        }
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
            if (res && res.peers) updateLastActionUI(msg.state, res.peers);
        });
    } else if (msg.type === 'PEER_UPDATE') {
        updatePeerList(msg.peers);
        if (msg.peers) detectPeerChanges(msg.peers);
    } else if (msg.type === 'CONTROL_MODE') {
        const inRoom = elements.sectionActive && elements.sectionActive.style.display === 'block';
        updateHostControlUI({ controlMode: msg.controlMode, amHost: msg.amHost, amController: msg.amController, controllers: msg.controllers, hostPeerId: msg.hostPeerId, hostControlSupported: msg.hostControlSupported, coHostSupported: msg.coHostSupported, inRoom });
    } else if (msg.type === 'CONNECTION_STATUS') {
        if (msg.status === 'connected' || msg.status === 'disconnected') {
            if (joinBtnTimeout) { clearTimeout(joinBtnTimeout); joinBtnTimeout = null; }
        }
        if (msg.status === 'connected') {
            clearConnectionErrorTimer();
        }
        if (msg.status !== 'reconnecting') {
            applyConnectionStatus(msg.status);
            reconnectSlowMode = false;
        }
        if (msg.status === 'connected') {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
                if (!res) return;
                if (res.peers) updatePeerList(res.peers);
                if (res.lastActionState) updateLastActionUI(res.lastActionState, res.peers);
                updatePingDisplay(res.ping);
                updateHostControlUI({ controlMode: res.controlMode, amHost: res.amHost, amController: res.amController, controllers: res.controllers, hostPeerId: res.hostPeerId, hostControlSupported: res.hostControlSupported, coHostSupported: res.coHostSupported, inRoom: true });
            });
        }
        if (msg.status === 'disconnected') {
            elements.joinBtn.disabled = false;
            elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');
        }
        if (msg.status === 'reconnecting') {
            chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
                if (chrome.runtime.lastError) return;
                if (res && res.reconnectSlowMode !== undefined) reconnectSlowMode = res.reconnectSlowMode;
                applyConnectionStatus(msg.status);
                if (res && res.reconnectAttempts !== undefined) {
                    if (elements.connText) {
                        elements.connText.textContent = `Reconnecting... (${res.reconnectAttempts})`;
                    }
                }
            });
        }
    } else if (msg.type === 'PING_UPDATE') {
        updatePingDisplay(msg.ping);
    } else if (msg.type === 'HISTORY_UPDATE') {
        updateHistory(msg.history);
    } else if (msg.type === 'ROOM_LIST') {
        updateRoomList(msg.rooms);
    } else if (msg.type === 'JOIN_STATUS') {
        isProcessingConnection = false;
        if (joinBtnTimeout) {
            clearTimeout(joinBtnTimeout);
            joinBtnTimeout = null;
        }
        elements.joinBtn.disabled = false;
        elements.joinBtn.textContent = getMessage('BTN_JOIN_ROOM');

        if (msg.success) {
            // Final confirmation of join from background
            chrome.storage.local.get(['roomId', 'password', 'useCustomServer', 'serverUrl'], (data) => {
                updateUI(data.roomId, data.password, data.useCustomServer, data.serverUrl);
                const syncTabBtn = document.querySelector('.tab-btn[data-tab="tab-sync"]');
                if (syncTabBtn) syncTabBtn.click();
                showSelectVideoHint();
            });
        } else {
            // Join failed: reset UI state
            chrome.storage.local.set({ roomId: '', password: '' });
            elements.roomId.value = '';
            elements.password.value = '';
            updateUI(null, null);
        }
    } else if (msg.type === 'LOBBY_UPDATE') {
        // Episode lobby state changed
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
            if (res && res.peers) {
                updateLobbyUI(msg.lobby, res.peers);
            } else {
                updateLobbyUI(msg.lobby, []);
            }
        });
    }
});

elements.copyLogs.addEventListener('click', () => {
    const utcNow = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const userAgent = String(navigator.userAgent || '');

    const safe = (val, fb) => (val != null ? val : fb);

    Promise.all([
        new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_STATUS' }, resolve)),
        new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_LOGS' }, resolve)),
        new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, resolve))
    ]).then(([status, logs, history]) => {
        status = status || {};
        logs = logs || [];
        history = history || [];

        const videoPromise = (status && status.targetTabId)
            ? new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_VIDEO_STATE', tabId: status.targetTabId }, resolve))
            : Promise.resolve(null);

        videoPromise.then(rawVideo => {
        const vs = rawVideo || {};
        const lines = [];

        // ── Header ──
        const verStr = safe(status.version, '?');
        lines.push('# KoalaSync Debug Report');
        lines.push(`> **v${verStr}** | ${utcNow}`);
        lines.push('');

        // ── System ──
        lines.push('## System');
        lines.push(`- **Protocol:** ${safe(status.protocolVersion, '?')}`);
        lines.push(`- **Peer ID:** \`${safe(status.peerId, '?')}\``);
        lines.push(`- **User Agent:** ${userAgent}`);
        lines.push('');

        // ── Tab ──
        if (rawVideo) {
            lines.push('## Tab');
            if (vs.pageTitle) lines.push(`- **Title:** ${vs.pageTitle}`);
            if (vs.url) lines.push(`- **URL:** ${vs.url}`);
            if (vs.platform) lines.push(`- **Platform:** ${safe(vs.platform, '?')}`);
            lines.push(`- **Video Count:** ${safe(vs.videoCount, 0)} | **Shadow DOM:** ${vs.inShadowDom ? 'YES' : 'NO'}`);
            lines.push('');

            // Multi-video overview
            const videos = Array.isArray(vs.allVideos) ? vs.allVideos : [];
            if (videos.length > 1) {
                lines.push('### All Videos on Page');
                lines.push('');
                lines.push('| # | Resolution | Muted | Paused | Ready | Duration | Selected |');
                lines.push('|---|------------|-------|--------|-------|----------|----------|');
                const rl = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
                for (const v of videos) {
                    if (!v) continue;
                    const sel = v.selected ? ' **\u2190 TARGET**' : '';
                    const dim = `${safe(v.width, '?')}x${safe(v.height, '?')}`;
                    const rs = (v.readyState != null && v.readyState >= 0 && v.readyState <= 4) ? rl[v.readyState] : '?';
                    lines.push(`| ${safe(v.index, '?')} | ${dim} | ${safe(v.muted, '?')} | ${safe(v.paused, '?')} | ${rs} | ${safe(v.duration, 0)}s |${sel} |`);
                }
                lines.push('');
            }
        }

        // ── Connection ──
        lines.push('## Connection');
        const st = safe(status.status, 'disconnected');
        const emoji = st === 'connected' ? '\uD83D\uDFE2'
            : st === 'connecting' ? '\uD83D\uDFE1'
            : st === 'reconnecting' ? '\uD83D\uDFE0'
            : '\uD83D\uDD34';
        lines.push(`- **Status:** ${emoji} ${st}`);
        lines.push(`- **Server:** \`${safe(status.serverUrl, '?')}\``);
        lines.push(`- **Ping:** ${status.ping != null ? `${status.ping}ms` : '-'}`);
        if (status.roomId) {
            lines.push(`- **Room:** \`${status.roomId}\``);
            const peers = Array.isArray(status.peers) ? status.peers : [];
            const peerNames = peers.map(p => (p && (p.username || p.peerId)) || '?').join(', ');
            lines.push(`- **Peers (${peers.length}):** ${peers.length > 0 ? peerNames : 'none'}`);
        } else {
            lines.push('- **Room:** none');
        }
        if (safe(status.reconnectAttempts, 0) > 0) lines.push(`- **Reconnect Attempts:** ${status.reconnectAttempts}`);
        lines.push('');

        // ── Video ──
        lines.push('## Video');
        if (!rawVideo) {
            lines.push('- *No tab selected / communication failed*');
        } else if (!vs.found) {
            lines.push('- **Found:** \u274C NO VIDEO ELEMENT');
            if (vs.videoCount != null) lines.push(`- **Video Tags:** ${vs.videoCount}`);
            if (vs.inShadowDom != null) lines.push(`- **Shadow DOM:** ${vs.inShadowDom ? 'YES (checked)' : 'NO'}`);
            if (vs.metadata) {
                if (vs.metadata.title) lines.push(`- **MediaSession Title:** "${vs.metadata.title}"`);
                if (vs.metadata.artist) lines.push(`- **MediaSession Artist:** "${vs.metadata.artist}"`);
                if (vs.metadata.album) lines.push(`- **MediaSession Album:** "${vs.metadata.album}"`);
            }
        } else {
            const timeStr = (typeof vs.currentTime === 'number' ? vs.currentTime.toFixed(2) : '?') + 's / ' +
                (typeof vs.duration === 'number' ? vs.duration.toFixed(2) : '?') + 's';
            const readyLabel = safe(vs.readyStateLabel, '?');
            const readyOk = safe(vs.readyState, -1) >= 3;
            const netLabel = safe(vs.networkStateLabel, '?');
            const dimOk = safe(vs.videoWidth, 0) > 0 && safe(vs.videoHeight, 0) > 0;

            lines.push(`- **State:** ${vs.paused ? 'PAUSED' : 'PLAYING'}`);
            lines.push(`- **Time:** ${timeStr}`);
            lines.push(`- **ReadyState:** ${readyOk ? '\u2705' : '\u26A0\uFE0F'} ${safe(vs.readyState, '?')} (${readyLabel})`);
            lines.push(`- **Network:** ${safe(vs.networkState, '?')} (${netLabel})`);
            lines.push(`- **Buffered:** ${safe(vs.buffered, '?')}`);
            if (vs.nativeCurrentTime != null || vs.nativeDuration != null) {
                lines.push(`- **Native Time:** ${safe(vs.nativeCurrentTime, '?')}s / ${safe(vs.nativeDuration, '?')}s`);
            }
            if (vs.siteQuirk) {
                const quirk = vs.siteQuirk;
                const label = quirk.name || quirk.key || 'site';
                if (quirk.timeline) {
                    lines.push(`- **${label} Timeline:** ${safe(quirk.timeline.current, '?')}s / ${safe(quirk.timeline.duration, '?')}s`);
                }
                const candidates = Array.isArray(quirk.timelineCandidates) ? quirk.timelineCandidates : [];
                if (candidates.length > 0) {
                    lines.push(`- **${label} Timeline Candidates:**`);
                    candidates.forEach(c => lines.push(`  - ${safe(c.source, '?')}: ${safe(c.current, '?')}s / ${safe(c.duration, '?')}s`));
                }
                const buttons = Array.isArray(quirk.seekButtons) ? quirk.seekButtons : [];
                if (buttons.length > 0) {
                    lines.push(`- **${label} Buttons:**`);
                    buttons.forEach(label => lines.push(`  - ${label}`));
                }
            }
            lines.push(`- **Dimensions:** ${safe(vs.videoWidth, '?')}x${safe(vs.videoHeight, '?')}${dimOk ? '' : ' \u26A0\uFE0F 0x0'}`);
            lines.push(`- **Muted:** ${safe(vs.muted, '?')} | **Volume:** ${safe(vs.volume, '?')} | **Speed:** ${safe(vs.playbackRate, '?')}x`);
            lines.push(`- **Seeking:** ${safe(vs.seeking, '?')} | **Ended:** ${safe(vs.ended, '?')} | **Loop:** ${safe(vs.loop, '?')}`);
            if (vs.error && vs.error.code != null) {
                lines.push(`- **Error:** code=${vs.error.code}, msg="${safe(vs.error.message, 'none')}"`);
            }
            lines.push(`- **ID:** \`${safe(vs.id, '')}\` | **Class:** \`${safe(vs.className, '')}\``);
            lines.push(`- **Source:** \`${safe(vs.currentSrc, safe(vs.src, 'none'))}\``);
            if (vs.metadata) {
                if (vs.metadata.title) lines.push(`- **MediaSession Title:** "${vs.metadata.title}"`);
                if (vs.metadata.artist) lines.push(`- **MediaSession Artist:** "${vs.metadata.artist}"`);
                if (vs.metadata.album) lines.push(`- **MediaSession Album:** "${vs.metadata.album}"`);
            }
            if (vs.dataAttributes) {
                const keys = Object.keys(vs.dataAttributes);
                if (keys.length > 0) {
                    lines.push('- **Data Attributes:**');
                    for (const k of keys) lines.push(`  - \`${k}\` = "${safe(vs.dataAttributes[k], '')}"`);
                }
            }
        }
        lines.push('');

        // ── Action History (last 20) ──
        lines.push('## Action History (last 20)');
        if (history && history.length > 0) {
            const recent = history.slice(0, 20).reverse();
            lines.push('```');
            for (const h of recent) {
                if (!h) continue;
                const ts = safe(h.timestamp, '');
                const evt = safe(h.action, '?');
                const from = h.senderId ? ` (${h.senderId})` : (h.peerId ? ` (${h.peerId})` : '');
                const extra = h.detail ? ` \u2192 ${h.detail}` : '';
                lines.push(`[${ts}] ${evt}${from}${extra}`);
            }
            lines.push('```');
        } else {
            lines.push('*No history entries*');
        }
        lines.push('');

        // ── Logs (last 50) ──
        lines.push('## Logs (last 50)');
        if (logs && logs.length > 0) {
            const recent = logs.slice(0, 50).reverse();
            lines.push('```');
            for (const l of recent) {
                if (!l) continue;
                lines.push(`[${safe(l.timestamp, '')}] [${safe(l.type, '?')}] ${safe(l.message, '')}`);
            }
            lines.push('```');
        } else {
            lines.push('*No log entries*');
        }

        const text = lines.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const original = elements.copyLogs.textContent;
            elements.copyLogs.textContent = getMessage('TOAST_LOGS_COPIED');
            setTimeout(() => { elements.copyLogs.textContent = original; }, 2000);

            // Construct rich multiline toast summary
            const verStr = safe(status.version, '?');
            const logsCount = logs.length;
            const historyCount = history.length;
            const peersCount = Array.isArray(status.peers) ? status.peers.length : 0;

            let summary = `📋 Debug Report Copied!\n`;
            summary += `• Version: v${verStr}\n`;
            summary += `• System Logs: ${logsCount} entries\n`;
            summary += `• Sync Actions: ${historyCount} captured\n`;
            if (status.roomId) {
                summary += `• Peers in Room: ${peersCount}\n`;
            }
            if (rawVideo && vs.found) {
                const stateStr = vs.paused === true ? 'Paused' : (vs.paused === false ? 'Playing' : 'Unknown');
                const timeStr = typeof vs.currentTime === 'number' ? `${Math.round(vs.currentTime)}s` : '?';
                summary += `• Video: ${stateStr} at ${timeStr}\n`;
            }
            summary += `Paste it in markdown to view!`;

            showToast(summary, 'success', 5000);
        }).catch(() => {
            showToast(getMessage('TOAST_COPY_FAILED'), 'error');
        });
    });
    });
});

function refreshDebugInfo() {
    // Only refresh if Dev tab is visible
    const devTab = document.getElementById('tab-dev');
    if (!devTab || devTab.style.display === 'none') return;

    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
        if (!res || !res.targetTabId) {
            if (elements.videoDebug) elements.videoDebug.textContent = getMessage('DEBUG_NO_TAB');
            return;
        }

        // Request direct state from the content script via background
        chrome.runtime.sendMessage({ type: 'GET_VIDEO_STATE', tabId: res.targetTabId }, (state) => {
            if (!state || (!state.found && state.error)) {
                if (elements.videoDebug) elements.videoDebug.textContent = getMessage('DEBUG_COMM_FAIL');
                return;
            }

            if (elements.videoDebug) {
                elements.videoDebug.innerHTML = '';

                const addField = (label, value, color = null) => {
                    const row = document.createElement('div');
                    row.style.marginBottom = '4px';
                    if (color) row.style.color = color;

                    const b = document.createElement('b');
                    b.textContent = `${label}: `;
                    b.style.color = 'var(--text-muted)';

                    const span = document.createElement('span');
                    span.textContent = value;
                    span.style.wordBreak = 'break-all';

                    row.appendChild(b);
                    row.appendChild(span);
                    elements.videoDebug.appendChild(row);
                };

                const addSection = (title) => {
                    const div = document.createElement('div');
                    div.style.cssText = 'margin: 8px 0 4px 0; border-bottom: 1px solid #334155; padding-bottom: 2px; color: var(--accent); font-weight: bold; font-size: 10px; text-transform: uppercase;';
                    div.textContent = title;
                    elements.videoDebug.appendChild(div);
                };

                if (!state.found) {
                    // No video found — show diagnostic info
                    addSection('Video Detection');
                    const notFound = document.createElement('div');
                    notFound.style.cssText = 'color: #ef4444; font-weight: 700; margin-bottom: 8px;';
                    notFound.textContent = 'NO VIDEO ELEMENT FOUND';
                    elements.videoDebug.appendChild(notFound);

                    addField('Platform', state.platform || '?', 'var(--accent)');
                    addField('Page Title', state.pageTitle || '?');
                    addField('URL', state.url || '?');
                    addField('Video Tags', String(state.videoCount || 0));
                    addField('Shadow DOM', state.inShadowDom ? 'YES (checked)' : 'NO');

                    if (state.metadata) {
                        addSection('Media Session API');
                        addField('Title', state.metadata.title || 'n/a');
                        addField('Artist', state.metadata.artist || 'n/a');
                        addField('Album', state.metadata.album || 'n/a');
                    }

                    const hint = document.createElement('div');
                    hint.style.cssText = 'margin-top: 12px; padding: 8px; background: rgba(251,191,36,0.1); border-left: 3px solid #fbbf24; border-radius: 4px; font-size: 10px; color: var(--text-muted);';
                    hint.textContent = 'Is a video currently playing? The extension only detects <video> elements. Ensure media is actively loaded on the page.';
                    elements.videoDebug.appendChild(hint);
                    return;
                }

                // Video found — full debug
                addSection('Playback');
                addField('State', state.paused ? 'PAUSED' : 'PLAYING', state.paused ? 'var(--text-muted)' : '#22c55e');
                addField('Time', `${state.currentTime.toFixed(2)}s / ${(state.duration || 0).toFixed(2)}s`);
                addField('ReadyState', `${state.readyState} (${state.readyStateLabel || '?'})`,
                    state.readyState >= 3 ? '#22c55e' : '#fbbf24');
                addField('Network', `${state.networkState} (${state.networkStateLabel || '?'})`,
                    state.networkState === 1 ? '#22c55e' : state.networkState === 3 ? '#ef4444' : 'var(--text-muted)');
                addField('Buffered', state.buffered || '?');
                if (state.nativeCurrentTime != null || state.nativeDuration != null) {
                    addField('Native Time', `${state.nativeCurrentTime ?? '?'}s / ${state.nativeDuration ?? '?'}s`);
                }
                if (state.siteQuirk) {
                    const quirk = state.siteQuirk;
                    const label = quirk.name || quirk.key || 'Site';
                    if (quirk.timeline) {
                        addField(`${label} Timeline`, `${quirk.timeline.current ?? '?'}s / ${quirk.timeline.duration ?? '?'}s`);
                    }
                    const buttons = Array.isArray(quirk.seekButtons) ? quirk.seekButtons.slice(0, 4).join(' | ') : '';
                    if (buttons) addField(`${label} Buttons`, buttons);
                }
                addSection('Properties');
                addField('Seeking', String(state.seeking));
                addField('Ended', String(state.ended));
                addField('Loop', String(state.loop));
                addField('Muted', String(state.muted));
                addField('Volume', String(state.volume));
                addField('Speed', `${state.playbackRate}x`);

                addSection('Dimensions');
                const dimsOk = state.videoWidth > 0 && state.videoHeight > 0;
                addField('Resolution', `${state.videoWidth}x${state.videoHeight}`, dimsOk ? '#22c55e' : '#ef4444');
                if (!dimsOk) {
                    const dimHint = document.createElement('div');
                    dimHint.style.cssText = 'color: #fbbf24; font-size: 9px; margin: 2px 0 6px 12px;';
                    dimHint.textContent = '0x0 = video element hidden or not yet loaded';
                    elements.videoDebug.appendChild(dimHint);
                }

                if (state.error) {
                    addSection('Media Error');
                    addField('Code', String(state.error.code), '#ef4444');
                    addField('Message', state.error.message || '?', '#ef4444');
                }

                addSection('Detection');
                addField('Platform', state.platform || '?', 'var(--accent)');
                addField('Video Count', String(state.videoCount || 0));
                addField('Shadow DOM', state.inShadowDom ? 'YES' : 'NO');

                addSection('Identification');
                addField('URL', state.url);
                addField('ID', state.id);
                addField('CLASS', state.className);

                addSection('Media Source');
                addField('CurrentSrc', state.currentSrc);
                addField('Src', state.src);

                if (state.metadata) {
                    addSection('Media Session API');
                    addField('Title', state.metadata.title || 'n/a');
                    addField('Artist', state.metadata.artist || 'n/a');
                    addField('Album', state.metadata.album || 'n/a');
                }

                if (state.dataAttributes && Object.keys(state.dataAttributes).length > 0) {
                    addSection('Data Attributes');
                    for (const [key, val] of Object.entries(state.dataAttributes)) {
                        addField(key.replace('data-', '').toUpperCase(), val);
                    }
                }
            }
        });
    });
}

init();
popupIntervals.push(setInterval(() => {
    if (isDevTabVisible) refreshLogs();
}, 5000));

window.addEventListener('unload', () => {
    stopInterpolation();
    popupIntervals.forEach(clearInterval);
    popupIntervals = [];
    if (joinBtnTimeout) {
        clearTimeout(joinBtnTimeout);
        joinBtnTimeout = null;
    }
    if (forceSyncResetTimer) {
        clearTimeout(forceSyncResetTimer);
        forceSyncResetTimer = null;
    }
    if (roomListRefreshTimer) {
        clearTimeout(roomListRefreshTimer);
        roomListRefreshTimer = null;
    }
    if (roomListRefreshInterval) {
        clearInterval(roomListRefreshInterval);
        roomListRefreshInterval = null;
    }
});

// --- Episode Lobby UI ---
function updateLobbyUI(lobby, peers) {
    if (!elements.episodeLobbyCard) return;

    if (!lobby) {
        elements.episodeLobbyCard.style.display = 'none';
        return;
    }

    elements.episodeLobbyCard.style.display = 'block';
    elements.lobbyTitle.textContent = getMessage('LOBBY_WAITING_FOR', { title: lobby.expectedTitle });

    // Build peer readiness list
    const readySet = new Set(lobby.readyPeers || []);
    const peerLines = [];

    if (peers && peers.length > 0) {
        peers.forEach(p => {
            const pId = typeof p === 'object' ? p.peerId : p;
            const pName = (typeof p === 'object' && p.username) ? p.username : pId;
            const avatar = getAvatarForName(pName);
            const isReady = readySet.has(pId);
            const icon = isReady ? '\u2705' : '\u23f3';
            const label = isReady ? getMessage('LABEL_LOBBY_PEER_READY') : getMessage('LABEL_LOBBY_PEER_LOADING');
            peerLines.push(`${icon} ${avatar} ${pName} \u2014 ${label}`);
        });
    }

    if (peerLines.length > 0 && elements.lobbyPeerStatus) {
        elements.lobbyPeerStatus.textContent = peerLines.join(' | ');
    } else if (elements.lobbyPeerStatus) {
        elements.lobbyPeerStatus.textContent = getMessage('LOBBY_WAITING_PEERS');
    }

    // Show elapsed time
    if (lobby.createdAt && elements.lobbyPeerStatus) {
        const elapsed = Math.floor((Date.now() - lobby.createdAt) / 1000);
        elements.lobbyPeerStatus.textContent += ` (${elapsed}s)`;
    }
}

// --- Onboarding Tour ---
const onboardingSteps = [
    { 
        icon: '👋', 
        get title() { return getMessage('ONBOARDING_1_TITLE'); }, 
        get text() { return getMessage('ONBOARDING_1_TEXT'); },
        targetTab: 'tab-room',
        targetSelector: null
    },
    { 
        icon: '🏠', 
        get title() { return getMessage('ONBOARDING_2_TITLE'); }, 
        get text() { return getMessage('ONBOARDING_2_TEXT'); }, 
        targetTab: 'tab-room',
        targetSelector: '#createRoomBtn'
    },
    { 
        icon: '🎬', 
        get title() { return getMessage('ONBOARDING_3_TITLE'); }, 
        get text() { return getMessage('ONBOARDING_3_TEXT'); }, 
        targetTab: 'tab-sync',
        targetSelector: '#targetTab'
    },
    { 
        icon: '⚙️', 
        get title() { return getMessage('ONBOARDING_4_TITLE'); }, 
        get text() { return getMessage('ONBOARDING_4_TEXT'); },
        targetTab: 'tab-settings',
        targetSelector: '#username'
    },
    {
        icon: '🍿',
        get title() { return getMessage('ONBOARDING_5_TITLE'); },
        get text() { return getMessage('ONBOARDING_5_TEXT'); },
        targetTab: 'tab-room',
        targetSelector: null
    }
];

function showSelectVideoHint() {
    const hint = document.getElementById('targetTabHint');
    if (hint && !elements.targetTab.value) {
        hint.style.display = 'block';
    }
}

let onboardingStep = 0;
let onboardingTimeout = null;

function showOnboarding() {
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;
    document.body.style.minHeight = '420px';
    overlay.style.display = 'block';
    onboardingStep = 0;
    renderOnboardingStep();
}

function positionSpotlightAndCard(targetEl) {
    const spotlight = document.getElementById('onboarding-spotlight');
    const card = document.getElementById('onboarding-card');
    const arrow = document.getElementById('onboarding-arrow');
    if (!spotlight || !card || !arrow) return;

    spotlight.style.display = 'block';
    card.style.display = 'block';
    
    // Force a reflow
    card.getBoundingClientRect();
    spotlight.getBoundingClientRect();

    const targetRect = targetEl.getBoundingClientRect();
    const pad = 6;
    const sLeft = targetRect.left - pad;
    const sTop = targetRect.top - pad;
    const sWidth = targetRect.width + (pad * 2);
    const sHeight = targetRect.height + (pad * 2);
    
    spotlight.style.left = `${sLeft}px`;
    spotlight.style.top = `${sTop}px`;
    spotlight.style.width = `${sWidth}px`;
    spotlight.style.height = `${sHeight}px`;
    spotlight.style.opacity = '1';

    const cardWidth = 280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    
    let cLeft = targetRect.left + (targetRect.width - cardWidth) / 2;
    cLeft = Math.max(12, Math.min(320 - cardWidth - 12, cLeft));
    
    const cardHeight = card.offsetHeight || 150;
    let cTop = targetRect.bottom + 14;
    let arrowDir = 'up';
    
    if (cTop + cardHeight > viewportHeight - 12) {
        cTop = targetRect.top - cardHeight - 14;
        arrowDir = 'down';
    }
    
    if (cTop < 12) {
        cTop = targetRect.bottom + 14;
        arrowDir = 'up';
    }

    card.style.left = `${cLeft}px`;
    card.style.top = `${cTop}px`;
    card.style.opacity = '1';
    card.style.transform = 'scale(1)';

    arrow.style.left = '';
    arrow.style.right = '';
    arrow.style.top = '';
    arrow.style.bottom = '';
    arrow.style.borderColor = 'transparent';
    
    const targetCenter = targetRect.left + (targetRect.width / 2);
    const arrowLeft = targetCenter - cLeft - 6;
    arrow.style.left = `${Math.max(12, Math.min(cardWidth - 24, arrowLeft))}px`;
    
    if (arrowDir === 'up') {
        arrow.style.top = '-12px';
        arrow.style.borderBottomColor = 'var(--card)';
    } else {
        arrow.style.bottom = '-12px';
        arrow.style.borderTopColor = 'var(--card)';
    }
}

function centerCardFallback() {
    const spotlight = document.getElementById('onboarding-spotlight');
    const card = document.getElementById('onboarding-card');
    const arrow = document.getElementById('onboarding-arrow');
    if (!card) return;

    if (spotlight) {
        spotlight.style.display = 'none';
        spotlight.style.opacity = '0';
    }
    if (arrow) {
        arrow.style.borderColor = 'transparent';
    }

    card.style.display = 'block';
    
    const cardWidth = 280;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    
    const cLeft = (320 - cardWidth) / 2;
    const cTop = (viewportHeight - (card.offsetHeight || 150)) / 2;
    
    card.style.left = `${cLeft}px`;
    card.style.top = `${cTop}px`;
    card.style.opacity = '1';
    card.style.transform = 'scale(1)';
}

function renderOnboardingStep() {
    if (onboardingTimeout) clearTimeout(onboardingTimeout);
    
    const step = onboardingSteps[onboardingStep];
    const icon = document.getElementById('onboarding-icon');
    const title = document.getElementById('onboarding-title');
    const text = document.getElementById('onboarding-text');
    const nextBtn = document.getElementById('onboarding-next');
    const stepIndicator = document.getElementById('onboarding-step-indicator');
    const progressBar = document.getElementById('onboarding-progress-bar');
    
    if (!icon || !title || !text || !nextBtn) return;

    icon.textContent = step.icon;
    title.textContent = step.title;
    text.textContent = step.text;

    if (stepIndicator) {
        stepIndicator.textContent = `Step ${onboardingStep + 1} of ${onboardingSteps.length}`;
    }
    if (progressBar) {
        progressBar.style.width = `${((onboardingStep + 1) / onboardingSteps.length) * 100}%`;
    }

    nextBtn.textContent = onboardingStep === onboardingSteps.length - 1 
        ? (getMessage('ONBOARDING_DONE') !== 'ONBOARDING_DONE' ? getMessage('ONBOARDING_DONE') : 'Done!') 
        : getMessage('BTN_ONBOARDING_NEXT');

    if (step.targetTab) {
        const tabBtn = document.querySelector(`.tab-btn[data-tab="${step.targetTab}"]`);
        if (tabBtn) tabBtn.click();
        
        const syncActive = document.getElementById('sync-active');
        const syncInactive = document.getElementById('sync-inactive');
        if (step.targetTab === 'tab-sync') {
            if (syncActive) syncActive.style.display = 'block';
            if (syncInactive) syncInactive.style.display = 'none';
        } else {
            const inRoom = elements.sectionActive && elements.sectionActive.style.display === 'block';
            if (syncActive) syncActive.style.display = inRoom ? 'block' : 'none';
            if (syncInactive) syncInactive.style.display = inRoom ? 'none' : 'block';
        }
    }

    const spotlight = document.getElementById('onboarding-spotlight');
    const card = document.getElementById('onboarding-card');
    if (spotlight) spotlight.style.opacity = '0';
    if (card) {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
    }

    onboardingTimeout = setTimeout(() => {
        const targetEl = step.targetSelector ? document.querySelector(step.targetSelector) : null;
        if (targetEl && targetEl.offsetParent !== null) {
            positionSpotlightAndCard(targetEl);
        } else {
            centerCardFallback();
        }
    }, 180);
}

function completeOnboarding() {
    if (onboardingTimeout) clearTimeout(onboardingTimeout);
    
    const overlay = document.getElementById('onboarding-overlay');
    const spotlight = document.getElementById('onboarding-spotlight');
    const card = document.getElementById('onboarding-card');
    
    if (card) {
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9)';
    }
    if (spotlight) {
        spotlight.style.opacity = '0';
    }
    
    setTimeout(() => {
        if (overlay) overlay.style.display = 'none';
        document.body.style.minHeight = '';
        chrome.storage.sync.set({ onboardingComplete: true });
        
        const inRoom = elements.sectionActive && elements.sectionActive.style.display === 'block';
        toggleUIState(inRoom);
    }, 300);
}

document.getElementById('onboarding-next')?.addEventListener('click', () => {
    onboardingStep++;
    if (onboardingStep >= onboardingSteps.length) {
        completeOnboarding();
    } else {
        renderOnboardingStep();
    }
});

document.getElementById('onboarding-skip')?.addEventListener('click', completeOnboarding);

document.getElementById('onboarding-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'onboarding-overlay') completeOnboarding();
});

elements.restartTourBtn?.addEventListener('click', () => {
    onboardingStep = 0;
    showOnboarding();
});

// Chat Functions
function sendChatMessage() {
    const text = elements.chatInput?.value;
    if (!text || !text.trim()) return;
    
    const message = {
        id: Date.now().toString(),
        senderId: localPeerId,
        username: elements.username?.value || 'Anonymous',
        text: text.trim(),
        timestamp: Date.now()
    };
    
    // Show own message immediately (local echo)
    addMessageToUI(message, 'own');
    
    // Send to background
    chrome.runtime.sendMessage({ 
        type: 'CHAT_MESSAGE', 
        payload: message 
    }).catch(err => {
        console.error('Failed to send chat message:', err);
    });
    
    // Clear input
    if (elements.chatInput) {
        elements.chatInput.value = '';
    }
}

// Chat Event Listeners
function initChatEventListeners() {
    // Enter key sends message
    elements.chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    
    // Send button click
    elements.sendBtn?.addEventListener('click', () => {
        sendChatMessage();
    });
    
    // Emoji button click (placeholder - shows toast for now)
    elements.emojiBtn?.addEventListener('click', () => {
        showToast('Emoji picker coming soon!', 'info');
    });
}

// Initialize chat event listeners
initChatEventListeners();

// Chat Message Display
function addMessageToUI(message, type = 'other') {
    const container = elements.chatMessages;
    if (!container) return;
    
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.dataset.messageId = message.id;
    
    const time = new Date(message.timestamp).toLocaleTimeString();
    
    div.innerHTML = `
        <div class="message-header">${escapeHtml(message.username || 'Anonymous')} • ${time}</div>
        <div class="message-text">${formatMessageText(message.text)}</div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatMessageText(text) {
    if (!text) return '';
    // Already escaped in escapeHtml, now apply markdown
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    return text;
}

// Receive chat messages from background
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CHAT_MESSAGE_RECEIVED') {
        // Determine if this is our own message or from another peer
        const isOwn = msg.payload.senderId === localPeerId;
        addMessageToUI(msg.payload, isOwn ? 'own' : 'other');
    }
});
