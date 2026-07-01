# Co-Host (Multi-Controller) — Implementation Plan

Branch base: `feature/host-control-mode` (builds directly on it).
Goal: let the room owner grant **playback control to several peers** (co-hosts), not
just one — e.g. 4 of N people in a room may drive play/pause/seek, the rest are guests.

This is the second server-gated feature the `capabilities` hook was designed for
(`CAPABILITIES.CO_HOST = 'co-host'`, already stubbed in `shared/constants.js`).

---

## 1. Roles

| Role | Can drive (play/pause/seek/force-sync/episode-lobby) | Can promote/demote + toggle mode |
|------|------|------|
| **Owner** (room creator, = today's "host") | yes (always a controller) | **yes** |
| **Controller** (co-host) | yes (in `host-only` mode) | no |
| **Guest** | only in `everyone` mode | no |

The single-host feature is just the special case `controllers = { owner }`.

## 2. Data model

### Server (`room` object)
- `ownerPeerId` — the creator / manager. Keep `hostPeerId` as an **alias** (= ownerPeerId)
  so older clients keep working.
- `controllers: Set<peerId>` — peers allowed to drive. **Always contains ownerPeerId.**
- `controlMode: 'everyone' | 'host-only'` — unchanged wire values (`'host-only'` now means
  "restricted to controllers", not "single host").
- `MAX_CONTROLLERS` cap (e.g. 10) to bound the set + payload.

### Shared constants
- `CAPABILITIES.CO_HOST = 'co-host'` (un-stub it) → add to `SERVER_CAPABILITIES`.
- New events:
  - `SET_PEER_ROLE` (client→server): `{ peerId, controller: boolean }` — owner promotes/demotes.
  - Extend `CONTROL_MODE` (server→client) payload: `{ controlMode, ownerPeerId, hostPeerId, controllers: [peerId...] }`.
- `ROOM_DATA` gains `ownerPeerId` + `controllers`.

## 3. Gate generalization (the core change)

Today the gate compares against a single `hostPeerId`. Generalize to set membership:

- **Server relay gate** (`server/index.js`): `controlMode === 'host-only' && !room.controllers.has(mapping.peerId)` → drop. (Was `mapping.peerId !== room.hostPeerId`.)
- **Background gates** (sender + receiver): replace `amHost()` / `senderId !== hostPeerId`
  with controller-set membership: `controllers.includes(myPeerId)` / `senderId ∈ controllers`.
- **Helpers:** split `amHost()` into `amOwner()` (manage rights) and `amController()`
  (drive rights). The desync/snap-back path keys on `!amController()` instead of `!amHost()`.

`SET_PEER_ROLE` handler (server): validate sender is owner, target is a current peer in the
room, enforce `MAX_CONTROLLERS`, always keep owner in the set, then broadcast `CONTROL_MODE`
with the new `controllers`.

## 4. Client + UI

- **Owner** sees the peer list with a per-peer **"Controller" toggle** (promote/demote) plus
  the existing mode toggle.
- **Controllers** see a "Controller" badge and are NOT locked out of the remote-control buttons.
- **Guests** see "Guest" + the host-only notice (unchanged).
- The promote UI + co-host badges render only when the relay advertises the `co-host`
  capability (feature detection, same pattern as `hostControlSupported`).
- i18n: new keys (`ROLE_CONTROLLER`, `BTN_PROMOTE`, `BTN_DEMOTE`, …) across all locales.

## 5. Backwards compatibility

- **New client + old server** (host-control only, no `co-host` capability): no co-host UI;
  behaves as today's single-host. ✓
- **Old client + new server**: ignores `controllers` / `SET_PEER_ROLE`. An old client that
  the owner promotes still **gates itself** (its sender-gate only knows `!amHost`), so it
  can't drive — it degrades to a guest. Co-host requires a client that understands
  `controllers`. Document this; not a crash. ✓
- No `PROTOCOL_VERSION` bump needed — purely additive, same as host-control.

## 6. Edge cases
- **Controller leaves** → `removePeerFromRoom` also does `room.controllers.delete(peerId)`.
- **Owner leaves** → fallback: promote the earliest remaining **controller** to owner (prefer
  a controller over a random peer); if none, earliest peer; keep the rest of the set. Reuse
  the `peerJoinLocks` guard so a reconnect/second-tab doesn't demote (same fix as host).
- **Promote a peer not in the room** → server rejects (target must be a live peer).
- **Promote beyond `MAX_CONTROLLERS`** → server rejects, re-syncs the owner's UI.
- **`everyone` mode** → the `controllers` set is still maintained (so flipping to `host-only`
  keeps the chosen co-hosts), it just isn't enforced while in `everyone`.
- **peerId spoofing** → unchanged accepted limitation (see `docs/KNOWN_LIMITATIONS.md`);
  co-host doesn't widen it materially (still bounded to a temporary room).

## 7. Scale: the "4 of 510 people" part — read this

The role change above is moderate. **Putting 510 people in one room is a separate, larger
problem** and should be its own track:

- `MAX_PEERS_PER_ROOM` is **25** today. 510 needs a large raise + load testing.
- **The real bottleneck at scale is heartbeat fan-out, not control events.** Every peer
  heartbeats and the relay broadcasts each to all peers → O(N²) per interval. At 510 that's
  ~510×509 / 15s ≈ **17k msg/s just for heartbeats** — the scaling wall.
- **Co-host actually *helps* the control-event side:** in `host-only` mode only the few
  controllers emit play/pause/seek, so event *sources* drop from N to K (e.g. 4). Restricting
  who can drive is synergistic with big rooms.
- Large rooms therefore need (independent of co-host):
  - **Heartbeat fan-out reduction** — e.g. only relay controller/owner heartbeats to everyone,
    relay guest heartbeats only to the owner/controllers (for the UI), or server-side
    aggregation into periodic snapshots instead of per-peer relay.
  - **`ROOM_DATA` payload trimming** — a 510-entry peer list is large; send counts + controller
    details, lazy-load the full roster.
  - Possibly the **socket.io Redis adapter** for horizontal scaling, and broadcast tuning.

## 8. Effort estimate
- **Co-host roles** (server gate generalization + `SET_PEER_ROLE` + owner-leave fallback +
  client gates + promote UI + i18n), at the current ≤25-peer scale: **~3–4 dev days** (same
  shape as host-control itself — mostly generalizing host→controller-set).
- **Large-room scaling (510)**: a **separate ~1–2 week** track (heartbeat redesign + payload
  trimming + cap raise + load testing), independent of co-host. Recommend shipping co-host at
  the current cap first, then scaling rooms as its own project.

## 9. Suggested sequencing
1. `CAPABILITIES.CO_HOST` + `controllers`/`ownerPeerId` in room state + `ROOM_DATA` (additive).
2. Server `SET_PEER_ROLE` + gate generalization + owner-leave fallback + WS tests.
3. Background: controller-set membership in both gates + `amOwner`/`amController`.
4. Popup: promote/demote toggles (owner) + Controller badge + i18n.
5. (Separate track) large-room scaling.
