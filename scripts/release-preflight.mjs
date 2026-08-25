import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { versionFromTag } from './release-artifact-checks.mjs';

export const REQUIRED_RELEASE_CHECKS = Object.freeze(['verify', 'node20', 'e2e']);

export function parseCheckRuns(text) {
    return String(text).split(/\r?\n/u).filter(Boolean).map(line => {
        const fields = line.split('\t');
        if (fields.length < 2 || !fields[0]) throw new Error(`Invalid check-run record: ${line}`);
        const [name, conclusion = '', url = ''] = fields;
        return { name, conclusion, url };
    });
}

export function validateRequiredChecks(checkRuns, required = REQUIRED_RELEASE_CHECKS) {
    for (const name of required) {
        const matches = checkRuns.filter(check => check.name === name);
        if (matches.length === 0) throw new Error(`Required check is missing for the release commit: ${name}`);
        if (matches.some(check => check.conclusion !== 'success')) {
            const conclusions = matches.map(check => check.conclusion || 'pending').join(', ');
            throw new Error(`Required check ${name} did not succeed: ${conclusions}`);
        }
    }
}

function run(command, args) {
    return execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

export function validateRepositoryName(repo) {
    if (!/^[^/\s]+\/[^/\s]+$/u.test(repo || '')) {
        throw new Error(`Invalid GitHub repository: ${repo || '<empty>'}`);
    }
    return repo;
}

export function validateVersionSnapshot(expectedVersion, snapshot) {
    for (const [label, actualVersion] of Object.entries(snapshot)) {
        if (actualVersion !== expectedVersion) {
            throw new Error(`${label} version ${actualVersion || '<missing>'} does not match tag version ${expectedVersion}`);
        }
    }
}

function versionFromMarker(text, pattern, label) {
    const matches = [...String(text).matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(`${label} must contain exactly one release-version marker`);
    }
    return matches[0][1];
}

export function validateReleaseSourceVersion(expectedVersion, repoRoot = process.cwd()) {
    const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const manifest = readJson('extension/manifest.base.json');
    const websiteVersion = readJson('website/version.json');
    const constants = fs.readFileSync(path.join(repoRoot, 'shared/constants.js'), 'utf8');
    const websiteTemplate = fs.readFileSync(path.join(repoRoot, 'website/template.html'), 'utf8');
    const websiteLlms = fs.readFileSync(path.join(repoRoot, 'website/llms.txt'), 'utf8');
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    validateVersionSnapshot(expectedVersion, {
        'package.json': packageJson.version,
        'package-lock.json': packageLock.version,
        'package-lock root package': packageLock.packages?.['']?.version,
        'extension manifest': manifest.version,
        'shared constants': versionFromMarker(
            constants,
            /export const APP_VERSION = ["']([^"']+)["'];/gu,
            'shared/constants.js'
        ),
        'website/version.json': websiteVersion.version,
        'website template': versionFromMarker(
            websiteTemplate,
            /"softwareVersion": "([^"]+)"/gu,
            'website/template.html'
        ),
        'website llms': versionFromMarker(
            websiteLlms,
            /Current website release: (\d+\.\d+\.\d+)/gu,
            'website/llms.txt'
        ),
        'README release badge': versionFromMarker(
            readme,
            /Release-v(\d+\.\d+\.\d+)-blue/gu,
            'README.md release badge'
        ),
        'README release banner': versionFromMarker(
            readme,
            /New v(\d+\.\d+\.\d+) Release!/gu,
            'README.md release banner'
        )
    });
}

export function verifyReleaseRef({ tag, repo }) {
    const version = versionFromTag(tag);
    validateRepositoryName(repo);
    const tagRef = `refs/tags/${tag}`;
    if (run('git', ['cat-file', '-t', tagRef]) !== 'tag') {
        throw new Error(`${tag} must be an annotated tag`);
    }
    const tagCommit = run('git', ['rev-list', '-n', '1', tagRef]);
    const mainCommit = run('git', ['rev-parse', 'origin/main']);
    if (tagCommit !== mainCommit) {
        throw new Error(`Release tag ${tag} points to ${tagCommit}, but origin/main is ${mainCommit}`);
    }

    const checks = parseCheckRuns(run('gh', [
        'api', `repos/${repo}/commits/${tagCommit}/check-runs`,
        '--jq', '.check_runs[] | [.name, .conclusion, .html_url] | @tsv'
    ]));
    validateRequiredChecks(checks);
    const releaseTimestamp = run('git', ['show', '-s', '--format=%cI', tagCommit]);
    return { version, tagCommit, releaseTimestamp };
}

function main() {
    if (process.argv[2] === '--sources') {
        if (process.argv.length !== 4) {
            throw new Error('Usage: release-preflight.mjs --sources MAJOR.MINOR.PATCH');
        }
        const version = versionFromTag(`v${process.argv[3]}`);
        validateReleaseSourceVersion(version);
        console.log(`Release sources match v${version}`);
        return;
    }
    const tag = process.env.GITHUB_REF_NAME || '';
    const repo = process.env.GITHUB_REPOSITORY || '';
    const outputPath = process.env.GITHUB_OUTPUT || '';
    const result = verifyReleaseRef({ tag, repo });
    if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
    fs.appendFileSync(
        outputPath,
        `version=${result.version}\ntag_commit=${result.tagCommit}\nrelease_timestamp=${result.releaseTimestamp}\n`,
        'utf8'
    );
    console.log(`Release preflight accepted ${tag} at ${result.tagCommit}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    try {
        main();
    } catch (error) {
        console.error(`Release preflight failed: ${error.message}`);
        process.exitCode = 1;
    }
}
