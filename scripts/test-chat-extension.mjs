import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popup = fs.readFileSync(path.join(root, 'extension/popup.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'extension/popup.html'), 'utf8');

assert.match(popup, /from '\.\/chat\.js'/, 'popup imports the safe chat module');
assert.match(popup, /msg\.type === 'ROOM_DATA'[\s\S]*chatHistory/, 'popup renders room chat history');
assert.match(popup, /function renderChatHistory[\s\S]*sendReadReceipt/, 'visible remote history sends receipts');
assert.match(popup, /res\.chatHistory/, 'popup restores history when opened after joining');
assert.match(popup, /CHAT_TYPING_RECEIVED/, 'popup handles remote typing');
assert.match(popup, /CHAT_SYSTEM_RECEIVED/, 'popup handles system messages');
assert.match(popup, /chatInput\?\.addEventListener\('input'/, 'popup emits typing activity');
assert.match(popup, /typingTracker\.stop\(\)/, 'popup sends typing stop');
assert.match(popup, /formatChatText\(message\.text\)/, 'popup uses the safe formatter');
assert.doesNotMatch(popup, /function formatMessageText\(/, 'unsafe inline formatter is removed');

assert.equal((background.match(/message\.type === 'CHAT_MESSAGE'/g) || []).length, 1,
  'background has exactly one outbound chat-message branch');
assert.match(background, /payload:\s*\{[\s\S]*?id:\s*data\.id,[\s\S]*?senderId:/,
  'background preserves inbound message IDs');
assert.match(background, /case EVENTS\.CHAT_SYSTEM:[\s\S]*data\.text/, 'background uses canonical system text');
assert.match(background, /GET_STATUS'[\s\S]*chatHistory:\s*currentRoom/, 'status exposes in-memory chat history');
assert.match(background, /case EVENTS\.CHAT_MESSAGE:[\s\S]*currentRoom\.chatHistory/, 'background keeps status history current');

assert.match(html, /id="emoji-palette"/, 'popup contains a real emoji palette');
assert.match(html, /aria-expanded="false"/, 'emoji picker exposes accessible state');
assert.match(html, /data-i18n-placeholder="CHAT_INPUT_PLACEHOLDER"/, 'chat input is localized');

console.log('chat extension integration checks passed');
