<p align="center">
  <img src="website/assets/PlatformJuggler_New.webp" width="280" alt="KoalaSync Mascot">
</p>

<h1 align="center">KoalaSync</h1>

<p align="center">
  <a href="https://github.com/Shik3i/KoalaSync/actions/workflows/release.yml"><img src="https://github.com/Shik3i/KoalaSync/actions/workflows/release.yml/badge.svg" alt="Release Status"></a>
  <a href="https://github.com/Shik3i/KoalaSync/releases"><img src="https://img.shields.io/badge/Release-v2.5.1-blue?logo=github" alt="GitHub release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License"></a>
  <a href="https://addons.mozilla.org/de/firefox/addon/koalasync/"><img src="https://img.shields.io/badge/Firefox-Download-orange?logo=firefoxbrowser&logoColor=white" alt="Firefox Add-on"></a>
  <a href="https://chromewebstore.google.com/detail/koalasync/obbnmkmlaaddodakcbdljknjpagklifc"><img src="https://img.shields.io/badge/Chrome-Download-blue?logo=googlechrome&logoColor=white" alt="Chrome Extension"></a>
</p>

<p align="center"><i>KoalaSync is a lightweight Browser Extension and Relay Server for synchronized video playback on almost any website with a video element—YouTube, Twitch, Netflix, Emby, Jellyfin, and beyond. Built with a focus on <b>Data Sovereignty</b> and <b>Performance</b>.</i></p>

<p align="center"><a href="docs/CHANGELOG.md"><b>New v2.5.1 Release!</b> — See what's changed</a></p>

### 🌟 Why KoalaSync?

*   **🛡️ Security-First**: Volatile RAM-based relay with built-in brute-force protection and zero-persistence architecture. We keep no logs of your sessions or synchronizations. *We don't track you. We only track our server* (relying on the [aggregated, anonymous, non-personal metrics](https://syncserver.koalastuff.net/health) provided under `/health`).
*   **📡 Direct Logic**: Manual Socket.IO wire implementation for reliable synchronization.
*   **🛠️ Clean Build**: Dependency-free extension runtime with no library overhead.
*   **🌐 Universal**: Works on any website with a `<video>` tag.

---

### ✨ Key Features

- **Global Synchronization**: Synchronize Play, Pause, and Seeking on any website with a `<video>` tag.
- **Episode Auto-Sync**: Perfectly sync series binges. All peers wait until everyone has loaded the next episode before starting together.
- **Smart Matching**: Automatically highlights tabs containing matching video titles.
- **Dual Heartbeat Architecture**: Robust session tracking that prevents ghost rooms and stale connections.
- **Efficient Relay**: Minimal overhead WebSocket message forwarding.
- **Seamless Invitations**: Smart links that automatically configure server and room credentials for your friends.
- **Smart Audio Compressor**: Tired of constantly riding the volume? Automatically balance out whispering dialogue and deafening explosions with simple presets, or fully customize the audio to your liking.

---

### 🚀 Quick Start

#### For Users (Installation & Usage)
The easiest and safest way to install KoalaSync is directly through the official browser stores:

<p>
  <a href="https://chromewebstore.google.com/detail/koalasync/obbnmkmlaaddodakcbdljknjpagklifc"><img src="https://img.shields.io/badge/Chrome-Download-blue?logo=googlechrome&logoColor=white&style=for-the-badge" alt="Chrome Extension"></a>
  <a href="https://addons.mozilla.org/de/firefox/addon/koalasync/"><img src="https://img.shields.io/badge/Firefox-Download-orange?logo=firefoxbrowser&logoColor=white&style=for-the-badge" alt="Firefox Add-on"></a>
</p>

