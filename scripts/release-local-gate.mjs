import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { versionFromTag } from './release-artifact-checks.mjs';
import {
    parseCheckRuns,
    validateRequiredChecks
} from './release-preflight.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function capture(command, args) {
    return execFileSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

function run(command, args) {
    execFileSync(command, args, {
        cwd: repoRoot,
        stdio: 'inherit'
    });
}

export function parseGateArgs(args) {
    const values = Array.from(args);
    const candidate = values.includes('--candidate');
    const positional = values.filter(value => value !== '--candidate');
    if (positional.length !== 1) {
        throw new Error('Usage: npm run release:gate -- MAJOR.MINOR.PATCH [--candidate]');
    }
    const version = versionFromTag(`v${positional[0]}`);
    return { version, candidate };
}

export function playwrightImageFromLock(lock) {
    const version = lock?.packages?.['node_modules/@playwright/test']?.version;
    if (!/^\d+\.\d+\.\d+$/u.test(version || '')) {
        throw new Error('package-lock.json must pin node_modules/@playwright/test to an exact version');
    }
    return `mcr.microsoft.com/playwright:v${version}-noble`;
}

export function linuxGateCommand() {
    return [
        'git clone --no-local /src /work',
        'cd /work',
        'node scripts/prepare-release.mjs "$RELEASE_VERSION" "2030-01-01T00:00:00Z"',
        'node scripts/release-preflight.mjs --sources "$RELEASE_VERSION"',
        'npm ci',
        'npm ci --prefix server',
        'npm run verify',
        'npm run test:e2e'
    ].join(' && ');
}

export function parseRemoteMain(text) {
    const match = /^([a-f0-9]{40})\trefs\/heads\/main\s*$/u.exec(String(text));
    if (!match) throw new Error(`could not resolve origin main from: ${String(text).trim() || '<empty>'}`);
    return match[1];
}

