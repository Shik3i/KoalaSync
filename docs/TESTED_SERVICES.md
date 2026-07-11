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
| **Crunchyroll** | Not tested | Not tested | Not tested | — | — | — | — |
| **Vimeo** | Not tested | Not tested | Not tested | — | — | — | — |
| **Dailymotion** | Not tested | Not tested | Not tested | — | — | — | — |
| **ARD / ZDF Mediathek** | Not tested | Not tested | Not tested | — | — | — | — |
| **Vix** | ✅ Full | ✅ Full | ✅ Full | — | — | — | Everything works correctly. |

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

Websites with heavily obfuscated custom players (e.g., complex Shadow DOM, iframe isolation) may require platform-specific workarounds in `content.js`.
