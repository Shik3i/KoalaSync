# Privacy Policy

**KoalaSync does not collect, store, or sell any personal data.**

*We don't track you. We only track our server* (relying exclusively on aggregated, anonymous, and non-personal system metrics to monitor performance and stability).

KoalaSync is designed with a **Security-First & Volatile** architecture. This means we prioritize keeping your data out of persistent storage, though certain technical data must be processed temporarily to ensure service stability and security.

## 1. Data Processing (In-Memory Only)
KoalaSync does not use a database. All active session data exists only in the server's RAM and is purged immediately when no longer needed.
- **Session Data**: To synchronize playback, the server must temporarily hold your `peerId` and `username`. By default, KoalaSync also shares the selected tab title and media title with the room so peers can identify matching videos and coordinate episode transitions. Privacy Settings let you disable sending the tab title separately, and choose whether media titles are sent in full, reduced to a detected episode identifier (for example `S01E04`), or not sent. Playback metadata (`playbackState`, `currentTime`, `volume`, `muted`) is held per peer for the duration of the session. All of this is deleted as soon as you leave the room.
- **Shared Video Link (opt-in, off by default)**: If you enable *Settings → Privacy → Share video link*, the extension shares the full URL of your selected tab, including any query string and fragment, with the other participants of the room. Only HTTP(S) URLs up to 900 bytes are shared. The URL is encrypted in your browser and travels through the relay as opaque ciphertext inside the existing chat message envelope; the relay cannot read it, stores it nowhere, and discards it like any other relayed message. This works even when the chat display is turned off. Room participants can read the URL, so do not enable it for pages whose address contains private tokens. The link is shared only while the selected tab shows a page on which KoalaSync detected a video; navigating that tab to a page without a video, turning the option off, switching tabs, or leaving the room withdraws it. Participants who hold the invitation's chat secret exchange links only with each other, under keys derived from that secret, so neither a passive nor an actively malicious relay can read them. In rooms without a chat secret, participants use an automatic key exchange that does not protect against an actively malicious relay. Even with the option off, the extension takes part in this encrypted key exchange so that it can receive other participants' links; the relay then sees, besides the ciphertext, a short tag derived from the room and chat secret, which tells it which participants hold the same secret, but never the secret or a URL.
- **Room Passwords**: If you set a room password, it is stored only as an in-memory **keyed SHA-256 HMAC hash**. The server receives the plaintext password only during join validation, never stores it, and keeps only the hash for the short room lifetime.
- **Routing Maps**: The server maintains ephemeral lookup tables (`socketToRoom`, `peerToSocket`) to route messages between peers. These contain only transport identifiers and are purged on disconnect.

### Data Retention
| Data Type | Maximum Retention | Trigger for Deletion |
|:----------|:------------------|:---------------------|
| Session data (peerId, username, video metadata) | Duration of session | User leaves room or disconnects |
| Shared video link (opt-in; ciphertext only, never stored by the relay) | Not stored; relayed once | Delivered or dropped immediately |
| Room state | 2 hours max | Last peer leaves, or inactivity timeout |
| Auth failure records (lockout after 5 failed attempts) | 15 minutes | Periodic cleanup |
| Connection rate-limit counters | 60 seconds | Automatic expiry |
| Event rate-limit counters | 10 seconds | Automatic expiry + periodic cleanup |

## 2. Security & Rate Limiting
To prevent abuse and brute-force attacks, the following data is processed:
- **Brute-Force Protection**: If multiple failed password attempts are detected, the server stores the `IP address` and `Room ID` in a temporary RAM-based lockout list for a maximum of 15 minutes.
- **Connection Rate Limiting**: IP addresses are tracked for 60 seconds to prevent connection-flooding (DoS) attacks.
- **Event Rate Limiting**: Per-socket event counters are tracked for 10-second windows to prevent event-spamming. These are keyed by ephemeral socket IDs and cleaned up periodically.
- **Console Logging**: The official relay server (`syncserver.koalastuff.net`) outputs connection events (including IP addresses) to the server console for real-time monitoring. These logs are ephemeral and are not archived, sold, or linked to any persistent user identity.

## 3. Extension Permissions
The browser extension requires the following permissions:
- `storage`: To remember your local preferences (username, server URL, room settings).
- `tabs` & `scripting`: To detect and control video elements on the pages you choose to sync, and to read tab addresses locally where tab selection and synchronization need them (for example to filter the tab list). Only if you enable *Share video link* is the selected tab's address shared with room participants.
- `<all_urls>` (host permission): Required to detect `<video>` elements on any website the user chooses to synchronize. The extension only activates on the specific tab the user has actively selected — it does not scan, monitor, or interact with any other tabs or pages.
- `alarms`: To keep the background service worker alive during active sync sessions (the extension only stays connected while you are in a room).
- `notifications`: To display sync status updates (e.g., "Peer joined", "Force Sync initiated").
- **No History Access**: We do not read, store, or transmit your browsing history. We only interact with the specific tab you have actively selected for synchronization.

## 4. Zero Third-Party Requests
KoalaSync is completely self-contained:
- **No CDNs or External Libraries**: All scripts and styles are self-hosted.
- **No Analytics**: We do not use Google Analytics, tracking pixels, or any third-party telemetry.
- **No External Fonts**: We use system font stacks to prevent tracking via font services.

## 5. Self-Hosted Instances
This privacy policy applies to the **official KoalaSync relay server** at `syncserver.koalastuff.net`. If you choose to self-host a relay server using our open-source Docker image, the data handling practices of that instance are the responsibility of the server operator.

---

**Auditable & Open Source**: Because KoalaSync is open source, you can verify these claims by reviewing the [Server Source Code](https://github.com/Shik3i/KoalaSync/blob/main/server/index.js) and the [Extension Logic](https://github.com/Shik3i/KoalaSync/blob/main/extension/content.js).
