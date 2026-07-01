# Host Control Mode — Beta Testing Guide

> Temporary doc for branch `feature/host-control-mode`. Remove before merge.
> The feature needs the **server** half too — the official relay
> (`wss://syncserver.koalastuff.net`) doesn't run it yet, so test against a beta
> server first.

## 1. Run the beta relay (Docker)

The branch publishes the server image to GHCR under non-production tags
(`:beta` = newest branch build, `:sha-<commit>` = immutable pin). `:latest` is
never touched.

```bash
# Log in (the package is private → PAT with read:packages)
echo "$GHCR_PAT" | docker login ghcr.io -u <your-gh-user> --password-stdin

# Pull + (re)create — NOTE: `docker restart` does NOT pick up a new image,
# you must remove and re-run (or use compose / Watchtower).
docker pull ghcr.io/shik3i/koalasync:beta
docker rm -f koala-beta 2>/dev/null || true
docker run -d --name koala-beta -p 3000:3000 \
  -e SERVER_SALT='choose-your-own-salt' \
  ghcr.io/shik3i/koalasync:beta
```

To always run the newest beta automatically, point **Watchtower** at the
container — it does the pull → recreate whenever `:beta` moves.

The `OFFICIAL_SERVER_TOKEN` is baked into `shared/constants.js`, so no token env
is needed. Set `SERVER_SALT` (used for room-password hashing).

## 2. Connect the extension to it

⚠️ The client **force-upgrades `ws://` to `wss://` for any non-localhost host**
(see background.js "Upgraded to wss:// for remote host"). So a bare
`ws://your-server:3000` will fail without TLS. Two options:

- **Quick (no TLS):** SSH-tunnel the port so it counts as local:
  ```bash
  ssh -L 3000:localhost:3000 your-beta-server
  ```
  then in the popup → **Manual Connect / Advanced → Custom →** `ws://localhost:3000`.
- **Proper:** put the container behind a TLS reverse proxy (Caddy does automatic
  HTTPS) → `wss://beta.yourdomain`.

Then create/join a room.

## 3. ⚠️ Use two *new* clients

Test with **two browser profiles both running this branch build** (load unpacked
from `extension/`, or install the built zip). A stock release client as a guest
will be correctly gated by the server but has none of the content-side code, so
it silently desyncs with no dialog/snap-back — that's expected degradation, not a
bug, but it looks like one during testing.

## 4. Verification checklist

| # | Step | Expect |
|---|------|--------|
| 1 | Create a room (host) | Host Control card shows **Host** + the toggle |
| 2 | Second profile joins | Guest sees no card while mode is "everyone" |
| 3 | Host enables "Only I can control" | Guest's Play/Pause/SYNC buttons lock; card shows **Guest** |
| 4 | Guest presses pause/space on the video | Brief flicker, snaps back to host position |
| 5 | Guest pauses again | Dialog: "Stay in sync" / "Watch on my own" |
| 6 | Guest → "Watch on my own" | Persistent "Solo" badge; host's peer list shows **Solo** |
| 7 | Guest → "Resync" | Snaps back to host; Solo badge clears on both sides |
| 8 | Guest tries Force-Sync / seek spam | Nothing propagates to the room |
| 9 | Host disables host-only | Card hides for guest; controls unlock |
| 10 | Host leaves the room | Room falls back to "everyone"; a remaining peer becomes host |
| 11 | Reload the guest's page while desynced | Still shows Solo (state survives reload) |
| 12 | Switch the popup language | Dialog/badge text is localized |

## 5. Capability detection

The relay advertises `capabilities: ['host-control']` in `ROOM_DATA`. The client
only enables the feature when that flag is present, so:
- against this beta server → feature on;
- against the old official server → feature cleanly hidden (no errors).

This is the extensible hook for the planned **co-host** feature (owner promotes
guests to additional controllers) — it'll add a `'co-host'` capability + events
without breaking older relays/clients.
