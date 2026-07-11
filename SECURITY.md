# Security Policy

KoalaSync is built on a **zero-persistence, privacy-first** architecture. We take security seriously and appreciate responsible disclosure of vulnerabilities.

---

## Supported Versions

Only the latest stable release receives security patches.

| Version | Supported |
|---------|-----------|
| Latest release | :white_check_mark: Active |
| Older versions | :x: Unsupported |

Users on older versions are encouraged to update. The server enforces a minimum client version via `MIN_VERSION`.

---

## Scope

The following components are within scope for security reports:

| Component | Examples |
|-----------|----------|
| **Relay Server** (`server/`) | Authentication bypass, rate-limit evasion, room hijacking, DoS vectors |
| **Browser Extension** (`extension/`) | XSS via content scripts, privilege escalation, data exfiltration, tab snooping |
| **WebSocket Protocol** | Message injection, replay attacks, man-in-the-middle (WSS bypass) |
| **Website** (`website/`) | XSS, CSP bypass, invitation-hash leaks |

### Out of Scope

- Theoretical attacks requiring physical device access
- Social engineering or phishing
- Denial of service via resource exhaustion on self-hosted instances
- Vulnerabilities in third-party browser extensions or websites

---

## Reporting a Vulnerability

> [!CAUTION]
> **Do NOT open a public GitHub issue for security vulnerabilities.** Public disclosure before a patch is available puts users at risk.

Instead, email the project maintainer privately:

**`koalasync@koalastuff.net`**

Encrypt sensitive findings with our PGP key (available on request).

### What to Include

- **Affected component**: Server / Extension / Website / Protocol
- **Steps to reproduce**: Clear, minimal steps to trigger the vulnerability
- **Impact**: What an attacker could achieve (data access, privilege escalation, etc.)
- **Environment**: Browser version, extension version, server configuration
- **Suggested fix** (optional): If you have ideas for a patch

### What to Expect

| Timeline | Action |
|----------|--------|
| **Within 48 hours** | Acknowledgment of your report |
| **Within 7 days** | Initial assessment and severity confirmation |
| **As needed** | Collaborative discussion for clarification |
| **After patch** | Notification that the fix is deployed |
| **After rollout** | Public acknowledgment in release notes (or anonymity if preferred) |

---

## Architecture & Threat Model

KoalaSync's security is grounded in its architecture:

- **RAM-only relay**: No database, no persistent logs. All session data evaporates on disconnect.
- **Keyed SHA-256 room password hashes**: Plaintext passwords are never stored. Room passwords are held only as in-memory HMAC-SHA256 hashes for the short room lifetime, with brute-force protection: 5 attempts → 15-minute IP lockout.
- **Rate limiting**: Connection rate (IP-based, 60s window), health endpoint rate (10 requests/minute/IP), wrong admin-metrics bearer attempts (5 requests/minute/IP), and event rate (per-socket, 10s window). Health-style JSON responses are cached server-side for 60 seconds and refreshed lazily on request.
- **Reverse proxy boundary**: The relay trusts one proxy hop for client IP detection. In production, keep the Node server reachable only through Caddy or another trusted reverse proxy.
- **URL-hash credential isolation**: Invitation credentials live in the URL fragment (`#join:...`) — never sent to the web server.
- **Strict CSP**: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'`.
- **No third-party requests**: Zero CDNs, fonts, analytics, or external scripts.

If you find a way to bypass any of these protections, we want to know about it.

> [!NOTE]
> Some frequently-reported "issues" are **intentional and out of scope** for our
> threat model (ephemeral, account-less rooms of invited participants) — e.g. an
> unauthenticated `peerId` or non-constant-time room-password compare. Before
> reporting, please read **[`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md)**.

---

## Responsible Disclosure

We follow the principle of **coordinated vulnerability disclosure**:

1. You report privately.
2. We investigate and develop a patch.
3. We deploy to the Chrome Web Store, Firefox Add-ons, and Docker registry.
4. We credit you publicly (unless you prefer to remain anonymous).

We do not pursue legal action against researchers who act in good faith and follow this disclosure process.
