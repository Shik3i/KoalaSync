#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  ['vitest unit tests and coverage', 'npm', ['run', 'test:coverage']],
  ['server routes', 'node', ['scripts/test-server-routes.mjs'], {
    env: { ADMIN_METRICS_TOKEN: 'verify-admin-token-with-more-than-32-chars' }
  }],
  ['server WebSocket integration', 'node', ['scripts/test-server-ws.mjs']],
  ['content video finder', 'node', ['scripts/test-content-video-finder.cjs']],
  ['audio settings', 'node', ['scripts/test-audio-settings.mjs']],
  ['popup refresh cooldown', 'node', ['scripts/test-popup-refresh-cooldown.mjs']],
  ['chat settings', 'node', ['scripts/test-chat-settings.mjs']],
  ['server syntax index', 'node', ['-c', 'server/index.js']],
  ['server syntax ops', 'node', ['-c', 'server/ops.js']],
  ['server syntax rate-limiter', 'node', ['-c', 'server/rate-limiter.js']],
  ['content syntax', 'node', ['-c', 'extension/content.js']],
  ['popup syntax', 'node', ['-c', 'extension/popup.js']],
  ['background syntax', 'node', ['-c', 'extension/background.js']],
  ['locale coverage', 'node', ['scripts/test-locales.cjs']],
  ['website locale coverage', 'node', ['scripts/test-website-locales.mjs']],
  ['website theme coverage', 'node', ['scripts/test-website-theme.mjs']],
  ['lint', 'npm', ['run', 'lint']],
  ['root production audit', 'npm', ['audit', '--omit=dev']],
  ['server production audit', 'npm', ['audit', '--omit=dev'], { cwd: path.join(repoRoot, 'server') }],
  ['extension build', 'npm', ['run', 'build:extension']],
  // Must run after the build: validates the exact artifact uploaded to AMO.
  // --warnings-as-errors is required: addons-linter exits 0 on warnings, and AMO
  // rejects on them, so without it this check would pass a rejectable build.
  ['AMO validation (firefox)', 'npx', ['addons-linter', '--warnings-as-errors', 'dist/koalasync-firefox.zip']],
  ['website build', 'node', ['website/build.cjs']]
];

function runCheck([label, command, args, options = {}]) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit code ${code}`));
    });
  });
}

for (const check of checks) {
  await runCheck(check);
}

console.log('\nRelease verification passed');
