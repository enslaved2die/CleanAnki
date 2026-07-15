// Verifies the media tracking database (collection.mdb) persistence fix:
// checkpointing it, reading it back out of the virtual FS, and restoring it
// into a *fresh* wasm instance (simulating a new browser session/reload)
// produces bytes sqlite can actually reopen — the property `persistMediaDb`/
// `restoreMediaDbToBackend` (web/src/db/collection.ts) depend on. Also
// confirms `wasm_checkpoint_media_db` is a harmless no-op-creating call on a
// collection that has never touched media at all.
//
// Usage: node media_db_persist_test.mjs <path-to-media.apkg>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[media-db-persist-test]", ...a);

async function makeInstance() {
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

  return { Module, err, withBuf };
}

async function main() {
  // --- Instance 0: a fresh collection that has never touched media at all.
  // wasm_checkpoint_media_db must be a harmless no-op-creating call here (it
  // opens-or-creates the db purely to run the checkpoint pragma), never an
  // error — otherwise the very first call ever made in a real session (right
  // after ensureCollectionReady's restore, before any import/sync) would
  // throw.
  {
    const { Module, err } = await makeInstance();
    const rc = Module._wasm_checkpoint_media_db();
    log(`checkpoint on virgin collection (no prior media op) -> rc=${rc}`, rc !== 0 ? err() : "(ok)");
    if (rc !== 0) process.exit(1);
  }

  // --- Instance 1: import a real apkg with media, which registers the
  // imported files into collection.mdb (see import_export/package/apkg's use
  // of Collection::media()).
  const inst1 = await makeInstance();
  const apkg = readFileSync(process.argv[2]);
  const rcImport = inst1.withBuf(apkg, (p, l) => inst1.Module._wasm_import_apkg(p, l));
  log(`import -> rc=${rcImport}`, rcImport !== 0 ? inst1.err() : "");
  if (rcImport !== 0) process.exit(1);

  const rcCp1 = inst1.Module._wasm_checkpoint_media_db();
  log(`checkpoint after import -> rc=${rcCp1}`, rcCp1 !== 0 ? inst1.err() : "");
  if (rcCp1 !== 0) process.exit(1);

  const mdbBytes = new Uint8Array(inst1.Module.FS.readFile("/anki/collection.mdb"));
  const magic = Buffer.from(mdbBytes.slice(0, 16)).toString("latin1");
  log(`collection.mdb after import+checkpoint: ${mdbBytes.length} bytes, header="${magic.replace(/\0/g, "\\0")}"`);
  if (mdbBytes.length === 0) { log("FAIL: mdb is empty after an import that should have registered media"); process.exit(1); }
  if (!magic.startsWith("SQLite format 3")) { log("FAIL: mdb does not look like a sqlite file"); process.exit(1); }

  // Also grab the media files themselves (persistMedia's job in the real
  // app) so instance 2 has a *consistent* folder + db pair to restore, same
  // as restoreMediaToBackend + restoreMediaDbToBackend both running before a
  // real sync.
  const rcList = inst1.Module._wasm_list_media_files();
  if (rcList !== 0) { log("list FAILED", inst1.err()); process.exit(1); }
  const resStr1 = () => {
    const p = inst1.Module._wasm_last_result_ptr(), l = Number(inst1.Module._wasm_last_result_len());
    return l === 0 ? "" : Buffer.from(inst1.Module.HEAPU8.subarray(p, p + l)).toString("utf8");
  };
  const names = JSON.parse(resStr1());
  const files = names.map((name) => {
    const nb = Buffer.from(name, "utf8");
    inst1.withBuf(nb, (p, l) => inst1.Module._wasm_read_media_file(p, l));
    const p = inst1.Module._wasm_last_result_ptr(), l = Number(inst1.Module._wasm_last_result_len());
    return [name, Buffer.from(inst1.Module.HEAPU8.subarray(p, p + l))];
  });
  log(`captured ${files.length} media file(s) to restore: ${names.join(", ")}`);

  // --- Instance 2: a brand-new wasm instance (fresh MEMFS) simulating a page
  // reload. Restore the media db bytes + media files *before* anything else
  // touches media, exactly as ensureCollectionReady/syncMediaAfterCollectionSync
  // do, then confirm sqlite can actually reopen the restored db.
  const inst2 = await makeInstance();
  inst2.Module.FS.writeFile("/anki/collection.mdb", mdbBytes);
  for (const [name, data] of files) {
    const nb = Buffer.from(name, "utf8");
    inst2.withBuf(nb, (np, nl) => inst2.withBuf(data, (dp, dl) =>
      inst2.Module._wasm_write_media_file(np, nl, dp, dl)));
  }

  const rcCp2 = inst2.Module._wasm_checkpoint_media_db();
  log(`checkpoint on restored db in fresh instance -> rc=${rcCp2}`, rcCp2 !== 0 ? inst2.err() : "(ok — sqlite reopened the restored file successfully)");
  if (rcCp2 !== 0) {
    log("FAIL: restored collection.mdb bytes did not reopen as a valid sqlite database");
    process.exit(1);
  }

  const mdbBytes2 = new Uint8Array(inst2.Module.FS.readFile("/anki/collection.mdb"));
  log(`collection.mdb in fresh instance after restore+checkpoint: ${mdbBytes2.length} bytes`);

  log("DONE — collection.mdb round-trips through checkpoint -> OPFS-style byte copy -> restore in a fresh instance -> reopens cleanly");
}
main().catch((e) => { console.error("[media-db-persist-test] FATAL:", e); process.exit(1); });
