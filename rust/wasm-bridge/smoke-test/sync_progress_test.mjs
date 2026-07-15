// Verifies wasm_sync_progress_json's "nothing reported yet" sentinel. Only
// covers the state before any sync has started — actually exercising a real
// sync's progress JSON needs a genuine network round trip (even a
// CORS-blocked/auth-rejected one still exercises the real emscripten_fetch
// path), which needs a real browser: this harness runs under plain Node,
// which has no XMLHttpRequest, and emscripten_fetch's XHR-based transport
// hard-crashes the process the instant a sync actually starts polling its
// network future forward (confirmed empirically — not a CORS issue, a
// missing-global one). See docs/ARCHITECTURE.md for how the rest of the
// progress pipeline was verified instead (real browser preview).
//
// Usage: node sync_progress_test.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[sync-progress-test]", ...a);

async function main() {
  const factory = (await import("./anki_wasm_bridge.js")).default;
  const Module = await factory({
    locateFile: (f) => path.join(__dirname, f),
    print: () => {},
    printErr: (s) => log("[wasm stderr]", s),
  });

  const err = () => {
    const p = Module._wasm_last_error_ptr(), l = Number(Module._wasm_last_error_len());
    return l === 0 ? "" : Buffer.from(Module.HEAPU8.subarray(p, p + l)).toString("utf8");
  };
  const withBuf = (bytes, fn) => {
    const p = Module._wasm_alloc(bytes.length);
    Module.HEAPU8.set(bytes, p);
    try { return fn(p, bytes.length); } finally { Module._wasm_dealloc(p, bytes.length); }
  };

  Module._wasm_init_backend();
  const empty = readFileSync(path.join(__dirname, "empty.anki2"));
  const rcOpen = withBuf(empty, (p, l) => Module._wasm_open_collection(p, l));
  if (rcOpen !== 0) { log("open FAILED", err()); process.exit(1); }

  const rcPre = Module._wasm_sync_progress_json();
  log(`progress before any sync -> rc=${rcPre} (expect 1, "no data yet")`);
  if (rcPre !== 1) { log("FAIL: expected 1"); process.exit(1); }

  // Calling it repeatedly should stay stable (no crash, no stale garbage).
  const rcAgain = Module._wasm_sync_progress_json();
  if (rcAgain !== 1) { log("FAIL: second call diverged", rcAgain); process.exit(1); }

  log("DONE — wasm_sync_progress_json is a safe, stable no-op before any sync has ever run");
}
main().catch((e) => { console.error("[sync-progress-test] FATAL:", e); process.exit(1); });
