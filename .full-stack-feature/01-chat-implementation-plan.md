# Chat MVP Implementierungsplan

## Feature Overview

**Feature:** In-Room Text Chat für KoalaSync  
**Priority:** P3 (Backlog → MVP)  
**Complexity:** Medium  
**Estimated Time:** 3-4 Stunden

---

## Acceptance Criteria

- [ ] Users können Textnachrichten im Chat-Tab senden/empfangen
- [ ] Nachrichten werden an alle Room-Pees relayt
- [ ] Emoji-Picker für Unicode-Emojis verfügbar
- [ ] Text-Formatting (Bold, Italic) via Markdown-Syntax
- [ ] "X schreibt..." Indikator (debounced, 1s)
- [ ] Read Receipts (Doppel-Haken: ⚪⚪ → ⚪✓ → ✓✓)
- [ ] Host kann Peers aus dem Chat kicken (`chat_kick`)
- [ ] Dark Mode Support (CSS Variables)
- [ ] Rate-Limiting (10 Nachrichten/10s pro Peer)
- [ ] XSS-Prävention (HTML-Escaping)
- [ ] Keine Persistenz (RAM-only, flüchtig)

---

## Technical Scope

### In Scope

| Component | Files | Changes |
|-----------|-------|---------|
| **Protocol** | `shared/constants.js` | `CHAT_MESSAGE`, `CHAT_SYSTEM`, `CHAT_TYPING`, `CHAT_READ`, `CHAT_KICK` |
| **Server** | `server/index.js` | Event-Handler für Chat-Events, Rate-Limiting, Kick-Logik |
| **Popup UI** | `extension/popup.html` | Chat-Tab HTML-Struktur |
| **Popup Logic** | `extension/popup.js` | Chat-Tab JavaScript (Send/Receive/Render) |
| **Background** | `extension/background.js` | Chat-Event-Routing zwischen Popup ↔ Server |
| **Styling** | `extension/popup.html` (inline CSS) | Chat-spezifische Styles + Dark Mode |

### Out of Scope

- Private Messages
- File/Image Sharing
- Chat-History Persistenz
- Emoji-Custom-Pack (nur Unicode)
- Advanced Formatting (Code, Links, Lists)
- Moderation-History/Logs

---

## Implementation Steps

### Step 1: Protocol Constants (15 min)

**File:** `shared/constants.js`

**Tasks:**
1. Neue Event-Namen zu `EVENTS` hinzufügen:
   ```javascript
   CHAT_MESSAGE: "chat_message",
   CHAT_TYPING: "chat_typing",
   CHAT_READ: "chat_read",
   CHAT_KICK: "chat_kick",
   CHAT_SYSTEM: "chat_system"
   ```

2. Build-Skript ausführen:
   ```bash
   node scripts/build-extension.cjs
   ```

**Verification:**
- [ ] Constants in `shared/constants.js` aktualisiert
- [ ] Build ohne Fehler durchgelaufen
- [ ] `dist/` neu generiert

---

### Step 2: Server-Side Implementation (45 min)

**File:** `server/index.js`

**Tasks:**

1. **Event-Handler registrieren:**
   ```javascript
   socket.on('chat_message', handleChatMessage);
   socket.on('chat_typing', handleChatTyping);
   socket.on('chat_read', handleChatRead);
   socket.on('chat_kick', handleChatKick);
   ```

2. **Rate-Limiting für Chat:**
   - Counter pro Socket (10 Nachrichten/10s)
   - Bei Überschreitung: Socket disconnect + Log

3. **Payload-Sanitization:**
   ```javascript
   {
     text: sanitizeText(payload.text, 500),      // max 500 chars
     senderId: sanitizeString(payload.senderId, 16),
     username: sanitizeString(payload.username, 30),
     timestamp: Date.now()
   }
   ```
   - HTML-Escaping für XSS-Prävention (`<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`)

4. **Relay-Logik:**
   - `chat_message`: Broadcast an alle anderen Peers im Room
   - `chat_typing`: Broadcast an alle anderen Peers (debounced)
   - `chat_read`: Relay nur an `targetId` (Read Receipt)
   - `chat_kick`: Nur Host/Controller → removePeerFromRoom()

5. **System-Nachrichten:**
   - Bei Join: `chat_system` an alle (`"X joined the room"`)
   - Bei Leave: `chat_system` an alle (`"X left the room"`)

**Verification:**
- [ ] Unit-Tests für Rate-Limiting (`server/rate-limiter.test.mjs`)
- [ ] Manueller Test: 10+ Nachrichten in <10s → Disconnect
- [ ] XSS-Test: `<script>alert('xss')</script>` → escaped

---

### Step 3: Popup UI Structure (30 min)

**File:** `extension/popup.html`

**Tasks:**

1. **Chat-Tab hinzufügen:**
   ```html
   <div id="chat-tab" class="tab-content" style="display: none;">
     <div class="chat-container">
       <div class="chat-messages" id="chat-messages"></div>
       <div class="chat-typing-indicator" id="chat-typing-indicator"></div>
       <div class="chat-input-row">
         <button id="emoji-btn" title="Emoji">😀</button>
         <input type="text" id="chat-input" placeholder="Type a message..." maxlength="500">
         <button id="send-btn" title="Send">➤</button>
       </div>
     </div>
   </div>
   ```

