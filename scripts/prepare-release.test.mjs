import { describe, expect, it } from 'vitest';
import { replaceExactly } from './prepare-release.mjs';

describe('release preparation helpers', () => {
    it('replaces one and only one version marker', () => {
        expect(replaceExactly('version=3.1.4', /version=\d+\.\d+\.\d+/gu, 'version=3.1.5', 'fixture'))
            .toBe('version=3.1.5');
        expect(replaceExactly('New v3.1.4 Release!', /New v\d+\.\d+\.\d+ Release!/gu, 'New v3.1.5 Release!', 'README.md release banner'))
            .toBe('New v3.1.5 Release!');
        expect(() => replaceExactly('none', /version=\d+/gu, 'version=4', 'fixture'))
            .toThrow('fixture must contain exactly one release-version marker');
        expect(() => replaceExactly('version=1 version=2', /version=\d+/gu, 'version=3', 'fixture'))
            .toThrow('fixture must contain exactly one release-version marker');
    });
});
