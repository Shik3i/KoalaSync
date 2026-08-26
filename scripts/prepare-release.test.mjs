import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateReleaseSourceVersion } from './release-preflight.mjs';
import { prepareRelease, replaceExactly } from './prepare-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories = [];
const releaseSourcePaths = [
    'README.md',
    'extension/manifest.base.json',
    'package.json',
    'package-lock.json',
    'shared/constants.js',
    'website/llms.txt',
    'website/template.html',
    'website/version.json'
];

function createReleaseFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koalasync-prepare-release-'));
    temporaryDirectories.push(root);
    for (const relativePath of releaseSourcePaths) {
        const target = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, relativePath), target);
    }
    return root;
}

function readFixture(root) {
    return Object.fromEntries(releaseSourcePaths.map(relativePath => [
        relativePath,
        fs.readFileSync(path.join(root, relativePath), 'utf8')
    ]));
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

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

    it('updates and validates every release-version source, including both README markers', () => {
        const root = createReleaseFixture();
        prepareRelease('9.8.7', new Date('2030-04-05T06:07:08Z'), root);

        expect(() => validateReleaseSourceVersion('9.8.7', root)).not.toThrow();
        expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('Release-v9.8.7-blue');
        expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toContain('New v9.8.7 Release!');
        expect(JSON.parse(fs.readFileSync(path.join(root, 'website/version.json'), 'utf8')).date)
            .toBe('2030-04-05T06:07:08Z');
    });

    it('is deterministic when repeated with the tag timestamp and does not duplicate markers', () => {
        const root = createReleaseFixture();
        const timestamp = new Date('2031-02-03T04:05:06Z');

        prepareRelease('9.8.7', timestamp, root);
        const once = readFixture(root);
        prepareRelease('9.8.7', timestamp, root);

        expect(readFixture(root)).toEqual(once);
        expect(once['README.md'].match(/Release-v9\.8\.7-blue/gu)).toHaveLength(1);
        expect(once['README.md'].match(/New v9\.8\.7 Release!/gu)).toHaveLength(1);
    });

    it('rejects invalid versions before changing release sources', () => {
        const root = createReleaseFixture();
        const before = readFixture(root);

        expect(() => prepareRelease('9.8.7;echo-unsafe', new Date('2030-01-01T00:00:00Z'), root))
            .toThrow('vMAJOR.MINOR.PATCH');
        expect(readFixture(root)).toEqual(before);
    });

    it('does not partially update release sources when a later marker is invalid', () => {
        const root = createReleaseFixture();
        const llmsPath = path.join(root, 'website/llms.txt');
        fs.writeFileSync(llmsPath, fs.readFileSync(llmsPath, 'utf8')
            .replace(/Current website release: .+/u, 'Release marker intentionally missing'), 'utf8');
        const before = readFixture(root);

        expect(() => prepareRelease('9.8.7', new Date('2030-01-01T00:00:00Z'), root))
            .toThrow('website/llms.txt must contain exactly one release-version marker');
        expect(readFixture(root)).toEqual(before);
    });
});
