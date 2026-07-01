# Host Control Mode — Branch Overview, Goals & Edge Cases

> **This is the canonical entry-point doc for branch `feature/host-control-mode`.**
> If you're an agent or contributor picking this up: read this file first, then the
> implementation plan in [`host-control-mode-plan.md`](./host-control-mode-plan.md).
> Temporary working doc — delete or fold into permanent docs before merging to `main`.
>
> Status legend: 🔴 open / unresolved · 🟡 idea, needs testing · 🟢 decided

---

## 0. Implementation status

All five layers are implemented & pushed (server + background + content + popup + i18n).
Automated checks green: ESLint, WS integration tests (incl. host-only gate, toggle
reject, host-leave fallback), content video-finder, locale consistency (15 langs),
full release verification.

**Still needs real-device testing** — the EC test matrix in §7 (YouTube/Netflix/
Twitch/Disney+/Jellyfin): involuntary-pause classification (EC-1/EC-5/EC-8), snap-back
reliability and fight-loops (EC-4), and the desync/resync flow across players. The
intent classifier (EC-9) and snap-back cooldown are first-pass heuristics tuned by
reading the code, not yet by watching them behave on each site.

Deferred by decision (see §8): host grace period on disconnect (EC-10).

### Capability detection (forward-compat hook)
The relay advertises `capabilities: ['host-control']` in `ROOM_DATA`
(`SERVER_CAPABILITIES` in server, `CAPABILITIES` in shared/constants). The client
enables host-control UI/behavior only when the flag is present, so the feature
degrades cleanly on an older relay (absent → off) and old clients ignore the
field. This is the extensible hook for the planned **co-host** feature (owner
promotes guests to additional controllers): it will add a `'co-host'` capability
+ events without a protocol bump or breaking older relays/clients. Add new flags
to `CAPABILITIES` / `SERVER_CAPABILITIES` as features land.

### Pre-test self-audit (fixed)
- **Popup remote buttons froze for guests** — in host-only a guest's Play/Pause/SYNC
  click was gated server-side but the button stuck on "Playing"/disabled with no
  feedback. Now the remote controls are locked (disabled + tooltip) for guests, with
  backstop guards in the handlers. (popup.js)
- **Desync dialog could break under strict CSP** — it used `innerHTML` with inline
  `style=""` attributes, which Netflix/YouTube/Disney+ strip via `style-src`. Rebuilt
  with the DOM API (CSSOM `.style` is CSP-safe) inside a **Shadow DOM** so page CSS
  can't restyle/hide it. (content.js)
- **Live-DVR not detected (EC-15)** — `duration === Infinity` misses Twitch/YouTube
  live-DVR (finite, sliding duration). Added a `seekable.start(0) > 1` sliding-window
  heuristic in `hcmIsLive()`. (content.js)

### Pre-test self-audit
- ~~**EC-4/EC-1 snap-back thrash:**~~ FIXED — implemented the **buffer-aware deferred
  snap-back** (`hcmDeferredSnapBack`): on an involuntary event, if the player isn't
  ready (`readyState<3` or seeking) we wait (poll, 8s cap) until it can play, then snap
  ONCE to the host's re-queried position instead of repeatedly fighting the buffer.
  Done defensively/player-agnostically — we can't enumerate every site, so this is safe
  whether a player fires `pause()` or only `waiting`. Aborts if the user goes solo or is
  no longer a gated guest; single pending poll (no stacking).
- ~~**Control-mode race at join:**~~ FIXED — `hcmHandleBlocked` now treats `HOST_BLOCKED`
  as authoritative (adopts host-only/guest role) instead of re-checking local mode,
  since background only sends it to gated guests.
- ~~**Dialog/badge text is English-only**~~ FIXED — background resolves the strings
  via GET_HCM_STRINGS (it has the i18n loader); content fetches them on init with
  English fallback. 6 new keys (HCM_DIALOG_*/HCM_BADGE_*) across all 15 locales.

---

