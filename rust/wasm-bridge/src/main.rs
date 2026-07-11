//! Phase 1 spike bridge: exposes a hair-thin slice of Anki's real `rslib`
//! backend (crate name = `anki`) to JavaScript, compiled as an Emscripten
//! *main module* executable (not a cdylib) so `emcc` emits its own JS glue
//! (`-s MODULARIZE=1 -s EXPORT_ES6=1`) instead of a bare side-module `.wasm`.
//!
//! wasm-bindgen was dropped entirely: its CLI does not process Emscripten
//! output (it targets `wasm32-unknown-unknown`), so its `__wbindgen_describe_*`
//! exports were dead weight that nothing could ever consume. Every entry
//! point below is a plain `#[no_mangle] pub extern "C" fn` operating on raw
//! pointers/lengths into wasm linear memory, per the standard Emscripten
//! "manual marshalling" pattern:
//!   - JS calls `wasm_alloc(len) -> ptr`, writes bytes into `Module.HEAPU8`
//!     at `ptr`, then calls the real function with `(ptr, len)`.
//!   - JS calls `wasm_dealloc(ptr, len)` when done with a buffer it allocated.
//!   - Simple scalars (status codes, the i64 card id) are returned directly.
//!   - On error, functions return a negative status code and the caller can
//!     read `wasm_last_error_ptr()`/`wasm_last_error_len()` for a UTF-8 message
//!     (valid only until the next call that might overwrite it).
//!
//! See docs/ARCHITECTURE.md (2026-07-10 §7) for the full design writeup and
//! the exact emcc flags used to produce a loadable `.wasm` + `.mjs` pair.
//!
//! The types and method names used here are the genuine ones, read from the
//! vendored `anki` source at tag `26.05`:
//!   - `anki::backend::Backend::new(tr: I18n, server: bool)`
//!   - `anki::collection::CollectionBuilder::new(path).build() -> Result<Collection>`
//!   - `Collection::get_next_card(&mut self) -> Result<Option<QueuedCard>>`
//!   - `Collection::answer_card(&mut self, &mut CardAnswer) -> Result<OpOutput<()>>`
//!   - `CardAnswer { card_id, current_state, new_state, rating, answered_at,
//!                   milliseconds_taken, custom_data, from_queue }`
//!   - `Rating { Again, Hard, Good, Easy }`

use std::sync::Mutex;
use std::sync::OnceLock;

use anki::backend::Backend;
use anki::collection::Collection;
use anki::collection::CollectionBuilder;
use anki::import_export::package::ImportAnkiPackageOptions;
use anki::prelude::CardId;
use anki::prelude::DeckId;
use anki::prelude::I18n;
use anki::scheduler::answering::CardAnswer;
use anki::scheduler::answering::Rating;
use anki::scheduler::queue::QueuedCard;
use anki::template::RenderedNode;
use anki::timestamp::TimestampMillis;
use anki::timestamp::TimestampSecs;
use anki_proto::decks::DeckTreeNode;

/// Where we stage the uploaded collection inside the (emscripten) virtual FS.
/// On wasm32-unknown-emscripten this is MEMFS by default; persisting across
/// reloads would require mounting IDBFS and calling FS.syncfs from JS.
const COLLECTION_PATH: &str = "/anki/collection.anki2";

/// Where an uploaded `.apkg` is staged before `wasm_import_apkg` hands it to
/// `Collection::import_apkg` (which wants a real file path — it opens the zip
/// itself). Removed again after the import attempt, success or failure.
const IMPORT_APKG_PATH: &str = "/anki/import.apkg";

/// The collection's media folder inside the (emscripten) virtual FS. rslib
/// derives this from `COLLECTION_PATH` via `col_path.with_extension("media")`
/// (see `CollectionBuilder::with_desktop_media_paths`, called in
/// `wasm_open_collection`), so for `/anki/collection.anki2` it is
/// `/anki/collection.media`. `import_apkg`'s own `MediaManager` writes imported
/// media files here; the media-file exports below read/write this same folder
/// so JS can shuttle them to/from OPFS (MEMFS is wiped on every page reload).
const MEDIA_FOLDER: &str = "/anki/collection.media";

