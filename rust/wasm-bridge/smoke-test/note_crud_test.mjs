// Verifies the note-CRUD bridge exports end-to-end against a fresh collection:
//   wasm_get_basic_notetype_info, wasm_add_basic_note, wasm_list_notes_in_deck,
//   wasm_get_note, wasm_update_note_fields.
// Scenario: open empty.anki2, create a deck, read the Basic notetype's real
// field names, add a note into the deck, list the deck's notes and confirm it
// shows up, get the note by id and confirm its fields round-trip, update a
// field and confirm the change persists on a fresh get.
// Usage: node note_crud_test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[note-crud-test]", ...a);
const fail = (msg) => { log("FAIL:", msg); process.exit(1); };

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
  const enc = (s) => Buffer.from(s, "utf8");

  Module._wasm_init_backend();
  const empty = readFileSync(path.join(__dirname, "empty.anki2"));
  if (withBuf(empty, (p, l) => Module._wasm_open_collection(p, l)) !== 0) {
    fail("open_collection: " + err());
  }
  log("opened empty.anki2");

  // --- create a deck to hold the notes --------------------------------------
  if (withBuf(enc("Note CRUD Test"), (p, l) => Module._wasm_create_deck(p, l)) !== 0) {
    fail("create_deck: " + err());
  }
  const deckId = BigInt(JSON.parse(resStr()));
  log("created deck id", deckId.toString());

  // --- Basic notetype info --------------------------------------------------
  if (Module._wasm_get_basic_notetype_info() !== 0) fail("get_basic_notetype_info: " + err());
  const ntInfo = JSON.parse(resStr());
  log("Basic notetype:", JSON.stringify(ntInfo));
  if (typeof ntInfo.notetypeId !== "string" || !/^\d+$/.test(ntInfo.notetypeId)) {
    fail("notetypeId not a numeric string: " + ntInfo.notetypeId);
  }
  if (!Array.isArray(ntInfo.fieldNames) || ntInfo.fieldNames.length < 2) {
    fail("expected >=2 field names for Basic, got " + JSON.stringify(ntInfo.fieldNames));
  }
  log("field names:", ntInfo.fieldNames.join(", "));

  // --- add a note -----------------------------------------------------------
  const front = "capital of France?";
  const back = "Paris";
  const addFields = enc(JSON.stringify([front, back]));
  if (withBuf(addFields, (p, l) => Module._wasm_add_basic_note(deckId, p, l)) !== 0) {
    fail("add_basic_note: " + err());
  }
  const noteId = BigInt(JSON.parse(resStr()));
  log("added note id", noteId.toString());

  // wrong field count must be rejected (not silently truncated)
  const badFields = enc(JSON.stringify([front]));
  if (withBuf(badFields, (p, l) => Module._wasm_add_basic_note(deckId, p, l)) === 0) {
    fail("add_basic_note accepted a wrong-length field array");
  }
  log("wrong-length add rejected as expected:", err());

  // --- list notes in the deck -----------------------------------------------
  if (Module._wasm_list_notes_in_deck(deckId) !== 0) fail("list_notes_in_deck: " + err());
  const notes = JSON.parse(resStr());
  log(`listed ${notes.length} note(s)`);
  if (notes.length !== 1) fail("expected exactly 1 note, got " + notes.length);
  if (notes[0].noteId !== noteId.toString()) {
    fail(`listed noteId ${notes[0].noteId} != added ${noteId}`);
  }
  if (notes[0].preview !== front) {
    fail(`preview ${JSON.stringify(notes[0].preview)} != first field ${JSON.stringify(front)}`);
  }
  log("preview matches first field:", notes[0].preview);

  // --- get the note by id ---------------------------------------------------
  if (Module._wasm_get_note(noteId) !== 0) fail("get_note: " + err());
  const detail = JSON.parse(resStr());
  log("get_note:", JSON.stringify(detail));
  if (detail.noteId !== noteId.toString()) fail("get_note noteId mismatch");
  if (detail.notetypeId !== ntInfo.notetypeId) fail("get_note notetypeId mismatch");
  if (detail.fieldNames.length !== detail.fields.length) {
    fail("fieldNames/fields length mismatch");
  }
  if (detail.fields[0] !== front || detail.fields[1] !== back) {
    fail("fields did not round-trip: " + JSON.stringify(detail.fields));
  }
  log("fields round-trip OK");

  // --- update a field -------------------------------------------------------
  const newBack = "Paris (France)";
  const updFields = enc(JSON.stringify([front, newBack]));
  if (withBuf(updFields, (p, l) => Module._wasm_update_note_fields(noteId, p, l)) !== 0) {
    fail("update_note_fields: " + err());
  }
  log("updated note field");

  // wrong field count must be rejected
  const updBad = enc(JSON.stringify([front, newBack, "extra"]));
  if (withBuf(updBad, (p, l) => Module._wasm_update_note_fields(noteId, p, l)) === 0) {
    fail("update_note_fields accepted a wrong-length field array");
  }
  log("wrong-length update rejected as expected:", err());

  // --- confirm the update persists on a fresh get ---------------------------
  if (Module._wasm_get_note(noteId) !== 0) fail("get_note (after update): " + err());
  const detail2 = JSON.parse(resStr());
  if (detail2.fields[1] !== newBack) {
    fail("update did not persist: " + JSON.stringify(detail2.fields));
  }
  if (detail2.fields[0] !== front) {
    fail("update clobbered an unchanged field: " + JSON.stringify(detail2.fields));
  }
  log("update persisted:", detail2.fields[1]);

  log("DONE (all assertions passed)");
}
main().catch((e) => { console.error("[note-crud-test] FATAL:", e); process.exit(1); });
