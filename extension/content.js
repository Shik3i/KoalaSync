/**
 * KoalaSync Content Script
 * Injected into video tabs to control playback and detect events.
 */

(function() {
    // Injection Guard: Check if already injected AND context is valid
    try {
        if (window.koalaSyncInjected && chrome.runtime.id) {
            return;
        }
    } catch (_e) {
        // Context invalidated, proceed with re-injection
    }
    window.koalaSyncInjected = true;

    // --- SHARED_EVENTS_INJECT_START ---
    // This block is automatically updated by /scripts/build-extension.cjs
    const EVENTS = {
        PLAY: "play",
        PAUSE: "pause",
        SEEK: "seek",
        FORCE_SYNC_PREPARE: "force_sync_prepare",
        FORCE_SYNC_ACK: "force_sync_ack",
        FORCE_SYNC_EXECUTE: "force_sync_execute",
        PEER_STATUS: "peer_status",
        EPISODE_LOBBY: "episode_lobby",
        EPISODE_READY: "episode_ready"
    };
    // --- SHARED_EVENTS_INJECT_END ---

    // Suppresses native event reporting after a programmatic action.
    // Each entry is a per-type timer (key = 'playing'|'paused'|'seek').
    // While a timer exists, matching native events are consumed and not relayed.
    // Timers self-clean after 300ms if the native event never fires.
    let _suppressTimers = {};

    function _setSuppress(state) {
        if (_suppressTimers[state]) clearTimeout(_suppressTimers[state]);
        _suppressTimers[state] = setTimeout(() => {
            delete _suppressTimers[state];
        }, 300);
    }

    function _clearSuppress(state) {
        if (_suppressTimers[state]) {
            clearTimeout(_suppressTimers[state]);
            delete _suppressTimers[state];
        }
    }

    // --- Seek Relay Filtering ---
    // Minimum seek delta (seconds) to report. Prevents HLS/DASH buffering micro-seeks
    // from being relayed to peers as user-initiated seeks.
    const MIN_SEEK_DELTA = 2.0;
    let lastReportedSeekTime = null;  // last currentTime we relayed as a SEEK
    let seekDebounceTimer = null;     // debounce timer for rapid seek events
    let expectedSeekTime = null;      // strictly track programmatic seeks

    const PAGE_API_SEEK_BRIDGE = 1;
    // Accurate Disney+ playhead pushed by the MAIN-world page-API bridge
    // (background.js installPageApiSeekBridge). The isolated content world
    // can't read the page's media player directly.
    let disneyPageApiTime = null;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const data = event.data;
            if (data && data.__koalaPlayerTime === 1 && data.provider === 'disney'
                && Number.isFinite(data.position) && Number.isFinite(data.duration) && data.duration > 0) {
                disneyPageApiTime = { position: data.position, duration: data.duration, at: Date.now() };
            }
        });
    }

    function hostMatchesUrl(host, url) {
        const normalized = String(url || '')
            .replace(/^https?:\/\//i, '')
            .split('/')[0]
            .toLowerCase();
        return normalized && (host === normalized || host.endsWith(`.${normalized}`));
    }

    function matchesPlayerUrls(urls) {
        const host = window.location.hostname.toLowerCase();
        return Array.isArray(urls) && urls.some(url => hostMatchesUrl(host, url));
    }

    function isDisneyPlusHost() {
        return matchesPlayerUrls(['disneyplus.com']);
    }

    function getDisneyPlusTimeline() {
        if (!isDisneyPlusHost()) return null;
        // Exact playhead/duration from the page media player, relayed by the
        // MAIN-world bridge. No Disney DOM scraping fallback.
        if (disneyPageApiTime && (Date.now() - disneyPageApiTime.at) < 2000 && disneyPageApiTime.duration > 0) {
            const cur = Math.max(0, Math.min(disneyPageApiTime.duration, disneyPageApiTime.position));
            return { start: 0, end: disneyPageApiTime.duration, duration: disneyPageApiTime.duration, current: cur, nativeScale: 1, nativeStart: 0 };
        }
        return null;
    }

    // Site-specific player exceptions live here. The default HTML5 path stays below.
    function getSiteQuirkAdapters() {
        return [{
            name: 'disneyplus-page-api',
            key: 'disneyPlus',
            urls: ['disneyplus.com'],
            matches() { return matchesPlayerUrls(this.urls); },
            getTimeline: getDisneyPlusTimeline,
            getDebug(video) {
                return {
                    name: this.name,
                    key: 'disneyPlus',
                    urls: this.urls,
                    timeline: getDisneyPlusTimeline(video)
                };
            }
        }];
    }

    function getActiveSiteQuirk() {
        return getSiteQuirkAdapters().find(adapter => adapter.matches()) || null;
    }

    function getSiteQuirkTimeline(video) {
        const adapter = getActiveSiteQuirk();
        return adapter ? adapter.getTimeline(video) : null;
    }

    function getSiteQuirkDebug(video) {
        const adapter = getActiveSiteQuirk();
        return adapter ? adapter.getDebug(video) : null;
    }

    function getSyncCurrentTime(video) {
        const siteTimeline = getSiteQuirkTimeline(video);
        if (siteTimeline) return siteTimeline.current;
        if (isDisneyPlusHost()) return null;
        const current = video.currentTime;
        return Number.isFinite(current) ? current : null;
    }

    function getSyncDuration(video) {
        const siteTimeline = getSiteQuirkTimeline(video);
        if (siteTimeline) return siteTimeline.duration;
        if (isDisneyPlusHost()) return 0;
        return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    }

    function toNativeSeekTime(video, targetTime) {
        if (!Number.isFinite(targetTime)) return targetTime;
        const siteTimeline = getSiteQuirkTimeline(video);
        if (!siteTimeline) return targetTime;
        const nativeTarget = siteTimeline.nativeStart + targetTime * siteTimeline.nativeScale;
        const max = Number.isFinite(siteTimeline.end) ? siteTimeline.end : nativeTarget;
        const min = Number.isFinite(siteTimeline.start) ? siteTimeline.start : 0;
        return Math.max(min, Math.min(max, nativeTarget));
    }

    function shouldUsePageApiSeek() {
        return window.KOALA_PAGE_API_SEEK_ENABLED === true &&
            typeof window.koalaFindPageApiSeekProvider === 'function' &&
            !!window.koalaFindPageApiSeekProvider(window.location.hostname);
    }

    function seekVideo(video, targetTime) {
        // Prefer a precise page-level seek API when available (Netflix, Disney+);
        // for those players the DOM/button seek path is imprecise or impossible.
        if (shouldUsePageApiSeek()) {
            expectedSeekTime = targetTime;
            window.postMessage({ __koalaPageApiSeek: PAGE_API_SEEK_BRIDGE, kind: 'seek', time: targetTime }, '*');
            return;
        }
        expectedSeekTime = targetTime;
        video.currentTime = toNativeSeekTime(video, targetTime);
    }

    // --- Play/Pause Coalescing (leading + trailing) ---
    // Media players (HLS/DASH, ad insertion, ABR/quality switches, source swaps,
    // page teardown) fire bursts of native play/pause events within a few hundred
    // ms. Relaying each as a distinct command spams peers and the relay.
    //
    // Strategy: emit the FIRST event immediately (leading edge → a deliberate
    // single play/pause has zero added latency), then hold a short window. If
    // more play/pause events arrive during the window it's a burst — we suppress
    // the intermediate churn and, once it settles, emit the FINAL state on the
    // trailing edge.
    //
    // We deliberately do NOT dedup the trailing send against the leading one. A
    // remote play/pause may be applied mid-window (e.g. I pause, peer plays, I
    // pause again within 150ms): the settled state then equals my last *sent*
    // state yet is a genuine change versus the now-shared state — suppressing it
    // would desync. Re-sending an unchanged state is a harmless no-op on peers,
    // so re-sending is always the safe choice. Echo-suppression and seek-flush
    // still run synchronously on event arrival (see reportEvent) — only the
    // network emit is governed here.
    const PLAY_PAUSE_COALESCE_MS = 150;
    let playPauseCoalesceTimer = null;  // non-null = a coalescing window is open
    let pendingPlayPauseAction = null;  // last play/pause seen during the window, awaiting trailing flush

    // --- Episode Auto-Sync State ---
    let lastKnownMediaTitle = null;
    let episodeTransitionDebounce = null;
    let _pendingLobbyTitle = null; // Title we're waiting to match (from remote lobby)
    let lobbyPollTimer = null;
    let _autoSyncEnabled = true; // Cached setting, updated via storage.onChanged
    let _audioSettings = null;
    let _audioProcessingAllowed = true;

    // Cache the autoSyncNextEpisode setting (local-only; never read from sync)
    chrome.storage.local.get(['autoSyncNextEpisode', 'audioSettings'], (data) => {
        _autoSyncEnabled = data.autoSyncNextEpisode !== false;
        _audioSettings = mergeAudioSettings(data.audioSettings);
        const video = findVideo();
        if (video && _audioProcessingAllowed) applyAudioSettings(video, _audioSettings);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.autoSyncNextEpisode) {
            _autoSyncEnabled = changes.autoSyncNextEpisode.newValue !== false;
        }
    });

    // --- Host Control Mode (guest-side) ---
    // When a room is in 'host-only' mode and we're a guest, a deliberate local
    // pause/seek must not drive the room (background/server already drop it). Here
    // we handle the *local* UX: snap back to the host's position, or — if the user
    // really wants to — let them go solo (desync) with a resync escape hatch.
    let hcmControlMode = 'everyone';   // mirror of room control mode
    let hcmAmController = false;        // are we allowed to drive (owner or co-host)?
    let hcmHostPeerId = null;          // last known host peerId (room/host identity)
    let hcmDesynced = false;           // user chose to go solo
    let hcmSnapBackCooldownUntil = 0;  // suppress re-trigger right after a snap-back
    let hcmDeferredSnapPending = false; // a buffer-aware snap-back is waiting for readiness
    let hcmLastUserGestureAt = 0;      // for deliberate-vs-involuntary classification
    let hcmBufferingUntil = 0;         // set on 'waiting' — buffering grace window
    let hcmDialogTimer = null;         // 8s auto-stay timer — cleared on dialog replace (H-4)
    // Localized strings for the in-page dialog/badge (content has no i18n loader;
    // background resolves them via GET_HCM_STRINGS on init). English fallbacks here.
    const hcmStrings = {
        title:  'KoalaSync · Host controls this room',
        body:   'Only the host can control playback in this room. Keep watching together, or watch on your own?',
        stay:   'Stay in sync',
        solo:   'Watch on my own',
        badge:  'Watching on your own',
        resync: 'Resync'
    };
    const HCM_USER_GESTURE_MS = 1000;
    const HCM_BUFFERING_GRACE_MS = 1500;
    const HCM_SNAP_BACK_COOLDOWN_MS = 1000;
    const HCM_BUFFER_WAIT_MS = 8000;   // cap on waiting for a buffering player before snapping anyway

    // Track genuine user input so we can tell a deliberate pause/seek from a
    // player-/browser-initiated one. Capturing + passive so we never interfere.
    const _hcmGesture = () => { hcmLastUserGestureAt = Date.now(); };
    document.addEventListener('keydown', _hcmGesture, { capture: true, passive: true });
    document.addEventListener('pointerdown', _hcmGesture, { capture: true, passive: true });

    function hcmIsGuestGated() {
        return hcmControlMode === 'host-only' && !hcmAmController;
    }

    // EC-9 intent classifier: only a *clearly deliberate* guest action triggers the
    // dialog/snap-back. Anything that smells involuntary (buffering, seeking, tab
    // refocus, no recent gesture) is treated as involuntary. Bias intentional —
    // in host-only the guest never broadcasts anyway, so this only tunes UX.
    function hcmClassifyIntent() {
        const video = findVideo();
        if (!video) return 'involuntary';
        if (hcmIsLive(video)) return 'live';                   // EC-15: degrade, don't gate
        if (video.readyState < 3) return 'involuntary';        // buffering / not enough data
        if (video.seeking) return 'involuntary';
        if (Date.now() < hcmBufferingUntil) return 'involuntary';
        if (Date.now() < visibilityGraceUntil) return 'involuntary';
        if (Date.now() - hcmLastUserGestureAt > HCM_USER_GESTURE_MS) return 'involuntary';
        return 'deliberate';
    }

    // Live detection (EC-15 + DVR). Pure live reports duration Infinity/NaN. Live-DVR
    // (Twitch/YouTube-live with rewind) reports a *finite, sliding* duration — its
    // seekable window doesn't start at 0, which we use as the DVR signal.
    function hcmIsLive(video) {
        // Don't trust duration before metadata has loaded (readyState >= 1) —
        // otherwise pre-loaded videos report NaN and get misclassified as live,
        // which suppresses the desync dialog (L-2).
        if (video.readyState < 1) return false;
        if (!isDisneyPlusHost() && !Number.isFinite(video.duration)) return true;
        try {
            const s = video.seekable;
            if (s && s.length > 0 && s.start(0) > 1) return true; // sliding DVR window
        } catch (_e) { /* seekable may throw if empty */ }
        return false;
    }

    // Snap the local player back to the host's current position/state.
    function hcmSnapBackToHost(target) {
        if (hcmDesynced) return; // user opted out — never yank them back automatically
        hcmSnapBackCooldownUntil = Date.now() + HCM_SNAP_BACK_COOLDOWN_MS;
        const video = findVideo();
        if (!video) return;
        if (target && Number.isFinite(target.targetTime)) {
            tryMediaAction(EVENTS.SEEK, { targetTime: target.targetTime });
        }
        // Adopt the host's play/pause state — but ONLY if we actually know it.
        // Defaulting to PLAY when the state is unknown would auto-resume a paused
        // video against the host's real state (H-1).
        if (target && target.playbackState === 'paused') {
            tryMediaAction(EVENTS.PAUSE);
        } else if (target && target.playbackState === 'playing') {
            tryMediaAction(EVENTS.PLAY);
        }
        reportLog('Host-only: snapped back to host position', 'info');
    }

    // Resync to the host's current position, retrying briefly if the host's state
    // isn't known yet (e.g. they just paused and no heartbeat has propagated) —
    // otherwise the request is a silent no-op and the user thinks they're synced
    // when they aren't. Shared by the dialog's "Stay in sync" and the Resync badge.
    function hcmRequestHostSyncWithRetry() {
        let attempts = 0;
        const tryOnce = () => {
            chrome.runtime.sendMessage({ type: 'REQUEST_HOST_SYNC' }, (res) => {
                if (chrome.runtime.lastError || !res || !res.target) {
                    if (++attempts < 5) setTimeout(tryOnce, 250);
                    else reportLog('Host-only: resync requested but host state unavailable', 'warn');
                    return;
                }
                hcmSnapBackToHost(res.target);
            });
        };
        tryOnce();
    }

    // Buffer-aware snap-back (#3). An involuntary pause/seek often coincides with the
    // player buffering — and a player can't actually play while it's stalled. Snapping
    // immediately just fights the buffer (seek → re-buffer → another pause → …), which
    // looks like stutter. Instead: if the player isn't ready, wait until it can play
    // (readyState>=3, not seeking), then snap ONCE to the host's *current* position
    // (re-queried, since the captured target may be stale by the time buffering ends).
    // Player-agnostic on purpose — we can't enumerate every site, so this must be safe
    // regardless of whether a given player fires 'pause' or only 'waiting'.
    function hcmDeferredSnapBack() {
        if (hcmDeferredSnapPending) return; // already waiting — don't stack polls
        hcmDeferredSnapPending = true;
        const deadline = Date.now() + HCM_BUFFER_WAIT_MS;
        const poll = () => {
            // Abort if the reason to snap is gone: user went solo, we're no longer a
            // gated guest, or the video vanished.
            if (hcmDesynced || !hcmIsGuestGated()) { hcmDeferredSnapPending = false; return; }
            const video = findVideo();
            const ready = video && video.readyState >= 3 && !video.seeking;
            if (ready || Date.now() >= deadline) {
                hcmDeferredSnapPending = false;
                hcmRequestHostSyncWithRetry(); // fresh host position + snap once
                return;
            }
            setTimeout(poll, 300);
        };
        poll();
    }

    // Entry point: background told us our local action was blocked in host-only.
    function hcmHandleBlocked(action, target) {
        // HOST_BLOCKED is only ever sent to a gated guest (background verifies
        // host-only + !host before sending), so it's authoritative. Adopt the
        // role/mode from it in case our CONTROL_MODE broadcast hasn't landed yet
        // (join race, EC-5) — otherwise we'd miss the dialog/snap-back.
        hcmControlMode = 'host-only';
        hcmAmController = false;
        if (hcmDesynced) return; // already solo, nothing to do

        const intent = hcmClassifyIntent();
        if (intent === 'live') return;          // EC-15: leave the guest alone on live
        if (intent === 'involuntary') {
            // EC-4 loop guard: only the silent auto snap-back is suppressed by the
            // cooldown — the deliberate dialog path below must still go through,
            // otherwise a second deliberate pause inside the cooldown window leaves
            // the user stuck paused with no UI (M-3).
            if (Date.now() < hcmSnapBackCooldownUntil || hcmDeferredSnapPending) return;
            // Buffering/ads/throttle — silently re-sync, no dialog spam.
            const video = findVideo();
            if (video && video.readyState >= 3 && !video.seeking) {
                // Ready now → snap immediately. Use the captured target if it's
                // usable, otherwise re-query+retry (host state may not be known yet)
                // so we never leave the guest silently stuck (consistent with the
                // deferred and "Stay in sync" paths).
                if (target && Number.isFinite(target.targetTime)) hcmSnapBackToHost(target);
                else hcmRequestHostSyncWithRetry();
            } else {
                hcmDeferredSnapBack();             // buffering → wait for ready, then snap once (#3)
            }
            return;
        }
        // Deliberate: offer the choice (Teleparty-style), default = snap back.
        hcmShowDesyncDialog(action, target);
    }

    // --- In-page UI (dialog + persistent desync badge) ---
    // Built with the DOM API (CSSOM .style is CSP-safe; inline style="" in innerHTML
    // is stripped by strict style-src on Netflix/YouTube/Disney+). Hosted in a
    // Shadow DOM so the page's CSS can't restyle or hide our controls.
    let hcmDialogHost = null;  // shadow host element for the dialog
    let hcmBadgeHost = null;   // shadow host element for the persistent badge
    let hcmBadgePending = false;  // retry flag for early-injection badge creation (L-4)

    function hcmEl(tag, css, text) {
        const el = document.createElement(tag);
        if (css) el.style.cssText = css;        // CSSOM assignment — not gated by CSP
        if (text != null) el.textContent = text;
        return el;
    }

    function hcmRemoveDialog() {
        // Cancel any pending auto-stay timer so a replaced dialog's stale closure
        // can't later remove its successor / snap to an outdated target (H-4).
        if (hcmDialogTimer) { clearTimeout(hcmDialogTimer); hcmDialogTimer = null; }
        if (hcmDialogHost) { hcmDialogHost.remove(); hcmDialogHost = null; }
    }

    function hcmShowDesyncDialog(action, target) {
        if (!document.body) { hcmSnapBackToHost(target); return; }
        hcmRemoveDialog();
        const host = hcmEl('div', 'all:initial');
        const root = host.attachShadow({ mode: 'open' });

        const wrap = hcmEl('div', 'position:fixed;z-index:2147483647;left:50%;bottom:32px;transform:translateX(-50%);background:#1f2937;color:#f9fafb;font:14px/1.4 system-ui,sans-serif;padding:16px 18px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.45);max-width:360px;border:1px solid #374151');
        wrap.setAttribute('role', 'dialog');
        const title = hcmEl('div', 'font-weight:600;margin-bottom:6px', hcmStrings.title);
        const body = hcmEl('div', 'margin-bottom:12px;color:#d1d5db', hcmStrings.body);
        const btnRow = hcmEl('div', 'display:flex;gap:8px;justify-content:flex-end');
        const soloBtn = hcmEl('button', 'background:#374151;color:#f9fafb;border:0;padding:8px 12px;border-radius:8px;cursor:pointer', hcmStrings.solo);
        const stayBtn = hcmEl('button', 'background:#10b981;color:#062a20;border:0;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600', hcmStrings.stay);
        btnRow.append(soloBtn, stayBtn);
        wrap.append(title, body, btnRow);
        root.appendChild(wrap);
        document.body.appendChild(host);
        hcmDialogHost = host;

        let settled = false;
        // Re-query the host's current position on click instead of using the
        // potentially stale target captured at HOST_BLOCKED time (M-1).
        const stay = () => {
            if (settled) return; settled = true; hcmRemoveDialog();
            hcmRequestHostSyncWithRetry();
        };
        const solo = () => { if (settled) return; settled = true; hcmRemoveDialog(); hcmEnterDesync(); };
        stayBtn.addEventListener('click', stay);
        soloBtn.addEventListener('click', solo);
        // EC-18: if the user ignores the prompt, default to staying in sync.
        hcmDialogTimer = setTimeout(() => { if (!settled) stay(); }, 8000);
    }

    function hcmEnterDesync() {
        hcmDesynced = true;
        reportLog('Host-only: you chose to watch on your own (desynced)', 'warn');
        // Notify background so it can relay our desynced state to the host via
        // heartbeats — the host's UI then knows we're not following commands
        // instead of appearing silently un-ACK'd.
        chrome.runtime.sendMessage({ type: 'HCM_DESYNC_STATE', desynced: true }).catch(() => {});
        hcmShowBadge();
    }

    function hcmExitDesync() {
        const wasDesynced = hcmDesynced;
        hcmDesynced = false;
        hcmRemoveBadge();
        if (wasDesynced) {
            chrome.runtime.sendMessage({ type: 'HCM_DESYNC_STATE', desynced: false }).catch(() => {});
        }
        // Resync to the host's current position (retries if host state not yet known).
        hcmRequestHostSyncWithRetry();
        reportLog('Host-only: resynced with the host', 'info');
    }

    function hcmShowBadge() {
        if (hcmBadgeHost) return;
        if (!document.body) {
            // Body not ready yet (very early injection). Defer until DOMReady,
            // otherwise the desynced user silently never sees the badge (L-4).
            if (!hcmBadgePending) {
                hcmBadgePending = true;
                const retry = () => {
                    hcmBadgePending = false;
                    if (hcmDesynced && !hcmBadgeHost) hcmShowBadge();
                };
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', retry, { once: true });
                } else {
                    setTimeout(retry, 50);
                }
            }
            return;
        }
        const host = hcmEl('div', 'all:initial');
        const root = host.attachShadow({ mode: 'open' });
        const b = hcmEl('div', 'position:fixed;z-index:2147483646;right:16px;bottom:16px;background:#b45309;color:#fff;font:13px/1.3 system-ui,sans-serif;padding:8px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.4);cursor:pointer;display:flex;align-items:center;gap:8px');
        b.append(hcmEl('span', null, '● ' + hcmStrings.badge), hcmEl('span', 'text-decoration:underline', hcmStrings.resync));
        b.addEventListener('click', hcmExitDesync);
        root.appendChild(b);
        document.body.appendChild(host);
        hcmBadgeHost = host;
    }

    function hcmRemoveBadge() {
        if (hcmBadgeHost) { hcmBadgeHost.remove(); hcmBadgeHost = null; }
    }

    function hcmReset() {
        const wasDesynced = hcmDesynced;
        hcmDesynced = false;
        hcmDeferredSnapPending = false;
        hcmSnapBackCooldownUntil = 0; // don't let a stale cooldown swallow the next snap-back
        hcmBufferingUntil = 0;
        hcmRemoveDialog();
        hcmRemoveBadge();
        // If we were desynced, notify background so it stops reporting us as
        // desynced in heartbeats (otherwise the host's UI keeps showing the
        // stale Solo badge until the next state change).
        if (wasDesynced) {
            chrome.runtime.sendMessage({ type: 'HCM_DESYNC_STATE', desynced: false }).catch(() => {});
        }
    }

    function reportLog(message, level = 'info') {
        chrome.runtime.sendMessage({ type: 'LOG', message, level }).catch(() => {});
    }

    // --- Helper: find the best video element on the page ---
    // Prefers larger, visible videos over tiny preview/trailer elements.
    function findVideo(root = document) {
        const candidates = Array.from(root.querySelectorAll('video'));

        // Scan likely media hosts even when light-DOM videos exist; many players
        // expose a tiny preview/ad video outside Shadow DOM and the real player inside.
        const potentialHosts = root.querySelectorAll('[id*="player" i], [class*="player" i], [id*="video" i], [class*="video" i], [id*="media" i], [class*="media" i], [id*="stream" i], [class*="stream" i], ytd-player, netflix-player, emby-player, jellyfin-player, video-player');
        for (const el of potentialHosts) {
            if (el.shadowRoot) {
                const found = findVideo(el.shadowRoot);
                if (found) candidates.push(found);
            }
        }

        if (candidates.length === 0) return null;

        // Multiple videos found → pick the best one
        if (candidates.length === 1) return candidates[0];

        let best = null;
        let bestScore = -1;
        for (const v of candidates) {
            if (v.tagName !== 'VIDEO') continue;
            // Score: visible area + bonus for unmuted + bonus for longer duration
            const area = (v.videoWidth || v.offsetWidth || 0) * (v.videoHeight || v.offsetHeight || 0);
            const unmutedBonus = v.muted ? 0 : 100000;
            const durationBonus = (v.duration && isFinite(v.duration) ? v.duration : 0) * 100;
            const score = area + unmutedBonus + durationBonus;
            if (score > bestScore) {
                bestScore = score;
                best = v;
            }
        }
        return best;
    }

    // --- Audio Processing Module ---
    const AUDIO_PRESETS = {
        recommended: { threshold: -24, ratio: 8, attack: 0.010, release: 0.300, knee: 15 },
        dynamicRange: { threshold: -18, ratio: 4, attack: 0.020, release: 0.200, knee: 10 },
        vocalEnhancement: { threshold: -12, ratio: 3, attack: 0.015, release: 0.150, knee: 5 },
        smooth: { threshold: -30, ratio: 1.5, attack: 0.030, release: 0.250, knee: 20 },
        custom: { threshold: -24, ratio: 12, attack: 0.003, release: 0.250, knee: 30 }
    };
    const DEFAULT_AUDIO_SETTINGS = {
        enabled: false,
        compressor: {
            enabled: false,
            preset: 'recommended',
            customParams: { ...AUDIO_PRESETS.custom }
        }
    };
    let audioCtx = null;
    let audioChains = new WeakMap();
    let currentAudioVideo = null;

    function mergeAudioSettings(settings = {}) {
        const safeSettings = settings && typeof settings === 'object' ? settings : {};
        return {
            ...DEFAULT_AUDIO_SETTINGS,
            ...safeSettings,
            compressor: {
                ...DEFAULT_AUDIO_SETTINGS.compressor,
                ...(safeSettings.compressor || {}),
                customParams: {
                    ...DEFAULT_AUDIO_SETTINGS.compressor.customParams,
                    ...(safeSettings.compressor?.customParams || {})
                }
            }
        };
    }

    function initAudioContext() {
        if (!audioCtx) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return null;
                audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
            } catch (e) {
                reportLog(`Audio Processing unavailable: ${e.message}`, 'warn');
                return null;
            }
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => { reportLog('AudioContext resume failed - browser may need page interaction first', 'warn'); });
        }
        return audioCtx;
    }

    function closeAudioContext() {
        if (audioCtx) {
            audioCtx.close().catch(() => {});
            audioCtx = null;
        }
        audioChains = new WeakMap();
        currentAudioVideo = null;
    }

    function setupAudioChain(videoEl) {
        if (audioChains.has(videoEl)) return audioChains.get(videoEl);
        const ctx = initAudioContext();
        if (!ctx) return null;

        try {
            const src = ctx.createMediaElementSource(videoEl);
            const compressor = ctx.createDynamicsCompressor();
            const dryGain = ctx.createGain();
            const compGain = ctx.createGain();

            src.connect(dryGain);
            dryGain.connect(ctx.destination);
            src.connect(compressor);
            compressor.connect(compGain);
            compGain.connect(ctx.destination);

            dryGain.gain.value = 1;
            compGain.gain.value = 0;

            const chain = { compressor, dryGain, compGain, active: false };
            audioChains.set(videoEl, chain);
            currentAudioVideo = videoEl;
            return chain;
        } catch (e) {
            reportLog(`Audio Processing setup failed: ${e.message}`, 'warn');
            return null;
        }
    }

    function rampGain(node, value, t) {
        const current = node.gain.value;
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(current, t);
        node.gain.linearRampToValueAtTime(value, t + 0.04);
    }

    function applyAudioBypass(videoEl) {
        const chain = audioChains.get(videoEl);
        if (!chain || !chain.active) return;
        const t = chain.dryGain.context.currentTime;
        rampGain(chain.dryGain, 1, t);
        rampGain(chain.compGain, 0, t);
        chain.active = false;
        reportLog('Audio compressor disabled', 'info');
    }

    function bypassCurrentAudioProcessing() {
        if (currentAudioVideo) applyAudioBypass(currentAudioVideo);
    }

    function applyAudioSettings(videoEl, settings) {
        const mergedSettings = mergeAudioSettings(settings);
        if (!mergedSettings.enabled || !mergedSettings.compressor?.enabled) {
            applyAudioBypass(videoEl);
            return;
        }

        const chain = setupAudioChain(videoEl);
        if (!chain) return;

        const cSettings = mergedSettings.compressor;
        const params = cSettings.preset === 'custom'
            ? cSettings.customParams
            : AUDIO_PRESETS[cSettings.preset] || AUDIO_PRESETS.recommended;

        chain.compressor.threshold.value = params.threshold ?? -24;
        chain.compressor.knee.value = params.knee ?? 15;
        chain.compressor.ratio.value = params.ratio ?? 8;
        chain.compressor.attack.value = params.attack ?? 0.010;
        chain.compressor.release.value = params.release ?? 0.300;

        if (!chain.active) {
            const t = chain.dryGain.context.currentTime;
            rampGain(chain.dryGain, 0, t);
            rampGain(chain.compGain, 1, t);
            chain.active = true;
            reportLog('Audio compressor enabled', 'info');
        }
    }

    // --- Episode Auto-Sync: Detection ---
    function getMediaTitle() {
        return (navigator.mediaSession && navigator.mediaSession.metadata)
            ? navigator.mediaSession.metadata.title
            : null;
    }

    // Extract a canonical episode identifier from a title string.
    // Handles: S01E01, S1E1, S01 - E01, Season 1 Episode 1, "Folge 5", "Episode 5", "Ep. 5", "#5"
    // Returns null if no episode pattern found.
    // --- SHARED_EPISODE_UTILS_INJECT_START ---
    // This block is automatically replaced by /scripts/build-extension.cjs
    function extractEpisodeId(title) {
        if (!title || typeof title !== 'string') return null;
        const se = title.match(/S(?:eason\s*)?(\d+)[^a-zA-Z0-9]*E(?:pisode\s*)?(\d+)/i);
        if (se) return `S${String(se[1]).padStart(2, '0')}E${String(se[2]).padStart(2, '0')}`;
        const ep = title.match(/(?:Episode|Folge|Ep\.?|#)\s*(\d+)/i);
        if (ep) return `EP${String(ep[1]).padStart(3, '0')}`;
        return null;
    }

    function sameEpisode(titleA, titleB) {
        if (!titleA && !titleB) return true;
        if (!titleA || !titleB) return false;
        const idA = extractEpisodeId(titleA);
        const idB = extractEpisodeId(titleB);
        if (idA && idB) return idA === idB;
        if (idA || idB) return false;
        return titleA === titleB;
    }
    // --- SHARED_EPISODE_UTILS_INJECT_END ---

    // Returns true only when we are CERTAIN the episodes differ.
    // Permissive: only blocks if BOTH titles have parseable IDs AND they differ.
    // Films, music, unparseable titles always pass through.
    function isDifferentEpisode(titleA, titleB) {
        if (!titleA || !titleB) return false; // Unknown → allow
        const idA = extractEpisodeId(titleA);
        const idB = extractEpisodeId(titleB);
        if (!idA || !idB) return false; // At least one unparseable → allow
        return idA !== idB;             // Both parseable → only block if different
    }
    function checkEpisodeTransition() {

        const currentTitle = getMediaTitle();

        const video = findVideo();

        const current = video ? getSyncCurrentTime(video) : null;
        // Only trigger if: we had a previous title, the title changed,
        // a video exists, and we're near the start of new content.
        if (lastKnownMediaTitle && currentTitle
            && !sameEpisode(currentTitle, lastKnownMediaTitle)
            && video
            && current !== null && current < 5
            && video.readyState >= 1) {
            onEpisodeTransition(currentTitle);
        }

        // Always track the latest known title
        if (currentTitle) lastKnownMediaTitle = currentTitle;
    }

    function onEpisodeTransition(newTitle) {
        // Debounce: prevent duplicate fires from multiple signals
        if (episodeTransitionDebounce) return;
        episodeTransitionDebounce = setTimeout(() => {
            episodeTransitionDebounce = null;
        }, 2000);

        reportLog(`Episode transition detected: "${newTitle}"`, 'info');

        // EC-12: a new episode dissolves any solo/desync state — the guest rejoins
        // the room for the fresh content rather than staying stuck on the old one.
        if (hcmDesynced) hcmReset();

        // Do NOT pause here. We notify background.js first.
        // Background checks the setting; if enabled it creates a lobby
        // and sends back PAUSE_FOR_LOBBY so we only freeze if the feature is on.
        chrome.runtime.sendMessage({
            type: 'EPISODE_CHANGED',
            payload: { newTitle }
        }).catch(() => {});
    }
    function checkAndReportLobbyReady(expectedTitle) {

        const video = findVideo();

        const currentTitle = getMediaTitle();

        const current = video ? getSyncCurrentTime(video) : null;
        if (video && currentTitle && sameEpisode(currentTitle, expectedTitle)
            && current !== null && current < 5 && video.readyState >= 1) {
            // Match! Pause at start and report ready.
            if (!video.paused) {
                _setSuppress('paused');
                video.pause();
            }
            stopLobbyPoll();
            chrome.runtime.sendMessage({
                type: 'EPISODE_READY_LOCAL',
                payload: { title: currentTitle }
            }).catch(() => {});
            reportLog(`Episode lobby: Ready for "${currentTitle}"`, 'success');
            return true;
        }
        return false;
    }

    function startLobbyPoll(expectedTitle) {
        stopLobbyPoll();
        _pendingLobbyTitle = expectedTitle;

        // NOTE: Do NOT pause here. Three callers reach this function:
        // 1. PAUSE_FOR_LOBBY (initiator): already paused by that handler before calling us.
        // 2. EPISODE_LOBBY (non-initiator): peer may still be on the PREVIOUS episode — pausing
        //    would freeze them mid-episode. The pause happens inside checkAndReportLobbyReady()
        //    only once their title actually matches.
        // 3. CONTENT_BOOT recovery: same reasoning as (2).

        // Check immediately
        if (checkAndReportLobbyReady(expectedTitle)) return;

        // Poll every 2 seconds — no log spam, internal only
        lobbyPollTimer = setInterval(() => {
            checkAndReportLobbyReady(expectedTitle);
        }, 2000);
    }


    function stopLobbyPoll() {
        _pendingLobbyTitle = null;
        if (lobbyPollTimer) {
            clearInterval(lobbyPollTimer);
            lobbyPollTimer = null;
        }
    }

    function getPlayerActionFixes() {
        return [
            {
                name: 'youtube-player-buttons',
                urls: ['youtube.com'],
                playPauseButtonSelector: '.ytp-play-button'
            },
            {
                name: 'twitch-player-buttons',
                urls: ['twitch.tv'],
                playPauseButtonSelector: '[data-a-target="player-play-pause-button"]'
            }
        ];
    }

    function getActivePlayerActionFix() {
        return getPlayerActionFixes().find(fix => matchesPlayerUrls(fix.urls)) || null;
    }

    function tryPlayerActionFix(fix, action, video, data) {
        if (!fix) return false;
        const button = document.querySelector(fix.playPauseButtonSelector);
        if (!button) return false;

        const isCurrentlyPlaying = !video.paused;
        if ((action === EVENTS.PLAY && !isCurrentlyPlaying) || (action === EVENTS.PAUSE && isCurrentlyPlaying)) {
            _setSuppress(action === EVENTS.PLAY ? 'playing' : 'paused');
            button.click();
        }
        if (action === EVENTS.SEEK) {
            seekVideo(video, data.targetTime, data.delta);
        }
        return true;
    }

    // --- Helper: site-specific player actions, then native HTML5 fallback ---
    function tryMediaAction(action, data) {
        const video = findVideo();
        if (!video) return;

        if (action === EVENTS.SEEK) {
            const target = data ? (data.targetTime !== undefined ? data.targetTime : data.currentTime) : undefined;
            if (!Number.isFinite(target)) {
                reportLog(`Media Action Error: Invalid seek payload - ${JSON.stringify(data)}`, 'error');
                return;
            }
            data = { ...data, targetTime: target };
        }

        try {
            const actionFix = getActivePlayerActionFix();
            if (tryPlayerActionFix(actionFix, action, video, data)) {
                return;
            }

            // Fallback for native HTML5
            if (action === EVENTS.PLAY) {
                _setSuppress('playing');
                video.play().catch((e) => {
                    reportLog(`Playback prevented: ${e.message}`, 'warn');
                    _clearSuppress('playing');
                });
            } else if (action === EVENTS.PAUSE) {
                _setSuppress('paused');
                video.pause();
            } else if (action === EVENTS.SEEK) {
                seekVideo(video, data.targetTime, data.delta);
            }
    } catch (e) {
            reportLog(`Media Action Error: ${e.message}`, 'error');
        }
    }

    // --- Helper: Wait until video is ready for playback (buffered & seeked) ---
    function pollSeekReady(targetTime, timeoutMs = 8000) {
        return new Promise((resolve) => {
            const interval = 150;
            let elapsed = 0;
            const timer = setInterval(() => {
                const video = findVideo(); // Re-query DOM on every iteration
                if (!video) {
                    clearInterval(timer);
                    resolve(false);
                    return;
                }

                elapsed += interval;
                const current = getSyncCurrentTime(video);
                const timeDiff = current !== null ? Math.abs(current - targetTime) : Infinity;
                const ready = video.readyState >= 3 && timeDiff < 2.0;
                if (ready) {
                    clearInterval(timer);
                    resolve(true);
                } else if (elapsed >= timeoutMs) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, interval);
        });
    }

    // Listen for commands from background.js
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;
        if (message.action === 'get_current_time') {
            const video = findVideo();
            sendResponse({ currentTime: video ? getSyncCurrentTime(video) : null });
            return true;
        }

        if (message.action === 'APPLY_AUDIO_SETTINGS') {
            _audioProcessingAllowed = true;
            _audioSettings = mergeAudioSettings(message.settings);
            const video = findVideo();
            if (video) applyAudioSettings(video, _audioSettings);
            sendResponse({ ok: true });
            return true;
        }

        if (message.action === 'RESET_AUDIO_PROCESSING') {
            _audioProcessingAllowed = false;
            bypassCurrentAudioProcessing();
            sendResponse({ ok: true });
            return true;
        }

        // Host Control Mode: room mode/role changed.
        if (message.type === 'CONTROL_MODE') {
            const wasGated = hcmIsGuestGated();
            const prevHostPeerId = hcmHostPeerId;
            hcmControlMode = message.controlMode || 'everyone';
            hcmAmController = !!message.amController;
            hcmHostPeerId = message.hostPeerId || null;
            // Reset guest-side state when leaving the gated state, OR when the
            // host identity changes (room switch, host-leave fallback, missed
            // teardown broadcast) — clears stale desync so a rejoin starts clean (H-3).
            const hostChanged = prevHostPeerId !== null && hcmHostPeerId !== prevHostPeerId;
            if ((wasGated && !hcmIsGuestGated()) || hostChanged) hcmReset();
            sendResponse({ ok: true });
            return true;
        }

        // Host Control Mode: background blocked our local action — handle UX locally.
        if (message.type === 'HOST_BLOCKED') {
            hcmHandleBlocked(message.action, message.target || null);
            sendResponse({ ok: true });
            return true;
        }

        // Background asks for an immediate state push (e.g. the first peer just
        // joined while we were solo) so the newcomer syncs without waiting.
        if (message.type === 'REQUEST_HEARTBEAT') {
            sendHeartbeat();
            sendResponse({ ok: true });
            return true;
        }

        if (message.type === 'SERVER_COMMAND') {
            const { action, payload } = message;
            let actionCompleted = false;

            // Host Control Mode: while watching on our own (desynced), don't apply
            // host commands. Only ACK FORCE_SYNC_PREPARE — that's the one the host's
            // force-sync flow actually waits on. Skipping CMD_ACKs for PLAY/PAUSE/SEEK
            // is intentional so the host's UI honestly reflects that we didn't apply
            // the command (M-2); sending them would make the host think we're synced.
            if (hcmDesynced) {
                const soloIgnored = [EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK, EVENTS.FORCE_SYNC_PREPARE, EVENTS.FORCE_SYNC_EXECUTE];
                if (soloIgnored.includes(action)) {
                    if (action === EVENTS.FORCE_SYNC_PREPARE) {
                        chrome.runtime.sendMessage({ type: 'FORCE_SYNC_ACK' }).catch(() => {});
                    }
                    return;
                }
            }

            // Guard: Don't execute sync commands if peers are on different episodes.
            // Only active when autoSyncNextEpisode setting is enabled (default: on).
            // Only blocks when BOTH sides have parseable S01E01-style IDs that differ.
            // Films and unparseable titles always pass through.
            const syncActions = [EVENTS.PLAY, EVENTS.PAUSE, EVENTS.SEEK,
                                 EVENTS.FORCE_SYNC_PREPARE, EVENTS.FORCE_SYNC_EXECUTE];
            if (_autoSyncEnabled && syncActions.includes(action)) {
                const senderTitle = payload?.mediaTitle;
                const myTitle = getMediaTitle();
                if (isDifferentEpisode(senderTitle, myTitle)) {
                    reportLog(`Episode mismatch: sender="${senderTitle || '?'}" vs mine="${myTitle || '?'}" — skipping ${action}. Disable "Auto-Sync next Episode" in settings if this causes issues.`, 'warn');
                    if (action !== EVENTS.FORCE_SYNC_PREPARE && action !== EVENTS.FORCE_SYNC_EXECUTE) {
                        chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp, commandSenderId: message.commandSenderId }).catch(() => {});
                    }
                    return;
                }
            }
            
            if (action === EVENTS.PLAY) {
                tryMediaAction(EVENTS.PLAY);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp, commandSenderId: message.commandSenderId });
                actionCompleted = true;
            } else if (action === EVENTS.PAUSE) {
                tryMediaAction(EVENTS.PAUSE);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp, commandSenderId: message.commandSenderId });
                actionCompleted = true;
            } else if (action === EVENTS.SEEK) {
                tryMediaAction(EVENTS.SEEK, payload);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp, commandSenderId: message.commandSenderId });
                actionCompleted = true;
            } else if (action === EVENTS.FORCE_SYNC_PREPARE) {
                if (!payload || payload.targetTime === undefined) return;
                const video = findVideo();
                if (video) {
                    if (!Number.isFinite(payload.targetTime)) {
                        reportLog(`Media Action Error: Invalid force sync payload - ${JSON.stringify(payload)}`, 'error');
                        return;
                    }
                    _setSuppress('paused');
                    video.pause();
                    try {
                        seekVideo(video, payload.targetTime);
                    } catch (e) {
                        reportLog(`Force Sync Seek Error: ${e.message}`, 'error');
                    }
                    pollSeekReady(payload.targetTime).then((ready) => {
                        chrome.runtime.sendMessage({ type: 'FORCE_SYNC_ACK' }).catch(() => {});
                        if (ready) {
                            scheduleProactiveHeartbeat();
                        } else {
                            reportLog('Force Sync: Seek ready timeout, proceeding anyway', 'warn');
                        }
                    }).catch(() => {});
                }
            } else if (action === EVENTS.FORCE_SYNC_EXECUTE) {
                stopLobbyPoll();
                tryMediaAction(EVENTS.PLAY);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp, commandSenderId: message.commandSenderId });
                actionCompleted = true;
            }

            if (actionCompleted) {
                scheduleProactiveHeartbeat();
            }
        }

        // Episode Auto-Sync: Lobby notification from background
        if (message.type === 'EPISODE_LOBBY') {
            // Host Control Mode: a desynced guest is watching on their own and must
            // not join the lobby flow. Otherwise they'd pause on title match, report
            // ready, but then ignore the host's FORCE_SYNC_* (hcmDesynced skip in
            // SERVER_COMMAND) and end up frozen in pause. They also can't be counted
            // toward lobby completion (background filters them out).
            if (hcmDesynced) {
                sendResponse({ status: 'ignored_desynced' });
                return true;
            }
            const expectedTitle = message.expectedTitle;
            if (expectedTitle) {
                reportLog(`Episode lobby received: waiting for "${expectedTitle}"`, 'info');
                startLobbyPoll(expectedTitle);
            }
            sendResponse({ status: 'ok' });
            return true;
        }

        // Episode Auto-Sync: Lobby cancelled by background
        if (message.type === 'EPISODE_LOBBY_CANCEL') {
            stopLobbyPoll();
            sendResponse({ status: 'ok' });
            return true;
        }

        // Episode Auto-Sync: Background confirmed lobby created, pause the video
        if (message.type === 'PAUSE_FOR_LOBBY') {
            const video = findVideo();
            if (video && !video.paused) {
                _setSuppress('paused');
                video.pause();
            }
            // Start lobby poll now that we know the feature is enabled
            if (message.expectedTitle) {
                startLobbyPoll(message.expectedTitle);
            }
            sendResponse({ status: 'ok' });
            return true;
        }

        if (message.type === 'GET_VIDEO_STATE') {
            const video = findVideo();

            const platform = (() => {
                const h = window.location.hostname.toLowerCase();
                if (h === 'youtube.com' || h.endsWith('.youtube.com')) return 'YouTube';
                if (h === 'twitch.tv' || h.endsWith('.twitch.tv')) return 'Twitch';
                if (h === 'netflix.com' || h.endsWith('.netflix.com')) return 'Netflix';
                if (h === 'primevideo.com' || h.endsWith('.primevideo.com') || /(^|\.)amazon\.(com\.[a-z]{2}|co\.[a-z]{2}|[a-z]{2,})$/.test(h)) return 'Prime Video';
                if (h === 'disneyplus.com' || h.endsWith('.disneyplus.com')) return 'Disney+';
                if (h === 'hulu.com' || h.endsWith('.hulu.com')) return 'Hulu';
                if (h === 'hbomax.com' || h.endsWith('.hbomax.com') || h === 'max.com' || h.endsWith('.max.com')) return 'Max/HBO';
                if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) return 'Vimeo';
                if (h === 'dailymotion.com' || h.endsWith('.dailymotion.com')) return 'Dailymotion';
                return 'Generic';
            })();

            const networkStates = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
            const readyStates = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];

            const videoCount = document.querySelectorAll('video').length;
            const inShadowDom = (() => {
                let el = video;
                while (el) {
                    if (el.toString() === '[object ShadowRoot]') return true;
                    el = el.parentNode;
                }
                // Also check if any potential host has shadow root (even if no video found)
                if (!video) {
                    const hosts = document.querySelectorAll('[id*="player" i], [class*="player" i], [id*="video" i], [class*="video" i]');
                    for (const host of hosts) {
                        if (host.shadowRoot) return true;
                    }
                }
                return false;
            })();

            // Build multi-video summary for debug reports
            const allVideos = [];
            const allVideoEls = document.querySelectorAll('video');
            for (let i = 0; i < allVideoEls.length; i++) {
                const v = allVideoEls[i];
                allVideos.push({
                    index: i,
                    width: v.videoWidth || v.offsetWidth || 0,
                    height: v.videoHeight || v.offsetHeight || 0,
                    muted: v.muted,
                    paused: v.paused,
                    duration: (v.duration && isFinite(v.duration)) ? Math.round(v.duration) : 0,
                    readyState: v.readyState,
                    src: (v.currentSrc || v.src || '').substring(0, 80),
                    selected: v === video
                });
            }

            if (video) {
                const dataAttributes = {};
                if (video.attributes) {
                    for (const attr of video.attributes) {
                        if (attr.name.startsWith('data-')) {
                            dataAttributes[attr.name] = attr.value;
                        }
                    }
                }

                const metadata = (navigator.mediaSession && navigator.mediaSession.metadata) ? {
                    title: navigator.mediaSession.metadata.title,
                    artist: navigator.mediaSession.metadata.artist,
                    album: navigator.mediaSession.metadata.album,
                    artwork: Array.from(navigator.mediaSession.metadata.artwork || []).map(a => a.src)
                } : null;

                const errorInfo = video.error ? {
                    code: video.error.code,
                    message: video.error.message
                } : null;

                sendResponse({
                    found: true,
                    paused: video.paused,
                    currentTime: getSyncCurrentTime(video),
                    duration: getSyncDuration(video),
                    nativeCurrentTime: video.currentTime,
                    nativeDuration: Number.isFinite(video.duration) ? video.duration : 0,
                    readyState: video.readyState,
                    readyStateLabel: readyStates[video.readyState] || 'UNKNOWN',
                    networkState: video.networkState,
                    networkStateLabel: networkStates[video.networkState] || 'UNKNOWN',
                    muted: video.muted,
                    volume: video.volume,
                    playbackRate: video.playbackRate,
                    videoWidth: video.videoWidth,
                    videoHeight: video.videoHeight,
                    seeking: video.seeking,
                    ended: video.ended,
                    error: errorInfo,
                    buffered: video.buffered && video.buffered.length > 0
                        ? Array.from({ length: video.buffered.length }, (_, i) =>
                            `${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}s`).join(', ')
                        : 'none',
                    loop: video.loop,
                    url: window.location.href,
                    pageTitle: document.title,
                    id: video.id || 'none',
                    className: video.className || 'none',
                    src: video.src || 'none',
                    currentSrc: video.currentSrc || 'none',
                    dataAttributes,
                    metadata,
                    videoCount,
                    inShadowDom,
                    platform,
                    siteQuirk: getSiteQuirkDebug(video),
                    allVideos
                });
            } else {
                sendResponse({
                    found: false,
                    videoCount,
                    inShadowDom,
                    platform,
                    allVideos,
                    url: window.location.href,
                    pageTitle: document.title,
                    metadata: (navigator.mediaSession && navigator.mediaSession.metadata) ? {
                        title: navigator.mediaSession.metadata.title,
                        artist: navigator.mediaSession.metadata.artist,
                        album: navigator.mediaSession.metadata.album
                    } : null
                });
            }
        }
    });

    // Detect native events
    // Build the relay payload from the *current* media state and send it to
    // background.js. Re-reads the video each call so deferred (coalesced) emits
    // carry an up-to-date position. Safe with no/invalid video — it no-ops.
    function sendContentEvent(action) {
        const video = findVideo();
        if (!video) return;

        const current = getSyncCurrentTime(video);
        if (current === null) return;

        const mediaTitle = (navigator.mediaSession && navigator.mediaSession.metadata) ? navigator.mediaSession.metadata.title : null;

        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: {
                currentTime: current,
                targetTime: current,
                mediaTitle: mediaTitle,
                timestamp: Date.now()
            }
        }).catch(() => {});

        // Trigger proactive heartbeat to push stabilized state
        scheduleProactiveHeartbeat();
    }

    // Trailing-edge flush of a coalesced play/pause burst: emit the final settled
    // state. No-ops only when no burst followed the leading edge. We do NOT skip
    // when the state matches the leading send — a remote command may have changed
    // the shared state mid-window, so re-sending is the safe (idempotent) choice.
    function flushPlayPause() {
        playPauseCoalesceTimer = null;
        const finalAction = pendingPlayPauseAction;
        pendingPlayPauseAction = null;
        // No burst follow-up (only the leading edge fired), or invalid state.
        if (finalAction !== EVENTS.PLAY && finalAction !== EVENTS.PAUSE) return;
        sendContentEvent(finalAction);
    }

    function reportEvent(action) {
        if (seekDebounceTimer && (action === EVENTS.PLAY || action === EVENTS.PAUSE)) {
            clearTimeout(seekDebounceTimer);
            seekDebounceTimer = null;
            const v = findVideo();
            if (v) {
                const syncTime = getSyncCurrentTime(v);
                if (syncTime === null) return;
                lastReportedSeekTime = syncTime;
                reportLog(`[Seek] Debounce flushed immediately due to ${action.toUpperCase()}`, 'info');
                reportEvent(EVENTS.SEEK);
            }
        }

        const video = findVideo();
        if (!video) return;

        const current = getSyncCurrentTime(video);
        if (current === null) return;

        const eventState = action === EVENTS.PLAY ? 'playing' : (action === EVENTS.PAUSE ? 'paused' : (action === EVENTS.SEEK ? 'seek' : null));

        // Echo-suppression for remotely-applied commands. MUST stay synchronous
        // on event arrival: the suppress timer is short-lived (300ms) and would
        // expire if deferred, leaking an echo back to peers.
        if (_suppressTimers[eventState]) {
            _clearSuppress(eventState);
            return;
        }

        // Suppress only SEEK during visibility grace period (tab re-focus ghost jump).
        // Play/Pause pass through — user may want to immediately pause after tabbing back.
        if (Date.now() < visibilityGraceUntil && action === EVENTS.SEEK) return;

        // Coalesce play/pause bursts (source swaps, ABR, ads, teardown). The
        // synchronous gates above have already run; only the network emit is
        // governed here. Leading edge sends the first event instantly; further
        // events within the window are collapsed to the final state by the
        // trailing flush. A pending burst is REPLACED, never dropped — the last
        // event in the window always wins.
        if (action === EVENTS.PLAY || action === EVENTS.PAUSE) {
            if (playPauseCoalesceTimer === null) {
                // Window closed → fresh action. Emit now (zero added latency).
                sendContentEvent(action);
                pendingPlayPauseAction = null;
            } else {
                // Window open → part of a burst. Defer to the trailing flush.
                pendingPlayPauseAction = action;
                clearTimeout(playPauseCoalesceTimer);
            }
            playPauseCoalesceTimer = setTimeout(flushPlayPause, PLAY_PAUSE_COALESCE_MS);
            return;
        }

        // SEEK (and any non play/pause action): emit immediately.
        sendContentEvent(action);
    }

    // --- Tab Visibility Handling ---
    // Browsers (especially Firefox) aggressively throttle background tabs.
    // When the user returns to a video tab, the video element may have lost
    // time-sync and fires spurious seek events as it recovers (jumping back).
    // We suppress only SEEK for a short grace period after tab re-focus.
    // Play/Pause are NOT suppressed — the user may legitimately want to
    // pause immediately after switching back.
    let pageVisible = !document.hidden;
    let visibilityGraceUntil = 0;
    const VISIBILITY_GRACE_MS = 300;

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            pageVisible = false;
        } else if (!pageVisible) {
            pageVisible = true;
            visibilityGraceUntil = Date.now() + VISIBILITY_GRACE_MS;
            reportLog(`Tab re-focused — suppressing seeks for ${VISIBILITY_GRACE_MS / 1000}s to prevent ghost relay`, 'warn');
        }
    });

    // Reset on page hide/show (bfcache, tab discard)
    window.addEventListener('pagehide', () => {
        pageVisible = false;
        closeAudioContext();
        if (keepAlivePort) { try { keepAlivePort.disconnect(); } catch (_e) { /* ignore */ } keepAlivePort = null; }
        if (lobbyPollTimer) { clearInterval(lobbyPollTimer); lobbyPollTimer = null; }
        if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
        if (proactiveHeartbeatTimeout) { clearTimeout(proactiveHeartbeatTimeout); proactiveHeartbeatTimeout = null; }
        // Drop any pending coalesced play/pause: we are tearing down and will
        // disconnect — peers learn we are gone via PEER_STATUS 'left'. This also
        // intentionally suppresses the teardown play/pause burst at the source.
        if (playPauseCoalesceTimer) { clearTimeout(playPauseCoalesceTimer); playPauseCoalesceTimer = null; pendingPlayPauseAction = null; }
        observer.disconnect();
    });
    window.addEventListener('pageshow', (event) => {
        // event.persisted is true ONLY when restored from bfcache, not on initial load
        if (event.persisted && !pageVisible) {
            pageVisible = true;
            visibilityGraceUntil = Date.now() + VISIBILITY_GRACE_MS;
            reportLog(`Page restored from cache — suppressing seeks for ${VISIBILITY_GRACE_MS / 1000}s`, 'warn');
        }
    });

    const handlePlay = () => reportEvent(EVENTS.PLAY);
    const handlePause = () => reportEvent(EVENTS.PAUSE);
    // Host Control Mode: a 'waiting' (buffering) event opens a grace window so the
    // pause it may trigger isn't misread as a deliberate guest action (EC-1).
    const handleWaiting = () => { hcmBufferingUntil = Date.now() + HCM_BUFFERING_GRACE_MS; };

    // Seek filtering: ignore HLS/DASH buffering micro-seeks.
    // Only relay if delta >= MIN_SEEK_DELTA AND not already debouncing.
    const handleSeeked = () => {
        const video = findVideo();
        if (!video) return;
        const current = getSyncCurrentTime(video);
        if (current === null) return;

        // Step 1: Check expectedSeekTime (programmatic seek from remote peer)
        if (expectedSeekTime !== null) {
            if (Math.abs(current - expectedSeekTime) < 1.0) {
                // Video arrived at expected time. Safely clear and ignore.
                expectedSeekTime = null;
                lastReportedSeekTime = current;
                return;
            } else {
                // User manually scrubbed to a DIFFERENT time while we were buffering
                expectedSeekTime = null;
            }
        }

        // Step 2: Suppress during visibility grace period (tab re-focus ghost events)
        if (Date.now() < visibilityGraceUntil) return;

        const delta = lastReportedSeekTime !== null ? Math.abs(current - lastReportedSeekTime) : null;
        const deltaStr = delta !== null ? `Δ${delta.toFixed(2)}s` : 'Δ?';

        // Step 3: Delta check — skip micro-seeks (buffering, chapter markers, etc.)
        if (lastReportedSeekTime !== null && delta < MIN_SEEK_DELTA) {
            reportLog(`[Seek] Filtered (${deltaStr} < ${MIN_SEEK_DELTA}s threshold) @ ${current.toFixed(2)}s — not relayed`, 'warn');
            return;
        }

        // Step 4: Debounce rapid consecutive seeks (e.g. scrubbing)
        // — wait 300ms for the user to settle before relaying
        if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
        seekDebounceTimer = setTimeout(() => {
            seekDebounceTimer = null;
            const v = findVideo();
            if (!v) return;
            const settled = getSyncCurrentTime(v);
            if (settled === null) return;
            const finalDelta = lastReportedSeekTime !== null ? Math.abs(settled - lastReportedSeekTime) : null;
            const finalDeltaStr = finalDelta !== null ? `Δ${finalDelta.toFixed(2)}s` : 'Δ?';
            lastReportedSeekTime = settled;
            reportLog(`[Seek] Relayed @ ${settled.toFixed(2)}s (${finalDeltaStr})`, 'info');
            reportEvent(EVENTS.SEEK);
        }, 300);
    };


    let lastVideoSrc = undefined;

    // Episode detection handler for loadeddata event
    const handleLoadedData = () => {
        checkEpisodeTransition();
    };

    function setupListeners() {
        const video = findVideo();
        if (video) {
            if (currentAudioVideo && currentAudioVideo !== video) {
                bypassCurrentAudioProcessing();
            }
            const existing = video._koalaHandlers;
            if (existing) {
                video.removeEventListener('play', existing.play);
                video.removeEventListener('pause', existing.pause);
                video.removeEventListener('seeked', existing.seeked);
                video.removeEventListener('loadeddata', existing.loadeddata);
                if (existing.waiting) video.removeEventListener('waiting', existing.waiting);
            }
            video._koalaHandlers = { play: handlePlay, pause: handlePause, seeked: handleSeeked, loadeddata: handleLoadedData, waiting: handleWaiting };
            video.addEventListener('play', handlePlay);
            video.addEventListener('pause', handlePause);
            video.addEventListener('seeked', handleSeeked);
            video.addEventListener('loadeddata', handleLoadedData);
            video.addEventListener('waiting', handleWaiting);
            video.dataset.koalaAttached = 'true';
            lastVideoSrc = video.currentSrc || video.src || null;

            if (!lastKnownMediaTitle) {
                lastKnownMediaTitle = getMediaTitle();
            }

            if (_audioSettings && _audioProcessingAllowed) applyAudioSettings(video, _audioSettings);
        }
    }

    // SPA Navigation Handler (MutationObserver)
    let lastMutate = 0;
    let observerTimeout = null;

    function checkVideo() {
        lastMutate = Date.now();
        const video = findVideo();

        if (!video && lastVideoSrc !== undefined) {
            reportLog('Video element removed from page', 'warn');
            lastVideoSrc = undefined;
            closeAudioContext();
            return;
        }

        if (!video) return;

        const currentSrc = video.currentSrc || video.src || null;

        if (!video.dataset.koalaAttached || (lastVideoSrc !== undefined && currentSrc && lastVideoSrc !== currentSrc)) {
            if (lastVideoSrc !== undefined && currentSrc && lastVideoSrc !== currentSrc) {
                checkEpisodeTransition();
            }
            setupListeners();
        }
    }

    const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastMutate >= 1000) {
            checkVideo();
        } else {
            if (observerTimeout) clearTimeout(observerTimeout);
            observerTimeout = setTimeout(checkVideo, 1000 - (now - lastMutate));
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // --- SHARED_HEARTBEAT_INJECT_START ---
    const HEARTBEAT_INTERVAL_VAL = 15000;
    // --- SHARED_HEARTBEAT_INJECT_END ---

    // Heartbeat Refactoring (Self-scheduling setTimeout with proactive heartbeat scheduling)
    let heartbeatTimeout = null;
    let proactiveHeartbeatTimeout = null;
    let heartbeatErrorCount = 0;

    function sendHeartbeat() {
        const video = findVideo();
        if (!video) return;

        const mediaTitle = (navigator.mediaSession && navigator.mediaSession.metadata) ? navigator.mediaSession.metadata.title : null;
        chrome.runtime.sendMessage({
            type: 'HEARTBEAT',
            payload: {
                playbackState: video.paused ? 'paused' : 'playing',
                currentTime: getSyncCurrentTime(video),
                mediaTitle: mediaTitle,
                volume: video.volume,
                muted: video.muted
            }
        }).catch(err => {
            if (err.message.includes('Extension context invalidated')) {
                heartbeatErrorCount++;
                if (heartbeatErrorCount === 1) {
                    reportLog('Extension reloaded. Please refresh the page if sync stops working.', 'warn');
                }
                if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
                if (proactiveHeartbeatTimeout) clearTimeout(proactiveHeartbeatTimeout);
                observer.disconnect();
            }
        });
    }

    function schedulePeriodicHeartbeat() {
        if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
        heartbeatTimeout = setTimeout(() => {
            sendHeartbeat();
            schedulePeriodicHeartbeat();
        }, HEARTBEAT_INTERVAL_VAL);
    }

    function scheduleProactiveHeartbeat() {
        if (proactiveHeartbeatTimeout) clearTimeout(proactiveHeartbeatTimeout);
        proactiveHeartbeatTimeout = setTimeout(() => {
            sendHeartbeat();
            schedulePeriodicHeartbeat(); // Reschedules the next periodic check to be exactly 15s from now
        }, 500); // 500ms stabilization delay
    }

    // Initial Setup
    setupListeners();

    // Maintain a persistent keep-alive port connection to prevent background SW suspension
    let keepAlivePort = null;
    function connectKeepAlivePort() {
        try {
            if (chrome.runtime.id) {
                keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
                keepAlivePort.onDisconnect.addListener(() => {
                    keepAlivePort = null;
                    setTimeout(connectKeepAlivePort, 1000);
                });
            }
        } catch (_e) {
            // Extension context invalidated or disabled
        }
    }
    connectKeepAlivePort();

    schedulePeriodicHeartbeat();

    // Immediate heartbeat on injection — populate peer data without waiting 15s
    setTimeout(() => sendHeartbeat(), 300);

    // Episode Auto-Sync: Boot recovery — check if background has an active lobby
    chrome.runtime.sendMessage({ type: 'CONTENT_BOOT' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && res.lobbyActive && res.expectedTitle) {
            reportLog(`Boot: Active lobby detected for "${res.expectedTitle}"`, 'info');
            startLobbyPoll(res.expectedTitle);
        }
    });

    // Host Control Mode: fetch current room mode/role on injection (we may have
    // been injected after ROOM_DATA already arrived, missing the broadcast).
    chrome.runtime.sendMessage({ type: 'GET_CONTROL_MODE' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        hcmControlMode = res.controlMode || 'everyone';
        hcmAmController = !!res.amController;
        hcmHostPeerId = res.hostPeerId || null;
        // Re-adopt persisted desync after a page reload so we don't start synced
        // while background still relays us as "Solo" to the host (split-brain).
        // Only when we're actually a gated guest — never adopt a stale flag as a
        // controller or in 'everyone' mode (would self-label "Solo" / ignore commands).
        if (res.desynced && res.controlMode === 'host-only' && !res.amController && !hcmDesynced) {
            hcmDesynced = true;
            hcmShowBadge();
        }
    });

    // Pull localized strings for the in-page dialog/badge (English fallback above).
    chrome.runtime.sendMessage({ type: 'GET_HCM_STRINGS' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        Object.keys(hcmStrings).forEach(k => { if (res[k]) hcmStrings[k] = res[k]; });
        // If the badge is already showing (early desync), refresh its text in place.
        // Re-creating the host element nukes the click target mid-poll and can drop a
        // click that landed between remove() and the re-create (L-4).
        if (hcmBadgeHost) {
            const span = hcmBadgeHost.shadowRoot && hcmBadgeHost.shadowRoot.querySelector('span');
            if (span) span.textContent = '● ' + hcmStrings.badge;
        }
    });

})();
