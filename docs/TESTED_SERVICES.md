# 🎬 Tested Streaming Services & Compatibility

This document tracks which streaming platforms and media servers are supported by the KoalaSync extension. 

> [!TIP]
> **Contributions are highly welcome!** 🤝 Anyone can easily update this list. If you have tested a streaming service (whether it works, has issues, or is not yet listed), please help the project by submitting a quick Pull Request. See the [How to Contribute](#how-to-contribute) guide below!

---

## Compatibility Matrix

| Service | Sync Works | Media Title | Episode Auto-Sync | Last Tested | Tested By | Extension Version | Notes |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **YouTube** | ✅ Full | ✅ Full | ❌ N/A | — | — | — | Individual videos, not episodes. |
| **Twitch** | ✅ Full | ✅ Full | ❌ N/A | — | — | — | Individual streams/VODs. |
| **Netflix** | ✅ Full | ❌ | ❌ | — | — | — | No media title exposed. |
| **Emby** | ✅ Full | ✅ Full | ✅ Full | — | — | — | Best-in-class support. |
| **Jellyfin** | ✅ Full | ✅ Full | ✅ Full | — | — | — | — |
| **Plex** | Not tested | Not tested | Not tested | — | — | — | — |
| **Disney+** | ✅ Full | ⚠️ Partial | ❌ | — | — | — | Series title only (e.g. "The Simpsons"), no episode info. |
| **Prime Video** | ✅ Full  | ✅ Full  | ❌ | — | — | — | — |
| **HBO Max / Max** | Not tested | Not tested | Not tested | — | — | — | — |
| **Crunchyroll** (`crunchyroll.com`) | ✅ Full | ⚠️ Partial | ❌ | 2026-08-21 | Shik3i | v3.1.4 | Manual testing on the live service confirmed playback synchronization with its top-level Bitmovin HTML5 player. The Media Session exposes the episode as `E1 - Prologue` and the series as artist metadata, but the current episode parser does not recognize the abbreviated `E1` form for episode auto-sync. |
| **Vimeo** | Not tested | Not tested | Not tested | — | — | — | — |
| **Dailymotion** | Not tested | Not tested | Not tested | — | — | — | — |
| **ARD / ZDF Mediathek** | Not tested | Not tested | Not tested | — | — | — | — |
| **Vix** | ✅ Full | ✅ Full | ✅ Full | — | — | — | Everything works correctly. |
| **JkAnime** | ✅ Full | ❌ | ❌ | 2026-08-14 | Shik3i | v3.1.0 | Player sits in a same-origin `/jkplayer/` iframe, so it needs the same-origin frame walk added in v3.1.0. No MediaSession metadata is exposed, and the page title carries no episode pattern (`… Futari 18 Sub Español …`). |
| **Google Drive** (`drive.google.com`) | ✅ Full | ✅ Full | ❌ N/A | 2026-08-17 | Shik3i | v3.1.2 | Manual testing on the live service confirmed playback synchronization through the visible `youtube.googleapis.com/embed` player. KoalaSync controls the exact child document while preserving the top-level Drive title and URL; packed-Chromium tests cover control, reloads, visibility changes, and cleanup. |
| **YummyAnime** (`yummyanime.tv`) | ✅ Full | ⚠️ Partial | ❌ | 2026-08-17 | Shik3i | v3.1.2 | Manual testing on the live service confirmed playback synchronization through the site's same-origin wrapper and current external `thealloha.club` player. The page title identifies the series but not the selected episode; packed-Chromium tests cover nested control, hidden duplicate rejection, reloads, and cleanup. |

### Legend

| Symbol | Meaning |
| :---: | :--- |
| ✅ Full | Works without limitations. |
| ⚠️ Partial | Works with caveats (see Notes). |
| ❌ | Not supported / does not work. |
| ❌ N/A | Not applicable (feature does not exist on the platform). |
| **Not tested** | Has not been tested yet. |

---

## How to Contribute

Updating this compatibility list is quick and easy! You don't need deep coding skills to contribute:

1. **Fork the Repository**: Click the **Fork** button at the top of the [KoalaSync GitHub Repository](https://github.com/Shik3i/KoalaSync).
2. **Edit this File**: Open [docs/TESTED_SERVICES.md](TESTED_SERVICES.md) in your fork's browser editor (or clone it locally) and update the table with your testing details.
3. **Commit & Push**: Commit your changes with a clear message (e.g., `docs: update Netflix compatibility status`).
4. **Create a Pull Request**: Submit the Pull Request (PR) from your fork to our `main` branch.

> [!NOTE]
> **Reporting Problems:** If you notice a bug or partial support on a service, please open a [GitHub Issue](https://github.com/Shik3i/KoalaSync/issues) describing the problem, and link it in the **Notes** column of the table. 
> 
> _If you are unsure how to create/link an issue, don't worry! Simply submit the PR anyway, and the maintainers will gladly create and link the issue for you._

---

## Technical Background

KoalaSync works on any website with a **standard HTML5 `<video>` element** that allows script injection. 

Limited functionality on certain platforms is typically caused by:
- **DRM/Copy Protection** (e.g., Widevine on Netflix) which restricts access to media metadata like title and playback state
- **Shadow DOM encapsulation** that hides video elements from content scripts
- **Strict Content Security Policies** (CSP) that block script injection
- **Cross-origin player frames**, where the `<video>` lives on a different origin than the page (see below)

Websites with heavily obfuscated custom players may require platform-specific workarounds in `content.js`.

### Player frames

Since v3.1.0 the content script walks **same-origin** frames, so a player wrapped in the site's own iframe is found and controlled without a site-specific workaround. This also covers `srcdoc` and `about:blank` frames, which inherit the parent origin.

Since v3.1.2 the background can also inspect accessible **cross-origin** frames and inject KoalaSync into the exact frame/document containing the visible player. Frame election uses visibility and media signals so hidden preloads, trailers and ad players do not win accidentally. When browser site access for the external player origin is withheld, KoalaSync uses the existing website-access recovery flow instead of bypassing the browser permission.

The currently verified cross-origin service topologies are:

- **Google Drive:** `drive.google.com` top page → `youtube.googleapis.com/embed` player.
- **YummyAnime:** `yummyanime.tv` top page → same-origin wrapper → `thealloha.club` player.

These embedded origins are implementation details of the services and may change independently. If the browser withholds access to a newly used player origin, KoalaSync asks for that origin through its normal site-access flow.

Crunchyroll currently exposes its Bitmovin `<video>` directly in the top-level
document. Its application layout uses a `display: contents` wrapper, which has
no box of its own even while the descendant player is visible; v3.1.4 handles
that standards-compliant layout without a Crunchyroll-specific host rule.
