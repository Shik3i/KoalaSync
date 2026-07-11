import { describe, expect, it } from 'vitest';
import {
  appendChatHistory,
  canKickPeer,
  canRelayReadReceipt,
  createChatMessage,
  isPeerInRoom,
  normalizeMessageId,
  sanitizeChatText,
  sanitizeChatUsername
} from './chat.js';

describe('server chat policy', () => {
  it('normalizes and limits text by Unicode code points without output encoding', () => {
    expect(sanitizeChatText('<img onerror="x"> & hi')).toBe('<img onerror="x"> & hi');
    expect([...sanitizeChatText('😀'.repeat(501))]).toHaveLength(500);
    expect(sanitizeChatText('   ')).toBe('');
  });

  it('normalizes usernames and message identifiers', () => {
    expect(sanitizeChatUsername(`  ${'😀'.repeat(31)}  `)).toBe('😀'.repeat(30));
    expect(normalizeMessageId('msg-safe_123', () => 'generated')).toBe('msg-safe_123');
    expect(normalizeMessageId('bad id"><', () => 'generated')).toBe('generated');
  });

  it('creates a canonical server-authoritative message', () => {
    const message = createChatMessage(
      { id: 'client-1', senderId: 'spoofed', username: 'spoofed', text: '<b>hello</b>', timestamp: 1 },
      { peerId: 'peer-1', username: 'Alice' },
      () => 1234,
      () => 'generated'
    );

    expect(message).toEqual({
      id: 'generated',
      senderId: 'peer-1',
      username: 'Alice',
      text: '<b>hello</b>',
      timestamp: 1234
    });
    expect(createChatMessage({ text: '   ' }, { peerId: 'peer-1' })).toBeNull();
  });

  it('always replaces client-controlled IDs with a server-generated ID', () => {
    expect(createChatMessage({ id: 'reused', text: 'one' }, { peerId: 'peer' }, () => 1, () => 'server-1').id).toBe('server-1');
    expect(createChatMessage({ id: 'reused', text: 'two' }, { peerId: 'peer' }, () => 2, () => 'server-2').id).toBe('server-2');
  });

  it('keeps only the newest messages in RAM history', () => {
    const history = [];
    for (let id = 1; id <= 102; id += 1) appendChatHistory(history, { id }, 100);
    expect(history).toHaveLength(100);
    expect(history[0].id).toBe(3);
    expect(history[99].id).toBe(102);
  });

  it('accepts a target only when its socket belongs to the same room', () => {
    const mappings = new Map([
      ['socket-a', { roomId: 'room-a' }],
      ['socket-b', { roomId: 'room-b' }]
    ]);
    expect(isPeerInRoom('socket-a', 'room-a', mappings)).toBe(true);
    expect(isPeerInRoom('socket-b', 'room-a', mappings)).toBe(false);
    expect(isPeerInRoom(undefined, 'room-a', mappings)).toBe(false);
  });

  it('relays receipts only for a real message authored by the target', () => {
    const history = [{ id: 'message-1', senderId: 'alice' }];
    expect(canRelayReadReceipt(history, 'alice', 'message-1')).toBe(true);
    expect(canRelayReadReceipt(history, 'bob', 'message-1')).toBe(false);
    expect(canRelayReadReceipt(history, 'alice', 'forged')).toBe(false);
  });

  it('prevents self-kicks and controllers kicking owners or other controllers', () => {
    const room = { hostPeerId: 'host', controllers: new Set(['host', 'controller']) };
    expect(canKickPeer(room, 'host', 'guest')).toBe(true);
    expect(canKickPeer(room, 'host', 'controller')).toBe(true);
    expect(canKickPeer(room, 'host', 'host')).toBe(false);
    expect(canKickPeer(room, 'controller', 'guest')).toBe(true);
    expect(canKickPeer(room, 'controller', 'host')).toBe(false);
    room.controllers.add('controller-2');
    expect(canKickPeer(room, 'controller', 'controller-2')).toBe(false);
  });
});
