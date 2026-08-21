import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: [
            'server/**/*.test.js',
            'server/**/*.test.mjs',
            'shared/**/*.test.js',
            'shared/**/*.test.mjs',
            'extension/**/*.test.js',
            'extension/**/*.test.mjs',
            'scripts/**/*.test.mjs'
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            // Coverage is intentionally scoped to importable modules exercised
            // by Vitest. Browser entry points and subprocess integration tests
            // have separate E2E/integration gates and must not be reported as
            // zero-coverage unit-test targets.
            include: [
                'server/{chat,ops,rate-limiter}.js',
                'shared/{blacklist,invite-links,names}.js',
                'extension/{chat-activity,chat-crypto,chat-format,chat-session,chat-wire,episode-utils,host-access,media-frame-target,title-privacy}.js',
                'scripts/release-artifact-checks.mjs'
            ],
            exclude: [
                '**/node_modules/**'
            ],
            thresholds: {
                statements: 80,
                branches: 68,
                functions: 85,
                lines: 83,
                'extension/media-frame-target.js': {
                    statements: 65,
                    branches: 50,
                    functions: 75,
                    lines: 67
                },
                'extension/host-access.js': {
                    statements: 77,
                    branches: 66,
                    functions: 81,
                    lines: 79
                },
                'server/rate-limiter.js': {
                    statements: 70,
                    branches: 58,
                    functions: 83,
                    lines: 74
                },
                'scripts/release-artifact-checks.mjs': {
                    statements: 100,
                    branches: 95,
                    functions: 100,
                    lines: 100
                }
            }
        }
    }
});