## 1. What this branch is for

Origin: a GitHub feature request. When watching with larger groups, anyone can pause
or seek and disrupt everyone else. The requester wants the room creator to optionally
restrict control to a single **host**, the way Teleparty works — guests who try to
pause get asked whether they want to pause *only their own* player (and desync), and
otherwise get snapped back to the room's position.

**Goal:** Add an optional per-room **Host Control Mode**. A room can be switched
between:
- **`everyone`** (default, current behavior): anyone can play/pause/seek for the room.
- **`host-only`**: only the host drives the room. A guest's deliberate play/pause/seek
  is not broadcast; instead they're snapped back to the room position — unless they
  explicitly choose to desync (go solo) with a "Resync" escape hatch.

## 2. Trust model (read this before over-engineering)

This is **client-side trust, by design**. It's a watch party, not a security boundary.
The point is preventing *accidental* and *casual* disruption, not stopping someone
determined to patch their own extension. We do **not** add auth, tokens, or
cryptographic host identity. `peerId` is unauthenticated and that's fine here.

(We still gate server-side as the robust chokepoint — see plan — but that's about
killing spam reliably, not about defeating a hostile client.)

## 3. Scope / non-goals

In scope:
- Host designation (first joiner = host), mode toggle, host-only gating of all
  room-moving events, guest snap-back, deliberate-desync flow + resync, host UI.

Explicit non-goals (for this branch):
- Authenticated / spoof-proof host identity.
- Persistent host across server restarts (room state is in-memory).
- Syncing around personalized ad breaks.
- Host transfer UI (auto-fallback to `everyone` when host leaves; manual transfer
  is a possible later add).

## 4. Architecture summary

Three-layer gate for room-moving events from a non-host in host-only mode
(`PLAY`, `PAUSE`, `SEEK`, `FORCE_SYNC_PREPARE`, `FORCE_SYNC_EXECUTE`, `EPISODE_LOBBY`):
1. **Server** — doesn't relay them (robust chokepoint, kills spam regardless of client).
2. **Sender (guest)** — doesn't emit; shows confirm dialog / disables host-only buttons.
3. **Receiver** — drops any that slip through (covers old/buggy/modified clients).

Snap-back reuses the existing `_setSuppress` mechanism (content.js:442) so applying
the room state programmatically doesn't echo back as a new event. Target position is
extrapolated from the host's last known state (±1s). Full detail + code hooks in the
plan doc.

---

## 5. The central challenge

Everything hard about this feature reduces to **one question** (see EC-9):

> How do we reliably tell a **deliberate** guest pause/seek from an **involuntary**
> player/browser event (buffering, ads, tab throttling, source swaps, DRM hiccups)?

If we get this wrong, guests get spammed with desync dialogs and snap-back loops for
things they never did. The host/role plumbing is the easy part; this classifier is the
real work. **Design the intent-classifier before writing the gate.**

---

## 6. Edge cases

### EC-1 🔴 Buffering / loading fires a `pause` event
content.js listens to `play`/`pause`/`seeked`/`loadeddata` only (content.js:1000-1003),
not `waiting`/`stalled`. Pure HTML5 buffering fires `waiting` → harmless. But custom
players (Netflix/YouTube/Twitch/JW) often call `video.pause()` during buffering/ads →
real `pause` → guest gate would mis-classify as deliberate. Sub-cases: (a) initial load
sits paused, no event, fine; (b) mid-stream stall, player-dependent; (c) seek-induced
re-buffering may outlast the suppress window and leak. Mitigation: `isBuffering` flag
from `waiting`/`playing`, or grace window; in host-only the guest's own state is
irrelevant so just ignore involuntary pauses and let catch-up logic (content.js:489)
re-sync them.

### EC-2 🟢 Force-Sync / Episode-Lobby abuse by guests
Guest could seek + spam Force-Sync to drag everyone, or spam Episode-Lobby to pause
everyone. Decision: host-only blocks guest *initiation* of `FORCE_SYNC_*` and
`EPISODE_LOBBY`; guests may only respond (`FORCE_SYNC_ACK`, `EPISODE_READY`). Guests'
legitimate path is the personal "Resync" button.

