// REPRO for the "reload shows starter card" bug.
//
// Faithfully mimics the browser flow:
//   SESSION (instance A): init -> open starter (has "smoke-test" card in Default
//     deck) -> import real .apkg (creates a Spanish deck) -> set_current_deck(Spanish)
//     -> read /anki/collection.anki2 back out (== persistCollection's FS.readFile).
//   RELOAD (fresh instance B): init -> write ONLY those persisted main-file bytes
//     into a fresh MEMFS (no -wal sidecar, exactly like a browser reload where
//     MEMFS is wiped and only the OPFS main file survives) -> open -> get_next_card
//     -> render -> is the question "smoke-test ..." (BUG) or a real Spanish card?
//
// Usage: node repro_wal.mjs <path-to.apkg> [iterations]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[repro]", ...a);

async function newInstance() {
  const factory = (await import("./anki_wasm_bridge.js")).default;
  return factory({
    locateFile: (f) => path.join(__dirname, f),
    print: () => {},
    printErr: () => {},
  });
}

function helpers(M) {
  const err = () => {
    const p = M._wasm_last_error_ptr(), l = Number(M._wasm_last_error_len());
    return l === 0 ? "" : Buffer.from(M.HEAPU8.subarray(p, p + l)).toString("utf8");
  };
  const resStr = () => {
    const p = M._wasm_last_result_ptr(), l = Number(M._wasm_last_result_len());
    return l === 0 ? "" : Buffer.from(M.HEAPU8.subarray(p, p + l)).toString("utf8");
  };
  const withBuf = (bytes, fn) => {
    const p = M._wasm_alloc(bytes.length);
    M.HEAPU8.set(bytes, p);
    try { return fn(p, bytes.length); } finally { M._wasm_dealloc(p, bytes.length); }
  };
  return { err, resStr, withBuf };
}

const COLLECTION_PATH = "/anki/collection.anki2";
const starter = readFileSync(path.join(__dirname, "with_note.anki2"));

async function session(apkgBytes, doCheckpoint) {
  const M = await newInstance();
  const { err, resStr, withBuf } = helpers(M);
  if (M._wasm_init_backend() !== 0) throw new Error("init: " + err());
  if (withBuf(starter, (p, l) => M._wasm_open_collection(p, l)) !== 0) throw new Error("open: " + err());
  if (withBuf(apkgBytes, (p, l) => M._wasm_import_apkg(p, l)) !== 0) throw new Error("import: " + err());

  M._wasm_list_decks();
  const decks = JSON.parse(resStr());
  const spanish = decks.find(([id]) => id !== "1");
  if (!spanish) throw new Error("no non-default deck after import");
  if (M._wasm_set_current_deck(BigInt(spanish[0])) !== 0) throw new Error("set_current_deck: " + err());

  // live sanity: what does the live (still-open) connection think is next?
  const liveId = M._wasm_get_next_card();
  M._wasm_render_current_card();
  const liveQ = JSON.parse(resStr()).question.replace(/\s+/g, " ").slice(0, 40);

  // How much is stranded in the WAL sidecar right now?
  let walBefore = 0;
  try { walBefore = M.FS.readFile(COLLECTION_PATH + "-wal").length; } catch { walBefore = 0; }

  // THE FIX: readCollectionBytes() now calls _wasm_checkpoint() before reading,
  // flushing the WAL into the main file. Toggle to compare before/after.
  if (doCheckpoint) {
    const cp = M._wasm_checkpoint();
    if (cp !== 0) throw new Error("checkpoint: " + err());
  }
  let walAfter = 0;
  try { walAfter = M.FS.readFile(COLLECTION_PATH + "-wal").length; } catch { walAfter = 0; }

  // persistCollection(): read the MAIN db file back out (this is exactly what
  // web/src/wasm/backend.ts readCollectionBytes does).
  const persisted = Buffer.from(M.FS.readFile(COLLECTION_PATH));

  return { persisted, spanishDeck: spanish, liveId, liveQ, walBefore, walAfter, mainSize: persisted.length };
}

async function reload(persisted) {
  const M = await newInstance();
  const { err, resStr, withBuf } = helpers(M);
  if (M._wasm_init_backend() !== 0) throw new Error("reload init: " + err());
  // Fresh MEMFS: only the persisted MAIN file exists, no -wal (browser reload).
  if (withBuf(persisted, (p, l) => M._wasm_open_collection(p, l)) !== 0)
    throw new Error("reload open: " + err());
  const id = M._wasm_get_next_card();
  let q = "(none)";
  if (id >= 0n && M._wasm_render_current_card() === 0) {
    q = JSON.parse(resStr()).question.replace(/\s+/g, " ").slice(0, 40);
  }
  // what deck does it think is current? infer from whether the card is the starter
  return { id, q, isStarter: /smoke-test/i.test(q) };
}

async function main() {
  const apkgPath = process.argv[2];
  if (!apkgPath) throw new Error("usage: node repro_wal.mjs <path-to.apkg> [iterations]");
  const iterations = parseInt(process.argv[3] || "1", 10);
  // arg 4: "checkpoint" to simulate the fix, anything else / omitted = baseline
  const doCheckpoint = (process.argv[4] || "") === "checkpoint";
  const apkgBytes = readFileSync(apkgPath);
  log(`apkg=${apkgPath} (${apkgBytes.length} bytes), iterations=${iterations}, checkpoint=${doCheckpoint}`);

  let bug = 0;
  for (let i = 0; i < iterations; i++) {
    const s = await session(apkgBytes, doCheckpoint);
    const r = await reload(s.persisted);
    const verdict = r.isStarter ? "BUG (starter card)" : "ok (real card)";
    if (r.isStarter) bug++;
    log(
      `#${i}: live[id=${s.liveId} q="${s.liveQ}"] wal(before=${s.walBefore}B after=${s.walAfter}B) ` +
      `main=${s.mainSize}B => reload[id=${r.id} q="${r.q}"] ${verdict}`,
    );
  }
  log(`RESULT: ${bug}/${iterations} reloads showed the starter card (${((bug / iterations) * 100).toFixed(0)}% failure), checkpoint=${doCheckpoint}`);
}

main().catch((e) => { console.error("[repro] FATAL:", e); process.exit(1); });
