import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    parseChecksumFile,
    sha256File,
    validateArchiveEntries,
    validateArchiveParity,
    validateManifest,
    validateReleaseAssetNames,
    versionFromTag
} from './release-artifact-checks.mjs';

const temporaryDirectories = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('published release artifact checks', () => {
    it('accepts semantic release tags and rejects ambiguous versions', () => {
        expect(versionFromTag('v3.1.4')).toBe('3.1.4');
        for (const invalid of ['3.1.4', 'v3.1', 'v3.1.4-beta', '', null]) {
            expect(() => versionFromTag(invalid)).toThrow('vMAJOR.MINOR.PATCH');
        }
    });

    it('parses strict sha256sum output and rejects duplicate or unsafe names', () => {
        const digest = 'a'.repeat(64);
        expect(parseChecksumFile(`${digest}  koalasync-chrome.zip\n`).get('koalasync-chrome.zip')).toBe(digest);
        expect(() => parseChecksumFile(`${digest} *koalasync-chrome.zip`)).toThrow('Invalid SHA256SUMS line');
        expect(() => parseChecksumFile(`${digest}  ../koalasync-chrome.zip`)).toThrow('Invalid SHA256SUMS line');
        expect(() => parseChecksumFile(`${digest}  chrome.zip\n${digest}  chrome.zip`)).toThrow('Duplicate checksum');
    });

    it('computes file digests without platform-specific checksum commands', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koalasync-checksum-test-'));
        temporaryDirectories.push(directory);
        const filePath = path.join(directory, 'fixture.txt');
        fs.writeFileSync(filePath, 'koalasync\n');
        await expect(sha256File(filePath)).resolves.toBe('2ee7e74af89fb4f42d4fa1bcf93c588bf4460a62c8def5c254bba7b5ae6cd544');
    });

    it('requires the exact public release asset inventory', () => {
        expect(() => validateReleaseAssetNames([
            'koalasync-firefox.zip',
            'SHA256SUMS',
            'koalasync-chrome.zip'
        ])).not.toThrow();
        expect(() => validateReleaseAssetNames(['koalasync-chrome.zip'])).toThrow('Release assets differ');
        expect(() => validateReleaseAssetNames([
            'koalasync-chrome.zip',
            'koalasync-firefox.zip',
            'SHA256SUMS',
            'debug.log'
        ])).toThrow('Release assets differ');
        expect(() => validateReleaseAssetNames([
            'koalasync-chrome.zip',
            'koalasync-firefox.zip',
            'SHA256SUMS',
            'SHA256SUMS'
        ])).toThrow('duplicate asset names');
    });

    it('rejects missing, duplicate, traversal, and development-only archive entries', () => {
        const valid = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'shared/constants.js'];
        expect(validateArchiveEntries('chrome', valid)).toEqual([...valid].sort());
        expect(validateArchiveEntries('chrome', [...valid, 'assets/'])).toEqual([...valid].sort());
        expect(() => validateArchiveEntries('chrome', null)).toThrow('entries must be an array');
        expect(() => validateArchiveEntries('chrome', [...valid, ''])).toThrow('invalid entry');
        expect(() => validateArchiveEntries('chrome', valid.slice(1))).toThrow('missing manifest.json');
        expect(() => validateArchiveEntries('chrome', [...valid, 'content.js'])).toThrow('duplicate entry');
        expect(() => validateArchiveEntries('chrome', [...valid, '../secret'])).toThrow('unsafe path');
        expect(() => validateArchiveEntries('chrome', [...valid, '../'])).toThrow('unsafe path');
        expect(() => validateArchiveEntries('chrome', [...valid, 'C:/secret'])).toThrow('unsafe path');
        expect(() => validateArchiveEntries('chrome', [...valid, '..\\secret'])).toThrow('unsafe path');
        expect(() => validateArchiveEntries('chrome', [...valid, 'content.test.mjs'])).toThrow('development-only');
        expect(() => validateArchiveEntries('chrome', [...valid, 'assets/.DS_Store'])).toThrow('development-only');
    });

    it('validates browser-specific manifests and version alignment', () => {
        expect(() => validateManifest('chrome', {
            version: '3.1.4',
            manifest_version: 3,
            background: { service_worker: 'background.js', type: 'module' }
        }, '3.1.4')).not.toThrow();
        expect(() => validateManifest('firefox', {
            version: '3.1.4',
            manifest_version: 3,
            background: { scripts: ['background.js'], type: 'module' },
            browser_specific_settings: { gecko: { id: 'koalasync@koalastuff.net' } }
        }, '3.1.4')).not.toThrow();
        expect(() => validateManifest('chrome', {
            version: '3.1.3',
            manifest_version: 3,
            background: { service_worker: 'background.js', type: 'module' }
        }, '3.1.4')).toThrow('does not match 3.1.4');

        expect(() => validateManifest('chrome', null, '3.1.4')).toThrow('must be a JSON object');
        expect(() => validateManifest('chrome', {
            version: '3.1.4',
            manifest_version: 2,
            background: { service_worker: 'background.js', type: 'module' }
        }, '3.1.4')).toThrow('Manifest V3');
        expect(() => validateManifest('chrome', {
            version: '3.1.4',
            manifest_version: 3,
            background: { service_worker: 'wrong.js', type: 'module' }
        }, '3.1.4')).toThrow('service worker');
        expect(() => validateManifest('chrome', {
            version: '3.1.4',
            manifest_version: 3,
            background: { service_worker: 'background.js', type: 'classic' }
        }, '3.1.4')).toThrow('ES module');
        expect(() => validateManifest('chrome', {
            version: '3.1.4',
            manifest_version: 3,
            background: { service_worker: 'background.js', type: 'module' },
            browser_specific_settings: { gecko: { id: 'unexpected@example.test' } }
        }, '3.1.4')).toThrow('must not contain Firefox');
        expect(() => validateManifest('firefox', {
            version: '3.1.4',
            manifest_version: 3,
            background: { scripts: ['wrong.js'], type: 'module' },
            browser_specific_settings: { gecko: { id: 'koalasync@koalastuff.net' } }
        }, '3.1.4')).toThrow('background script');
        expect(() => validateManifest('firefox', {
            version: '3.1.4',
            manifest_version: 3,
            background: { scripts: ['background.js'], type: 'classic' },
            browser_specific_settings: { gecko: { id: 'koalasync@koalastuff.net' } }
        }, '3.1.4')).toThrow('ES module');
        expect(() => validateManifest('firefox', {
            version: '3.1.4',
            manifest_version: 3,
            background: { scripts: ['background.js'], type: 'module' }
        }, '3.1.4')).toThrow('expected extension ID');
        expect(() => validateManifest('safari', {
            version: '3.1.4',
            manifest_version: 3
        }, '3.1.4')).toThrow('Unsupported browser');
    });

    it('requires Chrome and Firefox to ship the same file set', () => {
        expect(() => validateArchiveParity(['a', 'b'], ['b', 'a'])).not.toThrow();
        expect(() => validateArchiveParity(['a', 'chrome-only'], ['a', 'firefox-only'])).toThrow(
            'Chrome only: chrome-only; Firefox only: firefox-only'
        );
    });
});
