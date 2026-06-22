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

source ~/emsdk/emsdk_env.sh

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
        "-sASYNCIFY_IMPORTS=['vimwasm_wait_for_event']" \
        "-sEXPORTED_FUNCTIONS=['_wasm_main','_gui_wasm_resize_shell','_gui_wasm_handle_keydown','_gui_wasm_handle_drop','_gui_wasm_set_clip_avail','_gui_wasm_do_cmdline','_gui_wasm_emsg']" \
        "-sEXPORTED_RUNTIME_METHODS=['cwrap']" \
        --preload-file usr --preload-file tutor --preload-file home \
        -Os
}

deploy() {
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