// rslib's public API is `&mut self` methods on `Collection`, and free wasm
// functions have no receiver, so we stash process-global state. wasm is
// effectively single-threaded from the JS entry point (emscripten pthreads
// notwithstanding), so a plain Mutex is adequate for the spike.
static BACKEND: OnceLock<Backend> = OnceLock::new();
static COLLECTION: OnceLock<Mutex<Option<Collection>>> = OnceLock::new();
/// The most recently fetched card, kept so `answer_card` can reconstruct a
/// faithful `CardAnswer` (it needs the card's current + candidate next states).
static LAST_CARD: OnceLock<Mutex<Option<QueuedCard>>> = OnceLock::new();
/// UTF-8 bytes of the last error message, readable via `wasm_last_error_*`.
static LAST_ERROR: Mutex<Vec<u8>> = Mutex::new(Vec::new());
/// UTF-8 bytes of the last successful *result payload* (currently only
/// `wasm_list_decks`' JSON), readable via `wasm_last_result_*`. Deliberately a
/// separate buffer from `LAST_ERROR` — conflating "the error message" and "the
/// success payload" into one slot would let a caller that reads at the wrong
/// time mistake one for the other.
static LAST_RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn collection_slot() -> &'static Mutex<Option<Collection>> {
    COLLECTION.get_or_init(|| Mutex::new(None))
}

fn last_card_slot() -> &'static Mutex<Option<QueuedCard>> {
    LAST_CARD.get_or_init(|| Mutex::new(None))
}

fn set_last_error<E: std::fmt::Display>(e: E) {
    let msg = e.to_string();
    if let Ok(mut guard) = LAST_ERROR.lock() {
        *guard = msg.into_bytes();
    }
}

fn set_last_result(bytes: Vec<u8>) {
    if let Ok(mut guard) = LAST_RESULT.lock() {
        *guard = bytes;
    }
}

