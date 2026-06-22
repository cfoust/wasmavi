#!/usr/bin/env node
/*
 * Tiny static file server for trying the wasavi + vim.wasm integration.
 *
 * vim.wasm needs SharedArrayBuffer, which a document may only use when it is
 * "cross-origin isolated".  That requires these two response headers on the
 * top level document:
 *
 *     Cross-Origin-Opener-Policy:   same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * This server sets them (plus Cross-Origin-Resource-Policy for subresources)
 * on everything it serves, and serves .wasm with the correct MIME type so
 * WebAssembly.instantiateStreaming() works.
 *
 * Usage:   node test-harness/server.js [port]
 * Then open http://localhost:8765/test-harness/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8765;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.data': 'application/octet-stream',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

const NO_COI = process.env.NO_COI === '1';

const server = http.createServer((req, res) => {
    // cross-origin isolation headers (enable SharedArrayBuffer).
    // The Asyncify build of vim.wasm does NOT need these; set NO_COI=1 to serve
    // without them and prove editing still works on a non-isolated page.
    if (!NO_COI) {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }

    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // resolve and guard against path traversal
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404); res.end('Not found: ' + urlPath); return;
        }
        res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log('wasavi + vim.wasm test harness');
    console.log('  serving ' + ROOT);
    console.log('  open    http://localhost:' + PORT + '/test-harness/');
});