### EC-3 🟢 Host leaves the room
Fall back to `controlMode = 'everyone'`, broadcast `CONTROL_MODE`. Never a stuck locked
room. (Auto-promote next peer deferred.)

### EC-4 🔴 Snap-back fight loop (pause/play/skip back/pause/play)
Mashing controls or a janky player → each snap-back may emit events → ping-pong.
Mitigation: cooldown (~600ms) after snap-back; ensure snap-back runs fully under
suppress. Also: if target is unreachable (seek past buffered range), retry K times then
give up — no infinite loop.

### EC-5 🔴 Ad breaks (YouTube/Twitch/…)
Mid-roll ads pause/swap the media element, differ per peer → desync is unavoidable and
must NOT spam the dialog. Probably covered by EC-1 buffering grace; flag for explicit
testing.

### EC-6 🟡 Snap-back target accuracy
No continuous room clock; extrapolate from host's `currentTime` + `lastHeartbeat`
(±1s, worse if stale). The follow-up host correction must also be suppressed so it
doesn't read as guest input.

### EC-7 🟢 Old / buggy / modified guest client
Covered by receiver-side + server-side gates.

### EC-8 🔴 Tab throttling / background tab
Backgrounding throttles timers and may pause media. There's existing
`visibilityGraceUntil` handling for seeks (content.js:892). Confirm a
background-induced pause isn't treated as deliberate in host-only; reuse the grace flag.

### EC-9 🔴 What counts as "deliberate" — the central unresolved question
Collapses EC-1/EC-5/EC-8. Candidate signals: `readyState`/`networkState`/`video.seeking`
at event time; recent `waiting`; recent user gesture (`navigator.userActivation`,
keydown/click); visibility/focus. Build one shared **intent-classifier** helper in
content.js that all host-only gating flows through.

### EC-10 🔴 Host brief disconnect / reconnect (network blip)
Host's wifi drops for 3s and reconnects. With "host leaves → fallback to everyone",
a blip would silently unlock the room and demote the host (peerId persists in
chrome.storage so they rejoin with the same id, but the server already cleared
`hostPeerId`). Mitigation idea: short **host grace period** (e.g. keep `hostPeerId`
reserved for ~30s after disconnect; if the same peerId rejoins, restore host + mode).
Needs the server reaper (server:644) and `removePeerFromRoom` (server:168) to cooperate.

### EC-11 🔴 New guest joins mid-session in host-only mode
On join they must (a) immediately sync to the host's current position without the host
doing anything, and (b) see they're a guest in the UI. ROOM_DATA already carries peers;
add `hostPeerId`/`controlMode` so a fresh client knows its role instantly. Verify the
existing "newcomer syncs without waiting" path (content.js:542) still fires.

### EC-12 🔴 Desync semantics — what does "solo" actually mean?
When a guest chooses "pause only me", do they (a) fully ignore all subsequent host
events until they Resync, or (b) keep receiving but not auto-applying? Define clearly.
Proposed: full solo — ignore host play/pause/seek while desynced; Resync re-attaches and
snaps to current host position. Also: what state does Resync land them in if the host is
currently paused vs playing?

### EC-13 🔴 Race: host flips to host-only exactly as a guest pauses
Event ordering between `SET_CONTROL_MODE`/`CONTROL_MODE` and an in-flight guest `PAUSE`.
The `seq` ordering helps, but define the tie-break. Likely: server is authoritative —
once it has `host-only`, it drops the guest event regardless of client-side timing.

### EC-14 🟡 Volume / mute / audio-options must NOT be gated
Those are per-peer, not room control. The gate must target only play/pause/seek +
forcesync/episode — not `PEER_STATUS` volume/mute fields. Easy to over-block; add a test.

