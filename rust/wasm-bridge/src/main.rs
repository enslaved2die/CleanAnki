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

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use anki::backend::Backend;
use anki::collection::Collection;
use anki::collection::CollectionBuilder;
use anki::import_export::package::ImportAnkiPackageOptions;
use anki::progress::Progress;
use anki::progress::ProgressState;
use anki::prelude::BoolKey;
use anki::prelude::CardId;
use anki::prelude::DeckId;
use anki::prelude::I18n;
use anki::scheduler::answering::CardAnswer;
use anki::scheduler::answering::Rating;
use anki::scheduler::queue::QueuedCard;
use anki::search::SortMode;
use anki::services::StatsService;
use anki::sync::collection::normal::NormalSyncer;
use anki::sync::collection::normal::SyncActionRequired;
use anki::sync::collection::progress::SyncStage;
use anki::sync::http_client::HttpSyncClient;
use anki::sync::login::sync_login;
use anki::sync::login::SyncAuth;
use anki::sync::media::progress::MediaSyncProgress;
use anki::template::RenderedNode;
use anki::timestamp::TimestampMillis;
use anki::timestamp::TimestampSecs;
use anki_proto::decks::DeckTreeNode;
use anki_proto::stats::GraphsRequest;
use reqwest::Client;
use reqwest::Url;

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

// The media tracking database (change-tracking DB for the *media* sync
// protocol — entirely separate from the collection itself) lives at
// `/anki/collection.mdb`, same derivation as `MEDIA_FOLDER`:
// `col_path.with_extension("mdb")`. No Rust-side constant for it — every
// access goes through `Collection::media()`, which derives the path itself;
// JS persists it to OPFS via `wasm_checkpoint_media_db` + direct
// `FS.readFile`/`writeFile` calls at that same well-known path — see
// docs/ARCHITECTURE.md.

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

