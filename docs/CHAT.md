# KoalaSync Chat

In-room text chat for synchronized watch parties.

## Status

- Storage: RAM-only per room.
- Persistence: none across room deletion or server restart.
- Rendering: plain text plus Unicode emoji characters typed by the user.
- Markdown, image sharing, files, private messages, and link previews are out of scope.

## Server Configuration

`CHAT_HISTORY_LIMIT` controls chat availability and room history size.

| Value | Behavior |
|-------|----------|
| unset / invalid | Defaults to `100` messages per room |
| `0` | Disables chat entirely on the server |
| `1..500` | Enables chat and caps room history at that many messages |
| `>500` | Clamped to `500` |

Docker/self-hosted deployments can set this as a normal server environment variable.

## Features

| Feature | Behavior |
|---------|----------|
| Text messages | Room-wide plain-text messages |
| Chat history | Last `CHAT_HISTORY_LIMIT` messages, sent in `room_data` |
| Typing indicator | Broadcasts transient typing state to other room peers |
| Read receipts | Recipient sends `chat_read` to the original sender |
| Chat ban | Host/controller can ban a peer from chat without removing them from sync |
| Chat unban | Host/controller can restore chat access |
| System messages | Server-generated moderation messages |

## Protocol Events

```javascript
EVENTS.CHAT_MESSAGE  // "chat_message"
EVENTS.CHAT_TYPING   // "chat_typing"
EVENTS.CHAT_READ     // "chat_read"
EVENTS.CHAT_BAN      // "chat_ban"
EVENTS.CHAT_UNBAN    // "chat_unban"
EVENTS.CHAT_SYSTEM   // "chat_system"
```

The relay advertises chat support with `CAPABILITIES.CHAT` (`"chat"`). If the capability is absent, clients must disable chat UI.

## Payloads

### `chat_message`

Client sends:

```json
{
  "username": "Alice",
  "text": "Hello everyone"
}
```

Server relays to sender and room peers:

```json
{
  "id": "chat-1719950400000-1",
  "senderId": "a1b2c3d4",
  "username": "Alice",
  "text": "Hello everyone",
  "timestamp": 1719950400000
}
```

The server owns `id`, `senderId`, and `timestamp`.

### `chat_typing`

```json
{
  "senderId": "a1b2c3d4",
  "username": "Alice",
  "isTyping": true
}
```

### `chat_read`

```json
{
  "senderId": "b2c3d4e5",
  "targetId": "a1b2c3d4",
  "messageId": "chat-1719950400000-1"
}
```

The server only relays read receipts when sender and target are in the same room.

### `chat_ban` / `chat_unban`

Client sends:

```json
{
  "targetId": "b2c3d4e5"
}
```

Server broadcasts:

```json
{
  "senderId": "host-peer-id",
  "targetId": "b2c3d4e5",
  "chatBannedPeerIds": ["b2c3d4e5"],
  "timestamp": 1719950400000
}
```

Only host/controllers may send these events. A banned peer remains in the sync room but cannot send chat messages, typing events, or read receipts.

### `chat_system`

Server-generated only:

```json
{
  "id": "system-1719950400000-abc123",
  "text": "b2c3d4e5 was banned from chat by host-peer-id",
  "timestamp": 1719950400000
}
```

Clients cannot broadcast arbitrary system messages.

## `room_data` Additions

```json
{
  "capabilities": ["host-control", "co-host", "chat"],
  "chatHistory": [],
  "chatBannedPeerIds": []
}
```

`chatHistory` is empty when chat is disabled or no messages have been sent.

## Security

- Chat is disabled if the relay does not advertise `CAPABILITIES.CHAT`.
- Server rate limits chat events using the existing per-socket event limiter.
- Server rejects chat activity from chat-banned peers.
- Server validates same-room delivery for read receipts.
- Popup rendering uses DOM APIs and `textContent`, not raw user-controlled `innerHTML`.
- Server never trusts client-provided `senderId`.

## Manual Test Plan

1. Join one room from two browser profiles.
2. Send a message from profile A and verify profile B receives it.
3. Rejoin with profile C and verify history loads.
4. Send `<script>alert(1)</script>` and verify it renders as text.
5. Verify typing indicator appears while another peer types.
6. Verify read receipt appears on the sender side.
7. As host/controller, ban profile B from chat.
8. Verify profile B remains in sync room but chat input is disabled and messages do not relay.
9. Unban profile B and verify chat works again.
10. Start server with `CHAT_HISTORY_LIMIT=0` and verify chat UI reports server-disabled chat.
