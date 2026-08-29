import http from 'node:http';
import { startFixtureServer, stopFixtureServer } from './fixture-server.mjs';

function fixtureIsRunning(port) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const request = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/pages/simple-player.html'
        }, response => {
            response.resume();
            response.once('error', () => finish(false));
            response.once('end', () => finish(response.statusCode === 200));
        });
        request.once('error', () => finish(false));
        request.setTimeout(1000, () => {
            request.destroy();
            finish(false);
        });
    });
}

export default async function globalSetup() {
    const port = Number(process.env.KOALA_E2E_PORT || 4173);
    if (!process.env.CI && await fixtureIsRunning(port)) return undefined;

    const server = await startFixtureServer(port);
    return async () => stopFixtureServer(server);
}