// ---------------------------------------------------------------------------
// Buffer management: JS allocates/frees wasm-linear-memory buffers through
// these instead of touching emscripten's own malloc/free, so the allocation
// is guaranteed to round-trip through Rust's allocator (matters for `dealloc`
// safety: we reconstruct a `Vec<u8>` with the exact `len` passed to `alloc`).
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    // SAFETY: capacity is exactly `len`; we immediately hand the pointer to
    // JS, which is expected to write exactly `len` bytes before any Rust code
    // reads them back as an initialized slice.
    unsafe {
        buf.set_len(len);
    }
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr`/`len` must be a pair previously returned by `wasm_alloc` (same len),
/// not yet freed.
#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

#[no_mangle]
pub extern "C" fn wasm_last_error_ptr() -> *const u8 {
    LAST_ERROR.lock().map(|g| g.as_ptr()).unwrap_or(std::ptr::null())
}

#[no_mangle]
pub extern "C" fn wasm_last_error_len() -> usize {
    LAST_ERROR.lock().map(|g| g.len()).unwrap_or(0)
}

/// Pointer to the last successful *result payload* written by a call that
/// documents one (currently only `wasm_list_decks`). Separate from
/// `wasm_last_error_ptr` — see `LAST_RESULT`'s doc comment for why.
#[no_mangle]
pub extern "C" fn wasm_last_result_ptr() -> *const u8 {
    LAST_RESULT.lock().map(|g| g.as_ptr()).unwrap_or(std::ptr::null())
}

#[no_mangle]
pub extern "C" fn wasm_last_result_len() -> usize {
    LAST_RESULT.lock().map(|g| g.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

/// Construct a `Backend`. Returns 0 on success, -1 if already initialised.
///
/// A real `Backend` needs an `I18n`. rslib also ships `anki::backend::init_backend(&[u8])`
/// which decodes a protobuf init message; we sidestep protobuf here and build
/// `I18n` directly with an English locale.
#[no_mangle]
pub extern "C" fn wasm_init_backend() -> i32 {
    let tr = I18n::new(&["en"]);
    // server = false: we are a client, not a sync server.
    let backend = Backend::new(tr, false);

    match BACKEND.set(backend) {
        Ok(()) => 0,
        Err(_) => {
            set_last_error("backend already initialised");
            -1
        }
    }
}

/// Open a collection from raw `.anki2`/`.anki21` (SQLite) bytes at
/// `ptr`/`len` (as written by JS after a `wasm_alloc` call).
/// Returns 0 on success, negative on error (see `wasm_last_error_*`).
///
/// rslib has no "open from memory buffer" entry point — `CollectionBuilder`
/// wants a filesystem path (or `::default()` for an anonymous in-memory DB that
/// can't be seeded from bytes). So we write the bytes into the emscripten
/// virtual FS and open that path. rusqlite's *bundled* SQLite (compiled from C
/// by emcc) then does the actual open.
///
/// # Safety
/// `ptr`/`len` must describe a valid, readable byte slice (e.g. from
/// `wasm_alloc` followed by a JS-side write of exactly `len` bytes).
#[no_mangle]
pub unsafe extern "C" fn wasm_open_collection(ptr: *const u8, len: usize) -> i32 {
    let db_bytes = std::slice::from_raw_parts(ptr, len);
    let tr = I18n::new(&["en"]);

    if let Some(parent) = std::path::Path::new(COLLECTION_PATH).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            set_last_error(e);
            return -1;
        }
    }
    if let Err(e) = std::fs::write(COLLECTION_PATH, db_bytes) {
        set_last_error(e);
        return -2;
    }

    let col = match CollectionBuilder::new(COLLECTION_PATH)
        .set_tr(tr)
        .set_server(false)
        // Derives `/anki/collection.media` (dir, created for us) and
        // `/anki/collection.mdb` from COLLECTION_PATH — the same convention
        // desktop Anki uses for a `foo.anki2` file. Without this,
        // `media_folder`/`media_db` default to an empty PathBuf (see
        // CollectionBuilder::build), and anything that calls
        // `Collection::media()` (import_apkg does) fails immediately with
        // "attempted media operation without media folder set".
        .with_desktop_media_paths()
        .build()
    {
        Ok(col) => col,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    match collection_slot().lock() {
        Ok(mut guard) => {
            *guard = Some(col);
            0
        }
        Err(_) => {
            set_last_error("internal lock poisoned");
            -4
        }
    }
}

/// Flush the SQLite WAL into the main `.anki2` file so the raw bytes read back
/// out of the virtual FS (by JS `readCollectionBytes` → persisted to OPFS) are
/// complete and self-contained.
///
/// rslib opens collections with `journal_mode = wal` + `locking_mode =
/// exclusive` (see `storage/sqlite.rs`), so mutating calls — `open_collection`,
/// `import_apkg`, `set_current_deck`, `answer_card`, `delete_deck` — write into
/// a `<COLLECTION_PATH>-wal` sidecar rather than the main file, and under
/// exclusive locking that sidecar is checkpointed only lazily. JS persists only
/// the main file to OPFS (the `-wal` sidecar lives on MEMFS, which is wiped on
/// every page reload), so without this flush anything still in the WAL is
/// silently lost on reload — the reopened collection reverts to an earlier
/// checkpointed state (e.g. current-deck falls back to Default, showing the
/// bundled starter card). This mirrors `Collection::maybe_backup`, which calls
/// `storage.checkpoint()` immediately before copying the DB for a backup.
///
/// Returns 0 on success, negative on error. `pragma wal_checkpoint(truncate)`
/// on an empty WAL is a harmless no-op, so calling this before every read-back
/// is safe even when nothing was mutated.
#[no_mangle]
pub extern "C" fn wasm_checkpoint() -> i32 {
    let guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_ref() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    match col.storage.checkpoint() {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(e);
            -3
        }
    }
}

// ---------------------------------------------------------------------------
// .apkg import + deck listing/selection
// ---------------------------------------------------------------------------

