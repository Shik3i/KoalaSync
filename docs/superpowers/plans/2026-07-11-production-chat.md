# Production Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every documented KoalaSync chat feature as a secure, tested, dependency-free production implementation.

**Architecture:** Extract protocol policy into `server/chat.js` and browser-safe presentation/state helpers into `extension/chat.js`. Keep Socket.IO and Chrome runtime files as adapters, with canonical payloads flowing unchanged across server, background, and popup.

**Tech Stack:** Node.js ES modules, Socket.IO 4, Chrome extension APIs, Vitest, existing Node integration-test scripts.

## Global Constraints

- Keep every feature currently documented in `docs/CHAT.md`.
- Add no runtime dependency and persist no chat content.
- Server identity, timestamps, authorization, and room boundaries are authoritative.
- User-controlled HTML must never reach an executable DOM context.
- Chat history is RAM-only and limited to 100 canonical messages per room.
- Preserve unrelated user changes and avoid unrelated refactors.

---

### Task 1: Server chat policy module

**Files:**
- Create: `server/chat.js`
- Create: `server/chat.test.mjs`

**Interfaces:**
- Produces: `sanitizeChatText(value)`, `sanitizeChatUsername(value)`, `normalizeMessageId(value, createId)`, `createChatMessage(data, sender, now, createId)`, `appendChatHistory(history, message, limit)`, and `isPeerInRoom(targetSocketId, roomId, socketToRoom)`.

- [ ] Write Vitest tests proving safe escaping, code-point limits, server-authoritative fields, safe IDs, 100-message history, and room isolation.
- [ ] Run `npx vitest run server/chat.test.mjs` and confirm failures because `server/chat.js` does not exist.
- [ ] Implement only the tested pure helpers in `server/chat.js`.
- [ ] Run `npx vitest run server/chat.test.mjs` and confirm all tests pass.

### Task 2: Extension chat presentation module

**Files:**
- Create: `extension/chat.js`
- Create: `extension/chat.test.mjs`

**Interfaces:**
- Produces: `formatChatText(text)`, `insertEmoji(text, emoji, start, end)`, `createTypingTracker(options)`, and `createReceiptTracker()`.

- [ ] Write Vitest tests proving HTML/event attributes are escaped, only bold/italic markup is generated, emoji insertion preserves caret semantics, typing emits deterministic start/stop, and duplicate receipts are deduplicated.
- [ ] Run `npx vitest run extension/chat.test.mjs` and confirm failures because `extension/chat.js` does not exist.
- [ ] Implement the minimal pure browser-independent helpers.
- [ ] Run `npx vitest run extension/chat.test.mjs` and confirm all tests pass.

### Task 3: Real server chat integration

**Files:**
- Modify: `server/index.js`
- Modify: `scripts/test-server-ws.mjs`

**Interfaces:**
- Consumes: server chat policy helpers from Task 1 and existing `EVENTS` constants.
- Produces: canonical, room-scoped Socket.IO chat behavior.

- [ ] Extend `scripts/test-server-ws.mjs` with two-client tests for canonical messages, escaping, history, typing boolean propagation, targeted read receipts, cross-room rejection, system-event rejection, host/controller kicks, and guest kick rejection.
- [ ] Run `node scripts/test-server-ws.mjs` and confirm the new assertions fail against the current handlers.
- [ ] Replace inline chat policy with imports from `server/chat.js`, preserve IDs, validate target room membership, make typing boolean explicit, and reject client-authored system messages.
- [ ] Run `node scripts/test-server-ws.mjs` and confirm all integration tests pass.

### Task 4: Background and popup integration

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`
- Create: `scripts/test-chat-extension.mjs`

**Interfaces:**
- Consumes: extension chat helpers from Task 2 and canonical server payloads from Task 3.
- Produces: complete runtime transport and UI interactions.

- [ ] Write `scripts/test-chat-extension.mjs` assertions for lossless message IDs, one outbound message branch, typing listeners and timeout, history rendering, system schema, emoji palette, and safe formatter use.
- [ ] Run `node scripts/test-chat-extension.mjs` and confirm it fails on the current duplicate/lost-field/incomplete wiring.
- [ ] Make background forwarding lossless and remove the unreachable duplicate branch.
- [ ] Wire popup history, system messages, typing lifecycle, receipts, safe rendering, and emoji palette through `extension/chat.js`.
- [ ] Complete accessible palette and dark-mode styling in `extension/popup.html`.
- [ ] Run `node scripts/test-chat-extension.mjs` and `npx vitest run extension/chat.test.mjs` until both pass.

### Task 5: Locales and release gate

**Files:**
- Modify: `extension/locales/*.json`
- Modify: `extension/_locales/*/messages.json` only if new DOM translation keys require it
- Modify: `scripts/verify-release.mjs`
- Modify: `docs/CHAT.md`

**Interfaces:**
- Consumes: completed chat behavior.
- Produces: consistent translated UI labels and a release gate that executes chat tests.

- [ ] Add chat UI keys to every JSON locale and remove duplicate Portuguese/Ukrainian keys.
- [ ] Add both new chat suites to `scripts/verify-release.mjs`.
- [ ] Update `docs/CHAT.md` to match canonical fields, security boundaries, history retention, and automated test coverage.
- [ ] Run locale tests and confirm all locales are structurally consistent.

### Task 6: Full verification and review

**Files:**
- Review all modified files; make no unrelated cleanup edits.

- [ ] Run `npm run verify` fresh and require exit code 0.
- [ ] Run `npm audit --omit=dev` in root and `server/`, requiring zero known production vulnerabilities.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the complete scoped diff.
- [ ] Confirm only intended project files changed and unrelated `.memsearch` state remains untouched.
