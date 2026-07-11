import { describe, expect, it, vi } from 'vitest';
import {
  createReceiptTracker,
  createRemoteTypingTracker,
  createTypingTracker,
  formatChatText,
  insertEmoji
} from './chat.js';

describe('extension chat helpers', () => {
  it('escapes executable HTML before applying limited Markdown', () => {
    const result = formatChatText('<img src=x onerror=alert(1)> **bold** *italic*');
    expect(result).toBe('&lt;img src=x onerror=alert(1)&gt; <strong>bold</strong> <em>italic</em>');
    expect(result).not.toContain('<img');
  });

  it('inserts an emoji at the current selection', () => {
    expect(insertEmoji('hello world', '😀', 6, 11)).toEqual({ value: 'hello 😀', caret: 8 });
    expect(insertEmoji('hello', '🎉', 99, 99)).toEqual({ value: 'hello🎉', caret: 7 });
  });

  it('emits typing start once and stop after inactivity', () => {
    vi.useFakeTimers();
    const states = [];
    const tracker = createTypingTracker({ emit: (state) => states.push(state), timeoutMs: 1000 });
    tracker.activity();
    tracker.activity();
    expect(states).toEqual([true]);
    vi.advanceTimersByTime(1000);
    expect(states).toEqual([true, false]);
    tracker.stop();
    expect(states).toEqual([true, false]);
    vi.useRealTimers();
  });

  it('tracks each reader once per message', () => {
    const receipts = createReceiptTracker();
    expect(receipts.markRead('message-1', 'peer-a')).toBe(1);
    expect(receipts.markRead('message-1', 'peer-a')).toBe(1);
    expect(receipts.markRead('message-1', 'peer-b')).toBe(2);
    receipts.clear();
    expect(receipts.count('message-1')).toBe(0);
  });

  it('tracks canonical typing usernames and expires stale peers', () => {
    vi.useFakeTimers();
    const snapshots = [];
    const typing = createRemoteTypingTracker({ onChange: (names) => snapshots.push(names), timeoutMs: 1000 });
    typing.update({ senderId: 'peer-a', username: 'Alice', isTyping: true });
    expect(snapshots.at(-1)).toEqual(['Alice']);
    typing.update({ senderId: 'peer-b', username: 'Bob', isTyping: true });
    expect(snapshots.at(-1)).toEqual(['Alice', 'Bob']);
    typing.update({ senderId: 'peer-a', username: 'Alice', isTyping: false });
    expect(snapshots.at(-1)).toEqual(['Bob']);
    vi.advanceTimersByTime(1000);
    expect(snapshots.at(-1)).toEqual([]);
    typing.clear();
    vi.useRealTimers();
  });
});
