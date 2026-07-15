//! Emits the emcc flags needed to turn this crate's final link into a real
//! JS-loadable Emscripten module (an ES module factory + its `.wasm`),
//! instead of a bare `.wasm` with no JS glue.
//!
//! These are deliberately emitted from *here* (via `cargo:rustc-link-arg`,
//! which Cargo scopes to only this package's own bin/cdylib/test link step)
//! rather than via a blanket `RUSTFLAGS=-C link-arg=...` in build.sh. Plain
//! RUSTFLAGS applies to *every* rustc invocation in the whole dependency
//! graph, and some dependencies (e.g. reqwest's `wasm-streams`, which itself
//! declares a `cdylib` output for its own wasm-bindgen use) got linked with
//! our flags too, which broke their build:
//!   `emcc: error: undefined exported symbol: "_main"`
//! (because MODULARIZE + our EXPORTED_FUNCTIONS list implies an executable
//! link expecting a `main`, and that dependency's cdylib has neither `main`
//! nor any of the symbols we listed). See docs/ARCHITECTURE.md (2026-07-10 §7).

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("emscripten") {
        return;
    }

    // MODULARIZE wraps the whole runtime in a factory function instead of
    // dumping globals, which is what lets us load it as a self-contained unit.
    //
    // Deliberately NOT using -sEXPORT_ES6=1 (an earlier attempt did, and it
    // works fine in Node) — under Vite's dev server, an ES-module glue file
    // living in web/public/ cannot be loaded via dynamic `import()` from our
    // own source: Vite's dev middleware intercepts *any* request for a
    // JS/ESM-shaped file and refuses to serve public/ files through its
    // module-transform pipeline at all:
    //   "Failed to load url /wasm/anki_wasm_bridge.js ... This file is in
    //    /public and will be copied as-is during build without going through
    //    the plugin transforms, and therefore should not be imported from
    //    source code. It can only be referenced via HTML tags."
    // A classic (non-ESM) MODULARIZE build produces a plain script that
    // exports its factory as a global (name set by EXPORT_NAME below) when
    // loaded via an ordinary `<script>` tag — exactly like any other static
    // asset (a favicon, an image) — which never touches Vite's module graph
    // at all. See docs/ARCHITECTURE.md §8.
    println!("cargo:rustc-link-arg=-sMODULARIZE=1");
    println!("cargo:rustc-link-arg=-sEXPORT_NAME=AnkiWasmBridgeModule");

    // i64 params/returns (we return card ids as i64 from wasm_get_next_card)
    // marshal as native JS BigInt instead of emscripten's legacy two-i32
    // legalization trick.
    println!("cargo:rustc-link-arg=-sWASM_BIGINT=1");

    // Keep our wasm_* exports (plus the trivial `_main`) alive through emcc's
    // dead-code elimination; nothing else needs to be reachable from JS.
    let exported_functions = [
        "_main",
        "_wasm_alloc",
        "_wasm_dealloc",
        "_wasm_last_error_ptr",
        "_wasm_last_error_len",
        "_wasm_last_result_ptr",
        "_wasm_last_result_len",
        "_wasm_init_backend",
        "_wasm_open_collection",
        "_wasm_checkpoint",
        "_wasm_checkpoint_media_db",
        "_wasm_import_apkg",
        "_wasm_list_decks",
        "_wasm_set_current_deck",
        "_wasm_delete_deck",
        "_wasm_get_deck_tree",
        "_wasm_create_deck",
        "_wasm_get_basic_notetype_info",
        "_wasm_add_basic_note",
        "_wasm_list_notes_in_deck",
        "_wasm_get_note",
        "_wasm_update_note_fields",
        "_wasm_get_stats",
        "_wasm_reset_progress",
        "_wasm_list_media_files",
        "_wasm_read_media_file",
        "_wasm_write_media_file",
        "_wasm_check_media",
        "_wasm_delete_unused_media",
        "_wasm_get_next_card",
        "_wasm_render_current_card",
        "_wasm_answer_card",
        "_wasm_sync_login",
        "_wasm_sync_collection",
        "_wasm_sync_full_download",
        "_wasm_sync_full_upload",
        "_wasm_sync_media",
        "_wasm_sync_poll",
        "_wasm_sync_progress_json",
    ];
    let list = exported_functions
        .iter()
        .map(|f| format!("'{f}'"))
        .collect::<Vec<_>>()
        .join(",");
    println!("cargo:rustc-link-arg=-sEXPORTED_FUNCTIONS=[{list}]");

    // By default the returned Module object exposes only our EXPORTED_FUNCTIONS
    // — no memory view, so JS has no way to read/write the buffers our
    // wasm_alloc/wasm_open_collection functions expect. HEAPU8 is emscripten's
    // live Uint8Array view over the wasm memory (rebound automatically on
    // growth); exporting it lets JS do `Module.HEAPU8.set(bytes, ptr)`.
    //
    // FS is emscripten's virtual-filesystem convenience object. The bridge
    // (src/main.rs, COLLECTION_PATH) writes the opened collection to
    // `/anki/collection.anki2` on MEMFS via plain `std::fs::write`; nothing
    // in our own `wasm_*` exports reads it back out, so the *browser* side
    // (for OPFS persistence — see web/src/wasm/backend.ts) needs
    // `Module.FS.readFile('/anki/collection.anki2')` to pull the current
    // bytes back out after `wasm_open_collection`/`wasm_answer_card`.
    println!("cargo:rustc-link-arg=-sEXPORTED_RUNTIME_METHODS=['HEAPU8','FS']");

    // 2026-07-10: Emscripten's default wasm stack is only 64KB. That was
    // enough for the scheduler-only surface (open/get_next_card/answer_card),
    // but `wasm_import_apkg` reliably crashed with either
    // "RuntimeError: function signature mismatch" or
    // "RuntimeError: memory access out of bounds" deep inside SQLite's
    // recursive-descent SQL parser (`sqlite3RunParser`/`yy_reduce` calling
    // into `sqlite3Select`/`sqlite3GenerateColumnNames`/etc) — a classic wasm
    // stack-overflow signature: the parser's C stack frames plus our own Rust
    // frames overran the 64KB stack and corrupted adjacent linear memory
    // (which is where wasm's stack pointer lives), so the specific symptom
    // (which function looked "wrong", which pointer looked "garbage")
    // shifted between builds/opt-levels depending on exactly what got
    // clobbered. Root-caused by rebuilding with `-C debuginfo=1` +
    // `EMCC_CFLAGS=... -g` for named stack traces (see docs/ARCHITECTURE.md
    // §10 for the full diagnostic trail — several other flags were tried and
    // ruled out first: full LTO, opt-level, SQLITE_THREADSAFE, and
    // SQLITE_ENABLE_MEMORY_MANAGEMENT were all red herrings). Confirmed fixed
    // by bumping the stack; 4MB is generous headroom over whatever the real
    // minimum is — untuned, deliberately not cutting it close.
    println!("cargo:rustc-link-arg=-sSTACK_SIZE=4194304");

    // Link Emscripten's native `emscripten_fetch` HTTP implementation
    // (system/lib/fetch). This is the transport used by the sync exports:
    // reqwest's own wasm `.send()` needs wasm-bindgen JS glue this build never
    // produces (see docs/ARCHITECTURE.md §17), so all sync HTTP I/O goes
    // through synchronous `emscripten_fetch` on a background pthread instead.
    println!("cargo:rustc-link-arg=-sFETCH=1");
}
