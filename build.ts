/*
 * build.ts — Bun build for the wasavi extension's TypeScript sources.
 *
 * Compiles the editor-frame glue and the MV3 service worker to the .js files
 * the unpacked extension loads. The vim.wasm driver (vimwasm.ts -> vimwasm.js)
 * is bundled into the frame, so the frame is self-contained; the worker
 * (vim.js) and wasm/data stay as separate runtime assets.
 *
 * Usage: bun run build.ts   (or: bun run build)
 */
import { rmSync } from 'node:fs';

const CHROME = `${import.meta.dir}/src/chrome`;

const targets = [
    {
        name: 'editor frame',
        entry: `${CHROME}/frontend/vimwasm_frame.ts`,
        outdir: `${CHROME}/frontend`,
    },
    {
        name: 'service worker',
        entry: `${CHROME}/backend/sw.ts`,
        outdir: `${CHROME}/backend`,
    },
];

let failed = false;
for (const t of targets) {
    const result = await Bun.build({
        entrypoints: [t.entry],
        outdir: t.outdir,
        target: 'browser',
        format: 'esm',
        naming: '[name].js',
        sourcemap: 'none',
        // The emscripten worker is referenced by URL at runtime, never imported.
        external: [],
    });
    if (!result.success) {
        failed = true;
        console.error(`✗ ${t.name} build failed:`);
        for (const log of result.logs) console.error(log);
    } else {
        const out = result.outputs.map(o => o.path.replace(import.meta.dir + '/', '')).join(', ');
        console.log(`✓ ${t.name} -> ${out}`);
    }
}

// Bun emits a .js for every entry; clean any stray maps.
try { rmSync(`${CHROME}/frontend/vimwasm_frame.js.map`); } catch {}
try { rmSync(`${CHROME}/backend/sw.js.map`); } catch {}

if (failed) process.exit(1);
console.log('extension build complete.');
