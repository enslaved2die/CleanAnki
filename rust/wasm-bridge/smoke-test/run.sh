#!/usr/bin/env bash
#
# Reproduces the 2026-07-10 Node smoke test end-to-end:
#   1. builds the wasm bridge (rust/wasm-bridge/build.sh)
#   2. builds the host-native make-test-collection helper
#   3. generates a fresh empty .anki2 and one with a real note/card
#   4. copies the .wasm/.js glue + fixtures next to this script
#   5. runs smoke_test.mjs against both fixtures under Node
#
# Requires the same toolchain as build.sh (rustup cargo + nightly + emsdk on
# PATH) plus a system `node`. See docs/ARCHITECTURE.md (2026-07-10 §7).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUST_DIR="$(cd "${BRIDGE_DIR}/.." && pwd)"
TARGET_DIR="${BRIDGE_DIR}/target/wasm32-unknown-emscripten/release"
TOOL_DIR="${RUST_DIR}/tools/make-test-collection"

echo "==> 1/5 building the wasm bridge"
bash "${BRIDGE_DIR}/build.sh"

echo "==> 2/5 building make-test-collection (host-native)"
( cd "${TOOL_DIR}" && cargo build --release --offline )
TOOL_BIN="${TOOL_DIR}/target/release/make-test-collection"

echo "==> 3/5 generating test fixtures"
rm -f "${SCRIPT_DIR}/empty.anki2" "${SCRIPT_DIR}/with_note.anki2"
"${TOOL_BIN}" "${SCRIPT_DIR}/empty.anki2"
"${TOOL_BIN}" "${SCRIPT_DIR}/with_note.anki2" --with-note

echo "==> 4/5 copying .wasm/.js glue next to the smoke test"
cp "${TARGET_DIR}/anki_wasm_bridge.js" "${SCRIPT_DIR}/"
cp "${TARGET_DIR}/anki_wasm_bridge.wasm" "${SCRIPT_DIR}/"

echo "==> 5/5 running the smoke test under Node"
cd "${SCRIPT_DIR}"
echo "--- empty.anki2 (expect get_next_card == -1n) ---"
node smoke_test.mjs empty.anki2
echo
echo "--- with_note.anki2 (expect a real card id, then a successful answer_card) ---"
node smoke_test.mjs with_note.anki2
