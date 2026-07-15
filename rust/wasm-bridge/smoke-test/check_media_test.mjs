// Verifies wasm_check_media / wasm_delete_unused_media against a real .apkg.
// Scenario: import media.apkg, plant an unreferenced media file, confirm the
// checker reports it as unused, delete unused, confirm it's gone.
// Usage: node check_media_test.mjs <path-to.apkg>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[check-media-test]", ...a);

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
  const resStr = () => {
    const p = Module._wasm_last_result_ptr(), l = Number(Module._wasm_last_result_len());
    return l === 0 ? "" : Buffer.from(Module.HEAPU8.subarray(p, p + l)).toString("utf8");
  };
  const withBuf = (bytes, fn) => {
    const p = Module._wasm_alloc(bytes.length);
    Module.HEAPU8.set(bytes, p);
    try { return fn(p, bytes.length); } finally { Module._wasm_dealloc(p, bytes.length); }
  };

  Module._wasm_init_backend();
  const empty = readFileSync(path.join(__dirname, "empty.anki2"));
  withBuf(empty, (p, l) => Module._wasm_open_collection(p, l));

  const apkg = readFileSync(process.argv[2]);
  const rc = withBuf(apkg, (p, l) => Module._wasm_import_apkg(p, l));
  if (rc !== 0) { log("import FAILED", err()); process.exit(1); }
  log("imported", path.basename(process.argv[2]));

  const listNames = () => {
    if (Module._wasm_list_media_files() !== 0) { log("list FAILED", err()); process.exit(1); }
    return JSON.parse(resStr());
  };

  // baseline
  if (Module._wasm_check_media() !== 0) { log("check FAILED", err()); process.exit(1); }
  const base = JSON.parse(resStr());
  log(`baseline check -> unused=${base.unusedCount} missing=${base.missingCount} trash=${base.trashCount}`);
  log("baseline files:", listNames().length);

  // plant an unreferenced file
  const orphan = "cleananki_orphan_test.txt";
  const onb = Buffer.from(orphan, "utf8");
  const odata = Buffer.from("not referenced by any note", "utf8");
  const rcW = withBuf(onb, (np, nl) => withBuf(odata, (dp, dl) =>
    Module._wasm_write_media_file(np, nl, dp, dl)));
  if (rcW !== 0) { log("plant write FAILED", err()); process.exit(1); }
  log(`planted unreferenced file '${orphan}'`);

  // check again -> orphan must show up as unused
  if (Module._wasm_check_media() !== 0) { log("check2 FAILED", err()); process.exit(1); }
  const after = JSON.parse(resStr());
  log(`after-plant check -> unused=${after.unusedCount} (delta=${after.unusedCount - base.unusedCount})`);
  const orphanIsUnused = after.summary.includes(orphan);
  log(`summary mentions orphan: ${orphanIsUnused}`);
  if (after.unusedCount !== base.unusedCount + 1 || !orphanIsUnused) {
    log("FAIL: orphan not reported as unused"); process.exit(1);
  }

  // delete unused -> returns filenames, must include orphan
  if (Module._wasm_delete_unused_media() !== 0) { log("delete FAILED", err()); process.exit(1); }
  const deleted = JSON.parse(resStr());
  log(`deleted ${deleted.length} unused files; includes orphan: ${deleted.includes(orphan)}`);
  if (!deleted.includes(orphan)) { log("FAIL: orphan not deleted"); process.exit(1); }

  // orphan gone from media folder + check reports 0 unused
  const gone = !listNames().includes(orphan);
  if (Module._wasm_check_media() !== 0) { log("check3 FAILED", err()); process.exit(1); }
  const final = JSON.parse(resStr());
  log(`orphan removed from folder: ${gone}; final unused=${final.unusedCount}`);
  if (!gone || final.unusedCount !== 0) { log("FAIL: cleanup incomplete"); process.exit(1); }

  log("DONE (all assertions passed)");
}
main().catch((e) => { console.error("[check-media-test] FATAL:", e); process.exit(1); });
