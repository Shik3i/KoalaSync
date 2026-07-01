# Phase 2: Security & Performance Review

## Security Findings

### Critical

**S-1: Publicly visible default SERVER_SALT**  
*File: `server/index.js:52`*  
`const salt = process.env.SERVER_SALT || 'koalasync_salt_3i';`  
The fallback salt `koalasync_salt_3i` is committed to the repository. Any room password hash computed with the default salt is trivially verifiable offline by anyone reading the source. This is the single worst misconfiguration in the codebase — password verification becomes dictionary attack without needing the server.  
*CVSS: 7.5 (High)*  
*CWE-798: Use of Hard-coded Credentials*  
**Remediation:** The server MUST refuse to start if SERVER_SALT is not set in production. Add: `if (!process.env.SERVER_SALT) { console.error('[FATAL] SERVER_SALT must be set'); process.exit(1); }`

**S-2: Plaintext relay of tab titles and media titles between peers**  
*File: `server/index.js:579-619`*  
All relay payload fields (tabTitle, mediaTitle, expectedTitle, username) are sanitized for size but transmitted in plaintext to all room members. Any peer can see what shows on a user's screen tab and what media they're watching. While this is inherent to a sync application (peers need to display each other's info), there is no option to encrypt per-peer channels, and the server itself can read everything. No data is encrypted in transit within the room — only the WebSocket connection uses WSS.

**S-3: Extension source code exposes OFFICIAL_SERVER_TOKEN**  
*File: `shared/constants.js:14`*  
`const OFFICIAL_SERVER_TOKEN = '62170b705234c4f4807a9b22420bb93cf1a2aacfa4c5d3b47804482babb8eb50';`  
This 64-char hex token is used to authenticate all WebSocket connections. It is visible in the extension source (Chrome extensions have transparent source). Any user can extract it and create a custom client that connects to the official server. The token should be treated as compromised by design — but there's no compensating rotation mechanism.  
*CVSS: 6.5 (Medium)*  
*CWE-798: Use of Hard-coded Credentials*

**S-4: No input length limit on roomId**  
*File: `server/index.js:349`*  
roomId is sanitized with `.replace(/[^a-zA-Z0-9\-]/g, '').substring(0, 64)`, but the initial value from the client comes from `payload.roomId` without prior validation. The sanitization regex limits to 64 chars and alphanumeric hyphens only. Actually, this IS properly limited. However, the **popup.js generate a join URL** that embeds roomId + password in the URL fragment — this leaks credentials to browser history, referrer headers, and server logs.

### High

**H-1: Server token transmitted in URL query parameter**  
*File: `extension/background.js:636`*  
`url.searchParams.set('token', OFFICIAL_SERVER_TOKEN);`  
The authentication token is sent as a URL query parameter. This means:
- Token appears in browser network logs
- Token may be logged in proxy/firewall logs
- Token may appear in referrer headers if navigation occurs
- Not ideal for credentials — should use HTTP header or WebSocket handshake field  
*CVSS: 5.3 (Medium)*  
*CWE-209: Generation of Error Message Containing Sensitive Information*

**H-2: No CSRF protection on HTTP endpoints**  
*File: `server/index.js:77-122`*  
The `/` and `/health` GET endpoints have no CSRF protection. While they only return status (not state-modifying), any future state-changing endpoint via HTTP GET would be vulnerable.

**H-3: Origin-based CORS is only client-side**  
*File: `server/index.js:129-136`*  
CORS validation only applies to HTTP requests (not WebSocket connections by default — though Socket.IO does check origins). Direct WebSocket connections do not check the `Origin` header — the `socket.handshake.headers['origin']` field should also be validated.

**H-4: LEAVE_ROOM has no rate limiting**  
*File: `server/index.js:663-673`*  
A peer can spam LEAVE_ROOM events unlimited times. While each event triggers peer removal and broadcast, there's no per-socket or per-room rate limit on LEAVE_ROOM. This could be used to:
- Flood peers with PEER_STATUS 'left' broadcasts
- Cause UI thrashing on the client side
- Consume server CPU for Map operations  
*CVSS: 4.3 (Medium)*  
*CWE-770: Allocation of Resources Without Limits*

**H-5: Password sent in JOIN_ROOM payload without hashing on server**  
*File: `extension/background.js:672-679`, `server/index.js:346, 403, 452-458`*  
The client sends the raw password in the JOIN_ROOM payload. The server hashes it client-side before sending (line 346: `password is sanitized but not hashed on client`), then the server receives the raw password and hashes it server-side. This means:
- The password travels in plaintext over WebSocket
- If WSS is not used (local development with ws://), the password is exposed
- No password complexity validation  
*Note: The password could be intercepted by a man-in-the-middle if WSS is not enforced.*

**H-6: Extension can execute arbitrary code via content script reinjection**  
*File: `extension/background.js:1607-1614`*  
When a content script fails to respond, the background automatically reinjects `content.js` into the tab:  
```javascript
chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
```  
While this is from the extension's own source (not remotely controlled), it runs in the page's content script context and has access to chrome.* APIs. A future vulnerability in content.js would be automatically re-executed.

**H-7: Debug/dev mode exposes internal functionality**  
*File: `website/app.js:73-91`*  
Setting `?dev=success` or `?dev=failure` in the URL simulates connection events without actually having the extension installed. This could be exploited for phishing — a fake KoalaSync page could use this to simulate a successful join and trick users.

### Medium

**M-1: Cookie/session flags not set on custom server URL**  
*File: `extension/background.js:608-619`*  
When a user sets a custom server URL, the code auto-upgrades `http://` to `wss://` for non-localhost hosts. This is good security practice. However, the server's `/health` endpoint doesn't include security headers (CSP, X-Frame-Options, etc.).

**M-2: No rate limiting on WebSocket message sizes beyond Socket.IO config**  
*File: `server/index.js:139`*  
`maxHttpBufferSize: 4096` — 4KB max per message. This is reasonable but the JOIN_ROOM handler accepts `peerId` (16 chars), `roomId` (64 chars), `username` (30 chars), `tabTitle` (100 chars), `mediaTitle` (100 chars). These per-field limits are good, but there's no total payload size validation before the Socket.IO buffer limit.

**M-3: Admin metrics endpoint returns memory usage**  
*File: `server/ops.js:53-115`*  
`buildHealthPayload()` returns RSS, heapUsed, and heapTotal under `memory:` when `includeMetrics: true`. This exposes internal server resource usage to anyone with the admin token. In a shared/hosted environment, this information could help attackers understand server capacity or plan DoS attacks.

**M-4: `crypto.timingSafeEqual` usage is correct**  
*File: `server/ops.js:33-46`* — Good catch: the code uses timing-safe comparison with length-checking, preventing timing-based token leakage. This is a positive security pattern. **No fix needed.**

**M-5: i18n dictionary merge uses `Object.assign` (shallow)**  
*File: `extension/i18n.js:48`*  
`const mergedDict = Object.assign({}, enDict, targetDict);` — Currently safe because translation values are flat strings. If nested objects are ever added (e.g., for rich text translations), the shallow merge would lose nested keys from the English baseline.

### Low

**L-1: Locale JSON files are fetched without integrity checks**  
*File: `extension/i18n.js:32, 44`*  
Locale files are fetched with `fetch()` but no integrity validation. The JSON is directly parsed with `response.json()`. A man-in-the-middle could inject malicious translation values (though these only affect display, not execution).

**L-2: `chrome.storage.sync` is used for `dismissedHints` and `onboardingComplete`**  
These two keys are the only ones stored in `storage.sync` (cross-device), which is correctly scoped per the code comments. However, `browserNotifications` (a boolean) is stored in `storage.local` — this is correctly per-device.

---

## Performance Findings

### Critical

**P-1: No database or persistent storage — all state is volatile**  
*File: `server/index.js:149`*  
`const rooms = new Map();` — Server restart means all room state, peer positions, control modes, and episode lobby state are lost. In production, this means:
- Users experience sync desync after every server restart
- Room recovery is impossible (peers rejoin as strangers)
- No audit trail of room activity  

### High

**HP-1: In-memory Maps grow unbounded without guaranteed cleanup**  
*Files: `server/rate-limiter.js:18-23`*  
Six separate Map structures track rate limiting state. While cleanup intervals exist:
- `roomListCooldowns` is only cleaned when socket disconnects — not time-based
- If a client rapidly opens/closes tabs, new socketIds are generated faster than cleanup runs
- `failedAuthAttempts` has a 200K entry soft cap with insertion-order eviction (worst-case O(n))  
**Recommendation:** Use a TTL-based cache (e.g., QuickLRU with maxSize) or periodic compaction.

**HP-2: `updatePeerList()` does full DOM repaint on every peer change**  
*File: `extension/popup.js:619-811`*  
Every time a peer's state changes (heartbeat updates playbackState, currentTime, etc.), the entire peer list is re-rendered. With MAX_PEERS_PER_ROOM=25 and each peer having:
- Avatar + name rendering
- Role badges (host/controller/solo)
- Volume icon
- Status line with interpolated time display
- Promote/demote buttons for controllers  
This creates 25+ DOM element updates per heartbeat (15s interval = ~100+ DOM writes/min per room).

**HP-3: Heartbeat polling interval is fixed at 15s globally**  
*File: `shared/constants.js:83`*  
`HEARTBEAT_INTERVAL = 15000` — This affects all peers in all rooms. A room with 1 peer generates the same heartbeat frequency as a room with 25 peers. **Recommendation:** Scale heartbeat frequency inversely with peer count — more frequent updates when few peers, longer intervals when many.

**HP-4: `findVideo()` traverses Shadow DOM on every call**  
*File: `extension/content.js:411-444`*  
`findVideo()` is called on virtually every event (play, pause, seeked, heartbeat, media action, episode check) and performs:
1. `document.querySelectorAll('video')` — full DOM scan
2. Query for potential hosts by CSS selector
3. Recursive shadow root traversal for each potential host
4. Score computation for all candidates  
**Recommendation:** Cache the last found video element and only re-query on MutationObserver events.

### Medium

**MD-1: Event queue drain uses `setTimeout` with fixed 3s interval**  
*File: `extension/background.js:912-931`*  
`FLUSH_BATCH_INTERVAL_MS = 3000` means a disconnected client's event queue drains in batches of 10 every 3 seconds. With MAX events = 50, a full drain takes 15 seconds. This is reasonable but could be adaptive based on queue size.

**MD-2: Reconnect backoff is exponential but capped**  
*File: `extension/background.js:267-283`*  
The backoff formula `1000 * 1.8^(n-1)` with max 12s and 20% jitter produces: 1s, 1.8s, 3.2s, 5.8s, 10.4s, 12s, 12s... This is well-designed but the slow mode (5 min intervals after failure) means a user who disconnects and reconnects 5 minutes later will see very stale state.

**MD-3: Website `app.js` performs multiple full-page navigation operations for language switching**  
*File: `website/app.js:503-614`*  
Language switching via the dropdown triggers full `window.location.href` navigation to language subdirectories (`/de/`, `/fr/`, etc.). This causes:
- Full page reload
- Resource re-fetching (CSS, JS, images)
- Loss of any in-memory state (scroll position, animations)  
**Recommendation:** For dynamic pages (join, imprint, privacy), use dynamic DOM updates (like the homepage already does for some sections) instead of full navigation.

**MD-4: `MutationObserver` debouncing uses fixed 1s window**  
*File: `extension/content.js:1398-1406`*  
The MutationObserver has a 1-second debounce for video re-detection. If a site rapidly swaps video elements (SPA navigation), the observer waits 1s before checking — potentially missing the first frame of playback. **Recommendation:** Use immediate check + debounce, or use a microtask queue for critical events.

**MD-5: No lazy loading detected in website**  
*File: `website/style.css`, `website/app.js`*  
The website loads all CSS (2,966 lines) and full app.js (778 lines) on every page load. No code splitting, no lazy-loaded sections. The `content-visibility: auto` CSS optimization (line 123 style.css) is a good start but doesn't reduce JS execution time.

### Low

**LP-1: Interpolation interval runs at 1s frequency**  
*File: `extension/popup.js:559-574`*  
The time interpolation for all peer time displays runs at 1s intervals regardless of whether any peer is in playing state. **Recommendation:** Only run interpolation when there are playing peers.

**LP-2: `JSON.stringify()` comparison on line 639 of popup.js**  
*File: `extension/popup.js:639`*  
`const currentPeersJson = JSON.stringify(stateToHash); if (currentPeersJson === lastPeersJson) return;` — JSON serialization of peer state for change detection is O(n) where n = number of peers. For 25 peers this is fine, but for higher counts it becomes a performance concern.

**LP-3: Website version fetch on every page load**  
*File: `website/app.js:332-389`*  
`updateDynamicVersion()` fetches `/version.json` on every page load with no caching strategy (no-SW, no service worker). This is a small payload but represents unnecessary network I/O.

---

## Critical Issues for Phase 3 Context

### Testing-relevant

1. **No WebSocket integration tests exist** — The `test-server-ws.mjs` file likely tests connection flow but with in-memory sockets, not real extensions. Real-world testing requires actual Chrome/Firefox extension integration.

2. **No end-to-end sync tests** — Play/Pause sync between two browser instances with real video players cannot be tested in CI. This is a fundamental limitation for a sync product.

3. **Security-sensitive code has no fuzz tests** — Rate limiters, sanitizers, and auth checks have no adversarial input testing. Edge cases (empty strings, null bytes, Unicode surrogates, extremely long strings) should be explicitly tested.

4. **Content script platform detection is untested across platforms** — YouTube/Twitch/Netflix-specific button selectors in `content.js:742-772` will break when sites update their UI. No automated regression testing for these platform-specific overrides.

### Documentation-relevant

1. **No API documentation for the WebSocket protocol** — The events, payloads, and expected behaviors are scattered across server code and background.js comments. A protocol spec would help extension developers and self-hosters.

2. **No self-hosting guide** — Custom server URLs are supported but there's no documentation on server deployment, environment variables, or scaling.