/// Imports an Anki package (`.apkg`, a zip) at `ptr`/`len` into the
/// already-open collection. Returns 0 on success, negative on error (see
/// `wasm_last_error_*`); in particular -1 if no collection is open yet.
///
/// `Collection::import_apkg` wants a real file path (it opens the zip itself
/// via `ZipArchive::new`), so — same trick as `wasm_open_collection` — the
/// uploaded bytes are staged at `IMPORT_APKG_PATH` on the virtual FS first,
/// then removed again once the import attempt finishes (success or failure).
///
/// Uses `ImportAnkiPackageOptions::default()`: notably `with_scheduling` is
/// `false` by default (protobuf bool default), so imported cards come in as
/// fresh/new rather than preserving the source deck's due dates/intervals —
/// a real behavioural choice, not an oversight; see docs/ARCHITECTURE.md §10.
///
/// # Safety
/// `ptr`/`len` must describe a valid, readable byte slice.
#[no_mangle]
pub unsafe extern "C" fn wasm_import_apkg(ptr: *const u8, len: usize) -> i32 {
    let apkg_bytes = std::slice::from_raw_parts(ptr, len);

    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -4;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    if let Err(e) = std::fs::write(IMPORT_APKG_PATH, apkg_bytes) {
        set_last_error(e);
        return -2;
    }

    let result = col.import_apkg(IMPORT_APKG_PATH, ImportAnkiPackageOptions::default());
    // Best-effort cleanup regardless of import outcome; a leftover staged
    // .apkg on MEMFS is harmless but there's no reason to keep it around.
    let _ = std::fs::remove_file(IMPORT_APKG_PATH);

    match result {
        Ok(_) => 0,
        Err(e) => {
            set_last_error(e);
            -3
        }
    }
}

/// Lists every deck (including the default deck, id 1) as a JSON array of
/// `[id_as_string, name]` pairs, e.g. `[["1","Default"],["1774646385007","Spanish 5000"]]`.
/// IDs are encoded as **strings**, not JSON numbers — they're i64s that can
/// exceed `Number.MAX_SAFE_INTEGER`'s exact range in JS/JSON, so the caller is
/// expected to parse them back into a `BigInt` on the JS side.
///
/// Returns 0 on success (read the JSON via `wasm_last_result_ptr/len`),
/// negative on error (see `wasm_last_error_*`).
#[no_mangle]
pub extern "C" fn wasm_list_decks() -> i32 {
    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    let decks = match col.get_all_deck_names(false) {
        Ok(d) => d,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    let pairs: Vec<[String; 2]> = decks
        .into_iter()
        .map(|(id, name)| [id.0.to_string(), name])
        .collect();

    match serde_json::to_vec(&pairs) {
        Ok(json) => {
            set_last_result(json);
            0
        }
        Err(e) => {
            set_last_error(e);
            -4
        }
    }
}

/// Selects the current deck (what `get_next_card`'s queue-building is scoped
/// to — see docs/ARCHITECTURE.md §9/§10 for why this matters: without ever
/// calling this, the bridge silently defaulted to the empty built-in
/// "Default" deck while real imported cards sat in a different deck).
/// Returns 0 on success, negative on error.
#[no_mangle]
pub extern "C" fn wasm_set_current_deck(deck_id: i64) -> i32 {
    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    match col.set_current_deck(DeckId(deck_id)) {
        Ok(_) => 0,
        Err(e) => {
            set_last_error(e);
            -3
        }
    }
}

/// Deletes a deck **and all of its child decks**, along with every card (and
/// any note left with no remaining cards) in all of them — this mirrors real
/// Anki's actual behaviour (`Collection::remove_decks_and_child_decks`
/// cascades to subdecks unconditionally; there is no "delete this deck only"
/// mode in rslib itself). The built-in "Default" deck (id 1) is special-cased
/// by rslib to be reset/renamed rather than truly removed, so deleting it is
/// harmless.
///
/// If the deleted deck was the current deck, `get_current_deck` (used by
/// `get_next_card`) already falls back to Default on its own the next time
/// it's called (`decks/current.rs`) — no extra handling needed here.
///
/// Returns 0 on success, negative on error.
#[no_mangle]
pub extern "C" fn wasm_delete_deck(deck_id: i64) -> i32 {
    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    match col.remove_decks_and_child_decks(&[DeckId(deck_id)]) {
        Ok(_) => 0,
        Err(e) => {
            set_last_error(e);
            -3
        }
    }
}

/// Hand-rolled JSON serialization of a `DeckTreeNode` (recursively, including
/// `children`), matching the manual-JSON style used elsewhere in this file
/// (see `wasm_list_decks`) rather than pulling in `serde::Serialize` for a
/// type we don't own. `deck_id` is written as a **string**, not a JSON number
/// — same reasoning as `wasm_list_decks`: it's an i64 that can exceed
/// `Number.MAX_SAFE_INTEGER`'s exact range in JS.
fn deck_tree_node_to_json(node: &DeckTreeNode) -> serde_json::Value {
    serde_json::json!({
        "deckId": node.deck_id.to_string(),
        "name": node.name,
        "newCount": node.new_count,
        "learnCount": node.learn_count,
        "reviewCount": node.review_count,
        "collapsed": node.collapsed,
        "filtered": node.filtered,
        "children": node.children.iter().map(deck_tree_node_to_json).collect::<Vec<_>>(),
    })
}

/// Returns the full deck tree (names + due counts, nested by `::` hierarchy)
/// as JSON, written via `wasm_last_result_ptr/len`. Mirrors the real Anki
/// desktop deck-overview screen ("Stapelübersicht": Neu/Nochmal/Fällig per
/// deck).
///
/// Passes `Some(now)` to `Collection::deck_tree` (rather than `None`) so the
/// due-count fields are actually populated — `None` is only for tree-shape
/// queries that don't need counts (e.g. the plain deck picker in ImportView,
/// which still uses `wasm_list_decks`). This also unburies any cards buried on
/// a previous day, matching what opening the real deck list does.
///
/// Returns 0 on success, negative on error (see `wasm_last_error_*`).
#[no_mangle]
pub extern "C" fn wasm_get_deck_tree() -> i32 {
    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -1;
        }
    };

    let tree = match col.deck_tree(Some(TimestampSecs::now())) {
        Ok(t) => t,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    let json = deck_tree_node_to_json(&tree);
    match serde_json::to_vec(&json) {
        Ok(bytes) => {
            set_last_result(bytes);
            0
        }
        Err(e) => {
            set_last_error(e);
            -4
        }
    }
}

