#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  ['vitest unit tests', 'npm', ['run', 'test:unit']],
  ['server ops', 'node', ['scripts/test-server-ops.mjs']],
  ['server routes', 'node', ['scripts/test-server-routes.mjs'], {
    env: { ADMIN_METRICS_TOKEN: 'verify-admin-token-with-more-than-32-chars' }
  }],
  ['rate-limiter unit tests', 'node', ['scripts/test-rate-limiter.mjs']],
  ['episode-utils unit tests', 'node', ['scripts/test-episode-utils.mjs']],
  ['title privacy unit tests', 'node', ['scripts/test-title-privacy.mjs']],
  ['server WebSocket integration', 'node', ['scripts/test-server-ws.mjs']],
  ['server chat integration', 'node', ['scripts/test-server-chat.mjs']],
  ['extension chat integration', 'node', ['scripts/test-chat-extension.mjs']],
  ['names generator', 'node', ['scripts/test-names.mjs']],
  ['content video finder', 'node', ['scripts/test-content-video-finder.cjs']],
  ['audio settings', 'node', ['scripts/test-audio-settings.mjs']],
  ['popup refresh cooldown', 'node', ['scripts/test-popup-refresh-cooldown.mjs']],
  ['server syntax index', 'node', ['-c', 'server/index.js']],
  ['server syntax ops', 'node', ['-c', 'server/ops.js']],
  ['server syntax rate-limiter', 'node', ['-c', 'server/rate-limiter.js']],
  ['content syntax', 'node', ['-c', 'extension/content.js']],
  ['popup syntax', 'node', ['-c', 'extension/popup.js']],
  ['background syntax', 'node', ['-c', 'extension/background.js']],
  ['locale coverage', 'node', ['scripts/test-locales.cjs']],
  ['website locale coverage', 'node', ['scripts/test-website-locales.mjs']],
  ['lint', 'npm', ['run', 'lint']],
  ['root production audit', 'npm', ['audit', '--omit=dev']],
  ['server production audit', 'npm', ['audit', '--omit=dev'], { cwd: path.join(repoRoot, 'server') }],
  ['extension build', 'npm', ['run', 'build:extension']],
  ['website build', 'node', ['website/build.cjs']]
];

function runCheck([label, command, args, options = {}]) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const childEnv = { ...process.env, ...(options.env || {}) };
    // npm promotes the global allow-scripts config into npm_config_allow_scripts
    // while running package scripts. npm audit rejects that project-scoped value,
    // even though it does not execute install scripts, so do not inherit it.
    delete childEnv.npm_config_allow_scripts;
    delete childEnv.NPM_CONFIG_ALLOW_SCRIPTS;
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: childEnv,
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
