import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.KOALA_E2E_PORT || 4173);

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.mjs',
    // Extension tests drive a persistent context and a service worker; running
    // them in parallel makes the profile directories fight each other.
    workers: 1,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: process.env.CI ? 'list' : [['list']],
    timeout: 30_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
        launchOptions: {
            // Several fixtures hinge on a video actually playing. Without this
            // the browser's autoplay heuristics decide whether the fixture is
            // valid, which shows up later as an unexplained flake.
            args: ['--autoplay-policy=no-user-gesture-required']
        }
    },
    projects: [
        {
            name: 'detection-chromium',
            testMatch: 'detection.spec.mjs',
            use: { browserName: 'chromium' }
        },
        {
            name: 'detection-firefox',
            testMatch: 'detection.spec.mjs',
            use: { browserName: 'firefox' }
        },
        {
            name: 'detection-webkit',
            testMatch: 'detection.spec.mjs',
            use: { browserName: 'webkit' }
        },
        {
            name: 'extension-chromium',
            testIgnore: 'detection.spec.mjs'
        }
    ],
    webServer: {
        command: `node "${fileURLToPath(new URL('./fixture-server.mjs', import.meta.url))}" ${PORT}`,
        url: `http://localhost:${PORT}/pages/simple-player.html`,
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe'
    }
});
