import { describe, expect, it } from 'vitest';
import {
    parseCheckRuns,
    validateRepositoryName,
    validateRequiredChecks,
    validateVersionSnapshot
} from './release-preflight.mjs';

describe('release preflight helpers', () => {
    it('parses successful GitHub check runs', () => {
        const checks = parseCheckRuns('verify\tsuccess\thttps://example.test/1\nnode20\tsuccess\thttps://example.test/2\ne2e\tsuccess\thttps://example.test/3');
        expect(checks).toEqual([
            { name: 'verify', conclusion: 'success', url: 'https://example.test/1' },
            { name: 'node20', conclusion: 'success', url: 'https://example.test/2' },
            { name: 'e2e', conclusion: 'success', url: 'https://example.test/3' }
        ]);
        expect(() => validateRequiredChecks(checks)).not.toThrow();
    });

    it('ignores an unrelated in-progress release check while validating required checks', () => {
        const checks = parseCheckRuns([
            'verify\tsuccess\thttps://example.test/verify',
            'node20\tsuccess\thttps://example.test/node20',
            'e2e\tsuccess\thttps://example.test/e2e',
            'preflight\t\thttps://example.test/preflight'
        ].join('\n'));

        expect(checks.at(-1)).toEqual({
            name: 'preflight',
            conclusion: '',
            url: 'https://example.test/preflight'
        });
        expect(() => validateRequiredChecks(checks)).not.toThrow();
    });

    it('rejects missing, pending, and failed release checks', () => {
        expect(() => validateRequiredChecks([{ name: 'verify', conclusion: 'success' }]))
            .toThrow('Required check is missing for the release commit: node20');
        expect(() => validateRequiredChecks([
            { name: 'verify', conclusion: 'success' },
            { name: 'node20', conclusion: 'success' },
            { name: 'e2e', conclusion: '' }
        ])).toThrow('Required check e2e did not succeed: pending');
        expect(() => validateRequiredChecks([
            { name: 'verify', conclusion: 'failure' },
            { name: 'node20', conclusion: 'success' },
            { name: 'e2e', conclusion: 'success' }
        ])).toThrow('Required check verify did not succeed: failure');
        expect(() => validateRequiredChecks([
            { name: 'verify', conclusion: 'success' },
            { name: 'verify', conclusion: 'failure' },
            { name: 'node20', conclusion: 'success' },
            { name: 'e2e', conclusion: 'success' }
        ])).toThrow('Required check verify did not succeed: success, failure');
    });

    it('validates repository names and malformed check output', () => {
        expect(validateRepositoryName('Shik3i/KoalaSync')).toBe('Shik3i/KoalaSync');
        for (const invalid of ['', 'KoalaSync', 'owner/repo/extra', 'owner /repo']) {
            expect(() => validateRepositoryName(invalid)).toThrow('Invalid GitHub repository');
        }
        expect(() => parseCheckRuns('verify')).toThrow('Invalid check-run record');
    });

    it('requires every prepared release source to match the tag version', () => {
        expect(() => validateVersionSnapshot('3.1.5', {
            package: '3.1.5',
            manifest: '3.1.5'
        })).not.toThrow();
        expect(() => validateVersionSnapshot('3.1.5', {
            package: '3.1.5',
            manifest: '3.1.4'
        })).toThrow('manifest version 3.1.4 does not match tag version 3.1.5');
    });
});