2. **Tab-Navigation aktualisieren:**
   - Chat-Tab Button im Tab-Menu hinzufügen

3. **Inline-CSS für Chat:**
   ```css
   .chat-container { display: flex; flex-direction: column; height: 400px; }
   .chat-messages { flex: 1; overflow-y: auto; padding: 10px; }
   .message { margin: 8px 0; padding: 8px 12px; border-radius: 8px; }
   .message.own { background: #007bff; color: white; align-self: flex-end; }
   .message.other { background: #e9ecef; }
   .message.system { background: transparent; font-style: italic; text-align: center; }
   .message-header { font-size: 0.75rem; opacity: 0.7; margin-bottom: 4px; }
   .message-text { word-break: break-word; }
   .message-meta { font-size: 0.7rem; opacity: 0.5; margin-top: 4px; }
   .chat-input-row { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #ddd; }
   #chat-input { flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
   .emoji-picker { position: absolute; bottom: 60px; right: 10px; display: none; }
   .typing-indicator { font-size: 0.8rem; font-style: italic; color: #666; padding: 0 10px; }
   .read-receipt { font-size: 0.7rem; float: right; margin-left: 8px; }
   ```

4. **Dark Mode CSS Variables:**
   ```css
   :root {
     --chat-bg: #ffffff;
     --chat-text: #333333;
     --chat-message-own: #007bff;
     --chat-message-other: #e9ecef;
   }
   @media (prefers-color-scheme: dark) {
     :root {
       --chat-bg: #1a1a1a;
       --chat-text: #e0e0e0;
       --chat-message-own: #005cbf;
       --chat-message-other: #333333;
     }
   }
   ```

**Verification:**
- [ ] Chat-Tab sichtbar nach Klick
- [ ] Nachrichten-Container scrollt korrekt
- [ ] Input-Feld + Buttons gerendert
- [ ] Dark Mode erkennt System-Preference

---

### Step 4: Popup Logic (60 min)

**File:** `extension/popup.js`

**Tasks:**

1. **State Variables:**
   ```javascript
   let chatMessages = [];           // Lokaler Nachrichten-Cache
   let typingDebounce = null;       // Debounce Timer für "typing"
   let readReceipts = new Map();    // messageId → read status
   ```

2. **Send Message:**
   ```javascript
   async function sendChatMessage(text) {
     if (!text.trim()) return;
     
     const message = {
       id: generateMessageId(),
       senderId: peerId,
       username: username,
       text: sanitizeText(text),
       timestamp: Date.now(),
       type: 'chat_message'
     };
     
     background.sendMessage({ type: 'CHAT_MESSAGE', payload: message });
     addMessageToUI(message, 'own');
     document.getElementById('chat-input').value = '';
   }
   ```

3. **Receive Message:**
   ```javascript
   chrome.runtime.onMessage.addListener((msg) => {
     if (msg.type === 'CHAT_MESSAGE_RECEIVED') {
       addMessageToUI(msg.payload, 'other');
       // Send Read Receipt
       background.sendMessage({ 
         type: 'CHAT_READ', 
         payload: { messageId: msg.payload.id, targetId: msg.payload.senderId }
       });
     }
     if (msg.type === 'CHAT_READ_RECEIVED') {
       updateReadReceipt(msg.payload.messageId);
     }
   });
   ```

4. **Typing Indicator:**
   ```javascript
   document.getElementById('chat-input').addEventListener('input', () => {
     clearTimeout(typingDebounce);
     background.sendMessage({ type: 'CHAT_TYPING' });
     typingDebounce = setTimeout(() => {
       // Stop typing indicator nach 1s
     }, 1000);
   });
   ```

5. **Render Message:**
   ```javascript
   function addMessageToUI(message, type) {
     const container = document.getElementById('chat-messages');
     const div = document.createElement('div');
     div.className = `message ${type}`;
     div.dataset.messageId = message.id;
     
     div.innerHTML = `
       <div class="message-header">${escapeHtml(message.username)} • ${formatTime(message.timestamp)}</div>
       <div class="message-text">${formatMessageText(message.text)}</div>
       <div class="message-meta">${getReadReceiptHTML(message.id)}</div>
     `;
     
     container.appendChild(div);
     container.scrollTop = container.scrollHeight;
   }
   ```

6. **Text Formatting:**
   ```javascript
   function formatMessageText(text) {
     // Markdown → HTML
     text = escapeHtml(text);  // XSS prevention FIRST
     text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');  // Bold
     text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');  // Italic
     return text;
   }
   ```

7. **Emoji Picker:**
   ```javascript
   const commonEmojis = ['😀','😂','😍','👍','🎉','🔥','❤️','🍿','🎬','👋'];
   
   function toggleEmojiPicker() {
     const picker = document.getElementById('emoji-picker');
     picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
   }
   
   function insertEmoji(emoji) {
     const input = document.getElementById('chat-input');
     input.value += emoji;
     input.focus();
   }
   ```

