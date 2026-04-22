/**
 * KoalaSync Content Script
 * Injected into video tabs to control playback and detect events.
 */

(function() {
    if (window.koalaSyncInjected) return;
    window.koalaSyncInjected = true;

    let lastTargetState = null;
    let targetStateTimeout = null;

    function setTargetState(state) {
        lastTargetState = state;
        if (targetStateTimeout) clearTimeout(targetStateTimeout);
        if (state !== null) {
            targetStateTimeout = setTimeout(() => {
                lastTargetState = null;
            }, 1500);
        }
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
                    if ((action === 'play' && !isCurrentlyPlaying) || (action === 'pause' && isCurrentlyPlaying)) {
                        setTargetState(action === 'play' ? 'playing' : 'paused');
                        ytButton.click();
                    }
                    if (action === 'seek') video.currentTime = data.targetTime;
                    return;
                }
            }

            if (isTwitch) {
                const twitchButton = document.querySelector('[data-a-target="player-play-pause-button"]');
                if (twitchButton) {
                    const isCurrentlyPlaying = !video.paused;
                    if ((action === 'play' && !isCurrentlyPlaying) || (action === 'pause' && isCurrentlyPlaying)) {
                        setTargetState(action === 'play' ? 'playing' : 'paused');
                        twitchButton.click();
                    }
                    if (action === 'seek') video.currentTime = data.targetTime;
                    return;
                }
            }

            // Fallback for native HTML5
            if (action === 'play') {
                setTargetState('playing');
                video.play().catch((e) => {
                    console.warn('KoalaSync playback prevented:', e);
                    setTargetState(null);
                });
            } else if (action === 'pause') {
                setTargetState('paused');
                video.pause();
            } else if (action === 'seek') {
                video.currentTime = data.targetTime;
            }
        } catch (e) {
            console.error('KoalaSync Media Action Error:', e);
        }
    }

    // --- Helper: Wait until video is ready for playback (buffered & seeked) ---
    function pollSeekReady(targetTime, timeoutMs = 8000) {
        return new Promise((resolve) => {
            const video = findVideo();
            if (!video) { resolve(false); return; }

            const interval = 150;
            let elapsed = 0;
            const timer = setInterval(() => {
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
            
            if (action === 'play') {
                tryMediaAction('play');
            } else if (action === 'pause') {
                tryMediaAction('pause');
            } else if (action === 'seek') {
                tryMediaAction('seek', payload);
            } else if (action === 'force_sync_prepare') {
                if (!payload || payload.targetTime === undefined) return;
                const video = findVideo();
                if (video) {
                    setTargetState('paused');
                    video.pause();
                    video.currentTime = payload.targetTime;
                    pollSeekReady(payload.targetTime).then(() => {
                        chrome.runtime.sendMessage({ type: 'FORCE_SYNC_ACK' });
                    });
                }
            } else if (action === 'force_sync_execute') {
                tryMediaAction('play');
            }
        }
    });

    // Detect native events
    function reportEvent(action) {
        const video = findVideo();
        if (!video) return;

        const eventState = action === 'play' ? 'playing' : (action === 'pause' ? 'paused' : null);
        
        if (eventState && lastTargetState === eventState) {
            setTargetState(null); // Consume the match
            return; // Ignore event caused by our programmatic action
        }
        if (action !== 'seek') {
            setTargetState(null); // Reset on mismatch
        }

        chrome.runtime.sendMessage({
            type: 'CONTENT_EVENT',
            action,
            payload: {
                currentTime: video.currentTime,
                timestamp: Date.now()
            }
        });
    }

    function setupListeners() {
        const video = findVideo();
        if (video && !video.dataset.koalaAttached) {
            video.addEventListener('play', () => reportEvent('play'));
            video.addEventListener('pause', () => reportEvent('pause'));
            video.addEventListener('seeked', () => reportEvent('seek'));
            video.dataset.koalaAttached = 'true';
        }
    }

    // SPA Navigation Handler (MutationObserver)
    let lastMutate = 0;
    let observerTimeout = null;

    function checkVideo() {
        lastMutate = Date.now();
        const video = findVideo();
        if (video && !video.dataset.koalaAttached) {
            console.log('KoalaSync: New video detected via navigation.');
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
                        console.warn('KoalaSync: Extension reloaded. Please refresh the page if sync stops working.');
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
