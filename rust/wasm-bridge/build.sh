#!/usr/bin/env bash
#
# Phase 1 spike build script for the Anki rslib -> WASM bridge.
#
# Target: wasm32-unknown-emscripten (NOT wasm32-unknown-unknown) so that
# emscripten's C toolchain can compile rusqlite's bundled SQLite C amalgamation,
# and so emscripten pthreads (Web Workers + SharedArrayBuffer) can back
# tokio's rt-multi-thread and rayon.
#
# This has never been shown to work end-to-end; expect to iterate.

set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="wasm32-unknown-emscripten"

# --- 0. Toolchain preflight -------------------------------------------------
missing=0

if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: cargo/rustup not found on PATH."
  echo "  Install Rust:   https://rustup.rs"
  missing=1
fi

if ! command -v emcc >/dev/null 2>&1; then
  echo "ERROR: emcc (Emscripten) not found on PATH."
  echo "  Install the Emscripten SDK:"
  echo "    git clone https://github.com/emscripten-core/emsdk.git"
  echo "    cd emsdk && ./emsdk install latest && ./emsdk activate latest"
  echo "    source ./emsdk_env.sh   # puts emcc on PATH"
  missing=1
fi

if command -v rustup >/dev/null 2>&1; then
  if ! rustup target list --installed 2>/dev/null | grep -q "^${TARGET}$"; then
    echo "NOTE: Rust target ${TARGET} not installed. Installing..."
    rustup target add "${TARGET}" || {
      echo "ERROR: failed to add ${TARGET}. If your rust is not from rustup,"
      echo "       install the target manually or switch to a rustup toolchain."
      missing=1
    }
  fi
fi

if [ "${missing}" -ne 0 ]; then
  echo
  echo "Toolchain incomplete — see messages above. Aborting before build."
  exit 1
fi

# --- 0b. protoc -------------------------------------------------------------
# anki_proto's build.rs uses prost-build, which requires a system `protoc`
# (it is NOT bundled). Point it at one explicitly if not already on PATH.
if [ -z "${PROTOC:-}" ]; then
  if command -v protoc >/dev/null 2>&1; then
    export PROTOC="$(command -v protoc)"
  elif [ -x /opt/homebrew/bin/protoc ]; then
    export PROTOC=/opt/homebrew/bin/protoc
  else
    echo "ERROR: protoc not found (needed by anki_proto's build.rs)."
    echo "  Install it:   brew install protobuf"
    exit 1
  fi
fi
echo "PROTOC=${PROTOC}"

# --- 1. pthread flags -------------------------------------------------------
# emscripten pthreads require:
#   * the wasm atomics + bulk-memory features enabled in the Rust codegen
#   * emcc compiled/linked with -pthread
# Enabling atomics on a stable-std target generally forces a std rebuild, hence
# the nightly `-Z build-std`. If you are not on nightly, drop build-std and be
# prepared for link errors about missing atomic intrinsics.
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+atomics,+bulk-memory,+mutable-globals"

# tokio hard-rejects fs/rt-multi-thread/net/signal on any wasm target
# (target_family = "wasm", which emscripten also sets) via a compile_error!,
# UNLESS the `tokio_unstable` cfg is set. anki uses tokio's `fs` +
# `rt-multi-thread`; with the sync networking gated out there is no `net`
# feature (so no `mio`), and emscripten provides pthreads + a filesystem, so we
# opt into the unstable escape hatch to let those features compile.
export RUSTFLAGS="${RUSTFLAGS} --cfg tokio_unstable"

# Passed through to every emcc invocation (both the cc-built SQLite and the
# final link). USE_PTHREADS + a nonzero pool give tokio/rayon real workers.
export EMCC_CFLAGS="${EMCC_CFLAGS:-} -pthread -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=4 -s ALLOW_MEMORY_GROWTH=1"

# -fPIC: Rust codegen for this target is position-independent by default, but the
# cc-crate C compiles (rusqlite's bundled SQLite amalgamation, zstd-sys, etc.) are
# not, so wasm-ld rejects their data relocations ("recompile with -fPIC"). The
# cc crate keys its object cache on CFLAGS_<target>, so setting it here both adds
# -fPIC to those emcc compiles AND forces a recompile when it changes.
#
# NOTE (2026-07-10): kept even after switching from cdylib to a bin target —
# rustc's wasm32-unknown-emscripten target spec defaults to PIC codegen
# regardless of crate-type, so wasm-ld still rejects non-PIC C objects.
export EMCC_CFLAGS="${EMCC_CFLAGS} -fPIC"
export CFLAGS_wasm32_unknown_emscripten="${CFLAGS_wasm32_unknown_emscripten:-} -fPIC"

# NOTE (2026-07-10): the JS-glue-generation flags (-sMODULARIZE=1 etc.) are
# deliberately NOT set here via RUSTFLAGS/-C link-arg. Plain RUSTFLAGS applies
# to *every* rustc invocation in the whole dependency graph, including
# dependencies that themselves declare a `cdylib` output (e.g. reqwest's
# `wasm-streams` dep, used for wasm-bindgen-based streaming) — those got
# linked with our `-sEXPORTED_FUNCTIONS=[our fns]` + implied MODULARIZE
# executable-link mode too, and failed with
# `emcc: error: undefined exported symbol: "_main"` because they have no
# main() and don't export any of our functions. Fix: those flags now live in
# `rust/wasm-bridge/build.rs`, emitted via `cargo:rustc-link-arg`, which Cargo
# scopes to only the *current* package's own final link (our bin target) —
# see that file for the exact flag list.

echo "RUSTFLAGS=${RUSTFLAGS}"
echo "EMCC_CFLAGS=${EMCC_CFLAGS}"

# --- 2. Build ---------------------------------------------------------------
cd "${CRATE_DIR}"

# -Z build-std needs nightly + the rust-src component:
#   rustup toolchain install nightly
#   rustup component add rust-src --toolchain nightly
BUILD_STD_ARGS=(-Z build-std=std,panic_abort)

echo "==> cargo +nightly build --release --target ${TARGET}"
cargo +nightly build \
  --release \
  --target "${TARGET}" \
  "${BUILD_STD_ARGS[@]}"

echo
echo "Build finished. Artifacts (if produced):"
ls -la "${CRATE_DIR}/target/${TARGET}/release/"anki_wasm_bridge.* 2>/dev/null || true
