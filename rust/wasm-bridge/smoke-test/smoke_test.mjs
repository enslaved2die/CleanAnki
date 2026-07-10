// Node smoke test for the anki-wasm-bridge Emscripten module.
// Run with: node --experimental-wasm-threads smoke_test.mjs
// (or just `node smoke_test.mjs` on a Node new enough that wasm threads are
// no longer behind a flag; Node 26 here does not require the flag.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  console.log("[smoke]", ...args);
}

async function main() {
  log("importing generated glue module...");
  const factory = (await import("./anki_wasm_bridge.js")).default;
  log("glue module imported OK, factory =", typeof factory);

  log("instantiating (this is the first real runtime signal)...");
  const Module = await factory({
    // Keep emscripten from trying to locate files relative to some other
    // base; our .wasm sits next to the .mjs.
    locateFile: (f) => path.join(__dirname, f),
    print: (s) => log("[wasm stdout]", s),
    printErr: (s) => log("[wasm stderr]", s),
  });
  log("INSTANTIATION SUCCEEDED. Module keys sample:",
    Object.keys(Module).filter((k) => k.startsWith("_wasm_")).sort());

  // --- exercise the exports -------------------------------------------------
  const rc0 = Module._wasm_init_backend();
  log("wasm_init_backend() ->", rc0);

  function readLastError() {
    const ptr = Module._wasm_last_error_ptr();
    const len = Number(Module._wasm_last_error_len());
    if (len === 0) return "";
    const bytes = Module.HEAPU8.subarray(ptr, ptr + len);
    return Buffer.from(bytes).toString("utf8");
  }

  const collectionFile = process.argv[2] || "empty.anki2";
  const collectionPath = path.join(__dirname, collectionFile);
  const bytes = readFileSync(collectionPath);
  log(`read ${bytes.length} bytes from ${collectionPath}`);

  const ptr = Module._wasm_alloc(bytes.length);
  log("wasm_alloc ->", ptr);
  Module.HEAPU8.set(bytes, ptr);

  const rcOpen = Module._wasm_open_collection(ptr, bytes.length);
  log("wasm_open_collection() ->", rcOpen, rcOpen !== 0 ? `ERROR: ${readLastError()}` : "(ok)");

  Module._wasm_dealloc(ptr, bytes.length);

  if (rcOpen === 0) {
    const cardId = Module._wasm_get_next_card();
    log("wasm_get_next_card() ->", cardId, typeof cardId,
      cardId === -1n ? "(empty queue)" : "(got a real due card)");

    if (cardId !== -1n) {
      // ease 3 = "Good"
      const rcAnswer = Module._wasm_answer_card(3);
      log("wasm_answer_card(3) ->", rcAnswer, rcAnswer !== 0 ? `ERROR: ${readLastError()}` : "(ok)");

      const cardId2 = Module._wasm_get_next_card();
      log("wasm_get_next_card() after answering ->", cardId2,
        cardId2 === -1n ? "(queue now empty, as expected: single-card collection just answered)" : "(unexpected: still cards left)");
    }
  }

  log("SMOKE TEST COMPLETE");
}

main().catch((e) => {
  console.error("[smoke] FATAL:", e);
  process.exit(1);
});
