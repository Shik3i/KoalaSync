import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as csstree from 'css-tree';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const popupPath = path.join(repoRoot, 'extension', 'popup.html');
const popupScriptPath = path.join(repoRoot, 'extension', 'popup.js');
const popupHtml = fs.readFileSync(popupPath, 'utf8');
const popupScript = fs.readFileSync(popupScriptPath, 'utf8');
const styleMatch = popupHtml.match(/<style>([\s\S]*?)<\/style>/);

assert.ok(styleMatch, 'popup.html should contain an inline <style> block');

const parseErrors = [];
const popupCss = styleMatch[1];
csstree.parse(popupCss, {
  positions: true,
  onParseError(error) {
    parseErrors.push(`${error.message} at ${error.line}:${error.column}`);
  }
});

assert.deepEqual(parseErrors, [], `popup inline CSS should parse without errors:\n${parseErrors.join('\n')}`);
assert.equal(popupCss.includes('base-select'), false, 'popup CSS should not use experimental base-select appearance');
assert.equal(popupCss.includes('::picker(select)'), false, 'popup CSS should not customize native select picker overlays');
assert.equal(
  /input\s*,\s*select\s*,\s*option/.test(popupCss),
  false,
  'popup CSS should not globally style native option elements'
);
assert.equal(
  /option\s*\{[^}]*width\s*:/s.test(popupCss),
  false,
  'popup CSS should not give native options layout width'
);
assert.match(
  popupCss,
  /#peerList\s*,\s*#peerListSync\s*\{[^}]*max-height:\s*180px[^}]*overflow-y:\s*auto/s,
  'peer lists should have a bounded height inside the extension popup'
);
assert.equal(
  /\.chat-container\s*\{[^}]*\bheight:\s*(?:390|400)px/s.test(popupCss),
  false,
  'chat container should not use the original fixed 390/400px popup-filling height'
);
assert.match(
  popupCss,
  /\.chat-container\s*\{[^}]*max-height:\s*240px/s,
  'chat container should be bounded inside the extension popup'
);
assert.equal(
  /if\s*\([^)]*![^)]*onboardingComplete[^)]*\)\s*showOnboarding\(\)/.test(popupScript),
  false,
  'popup should not auto-open onboarding over the active room UI'
);
assert.equal(
  /chrome\.storage\.sync\.set\(\{\s*onboardingComplete:\s*true\s*\}\)/.test(popupScript),
  true,
  'popup should mark legacy auto-onboarding as completed'
);
assert.match(
  popupScript,
  /function\s+resetOnboardingOverlay\(\)[\s\S]*document\.body\.style\.minHeight\s*=\s*''/,
  'popup should clear any leftover onboarding overlay layout state'
);
console.log('popup css parse test passed');
