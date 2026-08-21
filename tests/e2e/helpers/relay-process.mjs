import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!port) throw new Error('failed to reserve relay port');
    return port;
}

export async function startRelay(port) {
    const output = [];
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            PORT: String(port),
            SERVER_SALT: 'koalasync-e2e-relay-salt-with-more-than-thirty-two-chars'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => output.push(String(chunk)));
    child.stderr.on('data', chunk => output.push(String(chunk)));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`relay exited with ${child.exitCode}: ${output.join('')}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return { child, output };
        } catch (_error) {
            // Relay is still starting.
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill('SIGTERM');
    throw new Error(`relay did not become healthy: ${output.join('')}`);
}

export async function stopRelay(relay) {
    if (!relay || relay.child.exitCode !== null) return;
    relay.child.kill('SIGTERM');
    const stopped = await Promise.race([
        new Promise(resolve => relay.child.once('exit', () => resolve(true))),
        new Promise(resolve => setTimeout(() => resolve(false), 7000))
    ]);
    if (stopped) return;
    relay.child.kill('SIGKILL');
    await new Promise(resolve => relay.child.once('exit', resolve));
    throw new Error(`relay required SIGKILL: ${relay.output.join('')}`);
}