*(For manual offline installation: Download the latest `.zip` from the [Releases](https://github.com/Shik3i/KoalaSync/releases) page and load it as an "Unpacked Extension" in Developer Mode).*

**How to use:**
1. **Create a Room:** Click the Koala icon in your browser and hit `+ Create New Room`.
2. **Invite Friends:** Share the auto-copied invite link. Once they click it, they automatically join.
3. **Pick a Video:** Navigate to the Sync Tab, select the tab playing your video, and grab some popcorn! 🍿

---

### 🌐 Localization & Translations

Both the official KoalaSync website and the **v2.0 Browser Extension** feature full dynamic localization:
- **Available Languages**: Support is included for 15 languages: English (`en`), German (`de`), French (`fr`), Spanish (`es`), Portuguese (Brazil) (`pt-BR`), Russian (`ru`), Italian (`it`), Polish (`pl`), Turkish (`tr`), Dutch (`nl`), Japanese (`ja`), Korean (`ko`), Chinese (Simplified) (`zh`), Ukrainian (`uk`), and European Portuguese (`pt`).
- **Real-Time Extension Localization**: Inside the extension Settings panel, users can swap languages instantly. The entire interface, notifications, Empty States, and onboarding guides re-translate dynamically in real-time.
- **Contributing**: We welcome community translations for both the website and the extension! Please refer directly to the [TRANSLATION.md](docs/TRANSLATION.md) guide for step-by-step instructions on how to audit, refine, or add new languages.


---

### 🛠️ For Developers & Self-Hosters

#### 📂 Repository Structure

- `extension/`: Browser Extension (Chrome & Firefox).
- `server/`: Node.js + Socket.IO Relay Server (Containerized).
- `website/`: Marketing landing page & Invitation Bridge.
- `shared/`: **Single Source of Truth** for protocol constants.
- `scripts/`: Automated build and synchronization utilities.
- `docs/`: Technical deep-dives ([Architecture](docs/ARCHITECTURE.md), [Sync Guide](docs/SYNC_GUIDE.md)).

#### Building from Source
To build the extension from source and synchronize protocol constants:
```bash
npm install
npm run build:extension
```
The compiled artifacts will be available in the `dist/` directory.

#### For Self-Hosting (Docker)
Deploy your own private relay server using our official image:
```bash
# Pull the latest image
docker pull ghcr.io/shik3i/koalasync:latest

# Or use our example compose file
cp examples/docker-compose.caddy.example.yml docker-compose.yml
docker-compose up -d
```
The server will be available at `ws://localhost:3000`. See [Docker network compose](examples/docker-compose.caddy.example.yml) or [Static IP compose](examples/docker-compose.ip.example.yml) for ready-to-use Docker Compose files.

To connect your extension to a self-hosted server, open the popup → **Room** tab → select **Custom Server** → enter your server's WebSocket URL (e.g., `ws://localhost:3000`).

> **⚠️ Note**: `ws://` only works for `localhost`. If you deploy to a real domain, you **must** use `wss://` (e.g., `wss://sync.yourdomain.com`). This requires a TLS-terminating reverse proxy (e.g., Caddy, Nginx, or Traefik) in front of the relay server. See [Caddyfile.example](examples/Caddyfile.example) for a production-ready template.

To verify your relay is reachable from outside, visit `https://your-domain.com` in a browser — it should return `{"status":"online","service":"KoalaSync Relay"}`.

#### Supply Chain Security (v2.2.2+)

All official release artifacts (Docker images and extension binaries) are published with signed [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations) to prove they were built from this repository's source code.

**Verify a Docker image:**
```bash
gh attestation verify oci://ghcr.io/shik3i/koalasync:latest \
  -R Shik3i/KoalaSync
```

**Verify an extension binary:**
```bash
gh attestation verify dist/koalasync-chrome.zip \
  -R Shik3i/KoalaSync
```

---

### 📖 Documentation & Links

- **[CHANGELOG.md](docs/CHANGELOG.md)**: Full version history for the extension and relay server.
- **[TESTED_SERVICES.md](docs/TESTED_SERVICES.md)**: Detailed compatibility matrix of tested streaming platforms and known limitations.
- **[TRANSLATION.md](docs/TRANSLATION.md)**: Translation and localization guide for contributors.
- **[PRIVACY.md](docs/PRIVACY.md)**: Data Handling and Privacy Policy.
- **[CONTRIBUTING.md](CONTRIBUTING.md)**: How to help make KoalaSync better.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)**: Our community standards and expectations.
- **[HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**: Step-by-step walkthrough of the complete user flow.
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)**: Deep-dive into the two-phase sync and heartbeat logic.
- **[PROTOCOL.md](docs/PROTOCOL.md)**: WebSocket protocol specification and event reference.
- **[ROADMAP.md](docs/ROADMAP.md)**: Planned features, backlog, and rejected ideas.
- **[SECURITY.md](SECURITY.md)**: Disclosure policy and security practices.
- **[Caddyfile.example](examples/Caddyfile.example)**: Production Caddy configuration for website and relay.

---

<div align="center">
  <sub><a href="https://support.koalastuff.net"><img src="https://img.shields.io/badge/Support-KoalaSync-FF5E5B" alt="Support KoalaSync"></a></sub>
  <sub><a href="https://gitgem.org/github/Shik3i/KoalaSync"><img src="https://gitgem.org/api/badge/github/Shik3i/KoalaSync.svg" alt="GitGem Badge" /></a></sub>

  <sub>Built with ❤️ by <a href="https://github.com/Shik3i">Shik3i</a>. KoalaSync is Open Source under the <a href="LICENSE">MIT License</a>.</sub>
</div>
