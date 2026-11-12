(function initKoalaSyncChatOverlay() {
    if (document.documentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;

    if (window.koalaSyncChatOverlay?.refresh) {
        window.koalaSyncChatOverlay.refresh();
        return;
    }

    const MAX_MESSAGES = 200;
    const MIN_WIDTH = 300;
    const MIN_HEIGHT = 320;
    const DEFAULT_WIDTH = 360;
    const DEFAULT_HEIGHT = 520;
    const LAUNCHER_SIZE = 48;
    const EDGE_INSET = 8;
    const MAX_MESSAGE_CODE_POINTS = 500;
    const MAX_CHAT_CHUNKS = 10;
    const MAX_COMPOSER_CODE_POINTS = MAX_MESSAGE_CODE_POINTS * MAX_CHAT_CHUNKS;
    const PAGE_DOCK_ATTRIBUTE = 'data-koalasync-chat-dock';
    const PAGE_DOCK_WIDTH = '--koalasync-chat-dock-width';
    const QUICK_REACTIONS = Object.freeze(['❤️', '😂', '😮', '😢', '👏', '🔥']);
    const MAX_REACTION_PARTICLES = 36;
    const MAX_RENDERED_ACTIVITY_IDS = 200;
    const LAUNCHER_ICON_DATA_URL = 'data:image/png;base64,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';
    const SIZE_PRESETS = Object.freeze({
        compact: Object.freeze({ width: 320, height: 400 }),
        standard: Object.freeze({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }),
        large: Object.freeze({ width: 440, height: 640 })
    });
    const storageKey = `chatOverlayLayout:${location.origin}`;
    const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
    let context = null;
    let opened = false;
    let destroyed = false;
    let saveTimer = null;
    let applyingLayout = false;
    let preferencesLoaded = false;
    let startStateApplied = false;
    let refreshGeneration = 0;
    let sendGeneration = 0;
    let sending = false;
    let unreadCount = 0;
    let layout = {
        mode: 'right',
        x: 24,
        y: 72,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        customWidth: DEFAULT_WIDTH,
        customHeight: DEFAULT_HEIGHT,
        detachedInitialized: false,
        launcherX: null,
        launcherY: null,
        launcherInitialized: false
    };
    let chatPosition = 'right';
    let chatSize = 'standard';
    let chatStartMode = 'bubble';
    let chatReactionDisplay = 'chat';
    let themeMode = 'system';
    let themePalette = 'eucalyptus';
    let pageDockTarget = null;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const renderedActivityIds = new Set();
    const renderedActivityIdOrder = [];

    const host = document.createElement('div');
    host.id = 'koalasync-chat-overlay-host';
    host.style.cssText = 'all:initial;display:none;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style paint;transform:translateZ(0);';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        #app {
            --bg: oklch(0.205 0.025 155); --card: oklch(0.30 0.035 150);
            --surface-alt: oklch(0.265 0.032 150); --surface-deep: oklch(0.205 0.025 155);
            --accent: oklch(0.73 0.13 155); --accent-hover: oklch(0.79 0.12 155);
            --text: oklch(0.96 0.01 90); --text-muted: oklch(0.78 0.02 90);
            --border-soft: oklch(0.88 0.025 145 / 0.09); --border-strong: oklch(0.39 0.038 145);
            --text-on-green: oklch(0.14 0.02 90); --danger: oklch(0.63 0.18 25);
            position: fixed; inset: 0; pointer-events: none; color: var(--text);
            font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #app[data-theme="light"] {
            --bg: oklch(0.935 0.018 110); --card: oklch(0.995 0.006 100);
            --surface-alt: oklch(0.91 0.022 115); --surface-deep: oklch(0.935 0.018 110);
            --accent: oklch(0.52 0.13 155); --accent-hover: oklch(0.45 0.12 155);
            --text: oklch(0.21 0.03 140); --text-muted: oklch(0.43 0.03 135);
            --border-soft: oklch(0.28 0.035 140 / 0.10); --border-strong: oklch(0.73 0.035 125);
            --text-on-green: oklch(0.16 0.03 140);
        }
        #app[data-palette="cyber"] {
            --bg: oklch(0.185 0.04 265); --card: oklch(0.285 0.05 265);
            --surface-alt: oklch(0.25 0.048 265); --surface-deep: oklch(0.185 0.04 265);
            --accent: oklch(0.59 0.20 275); --accent-hover: oklch(0.69 0.17 275);
            --text: oklch(0.97 0.012 265); --text-muted: oklch(0.74 0.03 265);
            --border-soft: oklch(0.9 0.03 265 / 0.10); --border-strong: oklch(0.42 0.05 265);
            --text-on-green: oklch(0.99 0.006 275);
        }
        #app[data-palette="cyber"][data-theme="light"] {
            --bg: oklch(0.945 0.014 265); --card: oklch(0.995 0.005 265);
            --surface-alt: oklch(0.915 0.02 265); --surface-deep: oklch(0.945 0.014 265);
            --accent: oklch(0.53 0.21 275); --accent-hover: oklch(0.46 0.20 275);
            --text: oklch(0.26 0.05 265); --text-muted: oklch(0.48 0.045 265);
            --border-soft: oklch(0.30 0.05 265 / 0.12); --border-strong: oklch(0.79 0.03 265);
            --text-on-green: oklch(0.99 0.005 275);
        }
        #app[data-palette="graphite"] {
            --bg: oklch(0.165 0.004 260); --card: oklch(0.255 0.005 260);
            --surface-alt: oklch(0.225 0.005 260); --surface-deep: oklch(0.165 0.004 260);
            --accent: oklch(0.93 0.006 260); --accent-hover: oklch(0.99 0.003 260);
            --text: oklch(0.97 0.003 260); --text-muted: oklch(0.72 0.005 260);
            --border-soft: oklch(0.92 0.008 260 / 0.11); --border-strong: oklch(0.42 0.006 260);
            --text-on-green: oklch(0.20 0.004 260);
        }
        #app[data-palette="graphite"][data-theme="light"] {
            --bg: oklch(0.928 0.003 260); --card: oklch(1 0 0);
            --surface-alt: oklch(0.90 0.004 260); --surface-deep: oklch(0.928 0.003 260);
            --accent: oklch(0.28 0.006 260); --accent-hover: oklch(0.18 0.005 260);
            --text: oklch(0.22 0.005 260); --text-muted: oklch(0.46 0.006 260);
            --border-soft: oklch(0.20 0.006 260 / 0.13); --border-strong: oklch(0.77 0.004 260);
            --text-on-green: oklch(0.98 0.002 260);
        }
        button, textarea { font: inherit; }
        button { color: inherit; }
        .launcher {
             position: fixed; width: 48px; height: 48px; border: 1px solid var(--border-strong);
             border-radius: 16px; background: var(--card); color: var(--text); cursor: pointer;
             pointer-events: auto; box-shadow: 0 10px 28px rgb(0 0 0 / .32);
             touch-action: none; user-select: none;
         }
         .launcher.docked-left { left: 0 !important; right: auto !important; border-left: 0; border-radius: 0 16px 16px 0; }
         .launcher.docked-right { left: auto !important; right: 0 !important; border-right: 0; border-radius: 16px 0 0 16px; }
         .launcher:hover:not([aria-disabled="true"]) { border-color: var(--accent); transform: translateY(-1px); }
         .launcher[aria-disabled="true"] { cursor: not-allowed; opacity: .58; }
         .launcher-icon { display: block; width: 36px; height: 36px; margin: auto; pointer-events: none; }
         .launcher-bubble-mark {
             position: absolute; right: 3px; bottom: 3px; width: 15px; height: 12px;
             border: 2px solid var(--card); border-radius: 7px; background: var(--accent); pointer-events: none;
         }
         .launcher-bubble-mark::after {
             content: ""; position: absolute; right: 0; bottom: -4px;
             width: 5px; height: 5px; background: var(--accent); clip-path: polygon(0 0, 100% 0, 100% 100%);
         }
         .unread {
             position: absolute; top: -7px; right: -7px; display: none; min-width: 22px; height: 22px;
             align-items: center; justify-content: center; padding: 0 6px; border: 2px solid var(--card);
             border-radius: 999px; background: var(--danger); color: white; font-size: 11px; font-weight: 800;
             line-height: 1; pointer-events: none;
         }
         .unread.visible { display: flex; }
         .panel {
            position: fixed; display: none; flex-direction: column; overflow: hidden;
            min-width: min(${MIN_WIDTH}px, calc(100vw - 16px)); min-height: min(${MIN_HEIGHT}px, calc(100vh - 16px)); max-width: calc(100vw - 16px);
            max-height: calc(100vh - 16px); pointer-events: auto; color: var(--text);
            background: var(--card); border: 1px solid var(--border-strong); border-radius: 18px;
            box-shadow: 0 18px 55px rgb(0 0 0 / .38); transform: translateZ(0);
         }
         .panel.open { display: flex; }
         .panel.docked { border-radius: 0; max-height: 100vh; }
         .header { display: flex; align-items: center; gap: 10px; padding: 12px; border-bottom: 1px solid var(--border-soft); user-select: none; }
        .header.detached { cursor: move; }
        .heading { min-width: 0; flex: 1; }
        .title { font-size: 14px; font-weight: 760; }
        .subtitle { color: var(--text-muted); font-size: 11px; }
        .modes { display: flex; gap: 4px; }
        .icon-button { width: 30px; height: 30px; border: 1px solid var(--border-soft); border-radius: 9px; background: var(--surface-alt); cursor: pointer; }
        .icon-button:hover, .icon-button.active { border-color: var(--accent); color: var(--accent); }
        .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; background: var(--bg); overscroll-behavior: contain; }
        .empty { color: var(--text-muted); text-align: center; padding: 32px 12px; font-size: 12px; }
        .message { margin-bottom: 11px; overflow-wrap: anywhere; }
        .meta { display: flex; align-items: baseline; gap: 7px; margin-bottom: 2px; }
        .sender { color: var(--accent); font-weight: 700; font-size: 12px; }
        .time { color: var(--text-muted); font-size: 10px; }
         .body { white-space: pre-wrap; color: var(--text); }
         .event-message {
             display: flex; align-items: center; justify-content: center; gap: 7px; margin: 8px 0;
             color: var(--text-muted); font-size: 11px; text-align: center;
         }
         .event-message::before, .event-message::after { content: ""; flex: 1; height: 1px; background: var(--border-soft); }
         .event-text { max-width: 78%; }
        .composer { padding: 10px; border-top: 1px solid var(--border-soft); background: var(--card); }
        .quick-reactions { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; }
        .reaction-button {
            width: 34px; height: 30px; border: 1px solid var(--border-soft); border-radius: 9px;
            background: var(--surface-alt); cursor: pointer; font-size: 18px; line-height: 1;
        }
        .reaction-button:hover:not(:disabled), .reaction-button:focus-visible { border-color: var(--accent); transform: translateY(-1px); }
        .reaction-button:disabled { opacity: .5; cursor: wait; }
        textarea { width: 100%; min-height: 62px; max-height: 132px; resize: vertical; border: 1px solid var(--border-strong); border-radius: 11px; padding: 9px; background: var(--surface-deep); color: var(--text); outline: none; }
        textarea:focus { border-color: var(--accent); }
        textarea::placeholder { color: var(--text-muted); }
        .composer-row { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
        .count { flex: 1; color: var(--text-muted); font-size: 10px; }
        .status { color: var(--danger); font-size: 10px; min-height: 14px; }
        .send { border: 0; border-radius: 10px; padding: 8px 13px; background: var(--accent); color: var(--text-on-green); font-weight: 750; cursor: pointer; }
        .send:hover:not(:disabled) { background: var(--accent-hover); }
        .send:disabled { opacity: .55; cursor: wait; }
        .reaction-layer { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 1; }
        .reaction-particle {
            position: absolute; top: -12vh; font-size: clamp(24px, 4vw, 48px);
            filter: drop-shadow(0 4px 7px rgb(0 0 0 / .35));
            animation: reaction-fall var(--reaction-duration) cubic-bezier(.22,.62,.45,1) var(--reaction-delay) forwards;
        }
        .launcher, .panel { z-index: 2; }
        @keyframes reaction-fall {
            0% { transform: translate3d(0, -8vh, 0) rotate(var(--reaction-start-rotation)); opacity: 0; }
            12% { opacity: 1; }
            100% { transform: translate3d(var(--reaction-drift), 116vh, 0) rotate(var(--reaction-end-rotation)); opacity: .92; }
        }
        .visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        @media (max-width: 520px) { .panel { max-width: calc(100vw - 12px); } }
        @media (prefers-reduced-motion: reduce) {
            * { transition: none !important; }
            .reaction-particle { animation: none !important; display: none !important; }
        }
    `;

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    const app = element('div');
    app.id = 'app';
    const launcher = element('button', 'launcher');
    launcher.type = 'button';
    const launcherIcon = element('img', 'launcher-icon');
    launcherIcon.src = LAUNCHER_ICON_DATA_URL;
    launcherIcon.alt = '';
    const launcherBubbleMark = element('span', 'launcher-bubble-mark');
    launcherBubbleMark.setAttribute('aria-hidden', 'true');
    const unreadBadge = element('span', 'unread');
    unreadBadge.setAttribute('aria-hidden', 'true');
    launcher.append(launcherIcon, launcherBubbleMark, unreadBadge);
    const launcherHint = element('span', 'visually-hidden');
    launcherHint.id = 'chat-launcher-hint';
    const panel = element('section', 'panel');
    panel.setAttribute('role', 'dialog');
    const header = element('header', 'header');
    const heading = element('div', 'heading');
    const title = element('div', 'title');
    const subtitle = element('div', 'subtitle');
    heading.append(title, subtitle);
    const modes = element('div', 'modes');
    const leftButton = element('button', 'icon-button', '←');
    const detachedButton = element('button', 'icon-button', '✥');
    const rightButton = element('button', 'icon-button', '→');
    const closeButton = element('button', 'icon-button', '×');
    for (const button of [leftButton, detachedButton, rightButton, closeButton]) button.type = 'button';
    modes.append(leftButton, detachedButton, rightButton, closeButton);
    header.append(heading, modes);
    const messages = element('div', 'messages');
    messages.setAttribute('aria-live', 'polite');
    const empty = element('div', 'empty');
    messages.append(empty);
    const composer = element('form', 'composer');
    const quickReactions = element('div', 'quick-reactions');
    quickReactions.setAttribute('role', 'group');
    const reactionButtons = QUICK_REACTIONS.map(reaction => {
        const button = element('button', 'reaction-button', reaction);
        button.type = 'button';
        button.dataset.reaction = reaction;
        quickReactions.append(button);
        return button;
    });
    const textareaLabel = element('label', 'visually-hidden');
    textareaLabel.htmlFor = 'chat-composer-input';
    const textarea = element('textarea');
    textarea.id = 'chat-composer-input';
    textarea.setAttribute('aria-describedby', 'chat-composer-count chat-composer-status');
    const composerRow = element('div', 'composer-row');
    const count = element('span', 'count', `0/${MAX_COMPOSER_CODE_POINTS}`);
    count.id = 'chat-composer-count';
    const sendButton = element('button', 'send');
    sendButton.type = 'submit';
    composerRow.append(count, sendButton);
    const status = element('div', 'status');
    status.id = 'chat-composer-status';
    status.setAttribute('role', 'status');
    composer.append(quickReactions, textareaLabel, textarea, composerRow, status);
    panel.append(header, messages, composer);
    const reactionLayer = element('div', 'reaction-layer');
    reactionLayer.setAttribute('aria-hidden', 'true');
    app.append(reactionLayer, launcherHint, launcher, panel);
    shadow.append(style, app);
    document.documentElement.append(host);
    const pageDockStyle = document.createElement('style');
    pageDockStyle.id = 'koalasync-chat-page-dock-style';
    pageDockStyle.textContent = `
        html[${PAGE_DOCK_ATTRIBUTE}] {
            box-sizing: border-box !important;
            width: calc(100% - var(${PAGE_DOCK_WIDTH})) !important;
            max-width: calc(100% - var(${PAGE_DOCK_WIDTH})) !important;
            overflow-x: clip !important;
        }
        html[${PAGE_DOCK_ATTRIBUTE}="left"] {
            margin-left: var(${PAGE_DOCK_WIDTH}) !important;
            margin-right: 0 !important;
        }
        html[${PAGE_DOCK_ATTRIBUTE}="right"] {
            margin-left: 0 !important;
            margin-right: var(${PAGE_DOCK_WIDTH}) !important;
        }
        html[${PAGE_DOCK_ATTRIBUTE}] > body {
            width: 100% !important;
            max-width: 100% !important;
            min-height: 100vh !important;
            overflow-x: clip !important;
            clip-path: inset(0) !important;
            contain: layout paint !important;
        }
        [${PAGE_DOCK_ATTRIBUTE}]:not(html) > :not(#koalasync-chat-overlay-host) {
            box-sizing: border-box !important;
            width: calc(100% - var(${PAGE_DOCK_WIDTH})) !important;
            max-width: calc(100% - var(${PAGE_DOCK_WIDTH})) !important;
            overflow-x: clip !important;
            clip-path: inset(0) !important;
            contain: layout paint !important;
        }
        [${PAGE_DOCK_ATTRIBUTE}="left"]:not(html) > :not(#koalasync-chat-overlay-host) {
            margin-left: var(${PAGE_DOCK_WIDTH}) !important;
            margin-right: 0 !important;
        }
        [${PAGE_DOCK_ATTRIBUTE}="right"]:not(html) > :not(#koalasync-chat-overlay-host) {
            margin-left: 0 !important;
            margin-right: var(${PAGE_DOCK_WIDTH}) !important;
        }
    `;
    document.documentElement.append(pageDockStyle);

    function messageRuntime(payload, timeoutMs = 5000) {
        return new Promise(resolve => {
            let settled = false;
            const finish = response => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(response || null);
            };
            const timeout = setTimeout(() => finish(null), timeoutMs);
            try {
                chrome.runtime.sendMessage(payload, response => {
                    if (chrome.runtime.lastError) finish(null);
                    else finish(response);
                });
            } catch (_) {
                finish(null);
            }
        });
    }

    function setLocalStorage(values) {
        if (destroyed) return;
        try {
            const result = chrome.storage.local.set(values);
            if (result?.catch) result.catch(() => {});
        } catch (_) {
            // Extension context was invalidated while the page remained open.
        }
    }

    function strings() {
        return context?.strings || {};
    }

    function applyStrings() {
        const text = strings();
        title.textContent = text.title || '';
        subtitle.textContent = text.liveOnly || '';
        launcher.setAttribute('aria-label', text.open || '');
        const unavailableHint = context?.supported && !context?.hasKey
            ? (text.missingKey || '')
            : context?.supported && !context?.connected ? (text.sendFailed || '') : '';
        launcher.title = unavailableHint || text.open || '';
        launcherHint.textContent = unavailableHint;
        if (unavailableHint) launcher.setAttribute('aria-describedby', launcherHint.id);
        else launcher.removeAttribute('aria-describedby');
        panel.setAttribute('aria-label', text.title || '');
        textarea.placeholder = text.placeholder || '';
        textareaLabel.textContent = text.placeholder || text.title || '';
        sendButton.textContent = text.send || '';
        empty.textContent = text.empty || '';
        leftButton.title = text.dockLeft || '';
        detachedButton.title = text.detached || '';
        rightButton.title = text.dockRight || '';
        closeButton.title = text.close || '';
        leftButton.setAttribute('aria-label', text.dockLeft || '');
        detachedButton.setAttribute('aria-label', text.detached || '');
        rightButton.setAttribute('aria-label', text.dockRight || '');
        closeButton.setAttribute('aria-label', text.close || '');
        quickReactions.setAttribute('aria-label', text.quickReactions || text.title || '');
        for (const button of reactionButtons) {
            const label = `${text.quickReactions || text.title || ''} ${button.dataset.reaction}`.trim();
            button.title = label;
            button.setAttribute('aria-label', label);
        }
        applyUnreadCount();
    }

    function applyTheme() {
        const light = themeMode === 'light' || (themeMode === 'system' && systemTheme.matches);
        app.dataset.theme = light ? 'light' : 'dark';
        app.dataset.palette = ['eucalyptus', 'cyber', 'graphite'].includes(themePalette) ? themePalette : 'eucalyptus';
    }

    function viewportBounds() {
        return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };
    }

    function normalizePosition(value) {
        return ['left', 'right', 'detached'].includes(value) ? value : 'right';
    }

    function normalizeSize(value) {
        return ['compact', 'standard', 'large', 'custom'].includes(value) ? value : 'standard';
    }

    function preferredSize() {
        return SIZE_PRESETS[chatSize] || {
            width: Number(layout.customWidth) || DEFAULT_WIDTH,
            height: Number(layout.customHeight) || DEFAULT_HEIGHT
        };
    }

    function clampLauncher() {
        const viewport = viewportBounds();
        const maxX = Math.max(0, viewport.width - LAUNCHER_SIZE - EDGE_INSET);
        const maxY = Math.max(0, viewport.height - LAUNCHER_SIZE - EDGE_INSET);
        layout.launcherX = Math.min(Math.max(Number(layout.launcherX) || EDGE_INSET, EDGE_INSET), maxX);
        layout.launcherY = Math.min(Math.max(Number(layout.launcherY) || EDGE_INSET, EDGE_INSET), maxY);
    }

    function initializeLauncher() {
        if (layout.launcherInitialized) return;
        const viewport = viewportBounds();
        layout.launcherX = chatPosition === 'left'
            ? Math.min(16, Math.max(EDGE_INSET, viewport.width - LAUNCHER_SIZE - EDGE_INSET))
            : Math.max(EDGE_INSET, viewport.width - LAUNCHER_SIZE - 16);
        layout.launcherY = Math.max(EDGE_INSET, Math.round(viewport.height / 2 - LAUNCHER_SIZE / 2));
        layout.launcherInitialized = true;
        clampLauncher();
    }

    function clearPageDock() {
        const targets = new Set([pageDockTarget, document.documentElement].filter(Boolean));
        for (const target of targets) {
            target.removeAttribute(PAGE_DOCK_ATTRIBUTE);
            target.style.removeProperty(PAGE_DOCK_WIDTH);
        }
        pageDockTarget = null;
    }

    function applyPageDock(side, width) {
        if (!opened) {
            clearPageDock();
            return;
        }
        const target = document.fullscreenElement || document.documentElement;
        if (pageDockTarget && pageDockTarget !== target) clearPageDock();
        pageDockTarget = target;
        target.setAttribute(PAGE_DOCK_ATTRIBUTE, side);
        target.style.setProperty(PAGE_DOCK_WIDTH, `${width}px`);
    }

    function applyUnreadCount() {
        unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        unreadBadge.classList.toggle('visible', unreadCount > 0);
        const openLabel = strings().open || '';
        launcher.setAttribute('aria-label', unreadCount > 0 ? `${openLabel} (${unreadCount})` : openLabel);
    }

    function setUnreadCount(next) {
        unreadCount = Math.max(0, Number.isFinite(next) ? Math.trunc(next) : 0);
        applyUnreadCount();
    }

    function clampDetached() {
        const viewport = viewportBounds();
        const maxWidth = Math.max(1, Math.min(600, viewport.width - 16));
        const maxHeight = Math.max(1, viewport.height - 16);
        const horizontalInset = Math.min(8, Math.max(0, Math.floor((viewport.width - 1) / 2)));
        const verticalInset = Math.min(8, Math.max(0, Math.floor((viewport.height - 1) / 2)));
        layout.width = Math.min(Math.max(Number(layout.width) || DEFAULT_WIDTH, Math.min(MIN_WIDTH, maxWidth)), maxWidth);
        layout.height = Math.min(Math.max(Number(layout.height) || DEFAULT_HEIGHT, Math.min(MIN_HEIGHT, maxHeight)), maxHeight);
        layout.x = Math.min(Math.max(Number(layout.x) || horizontalInset, horizontalInset), Math.max(horizontalInset, viewport.width - layout.width - horizontalInset));
        layout.y = Math.min(Math.max(Number(layout.y) || verticalInset, verticalInset), Math.max(verticalInset, viewport.height - layout.height - verticalInset));
    }

    function saveLayout() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            setLocalStorage({ [storageKey]: layout });
        }, 150);
    }

    function applyLayout() {
        if (destroyed) return;
        applyingLayout = true;
        const size = preferredSize();
        launcher.classList.toggle('docked-left', layout.mode === 'left');
        launcher.classList.toggle('docked-right', layout.mode === 'right');
        if (layout.mode === 'detached') {
            initializeLauncher();
            clampLauncher();
            launcher.style.left = `${layout.launcherX}px`;
            launcher.style.right = 'auto';
            launcher.style.top = `${layout.launcherY}px`;
        } else {
            launcher.style.left = layout.mode === 'left' ? '0' : 'auto';
            launcher.style.right = layout.mode === 'right' ? '0' : 'auto';
            launcher.style.top = `${Math.max(0, Math.round(window.innerHeight / 2 - LAUNCHER_SIZE / 2))}px`;
        }
        panel.style.right = 'auto';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.resize = 'none';
        panel.classList.toggle('docked', layout.mode !== 'detached');
        header.classList.toggle('detached', layout.mode === 'detached');
        leftButton.classList.toggle('active', layout.mode === 'left');
        detachedButton.classList.toggle('active', layout.mode === 'detached');
        rightButton.classList.toggle('active', layout.mode === 'right');
        if (layout.mode === 'detached') {
            clearPageDock();
            clampDetached();
            panel.style.left = `${layout.x}px`;
            panel.style.top = `${layout.y}px`;
            panel.style.width = `${layout.width}px`;
            panel.style.height = `${layout.height}px`;
            panel.style.resize = 'both';
        } else {
            const viewport = viewportBounds();
            const dockWidth = Math.max(1, Math.min(size.width, viewport.width - 16));
            panel.style.top = '0';
            panel.style.bottom = '0';
            panel.style.width = `${dockWidth}px`;
            panel.style.height = `${viewport.height}px`;
            panel.style[layout.mode] = '0';
            applyPageDock(layout.mode, dockWidth);
        }
        globalThis.queueMicrotask(() => { applyingLayout = false; });
    }

    function setMode(mode, persistPreference = true) {
        mode = normalizePosition(mode);
        if (mode === 'detached' && !layout.detachedInitialized) {
            const size = preferredSize();
            layout.x = Math.max(8, Math.round((window.innerWidth - size.width) / 2));
            layout.y = Math.max(8, Math.round((window.innerHeight - size.height) / 2));
            layout.detachedInitialized = true;
        }
        chatPosition = mode;
        layout.mode = mode;
        applyLayout();
        saveLayout();
        if (persistPreference) setLocalStorage({ chatPosition: mode });
    }

    function setSize(size, persistPreference = true) {
        chatSize = normalizeSize(size);
        const preset = SIZE_PRESETS[chatSize];
        if (preset) {
            layout.width = preset.width;
            layout.height = preset.height;
        } else {
            layout.width = Number(layout.customWidth) || DEFAULT_WIDTH;
            layout.height = Number(layout.customHeight) || DEFAULT_HEIGHT;
        }
        if (layout.mode === 'detached') clampDetached();
        applyLayout();
        saveLayout();
        if (persistPreference) setLocalStorage({ chatSize });
    }

    function setOpened(next) {
        opened = !!next && !!context?.enabled;
        panel.classList.toggle('open', opened);
        launcher.style.display = opened ? 'none' : '';
        if (opened) {
            setUnreadCount(0);
            textarea.focus();
            messages.scrollTop = messages.scrollHeight;
        }
        applyLayout();
    }

    function applyContext(next) {
        const previousRoomId = context?.roomId;
        context = next || null;
        const supported = !!context?.supported;
        const optedIn = !!context?.enabled;
        const hasKey = !!context?.hasKey;
        const connected = !!context?.connected;
        context = context ? { ...context, enabled: supported && optedIn && hasKey && connected } : null;
        if (previousRoomId && previousRoomId !== context?.roomId) {
            clearMessages();
            startStateApplied = false;
        }
        host.style.display = supported && optedIn ? '' : 'none';
        launcher.setAttribute('aria-disabled', String(!context?.enabled));
        if (!optedIn) startStateApplied = false;
        if (!context?.enabled) {
            setOpened(false);
        } else if (preferencesLoaded && !startStateApplied) {
            startStateApplied = true;
            setOpened(chatStartMode === 'open');
        }
        applyStrings();
        applyLayout();
        if (context?.enabled && Array.isArray(context.activity)) {
            for (const event of context.activity) appendEvent(event);
        }
    }

    async function refresh() {
        if (destroyed) return;
        const generation = ++refreshGeneration;
        const next = await messageRuntime({ type: 'GET_CHAT_CONTEXT' });
        if (destroyed || generation !== refreshGeneration) return;
        applyContext(next);
    }

    function appendMessage(message) {
        if (!context?.enabled || !message || typeof message.text !== 'string') return;
        if (empty.isConnected) empty.remove();
        const wrapper = element('article', 'message');
        const meta = element('div', 'meta');
        const own = message.senderId === context.peerId;
        if (!opened && !own) setUnreadCount(unreadCount + 1);
        const sender = element('span', 'sender', own ? (strings().you || '') : (message.username || message.senderId || ''));
        const time = element('time', 'time');
        const date = new Date(message.timestamp);
        time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        meta.append(sender, time);
        const body = element('div', 'body');
        const tokens = globalThis.KoalaSyncChatFormat?.tokenizeChatText(message.text) || [{ type: 'text', text: message.text }];
        for (const token of tokens) {
            const node = token.type === 'strong' ? document.createElement('strong') : token.type === 'em' ? document.createElement('em') : document.createTextNode(token.text);
            if (node.nodeType === 1) node.textContent = token.text;
            body.append(node);
        }
        wrapper.append(meta, body);
        messages.append(wrapper);
        while (messages.querySelectorAll('.message').length > MAX_MESSAGES) messages.querySelector('.message')?.remove();
        messages.scrollTop = messages.scrollHeight;
        if (QUICK_REACTIONS.includes(message.text.trim())) triggerReactionRain(message.text.trim());
    }

    function appendEvent(event) {
        if (!context?.enabled || !event || typeof event.action !== 'string') return;
        if (typeof event.id === 'string' && renderedActivityIds.has(event.id)) return;
        const own = event.senderId === context.peerId;
        const displayName = own ? (strings().you || '') : (event.username || event.senderId || '');
        const labels = {
            play: strings().eventPlay,
            pause: strings().eventPause,
            seek: strings().eventSeek,
            force_sync_prepare: strings().eventForcePrepare,
            force_sync_execute: strings().eventForceExecute
        };
        let eventText = '';
        if (event.action === 'joined' || event.action === 'left') {
            const template = event.action === 'joined' ? strings().eventJoined : strings().eventLeft;
            eventText = (template || '{name}').replace('{name}', displayName);
        } else if (labels[event.action]) {
            eventText = (strings().eventAction || '{name} {action}')
                .replace('{name}', displayName)
                .replace('{action}', labels[event.action]);
        }
        if (!eventText) return;
        if (typeof event.id === 'string') {
            renderedActivityIds.add(event.id);
            renderedActivityIdOrder.push(event.id);
            while (renderedActivityIdOrder.length > MAX_RENDERED_ACTIVITY_IDS) {
                renderedActivityIds.delete(renderedActivityIdOrder.shift());
            }
        }

        if (empty.isConnected) empty.remove();
        const wrapper = element('article', 'message event-message');
        const body = element('span', 'event-text', eventText);
        const time = element('time', 'time');
        const date = new Date(event.timestamp);
        time.textContent = Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        wrapper.append(body, time);
        messages.append(wrapper);
        while (messages.querySelectorAll('.message').length > MAX_MESSAGES) messages.querySelector('.message')?.remove();
        messages.scrollTop = messages.scrollHeight;
    }

    function clearMessages() {
        messages.replaceChildren(empty);
        renderedActivityIds.clear();
        renderedActivityIdOrder.length = 0;
        setUnreadCount(0);
    }

    function triggerReactionRain(reaction) {
        if (chatReactionDisplay !== 'video' || reducedMotion.matches || !QUICK_REACTIONS.includes(reaction)) return;
        const available = Math.max(0, MAX_REACTION_PARTICLES - reactionLayer.childElementCount);
        const particleCount = Math.min(10, available);
        for (let index = 0; index < particleCount; index++) {
            const particle = element('span', 'reaction-particle', reaction);
            particle.style.left = `${4 + Math.random() * 88}%`;
            particle.style.setProperty('--reaction-duration', `${2.8 + Math.random() * 1.6}s`);
            particle.style.setProperty('--reaction-delay', `${Math.random() * .7}s`);
            particle.style.setProperty('--reaction-drift', `${-45 + Math.random() * 90}px`);
            particle.style.setProperty('--reaction-start-rotation', `${-35 + Math.random() * 70}deg`);
            particle.style.setProperty('--reaction-end-rotation', `${-160 + Math.random() * 320}deg`);
            particle.addEventListener('animationend', () => particle.remove(), { once: true });
            reactionLayer.append(particle);
        }
    }

    function updateComposerState() {
        const length = [...textarea.value].length;
        count.textContent = `${length}/${MAX_COMPOSER_CODE_POINTS}`;
        count.style.color = length > MAX_COMPOSER_CODE_POINTS ? 'var(--danger)' : '';
        status.textContent = length > MAX_COMPOSER_CODE_POINTS ? (strings().tooLong || '') : '';
        return length;
    }

    function resetComposer() {
        sendGeneration++;
        sending = false;
        textarea.value = '';
        updateComposerState();
        status.textContent = '';
        sendButton.disabled = false;
        for (const button of reactionButtons) button.disabled = false;
    }

    let launcherDrag = null;
    let suppressLauncherClick = false;
    launcher.addEventListener('click', event => {
        if (suppressLauncherClick && event.detail !== 0) {
            suppressLauncherClick = false;
            return;
        }
        suppressLauncherClick = false;
        setOpened(true);
    });
    launcher.addEventListener('pointerdown', event => {
        if (layout.mode !== 'detached') return;
        launcherDrag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            x: layout.launcherX,
            y: layout.launcherY,
            moved: false
        };
        launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', event => {
        if (!launcherDrag || event.pointerId !== launcherDrag.pointerId) return;
        const deltaX = event.clientX - launcherDrag.startX;
        const deltaY = event.clientY - launcherDrag.startY;
        if (Math.hypot(deltaX, deltaY) >= 4) launcherDrag.moved = true;
        layout.launcherX = launcherDrag.x + deltaX;
        layout.launcherY = launcherDrag.y + deltaY;
        clampLauncher();
        launcher.style.left = `${layout.launcherX}px`;
        launcher.style.top = `${layout.launcherY}px`;
    });
    launcher.addEventListener('pointerup', event => {
        if (!launcherDrag || event.pointerId !== launcherDrag.pointerId) return;
        suppressLauncherClick = launcherDrag.moved;
        launcherDrag = null;
        saveLayout();
    });
    launcher.addEventListener('pointercancel', () => {
        launcherDrag = null;
        suppressLauncherClick = false;
    });
    closeButton.addEventListener('click', () => setOpened(false));
    leftButton.addEventListener('click', () => setMode('left'));
    detachedButton.addEventListener('click', () => setMode('detached'));
    rightButton.addEventListener('click', () => setMode('right'));

    textarea.addEventListener('input', updateComposerState);
    const stopPageKeyboardShortcut = event => {
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (!path.includes(textarea) && !path.includes(composer)) return;
        if (event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!sending) composer.requestSubmit();
        }
        event.stopImmediatePropagation();
    };
    for (const eventName of ['keydown', 'keyup', 'keypress']) {
        window.addEventListener(eventName, stopPageKeyboardShortcut, true);
    }
    async function sendChatText(text, clearComposerValue = false) {
        if (sending || !context?.enabled) return;
        text = String(text || '').trim();
        if (!text) return;
        if ([...text].length > MAX_COMPOSER_CODE_POINTS) {
            status.textContent = strings().tooLong || '';
            return;
        }
        let chunks;
        try {
            chunks = globalThis.KoalaSyncChatFormat?.splitChatText(
                text,
                MAX_MESSAGE_CODE_POINTS,
                MAX_CHAT_CHUNKS
            );
        } catch (_) {
            status.textContent = strings().tooLong || '';
            return;
        }
        if (!Array.isArray(chunks) || chunks.length === 0) return;
        const generation = ++sendGeneration;
        sending = true;
        sendButton.disabled = true;
        for (const button of reactionButtons) button.disabled = true;
        status.textContent = '';
        let completedChunks = 0;
        let response = null;
        for (const chunk of chunks) {
            response = await messageRuntime({ type: 'CHAT_SEND', text: chunk });
            if (destroyed || generation !== sendGeneration) return;
            if (response?.status !== 'ok') break;
            completedChunks++;
        }
        sending = false;
        sendButton.disabled = false;
        for (const button of reactionButtons) button.disabled = false;
        if (completedChunks === chunks.length) {
            if (clearComposerValue && textarea.value.trim() === text) {
                textarea.value = '';
                updateComposerState();
            }
        } else {
            if (clearComposerValue && textarea.value.trim() === text) {
                textarea.value = chunks.slice(completedChunks).join('\n');
                updateComposerState();
            }
            status.textContent = response?.status === 'too_long' ? (strings().tooLong || '') : (strings().sendFailed || '');
        }
    }
    composer.addEventListener('submit', async event => {
        event.preventDefault();
        await sendChatText(textarea.value, true);
    });
    for (const button of reactionButtons) {
        button.addEventListener('click', () => sendChatText(button.dataset.reaction));
    }

    let drag = null;
    header.addEventListener('pointerdown', event => {
        if (layout.mode !== 'detached' || event.target.closest('button')) return;
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: layout.x, y: layout.y };
        header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        layout.x = drag.x + event.clientX - drag.startX;
        layout.y = drag.y + event.clientY - drag.startY;
        clampDetached();
        applyLayout();
    });
    header.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag = null;
        saveLayout();
    });

    const resizeObserver = new globalThis.ResizeObserver(() => {
        if (applyingLayout || layout.mode !== 'detached') return;
        const rect = panel.getBoundingClientRect();
        if (!opened || !rect?.width || !rect.height) return;
        if (Math.abs(rect.width - layout.width) < 1 && Math.abs(rect.height - layout.height) < 1) return;
        layout.width = rect.width;
        layout.height = rect.height;
        layout.customWidth = rect.width;
        layout.customHeight = rect.height;
        if (chatSize !== 'custom') {
            chatSize = 'custom';
            setLocalStorage({ chatSize });
        }
        clampDetached();
        saveLayout();
    });
    resizeObserver.observe(panel);

    function moveIntoFullscreen() {
        const parent = document.fullscreenElement || document.documentElement;
        if (parent && host.parentNode !== parent) parent.append(host);
        globalThis.requestAnimationFrame(applyLayout);
    }

    function handleResize() {
        clampLauncher();
        applyLayout();
        saveLayout();
        if (layout.mode === 'detached') {
            clampDetached();
        }
    }

    function handleSystemTheme() {
        if (themeMode === 'system') applyTheme();
    }

    function handleStorage(changes, area) {
        if (destroyed || area !== 'local') return;
        if (changes.themeMode) themeMode = changes.themeMode.newValue || 'system';
        if (changes.themePalette) themePalette = changes.themePalette.newValue || 'eucalyptus';
        if (changes.themeMode || changes.themePalette) applyTheme();
        if (changes.chatPosition) setMode(changes.chatPosition.newValue, false);
        if (changes.chatSize) setSize(changes.chatSize.newValue, false);
        if (changes.chatStartMode) {
            chatStartMode = changes.chatStartMode.newValue === 'open' ? 'open' : 'bubble';
            if (context?.enabled) {
                startStateApplied = true;
                setOpened(chatStartMode === 'open');
            }
        }
        if (changes.chatReactionDisplay) {
            chatReactionDisplay = changes.chatReactionDisplay.newValue === 'video' ? 'video' : 'chat';
        }
        if (changes.locale) refresh();
    }

    function handleRuntime(message) {
        if (message?.type === 'CHAT_MESSAGE') appendMessage(message.message);
        if (message?.type === 'CHAT_EVENT') appendEvent(message.event);
        if (message?.type === 'CHAT_CONTEXT_UPDATE' || message?.type === 'CONNECTION_STATUS') refresh();
        if (message?.type === 'CHAT_RESET') {
            clearMessages();
            resetComposer();
            refresh();
        }
        if (message?.type === 'CHAT_DESTROY' || message?.type === 'TARGET_DEACTIVATE') destroy();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        refreshGeneration++;
        sendGeneration++;
        if (saveTimer) clearTimeout(saveTimer);
        resizeObserver.disconnect();
        clearPageDock();
        pageDockStyle.remove();
        for (const eventName of ['keydown', 'keyup', 'keypress']) {
            window.removeEventListener(eventName, stopPageKeyboardShortcut, true);
        }
        document.removeEventListener('fullscreenchange', moveIntoFullscreen);
        window.removeEventListener('resize', handleResize);
        systemTheme.removeEventListener('change', handleSystemTheme);
        try { chrome.storage.onChanged.removeListener(handleStorage); } catch (_) { /* invalidated context */ }
        try { chrome.runtime.onMessage.removeListener(handleRuntime); } catch (_) { /* invalidated context */ }
        host.remove();
        window.koalaSyncChatOverlay = null;
    }

    document.addEventListener('fullscreenchange', moveIntoFullscreen);
    window.addEventListener('resize', handleResize, { passive: true });
    systemTheme.addEventListener('change', handleSystemTheme);
    chrome.storage.onChanged.addListener(handleStorage);
    chrome.runtime.onMessage.addListener(handleRuntime);
    chrome.storage.local.get([storageKey, 'themeMode', 'themePalette', 'chatPosition', 'chatSize', 'chatStartMode', 'chatReactionDisplay'], data => {
        if (destroyed) return;
        const storedLayout = data[storageKey];
        if (storedLayout && typeof storedLayout === 'object') {
            layout = { ...layout, ...storedLayout };
            layout.customWidth = Number(storedLayout.customWidth) || Number(storedLayout.width) || DEFAULT_WIDTH;
            layout.customHeight = Number(storedLayout.customHeight) || Number(storedLayout.height) || DEFAULT_HEIGHT;
        }
        chatPosition = normalizePosition(data.chatPosition);
        chatSize = normalizeSize(data.chatSize);
        chatStartMode = data.chatStartMode === 'open' ? 'open' : 'bubble';
        chatReactionDisplay = data.chatReactionDisplay === 'video' ? 'video' : 'chat';
        layout.mode = chatPosition;
        if (layout.mode === 'detached') layout.detachedInitialized = true;
        const preset = SIZE_PRESETS[chatSize];
        if (preset) {
            layout.width = preset.width;
            layout.height = preset.height;
        }
        themeMode = data.themeMode || 'system';
        themePalette = data.themePalette || 'eucalyptus';
        preferencesLoaded = true;
        applyTheme();
        applyLayout();
        refresh();
    });

    window.koalaSyncChatOverlay = { refresh, destroy };
})();
