/**
 * KoalaSync Content Script
 * Injected into video tabs to control playback and detect events.
 */

(function() {
    if (window.koalaSyncInjected) return;
    window.koalaSyncInjected = true;

    let isProcessingCommand = false;

    // --- Helper: find the best video element on the page ---
    function findVideo() {
        const videos = document.querySelectorAll('video');
        return videos.length > 0 ? videos[0] : null;
    }

    // --- Helper: YouTube/Twitch specific actions ---
    function tryMediaAction(action, data) {
        const video = findVideo();
        if (!video) return;

        isProcessingCommand = true;
        try {
            const host = window.location.hostname.toLowerCase();
            const isYouTube = host.includes('youtube.com');
            const isTwitch  = host.includes('twitch.tv');

            if (isYouTube) {
                const ytButton = document.querySelector('.ytp-play-button');
                if (ytButton) {
                    const title = ytButton.getAttribute('aria-label') || '';
                    const isCurrentlyPlaying = title.toLowerCase().includes('pause');
                    if ((action === 'play' && !isCurrentlyPlaying) || (action === 'pause' && isCurrentlyPlaying)) {
                        ytButton.click();
                    }
                }
                if (action === 'seek') video.currentTime = data.targetTime;
                return;
            }

            if (isTwitch) {
                const twitchButton = document.querySelector('[data-a-target="player-play-pause-button"]');
                if (twitchButton) {
                    const label = twitchButton.getAttribute('aria-label')?.toLowerCase() || '';
                    // Check for common localized labels (pause, stoppen, arrête)
                    const isCurrentlyPlaying = label.includes('pause') || label.includes('stoppen') || label.includes('arrête');
                    if ((action === 'play' && !isCurrentlyPlaying) || (action === 'pause' && isCurrentlyPlaying)) {
                        twitchButton.click();
                    }
                }
                if (action === 'seek') video.currentTime = data.targetTime;
                return;
            }

            // Fallback for native HTML5
            if (action === 'play') {
                video.play().catch(() => {});
            } else if (action === 'pause') {
                video.pause();
            } else if (action === 'seek') {
                video.currentTime = data.targetTime;
            }
        } catch (e) {
            console.error('KoalaSync Media Action Error:', e);
        } finally {
            // Guarantee reset even on early returns in YouTube/Twitch blocks
            setTimeout(() => { isProcessingCommand = false; }, 1000);
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
        if (message.type === 'SERVER_COMMAND') {
            const { action, payload } = message;
            
            if (action === 'play') {
                tryMediaAction('play');
            } else if (action === 'pause') {
                tryMediaAction('pause');
            } else if (action === 'seek') {
                tryMediaAction('seek', payload);
            } else if (action === 'force_sync_prepare') {
                const video = findVideo();
                if (video) {
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
        if (isProcessingCommand) return;
        const video = findVideo();
        if (!video) return;

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

    // Heartbeat
    setInterval(() => {
        const video = findVideo();
        if (video) {
            chrome.runtime.sendMessage({
                type: 'HEARTBEAT',
                payload: {
                    playbackState: video.paused ? 'paused' : 'playing',
                    currentTime: video.currentTime
                }
            }).catch(() => {});
        }
    }, 15000);

    const observer = new MutationObserver(() => setupListeners());
    observer.observe(document.body, { childList: true, subtree: true });
    setupListeners();

})();
