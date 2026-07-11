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
            'extension/**/*.test.mjs'
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            include: ['server/**/*.js', 'shared/**/*.js', 'extension/chat.js'],
            exclude: [
                '**/node_modules/**',
                '**/scripts/**',
                '**/extension/**'
            ]
        }
    }
});
