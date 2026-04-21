# KoalaSync Chrome Extension

A Manifest V3 Chrome Extension for synchronized video playback.

## Key Features
- **Manifest V3**: Using a modern Service Worker architecture.
- **Native WebSockets**: No heavy libraries, uses the browser's native API.

## Privacy & Permissions
KoalaSync requires `<all_urls>` permission to detect and interact with video elements (`<video>`) on any website. 
- **No Browsing History**: We do not track which sites you visit.
- **No Telemetry**: There are no analytics or tracking scripts included.
- **Local State**: Settings (Server URL, Room ID, Password) are stored only locally in your browser using `chrome.storage`.

## Installation
1. Go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Development
If you change `shared/constants.js`, remember to run the synchronization script:
- Windows: `..\scripts\sync-constants.bat`
- Linux/macOS: `../scripts/sync-constants.sh`