export function validateReleaseWorkflowContract(text) {
    const workflow = String(text).replace(/\r\n/gu, '\n');
    const image = 'ghcr.io/shik3i/koalasync';
    if (!workflow.includes(`IMAGE: ${image}`)) {
        throw new Error(`release workflow must define the lowercase canonical image ${image}`);
    }
    for (const reference of ['images: ${{ env.IMAGE }}', 'subject-name: ${{ env.IMAGE }}']) {
        if (!workflow.includes(reference)) throw new Error(`release workflow must use ${reference}`);
    }
    if (/ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/u.test(workflow)) {
        throw new Error('release workflow must not derive a Docker image from case-preserving github.repository');
    }
    for (const marker of [
        'prepare-release:',
        'node scripts/prepare-release.mjs "$VERSION" "$RELEASE_TIMESTAMP"',
        'node scripts/release-preflight.mjs --sources "$VERSION"',
        'git commit -m "chore(release): update versions to v$VERSION [skip ci]"',
        'git push origin HEAD:main',
        'needs: [prepare-release, verify-prepared-release, release-extension-draft, release-server]',
        'gh release edit "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft=false --verify-tag'
    ]) {
        if (!workflow.includes(marker)) {
            throw new Error(`release workflow must preserve automatic tag versioning: ${marker}`);
        }
    }
    const preparedCheckout = 'ref: ${{ needs.prepare-release.outputs.prepared-commit }}';
    if ((workflow.match(new RegExp(preparedCheckout.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) || []).length < 3) {
        throw new Error('release workflow must use the prepared commit for verification and all release builds');
    }
    if (/git push origin HEAD:main\s*(?:\|\||;\s*true)/u.test(workflow)) {
        throw new Error('release workflow must stop when the automatic main push fails');
    }
    const verificationPermissions = [
        '  verify-prepared-release:',
        '    needs: [preflight, prepare-release]',
        '    runs-on: ubuntu-latest',
        '    permissions:',
        '      contents: read'
    ].join('\n');
    if (!workflow.includes(verificationPermissions)) {
        throw new Error('prepared release verification must explicitly limit GITHUB_TOKEN to contents: read');
    }
    return image;
}

export function validateWorkflowImageReferences(workflows) {
    const canonicalImage = 'ghcr.io/shik3i/koalasync';
    for (const [name, rawText] of Object.entries(workflows)) {
        const text = String(rawText);
        if (/ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/iu.test(text)) {
            throw new Error(`${name} must not derive a Docker image from case-preserving github.repository`);
        }
        for (const reference of text.match(/ghcr\.io\/[a-zA-Z0-9._/-]+/gu) || []) {
            if (reference !== canonicalImage) {
                throw new Error(`${name} must use the lowercase canonical image ${canonicalImage}, found ${reference}`);
            }
        }
    }
    return canonicalImage;
}

function assertCleanTree() {
    const status = capture('git', ['status', '--porcelain=v1']);
    if (status) throw new Error(`release gate requires a clean working tree:\n${status}`);
}

function assertFinalMainChecks() {
    const branch = capture('git', ['branch', '--show-current']);
    if (branch !== 'main') throw new Error(`final release gate requires branch main, found ${branch || '<detached>'}`);
    const head = capture('git', ['rev-parse', 'HEAD']);
    const remoteMain = parseRemoteMain(capture('git', [
        'ls-remote', '--exit-code', 'origin', 'refs/heads/main'
    ]));
    if (head !== remoteMain) throw new Error(`HEAD ${head} does not match origin/main ${remoteMain}`);

    const checksText = capture('gh', [
        'api', `repos/Shik3i/KoalaSync/commits/${head}/check-runs`,
        '--jq', '.check_runs[] | [.name, .conclusion, .html_url] | @tsv'
    ]);
    // Model the release workflow querying this commit while its own preflight
    // check is still running. This exact state broke the first v3.1.5 attempt.
    const checks = parseCheckRuns(`${checksText}\npreflight\t\tlocal://self-check`);
    validateRequiredChecks(checks);
}

async function smokeRelayImage(image) {
    const containerId = capture('docker', [
        'run', '--detach', '--platform', 'linux/amd64', '--publish', '127.0.0.1::3000',
        '--env', 'SERVER_SALT=release-local-gate-salt-with-more-than-thirty-two-chars',
        image
    ]);
    try {
        const portOutput = capture('docker', ['port', containerId, '3000/tcp']);
        const port = /:(\d+)$/u.exec(portOutput)?.[1];
        if (!port) throw new Error(`could not resolve relay host port: ${portOutput}`);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`, {
                    signal: globalThis.AbortSignal.timeout(1000)
                });
                if (response.ok) return;
            } catch (_error) {
                // Container is still starting.
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        run('docker', ['logs', containerId]);
        throw new Error('relay container did not become healthy within 30 seconds');
    } finally {
        run('docker', ['rm', '--force', containerId]);
    }
}

export async function runReleaseGate({ version, candidate }) {
    assertCleanTree();
    const workflowDir = path.join(repoRoot, '.github', 'workflows');
    const workflowFiles = fs.readdirSync(workflowDir)
        .filter(name => /\.ya?ml$/u.test(name));
    validateWorkflowImageReferences(Object.fromEntries(workflowFiles.map(name => [
        name,
        fs.readFileSync(path.join(workflowDir, name), 'utf8')
    ])));
    validateReleaseWorkflowContract(fs.readFileSync(
        path.join(repoRoot, '.github/workflows/release.yml'), 'utf8'
    ));
    if (!candidate) assertFinalMainChecks();

    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const playwrightImage = playwrightImageFromLock(lock);
    run('docker', ['pull', '--platform', 'linux/amd64', playwrightImage]);
    run('docker', [
        'run', '--rm', '--platform', 'linux/amd64', '--ipc=host', '--env', 'CI=1',
        '--env', `RELEASE_VERSION=${version}`,
        '--volume', `${repoRoot}:/src:ro`, playwrightImage,
        'bash', '-lc', linuxGateCommand()
    ]);

    const relayImage = `koalasync:${version}-release-gate`;
    run('docker', [
        'build', '--platform', 'linux/amd64',
        '--file', 'server/Dockerfile', '--tag', relayImage, '.'
    ]);
    await smokeRelayImage(relayImage);
    console.log(`Local ${candidate ? 'candidate' : 'final'} release gate passed for v${version}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    try {
        await runReleaseGate(parseGateArgs(process.argv.slice(2)));
    } catch (error) {
        console.error(`Local release gate failed: ${error.message}`);
        process.exitCode = 1;
    }
}