// ---------------------------------------------------------------------------
// Media files (audio/images referenced by note fields)
//
// rslib's `import_apkg` writes a collection's media into MEDIA_FOLDER on the
// emscripten virtual FS (MEMFS), which is wiped on every page reload. These
// three exports let the JS layer shuttle those files to/from OPFS (which does
// persist): after import, enumerate + read each file to copy into OPFS; on
// load, write them back so rslib operations that touch media stay consistent.
// (Card *rendering* itself doesn't read media bytes — it only emits filenames
// in the HTML — so displaying audio/images can be served straight from OPFS
// without a restore; see docs/ARCHITECTURE.md §13 for the persistence design.)
// ---------------------------------------------------------------------------

/// Lists the collection's media filenames as a JSON array of strings, e.g.
/// `["front.jpg","hello.mp3"]`, written via `wasm_last_result_ptr/len`. Only
/// regular files directly in MEDIA_FOLDER are listed (no recursion — Anki's
/// media folder is flat). A missing/empty media folder yields `[]`, not an
/// error. Returns 0 on success, negative on error (see `wasm_last_error_*`).
#[no_mangle]
pub extern "C" fn wasm_list_media_files() -> i32 {
    let mut names: Vec<String> = Vec::new();
    match std::fs::read_dir(MEDIA_FOLDER) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    if let Some(name) = entry.file_name().to_str() {
                        names.push(name.to_string());
                    }
                }
            }
        }
        // A not-yet-created media folder just means "no media"; anything else
        // is a real error worth surfacing.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    }

    match serde_json::to_vec(&names) {
        Ok(json) => {
            set_last_result(json);
            0
        }
        Err(e) => {
            set_last_error(e);
            -2
        }
    }
}

/// Reads a single media file (name given as UTF-8 bytes at `ptr`/`len`) from
/// MEDIA_FOLDER and writes its **raw bytes** (not JSON) via
/// `wasm_last_result_ptr/len`. Returns 0 on success, negative on error — in
/// particular if the file does not exist. The filename is treated as a bare
/// name inside MEDIA_FOLDER; any path separators would be rejected by the
/// filesystem, but Anki media names are always flat.
///
/// # Safety
/// `ptr`/`len` must describe a valid, readable byte slice.
#[no_mangle]
pub unsafe extern "C" fn wasm_read_media_file(ptr: *const u8, len: usize) -> i32 {
    let name_bytes = std::slice::from_raw_parts(ptr, len);
    let name = match std::str::from_utf8(name_bytes) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    let path = std::path::Path::new(MEDIA_FOLDER).join(name);
    match std::fs::read(&path) {
        Ok(bytes) => {
            set_last_result(bytes);
            0
        }
        Err(e) => {
            set_last_error(e);
            -2
        }
    }
}

