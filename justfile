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

# Cut a release: derive a CalVer version (YYYY.M.D, with a .N suffix for the
# Nth release in a day), write it to package.json + manifest.json, commit, tag,
# and push. CI (release.yml) then builds the extension and publishes the release.
# Usage: `just tag`
tag:
    #!/usr/bin/env bash
    set -euo pipefail
    # 10# forces base-10 so 08/09 don't parse as invalid octal; this also strips
    # the leading zeros Chrome's manifest version forbids.
    base="$(date +%Y).$((10#$(date +%m))).$((10#$(date +%d)))"
    ver="$base"
    if git rev-parse -q --verify "refs/tags/v$ver" >/dev/null; then
        n=1
        while git rev-parse -q --verify "refs/tags/v$base.$n" >/dev/null; do
            n=$((n + 1))
        done
        ver="$base.$n"
    fi
    echo "Releasing v$ver"
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
    # Publish to the fork that hosts CI/releases (cfoust/wasmavi), whether it is
    # named origin or fork in this checkout; fall back to origin.
    remote="$(git remote -v | awk '/cfoust\/wasmavi(\.git)?[[:space:]].*\(push\)/{print $1; exit}')"
    remote="${remote:-origin}"
    echo "Pushing to remote '$remote'"
    git commit -m "chore(release): v$ver" -- package.json src/chrome/manifest.json
    git tag -a "v$ver" -m "v$ver"
    git push "$remote" HEAD
    git push "$remote" "v$ver"
    echo "Pushed v$ver — CI will build and publish the release."
