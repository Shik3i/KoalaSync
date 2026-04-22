/**
 * KoalaSync Bridge Script
 * Injected into koalasync.shik3i.net to facilitate communication between 
 * the landing page and the extension.
 */

// 1. Signal presence to the website
document.documentElement.dataset.koalasyncInstalled = 'true';

// 2. Listen for Join Requests from the Website
window.addEventListener('KOALASYNC_JOIN_REQUEST', (e) => {
    const { roomId, password, useCustomServer, serverUrl } = e.detail;
    chrome.runtime.sendMessage({ 
        type: 'WEB_JOIN_REQUEST', 
        roomId, 
        password,
        useCustomServer,
        serverUrl
    });
});

// 3. Listen for Status Updates from the Extension and relay to Website
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'JOIN_STATUS') {
        const event = new CustomEvent('KOALASYNC_STATUS', { 
            detail: { 
                success: msg.success, 
                message: msg.message 
            } 
        });
        window.dispatchEvent(event);
    }
});