/// Writes `data` (raw bytes at `data_ptr`/`data_len`) to
/// `<MEDIA_FOLDER>/<name>`, where `name` is UTF-8 bytes at
/// `name_ptr`/`name_len`. Creates MEDIA_FOLDER first if it doesn't exist
/// (mirroring how `wasm_open_collection` creates COLLECTION_PATH's parent).
/// Used to restore media from OPFS back into MEMFS. Returns 0 on success,
/// negative on error.
///
/// # Safety
/// Both `(name_ptr, name_len)` and `(data_ptr, data_len)` must describe valid,
/// readable byte slices.
#[no_mangle]
pub unsafe extern "C" fn wasm_write_media_file(
    name_ptr: *const u8,
    name_len: usize,
    data_ptr: *const u8,
    data_len: usize,
) -> i32 {
    let name_bytes = std::slice::from_raw_parts(name_ptr, name_len);
    let name = match std::str::from_utf8(name_bytes) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let data = std::slice::from_raw_parts(data_ptr, data_len);

    if let Err(e) = std::fs::create_dir_all(MEDIA_FOLDER) {
        set_last_error(e);
        return -2;
    }
    let path = std::path::Path::new(MEDIA_FOLDER).join(name);
    match std::fs::write(&path, data) {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(e);
            -3
        }
    }
}

/// Fetch the next due card. Returns its numeric card id (>= 0), or `-1` if the
/// queue is empty, or `-2` on error (see `wasm_last_error_*`).
///
/// The full `QueuedCard` (including its `SchedulingStates`) is cached so a
/// subsequent `answer_card` can build a correct `CardAnswer`.
#[no_mangle]
pub extern "C" fn wasm_get_next_card() -> i64 {
    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -2;
        }
    };

    match col.get_next_card() {
        Ok(Some(queued)) => {
            let id = queued.card.id().0;
            if let Ok(mut slot) = last_card_slot().lock() {
                *slot = Some(queued);
            }
            id
        }
        Ok(None) => {
            if let Ok(mut slot) = last_card_slot().lock() {
                *slot = None;
            }
            -1
        }
        Err(e) => {
            set_last_error(e);
            -2
        }
    }
}

/// Concatenates a rendered node list into plain text, handling *every*
/// `RenderedNode` variant rather than requiring a single `Text` node the way
/// `RenderCardOutput::question()`/`.answer()`'s convenience accessors do.
///
/// Real-world finding (a 46k-note medical-school deck, "Ankizin"): a
/// malformed Cloze note (its content has no actual `{{c1::...}}` for the
/// card's ordinal — a genuine data-quality issue in that specific note, not
/// a bug here) makes `render_card`'s question-side output end up as
/// *multiple* nodes (an error message text node gets appended to whatever
/// partial rendering already happened, rather than replacing it — see
/// `template::render_card`'s `empty_message` handling). `.question()`'s
/// strict `[RenedNode::Text] => ...` match then falls through to the literal
/// string `"not fully rendered"` for ~56% of a real sample of that deck's
/// cards. Flattening every node's text ourselves (both `Text` and
/// `Replacement`, which — since we always request `partial_render=false` —
/// should never actually appear unresolved, but concatenating its
/// `current_text` is a safe fallback if it ever does) surfaces the real
/// (if sometimes error-message-shaped) content instead.
fn flatten_rendered_nodes(nodes: &[RenderedNode]) -> String {
    nodes
        .iter()
        .map(|node| match node {
            RenderedNode::Text { text } => text.as_str(),
            RenderedNode::Replacement { current_text, .. } => current_text.as_str(),
        })
        .collect()
}

