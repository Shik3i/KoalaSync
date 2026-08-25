import { describe, expect, it } from 'vitest';
import {
    linuxGateCommand,
    parseGateArgs,
    playwrightImageFromLock
} from './release-local-gate.mjs';

describe('local release gate contract', () => {
    it('requires one exact version and makes candidate mode explicit', () => {
        expect(parseGateArgs(['3.1.5'])).toEqual({ version: '3.1.5', candidate: false });
        expect(parseGateArgs(['3.1.5', '--candidate'])).toEqual({ version: '3.1.5', candidate: true });
        expect(() => parseGateArgs([])).toThrow('Usage: npm run release:gate');
        expect(() => parseGateArgs(['3.1'])).toThrow('Release tag must match vMAJOR.MINOR.PATCH');
    });

    it('derives an exact official Playwright Linux image from the lockfile', () => {
        expect(playwrightImageFromLock({
            packages: { 'node_modules/@playwright/test': { version: '1.62.0' } }
        })).toBe('mcr.microsoft.com/playwright:v1.62.0-noble');
        expect(() => playwrightImageFromLock({ packages: {} })).toThrow('must pin');
    });

    it('runs the complete CI-equivalent dependency, verify, and browser sequence', () => {
        expect(linuxGateCommand()).toBe([
            'git clone --no-local /src /work',
            'cd /work',
            'npm ci',
            'npm ci --prefix server',
            'npm run verify',
            'npm run test:e2e'
        ].join(' && '));
    });
});
