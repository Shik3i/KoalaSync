import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const overlaySource = fs.readFileSync(path.join(extensionDir, 'chat-overlay.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
const manifestSource = fs.readFileSync(path.join(extensionDir, 'manifest.base.json'), 'utf8');
const buildSource = fs.readFileSync(path.join(extensionDir, '..', 'scripts', 'build-extension.cjs'), 'utf8');
const localeDir = path.join(extensionDir, 'locales');
const chatKeys = [
    'LABEL_CHAT_ENABLED',
    'LABEL_CHAT_ENABLED_TOOLTIP',
    'CHAT_TITLE',
    'CHAT_LIVE_ONLY',
    'CHAT_OPEN',
    'CHAT_CLOSE',
    'CHAT_DOCK_LEFT',
    'CHAT_DOCK_RIGHT',
    'CHAT_DETACHED',
    'CHAT_PLACEHOLDER',
    'CHAT_SEND',
    'CHAT_MISSING_KEY',
    'CHAT_TOO_LONG',
    'CHAT_SEND_FAILED',
    'CHAT_EMPTY',
    'LABEL_CHAT_REACTION_DISPLAY',
    'LABEL_CHAT_REACTION_DISPLAY_TOOLTIP',
    'OPTION_CHAT_REACTIONS_CHAT',
    'OPTION_CHAT_REACTIONS_VIDEO',
    'CHAT_QUICK_REACTIONS'
];

describe('chat overlay contract', () => {
    it('skips SVG and other non-HTML documents before creating the overlay host', () => {
        const documentGuard = "document.documentElement?.namespaceURI !== 'http://www.w3.org/1999/xhtml'";
        expect(overlaySource).toContain(documentGuard);
        expect(overlaySource.indexOf(documentGuard)).toBeLessThan(overlaySource.indexOf("document.createElement('div')"));
        expect(() => vm.runInNewContext(overlaySource, {
            document: { documentElement: { namespaceURI: 'http://www.w3.org/2000/svg' } }
        })).not.toThrow();
    });

    it('isolates the overlay and never renders markup as HTML', () => {
        expect(overlaySource).toContain("attachShadow({ mode: 'open' })");
        expect(overlaySource).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=/);
        expect(overlaySource).toContain('document.createTextNode(token.text)');
    });

    it('injects formatting and overlay code only with the selected-tab content script', () => {
        expect(backgroundSource).toContain("files: ['chat-format.js', 'chat-overlay.js', 'content.js']");
        expect(overlaySource).toContain("const storageKey = `chatOverlayLayout:${location.origin}`");
        expect(overlaySource).toContain('document.fullscreenElement || document.documentElement');
    });

    it('supports all layout and theme combinations with bounded message DOM', () => {
        expect(overlaySource).toContain("['left', 'right', 'detached']");
        expect(overlaySource).toContain('!layout.detachedInitialized');
        expect(overlaySource).toContain('const rect = panel.getBoundingClientRect()');
        expect(overlaySource).not.toContain('contentRect');
        expect(overlaySource).toContain("#app[data-palette=\"cyber\"][data-theme=\"light\"]");
        expect(overlaySource).toContain("#app[data-palette=\"graphite\"][data-theme=\"light\"]");
        expect(overlaySource).toContain('const MAX_MESSAGES = 200');
        expect(overlaySource).toContain('while (messages.querySelectorAll(\'.message\').length > MAX_MESSAGES)');
        expect(overlaySource).toContain('Math.max(1, window.innerWidth)');
        expect(overlaySource).toContain('min(${MIN_WIDTH}px, calc(100vw - 16px))');
    });

    it('blocks page playback shortcuts while the chat composer owns keyboard input', () => {
        expect(overlaySource).toContain("for (const eventName of ['keydown', 'keyup', 'keypress'])");
        expect(overlaySource).toContain('window.addEventListener(eventName, stopPageKeyboardShortcut, true)');
        expect(overlaySource).toContain('path.includes(textarea)');
        expect(overlaySource).toContain('event.stopImmediatePropagation()');
        expect(overlaySource).toContain('window.removeEventListener(eventName, stopPageKeyboardShortcut, true)');
    });

    it('keeps the launcher draggable only in detached mode and anchors dock launchers', () => {
        expect(overlaySource).toContain("launcher.addEventListener('pointerdown'");
        expect(overlaySource).toMatch(/launcher\.addEventListener\('pointerdown'[\s\S]*layout\.mode !== 'detached'/);
        expect(overlaySource).toContain("launcher.addEventListener('pointermove'");
        expect(overlaySource).toContain('layout.launcherX = launcherDrag.x + deltaX');
        expect(overlaySource).toContain('layout.launcherY = launcherDrag.y + deltaY');
        expect(overlaySource).toContain('suppressLauncherClick = launcherDrag.moved');
        expect(overlaySource).toContain("launcher.classList.toggle('docked-left'");
        expect(overlaySource).toContain("launcher.classList.toggle('docked-right'");
    });

    it('reserves page space for real left and right dock modes', () => {
        expect(overlaySource).toContain("const PAGE_DOCK_ATTRIBUTE = 'data-koalasync-chat-dock'");
        expect(overlaySource).toContain('width: calc(100% - var(${PAGE_DOCK_WIDTH})) !important');
        expect(overlaySource).toContain('margin-left: var(${PAGE_DOCK_WIDTH}) !important');
        expect(overlaySource).toContain('margin-right: var(${PAGE_DOCK_WIDTH}) !important');
        expect(overlaySource).toContain('html[${PAGE_DOCK_ATTRIBUTE}] > body');
        expect(overlaySource).toContain('clip-path: inset(0) !important');
        expect(overlaySource).toContain('contain: layout paint !important');
        expect(overlaySource).toContain('> :not(#koalasync-chat-overlay-host)');
        expect(overlaySource).toContain('const target = document.fullscreenElement || document.documentElement');
        expect(overlaySource).toContain('pageDockTarget = target');
        expect(overlaySource).not.toContain('DOCK_MIN_PAGE_WIDTH');
        expect(overlaySource).toContain('applyPageDock(layout.mode, dockWidth)');
        expect(overlaySource).toContain('clearPageDock()');
    });

    it('counts unread remote messages on the bubble and clears the badge when opened', () => {
        expect(overlaySource).toContain("const unreadBadge = element('span', 'unread')");
        expect(overlaySource).toContain('if (!opened && !own) setUnreadCount(unreadCount + 1)');
        expect(overlaySource).toMatch(/if \(opened\) \{\s*setUnreadCount\(0\)/);
        expect(overlaySource).toContain("unreadBadge.classList.toggle('visible', unreadCount > 0)");
        expect(backgroundSource).toMatch(/received\.senderId !== peerId[\s\S]*showChatNotification\([\s\S]*senderPeer\.username[\s\S]*received\.senderId/);
        expect(backgroundSource).toContain("chrome.notifications.create(`chat_${Date.now()}`");
        expect(backgroundSource).toContain('getTabForNotification(targetTabId)');
        expect(backgroundSource).toContain('getWindowForNotification(tab.windowId)');
        expect(backgroundSource).toContain('shouldShowChatNotification({ enabled, targetTabId, tab, windowInfo })');
    });

    it('renders timestamped room activity without incrementing the unread message badge', () => {
        expect(overlaySource).toContain("if (message?.type === 'CHAT_EVENT') appendEvent(message.event)");
        expect(overlaySource).toContain("const time = element('time', 'time')");
        expect(overlaySource).toContain("date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })");
        const appendEventBlock = overlaySource.slice(
            overlaySource.indexOf('function appendEvent(event)'),
            overlaySource.indexOf('function clearMessages()')
        );
        expect(appendEventBlock).toContain("const wrapper = element('article', 'message event-message')");
        expect(appendEventBlock).not.toContain('setUnreadCount');
        expect(overlaySource).not.toContain('eventNotifications');
        expect(backgroundSource).not.toContain('eventNotifications');
        expect(backgroundSource).toContain("sendChatActivity(message.action, peerId, timestamp)");
        expect(backgroundSource).toContain("sendChatActivity(event, data.senderId, data.actionTimestamp)");
        expect(backgroundSource).toContain("sendChatActivity('joined', data.peerId, Date.now())");
        expect(backgroundSource).toContain("sendChatActivity('left', data.peerId, Date.now())");
        expect(backgroundSource).toContain('activity: chatActivityStore.snapshot()');
        expect(overlaySource).toContain('renderedActivityIds.has(event.id)');
        expect(overlaySource).toContain('const MAX_RENDERED_ACTIVITY_IDS = 200');
        expect(overlaySource).toContain('while (renderedActivityIdOrder.length > MAX_RENDERED_ACTIVITY_IDS)');
        expect(overlaySource).toContain('renderedActivityIds.delete(renderedActivityIdOrder.shift())');
    });

    it('uses the KoalaSync icon and offers bounded encrypted quick reactions', () => {
        expect(overlaySource).toContain("const LAUNCHER_ICON_DATA_URL = 'data:image/png;base64,");
        expect(overlaySource).toContain('launcherIcon.src = LAUNCHER_ICON_DATA_URL');
        expect(manifestSource).not.toContain('web_accessible_resources');
        expect(overlaySource).toContain("const QUICK_REACTIONS = Object.freeze(['❤️', '😂', '😮', '😢', '👏', '🔥'])");
        expect(overlaySource).toContain("messageRuntime({ type: 'CHAT_SEND', text: chunk })");
        expect(overlaySource).toContain("chatReactionDisplay !== 'video'");
        expect(overlaySource).toContain('MAX_REACTION_PARTICLES - reactionLayer.childElementCount');
        expect(overlaySource).toContain('reducedMotion.matches');
    });

    it('splits a 5000-codepoint composer value into at most ten acknowledged chat-v1 messages', () => {
        expect(overlaySource).toContain('const MAX_MESSAGE_CODE_POINTS = 500');
        expect(overlaySource).toContain('const MAX_CHAT_CHUNKS = 10');
        expect(overlaySource).toContain('MAX_MESSAGE_CODE_POINTS * MAX_CHAT_CHUNKS');
        expect(overlaySource).toContain('KoalaSyncChatFormat?.splitChatText(');
        expect(overlaySource).toMatch(/for \(const chunk of chunks\)[\s\S]*messageRuntime\(\{ type: 'CHAT_SEND', text: chunk \}\)/);
        expect(overlaySource).toContain("textarea.value = chunks.slice(completedChunks).join('\\n')");
        expect(backgroundSource).toContain('const echoPromise = chatEchoTracker.waitFor(ciphertext)');
        expect(backgroundSource).toContain('chatEchoTracker.acknowledge(received.ciphertext)');
        expect(backgroundSource).toContain("status: acknowledged ? 'ok' : 'unconfirmed'");
    });

    it('excludes test-only modules from production extension artifacts', () => {
        expect(buildSource).toContain("/\\.test\\.[cm]?js$/u.test(item)");
    });

    it('guards async refresh/send work and clears all composer state on room reset', () => {
        expect(overlaySource).toContain('generation !== refreshGeneration');
        expect(overlaySource).toContain('if (sending || !context?.enabled) return');
        expect(overlaySource).toContain("clearComposerValue && textarea.value.trim() === text");
        expect(overlaySource).toMatch(/CHAT_RESET[\s\S]*resetComposer\(\)/);
        expect(overlaySource).toContain('setTimeout(() => finish(null), timeoutMs)');
        expect(backgroundSource).toContain('chatReceiveQueue = chatReceiveQueue.catch(() => {}).then');
        expect(backgroundSource).toContain("status: 'rate_limited'");
        expect(overlaySource).toContain('function setLocalStorage(values)');
        expect(overlaySource).toMatch(/chrome\.storage\.local\.get\([\s\S]*data => \{\s*if \(destroyed\) return;/);
        expect(overlaySource).toContain("if (destroyed || area !== 'local') return");
    });

    it('keeps chat hidden by default without discarding the room chat key', () => {
        expect(popupSource).toContain('localData.chatEnabled === true');
        expect(backgroundSource).toContain('chatEnabled: data.chatEnabled === true');
        expect(backgroundSource).toContain('clientCapabilities: CLIENT_CAPABILITIES');
        expect(overlaySource).toContain('all:initial;display:none;position:fixed');
        expect(overlaySource).toContain("host.style.display = supported && optedIn ? '' : 'none'");
        expect(overlaySource).toContain('supported && optedIn && hasKey && connected');
        expect(popupSource).toContain("chrome.storage.local.set({ chatEnabled: elements.chatEnabled.checked })");
        expect(popupSource).toMatch(/if \(isCreating\) \{[\s\S]*?type: 'CREATE_CHAT_KEY'[\s\S]*?chatKey = normalizeChatKey/);
        expect(popupSource).not.toMatch(/chatEnabled[\s\S]{0,120}chatKey:\s*''/);
    });

    it('keeps unavailable chat controls discoverable to assistive technology', () => {
        expect(overlaySource).toContain("launcher.setAttribute('aria-disabled'");
        expect(overlaySource).not.toContain('launcher.disabled =');
        expect(overlaySource).toContain("launcher.setAttribute('aria-describedby', launcherHint.id)");
        expect(overlaySource).toContain("textarea.setAttribute('aria-describedby', 'chat-composer-count chat-composer-status')");
        expect(overlaySource).toContain("status.setAttribute('role', 'status')");
    });

    it('creates a chat key for both generated-room entry points', () => {
        expect(popupSource).toContain('let pendingRoomCreation = false');
        expect(popupSource).toContain('const isCreating = pendingRoomCreation || !roomIdInput');
        expect(popupSource).toMatch(/function handleCreateRoom\(\)[\s\S]*pendingRoomCreation = true[\s\S]*elements\.joinBtn\.click\(\)/);
        expect(popupSource).toContain("type: 'CREATE_CHAT_KEY'");
    });

    it('contains every chat string in all 15 extension locales', () => {
        const localeFiles = fs.readdirSync(localeDir).filter(file => file.endsWith('.json')).sort();
        expect(localeFiles).toHaveLength(15);
        for (const file of localeFiles) {
            const messages = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
            for (const key of chatKeys) {
                expect(messages[key], `${file}: ${key}`).toBeTypeOf('string');
                expect(messages[key], `${file}: ${key}`).not.toBe('');
                expect(messages[key], `${file}: ${key}`).not.toMatch(/[—–]/);
            }
        }
    });
});