/// Renders the card most recently returned by `wasm_get_next_card` (peeks
/// `LAST_CARD` — does not consume it; `wasm_answer_card` still does that).
/// Writes `{"question": "...", "answer": "...", "css": "..."}` via the
/// `wasm_last_result_ptr/len` mechanism (same pattern as `wasm_list_decks`).
/// Returns 0 on success, negative on error — in particular -1 if no card is
/// currently loaded.
///
/// The HTML is returned **verbatim**: `[sound:...]`-style audio tags and
/// `<img src="...">` references are left intact (we deliberately do NOT call
/// `strip_av_tags` anymore — that used to delete audio entirely). The JS layer
/// (see web/src/wasm/media.ts) parses `[sound:...]` into playable `<audio>`
/// elements and rewrites `<img src>` to blob URLs backed by media files
/// persisted in OPFS. See docs/ARCHITECTURE.md §13.
#[no_mangle]
pub extern "C" fn wasm_render_current_card() -> i32 {
    let cid = match last_card_slot().lock() {
        Ok(slot) => match slot.as_ref() {
            Some(queued) => queued.card.id(),
            None => {
                set_last_error("no current card; call wasm_get_next_card first");
                return -1;
            }
        },
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };

    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -3;
        }
    };

    let rendered = match col.render_existing_card(cid, false, false) {
        Ok(r) => r,
        Err(e) => {
            set_last_error(e);
            return -4;
        }
    };

    let question = flatten_rendered_nodes(&rendered.qnodes);
    let answer = flatten_rendered_nodes(&rendered.anodes);
    let payload = serde_json::json!({
        "question": question,
        "answer": answer,
        "css": rendered.css,
    });

    match serde_json::to_vec(&payload) {
        Ok(json) => {
            set_last_result(json);
            0
        }
        Err(e) => {
            set_last_error(e);
            -5
        }
    }
}

/// Answer the card most recently returned by `wasm_get_next_card`.
/// `ease` follows Anki's 1..=4 convention: 1=Again, 2=Hard, 3=Good, 4=Easy.
/// Returns 0 on success, negative on error.
#[no_mangle]
pub extern "C" fn wasm_answer_card(ease: u8) -> i32 {
    let rating = match ease {
        1 => Rating::Again,
        2 => Rating::Hard,
        3 => Rating::Good,
        4 => Rating::Easy,
        other => {
            set_last_error(format!("invalid ease {other}, expected 1..=4"));
            return -1;
        }
    };

    let queued = match last_card_slot().lock() {
        Ok(mut slot) => match slot.take() {
            Some(q) => q,
            None => {
                set_last_error("no current card; call wasm_get_next_card first");
                return -2;
            }
        },
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -2;
        }
    };

    let states = &queued.states;
    let new_state = match rating {
        Rating::Again => states.again,
        Rating::Hard => states.hard,
        Rating::Good => states.good,
        Rating::Easy => states.easy,
    };

    let mut answer = CardAnswer {
        card_id: CardId(queued.card.id().0),
        current_state: states.current,
        new_state,
        rating,
        answered_at: TimestampMillis::now(),
        milliseconds_taken: 0,
        custom_data: None,
        from_queue: true,
    };

    let mut guard = match collection_slot().lock() {
        Ok(g) => g,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -3;
        }
    };
    let col = match guard.as_mut() {
        Some(c) => c,
        None => {
            set_last_error("no collection open; call wasm_open_collection first");
            return -3;
        }
    };
    match col.answer_card(&mut answer) {
        Ok(_) => 0,
        Err(e) => {
            set_last_error(e);
            -4
        }
    }
}

/// STUB — not implemented in Phase 1. Always returns -1.
///
/// rslib's real sync path (`anki::sync::*`) is built on `reqwest`, which on
/// wasm uses the browser's `fetch()` under the hood but still expects a real
/// network stack behind it. Wiring a real AnkiWeb sync flow is deliberately
/// out of scope for this spike.
///
/// # Safety
/// `endpoint_ptr`/`endpoint_len` and `token_ptr`/`token_len` must each
/// describe a valid, readable byte slice (or `len == 0`, in which case `ptr`
/// is not read).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_with_server(
    endpoint_ptr: *const u8,
    endpoint_len: usize,
    token_ptr: *const u8,
    token_len: usize,
) -> i32 {
    let _ = (endpoint_ptr, endpoint_len, token_ptr, token_len);
    // Touch BACKEND so it isn't dead code once init_backend is wired up.
    let _ = BACKEND.get();
    set_last_error(
        "sync_with_server: not yet implemented — see docs/ARCHITECTURE.md \
         (needs a fetch()-based transport shim to replace reqwest's native path).",
    );
    -1
}

fn main() {
    // Trivial entry point: this binary is never "run" in the traditional
    // sense. Its only purpose is to be an Emscripten main-module executable
    // so `emcc` emits JS glue (`-s MODULARIZE=1 -s EXPORT_ES6=1`) instead of
    // treating the crate as a bare cdylib "reactor"/side module. All real
    // work happens through the `wasm_*` exports above, called from JS after
    // the module has been instantiated.
}
