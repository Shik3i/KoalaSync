import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = fs.readFileSync(path.join(repoRoot, 'extension', 'popup.html'), 'utf8');
const styleMatch = popupHtml.match(/<style>([\s\S]*?)<\/style>/);

assert.ok(styleMatch, 'popup.html should contain an inline style block');

const parseErrors = [];
const popupCss = styleMatch[1];
csstree.parse(popupCss, {
  positions: true,
  onParseError(error) {
    parseErrors.push(`${error.message} at ${error.line}:${error.column}`);
  }
});

assert.deepEqual(parseErrors, [], `popup inline CSS should parse without errors:\n${parseErrors.join('\n')}`);
assert.equal(
  /\.chat-container\s*\{[^}]*\bheight:\s*(?:390|400)px/s.test(popupCss),
  false,
  'chat container must not use the popup-filling 390/400px fixed height'
);
assert.match(
  popupCss,
  /\.chat-container\s*\{[^}]*height:\s*340px[^}]*max-height:\s*calc\(100vh\s*-\s*140px\)[^}]*min-height:\s*280px/s,
  'chat container should target 340px while remaining bounded by the popup viewport'
);
assert.match(
  popupCss,
  /\.chat-messages\s*\{[^}]*min-height:\s*120px[^}]*overflow-y:\s*auto/s,
  'chat history should scroll inside the bounded container'
);

console.log('popup css parse test passed');
