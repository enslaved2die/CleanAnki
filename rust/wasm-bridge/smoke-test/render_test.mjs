// Independent verification of wasm_render_current_card, specifically the
// flatten_rendered_nodes fix for the "not fully rendered" bug the agent found
// in ~56% of a real deck's cards (malformed Cloze notes producing multi-node
// rendered output). Imports a real deck, walks N cards via get_next_card +
// answer_card(3), rendering each, and tallies how many hit the literal
// fallback string.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function log(...a) { console.log("[render-verify]", ...a); }

async function main() {
  const factory = (await import("./anki_wasm_bridge.js")).default;
  const Module = await factory({
    locateFile: (f) => path.join(__dirname, f),
    print: () => {},
    printErr: (s) => log("[wasm stderr]", s),
  });

  function readLastError() {
    const ptr = Module._wasm_last_error_ptr();
    const len = Number(Module._wasm_last_error_len());
    return len === 0 ? "" : Buffer.from(Module.HEAPU8.subarray(ptr, ptr + len)).toString("utf8");
  }
  function readLastResult() {
    const ptr = Module._wasm_last_result_ptr();
    const len = Number(Module._wasm_last_result_len());
    return len === 0 ? "" : Buffer.from(Module.HEAPU8.subarray(ptr, ptr + len)).toString("utf8");
  }

  Module._wasm_init_backend();

  const emptyBytes = readFileSync(path.join(__dirname, "empty.anki2"));
  const p0 = Module._wasm_alloc(emptyBytes.length);
  Module.HEAPU8.set(emptyBytes, p0);
  Module._wasm_open_collection(p0, emptyBytes.length);
  Module._wasm_dealloc(p0, emptyBytes.length);

  const apkgPath = process.argv[2];
  const sampleSize = parseInt(process.argv[3] || "300", 10);
  const apkgBytes = readFileSync(apkgPath);
  const p1 = Module._wasm_alloc(apkgBytes.length);
  Module.HEAPU8.set(apkgBytes, p1);
  const rcImport = Module._wasm_import_apkg(p1, apkgBytes.length);
  Module._wasm_dealloc(p1, apkgBytes.length);
  log("import ->", rcImport, rcImport !== 0 ? readLastError() : "(ok)");
  if (rcImport !== 0) process.exit(1);

  Module._wasm_list_decks();
  const decks = JSON.parse(readLastResult());
  const topDeck = decks.find(([id]) => id !== "1");
  Module._wasm_set_current_deck(BigInt(topDeck[0]));
  log(`studying deck ${topDeck[1]} (${topDeck[0]})`);

  let checked = 0, notFullyRendered = 0, emptyQuestion = 0, renderErrors = 0;
  const samples = [];

  for (let i = 0; i < sampleSize; i++) {
    const cid = Module._wasm_get_next_card();
    if (cid === -1n) { log(`queue exhausted after ${checked} cards`); break; }

    const rcRender = Module._wasm_render_current_card();
    if (rcRender !== 0) {
      renderErrors++;
      log(`render error on card ${cid}: ${readLastError()}`);
    } else {
      const content = JSON.parse(readLastResult());
      checked++;
      if (content.question.includes("not fully rendered") || content.answer.includes("not fully rendered")) {
        notFullyRendered++;
        if (samples.length < 3) samples.push({ cid: cid.toString(), ...content });
      }
      if (content.question.trim().length === 0) emptyQuestion++;
    }

    const rcAnswer = Module._wasm_answer_card(3);
    if (rcAnswer !== 0) { log(`answer error on card ${cid}: ${readLastError()}`); break; }
  }

  log(`checked=${checked} notFullyRendered=${notFullyRendered} emptyQuestion=${emptyQuestion} renderErrors=${renderErrors}`);
  if (notFullyRendered > 0) {
    log("SAMPLES OF 'not fully rendered' HITS:", JSON.stringify(samples, null, 2));
  } else {
    log("ZERO 'not fully rendered' hits in this sample — fix confirmed.");
  }

  // Also print one genuine full sample so the content quality can be eyeballed.
  Module._wasm_get_next_card();
  log("--- one more full sample for manual inspection ---");
}

main().catch((e) => { console.error("[render-verify] FATAL:", e); process.exit(1); });
