# KoalaSync Chat (soonTMChat)

In-Room Text-Chat für synchronisierte Watch-Parties.

---

## Overview

Der Chat ermöglicht es Room-Mitgliedern, Textnachrichten auszutauschen, ohne die Video-Synchronisation zu unterbrechen.

**Status:** MVP (seit v2.6.0)  
**Privacy:** RAM-only, keine Persistenz

---

## Features

| Feature | Beschreibung |
|---------|--------------|
| **Text-Nachrichten** | Senden/Empfangen von Chat-Nachrichten an alle Room-Peers |
| **Emoji-Support** | Unicode-Emoji-Picker für schnelle Reaktionen |
| **Markdown-Formatting** | `**fett**` → **fett**, `*kursiv*` → *kursiv* |
| **Typing Indicator** | "X schreibt..." wird nach 1s Tippen angezeigt |
| **Read Receipts** | ⚪⚪ (gesendet) → ✓✓ (gelesen) |
| **Host-Kick** | Host kann Peers aus dem Chat kicken |
| **Dark Mode** | Automatisches Umschalten via `prefers-color-scheme` |
| **Rate-Limiting** | 10 Nachrichten/10s pro Peer (Spam-Schutz) |

---

## Technical Implementation

### Protocol Events

```javascript
// shared/constants.js
EVENTS.CHAT_MESSAGE    // "chat_message"    - User-Nachricht
EVENTS.CHAT_TYPING     // "chat_typing"     - Tippt gerade
EVENTS.CHAT_READ       // "chat_read"       - Read Receipt
EVENTS.CHAT_KICK       // "chat_kick"       - Peer kicken
EVENTS.CHAT_SYSTEM     // "chat_system"     - System-Nachricht
```

### Payloads

**chat_message:**
```json
{
  "id": "msg-123",
  "senderId": "a1b2c3d4",
  "username": "Alice",
  "text": "Hallo **Welt**!",
  "timestamp": 1719950400000
}
```

**chat_typing:**
```json
{
  "senderId": "a1b2c3d4",
  "username": "Alice",
  "isTyping": true
}
```

**chat_read:**
```json
{
  "senderId": "b2c3d4e5",
  "targetId": "a1b2c3d4",
  "messageId": "msg-123"
}
```

**chat_kick:**
```json
{
  "senderId": "host-peer-id",
  "targetId": "a1b2c3d4"
}
```

**chat_system:**
```json
{
  "type": "kick",
  "text": "Bob was kicked by Alice",
  "timestamp": 1719950400000
}
```

### Server-Side Security

| Maßnahme | Umsetzung |
|----------|-----------|
| **Rate-Limiting** | 10 Nachrichten/10s pro Socket, Disconnect bei Überschreitung |
| **XSS-Prävention** | Längen-/Typvalidierung plus kontextgerechtes Escaping unmittelbar vor der DOM-Ausgabe |
| **Host Control** | Host darf alle anderen entfernen; Controller nur normale Gäste, niemals Host/andere Controller |
| **Payload-Sanitization** | Text max. 500 Unicode-Zeichen, Username max. 30 Unicode-Zeichen, sichere Message-ID |

### Client-Side Security

| Maßnahme | Umsetzung |
|----------|-----------|
| **XSS-Prävention** | HTML-Escaping VOR begrenztem Markdown-Parsing; kein ungeprüftes HTML |
| **Input-Validation** | `maxlength="500"` am Input-Feld |
| **No Persistence** | Nachrichten nur im RAM, keine Speicherung |

---

## User Flow

### Nachricht senden
1. User tippt Text ins Chat-Input-Feld
2. Beim Tippen: "X schreibt..." wird bei Peers angezeigt; nach 1,5s Inaktivität endet der Status
3. User drückt Enter oder Klick auf Send-Button
4. Nachricht wird an Server gerelayt
5. Server validiert und ergänzt autoritative Identität, ID und Zeitstempel
6. Empfänger rendern Nachricht im Chat

### Read Receipt
1. Nachricht wird empfangen
2. Popup sendet `chat_read` an Server
3. Server relayt an `targetId` (Original-Sender)
4. Sender sieht Update: ⚪⚪ → ✓✓

