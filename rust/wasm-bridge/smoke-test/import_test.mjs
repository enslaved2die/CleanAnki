// Independent verification script (not the agent's) for the apkg-import
// feature. Imports a real .apkg into a fresh empty collection, lists decks,
// selects the new one, and fetches a real card.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  console.log("[verify]", ...args);
}

async function main() {
  const factory = (await import("./anki_wasm_bridge.js")).default;
  const Module = await factory({
    locateFile: (f) => path.join(__dirname, f),
    print: (s) => log("[wasm stdout]", s),
    printErr: (s) => log("[wasm stderr]", s),
  });
  log("instantiated ok");

  function readLastError() {
    const ptr = Module._wasm_last_error_ptr();
    const len = Number(Module._wasm_last_error_len());
    if (len === 0) return "";
    return Buffer.from(Module.HEAPU8.subarray(ptr, ptr + len)).toString("utf8");
  }
  function readLastResult() {
    const ptr = Module._wasm_last_result_ptr();
    const len = Number(Module._wasm_last_result_len());
    if (len === 0) return "";
    return Buffer.from(Module.HEAPU8.subarray(ptr, ptr + len)).toString("utf8");
  }

  const rc0 = Module._wasm_init_backend();
  log("wasm_init_backend ->", rc0);

  const emptyBytes = readFileSync(path.join(__dirname, "empty.anki2"));
  const p0 = Module._wasm_alloc(emptyBytes.length);
  Module.HEAPU8.set(emptyBytes, p0);
  const rcOpen = Module._wasm_open_collection(p0, emptyBytes.length);
  Module._wasm_dealloc(p0, emptyBytes.length);
  log("wasm_open_collection (fresh empty) ->", rcOpen, rcOpen !== 0 ? readLastError() : "(ok)");
  if (rcOpen !== 0) process.exit(1);

  const apkgPath = process.argv[2];
  if (!apkgPath) throw new Error("usage: node import_test.mjs <path-to.apkg>");
  const apkgBytes = readFileSync(apkgPath);
  log(`read ${apkgBytes.length} bytes from ${apkgPath}`);

  const p1 = Module._wasm_alloc(apkgBytes.length);
  Module.HEAPU8.set(apkgBytes, p1);
  const t0 = process.hrtime.bigint();
  const rcImport = Module._wasm_import_apkg(p1, apkgBytes.length);
  const t1 = process.hrtime.bigint();
  Module._wasm_dealloc(p1, apkgBytes.length);
  log(`wasm_import_apkg -> ${rcImport} (${Number(t1 - t0) / 1e6}ms)`, rcImport !== 0 ? readLastError() : "(ok)");
  if (rcImport !== 0) process.exit(1);

  const rcList = Module._wasm_list_decks();
  const decksJson = readLastResult();
  log("wasm_list_decks ->", rcList, decksJson);
  if (rcList !== 0) process.exit(1);

  const decks = JSON.parse(decksJson);
  const nonDefault = decks.find(([id, name]) => id !== "1");
  if (!nonDefault) throw new Error("no non-default deck found after import");
  const [deckIdStr, deckName] = nonDefault;
  log(`selecting deck ${deckIdStr} (${deckName})`);

  const rcSelect = Module._wasm_set_current_deck(BigInt(deckIdStr));
  log("wasm_set_current_deck ->", rcSelect, rcSelect !== 0 ? readLastError() : "(ok)");
  if (rcSelect !== 0) process.exit(1);

  const cardId = Module._wasm_get_next_card();
  log("wasm_get_next_card ->", cardId, typeof cardId);

  log("VERIFY COMPLETE");
}

main().catch((e) => {
  console.error("[verify] FATAL:", e);
  process.exit(1);
});
