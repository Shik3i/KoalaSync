import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clearRateLimitMaps, connectionCounts } from '../server/rate-limiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '..', 'server', 'package.json'));
const WebSocket = require('ws');
const clients = [];
let serverModule;
let port;

function url() {
  return `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket&version=2.4.0&token=62170b705234c4f4807a9b22420bb93cf1a2aacfa4c5d3b47804482babb8eb50`;
}

async function connect() {
  const socket = new WebSocket(url());
  clients.push(socket);
  socket.messages = [];
  socket.on('message', (data) => socket.messages.push(data.toString()));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connect timeout')), 3000);
    socket.on('open', () => { clearTimeout(timeout); resolve(); });
  });
  socket.send('40');
  await waitUntil(() => socket.messages.length >= 2, 3000);
  socket.messages.length = 0;
  return socket;
}

function emit(socket, event, data = {}) {
  socket.send(`42${JSON.stringify([event, data])}`);
}

function eventAt(socket, event) {
  for (let index = 0; index < socket.messages.length; index += 1) {
    const raw = socket.messages[index];
    if (!raw.startsWith('42')) continue;
    const parsed = JSON.parse(raw.slice(2));
    if (parsed[0] === event) {
      socket.messages.splice(index, 1);
      return parsed[1];
    }
  }
  return undefined;
}

async function waitUntil(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timeout');
}

async function waitForEvent(socket, event, timeoutMs = 1500) {
  return waitUntil(() => eventAt(socket, event), timeoutMs);
}

async function expectNoEvent(socket, event, timeoutMs = 300) {
  try {
    await waitForEvent(socket, event, timeoutMs);
    assert.fail(`unexpected ${event}`);
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
  }
}

async function join(socket, roomId, peerId, username) {
  emit(socket, 'join_room', { roomId, peerId, username, protocolVersion: '1.0.0' });
  return waitForEvent(socket, 'room_data');
}

function closeClients() {
  for (const client of clients.splice(0)) {
    try { client.close(); } catch { /* already closed */ }
  }
}

try {
  process.env.ADMIN_METRICS_TOKEN = 'chat-integration-test-32chars-minimum';
  serverModule = await import('../server/index.js');
  await serverModule.startServer(0, '127.0.0.1');
  port = serverModule.httpServer.address().port;

  const roomId = `chat-${Date.now()}`;
  const alice = await connect();
  const bob = await connect();
  const aliceRoomData = await join(alice, roomId, 'alice-id', 'Alice');
  assert.ok(aliceRoomData.capabilities.includes('chat'), 'relay advertises explicit chat capability');
  await join(bob, roomId, 'bob-id', 'Bob');
  alice.messages.length = bob.messages.length = 0;

  emit(alice, 'chat_message', {
    id: 'message-1', senderId: 'spoofed', username: 'Mallory',
    text: '<img src=x onerror=alert(1)> **hello**', timestamp: 1
  });
  const message = await waitForEvent(bob, 'chat_message');
  assert.deepEqual(message, {
    id: message.id,
    senderId: 'alice-id',
    username: 'Alice',
    text: '<img src=x onerror=alert(1)> **hello**',
    timestamp: message.timestamp
  });
  assert.match(message.id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(message.id, 'message-1');
  assert.ok(Number.isSafeInteger(message.timestamp) && message.timestamp > 1);
  assert.deepEqual(await waitForEvent(alice, 'chat_message'), message,
    'sender receives the canonical server-confirmed message');

  emit(bob, 'chat_read', { targetId: 'alice-id', messageId: message.id });
  assert.deepEqual(await waitForEvent(alice, 'chat_read'), {
    senderId: 'bob-id', targetId: 'alice-id', messageId: message.id
  });

  emit(bob, 'chat_typing', { username: 'Mallory', isTyping: true });
  assert.deepEqual(await waitForEvent(alice, 'chat_typing'), {
    senderId: 'bob-id', username: 'Bob', isTyping: true
  });
  emit(bob, 'chat_typing', { isTyping: false });
  assert.equal((await waitForEvent(alice, 'chat_typing')).isTyping, false);

  emit(bob, 'chat_system', { text: '<b>forged system message</b>' });
  await expectNoEvent(alice, 'chat_system');

  const outsider = await connect();
  await join(outsider, `other-${Date.now()}`, 'outsider-id', 'Outsider');
  outsider.messages.length = 0;
  emit(bob, 'chat_read', { targetId: 'outsider-id', messageId: 'message-1' });
  await expectNoEvent(outsider, 'chat_read');

  const reconnect = await connect();
  const roomData = await join(reconnect, roomId, 'charlie-id', 'Charlie');
  assert.equal(roomData.chatHistory.length, 1);
  assert.equal(roomData.chatHistory[0].id, message.id);

  alice.messages.length = bob.messages.length = 0;
  emit(bob, 'chat_kick', { targetId: 'alice-id' });
  await expectNoEvent(alice, 'chat_system');
  assert.equal(alice.readyState, WebSocket.OPEN, 'guest kick does not disconnect host');

  emit(alice, 'chat_kick', { targetId: 'bob-id' });
  const system = await waitForEvent(reconnect, 'chat_system');
  assert.equal(system.type, 'kick');
  assert.match(system.text, /Bob.*Alice/);
  await waitUntil(() => bob.readyState === WebSocket.CLOSED, 1500);

  connectionCounts.clear();
  const spammer = await connect();
  const observer = await connect();
  const spamRoom = `spam-${Date.now()}`;
  await join(spammer, spamRoom, 'spammer-id', 'Spammer');
  await join(observer, spamRoom, 'observer-id', 'Observer');
  spammer.messages.length = observer.messages.length = 0;
  for (let index = 0; index < 11; index += 1) {
    emit(spammer, 'chat_message', { id: `spam-${index}`, text: `message ${index}` });
  }
  await waitUntil(() => spammer.readyState === WebSocket.CLOSED, 1500);
  await waitUntil(() => observer.messages.filter((raw) => raw.includes('chat_message')).length === 10, 1500);

  console.log('server chat integration tests passed');
} catch (error) {
  console.error('FAILED:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  closeClients();
  connectionCounts.clear();
  clearRateLimitMaps();
  if (serverModule?.stopServerForTests) await serverModule.stopServerForTests();
}