8. **Read Receipts:**
   ```javascript
   function updateReadReceipt(messageId) {
     const receipt = readReceipts.get(messageId);
     if (receipt) {
       receipt.read = true;
       renderReadReceipt(messageId);
     }
   }
   
   function getReadReceiptHTML(messageId) {
     const receipt = readReceipts.get(messageId);
     if (!receipt) return '';
     if (!receipt.read) return '⚪⚪';  // Sent
     return '✓✓';  // Read
   }
   ```

**Verification:**
- [ ] Nachrichten senden funktioniert
- [ ] Empfangene Nachrichten werden gerendert
- [ ] "X schreibt..." erscheint nach Tippen
- [ ] Emoji-Picker öffnet/schließt
- [ ] Bold/Italic Formatting funktioniert
- [ ] Read Receipts aktualisieren (⚪⚪ → ✓✓)

---

### Step 5: Background Event Routing (30 min)

**File:** `extension/background.js`

**Tasks:**

1. **Message Routing (Popup → Server):**
   ```javascript
   chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
     if (msg.type === 'CHAT_MESSAGE') {
       socket.emit(EVENTS.CHAT_MESSAGE, {
         senderId: peerId,
         username: username,
         text: msg.payload.text,
         timestamp: msg.payload.timestamp
       });
     }
     if (msg.type === 'CHAT_TYPING') {
       socket.emit(EVENTS.CHAT_TYPING, {
         senderId: peerId,
         username: username,
         isTyping: true
       });
     }
     if (msg.type === 'CHAT_READ') {
       socket.emit(EVENTS.CHAT_READ, {
         senderId: peerId,
         targetId: msg.payload.targetId,
         messageId: msg.payload.messageId
       });
     }
     if (msg.type === 'CHAT_KICK') {
       socket.emit(EVENTS.CHAT_KICK, {
         senderId: peerId,
         targetId: msg.payload.targetId
       });
     }
   });
   ```

2. **Message Routing (Server → Popup):**
   ```javascript
   socket.on(EVENTS.CHAT_MESSAGE, (payload) => {
     chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
       chrome.tabs.sendMessage(tabs[0].id, {
         type: 'CHAT_MESSAGE_RECEIVED',
         payload: payload
       });
     });
   });
   
   socket.on(EVENTS.CHAT_TYPING, (payload) => {
     // Forward to popup for typing indicator
   });
   
   socket.on(EVENTS.CHAT_READ, (payload) => {
     // Forward to popup for read receipt update
   });
   ```

**Verification:**
- [ ] Chat-Nachrichten werden vom Server empfangen
- [ ] Typing-Events werden gesendet
- [ ] Read Receipts werden gerelayt

---

### Step 6: Build & Integration Test (30 min)

**Commands:**
```bash
# Build extension
npm run build:extension

# Lint check
npm run lint

# Load unpacked extension
# Chrome: chrome://extensions/ → Load unpacked → dist/chrome/
```

**Manual Test Plan:**

1. **Setup:**
   - 2 Browser-Profile (oder Chrome + Firefox)
   - Beide verbinden zum gleichen Room

2. **Test Cases:**
   - [ ] Nachricht senden → Empfänger sieht sie
   - [ ] Emoji einfügen → Emoji wird gerendert
   - [ ] **Fett** kursiv → Formatting funktioniert
   - [ ] Tippen → "X schreibt..." erscheint
   - [ ] Nachricht lesen → Read Receipt aktualisiert
   - [ ] 10+ Nachrichten in 10s → Rate-Limit kickt
   - [ ] XSS-Versuch (`<script>...`) → escaped
   - [ ] Host kickt Peer → Peer wird entfernt
   - [ ] Dark Mode → Chat-Styling passt sich an

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| XSS durch User-Input | High | Medium | HTML-Escaping vor Markdown-Parsing |
| Rate-Limit False Positives | Medium | Low | 10/10s ist großzügig |
| Chat-Spam | Low | Medium | Rate-Limit + Kick-Option |
| Dark Mode Bugs | Low | Medium | CSS Variables isoliert testen |
| Read Receipt Race Conditions | Low | Low | Message-ID als Primary Key |

---

## Files Modified/Created

| File | Type | Changes |
|------|------|---------|
| `shared/constants.js` | Modified | 5 neue Event-Namen |
| `server/index.js` | Modified | 4 Event-Handler + Rate-Limit |
| `extension/popup.html` | Modified | Chat-Tab HTML + CSS |
| `extension/popup.js` | Modified | Chat-Logic (~300 Zeilen) |
| `extension/background.js` | Modified | Chat Event-Routing |

---

## Next Steps

1. **Plan Review:** User prüft und genehmigt diesen Plan
2. **Implementation:** Steps 1-6 sequentiell umsetzen
3. **Testing:** Manual Test Plan ausführen
4. **Documentation:** Kurze Doku in `docs/CHAT.md` (optional)

---

**Approval Required:**

- [ ] Plan genehmigt → Mit Implementation beginnen
- [ ] Änderungen gewünscht → Feedback einarbeiten
- [ ] Pause/Stop → Plan archivieren
