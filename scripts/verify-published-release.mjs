#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    parseChecksumFile,
    RELEASE_ASSET_NAMES,
    sha256File,
    validateArchiveEntries,
    validateArchiveParity,
    validateManifest,
    validateReleaseAssetNames,
    versionFromTag
} from './release-artifact-checks.mjs';

function parseArgs(argv) {
    const options = { tag: '', repo: '', assetDir: '', skipAttestation: false };
    const positional = [];
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--repo' || argument === '--asset-dir') {
            const value = argv[++index];
            if (!value) throw new Error(`${argument} requires a value`);
            if (argument === '--repo') options.repo = value;
            else options.assetDir = path.resolve(value);
        } else if (argument === '--skip-attestation') {
            options.skipAttestation = true;
        } else if (argument.startsWith('-')) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length !== 1) {
        throw new Error('Usage: node scripts/verify-published-release.mjs <tag> [--repo OWNER/REPO] [--asset-dir PATH] [--skip-attestation]');
    }
    options.tag = positional[0];
    return options;
}

function run(command, args, { capture = true } = {}) {
    return execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: capture ? 'utf8' : undefined,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
}

function readArchiveText(archivePath, entry) {
    return run('unzip', ['-p', archivePath, entry]);
}

function listArchiveEntries(archivePath) {
    return run('unzip', ['-Z1', archivePath]).split(/\r?\n/u).filter(Boolean);
}

function assertRuntimeBuild(browserName, archivePath, version) {
    const constants = readArchiveText(archivePath, 'shared/constants.js');
    const background = readArchiveText(archivePath, 'background.js');
    const content = readArchiveText(archivePath, 'content.js');
    const popup = readArchiveText(archivePath, 'popup.html');
    if (!constants.includes(`export const APP_VERSION = "${version}";`)) {
        throw new Error(`${browserName} shared/constants.js does not contain APP_VERSION ${version}`);
    }
    if (!background.includes(`const BROWSER_TYPE = "${browserName}";`)) {
        throw new Error(`${browserName} background.js does not contain the injected browser type`);
    }
    if (!content.includes('const EVENTS = {')) {
        throw new Error(`${browserName} content.js does not contain injected protocol events`);
    }
    if (popup.includes('__BUILD_TIMESTAMP__')) {
        throw new Error(`${browserName} popup.html contains an unresolved build timestamp`);
    }
}

async function verify() {
    const options = parseArgs(process.argv.slice(2));
    const version = versionFromTag(options.tag);
    const repo = options.repo || run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) throw new Error(`Invalid GitHub repository: ${repo}`);

    const tagRef = `refs/tags/${options.tag}`;
    if (run('git', ['cat-file', '-t', tagRef]).trim() !== 'tag') {
        throw new Error(`${options.tag} must be an annotated tag`);
    }
    run('git', ['merge-base', '--is-ancestor', tagRef, 'HEAD']);

    const temporaryDirectory = options.assetDir
        ? null
        : fs.mkdtempSync(path.join(os.tmpdir(), 'koalasync-release-verification-'));
    const assetDirectory = options.assetDir || temporaryDirectory;
    try {
        if (!options.assetDir) {
            const publishedAssets = run('gh', [
                'release', 'view', options.tag, '--repo', repo,
                '--json', 'assets', '--jq', '.assets[].name'
            ]).split(/\r?\n/u).filter(Boolean);
            validateReleaseAssetNames(publishedAssets);
            run('gh', [
                'release', 'download', options.tag, '--repo', repo, '--dir', assetDirectory,
                '--pattern', 'koalasync-*.zip', '--pattern', 'SHA256SUMS'
            ], { capture: false });
        }

        for (const assetName of RELEASE_ASSET_NAMES) {
            const assetPath = path.join(assetDirectory, assetName);
            if (!fs.statSync(assetPath, { throwIfNoEntry: false })?.isFile()) {
                throw new Error(`Missing release asset: ${assetName}`);
            }
        }

        const checksums = parseChecksumFile(fs.readFileSync(path.join(assetDirectory, 'SHA256SUMS'), 'utf8'));
        validateReleaseAssetNames([...checksums.keys(), 'SHA256SUMS']);
        for (const assetName of RELEASE_ASSET_NAMES.filter(name => name.endsWith('.zip'))) {
            const actual = await sha256File(path.join(assetDirectory, assetName));
            const expected = checksums.get(assetName);
            if (actual !== expected) throw new Error(`${assetName} checksum mismatch: expected ${expected}, got ${actual}`);
        }

        const archiveEntries = {};
        for (const browserName of ['chrome', 'firefox']) {
            const archivePath = path.join(assetDirectory, `koalasync-${browserName}.zip`);
            archiveEntries[browserName] = validateArchiveEntries(browserName, listArchiveEntries(archivePath));
            let manifest;
            try {
                manifest = JSON.parse(readArchiveText(archivePath, 'manifest.json'));
            } catch (error) {
                throw new Error(`${browserName} manifest.json is invalid: ${error.message}`);
            }
            validateManifest(browserName, manifest, version);
            assertRuntimeBuild(browserName, archivePath, version);
            if (!options.skipAttestation && !options.assetDir) {
                run('gh', ['attestation', 'verify', archivePath, '--repo', repo], { capture: false });
            }
        }
        validateArchiveParity(archiveEntries.chrome, archiveEntries.firefox);

        console.log(`Published release ${options.tag} verified for ${repo}`);
        console.log(`Assets: ${RELEASE_ASSET_NAMES.join(', ')}`);
        console.log(`Version: ${version}; checksums, manifests, parity${options.skipAttestation || options.assetDir ? '' : ', attestations'} passed`);
    } finally {
        if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

verify().catch(error => {
    console.error(`Published release verification failed: ${error.message}`);
    process.exitCode = 1;
});