/// Builds a `reqwest::Client` for the sync exports below. Deliberately NOT
/// `reqwest::Client::new()`: on the wasm backend that does
/// `Client::builder().build().unwrap_throw()` (reqwest-0.12.28's
/// `src/wasm/client.rs:51`), and that one `.unwrap_throw()` — infallible in
/// practice here, since `ClientBuilder::build()` only ever errors on a config
/// mistake we never make — is the *only* reason `wasm_bindgen`'s
/// `__wbindgen_throw` raw import (`wasm-bindgen-0.2.126/src/lib.rs`) is
/// reachable from our binary at all. Since that import needs the
/// wasm-bindgen-CLI-generated JS glue this Emscripten build deliberately never
/// produces (see docs/ARCHITECTURE.md §17), reaching it would fail the module
/// at *instantiation* (wasm imports are resolved eagerly, whether or not the
/// code path is ever executed) — confirmed empirically: switching to this
/// plain `.build()` + `.expect()` (ordinary `Result::expect`, no
/// `wasm_bindgen` involvement at all) let dead-code elimination drop
/// `Client::new()`'s body entirely, and with it the only path to
/// `__wbindgen_throw`, letting the module link and instantiate cleanly. See
/// docs/ARCHITECTURE.md §20 for the full derisking trail.
fn build_sync_http_client() -> Client {
    Client::builder()
        .build()
        .expect("reqwest wasm ClientBuilder::build() is infallible for default config")
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
    // rslib's sync client-version string (sent as part of every sync request,
    // and what a sync server's device list displays) is
    // `"anki,{version} ({buildhash}),{platform}"` — `{platform}` defaults to
    // `env::consts::OS` unless a `PLATFORM` env var overrides it
    // (rust/vendor/anki/rslib/src/version.rs `sync_client_version`,
    // `pub(crate)` — not callable directly, but reachable this way). On our
    // target that constant is literally "emscripten", which a real sync
    // server then shows as the device name — accurate about the build
    // target, but not a helpful label for an end user managing their device
    // list (a real self-hosted user saw exactly this: "emscripten · Anki
    // 26.05" next to their desktop's "macos · Anki 26.05" with no indication
    // either is a browser/wasm client). Overridden here, once, before
    // anything that could construct a sync request runs — `sync_client_version`
    // caches its result in a `LazyLock` on first use, so this must happen
    // before the first login/sync call, which `wasm_init_backend` (always the
    // first bridge call) guarantees.
    //
    // # Safety
    // Single-threaded at this point in the bridge's lifecycle (called once,
    // before any std::thread::spawn'd sync worker could exist) — no
    // concurrent env access is possible yet.
    unsafe {
        std::env::set_var("PLATFORM", "wasm");
    }

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
/// Builds a `Collection` from whatever bytes currently live at
/// `COLLECTION_PATH` on the (emscripten) virtual FS, applying the same setup
/// every open needs (media paths, FSRS default). Shared by `wasm_open_collection`
/// (which writes fresh bytes first) and the full-sync exports below (which
/// reopen after `Collection::full_download`/`full_upload` — both take `self`
/// by value and leave no usable `Collection` behind, even on failure, since
/// they close the sqlite connection before doing the network I/O).
fn build_collection_at_path() -> Result<Collection, String> {
    let tr = I18n::new(&["en"]);
    let mut col = CollectionBuilder::new(COLLECTION_PATH)
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
        .map_err(|e| e.to_string())?;

    // Make FSRS the active scheduling algorithm (real Anki's own recommended
    // default for new collections since 23.10). This is a single collection-
    // level config flag — `BoolKey::Fsrs` — that every scheduling call site
    // (`get_next_card`, `answer_card`, filtered-deck building) branches on
    // directly; no per-deck config is required. Left-as-default (empty)
    // per-deck `fsrs_params` is fully supported: `Collection::answer_card`
    // constructs `FSRS::new(Some(params))` with an empty params slice, and the
    // vendored `fsrs` crate treats that as "use its built-in
    // `DEFAULT_PARAMETERS`," not an error. Set unconditionally on every open
    // (idempotent — setting `true` when already `true` is a no-op) rather than
    // only for brand-new collections, since this app has no UI to toggle it
    // off and imports discard scheduling state anyway (`with_scheduling:
    // false`, see `wasm_import_apkg`).
    col.set_config_bool(BoolKey::Fsrs, true, false)
        .map_err(|e| e.to_string())?;

    Ok(col)
}

/// # Safety
/// `ptr`/`len` must describe a valid, readable byte slice (e.g. from
/// `wasm_alloc` followed by a JS-side write of exactly `len` bytes).
#[no_mangle]
pub unsafe extern "C" fn wasm_open_collection(ptr: *const u8, len: usize) -> i32 {
    let db_bytes = std::slice::from_raw_parts(ptr, len);

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

    let col = match build_collection_at_path() {
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

/// Flush the *media* tracking database's WAL into `MEDIA_DB_PATH`, exactly
/// like `wasm_checkpoint` does for the collection itself. Call this after a
/// successful `wasm_sync_media` (or `wasm_import_apkg`, which also mutates
/// this database) and before reading `MEDIA_DB_PATH` out of the virtual FS to
/// persist it to OPFS — otherwise `last_sync_usn` and the per-file
/// mtimes/checksums `register_changes` relies on may still be sitting in the
/// never-persisted `-wal` sidecar and get silently lost on reload, forcing
/// every session's media sync to reconcile the whole library from scratch
/// (`last_sync_usn` resets to 0) instead of picking up where the last one
/// left off. See docs/ARCHITECTURE.md.
///
/// Returns 0 on success, negative on error. Opens (creating if necessary) a
/// short-lived `MediaManager` purely to run the checkpoint pragma — the
/// connection that actually performed the sync/import has already been
/// dropped by the time JS calls this, but WAL checkpointing operates on the
/// database *file*, not a specific connection, so any connection to the same
/// path can request one.
#[no_mangle]
pub extern "C" fn wasm_checkpoint_media_db() -> i32 {
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

    let mgr = match col.media() {
        Ok(m) => m,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    match mgr.checkpoint() {
        Ok(()) => 0,
        Err(e) => {
            set_last_error(e);
            -4
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
// Statistics
// ---------------------------------------------------------------------------

/// Returns a summary of real collection statistics as JSON, written via
/// `wasm_last_result_ptr/len`. Backed by `Collection::graphs` (the same
/// `StatsService::graphs` real Anki desktop's full chart-rendering stats
/// screen calls) and `Collection::studied_today` — this bridge just picks out
/// the handful of scalar fields cheap to show as headline numbers, rather
/// than hand-serializing `GraphsResponse` wholesale (most of it is
/// day/interval `HashMap` chart-bucket data meant for client-side chart
/// rendering, not a summary payload).
///
/// `search: ""` means "the whole collection" (`graph_data_for_search` treats
/// an empty/whitespace-only search as `all = true` — see
/// rust/vendor/anki/rslib/src/stats/graphs/mod.rs). `days` only bounds the
/// revlog window for `added`/`reviews`-style charts we don't expose here;
/// `future_due` (the due-forecast counts below) always covers every
/// non-suspended card regardless of `days`, so the exact value doesn't matter
/// for what we read back — 365 is just a reasonable, generous window.
///
/// Returns 0 on success, negative on error (see `wasm_last_error_*`).
#[no_mangle]
pub extern "C" fn wasm_get_stats() -> i32 {
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

    let studied_today_text = match col.studied_today() {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    let graphs = match col.graphs(GraphsRequest {
        search: String::new(),
        days: 365,
    }) {
        Ok(g) => g,
        Err(e) => {
            set_last_error(e);
            return -4;
        }
    };

    let today = graphs.today.unwrap_or_default();
    let counts = graphs
        .card_counts
        .and_then(|c| c.including_inactive)
        .unwrap_or_default();

    // `future_due`'s keys are a day offset from "today" (0 = due today, 1 =
    // tomorrow, negative = overdue backlog) — see
    // rust/vendor/anki/rslib/src/stats/graphs/future_due.rs. Sum the buckets
    // ourselves rather than exposing the raw map; the UI only needs a few
    // headline numbers, not a full forecast chart.
    let future_due = graphs.future_due.unwrap_or_default();
    let due_today: u32 = future_due.future_due.get(&0).copied().unwrap_or(0);
    let due_this_week: u32 = (0..7)
        .map(|day| future_due.future_due.get(&day).copied().unwrap_or(0))
        .sum();
    let backlog: u32 = future_due
        .future_due
        .iter()
        .filter(|(day, _)| **day < 0)
        .map(|(_, count)| *count)
        .sum();

    let payload = serde_json::json!({
        "fsrs": graphs.fsrs,
        "studiedTodayText": studied_today_text,
        "today": {
            "answerCount": today.answer_count,
            "answerMillis": today.answer_millis,
            "correctCount": today.correct_count,
            "matureCount": today.mature_count,
            "matureCorrect": today.mature_correct,
        },
        "cardCounts": {
            "newCards": counts.new_cards,
            "learn": counts.learn,
            "relearn": counts.relearn,
            "young": counts.young,
            "mature": counts.mature,
            "suspended": counts.suspended,
            "buried": counts.buried,
        },
        "dueToday": due_today,
        "dueThisWeek": due_this_week,
        "backlog": backlog,
    });

    match serde_json::to_vec(&payload) {
        Ok(bytes) => {
            set_last_result(bytes);
            0
        }
        Err(e) => {
            set_last_error(e);
            -5
        }
    }
}

/// Resets every card in the collection back to "new" (clearing scheduling
/// state — interval, ease, review counts) and deletes all revlog (review
/// history) entries, for a genuine fresh start while keeping every imported
/// deck/note/card. Two real rslib operations, not a single dedicated API:
///
/// - `Collection::reschedule_cards_as_new` is real Anki's own "Forget" (the
///   card browser's Cards → Forget action), applied to every card
///   (`search_cards("", ...)` — an empty search matches the whole
///   collection, see rust/vendor/anki/rslib/src/search/parser.rs). Called
///   with `log: false` (no point logging a "manually rescheduled" revlog
///   entry when we're about to delete the whole revlog next),
///   `restore_position: false` (fresh new-card order, not preserving
///   whatever order cards happened to have before), `reset_counts: true`
///   (zero `reps`/`lapses`, matching a true "start over").
/// - Forget alone does NOT touch revlog history (confirmed by reading
///   rslib's implementation — it only ever *adds* a revlog entry, when
///   `log: true`, never deletes one), so without a second step the
///   statistics view would still show old answer counts/correct%/"studied
///   today" from before the reset. `SqliteStorage::clear_all_revlog_entries`
///   (added for this — no such bulk-wipe existed in rslib) deletes every
///   revlog row directly.
///
/// Does not reset each deck's daily "new/reviews studied today" counters
/// (`deck.common`, separate persisted state) — cosmetic only, since card
/// state itself is fully reset regardless, and it self-corrects at the next
/// day rollover.
///
/// Returns 0 on success, negative on error (see `wasm_last_error_*`).
#[no_mangle]
pub extern "C" fn wasm_reset_progress() -> i32 {
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

    let cids = match col.search_cards("", SortMode::NoOrder) {
        Ok(c) => c,
        Err(e) => {
            set_last_error(e);
            return -3;
        }
    };

    if let Err(e) = col.reschedule_cards_as_new(&cids, false, false, true, None) {
        set_last_error(e);
        return -4;
    }

    if let Err(e) = col.storage.clear_all_revlog_entries() {
        set_last_error(e);
        return -5;
    }

    0
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

// ---------------------------------------------------------------------------
// Real collection sync (login + normal sync) against AnkiWeb or a self-hosted
// anki-sync-server.
//
// rslib's whole sync protocol (login, meta check, the NormalSyncer algorithm,
// sanity checks) is unmodified, working rslib logic; the only piece that could
// not run on this Emscripten build was the HTTP transport — reqwest's wasm
// `.send()` needs wasm-bindgen JS glue we never generate (docs/ARCHITECTURE.md
// §17). That one function (`IoMonitor::zstd_request_with_timeout`) is now
// implemented on top of Emscripten's native synchronous `emscripten_fetch`
// (see the vendored rslib patch in io_monitor.rs, and §20).
//
// Synchronous `emscripten_fetch` blocks on network I/O, which the browser
// forbids on the main thread. So every sync op runs on a background thread
// (`std::thread::spawn` → a real Web Worker, proven in §20), driving the async
// rslib code to completion with a current-thread tokio runtime. The `wasm_*`
// entry points therefore can't return the result directly: they *start* the
// work and return immediately, and JS polls `wasm_sync_poll` (the main thread
// never blocks). Only one sync op runs at a time.
// ---------------------------------------------------------------------------

/// Sync progress/result, shared between the worker thread and the polling main
/// thread. 1 = running, 2 = finished OK (login: hkey in `wasm_last_result_*`),
/// a negative code = finished with an error (message in `wasm_last_error_*`).
/// -100 specifically means the server requires a full up/download, which this
/// pass does not perform.
static SYNC_STATE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

const SYNC_STATE_RUNNING: i32 = 1;
const SYNC_STATE_DONE_OK: i32 = 2;
const SYNC_ERR_GENERIC: i32 = -1;
const SYNC_ERR_FULL_SYNC_REQUIRED: i32 = -100;

/// Drive an async rslib future to completion on the current (worker) thread.
/// A current-thread runtime is the established way to run rslib's async API
/// synchronously; our transport does its blocking `emscripten_fetch` inline
/// when polled, so no multi-threaded scheduler or I/O driver is needed.
fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("build current-thread tokio runtime")
        .block_on(fut)
}

/// Normalises a user-entered sync endpoint into a `reqwest::Url`. Accepts a
/// plain `http://host:port` (a self-hosted anki-sync-server may well be plain
/// HTTP, not HTTPS) and guarantees a trailing slash, since rslib joins the
/// protocol path onto this base and a missing trailing slash would drop the
/// last segment. An empty string yields `None` → official AnkiWeb
/// (`HttpSyncClient::new` resolves `None` to `https://sync.ankiweb.net/`).
fn parse_endpoint(raw: &str) -> Result<Option<Url>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let with_slash = if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    };
    Url::parse(&with_slash)
        .map(Some)
        .map_err(|e| format!("invalid sync endpoint '{raw}': {e}"))
}

/// Reads a UTF-8 string from a `(ptr, len)` pair (or `""` when `len == 0`).
///
/// # Safety
/// `ptr`/`len` must describe a valid, readable byte slice, or `len == 0`.
unsafe fn str_from_raw(ptr: *const u8, len: usize) -> Result<String, std::str::Utf8Error> {
    if len == 0 {
        return Ok(String::new());
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).map(str::to_string)
}

/// Poll the in-flight sync started by `wasm_sync_login`/`wasm_sync_collection`.
/// Returns 1 while running, 2 on success, or a negative error code when done
/// (see `SYNC_STATE`). 0 means no sync has been started.
#[no_mangle]
pub extern "C" fn wasm_sync_poll() -> i32 {
    SYNC_STATE.load(std::sync::atomic::Ordering::SeqCst)
}

/// Clone of whichever collection's shared progress state the *current*
/// sync op is writing into (`Collection::progress_state()`), for
/// `wasm_sync_progress_json` to poll from the main thread. A separate,
/// always-fast lock from `collection_slot()`'s — a normal collection sync
/// holds that lock for its whole duration (and full_download/full_upload
/// take the `Collection` out of the slot entirely), so polling progress
/// through it would risk the exact main-thread `Atomics.wait` block
/// `onBusyChange` already works around elsewhere. Set once, right when each
/// sync export grabs its `Collection` reference, before the actual
/// network I/O starts.
static SYNC_PROGRESS_STATE: Mutex<Option<Arc<Mutex<ProgressState>>>> = Mutex::new(None);

fn set_sync_progress_state(state: Arc<Mutex<ProgressState>>) {
    if let Ok(mut guard) = SYNC_PROGRESS_STATE.lock() {
        *guard = Some(state);
    }
}

/// Reads the latest progress reported by the current (or most recently
/// finished) sync op, as a JSON string in `wasm_last_result_*`. Returns 0 if
/// progress data is available, 1 if none has been reported yet (not an
/// error — e.g. called before the background thread has gotten far enough
/// to construct its progress handler), negative on an internal error.
///
/// Shape depends on the `"kind"` field:
/// - `"normal_sync"`: `stage` ("connecting"/"syncing"/"finalizing"),
///   `localUpdate`/`localRemove`/`remoteUpdate`/`remoteRemove` (counts so
///   far — collection sync has no fixed total, so this is a live counter,
///   not a percentage).
/// - `"media_sync"`: `checked`/`downloadedFiles`/`downloadedDeletions`/
///   `uploadedFiles`/`uploadedDeletions` (counts so far — also no fixed
///   total).
/// - `"full_sync"`: `transferredBytes`/`totalBytes` — full_download/upload
///   transfer one big file of a known size, so this *is* a real percentage
///   (`transferredBytes / totalBytes`).
/// - `"other"`: some other rslib operation (e.g. `wasm_import_apkg`) last
///   touched this collection's shared progress state; nothing sync-related
///   to show.
#[no_mangle]
pub extern "C" fn wasm_sync_progress_json() -> i32 {
    let state = match SYNC_PROGRESS_STATE.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -1;
        }
    };
    let Some(state) = state else {
        return 1;
    };
    let progress = match state.lock() {
        Ok(guard) => guard.last_progress,
        Err(_) => {
            set_last_error("internal lock poisoned");
            return -1;
        }
    };
    let Some(progress) = progress else {
        return 1;
    };

    let json = match progress {
        Progress::NormalSync(p) => serde_json::json!({
            "kind": "normal_sync",
            "stage": match p.stage {
                SyncStage::Connecting => "connecting",
                SyncStage::Syncing => "syncing",
                SyncStage::Finalizing => "finalizing",
            },
            "localUpdate": p.local_update,
            "localRemove": p.local_remove,
            "remoteUpdate": p.remote_update,
            "remoteRemove": p.remote_remove,
        }),
        Progress::MediaSync(p) => serde_json::json!({
            "kind": "media_sync",
            "checked": p.checked,
            "downloadedFiles": p.downloaded_files,
            "downloadedDeletions": p.downloaded_deletions,
            "uploadedFiles": p.uploaded_files,
            "uploadedDeletions": p.uploaded_deletions,
        }),
        Progress::FullSync(p) => serde_json::json!({
            "kind": "full_sync",
            "transferredBytes": p.transferred_bytes,
            "totalBytes": p.total_bytes,
        }),
        _ => serde_json::json!({ "kind": "other" }),
    };
    set_last_result(json.to_string().into_bytes());
    0
}

/// Begin a sync **login**: exchanges username/password for a sync key (hkey)
/// against `endpoint` (empty → official AnkiWeb). Returns 0 once the background
/// login has been started (negative only on a bad argument); JS then polls
/// `wasm_sync_poll` until it is 2 (hkey in `wasm_last_result_*`) or negative
/// (message in `wasm_last_error_*`).
///
/// # Safety
/// Each `(ptr, len)` pair must describe a valid, readable byte slice (or
/// `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_login(
    username_ptr: *const u8,
    username_len: usize,
    password_ptr: *const u8,
    password_len: usize,
    endpoint_ptr: *const u8,
    endpoint_len: usize,
) -> i32 {
    let username = match str_from_raw(username_ptr, username_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let password = match str_from_raw(password_ptr, password_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint = match str_from_raw(endpoint_ptr, endpoint_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    // Validate the endpoint on the calling thread so an obviously bad URL is
    // reported synchronously; `sync_login` re-parses it internally anyway.
    let endpoint_opt = match parse_endpoint(&endpoint) {
        Ok(e) => e.map(|u| u.to_string()),
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    SYNC_STATE.store(SYNC_STATE_RUNNING, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = block_on(sync_login(
            username,
            password,
            endpoint_opt,
            build_sync_http_client(),
        ));
        match result {
            Ok(auth) => {
                set_last_result(auth.hkey.into_bytes());
                SYNC_STATE.store(SYNC_STATE_DONE_OK, std::sync::atomic::Ordering::SeqCst);
            }
            Err(e) => {
                // `AnkiError`'s derived `Display` (via snafu, no explicit
                // `#[snafu(display(...))]` on most variants) prints just the
                // bare variant name (e.g. "SyncError") — `Debug` recurses into
                // the nested source (network/HTTP status/context), which is
                // far more useful for diagnosing a real sync failure against a
                // real server than the terser `Display`.
                set_last_error(format!("{e:?}"));
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    0
}

/// Begin a normal **collection sync** using a previously obtained `hkey`
/// against `endpoint` (empty → official AnkiWeb). Returns 0 once the background
/// sync has been started (negative only on a bad argument); JS then polls
/// `wasm_sync_poll` until 2 (success — persist the collection afterwards) or a
/// negative error code (`-100` = server requires a full up/download, which is
/// out of scope for this pass; other negatives = message in
/// `wasm_last_error_*`).
///
/// # Safety
/// Each `(ptr, len)` pair must describe a valid, readable byte slice (or
/// `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_collection(
    hkey_ptr: *const u8,
    hkey_len: usize,
    endpoint_ptr: *const u8,
    endpoint_len: usize,
) -> i32 {
    let hkey = match str_from_raw(hkey_ptr, hkey_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint = match str_from_raw(endpoint_ptr, endpoint_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint_opt = match parse_endpoint(&endpoint) {
        Ok(e) => e,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    SYNC_STATE.store(SYNC_STATE_RUNNING, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        let auth = SyncAuth {
            hkey,
            endpoint: endpoint_opt,
            io_timeout_secs: None,
        };
        // Hold the collection lock for the whole sync — nothing else touches
        // the collection while a sync is in flight (the main thread only polls).
        let mut guard = match collection_slot().lock() {
            Ok(g) => g,
            Err(_) => {
                set_last_error("internal lock poisoned");
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };
        let col = match guard.as_mut() {
            Some(c) => c,
            None => {
                set_last_error("no collection open; call wasm_open_collection first");
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };

        set_sync_progress_state(col.progress_state());
        let server = HttpSyncClient::new(auth, build_sync_http_client());
        let result = block_on(NormalSyncer::new(col, server).sync());
        match result {
            Ok(output) => match output.required {
                // NoChanges, or a normal sync that ran and left the collection
                // in sync — both are success.
                SyncActionRequired::NoChanges | SyncActionRequired::NormalSyncRequired => {
                    SYNC_STATE.store(SYNC_STATE_DONE_OK, std::sync::atomic::Ordering::SeqCst);
                }
                SyncActionRequired::FullSyncRequired { .. } => {
                    set_last_error(
                        "server requires a full upload/download; full sync is not yet \
                         supported in this build (use Anki desktop for the first full sync)",
                    );
                    SYNC_STATE
                        .store(SYNC_ERR_FULL_SYNC_REQUIRED, std::sync::atomic::Ordering::SeqCst);
                }
            },
            Err(e) => {
                // See the matching comment in `wasm_sync_login`: `Debug`
                // surfaces the nested error detail that `Display` collapses
                // to just the bare variant name.
                set_last_error(format!("{e:?}"));
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    0
}

/// Takes the open `Collection` out of `COLLECTION`, for the full-sync exports
/// below: `Collection::full_download`/`full_upload` both take `self` **by
/// value** (they close the sqlite connection internally before doing any
/// network I/O, succeed or fail), so there is no `&mut Collection` to hand
/// them the way `wasm_sync_collection`'s `NormalSyncer` gets one. Whatever
/// calls this must call `reopen_collection` afterwards, unconditionally,
/// win or lose — see that function's doc comment for why that's always safe.
fn take_collection() -> Result<Collection, String> {
    let mut guard = collection_slot()
        .lock()
        .map_err(|_| "internal lock poisoned".to_string())?;
    guard
        .take()
        .ok_or_else(|| "no collection open; call wasm_open_collection first".to_string())
}

/// Rebuilds a `Collection` from `COLLECTION_PATH` and stores it back in
/// `COLLECTION`. Safe to call after either outcome of `full_download`/
/// `full_upload`: a successful `full_download` already atomically renamed the
/// downloaded file over `COLLECTION_PATH` before returning, so this picks up
/// the new data; a failed download never touches `COLLECTION_PATH` at all,
/// and `full_upload` never modifies the local file in either case (it only
/// reads and sends it) — so reopening always yields a valid, usable
/// collection, whichever way the sync went.
fn reopen_collection() -> Result<(), String> {
    let col = build_collection_at_path()?;
    let mut guard = collection_slot()
        .lock()
        .map_err(|_| "internal lock poisoned".to_string())?;
    *guard = Some(col);
    Ok(())
}

/// Begin a **full download**: replaces the local collection wholesale with
/// the server's copy. This is the real Anki desktop "first sync" dialog's
/// "Download from server" choice — for when the server already has the
/// authoritative data (e.g. pushed there from desktop Anki already) and the
/// local collection should be discarded. **Destructive to local data** —
/// any local-only changes not already on the server are lost. Returns 0 once
/// started; JS polls `wasm_sync_poll` same as the other sync exports (2 =
/// success, persist afterwards; negative = message in `wasm_last_error_*`).
///
/// # Safety
/// Each `(ptr, len)` pair must describe a valid, readable byte slice (or
/// `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_full_download(
    hkey_ptr: *const u8,
    hkey_len: usize,
    endpoint_ptr: *const u8,
    endpoint_len: usize,
) -> i32 {
    let hkey = match str_from_raw(hkey_ptr, hkey_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint = match str_from_raw(endpoint_ptr, endpoint_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint_opt = match parse_endpoint(&endpoint) {
        Ok(e) => e,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    SYNC_STATE.store(SYNC_STATE_RUNNING, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        let col = match take_collection() {
            Ok(c) => c,
            Err(e) => {
                set_last_error(e);
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };
        let auth = SyncAuth {
            hkey,
            endpoint: endpoint_opt,
            io_timeout_secs: None,
        };
        // Grab this before `full_download` consumes `col` — `full_download`
        // builds its own progress handler from the same shared state as its
        // very first step (see `Collection::full_download_with_server`), so
        // this clone stays valid/live for the whole transfer even once `col`
        // itself is gone.
        set_sync_progress_state(col.progress_state());
        let result = block_on(col.full_download(auth, build_sync_http_client()));
        if let Err(e) = reopen_collection() {
            set_last_error(format!(
                "full download {}, but failed to reopen the collection afterwards: {e}",
                if result.is_ok() { "succeeded" } else { "also failed" }
            ));
            SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        match result {
            Ok(()) => SYNC_STATE.store(SYNC_STATE_DONE_OK, std::sync::atomic::Ordering::SeqCst),
            Err(e) => {
                set_last_error(format!("{e:?}"));
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    0
}

/// Begin a **full upload**: replaces the server's collection wholesale with
/// the local copy. The real Anki desktop "first sync" dialog's "Upload to
/// server" choice — for when the *local* collection is authoritative and the
/// server's copy (if any) should be discarded. **Destructive to remote
/// data.** Same start-then-poll shape as `wasm_sync_full_download`.
///
/// # Safety
/// Each `(ptr, len)` pair must describe a valid, readable byte slice (or
/// `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_full_upload(
    hkey_ptr: *const u8,
    hkey_len: usize,
    endpoint_ptr: *const u8,
    endpoint_len: usize,
) -> i32 {
    let hkey = match str_from_raw(hkey_ptr, hkey_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint = match str_from_raw(endpoint_ptr, endpoint_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint_opt = match parse_endpoint(&endpoint) {
        Ok(e) => e,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    SYNC_STATE.store(SYNC_STATE_RUNNING, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        let col = match take_collection() {
            Ok(c) => c,
            Err(e) => {
                set_last_error(e);
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };
        let auth = SyncAuth {
            hkey,
            endpoint: endpoint_opt,
            io_timeout_secs: None,
        };
        // See the matching comment in `wasm_sync_full_download`: `full_upload`
        // builds its progress handler from the same shared state before
        // consuming `self`, so this clone stays live for the whole transfer.
        set_sync_progress_state(col.progress_state());
        let result = block_on(col.full_upload(auth, build_sync_http_client()));
        if let Err(e) = reopen_collection() {
            set_last_error(format!(
                "full upload {}, but failed to reopen the collection afterwards: {e}",
                if result.is_ok() { "succeeded" } else { "also failed" }
            ));
            SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            return;
        }
        match result {
            Ok(()) => SYNC_STATE.store(SYNC_STATE_DONE_OK, std::sync::atomic::Ordering::SeqCst),
            Err(e) => {
                set_last_error(format!("{e:?}"));
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    0
}

/// Begin a **media sync** — a separate protocol and a separate server-side
/// database from collection sync (`wasm_sync_collection`/`_full_download`/
/// `_full_upload` only ever transfer the `.anki2` SQLite file; this is what
/// actually fetches/sends the image and audio files referenced from note
/// fields). Real Anki desktop always runs both when you hit its one "Sync"
/// button; this bridge exposes them as two exports so the caller can chain
/// them the same way (and so a media-sync failure doesn't have to undo an
/// already-successful collection sync). Same start-then-poll shape as the
/// other sync exports (reuses `SYNC_STATE`/`wasm_sync_poll`).
///
/// `Collection::media()` derives the media folder/tracking-database paths
/// from `COLLECTION_PATH` (`with_desktop_media_paths`, set at open time), so
/// no new path plumbing is needed. Downloaded files are written directly
/// into `MEDIA_FOLDER` by rslib's own sync code — the caller should run the
/// existing `wasm_list_media_files`/`wasm_read_media_file` → OPFS shuttle
/// (`persistMedia()` on the JS side, already used after `wasm_import_apkg`)
/// afterwards to persist them, exactly as it already does after an import.
///
/// Only `mgr`/`progress` are extracted from the open collection; the
/// collection lock is released *before* the (potentially slow, many-files)
/// network transfer runs — unlike `wasm_sync_collection`, media sync never
/// needs continued access to the `Collection` itself, so there's no reason
/// to block other bridge calls for its whole duration.
///
/// # Safety
/// Each `(ptr, len)` pair must describe a valid, readable byte slice (or
/// `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn wasm_sync_media(
    hkey_ptr: *const u8,
    hkey_len: usize,
    endpoint_ptr: *const u8,
    endpoint_len: usize,
) -> i32 {
    let hkey = match str_from_raw(hkey_ptr, hkey_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint = match str_from_raw(endpoint_ptr, endpoint_len) {
        Ok(s) => s,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };
    let endpoint_opt = match parse_endpoint(&endpoint) {
        Ok(e) => e,
        Err(e) => {
            set_last_error(e);
            return -1;
        }
    };

    SYNC_STATE.store(SYNC_STATE_RUNNING, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || {
        let (mgr, progress) = {
            let mut guard = match collection_slot().lock() {
                Ok(g) => g,
                Err(_) => {
                    set_last_error("internal lock poisoned");
                    SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            };
            let col = match guard.as_mut() {
                Some(c) => c,
                None => {
                    set_last_error("no collection open; call wasm_open_collection first");
                    SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            };
            let mgr = match col.media() {
                Ok(m) => m,
                Err(e) => {
                    set_last_error(e);
                    SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            };
            set_sync_progress_state(col.progress_state());
            (mgr, col.new_progress_handler::<MediaSyncProgress>())
        };

        let auth = SyncAuth {
            hkey,
            endpoint: endpoint_opt,
            io_timeout_secs: None,
        };
        let result = block_on(mgr.sync_media(progress, auth, build_sync_http_client(), None));
        match result {
            Ok(()) => SYNC_STATE.store(SYNC_STATE_DONE_OK, std::sync::atomic::Ordering::SeqCst),
            Err(e) => {
                set_last_error(format!("{e:?}"));
                SYNC_STATE.store(SYNC_ERR_GENERIC, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    0
}

fn main() {
    // Trivial entry point: this binary is never "run" in the traditional
    // sense. Its only purpose is to be an Emscripten main-module executable
    // so `emcc` emits JS glue (`-s MODULARIZE=1 -s EXPORT_ES6=1`) instead of
    // treating the crate as a bare cdylib "reactor"/side module. All real
    // work happens through the `wasm_*` exports above, called from JS after
    // the module has been instantiated.
}
