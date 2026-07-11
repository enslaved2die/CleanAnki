// Verifies the media-file bridge exports (wasm_list_media_files /
// wasm_read_media_file / wasm_write_media_file) against a real .apkg with
// media, and that wasm_render_current_card no longer strips [sound:...] tags.
// Usage: node media_test.mjs <path-to.apkg> [sampleCards]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[media-test]", ...a);

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
  const resBytes = () => {
    const p = Module._wasm_last_result_ptr(), l = Number(Module._wasm_last_result_len());
    return Buffer.from(Module.HEAPU8.subarray(p, p + l));
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
  const t0 = performance.now();
  const rc = withBuf(apkg, (p, l) => Module._wasm_import_apkg(p, l));
  log(`import -> ${rc} in ${(performance.now() - t0).toFixed(0)}ms`, rc !== 0 ? err() : "");
  if (rc !== 0) process.exit(1);

  // list media
  const rcList = Module._wasm_list_media_files();
  if (rcList !== 0) { log("list FAILED", err()); process.exit(1); }
  const names = JSON.parse(resStr());
  log(`media files: ${names.length}`, names.slice(0, 8));

  // read the first media file, verify non-empty + round-trips via write
  if (names.length > 0) {
    const name = names[0];
    const nb = Buffer.from(name, "utf8");
    const tRead = performance.now();
    const rcRead = withBuf(nb, (p, l) => Module._wasm_read_media_file(p, l));
    if (rcRead !== 0) { log("read FAILED", err()); process.exit(1); }
    const bytes = resBytes();
    log(`read '${name}' -> ${bytes.length} bytes in ${(performance.now() - tRead).toFixed(1)}ms`);

    // write it back under a new name, then read again to confirm equality
    const copyName = "roundtrip_" + name;
    const cnb = Buffer.from(copyName, "utf8");
    const rcWrite = withBuf(cnb, (np, nl) => withBuf(bytes, (dp, dl) =>
      Module._wasm_write_media_file(np, nl, dp, dl)));
    if (rcWrite !== 0) { log("write FAILED", err()); process.exit(1); }
    const rcRead2 = withBuf(cnb, (p, l) => Module._wasm_read_media_file(p, l));
    const bytes2 = resBytes();
    log(`write+reread '${copyName}' -> ${bytes2.length} bytes, equal=${Buffer.compare(bytes, bytes2) === 0}`);

    // read a nonexistent file -> should error
    const missing = Buffer.from("__nope__.xyz", "utf8");
    const rcMiss = withBuf(missing, (p, l) => Module._wasm_read_media_file(p, l));
    log(`read missing -> rc=${rcMiss} (expected negative), err="${rcMiss !== 0 ? err() : ""}"`);
  }

  // Bulk read timing (proxy for persist-to-OPFS read cost): read every file.
  const tBulk = performance.now();
  let totalBytes = 0;
  for (const name of names) {
    const nb = Buffer.from(name, "utf8");
    withBuf(nb, (p, l) => Module._wasm_read_media_file(p, l));
    totalBytes += Number(Module._wasm_last_result_len());
  }
  log(`read ALL ${names.length} files (${(totalBytes / 1e6).toFixed(1)}MB) in ${(performance.now() - tBulk).toFixed(0)}ms`);

  // Bulk write timing (proxy for restore-to-MEMFS cost): write each back.
  const tWrite = performance.now();
  for (const name of names) {
    const nb = Buffer.from(name, "utf8");
    withBuf(nb, (p, l) => Module._wasm_read_media_file(p, l));
    const data = resBytes();
    const wn = Buffer.from("w_" + name, "utf8");
    withBuf(wn, (np, nl) => withBuf(data, (dp, dl) => Module._wasm_write_media_file(np, nl, dp, dl)));
  }
  log(`write ALL ${names.length} files back in ${(performance.now() - tWrite).toFixed(0)}ms`);

  // Confirm [sound:...] survives rendering now (find a card with audio)
  Module._wasm_list_decks();
  const decks = JSON.parse(resStr());
  const top = decks.find(([id]) => id !== "1") || decks[0];
  Module._wasm_set_current_deck(BigInt(top[0]));
  const sample = parseInt(process.argv[3] || "60", 10);
  let sound = 0, img = 0, checked = 0;
  for (let i = 0; i < sample; i++) {
    const cid = Module._wasm_get_next_card();
    if (cid === -1n) break;
    if (Module._wasm_render_current_card() === 0) {
      const c = JSON.parse(resStr());
      checked++;
      const all = c.question + c.answer;
      if (/\[sound:/.test(all)) sound++;
      if (/<img\s/i.test(all)) img++;
      if (sound === 1 && /\[sound:/.test(all)) log("sample with audio:", all.match(/\[sound:[^\]]+\]/)[0]);
      if (img === 1 && /<img\s/i.test(all)) log("sample with image:", (all.match(/<img[^>]*>/i) || [])[0]);
    }
    Module._wasm_answer_card(3);
  }
  log(`rendered ${checked} cards: ${sound} had [sound:], ${img} had <img>`);
  log("DONE");
}
main().catch((e) => { console.error("[media-test] FATAL:", e); process.exit(1); });
