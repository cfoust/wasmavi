# wasavi × vim.wasm integration

This repository wires [**wasavi**](./wasavi) (a browser extension that brings vi
keybindings to any text field) to use [**vim.wasm**](./vim.wasm) (real Vim
compiled to WebAssembly) as its editing engine, replacing wasavi's own
JavaScript reimplementation of vi.

Focus a `<textarea>`/`<input>`, hit the activation shortcut (**Ctrl+Enter** or
**Insert**), edit with vi keys, `:w` writes the text back to the field and `:q`
closes the editor. The keystrokes are handled by **actual Vim** running in a Web
Worker — and, thanks to an Asyncify rebuild, **without any SharedArrayBuffer
requirement**, so it works on ordinary pages (no cross-origin isolation needed).

---

## How it works

wasavi already split into two pieces that talk over a small message protocol
routed through the extension's background:

* **the agent** (`wasavi/src/chrome/frontend/agent.js`) — a content script that,
  on activation, reads the target element's text, injects an `<iframe>` pointing
  at the extension's `wasavi.html`, ships the text to it, and writes edited text
  back to the element.
* **the editor frame** (`wasavi.html` + the engine) — runs inside that iframe.

Only the **editor frame** was swapped; the agent speaks the same protocol:

```
agent                              editor frame (vim.wasm)
  |  push-payload {value:"…"}  -->  |   (routed via the service worker)
  |                                 |   connect('init') receives the payload
  | <-------- 'initialized' --------|
  | <-------- 'window-state' -------|   maximize the iframe
  | <-------- 'ready' --------------|   agent reveals + focuses the frame
  |                                 |
  | <-------- 'write' {value:"…"} --|   on :w  (BufWritePost ➜ :export ➜ onFileExport)
  | <-------- 'terminated' ---------|   on :q / :wq / :qa
```

Inside the frame, [`frontend/vimwasm_frame.ts`](./wasavi/src/chrome/frontend/vimwasm_frame.ts):

