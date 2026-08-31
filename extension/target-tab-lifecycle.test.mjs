import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
const overlaySource = fs.readFileSync(path.join(extensionDir, 'chat-overlay.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
const monitorSource = fs.readFileSync(path.join(extensionDir, 'media-frame-monitor.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.base.json'), 'utf8'));
const sharedConstantsSource = fs.readFileSync(path.join(extensionDir, '..', 'shared', 'constants.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(extensionDir, '..', 'server', 'index.js'), 'utf8');

describe('target tab lifecycle', () => {
    it('injects playback and chat scripts only into the explicitly selected tab', () => {
        expect(backgroundSource).not.toContain('chrome.tabs.onActivated');
        expect(backgroundSource).not.toContain('chrome.tabs.query({})');
        expect(backgroundSource).toMatch(/contentTarget = await resolveMediaContentTarget\(chrome, tabId, \{\s*knownFrameIds/);
        // Frame ids must come from observed senders, never from a navigation permission.
        expect(backgroundSource).toContain('function rememberFrameId(tabId, frameId)');
        expect(backgroundSource).toContain('rememberFrameId(senderTabId, sender?.frameId)');
        expect(backgroundSource).toContain('target: scriptTarget');
        expect(backgroundSource).toContain("files: ['chat-format.js', 'chat-overlay.js', 'content.js']");
        expect(backgroundSource).toContain("chrome.tabs.query({ url: 'https://sync.koalastuff.net/*' })");

        const activationStart = backgroundSource.indexOf('async function activateTargetTab');
        const activationEnd = backgroundSource.indexOf('async function reactivateCurrentTarget', activationStart);
        const activationSource = backgroundSource.slice(activationStart, activationEnd);
        expect(activationSource.indexOf('await deactivateTargetTab(previousTabId)'))
            .toBeLessThan(activationSource.indexOf('await injectContentScript(selectedTabId'));
        expect(activationSource).toContain('previousTabId !== selectedTabId');
        expect(contentSource).toContain('if (window.koalaSyncInjected && chrome.runtime.id)');
        expect(overlaySource).toContain('if (window.koalaSyncChatOverlay?.refresh)');
    });

    it('keeps the chat overlay in the top document when the player is nested', () => {
        expect(backgroundSource).toContain('function sendMessageToChatOverlay(message)');
        expect(backgroundSource).toContain('return sendMessageToFrame(tabId, 0, message)');
        // Every chat-facing message must reach the overlay's frame, not the
        // player's. A stray sendMessageToCurrentContent here renders the chat
        // inside the video on Drive.
        expect(backgroundSource).not.toMatch(/sendMessageToCurrentContent\(\{\s*type: 'CHAT/);
        expect(backgroundSource).toMatch(
            /target: \{ tabId, frameIds: \[0\] \},\s*files: \['chat-format\.js', 'chat-overlay\.js'\]/
        );
        expect(backgroundSource).toContain("files: ['content.js']");
        expect(backgroundSource).toContain('if (normalizeFrameId(target.frameId) !== 0)');
    });

    it('does not reactivate the target for ordinary playback churn', () => {
        expect(backgroundSource).toContain('async function selectedMediaTargetMoved(tabId)');
        expect(backgroundSource).toContain('onlyIfTargetMoved = true');
        // Forcing a rebuild must stay rare and deliberate: an unreachable content
        // script, an explicit request, and a completed navigation. Everything else
        // takes the guarded path by default.
        expect(backgroundSource.match(/onlyIfTargetMoved: false/g)?.length).toBe(3);
        // Playback state must stay out of the candidate signature, otherwise
        // every play/pause looks like a frame layout change.
        expect(monitorSource).not.toContain('element.paused ? 0 : 1');
        expect(monitorSource).toContain('element.readyState > 0 ? 1 : 0');
    });

    it('keeps the frame registry bounded and free of a navigation permission', () => {
        expect(backgroundSource).toContain('const MAX_KNOWN_FRAMES_PER_TAB = 24');
        // Frame ids are learned, never enumerated through a permission.
        expect(backgroundSource).toContain('function rememberFrameId(tabId, frameId)');
        expect(backgroundSource).toContain('rememberFrameId(senderTabId, sender?.frameId)');
        expect(backgroundSource).toContain('contentTarget.discoveredFrameIds');
        // The registry must never be cleared on navigation: tabs.onUpdated
        // reports 'loading' for same-document History API navigations too, which
        // is exactly when these players are built. It self-corrects instead.
        expect(backgroundSource).toContain('function refreshFrameIds(tabId, frameIds)');
        expect(backgroundSource).not.toMatch(/changeInfo\.status === 'loading'[\s\S]{0,160}forgetFrameIds/);
        expect(backgroundSource).toContain('refreshFrameIds(tabId, contentTarget.discoveredFrameIds)');
        expect(backgroundSource).not.toMatch(/chrome\.webNavigation/);
    });

    it('bounds every frame probe and verifies withheld origins', () => {
        const resolverSource = fs.readFileSync(
            path.join(extensionDir, 'media-frame-target.js'),
            'utf8'
        );
        expect(resolverSource).toContain('async function originAccessIsWithheld(chromeApi, originPattern)');
        expect(resolverSource).toContain('probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS');
        expect(resolverSource).toContain('attempts = 8');
        expect(resolverSource).toContain('deadlineMs = 12000');
        // A swallowed probe error is what turned a slow player frame into a
        // permission prompt for an origin the extension already held.
        expect(resolverSource).toContain('errors.push({ target, error })');
    });

    it('fully deactivates old and superseded target injections', () => {
        expect(backgroundSource).toContain("{ type: 'TARGET_DEACTIVATE' }");
        expect(backgroundSource).toContain('target.documentId');
        expect(backgroundSource.match(/await deactivateTargetTab\(selectedTabId,/g)?.length).toBeGreaterThanOrEqual(6);
        expect(contentSource).toContain("if (message.type === 'TARGET_DEACTIVATE')");
        expect(overlaySource).toContain("message?.type === 'TARGET_DEACTIVATE'");
    });

    it('routes every terminal room exit through the full target unhook', () => {
        const teardownStart = backgroundSource.indexOf('async function performRoomSessionTeardown');
        const teardownEnd = backgroundSource.indexOf('async function endRoomSession', teardownStart);
        const teardownSource = backgroundSource.slice(teardownStart, teardownEnd);
        expect(teardownSource).toContain('await clearTargetSelectionForLifecycle()');
        expect(teardownSource).toContain('forceDisconnect()');
        expect(teardownSource.indexOf('completeForceSyncBeforeTargetChange(null)'))
            .toBeLessThan(teardownSource.indexOf('currentRoom = null'));

        const clearStart = backgroundSource.indexOf('async function clearTargetSelectionForLifecycle');
        const clearEnd = backgroundSource.indexOf('function clearTargetTabForIdle', clearStart);
        const clearSource = backgroundSource.slice(clearStart, clearEnd);
        expect(clearSource).toContain('const previousTabId = normalizeTabId(currentTabId)');
        expect(clearSource).toContain('const previousContentTarget = currentContentTarget()');
        expect(clearSource.indexOf('const previousContentTarget = currentContentTarget()'))
            .toBeLessThan(clearSource.indexOf('currentTabId = null'));
        expect(clearSource).toContain('resetUserSelectionState()');
        expect(clearSource).toContain('deactivateTargetTab(previousTabId, previousContentTarget)');
        expect(clearSource).toContain('selectedTabId: null');
        expect(clearSource).toContain("type: 'TARGET_TAB_CLEARED'");
        expect(popupSource).toContain("refreshTargetAccessState({ autoSelectMatch: false })");
        expect(popupSource).toContain('if (autoSelectMatch && matchOpt && elements.targetTab.options.length > 1)');

        expect(backgroundSource).toContain('await endRoomSession({ notifyServer: true, reason });');
        expect(backgroundSource).toContain("await endRoomSession({ notifyServer: true, reason: 'Left Room' });");
        expect(backgroundSource).toContain('data.code === ERROR_CODES.ROOM_CLOSED');
        expect(backgroundSource).toContain('data.code === ERROR_CODES.PEER_TIMED_OUT');
        expect(backgroundSource).toContain("data.message === 'Room closed'");
        expect(backgroundSource).toContain("data.message === 'Removed from room after inactivity'");
        expect(backgroundSource).toContain('await endRoomSession({ reason: `Room session ended: ${data.message}` });');

        const controlModeStart = backgroundSource.indexOf('case EVENTS.CONTROL_MODE:');
        const controlModeEnd = backgroundSource.indexOf('case EVENTS.ROOM_LIST:', controlModeStart);
        expect(backgroundSource.slice(controlModeStart, controlModeEnd)).toContain('if (!currentRoom) break;');

        expect(sharedConstantsSource).toContain("ROOM_CLOSED: 'room_closed'");
        expect(sharedConstantsSource).toContain("PEER_TIMED_OUT: 'peer_timed_out'");
        expect(serverSource).toContain('code: ERROR_CODES.ROOM_CLOSED');
        expect(serverSource).toContain('code: ERROR_CODES.PEER_TIMED_OUT');
        expect(serverSource).toContain(
            "removePeerFromRoom(sid, roomId, 'room-timeout', { notifyRemainingPeers: false })"
        );
    });

    it('does not promote a nested media target without confirmed parent visibility', () => {
        expect(backgroundSource).toContain(
            'normalizeFrameId(resolved.frameId) !== 0 && resolved.visibilityConfirmed !== true'
        );
    });

    it('removes monitors injected by a superseded cross-tab activation', () => {
        expect(backgroundSource).toContain('function isTargetActivationSuperseded(tabId, activationGeneration)');
        expect(backgroundSource).toMatch(/navigationRetries: navigationRetries - 1,\s*activationGeneration\s*\}\)/);
        expect(backgroundSource).toMatch(/await injectMediaFrameMonitors\(tabId, contentTarget\);[\s\S]*if \(isTargetActivationSuperseded\(tabId, activationGeneration\)\)[\s\S]*await deactivateMediaFrameMonitors\(tabId\);/);
        expect(backgroundSource).toContain("error.code = 'target_activation_superseded'");
    });

    it('uses all-frame probing for cross-origin targets without navigation permissions', () => {
        expect(backgroundSource).toContain("files: ['media-frame-monitor.js']");
        expect(backgroundSource).toContain('async function announcePotentialMediaFrame()');
        expect(backgroundSource).toContain("{ type: 'MEDIA_FRAME_DISCOVERED' }");
        expect(backgroundSource).toContain('func: announcePotentialMediaFrame');
        // Monitors must reach the frames we know about, not only whatever the
        // all-frames sweep happens to accept — both on the way in and out.
        expect(backgroundSource.match(/\.\.\.listMediaFrameScriptTargets\(tabId\),/g)?.length).toBe(2);
        expect(backgroundSource.match(/\.\.\.listKnownFrameIds\(tabId\)/g)?.length).toBe(2);
        expect(backgroundSource).toContain('One denied widget frame must not block the selected player');
        expect(backgroundSource).toContain("navigationError.code = 'media_target_navigated'");
        expect(backgroundSource).toContain("{ type: 'MEDIA_MONITOR_DEACTIVATE' }");
        expect(backgroundSource).toContain('async function deactivateMediaFrameMonitors(tabId)');
        expect(backgroundSource).toContain('{ documentId }');
        expect(monitorSource).toContain("type: 'MEDIA_FRAME_CANDIDATE_CHANGED'");
        expect(monitorSource).toContain("attributeFilter: ['class', 'style', 'hidden', 'src', 'controls']");
        expect(monitorSource).toContain('if (!force && nextSignature === lastCandidateSignature) return');
        expect(monitorSource).toContain("const MEDIA_STATE_EVENTS = ['play', 'pause', 'loadedmetadata'");
        expect(monitorSource).toContain("node.querySelector?.('video, iframe, frame')");
        expect(manifest.permissions).toEqual([
            'storage',
            'tabs',
            'scripting',
            'alarms',
            'activeTab',
            'notifications'
        ]);
        expect(backgroundSource).not.toMatch(/chrome\.(?:web)?Navigation/);
    });

    it('serializes content commands and coalesces target refreshes', () => {
        expect(backgroundSource).toContain('contentCommandQueue.catch(() => {}).then(deliver)');
        expect(backgroundSource).toContain('if (mediaTargetRefreshTask && mediaTargetRefreshTabId === selectedTabId)');
        expect(backgroundSource).toContain('if (queueIfRunning) mediaTargetRefreshDirty = true');
        expect(backgroundSource).toContain('&& pass < 2');
        expect(backgroundSource).toContain('const needsFollowup = mediaTargetRefreshDirty');
        expect(backgroundSource).not.toContain('Re-elect before every remote command');
        expect(backgroundSource).toContain('await sendMessageToContentTab(tabId');
    });

    it('tears down every persistent content-script resource', () => {
        expect(contentSource).toContain('function destroyContentScript({ preserveAudioRoute = false } = {})');
        // Deselecting a tab hands the page back to itself; it must not go mute.
        expect(contentSource).toContain('destroyContentScript({ preserveAudioRoute: true });');
        expect(contentSource).toContain('if (!preserveAudioRoute) closeAudioContext();');
        expect(contentSource).toContain('observer.disconnect()');
        expect(contentSource).toContain('keepAlivePort.disconnect()');
        expect(contentSource).toContain('for (const video of [...attachedVideos]) detachVideoListeners(video);');
        expect(contentSource).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)");
        expect(contentSource).toContain("window.removeEventListener('pagehide', handlePageHide)");
        expect(contentSource).toContain("window.removeEventListener('pageshow', handlePageShow)");
        expect(contentSource).toContain("window.removeEventListener('resize', handleMediaFrameResize)");
        expect(contentSource).toContain('chrome.storage.onChanged.removeListener(handleStorageChanged)');
        expect(contentSource).toContain('chrome.runtime.onMessage.removeListener(handleRuntimeMessage)');
        expect(contentSource).toContain('window.koalaSyncInjected = false');
    });

    it('stops the MAIN-world seek bridge when its target is deactivated', () => {
        expect(backgroundSource).toContain('const timelineInterval = setInterval');
        expect(backgroundSource).toContain('clearInterval(timelineInterval)');
        expect(backgroundSource).toContain("window.removeEventListener('message', handleBridgeMessage)");
        expect(contentSource).toContain("kind: 'destroy'");
    });

    it('self-cleans instead of throwing when an extension reload invalidates the context', () => {
        expect(contentSource).toContain('if (!chrome.runtime?.id)');
        expect(contentSource).toContain('destroyContentScript()');
        expect(contentSource).toContain('return chrome.runtime.sendMessage(message, callback) || Promise.resolve(undefined)');
        expect(contentSource).toContain('function handleVisibilityChange()');
    });

    it('suspends background work for bfcache and restores it without duplicate injection', () => {
        expect(contentSource).toContain('pageSuspended = true');
        expect(contentSource).toContain('if (destroyed || pageSuspended) return');
        expect(contentSource).toContain('if (!destroyed && !pageSuspended) scheduleLifecycleTimeout(connectKeepAlivePort, 1000)');
        expect(contentSource).toMatch(/function handlePageShow\(event\)[\s\S]*if \(!event\.persisted\) return;[\s\S]*pageSuspended = false/);
        expect(contentSource).toMatch(/function handlePageShow\(event\)[\s\S]*observer\.observe\(document\.documentElement[\s\S]*setupListeners\(\)[\s\S]*connectKeepAlivePort\(\)/);
    });
});
