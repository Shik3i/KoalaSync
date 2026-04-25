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
    } catch (e) {
        // Context invalidated, proceed with re-injection
    }
    window.koalaSyncInjected = true;

    // Local Protocol Constants (Mirroring shared/constants.js)
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

    let expectedEvents = new Set();
    let expectedTimeouts = {};

    // --- Seek Relay Filtering ---
    // Minimum seek delta (seconds) to report. Prevents HLS/DASH buffering micro-seeks
    // from being relayed to peers as user-initiated seeks.
    const MIN_SEEK_DELTA = 3.0;
    let lastReportedSeekTime = null;  // last currentTime we relayed as a SEEK
    let seekDebounceTimer = null;     // debounce timer for rapid seek events

    // --- Episode Auto-Sync State ---
    let lastKnownMediaTitle = null;
    let episodeTransitionDebounce = null;
    let pendingLobbyTitle = null; // Title we're waiting to match (from remote lobby)
    let lobbyPollTimer = null;

    function expectEvent(state) {
        expectedEvents.add(state);
        if (expectedTimeouts[state]) clearTimeout(expectedTimeouts[state]);
        const timeout = state === 'seek' ? 10000 : 1500;
        expectedTimeouts[state] = setTimeout(() => {
            expectedEvents.delete(state);
        }, timeout);
    }

    function reportLog(message, level = 'info') {
        chrome.runtime.sendMessage({ type: 'LOG', message, level }).catch(() => {});
    }

    // --- Helper: find the best video element on the page ---
    function findVideo() {
        const videos = document.querySelectorAll('video');
        return videos.length > 0 ? videos[0] : null;
    }

    // --- Episode Auto-Sync: Detection ---
    function getMediaTitle() {
        return (navigator.mediaSession && navigator.mediaSession.metadata)
            ? navigator.mediaSession.metadata.title
            : null;
    }

    function checkEpisodeTransition() {
        const currentTitle = getMediaTitle();
        const video = findVideo();

        // Only trigger if: we had a previous title, the title changed,
        // a video exists, and we're near the start of new content.
        if (lastKnownMediaTitle && currentTitle
            && currentTitle !== lastKnownMediaTitle
            && video
            && video.currentTime < 5
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

        if (video && currentTitle && currentTitle === expectedTitle
            && video.currentTime < 5 && video.readyState >= 1) {
            // Match! Pause at start and report ready.
            if (!video.paused) {
                expectEvent('paused');
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
        pendingLobbyTitle = expectedTitle;

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
        pendingLobbyTitle = null;
        if (lobbyPollTimer) {
            clearInterval(lobbyPollTimer);
            lobbyPollTimer = null;
        }
    }

    // --- Helper: YouTube/Twitch specific actions ---
    function tryMediaAction(action, data) {
        const video = findVideo();
        if (!video) return;

        if (action === EVENTS.SEEK) {
            const target = data ? (data.targetTime !== undefined ? data.targetTime : data.currentTime) : undefined;
            if (!Number.isFinite(target)) {
                reportLog(`Media Action Error: Invalid seek payload - ${JSON.stringify(data)}`, 'error');
                return;
            }
            data.targetTime = target;
        }

        try {
            const host = window.location.hostname.toLowerCase();
            const isYouTube = host.includes('youtube.com');
            const isTwitch  = host.includes('twitch.tv');

            if (isYouTube) {
                const ytButton = document.querySelector('.ytp-play-button');
                if (ytButton) {
                    const isCurrentlyPlaying = !video.paused;
                    if ((action === EVENTS.PLAY && !isCurrentlyPlaying) || (action === EVENTS.PAUSE && isCurrentlyPlaying)) {
                        expectEvent(action === EVENTS.PLAY ? 'playing' : 'paused');
                        ytButton.click();
                    }
                    if (action === EVENTS.SEEK) {
                        expectEvent('seek');
                        video.currentTime = data.targetTime;
                    }
                    return;
                }
            }

            if (isTwitch) {
                const twitchButton = document.querySelector('[data-a-target="player-play-pause-button"]');
                if (twitchButton) {
                    const isCurrentlyPlaying = !video.paused;
                    if ((action === EVENTS.PLAY && !isCurrentlyPlaying) || (action === EVENTS.PAUSE && isCurrentlyPlaying)) {
                        expectEvent(action === EVENTS.PLAY ? 'playing' : 'paused');
                        twitchButton.click();
                    }
                    if (action === EVENTS.SEEK) {
                        expectEvent('seek');
                        video.currentTime = data.targetTime;
                    }
                    return;
                }
            }

            // Fallback for native HTML5
            if (action === EVENTS.PLAY) {
                expectEvent('playing');
                video.play().catch((e) => {
                    reportLog(`Playback prevented: ${e.message}`, 'warn');
                    expectedEvents.delete('playing');
                });
            } else if (action === EVENTS.PAUSE) {
                expectEvent('paused');
                video.pause();
            } else if (action === EVENTS.SEEK) {
                expectEvent('seek');
                video.currentTime = data.targetTime;
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
                const timeDiff = Math.abs(video.currentTime - targetTime);
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
        if (message.action === 'get_current_time') {
            const video = findVideo();
            sendResponse({ currentTime: video ? video.currentTime : undefined });
            return true;
        }

        if (message.type === 'SERVER_COMMAND') {
            const { action, payload } = message;
            
            if (action === EVENTS.PLAY) {
                tryMediaAction(EVENTS.PLAY);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp });
            } else if (action === EVENTS.PAUSE) {
                tryMediaAction(EVENTS.PAUSE);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp });
            } else if (action === EVENTS.SEEK) {
                tryMediaAction(EVENTS.SEEK, payload);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp });
            } else if (action === EVENTS.FORCE_SYNC_PREPARE) {
                if (!payload || payload.targetTime === undefined) return;
                const video = findVideo();
                if (video) {
                    if (!Number.isFinite(payload.targetTime)) {
                        reportLog(`Media Action Error: Invalid force sync payload - ${JSON.stringify(payload)}`, 'error');
                        return;
                    }
                    expectEvent('paused');
                    expectEvent('seek');
                    video.pause();
                    video.currentTime = payload.targetTime;
                    pollSeekReady(payload.targetTime).then((ready) => {
                        if (ready) chrome.runtime.sendMessage({ type: 'FORCE_SYNC_ACK' });
                    });
                }
            } else if (action === EVENTS.FORCE_SYNC_EXECUTE) {
                stopLobbyPoll(); // Clear any pending lobby on force sync
                tryMediaAction(EVENTS.PLAY);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp });
            }
        }

        // Episode Auto-Sync: Lobby notification from background
        if (message.type === 'EPISODE_LOBBY') {
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
                expectEvent('paused');
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

                sendResponse({
                    paused: video.paused,
                    currentTime: video.currentTime,
                    duration: video.duration || 0,
                    readyState: video.readyState,
                    muted: video.muted,
                    volume: video.volume,
                    playbackRate: video.playbackRate,
                    url: window.location.href,
                    id: video.id || 'none',
                    className: video.className || 'none',
                    src: video.src || 'none',
                    currentSrc: video.currentSrc || 'none',
                    dataAttributes,
                    metadata
                });
            } else {
                sendResponse({ error: 'No video found' });
            }
        }
    });

    // Detect native events
    function reportEvent(action) {
        const video = findVideo();
        if (!video) return;

        const current = video.currentTime;
        if (!Number.isFinite(current)) return;

        const mediaTitle = (navigator.mediaSession && navigator.mediaSession.metadata) ? navigator.mediaSession.metadata.title : null;

        const eventState = action === EVENTS.PLAY ? 'playing' : (action === EVENTS.PAUSE ? 'paused' : (action === EVENTS.SEEK ? 'seek' : null));
        
        if (eventState && expectedEvents.has(eventState)) {
            expectedEvents.delete(eventState); // Consume the match
            return; // Ignore event caused by our programmatic action
        }
        
        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: {
                currentTime: current,
                targetTime: current,
                mediaTitle: mediaTitle,
                timestamp: Date.now()
            }
        });
    }

    const handlePlay = () => reportEvent(EVENTS.PLAY);
    const handlePause = () => reportEvent(EVENTS.PAUSE);

    // Seek filtering: ignore HLS/DASH buffering micro-seeks.
    // Only relay if delta >= MIN_SEEK_DELTA AND not already debouncing.
    const handleSeeked = () => {
        const video = findVideo();
        if (!video) return;
        const current = video.currentTime;
        if (!Number.isFinite(current)) return;

        // Step 1: Check expectedEvents (programmatic seek suppression)
        if (expectedEvents.has('seek')) {
            expectedEvents.delete('seek');
            lastReportedSeekTime = current; // Update baseline so next user seek is relative to here
            // No log — this is routine programmatic behavior (Force Sync, lobby, peer command)
            return;
        }

        const delta = lastReportedSeekTime !== null ? Math.abs(current - lastReportedSeekTime) : null;
        const deltaStr = delta !== null ? `Δ${delta.toFixed(2)}s` : 'Δ?';

        // Step 2: Delta check — skip micro-seeks (buffering, chapter markers, etc.)
        if (lastReportedSeekTime !== null && delta < MIN_SEEK_DELTA) {
            reportLog(`[Seek] Filtered (${deltaStr} < ${MIN_SEEK_DELTA}s threshold) @ ${current.toFixed(2)}s — not relayed`, 'warn');
            return;
        }

        // Step 3: Debounce rapid consecutive seeks (e.g. scrubbing)
        // — wait 800ms for the user to settle before relaying
        if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
        seekDebounceTimer = setTimeout(() => {
            seekDebounceTimer = null;
            const v = findVideo();
            if (!v) return;
            const settled = v.currentTime;
            const finalDelta = lastReportedSeekTime !== null ? Math.abs(settled - lastReportedSeekTime) : null;
            const finalDeltaStr = finalDelta !== null ? `Δ${finalDelta.toFixed(2)}s` : 'Δ?';
            lastReportedSeekTime = settled;
            reportLog(`[Seek] Relayed @ ${settled.toFixed(2)}s (${finalDeltaStr})`, 'info');
            reportEvent(EVENTS.SEEK);
        }, 800);
    };


    let lastVideoSrc = null;

    // Episode detection handler for loadeddata event
    const handleLoadedData = () => {
        checkEpisodeTransition();
    };

    function setupListeners() {
        const video = findVideo();
        if (video) {
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('seeked', handleSeeked);
            video.removeEventListener('loadeddata', handleLoadedData);

            video.addEventListener('play', handlePlay);
            video.addEventListener('pause', handlePause);
            video.addEventListener('seeked', handleSeeked);
            video.addEventListener('loadeddata', handleLoadedData);
            video.dataset.koalaAttached = 'true';
            lastVideoSrc = video.currentSrc || video.src;

            // Initialize episode tracking title on first attach
            if (!lastKnownMediaTitle) {
                lastKnownMediaTitle = getMediaTitle();
            }
        }
    }

    // SPA Navigation Handler (MutationObserver)
    let lastMutate = 0;
    let observerTimeout = null;

    function checkVideo() {
        lastMutate = Date.now();
        const video = findVideo();
        if (!video) return;

        const currentSrc = video.currentSrc || video.src;

        if (!video.dataset.koalaAttached || (lastVideoSrc && currentSrc && lastVideoSrc !== currentSrc)) {
            // If src changed, also check for episode transition
            if (lastVideoSrc && currentSrc && lastVideoSrc !== currentSrc) {
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
    observer.observe(document.body, { childList: true, subtree: true });

    // Heartbeat
    let heartbeatErrorCount = 0;
    const heartbeatInterval = setInterval(() => {
        const video = findVideo();
        if (video) {
            const mediaTitle = (navigator.mediaSession && navigator.mediaSession.metadata) ? navigator.mediaSession.metadata.title : null;
            chrome.runtime.sendMessage({
                type: 'HEARTBEAT',
                payload: {
                    playbackState: video.paused ? 'paused' : 'playing',
                    currentTime: video.currentTime,
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
                    clearInterval(heartbeatInterval);
                    observer.disconnect();
                }
            });
        }
    }, 15000);

    // Initial Setup
    setupListeners();

    // Episode Auto-Sync: Boot recovery — check if background has an active lobby
    chrome.runtime.sendMessage({ type: 'CONTENT_BOOT' }, (res) => {
        if (res && res.lobbyActive && res.expectedTitle) {
            reportLog(`Boot: Active lobby detected for "${res.expectedTitle}"`, 'info');
            startLobbyPoll(res.expectedTitle);
        }
    });

})();
