#!/bin/bash
#
# build-vim-wasm.sh — build the Asyncify (no-SharedArrayBuffer) vim.wasm engine
# and deploy it into the wasavi extension.
#
# Requirements: emsdk active (source ~/emsdk/emsdk_env.sh), bun on PATH.
#
# Stages:
#   configure  cross-compile Vim with emscripten (no test-program execution)
#   make       compile Vim C sources to wasm objects (src/objects/*.o, vim.bc)
#   link       compile the TS runtime/driver and emcc-link with -sASYNCIFY,
#              feeding input via postMessage instead of Atomics/SharedArrayBuffer
#   deploy     copy vim.js / vim.wasm / vim.data / vimwasm.js into the extension
#
# Pass a stage name to run a single stage; with no args runs all of them.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VIM="$ROOT/vim.wasm"
WASM="$VIM/wasm"
DEST="$ROOT/src/chrome/frontend/vim-wasm"

# Pin the emscripten toolchain. This engine's Asyncify runtime (worker exit
# detection, the default _malloc/runtime-method exports) is sensitive to the
# emscripten version; newer SDKs change those defaults and break `:q` and
# memory allocation. 3.1.8 is the known-good version — keep all builds on it.
EMSDK_VERSION="3.1.8"
EMSDK="${EMSDK:-$HOME/emsdk}"

if [ ! -f "$EMSDK/emsdk_env.sh" ]; then
    echo "error: emsdk not found at '$EMSDK'." >&2
    echo "  Install it (git clone https://github.com/emscripten-core/emsdk) and/or" >&2
    echo "  set EMSDK=/path/to/emsdk, then re-run." >&2
    exit 1
fi

# Activate the pinned version (installing it first if needed). Both are no-ops
# when 3.1.8 is already installed and active, so this stays fast on rebuilds.
if ! "$EMSDK/emsdk" activate "$EMSDK_VERSION" >/dev/null 2>&1; then
    echo "build-vim-wasm.sh: installing emscripten $EMSDK_VERSION ..."
    "$EMSDK/emsdk" install "$EMSDK_VERSION"
    "$EMSDK/emsdk" activate "$EMSDK_VERSION"
fi

source "$EMSDK/emsdk_env.sh"

ACTIVE_VERSION="$(emcc --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ "$ACTIVE_VERSION" != "$EMSDK_VERSION" ]; then
    echo "error: active emscripten is '$ACTIVE_VERSION', expected '$EMSDK_VERSION'." >&2
    echo "  Run: \"$EMSDK/emsdk\" install $EMSDK_VERSION && \"$EMSDK/emsdk\" activate $EMSDK_VERSION" >&2
    exit 1
fi

configure() {
    cd "$VIM"
    # Vim's configure runs test programs, which fails under emscripten (the
    # generated JS can't be executed by a modern Node). Force cross-compilation
    # and supply the cache variables it would otherwise compute by running code.
    export vim_cv_toupper_broken=no vim_cv_terminfo=yes vim_cv_tgetent=zero \
        vim_cv_tty_group=world vim_cv_tty_mode=0620 vim_cv_getcwd_broken=no \
        vim_cv_stat_ignores_slash=no vim_cv_memmove_handles_overlap=yes \
        vim_cv_bcopy_handles_overlap=yes vim_cv_memcpy_handles_overlap=yes
    ( cd src && make distclean >/dev/null 2>&1 || true )
    CPP="gcc -E" emconfigure ./configure \
        --host=wasm32-unknown-emscripten \
        --enable-fail-if-missing --enable-gui=wasm --with-features=normal \
        --with-x=no --with-vim-name=vim.bc --with-modified-by=rhysd --with-compiledby=rhysd \
        --disable-darwin --disable-smack --disable-selinux --disable-xsmp --disable-xsmp-interact \
        --disable-luainterp --disable-mzschemeinterp --disable-perlinterp --disable-pythoninterp \
        --disable-python3interp --disable-tclinterp --disable-rubyinterp --disable-cscope \
        --disable-netbeans --disable-channel --disable-terminal --disable-autoservername \
        --disable-rightleft --disable-arabic --disable-xim --disable-fontset \
        --disable-gtktest --disable-icon-cache-update --disable-desktop-database-update \
        --disable-largefile --disable-canberra --disable-acl --disable-gpm \
        --disable-sysmouse --disable-nls
}

make_objects() {
    cd "$VIM"
    emmake make -j CFLAGS="-Os"
    cp src/vim.bc wasm/ 2>/dev/null || true
}

link() {
    cd "$WASM"
    # Compile the TypeScript runtime (worker) and driver (main).
    bunx tsc -p tsconfig.worker.build.json || echo "(worker tsc: type warnings, emitted)"
    bunx tsc -p tsconfig.main.build.json   || echo "(main tsc: type warnings, emitted)"
    [ -f tutor ] || cp ../runtime/tutor/tutor tutor
    emcc ../src/objects/*.o \
        -o vim.js -lidbfs.js \
        --pre-js pre.js --js-library runtime.js \
        -sINVOKE_RUN=1 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 \
        -sASYNCIFY -sASYNCIFY_STACK_SIZE=65536 \
        "-sASYNCIFY_IMPORTS=['vimwasm_wait_for_event','vimwasm_read_clipboard']" \
        "-sEXPORTED_FUNCTIONS=['_wasm_main','_gui_wasm_resize_shell','_gui_wasm_handle_keydown','_gui_wasm_handle_drop','_gui_wasm_set_clip_avail','_gui_wasm_do_cmdline','_gui_wasm_emsg','_malloc','_free']" \
        "-sEXPORTED_RUNTIME_METHODS=['cwrap','ccall','UTF8ToString','stringToUTF8','lengthBytesUTF8','HEAPU8']" \
        --preload-file usr --preload-file tutor --preload-file home \
        -Os
}

deploy() {
    # The deploy target holds generated files and is gitignored, so it does not
    # exist on a fresh checkout (e.g. CI). Create it before copying.
    mkdir -p "$DEST"
    cp "$WASM/vim.js" "$WASM/vim.wasm" "$WASM/vim.data" "$WASM/vimwasm.js" "$DEST/"
    echo "Deployed Asyncify vim.wasm engine to $DEST"
    ls -la "$DEST"/vim.js "$DEST"/vim.wasm "$DEST"/vim.data "$DEST"/vimwasm.js
}

case "${1:-all}" in
    configure) configure ;;
    make) make_objects ;;
    link) link ;;
    deploy) deploy ;;
    all) configure; make_objects; link; deploy ;;
    *) echo "usage: $0 [configure|make|link|deploy|all]" >&2; exit 1 ;;
esac
echo "build-vim-wasm.sh: ${1:-all} done"
