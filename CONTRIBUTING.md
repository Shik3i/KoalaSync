# Contributing to KoalaSync

Thanks for your interest in improving KoalaSync. All contributions are welcome — from bug reports and translations to core protocol changes.

Please note that by participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Ways to Contribute

| Area | Description |
|------|-------------|
| **Bug Reports** | Found a bug? Open an issue with repro steps (see template below). |
| **Code** | Fix bugs, add features, or improve the extension / server / website. |
| **Translations** | Help localize the extension and website into more languages. See [TRANSLATION.md](docs/TRANSLATION.md). |
| **Documentation** | Improve docs, fix typos, or add missing examples. |
| **Security** | Found a vulnerability? See [SECURITY.md](SECURITY.md) — do NOT open a public issue. |

---

## Development Setup

### Prerequisites

- **Node.js** v20.19+
- **Docker** (for local relay server testing)

### Quick Start

```bash
git clone https://github.com/Shik3i/KoalaSync.git
cd KoalaSync
npm install
node scripts/build-extension.cjs
```

---

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `extension/` | Browser extension (Manifest V3, Chrome & Firefox) |
| `server/` | Node.js + Socket.IO relay server (Dockerized) |
| `website/` | Landing page, invitation bridge, and marketing site |
| `shared/` | Protocol constants — single source of truth |
| `scripts/` | Build and sync utilities |
| `docs/` | Architecture, sync protocol, and deep-dive guides |

---

## Testing Locally

### Extension

1. Load `dist/chrome/` as an unpacked extension in Chrome (`chrome://extensions/` → Developer Mode → **Load unpacked**).
2. For Firefox: load `dist/firefox/` via `about:debugging` → **Load Temporary Add-on**.
3. Start the relay server: `docker compose up --build`.
4. Use **two different browser profiles** (or Chrome + Firefox) to test multi-peer sync.
5. Use the extension's **Dev tab** to inspect real-time video element state (`readyState`, `currentTime`, `paused`).

### Website

```bash
node website/build.cjs           # Compile static site → www/
python3 -m http.server 8080 -d website/www  # Serve locally
```

Then open `http://localhost:8080`. For multi-language testing: `http://localhost:8080/de/`.

---

## Protocol Constants

KoalaSync uses a **single source of truth** for all protocol constants in `shared/constants.js`.

> [!IMPORTANT]
> After modifying `shared/constants.js`, you **must** run the build script to sync changes to the extension:
> ```bash
> node scripts/build-extension.cjs
> ```
> This automatically injects constants into `content.js` and regenerates browser bundles in `dist/`.

---

## Code Standards

- **Vanilla JS**: The extension must remain dependency-free. No npm packages in `extension/`.
- **Privacy-first**: Zero external requests — no CDNs, fonts, analytics, or trackers. All assets self-hosted.
- **System font stack**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...` — never `@import` external fonts.
- **Room IDs**: Restricted to `[a-zA-Z0-9-]` (alphanumeric + hyphens only). Enforced server-side.
- **Comments**: Document complex sync logic. The codebase uses inline comments for protocol reasoning.

---

## Version Numbers

> [!CAUTION]
> **Never edit release versions independently.** Release maintainers run
> `npm run prepare:release -- MAJOR.MINOR.PATCH` on a branch and merge the
> resulting version changes through a CI-green pull request before tagging.

---

## Open Source Workflow & Pull Requests

If you are new to open-source contributions, follow these steps to propose your changes:

1. **Fork the Repository**: Click the "Fork" button at the top right of this repository to create your own copy of KoalaSync.
2. **Clone your Fork**: `git clone https://github.com/YOUR-USERNAME/KoalaSync.git`
3. **Create a Branch**: `git checkout -b my-new-feature` (e.g. `feature/dark-mode` or `fix/translation-de`)
4. **Make your Changes**: Edit the files, then verify them locally.
   - *Extension/Server changes*: Test on Chrome/Firefox and check `npm run lint`.
   - *Website/Translation changes*: Run `node website/build.cjs` and check the output in `www/`.
5. **Commit and Push**: `git commit -m "Add my feature"` and `git push origin my-new-feature`
6. **Open a Pull Request (PR)**: Go to the original KoalaSync repository on GitHub and click "New Pull Request".

### PR Code Requirements
- **Lint**: Ensure `npm run lint` passes with zero errors and warnings.
- **Syntax**: Run `node -c` on every modified `.js` file.
- **Protocol changes**: Update relevant documentation in `docs/`.

---

## Bug Report Template

When filing a bug, the easiest way is to use the **Copy Logs** button in the extension's **Status** tab. It copies a fully formatted Markdown report to your clipboard containing:

- System info (version, protocol, peer ID, browser)
- Connection status (server, room, peers, reconnect state)
- Video debug info (playback state, readyState, network state, dimensions, error codes, shadow DOM detection, platform)
- Action history (last 20 events)
- Log entries (last 50)

Simply paste the clipboard contents into your GitHub issue and add:

| Field | Example |
|-------|---------|
| **Steps to Reproduce** | 1. Create room → 2. Join from second browser → 3. Play video |
| **Expected Behavior** | Both peers play simultaneously |
| **Actual Behavior** | Peer B remains paused |

If you cannot access the Status tab, include as much of the following manually:

| Field | Example |
|-------|---------|
| **Browser** | Chrome 125, Firefox 128 |
| **Extension Version** | v1.9.3 (visible at bottom of Settings tab) |
| **Website/Platform** | Netflix, YouTube, Twitch, Jellyfin, etc.

---

## Translation Contributions (Translators Welcome!)

We welcome native speakers to help translate KoalaSync! You **do not** need deep programming knowledge to contribute translations.

KoalaSync supports multiple languages. To add or improve translations:
1. Read the **[Translation Guide](docs/TRANSLATION.md)** first. It explains how our localization system works.
2. Edit the `.json` files in `website/locales/` (for the website) and `extension/locales/` (for the extension).
3. Test your translations locally by running:
   - `node scripts/test-locales.cjs` (for extension)
   - `node scripts/test-website-locales.mjs` (for website)
   - `node website/build.cjs` (to build the site)
4. Follow the **Open Source Workflow** above (Fork -> Branch -> Edit -> PR) to submit your translations.

---

## Security

If you discover a security vulnerability, **do not open a public issue**. Report it privately as described in [SECURITY.md](SECURITY.md).
