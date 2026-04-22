# KoalaSync Chrome Extension

A Manifest V3 Chrome Extension for synchronized video playback across any website.

## Key Features
- **Manifest V3**: Optimized Service Worker architecture with session persistence.
- **Pure Vanilla JS**: No external dependencies or heavy libraries.
- **Smart Peer IDs**: Hexadecimal IDs combined with customizable Usernames for easy identification.
- **Dual Heartbeat**: Advanced session tracking (Background) and video synchronization (Content) to prevent ghost sessions.
- **Live Diagnostics**: Built-in "Dev" tab for real-time video state debugging (ReadyState, CurrentTime, etc.).

## Tab Overview
1. **Room**: Manage connections, view active peers, and share invitation links.
2. **Sync**: Control video playback (Play/Pause/Force Sync) and view recent activity.
3. **Settings**: Customize your Username and toggle domain-based Noise Filtering.
4. **Dev**: Monitor connection status and view real-time video element metadata for debugging.

## Privacy & Permissions
KoalaSync requires `<all_urls>` permission to detect and interact with video elements (`<video>`) on websites.
- **No Browsing History**: We do not track or store your browsing history.
- **State Management**: Sensitive data (Room Passwords) is stored locally using `chrome.storage`.
- **Zero Telemetry**: No analytics or external tracking scripts.

## Installation
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder from this repository.

## Development
If you modify `shared/constants.js`, you must synchronize the changes across the extension and server:
- **Windows**: Run `scripts\sync-constants.bat`
- **Linux/macOS**: Run `scripts/sync-constants.sh`
