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

# Cut a release: set VERSION in package.json + manifest.json, commit, tag, push.
# CI (release.yml) then builds the extension and publishes a GitHub release.
# Usage: `just tag 1.2.0`
tag version:
    #!/usr/bin/env bash
    set -euo pipefail
    ver="{{version}}"
    ver="${ver#v}"
    if ! [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "error: version must be SEMVER like 1.2.0 (got '{{version}}')" >&2
        exit 1
    fi
    if git rev-parse -q --verify "refs/tags/v$ver" >/dev/null; then
        echo "error: tag v$ver already exists" >&2
        exit 1
    fi
    bun -e '
        const fs = require("fs");
        const v = process.argv[1];
        for (const f of ["package.json", "src/chrome/manifest.json"]) {
            const s = fs.readFileSync(f, "utf8");
            const next = s.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`);
            if (next === s) throw new Error(`no version field updated in ${f}`);
            fs.writeFileSync(f, next);
        }
    ' "$ver"
    git commit -m "chore(release): v$ver" -- package.json src/chrome/manifest.json
    git tag -a "v$ver" -m "v$ver"
    git push origin HEAD
    git push origin "v$ver"
    echo "Pushed v$ver — CI will build and publish the release."
