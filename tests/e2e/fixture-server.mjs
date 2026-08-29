#!/usr/bin/env node
/**
 * Static file server for the E2E fixtures. Local only, no directory listing,
 * paths are resolved and then checked to stay inside the fixture root.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(modulePath), 'fixtures');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mp4': 'video/mp4',
    '.json': 'application/json'
};

export function createFixtureServer(port) {
    return http.createServer((req, res) => {
        const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (requested === '/redirect/hidden-player') {
            res.writeHead(302, {
                Location: `http://127.0.0.1:${port}/pages/frames/player-frame-2.html?redirected=hidden`,
                'Cache-Control': 'no-store'
            }).end();
            return;
        }
        const filePath = path.resolve(root, `.${requested}`);

        if (!filePath.startsWith(root + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
        }

        fs.stat(filePath, (statErr, stat) => {
            if (statErr || !stat.isFile()) {
                res.writeHead(404).end('not found');
                return;
            }

            const contentType = TYPES[path.extname(filePath)] || 'application/octet-stream';
            // Media needs byte ranges: without them Chromium reports an empty
            // seekable range and seeking silently does nothing, which would make
            // the remote-seek test fail for a reason that has nothing to do with
            // the extension.
            const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
            if (range) {
                const start = range[1] ? Number(range[1]) : 0;
                const end = range[2] ? Number(range[2]) : stat.size - 1;
                if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
                    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
                    return;
                }
                res.writeHead(206, {
                    'Content-Type': contentType,
                    'Content-Length': end - start + 1,
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-store'
                });
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
            }

            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store'
            });
            fs.createReadStream(filePath).pipe(res);
        });
    });
}

export async function startFixtureServer(port = Number(process.env.KOALA_E2E_PORT || 4173)) {
    const server = createFixtureServer(port);
    await new Promise((resolve, reject) => {
        const onError = error => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
    return server;
}

export async function stopFixtureServer(server) {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections?.();
    });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath);
if (isMainModule) {
    const port = Number(process.argv[2] || process.env.KOALA_E2E_PORT || 4173);
    await startFixtureServer(port);
    console.log(`fixture server on http://localhost:${port}`);
}
