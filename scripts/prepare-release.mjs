import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionFromTag } from './release-artifact-checks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function replaceExactly(text, pattern, replacement, label) {
    const matches = String(text).match(pattern);
    if (!matches || matches.length !== 1) {
        throw new Error(`${label} must contain exactly one release-version marker`);
    }
    return text.replace(pattern, replacement);
}

function writeJson(root, relativePath, update) {
    const absolutePath = path.join(root, relativePath);
    const value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    update(value);
    fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function updateText(root, relativePath, pattern, replacement, label) {
    const absolutePath = path.join(root, relativePath);
    const current = fs.readFileSync(absolutePath, 'utf8');
    fs.writeFileSync(absolutePath, replaceExactly(current, pattern, replacement, label), 'utf8');
}

export function prepareRelease(version, date = new Date(), root = repoRoot) {
    versionFromTag(`v${version}`);
    const timestamp = date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
    writeJson(root, 'package.json', value => { value.version = version; });
    writeJson(root, 'package-lock.json', value => {
        value.version = version;
        value.packages[''].version = version;
    });
    writeJson(root, 'extension/manifest.base.json', value => { value.version = version; });
    writeJson(root, 'website/version.json', value => {
        value.version = version;
        value.date = timestamp;
    });
    updateText(
        root,
        'shared/constants.js',
        /export const APP_VERSION = ["'][^"']+["'];/gu,
        `export const APP_VERSION = "${version}";`,
        'shared/constants.js'
    );
    updateText(
        root,
        'website/template.html',
        /"softwareVersion": "[^"]+"/gu,
        `"softwareVersion": "${version}"`,
        'website/template.html'
    );
    updateText(
        root,
        'website/llms.txt',
        /Current website release: .+/gu,
        `Current website release: ${version}`,
        'website/llms.txt'
    );
    updateText(
        root,
        'README.md',
        /Release-v\d+\.\d+\.\d+-blue/gu,
        `Release-v${version}-blue`,
        'README.md release badge'
    );
    updateText(
        root,
        'README.md',
        /New v\d+\.\d+\.\d+ Release!/gu,
        `New v${version} Release!`,
        'README.md release banner'
    );
    console.log(`Prepared release v${version} at ${timestamp}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    try {
        if (process.argv.length < 3 || process.argv.length > 4) {
            throw new Error('Usage: prepare-release.mjs MAJOR.MINOR.PATCH [ISO_TIMESTAMP]');
        }
        const date = process.argv[3] ? new Date(process.argv[3]) : new Date();
        if (Number.isNaN(date.getTime())) throw new Error(`Invalid release timestamp: ${process.argv[3]}`);
        prepareRelease(process.argv[2], date);
    } catch (error) {
        console.error(`Release preparation failed: ${error.message}`);
        process.exitCode = 1;
    }
}