### EC-15 🔴 Live streams (Twitch live, live DVR)
"Room timestamp" is fuzzy on live edge; seeking semantics differ. Decide whether
host-only even makes sense for live, or degrade gracefully. Low priority but log it.

### EC-16 🟡 Host's own involuntary events still drive the room
If the host buffers and the player auto-pauses, that pause is "allowed" and pauses
everyone. That's existing behavior, but in host-only it means the host's buffering
stalls the whole room. Acceptable? Probably yes (host is authoritative), but note it.

### EC-17 🟡 Server restart drops room state
`hostPeerId`/`controlMode` are in-memory. After a server restart, whoever rejoins first
becomes the new host and mode resets to `everyone`. Acceptable for now (non-goal), but
document so it's not a surprise.

### EC-18 🟡 Dialog dismissed without choosing
Guest clicks away / presses Esc on the desync prompt. Default = treat as "No" → snap
back. Make sure an un-answered dialog can't leave them in limbo (paused + not desynced +
no dialog).

### EC-19 🟡 Multiple video elements / element swap (SPA, ad → content)
Players that swap the `<video>` element mid-session: re-attach handlers (content.js
already re-binds on `loadeddata`) and make sure host-only gating follows the new element.

### EC-20 🟡 Peer list shape (object vs legacy string)
Throughout background.js peers may be objects or bare peerId strings
(`typeof p === 'object' ? p.peerId : p`). All new `hostPeerId` comparisons must handle
both forms, or we get a host that's never recognized.

### EC-21 🟡 Mode toggle spam / rate limiting
Host hammering the toggle → many `SET_CONTROL_MODE`. Covered by existing
`checkEventRate` (server), but debounce in the UI and ignore no-op transitions.

---

## 7. Test matrix (fill in during dev)

| Player            | Buffer→`pause`? | Ad behavior | Snap-back works? | Element swap? | Notes |
|-------------------|-----------------|-------------|------------------|---------------|-------|
| Generic HTML5     |                 |             |                  |               |       |
| YouTube           |                 |             |                  |               |       |
| Netflix           |                 |             |                  |               |       |
| Twitch (VOD)      |                 |             |                  |               |       |
| Twitch (live)     |                 |             |                  |               |       |
| Disney+ / DRM     |                 |             |                  |               |       |
| Jellyfin / Emby   |                 |             |                  |               |       |

## 8. Decisions (audited)
- [x] **Intent-classifier (EC-9):** A `pause`/`seek` is **involuntary** if ANY of:
  `readyState < 3`, `video.seeking`, a `waiting` fired < ~1500ms ago (`isBuffering`
  flag), inside `visibilityGraceUntil`, OR no own-tracked user gesture
  (`Date.now() - lastUserGestureAt < 1000`, via capturing keydown/pointerdown — do
  NOT use sticky `navigator.userActivation.hasBeenActive`). Bias: only *clearly*
  involuntary is ignored; everything else = deliberate. **Note:** in host-only the
  guest never broadcasts anyway, so this only decides dialog-vs-silent — a UX call,
  not a room-integrity call. Start simple, tune later.
- [x] **Host grace on disconnect (EC-10): NOT in v1.** Immediate fallback to
  `everyone` (EC-3). A grace window risks a multi-second hard-lock if the host never
  returns. Revisit as polish once the core flow works.
- [x] **Desync semantics (EC-12): full solo.** Ignore host play/pause/seek while
  desynced; Resync snaps to host position + adopts host play/pause state. Desync
  auto-clears on new media/episode. Requires a persistent, obvious "You are desynced"
  UI.
- [x] **Snap-back cooldown (EC-4): until-settled, not fixed.** Suppress re-trigger
  until `readyState>=3 && playing && |Δt|<tol`, hard-cap ~1500ms. Retry target up to
  3×, then give up (no infinite loop).
- [x] **Live streams (EC-15): degrade.** Disable the gate when
  `video.duration === Infinity`. Caveat: live-DVR may report finite duration and slip
  through — acceptable for v1.
