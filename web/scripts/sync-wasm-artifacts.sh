#!/usr/bin/env bash
#
# Copies the Emscripten build output from rust/wasm-bridge/ (and a bundled
# starter collection fixture) into web/public/wasm/, where Vite serves it as
# a static passthrough (dev server AND `vite build`, which copies public/
# verbatim into dist/ root) at /wasm/*.
#
# public/ is the deliberate choice over importing the .js/.wasm through
# Vite's bundler: the generated glue re-invokes itself by a *literal*
# self-referential URL for pthread worker bootstrap
# (`new Worker(new URL("anki_wasm_bridge.js", import.meta.url))` — see
# docs/ARCHITECTURE.md §8), which would break under Vite's asset hashing.
# Serving it unprocessed from a fixed path sidesteps that entirely.
#
# Run this manually after (re)building the wasm bridge:
#   bash rust/wasm-bridge/build.sh
#   bash web/scripts/sync-wasm-artifacts.sh
#
# public/wasm/ is gitignored (the .wasm is ~11MB and is always regenerable
# from source) — see web/public/wasm/.gitignore.

set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_DIR="$(cd "${WEB_DIR}/../rust" && pwd)"
BRIDGE_RELEASE_DIR="${RUST_DIR}/wasm-bridge/target/wasm32-unknown-emscripten/release"
OUT_DIR="${WEB_DIR}/public/wasm"
TOOL_DIR="${RUST_DIR}/tools/make-test-collection"

if [ ! -f "${BRIDGE_RELEASE_DIR}/anki_wasm_bridge.js" ] || [ ! -f "${BRIDGE_RELEASE_DIR}/anki_wasm_bridge.wasm" ]; then
  echo "ERROR: wasm-bridge build output not found at ${BRIDGE_RELEASE_DIR}"
  echo "  Build it first:  bash rust/wasm-bridge/build.sh"
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "==> copying anki_wasm_bridge.{js,wasm}"
cp "${BRIDGE_RELEASE_DIR}/anki_wasm_bridge.js" "${OUT_DIR}/"
cp "${BRIDGE_RELEASE_DIR}/anki_wasm_bridge.wasm" "${OUT_DIR}/"

echo "==> building make-test-collection (host-native, for the starter fixture)"
( cd "${TOOL_DIR}" && cargo build --release --offline )

echo "==> generating starter-collection.anki2 (one real note/card, so first launch has something to study)"
rm -f "${OUT_DIR}/starter-collection.anki2"
"${TOOL_DIR}/target/release/make-test-collection" "${OUT_DIR}/starter-collection.anki2" --with-note

echo "==> done. web/public/wasm/ now has:"
ls -la "${OUT_DIR}"