### Host-Kick
1. Host klickt auf Kick-Button neben Peer-Name
2. `chat_kick` wird an Server gesendet
3. Server validiert: Host/Controller?
4. `removePeerFromRoom()` wird aufgerufen
5. System-Nachricht: "X was kicked by Y"
6. Gekickter Peer verliert Room-Zugang

---

## UI Components

### Chat Tab Structure
```
┌─────────────────────────────────┐
│  [Chat-Nachrichten Container]   │
│  ┌───────────────────────────┐  │
│  │ Alice: Hallo Welt!        │  │
│  │ Bob: **Hi**!               │  │
│  │ [System] Bob joined       │  │
│  └───────────────────────────┘  │
│  [Typing Indicator: "Alice schreibt..."]
│  ┌───────────────────────────┐  │
│  │ 😀 │ Type a message... │ ➤│  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Read Receipt States
| Zustand | Symbol | Bedeutung |
|---------|--------|-----------|
| Gesendet | ⚪⚪ | Nachricht beim Server |
| Gelesen | ✓✓ | Empfänger hat Nachricht gesehen |

---

## Testing

### Manual Test Plan

**Setup:**
- 2 Browser-Profile (oder Chrome + Firefox)
- Beide verbinden zum gleichen Room

**Test Cases:**

| # | Test | Erwartet |
|---|------|----------|
| 1 | Nachricht senden | Empfänger sieht sie |
| 2 | Emoji einfügen | Emoji wird gerendert |
| 3 | `**fett**` `*kursiv*` | Formatting funktioniert |
| 4 | Tippen | "X schreibt..." erscheint |
| 5 | Nachricht lesen | Read Receipt aktualisiert |
| 6 | 10+ Nachrichten in 10s | Rate-Limit kickt |
| 7 | `<script>alert('xss')</script>` | Escaped output |
| 8 | Host kickt Peer | Peer wird entfernt |
| 9 | Dark Mode | Chat-Styling passt sich an |

### Automated release coverage

- Unit-Tests für Server-Validierung, History, sichere Markdown-Ausgabe, Emoji-Einfügung, Typing und Receipts
- Echte Zwei-Client-WebSocket-Tests für Nachrichten, Identität, History, Typing, Receipts, Room-Isolation und Kick-Rechte
- Extension-Integrationschecks für verlustfreien Background-Transport und vollständige Popup-Verdrahtung
- Alle Chat-Suiten sind Bestandteil von `npm run verify`

---

## Privacy & Security

### Data Retention

| Datentyp | Retention | Löschung |
|----------|-----------|----------|
| Chat-Nachrichten | Bis zu 100 Nachrichten solange der Room existiert | Beim Löschen des Rooms/Serverneustart |
| Read Receipts | Nur im geöffneten Popup | Beim Schließen/Verlassen des Rooms |
| Typing-Status | 1,5s Inaktivität; Empfänger-Fallback 2,5s | Automatisch |

### Threat Model

**Geschützt gegen:**
- ✅ Spam/DoS (Rate-Limiting)
- ✅ XSS (HTML-Escaping)
- ✅ Guest-Disruption (Host Control Mode)

**Nicht geschützt gegen:**
- ⚠️ Modifizierte Clients (kann eigene Nachrichten manipulieren)
- ⚠️ Social Engineering (Nutzer kann eigene Nachrichten schreiben)

→ Siehe [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) für Details.

---

## Known Issues

| Issue | Status | Workaround |
|-------|--------|------------|
| Private Messages | Out of Scope | N/A |
| File/Image Sharing | Out of Scope | N/A |
| Chat-History | Out of Scope | N/A |
| Advanced Formatting | Backlog | N/A |

---

## Related Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — Kommunikationsflüsse, Host Control Mode
- [PROTOCOL.md](PROTOCOL.md) — WebSocket-Event-Referenz
- [host-control-mode.md](host-control-mode.md) — Host-Kick Berechtigungen
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — NOFIX-Einträge

---

**Implementation:** soonTMChat (v2.6.0)  
**Last Updated:** 2026-07-02
