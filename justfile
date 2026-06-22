# wasmavi build recipes. Run `just` to list, `just build` for a full build.

# Path to your emsdk checkout (override: `just emsdk=/path build`).
emsdk := env_var_or_default("EMSDK", env_var("HOME") / "emsdk")

# List available recipes.
default:
    @just --list

# Full build: install deps, compile the vim.wasm engine, bundle the extension.
build: install wasm ext

# Install JS/TS dependencies.
install:
    bun install

# Build the Asyncify vim.wasm engine (pins emscripten 3.1.8) and deploy it.
wasm:
    EMSDK="{{emsdk}}" bun run build:wasm

# Bundle the extension TypeScript -> JavaScript.
ext:
    bun run build

# Type-check the extension sources.
typecheck:
    bun run typecheck

# Run the service-worker tests.
test:
    bun run test
