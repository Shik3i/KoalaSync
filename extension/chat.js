export function escapeChatHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatChatText(value) {
  return escapeChatHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

export function insertEmoji(value, emoji, start, end) {
  const text = String(value ?? '');
  const safeStart = Math.min(Math.max(Number.isInteger(start) ? start : text.length, 0), text.length);
  const safeEnd = Math.min(Math.max(Number.isInteger(end) ? end : safeStart, safeStart), text.length);
  return {
    value: `${text.slice(0, safeStart)}${emoji}${text.slice(safeEnd)}`,
    caret: safeStart + String(emoji).length
  };
}

export function createTypingTracker({ emit, timeoutMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let typing = false;
  let timer = null;
  const stop = () => {
    if (timer) clearTimer(timer);
    timer = null;
    if (!typing) return;
    typing = false;
    emit(false);
  };
  return {
    activity() {
      if (!typing) {
        typing = true;
        emit(true);
      }
      if (timer) clearTimer(timer);
      timer = setTimer(stop, timeoutMs);
    },
    stop
  };
}

export function createReceiptTracker() {
  const byMessage = new Map();
  return {
    markRead(messageId, peerId) {
      const readers = byMessage.get(messageId) || new Set();
      readers.add(peerId);
      byMessage.set(messageId, readers);
      return readers.size;
    },
    count(messageId) {
      return byMessage.get(messageId)?.size || 0;
    },
    clear() {
      byMessage.clear();
    }
  };
}

export function createRemoteTypingTracker({ onChange, timeoutMs = 2500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const peers = new Map();
  const notify = () => onChange(Array.from(peers.values(), (peer) => peer.username));
  const remove = (senderId) => {
    const existing = peers.get(senderId);
    if (existing?.timer) clearTimer(existing.timer);
    peers.delete(senderId);
    notify();
  };
  return {
    update(payload) {
      if (!payload?.senderId) return;
      if (payload.isTyping !== true) {
        remove(payload.senderId);
        return;
      }
      const existing = peers.get(payload.senderId);
      if (existing?.timer) clearTimer(existing.timer);
      const username = payload.username || payload.senderId;
      const timer = setTimer(() => remove(payload.senderId), timeoutMs);
      peers.set(payload.senderId, { username, timer });
      notify();
    },
    clear() {
      for (const peer of peers.values()) if (peer.timer) clearTimer(peer.timer);
      peers.clear();
      notify();
    }
  };
}
