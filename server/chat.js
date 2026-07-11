import { randomUUID } from 'node:crypto';

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

export function parseChatHistoryLimit(value, fallback = 100) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(500, Math.max(0, parsed));
}

function limitCodePoints(value, limit) {
  return [...value].slice(0, limit).join('');
}

export function sanitizeChatText(value) {
  if (typeof value !== 'string') return '';
  return limitCodePoints(value.trim(), 500);
}

export function sanitizeChatUsername(value) {
  if (typeof value !== 'string') return null;
  const normalized = limitCodePoints(value.trim(), 30);
  return normalized || null;
}

export function normalizeMessageId(value, createId = randomUUID) {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value) ? value : createId();
}

export function createChatMessage(data, sender, now = Date.now, createId = randomUUID) {
  if (!data || typeof data !== 'object' || !sender?.peerId) return null;
  const text = sanitizeChatText(data.text);
  if (!text) return null;
  return {
    id: createId(),
    senderId: sender.peerId,
    username: sanitizeChatUsername(sender.username),
    text,
    timestamp: now()
  };
}

export function appendChatHistory(history, message, limit = 100) {
  history.push(message);
  if (history.length > limit) history.splice(0, history.length - limit);
  return history;
}

export function isPeerInRoom(targetSocketId, roomId, socketToRoom) {
  if (!targetSocketId || !roomId) return false;
  return socketToRoom.get(targetSocketId)?.roomId === roomId;
}

export function canRelayReadReceipt(history, targetPeerId, messageId) {
  if (!Array.isArray(history) || !targetPeerId || !MESSAGE_ID_PATTERN.test(messageId || '')) return false;
  return history.some((message) => message.id === messageId && message.senderId === targetPeerId);
}

export function canKickPeer(room, actorPeerId, targetPeerId) {
  if (!room || !actorPeerId || !targetPeerId || actorPeerId === targetPeerId) return false;
  if (actorPeerId === room.hostPeerId) return true;
  if (!room.controllers?.has(actorPeerId)) return false;
  return targetPeerId !== room.hostPeerId && !room.controllers.has(targetPeerId);
}
