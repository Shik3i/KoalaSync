import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['**/*.test.js', '**/*.test.mjs'],
        exclude: ['**/scripts/test-*.*(mjs|cjs|js)'],
        coverage: {
            provider: 'c8',
            reporter: ['text', 'lcov'],
            include: ['server/**/*.js', 'shared/**/*.js'],
            exclude: [
                '**/node_modules/**',
                '**/scripts/**',
                '**/extension/**'
            ],
            thresholds: {
                functions: 30,
                lines: 30,
                branches: 25,
                statements: 30
            }
        }
    }
});