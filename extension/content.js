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
        PEER_STATUS: "peer_status"
    };

    let lastTargetState = null;
    let targetStateTimeout = null;

    function setTargetState(state) {
        lastTargetState = state;
        if (targetStateTimeout) clearTimeout(targetStateTimeout);
        if (state !== null) {
            // Seek events might take longer than play/pause, using 2s for safety
            const timeout = state === 'seek' ? 2000 : 1500;
            targetStateTimeout = setTimeout(() => {
                lastTargetState = null;
            }, timeout);
        }
    }

    function reportLog(message, level = 'info') {
        chrome.runtime.sendMessage({ type: 'LOG', message, level }).catch(() => {});
    }

    // --- Helper: find the best video element on the page ---
    function findVideo() {
        const videos = document.querySelectorAll('video');
        return videos.length > 0 ? videos[0] : null;
    }

    // --- Helper: YouTube/Twitch specific actions ---
    function tryMediaAction(action, data) {
        const video = findVideo();
        if (!video) return;

        try {
            const host = window.location.hostname.toLowerCase();
            const isYouTube = host.includes('youtube.com');
            const isTwitch  = host.includes('twitch.tv');

            if (isYouTube) {
                const ytButton = document.querySelector('.ytp-play-button');
                if (ytButton) {
                    const isCurrentlyPlaying = !video.paused;
                    if ((action === EVENTS.PLAY && !isCurrentlyPlaying) || (action === EVENTS.PAUSE && isCurrentlyPlaying)) {
                        setTargetState(action === EVENTS.PLAY ? 'playing' : 'paused');
                        ytButton.click();
                    }
                    if (action === EVENTS.SEEK) {
                        setTargetState('seek');
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
                        setTargetState(action === EVENTS.PLAY ? 'playing' : 'paused');
                        twitchButton.click();
                    }
                    if (action === EVENTS.SEEK) {
                        setTargetState('seek');
                        video.currentTime = data.targetTime;
                    }
                    return;
                }
            }

            // Fallback for native HTML5
            if (action === EVENTS.PLAY) {
                setTargetState('playing');
                video.play().catch((e) => {
                    reportLog(`Playback prevented: ${e.message}`, 'warn');
                    setTargetState(null);
                });
            } else if (action === EVENTS.PAUSE) {
                setTargetState('paused');
                video.pause();
            } else if (action === EVENTS.SEEK) {
                setTargetState('seek');
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
                const ready = video.readyState >= 3 && timeDiff < 1.0;
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
                    setTargetState('paused');
                    video.pause();
                    video.currentTime = payload.targetTime;
                    pollSeekReady(payload.targetTime).then((ready) => {
                        if (ready) chrome.runtime.sendMessage({ type: 'FORCE_SYNC_ACK' });
                    });
                }
            } else if (action === EVENTS.FORCE_SYNC_EXECUTE) {
                tryMediaAction(EVENTS.PLAY);
                chrome.runtime.sendMessage({ type: 'CMD_ACK', actionTimestamp: message.actionTimestamp });
            }
        }

        if (message.type === 'GET_VIDEO_STATE') {
            const video = findVideo();
            if (video) {
                sendResponse({
                    paused: video.paused,
                    currentTime: video.currentTime,
                    duration: video.duration || 0,
                    readyState: video.readyState,
                    muted: video.muted,
                    playbackRate: video.playbackRate,
                    url: window.location.href,
                    id: video.id || 'none'
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

        const eventState = action === EVENTS.PLAY ? 'playing' : (action === EVENTS.PAUSE ? 'paused' : (action === EVENTS.SEEK ? 'seek' : null));
        
        if (eventState && lastTargetState === eventState) {
            setTargetState(null); // Consume the match
            return; // Ignore event caused by our programmatic action
        }
        
        setTargetState(null); // Reset on mismatch or unhandled event

        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: {
                currentTime: video.currentTime,
                timestamp: Date.now()
            }
        });
    }

    const handlePlay = () => reportEvent(EVENTS.PLAY);
    const handlePause = () => reportEvent(EVENTS.PAUSE);
    const handleSeeked = () => reportEvent(EVENTS.SEEK);

    let lastVideoSrc = null;

    function setupListeners() {
        const video = findVideo();
        if (video) {
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
            video.removeEventListener('seeked', handleSeeked);

            video.addEventListener('play', handlePlay);
            video.addEventListener('pause', handlePause);
            video.addEventListener('seeked', handleSeeked);
            video.dataset.koalaAttached = 'true';
            lastVideoSrc = video.currentSrc || video.src;
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
            chrome.runtime.sendMessage({
                type: 'HEARTBEAT',
                payload: {
                    playbackState: video.paused ? 'paused' : 'playing',
                    currentTime: video.currentTime
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

})();