1. Receives the boot payload (the element's text is in `payload.value`).
2. Preloads that text as a file in Vim's in-memory filesystem and opens it.
3. Installs an autocommand so every successful write exports the buffer:
   `autocmd BufWritePost * silent! execute 'export ' . fnameescape(expand('%:p'))`.
   `:export` fires the JS `onFileExport` callback with the file's bytes, which
   the frame sends to the agent as a `write` message, which writes it back to the
   host element.
4. On Vim exit sends `terminated`; the agent tears the iframe down.

This maps cleanly onto vi semantics: `:w` syncs the field live, `:q` discards,
`:wq` writes then closes, `:q!` abandons changes.

---

## Dropping SharedArrayBuffer (the Asyncify rebuild)

Stock vim.wasm runs Vim's blocking C main loop in a Worker and waits for input
with `Atomics.wait()` on a `SharedArrayBuffer`. SAB requires the page to be
cross-origin isolated (COOP+COEP), which an iframe injected into an arbitrary
page can never be — so stock vim.wasm could not work as an injected editor.

We rebuilt Vim with **emscripten Asyncify** so the input wait suspends the Wasm
stack and yields to the worker's event loop instead of blocking, and replaced the
SAB/Atomics channel with ordinary `postMessage`:

* `vim.wasm/wasm/runtime.ts` — `vimwasm_wait_for_event` is now async
  (`Asyncify.handleAsync`, listed in `ASYNCIFY_IMPORTS`); input arrives via
  `postMessage` and is applied with reentrant `_gui_wasm_handle_keydown`/
  `_gui_wasm_resize_shell` calls while the loop is suspended. `wasm_main` is
  cwrapped `{async:true}` so program exit is caught cleanly.
* `vim.wasm/wasm/vimwasm.ts` — the driver sends key/resize/cmdline via
  `postMessage`; `checkBrowserCompatibility()` no longer requires SAB.
* Built with `-sASYNCIFY` (see `scripts/build-vim-wasm.sh`).

Trade-offs: Asyncify adds some Wasm size/overhead (fine for an editor). The
**system clipboard** works — clipboard write is a fire-and-forget postMessage,
and clipboard read is an async (Asyncify) round-trip, the same pattern as the
input wait. The editor sets `clipboard=unnamed` so y/d/p use the system
clipboard via the `*` register (the `+` register's read path is an upstream stub).
**jsevalfunc** remains disabled (it needed a synchronous result round-trip).

**Result (verified):** the editor boots, loads the field text, edits, and writes
back on a page with `crossOriginIsolated === false`.

---

## TypeScript + Bun

Project tooling is TypeScript built/run with **Bun**:

* Extension sources are TypeScript: `frontend/vimwasm_frame.ts`, `backend/sw.ts`.
* `bun run build` (→ `build.ts`) bundles them to the `.js` the extension loads
  (the vim.wasm driver is bundled into the frame; the worker stays a separate
  asset).
* `bun run typecheck` (`tsc --noEmit`) — clean.
* `bun run test` runs the service-worker routing test (`test-harness/sw.test.ts`).
* `bun run build:wasm` rebuilds the Asyncify vim.wasm engine end-to-end.
* The vim.wasm worker/driver (`runtime.ts`, `vimwasm.ts`) were already TS; they
  compile via `bunx tsc` inside `scripts/build-vim-wasm.sh`.

---

## Files

**Added / changed (extension)**

| Path | Purpose |
|------|---------|
| `wasavi/src/chrome/backend/sw.ts` → `sw.js` | MV3 service-worker backend (replaces the Kosian background page) |
| `wasavi/src/chrome/frontend/vimwasm_frame.ts` → `.js` | Editor-frame glue: protocol ↔ vim.wasm |
| `wasavi/src/chrome/frontend/vim-wasm/` | Asyncify vim.wasm assets (`vim.wasm`, `vim.data`, `vim.js` worker, `vimwasm.js` driver) |
| `wasavi/src/chrome/manifest.json` | Manifest V3 (service worker, host_permissions, MV3 CSP/`web_accessible_resources`) |
| `wasavi/src/chrome/wasavi.html` | Loads the canvas/input + `vimwasm_frame.js` |

**Added (engine + tooling)**

| Path | Purpose |
|------|---------|
| `vim.wasm/wasm/runtime.ts`, `vimwasm.ts`, `runtime.d.ts` | Asyncify / no-SAB changes |
| `vim.wasm/wasm/tsconfig.{worker,main}.build.json` | lenient build configs |
| `scripts/build-vim-wasm.sh` | full Asyncify build (configure → make → link → deploy) |
| `package.json`, `tsconfig.json`, `build.ts` | Bun + TypeScript project tooling |
| `test-harness/` | COOP/COEP-optional static server, demo, `sw.test.ts` |

The original JS vi engine (`wasavi.js`, `classes*.js`) and Kosian backend remain
in the repo for reference but are unused.

---

## Verification status

| Check | Result |
|-------|--------|
| vim.wasm loads the field text, edits, writes back on `:w`/`:wq` — **on a non-isolated page** (`crossOriginIsolated === false`), real Chrome | ✅ pass |
| Content preserved (no-edit `:wq` returns the original buffer) | ✅ pass |
| MV3 manifest validity (`--pack-extension` → `.crx`) | ✅ valid |
| Service-worker routing/handshake (`bun run test`) | ✅ pass |
| `bun run typecheck` | ✅ clean |

> Note: a fully automated "load the unpacked extension and click" run isn't
> possible here because this Chrome build disables the `--load-extension`
> command-line switch (a Chrome 137+ hardening). That does not affect the
> **Load unpacked** UI you install with.

---

## Build & run

```bash
# build the Asyncify vim.wasm engine (needs emsdk active + bun)
source ~/emsdk/emsdk_env.sh
bun run build:wasm

# build the extension TypeScript -> JS
bun run build

# tests
bun run test          # service-worker routing
bun run typecheck

# try the editor in a browser (no cross-origin isolation needed):
node test-harness/server.js            # http://localhost:8765/test-harness/
#   NO_COI=1 node test-harness/server.js   # prove it works without COOP/COEP
```

Install in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
select `wasavi/src/chrome`. Activate on a textarea with **Ctrl+Enter** / **Insert**.

---

## Known limitations

* **Clipboard**: the system clipboard works (read via an async round-trip, write
  fire-and-forget); the editor uses `clipboard=unnamed` (the `*` register). The
  `+` register read is an upstream stub. **jsevalfunc** is still disabled (it
  needed a synchronous result).
* **Cursor restoration**: the cursor starts at the top of the buffer; the host
  element's selection offset isn't yet mapped to a Vim line/column.
* **Options page**: `options.html` still uses the old Kosian frontend and isn't
  wired to the service worker; editing defaults live in `backend/sw.ts`.
* The full (non-`small`) vim.wasm build is bundled (~9 MB of `vim.data` +
  `vim.wasm`); the `small` feature set could shrink it.
