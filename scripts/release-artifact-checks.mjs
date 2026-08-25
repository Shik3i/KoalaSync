import crypto from 'node:crypto';
import fs from 'node:fs';

export const RELEASE_ASSET_NAMES = Object.freeze([
    'koalasync-chrome.zip',
    'koalasync-firefox.zip',
    'SHA256SUMS'
]);

const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
    'manifest.json',
    'background.js',
    'content.js',
    'popup.html',
    'shared/constants.js'
]);

export function versionFromTag(tag) {
    const match = /^v(\d+\.\d+\.\d+)$/u.exec(tag || '');
    if (!match) throw new Error(`Release tag must match vMAJOR.MINOR.PATCH: ${tag || '<empty>'}`);
    return match[1];
}

export function parseChecksumFile(text) {
    const checksums = new Map();
    for (const [index, rawLine] of String(text).split(/\r?\n/u).entries()) {
        if (!rawLine.trim()) continue;
        const match = /^([a-fA-F0-9]{64})  ([^/\\]+)$/u.exec(rawLine);
        if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}: ${rawLine}`);
        const [, digest, filename] = match;
        if (checksums.has(filename)) throw new Error(`Duplicate checksum entry: ${filename}`);
        checksums.set(filename, digest.toLowerCase());
    }
    return checksums;
}

export async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
}

export function validateReleaseAssetNames(assetNames) {
    const actual = [...new Set(assetNames)].sort();
    const expected = [...RELEASE_ASSET_NAMES].sort();
    if (actual.length !== assetNames.length) throw new Error('Release contains duplicate asset names');
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Release assets differ: expected ${expected.join(', ')}, got ${actual.join(', ')}`);
    }
}

export function validateArchiveEntries(browserName, archiveEntries) {
    if (!Array.isArray(archiveEntries)) throw new Error(`${browserName} archive entries must be an array`);
    const seen = new Set();
    const files = new Set();
    for (const entry of archiveEntries) {
        if (typeof entry !== 'string' || !entry) throw new Error(`${browserName} archive contains an invalid entry`);
        if (seen.has(entry)) throw new Error(`${browserName} archive contains duplicate entry: ${entry}`);
        seen.add(entry);
        if (entry.startsWith('/')
            || /^[A-Za-z]:[\\/]/u.test(entry)
            || entry.includes('\\')
            || entry.includes('\0')
            || entry.split('/').includes('..')) {
            throw new Error(`${browserName} archive contains unsafe path: ${entry}`);
        }
        if (entry.endsWith('/')) continue;
        files.add(entry);
        if (/\.test\.[cm]?js$/u.test(entry)
            || entry === 'manifest.base.json'
            || entry === '.DS_Store'
            || entry.endsWith('/.DS_Store')) {
            throw new Error(`${browserName} archive contains development-only file: ${entry}`);
        }
    }
    for (const required of REQUIRED_ARCHIVE_ENTRIES) {
        if (!seen.has(required)) throw new Error(`${browserName} archive is missing ${required}`);
    }
    return [...files].sort();
}

export function validateManifest(browserName, manifest, expectedVersion) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`${browserName} manifest must be a JSON object`);
    }
    if (manifest.version !== expectedVersion) {
        throw new Error(`${browserName} manifest version ${manifest.version || '<missing>'} does not match ${expectedVersion}`);
    }
    if (manifest.manifest_version !== 3) {
        throw new Error(`${browserName} manifest must use Manifest V3`);
    }
    if (browserName === 'chrome') {
        if (manifest.background?.service_worker !== 'background.js') {
            throw new Error('Chrome manifest must use background.js as its service worker');
        }
        if (manifest.background?.type !== 'module') throw new Error('Chrome background must be an ES module');
        if (manifest.browser_specific_settings?.gecko) {
            throw new Error('Chrome manifest must not contain Firefox gecko settings');
        }
    } else if (browserName === 'firefox') {
        if (!Array.isArray(manifest.background?.scripts)
            || manifest.background.scripts.length !== 1
            || manifest.background.scripts[0] !== 'background.js') {
            throw new Error('Firefox manifest must use background.js as its background script');
        }
        if (manifest.background?.type !== 'module') throw new Error('Firefox background must be an ES module');
        if (manifest.browser_specific_settings?.gecko?.id !== 'koalasync@koalastuff.net') {
            throw new Error('Firefox manifest is missing the expected extension ID');
        }
    } else {
        throw new Error(`Unsupported browser archive: ${browserName}`);
    }
}

export function validateArchiveParity(chromeEntries, firefoxEntries) {
    const chrome = [...chromeEntries].sort();
    const firefox = [...firefoxEntries].sort();
    if (JSON.stringify(chrome) !== JSON.stringify(firefox)) {
        const chromeOnly = chrome.filter(entry => !firefox.includes(entry));
        const firefoxOnly = firefox.filter(entry => !chrome.includes(entry));
        throw new Error(`Archive contents differ; Chrome only: ${chromeOnly.join(', ') || '<none>'}; Firefox only: ${firefoxOnly.join(', ') || '<none>'}`);
    }
}
