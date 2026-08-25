import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    linuxGateCommand,
    parseGateArgs,
    parseRemoteMain,
    playwrightImageFromLock,
    validateReleaseWorkflowContract
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

    it('extracts main only from the exact remote branch record', () => {
        const sha = '0123456789abcdef0123456789abcdef01234567';
        expect(parseRemoteMain(`${sha}\trefs/heads/main\n`)).toBe(sha);
        expect(() => parseRemoteMain('')).toThrow('could not resolve origin main');
        expect(() => parseRemoteMain(`${sha}\trefs/heads/not-main`)).toThrow('could not resolve origin main');
    });

    it('requires one lowercase registry image throughout the release workflow', () => {
        const valid = [
            'IMAGE: ghcr.io/shik3i/koalasync',
            'images: ${{ env.IMAGE }}',
            'subject-name: ${{ env.IMAGE }}',
            'prepare-release:',
            'node scripts/prepare-release.mjs "$VERSION" "$RELEASE_TIMESTAMP"',
            'node scripts/release-preflight.mjs --sources "$VERSION"',
            'git commit -m "chore(release): update versions to v$VERSION [skip ci]"',
            'git push origin HEAD:main',
            'ref: ${{ needs.prepare-release.outputs.prepared-commit }}',
            'ref: ${{ needs.prepare-release.outputs.prepared-commit }}',
            'ref: ${{ needs.prepare-release.outputs.prepared-commit }}',
            'needs: [prepare-release, verify-prepared-release, release-extension-draft, release-server]',
            'gh release edit "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft=false --verify-tag'
        ].join('\n');
        expect(validateReleaseWorkflowContract(valid)).toBe('ghcr.io/shik3i/koalasync');
        expect(() => validateReleaseWorkflowContract(valid.replace(
            'IMAGE: ghcr.io/shik3i/koalasync',
            'IMAGE: ghcr.io/${{ github.repository }}'
        ))).toThrow('lowercase canonical image');
        expect(() => validateReleaseWorkflowContract(`${valid}\n${'ghcr.io/${{ github.repository }}'}`))
            .toThrow('case-preserving github.repository');
    });

    it('enforces the automatic version commit, direct push, prepared source, and final publication contract', () => {
        const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
        expect(validateReleaseWorkflowContract(workflow)).toBe('ghcr.io/shik3i/koalasync');
        expect(() => validateReleaseWorkflowContract(workflow.replace(
            'git push origin HEAD:main',
            'git push origin HEAD:release'
        ))).toThrow('automatic tag versioning');
        expect(() => validateReleaseWorkflowContract(workflow.replace(
            'git push origin HEAD:main',
            'git push origin HEAD:main || true'
        ))).toThrow('stop when the automatic main push fails');
    });

    it('runs the complete CI-equivalent dependency, verify, and browser sequence', () => {
        expect(linuxGateCommand()).toBe([
            'git clone --no-local /src /work',
            'cd /work',
            'node scripts/prepare-release.mjs "$RELEASE_VERSION" "2030-01-01T00:00:00Z"',
            'node scripts/release-preflight.mjs --sources "$RELEASE_VERSION"',
            'npm ci',
            'npm ci --prefix server',
            'npm run verify',
            'npm run test:e2e'
        ].join(' && '));
    });
});
