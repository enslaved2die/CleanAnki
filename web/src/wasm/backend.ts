// Thin TypeScript wrapper around the Emscripten-compiled Rust core (rslib),
// built by the `rust/wasm-bridge/` crate (plain `#[no_mangle] extern "C"`
// exports, target wasm32-unknown-emscripten — NOT wasm-bindgen; see
// docs/ARCHITECTURE.md §7 for why). This module is the *only* place that
// should know the raw C ABI (pointers, lengths, manual byte marshalling); the
// rest of the app should only ever see the typed async functions exported
// below.
//
// The wasm build output (`anki_wasm_bridge.js` + `.wasm`) is NOT bundled by
// Vite — it's served unprocessed from `public/wasm/` (see
// web/scripts/sync-wasm-artifacts.sh and docs/ARCHITECTURE.md §8) for two
// independent reasons:
//   1. The generated glue re-invokes itself by a literal, self-referential
//      URL for pthread worker bootstrap, which would break under Vite's
//      asset hashing if it went through the bundler.
//   2. Vite's dev server flatly refuses to serve a public/ file through a JS
//      `import()`/`import` from source code at all ("This file is in /public
//      ... should not be imported from source code. It can only be
//      referenced via HTML tags" — a real error hit and confirmed; see
//      docs/ARCHITECTURE.md §8). That's *why* rust/wasm-bridge/build.rs emits
//      a classic (non-ES-module) MODULARIZE build (`EXPORT_NAME` below
//      instead of `EXPORT_ES6`): loaded via a plain `<script>` tag appended
//      to the DOM, which is an ordinary static-asset fetch Vite's dev server
//      never tries to transform — exactly like `<link rel="icon">` already
//      does for the favicon.
//
// The calling convention mirrored here (alloc → write bytes into
// `Module.HEAPU8` → call → dealloc, read-back errors via
// `wasm_last_error_ptr/len`) is the exact one proven working in
// rust/wasm-bridge/smoke-test/smoke_test.mjs — not reinvented.

const WASM_JS_URL = '/wasm/anki_wasm_bridge.js'

/** Global name the classic-mode Emscripten build assigns its factory
 * function to (`-sEXPORT_NAME=AnkiWasmBridgeModule` in
 * rust/wasm-bridge/build.rs). Picked to avoid colliding with the generic
 * `window.Module` name emscripten uses by default. */
const GLOBAL_FACTORY_NAME = 'AnkiWasmBridgeModule'

/** Where the bridge stages the collection inside Emscripten's virtual FS.
 * Must match `COLLECTION_PATH` in rust/wasm-bridge/src/main.rs exactly. */
const COLLECTION_PATH = '/anki/collection.anki2'

/** The media sync protocol's change-tracking database — a completely
 * separate database from the collection itself. Must match `MEDIA_DB_PATH`
 * in rust/wasm-bridge/src/main.rs exactly (derived there from
 * `COLLECTION_PATH.with_extension("mdb")`, same convention desktop Anki
 * uses). */
const MEDIA_DB_PATH = '/anki/collection.mdb'

/** Card returned by `get_next_card`. Just the id — the actual rendered
 * content is a separate round trip via `getCurrentCardContent()` (mirrors
 * the bridge: `wasm_get_next_card` only returns an id, `wasm_render_current_card`
 * renders whatever card is currently loaded). */
export interface BackendCard {
  id: number
}

/** Rendered HTML for the card most recently returned by `getNextCard`.
 * `question`/`answer` are real Anki template output
 * (`Collection::render_existing_card`) returned **verbatim** — `[sound:...]`
 * audio tokens and `<img src="...">` references are left intact (the bridge no
 * longer strips av tags). The caller resolves those into playable/visible
 * media via `resolveMediaInHtml` (see web/src/ui/StudyView/media.ts and
 * docs/ARCHITECTURE.md §13). `css` is the notetype's own stylesheet; the caller
 * renders it in a sandboxed iframe (see StudyView/CardFrame) rather than
 * scoping it, since it assumes classic Anki's `.card` container convention. */
export interface CardContent {
  question: string
  answer: string
  css: string
}

/** A deck as returned by `listDecks` — `id` is a `bigint` because deck ids
 * are i64 creation-timestamps that can exceed `Number.MAX_SAFE_INTEGER`'s
 * exact range; `wasm_list_decks` deliberately encodes them as JSON strings
 * for exactly this reason (see rust/wasm-bridge/src/main.rs), parsed back
 * into `BigInt` here. */
export interface Deck {
  id: bigint
  name: string
}

/** A node of the tree returned by `getDeckTree`, mirroring real Anki's deck
 * overview screen ("Stapelübersicht": Neu/Nochmal/Fällig per deck). `deckId`
 * is a `bigint` for the same reason as `Deck.id` above. `newCount`/
 * `learnCount`/`reviewCount` are already-limited, already-including-children
 * counts (i.e. exactly what real Anki's deck list displays), not raw totals —
 * see `Collection::deck_tree`'s doc comment in the vendored rslib source. */
export interface DeckTreeNode {
  deckId: bigint
  name: string
  newCount: number
  learnCount: number
  reviewCount: number
  collapsed: boolean
  filtered: boolean
  children: DeckTreeNode[]
}

/** Summary statistics from `getStats`, backed by real rslib computation
 * (`Collection::graphs`/`Collection::studied_today` — the same data real
 * Anki desktop's stats screen is built from). This is a hand-picked subset of
 * scalar headline numbers, not the full chart-bucket payload — see
 * rust/wasm-bridge/src/main.rs's `wasm_get_stats` doc comment for why. */
export interface Stats {
  /** Whether FSRS (vs. legacy SM-2) is the active scheduling algorithm. */
  fsrs: boolean
  /** Real Anki's own translated "Studied N cards in M minutes today" sentence. */
  studiedTodayText: string
  today: {
    answerCount: number
    answerMillis: number
    correctCount: number
    matureCount: number
    matureCorrect: number
  }
  cardCounts: {
    newCards: number
    learn: number
    relearn: number
    young: number
    mature: number
    suspended: number
    buried: number
  }
  /** Cards due today, per rslib's `future_due` forecast. */
  dueToday: number
  /** Cards due within the next 7 days (today included). */
  dueThisWeek: number
  /** Overdue cards (were due on a previous day and haven't been studied). */
  backlog: number
  /** Per-day due counts for the next 7 days (day 0 = today), from rslib's
   * `future_due` forecast — the same map `dueToday`/`dueThisWeek` are summed
   * from. Rendered as a small forecast bar chart. */
  dueForecast: { day: number; count: number }[]
}

/**
 * Result of a media check — the real rslib `MediaCheckOutput` (from
 * `Collection::media_checker().check()`), reduced to the fields the UI needs.
 * `summary` is rslib's own `MediaChecker::summarize_output` text, identical to
 * what real Anki desktop's Tools → Check Media dialog shows (multi-line).
 */
export interface MediaCheckReport {
  /** Full human-readable report text (multi-line), produced by rslib. */
  summary: string
  /** Number of media files referenced by no note — the ones deletable via
   * `deleteUnusedMedia`. */
  unusedCount: number
  /** Number of files referenced by notes but missing from the media folder. */
  missingCount: number
  /** Number of files sitting in the media trash folder. */
  trashCount: number
  /** Total size in bytes of the files in the media trash folder. */
  trashBytes: number
}

/** Raw shape of the object Emscripten's MODULARIZE factory resolves to.
 * Only the pieces this module actually touches are declared. */
interface EmscriptenModule {
  HEAPU8: Uint8Array
  FS: {
    readFile(path: string): Uint8Array
    writeFile(path: string, data: Uint8Array): void
  }
  _wasm_alloc(len: number): number
  _wasm_dealloc(ptr: number, len: number): void
  _wasm_last_error_ptr(): number
  _wasm_last_error_len(): number
  _wasm_last_result_ptr(): number
  _wasm_last_result_len(): number
  _wasm_init_backend(): number
  _wasm_open_collection(ptr: number, len: number): number
  _wasm_checkpoint(): number
  _wasm_checkpoint_media_db(): number
  _wasm_import_apkg(ptr: number, len: number): number
  _wasm_list_decks(): number
  _wasm_get_deck_tree(): number
  _wasm_get_stats(): number
  _wasm_reset_progress(): number
  // `deck_id` is a genuine i64 parameter, not just an i64 return — confirmed
  // empirically (not just assumed) that -sWASM_BIGINT=1 marshals i64
  // *parameters* as native JS BigInt too, the same as it does for
  // wasm_get_next_card's i64 *return*. See docs/ARCHITECTURE.md §10.
  _wasm_set_current_deck(deckId: bigint): number
  _wasm_delete_deck(deckId: bigint): number
  _wasm_list_media_files(): number
  _wasm_check_media(): number
  _wasm_delete_unused_media(): number
  _wasm_read_media_file(ptr: number, len: number): number
  _wasm_write_media_file(
    namePtr: number,
    nameLen: number,
    dataPtr: number,
    dataLen: number,
  ): number
  _wasm_get_next_card(): bigint
  _wasm_render_current_card(): number
  _wasm_answer_card(ease: number): number
  _wasm_sync_login(
    usernamePtr: number,
    usernameLen: number,
    passwordPtr: number,
    passwordLen: number,
    endpointPtr: number,
    endpointLen: number,
  ): number
  _wasm_sync_collection(hkeyPtr: number, hkeyLen: number, endpointPtr: number, endpointLen: number): number
  _wasm_sync_full_download(hkeyPtr: number, hkeyLen: number, endpointPtr: number, endpointLen: number): number
  _wasm_sync_full_upload(hkeyPtr: number, hkeyLen: number, endpointPtr: number, endpointLen: number): number
  _wasm_sync_media(hkeyPtr: number, hkeyLen: number, endpointPtr: number, endpointLen: number): number
  _wasm_sync_poll(): number
  _wasm_sync_progress_json(): number
}

type EmscriptenModuleFactory = (
  moduleOverrides?: Record<string, unknown>,
) => Promise<EmscriptenModule>

let modulePromise: Promise<EmscriptenModule> | null = null

/** Loads `anki_wasm_bridge.js` via a plain `<script>` tag (see the
 * module-level comment for why) and resolves to the factory function it
 * assigns to `window[GLOBAL_FACTORY_NAME]`. */
function loadFactoryScript(): Promise<EmscriptenModuleFactory> {
  const globals = window as unknown as Record<string, unknown>

  const existing = globals[GLOBAL_FACTORY_NAME]
  if (typeof existing === 'function') {
    return Promise.resolve(existing as EmscriptenModuleFactory)
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = WASM_JS_URL
    script.async = true
    script.onload = () => {
      const factory = globals[GLOBAL_FACTORY_NAME]
      if (typeof factory === 'function') {
        resolve(factory as EmscriptenModuleFactory)
      } else {
        reject(
          new Error(
            `${WASM_JS_URL} loaded but did not define window.${GLOBAL_FACTORY_NAME} — ` +
              'did rust/wasm-bridge/build.rs\'s EXPORT_NAME change without updating this constant?',
          ),
        )
      }
    }
    script.onerror = () => {
      reject(
        new Error(
          `failed to load ${WASM_JS_URL} — did you run web/scripts/sync-wasm-artifacts.sh?`,
        ),
      )
    }
    document.head.appendChild(script)
  })
}

async function loadModule(): Promise<EmscriptenModule> {
  if (modulePromise) return modulePromise

  modulePromise = (async (): Promise<EmscriptenModule> => {
    const createModule = await loadFactoryScript()
    return createModule({
      locateFile: (file: string) => `/wasm/${file}`,
      print: (line: string) => console.log('[wasm stdout]', line),
      printErr: (line: string) => console.warn('[wasm stderr]', line),
    })
  })()

  return modulePromise
}

/** Reads the current `wasm_last_error_*` buffer as a UTF-8 string. Only
 * meaningful immediately after a `wasm_*` call returned a negative status —
 * a later call may overwrite it. */
function readLastError(mod: EmscriptenModule): string {
  const ptr = mod._wasm_last_error_ptr()
  const len = mod._wasm_last_error_len()
  if (len === 0) return '(no error message set)'
  // `mod.HEAPU8` is backed by a SharedArrayBuffer (pthreads require it), and
  // TextDecoder.decode() refuses a view over shared memory ("The provided
  // ArrayBufferView value must not be shared"). Copy into a plain,
  // non-shared Uint8Array first — `new Uint8Array(view)` copies elements
  // into a fresh regular ArrayBuffer, it does not alias the shared one.
  const shared = mod.HEAPU8.subarray(ptr, ptr + len)
  const copy = new Uint8Array(shared)
  return new TextDecoder().decode(copy)
}

/** Reads the current `wasm_last_result_*` buffer as a UTF-8 string (the
 * success-payload counterpart to `readLastError` — see `LAST_RESULT`'s doc
 * comment in main.rs for why these are two separate buffers, not one). */
function readLastResult(mod: EmscriptenModule): string {
  const ptr = mod._wasm_last_result_ptr()
  const len = mod._wasm_last_result_len()
  if (len === 0) return ''
  const shared = mod.HEAPU8.subarray(ptr, ptr + len)
  const copy = new Uint8Array(shared)
  return new TextDecoder().decode(copy)
}

/** Reads the current `wasm_last_result_*` buffer as **raw bytes** (a fresh,
 * non-shared copy). Used by `readMediaFile`, where the payload is arbitrary
 * binary (an image/audio file) rather than the UTF-8 JSON `readLastResult`
 * decodes. Must be copied out (not aliased) before any later wasm call
 * overwrites `LAST_RESULT` or a memory-growth reallocation invalidates the
 * view. */
function readLastResultBytes(mod: EmscriptenModule): Uint8Array {
  const ptr = mod._wasm_last_result_ptr()
  const len = mod._wasm_last_result_len()
  if (len === 0) return new Uint8Array(0)
  return new Uint8Array(mod.HEAPU8.subarray(ptr, ptr + len))
}

/** Writes `bytes` into a freshly `wasm_alloc`'d buffer, runs `fn` with its
 * `(ptr, len)`, and frees the buffer afterwards regardless of outcome. */
function withWasmBuffer<T>(
  mod: EmscriptenModule,
  bytes: Uint8Array,
  fn: (ptr: number, len: number) => T,
): T {
  const ptr = mod._wasm_alloc(bytes.length)
  try {
    mod.HEAPU8.set(bytes, ptr)
    return fn(ptr, bytes.length)
  } finally {
    mod._wasm_dealloc(ptr, bytes.length)
  }
}

// A React StrictMode double-effect (or any other caller invoking
// `initBackend` more than once) would otherwise hit `wasm_init_backend`'s
// "-1: already initialised" status. That's not a real error — the backend
// really is initialised — so we make init idempotent from the JS side
// instead of surfacing it as a failure.
let backendInitPromise: Promise<void> | null = null

export async function initBackend(): Promise<void> {
  if (backendInitPromise) return backendInitPromise

  backendInitPromise = (async () => {
    const mod = await loadModule()
    const rc = mod._wasm_init_backend()
    if (rc !== 0) {
      throw new Error(`wasm_init_backend failed (${rc}): ${readLastError(mod)}`)
    }
  })()

  return backendInitPromise
}

// Like `backendInitPromise` above: the backend keeps one collection open for
// the whole page session (verified by hand — switching to the Sync tab and
// back remounts StudyView, which called `openCollection` a second time and
// got `wasm_open_collection failed (-3): DbError`, since rslib refuses to
// open a second connection while one is already open). There's no
// close/reopen flow yet (no import UI, no real sync), so for this phase
// "open" just means "make sure it's open" — later calls are a no-op once the
// first one succeeds, same as `initBackend`. The `bytes` a later call was
// passed are simply ignored; revisit if/when a real "switch collections"
// flow exists.
let openCollectionPromise: Promise<void> | null = null

export async function openCollection(bytes: Uint8Array): Promise<void> {
  if (openCollectionPromise) return openCollectionPromise

  openCollectionPromise = (async () => {
    const mod = await loadModule()
    const rc = withWasmBuffer(mod, bytes, (ptr, len) => mod._wasm_open_collection(ptr, len))
    if (rc !== 0) {
      throw new Error(`wasm_open_collection failed (${rc}): ${readLastError(mod)}`)
    }
  })()

  try {
    await openCollectionPromise
  } catch (err) {
    openCollectionPromise = null
    throw err
  }
  return openCollectionPromise
}

/**
 * Reads the collection's *current* bytes back out of Emscripten's virtual FS
 * (MEMFS) at `COLLECTION_PATH`. Callers should persist the result to OPFS
 * after `openCollection` and after any mutating call (`answerCard`) — nothing
 * survives a reload otherwise, since MEMFS is purely in-memory.
 *
 * Checkpoints the SQLite WAL into the main file *first*. rslib opens
 * collections in WAL mode with exclusive locking (see
 * rust/wasm-bridge/src/main.rs `wasm_checkpoint` and docs/ARCHITECTURE.md §15),
 * so mutations (import, deck selection, answering) land in a `-wal` sidecar
 * that this read — and therefore OPFS — never captures. Without the flush the
 * persisted bytes are a stale earlier snapshot, and a reload silently reverts
 * (e.g. current-deck falls back to Default, showing the bundled starter card).
 */
export async function readCollectionBytes(): Promise<Uint8Array> {
  const mod = await loadModule()
  const cp = mod._wasm_checkpoint()
  if (cp !== 0) {
    throw new Error(`wasm_checkpoint failed (${cp}): ${readLastError(mod)}`)
  }
  const view = mod.FS.readFile(COLLECTION_PATH)
  // Defensive copy: `view` may be backed by wasm linear memory that a later
  // call (or a memory-growth reallocation) could invalidate.
  return new Uint8Array(view)
}

/**
 * Reads the media sync tracking database's *current* bytes back out of
 * Emscripten's virtual FS at `MEDIA_DB_PATH` — the same idea as
 * `readCollectionBytes`, but for the completely separate database the media
 * sync protocol uses to remember `last_sync_usn` and each file's last-known
 * mtime/checksum (see `syncMedia`'s doc comment). Persisting this to OPFS
 * (`persistMediaDb()` in db/collection.ts) and restoring it on the next
 * session is what lets a repeat "Sync now" pick up from where the last one
 * left off instead of re-fetching the server's entire media change history
 * from scratch every time.
 *
 * Returns `null` if no media sync (or import) has touched the database yet
 * this collection's lifetime — not an error, just "nothing to persist".
 * Checkpoints the WAL first via `wasm_checkpoint_media_db`, mirroring
 * `readCollectionBytes` (see rust/wasm-bridge/src/main.rs for why the
 * short-lived `MediaManager` connection used for sync/import doesn't already
 * guarantee this).
 */
export async function readMediaDbBytes(): Promise<Uint8Array | null> {
  const mod = await loadModule()
  const cp = mod._wasm_checkpoint_media_db()
  if (cp !== 0) {
    throw new Error(`wasm_checkpoint_media_db failed (${cp}): ${readLastError(mod)}`)
  }
  try {
    const view = mod.FS.readFile(MEDIA_DB_PATH)
    return new Uint8Array(view)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Restores previously-persisted media tracking database bytes into
 * Emscripten's virtual FS at `MEDIA_DB_PATH`, before the first `col.media()`
 * call of this session opens (and would otherwise create empty) that path.
 * Call once during collection bootstrap, after `openCollection` (which
 * creates `MEDIA_DB_PATH`'s parent directory).
 */
export async function writeMediaDbBytes(bytes: Uint8Array): Promise<void> {
  const mod = await loadModule()
  mod.FS.writeFile(MEDIA_DB_PATH, bytes)
}

/**
 * Imports an Anki package (`.apkg`) into the already-open collection.
 * Requires `openCollection` to have succeeded first. Notably imports with
 * `with_scheduling: false` (rslib's `ImportAnkiPackageOptions::default()`),
 * so imported cards come in fresh/new rather than preserving the source
 * deck's original due dates/intervals — see rust/wasm-bridge/src/main.rs.
 *
 * Callers should call `persistCollection()` afterwards (same as after
 * `answerCard`) — this only mutates Emscripten's in-memory FS.
 */
export async function importApkg(bytes: Uint8Array): Promise<void> {
  const mod = await loadModule()
  const rc = withWasmBuffer(mod, bytes, (ptr, len) => mod._wasm_import_apkg(ptr, len))
  if (rc !== 0) {
    throw new Error(`wasm_import_apkg failed (${rc}): ${readLastError(mod)}`)
  }
}

/** Lists every deck in the open collection, including the built-in "Default"
 * deck (id 1n). */
export async function listDecks(): Promise<Deck[]> {
  const mod = await loadModule()
  const rc = mod._wasm_list_decks()
  if (rc !== 0) {
    throw new Error(`wasm_list_decks failed (${rc}): ${readLastError(mod)}`)
  }
  const pairs = JSON.parse(readLastResult(mod)) as [string, string][]
  return pairs.map(([id, name]) => ({ id: BigInt(id), name }))
}

/** Raw JSON shape `wasm_get_deck_tree` writes (`deckId` as a string, same
 * `Number.MAX_SAFE_INTEGER` concern as `listDecks`/`Deck.id`). */
interface RawDeckTreeNode {
  deckId: string
  name: string
  newCount: number
  learnCount: number
  reviewCount: number
  collapsed: boolean
  filtered: boolean
  children: RawDeckTreeNode[]
}

function parseDeckTreeNode(raw: RawDeckTreeNode): DeckTreeNode {
  return {
    ...raw,
    deckId: BigInt(raw.deckId),
    children: raw.children.map(parseDeckTreeNode),
  }
}

/**
 * Fetches the full deck tree (names + due counts, nested by `::` hierarchy),
 * matching real Anki's deck overview screen. The top-level returned node is
 * itself synthetic (rslib's internal tree root, not a real deck) — its own
 * `deckId`/`name`/counts are meaningless; iterate `children` for the actual
 * top-level decks.
 */
export async function getDeckTree(): Promise<DeckTreeNode> {
  const mod = await loadModule()
  const rc = mod._wasm_get_deck_tree()
  if (rc !== 0) {
    throw new Error(`wasm_get_deck_tree failed (${rc}): ${readLastError(mod)}`)
  }
  return parseDeckTreeNode(JSON.parse(readLastResult(mod)) as RawDeckTreeNode)
}

/**
 * Fetches summary statistics for the whole collection (headline numbers only
 * — see `Stats`'s doc comment for why this isn't the full chart-data payload).
 */
export async function getStats(): Promise<Stats> {
  const mod = await loadModule()
  const rc = mod._wasm_get_stats()
  if (rc !== 0) {
    throw new Error(`wasm_get_stats failed (${rc}): ${readLastError(mod)}`)
  }
  return JSON.parse(readLastResult(mod)) as Stats
}

/**
 * Resets every card back to "new" and deletes all review history, keeping
 * every imported deck/note/card — see `wasm_reset_progress`'s doc comment in
 * rust/wasm-bridge/src/main.rs for exactly what this does and doesn't touch.
 * Callers must still `persistCollection()` afterward, same as every other
 * mutating call in this app.
 */
export async function resetProgress(): Promise<void> {
  const mod = await loadModule()
  const rc = mod._wasm_reset_progress()
  if (rc !== 0) {
    throw new Error(`wasm_reset_progress failed (${rc}): ${readLastError(mod)}`)
  }
}

/**
 * Selects which deck `getNextCard`'s queue-building is scoped to. Without
 * ever calling this, the bridge silently studies whatever deck the
 * collection's `curDeck` config happens to point at (the built-in "Default"
 * deck, id 1n, for a freshly-imported collection) — see
 * docs/ARCHITECTURE.md §9/§10 for the real bug this caused.
 */
export async function setCurrentDeck(deckId: bigint): Promise<void> {
  const mod = await loadModule()
  const rc = mod._wasm_set_current_deck(deckId)
  if (rc !== 0) {
    throw new Error(`wasm_set_current_deck failed (${rc}): ${readLastError(mod)}`)
  }
}

/**
 * Deletes a deck **and all of its child decks**, plus every card (and any
 * note left with no cards) in all of them — this cascades, matching real
 * Anki's own behaviour (rslib has no "this deck only" delete mode). If the
 * deleted deck was selected, the bridge falls back to the Default deck on
 * its own next time `getNextCard` is called — callers don't need to also
 * call `setCurrentDeck` afterward.
 */
export async function deleteDeck(deckId: bigint): Promise<void> {
  const mod = await loadModule()
  const rc = mod._wasm_delete_deck(deckId)
  if (rc !== 0) {
    throw new Error(`wasm_delete_deck failed (${rc}): ${readLastError(mod)}`)
  }
}

/**
 * Lists the open collection's media filenames (audio/images referenced by
 * note fields). These live in Emscripten's in-memory FS, written there by
 * `import_apkg` — enumerate them right after an import so the JS layer can
 * copy each into OPFS (MEMFS is wiped on reload). Returns `[]` if there is no
 * media.
 */
export async function listMediaFiles(): Promise<string[]> {
  const mod = await loadModule()
  const rc = mod._wasm_list_media_files()
  if (rc !== 0) {
    throw new Error(`wasm_list_media_files failed (${rc}): ${readLastError(mod)}`)
  }
  return JSON.parse(readLastResult(mod)) as string[]
}

/**
 * Scans for unused/missing media files, exactly like real Anki desktop's
 * Tools → Check Media (this is rslib's `Collection::media_checker().check()`).
 * Purely a local disk scan — no network. Returns the report the desktop dialog
 * would show plus the headline counts.
 *
 * Real side effect (same as desktop): the scan renames any non-NFC-normalized
 * or illegally-named files on disk as it goes. That's rslib behaviour, not a
 * bug — callers should `persistMediaDb`/persist media after if they care about
 * those renames surviving a reload.
 */
export async function checkMedia(): Promise<MediaCheckReport> {
  const mod = await loadModule()
  const rc = mod._wasm_check_media()
  if (rc !== 0) {
    throw new Error(`wasm_check_media failed (${rc}): ${readLastError(mod)}`)
  }
  return JSON.parse(readLastResult(mod)) as MediaCheckReport
}

/**
 * Deletes every currently-unused (unreferenced) media file — the explicit
 * second step of Check Media. This is rslib's `MediaManager::remove_files`,
 * which both physically deletes the files AND marks their media-DB entries
 * `sha1: None, sync_required: true`, so the deletion propagates to the server
 * on the next media sync. Returns the deleted filenames so the caller can also
 * remove them from OPFS (see `checkAndDeleteUnusedMedia` in db/collection.ts,
 * which ties OPFS + media-DB persistence together).
 */
export async function deleteUnusedMedia(): Promise<string[]> {
  const mod = await loadModule()
  const rc = mod._wasm_delete_unused_media()
  if (rc !== 0) {
    throw new Error(`wasm_delete_unused_media failed (${rc}): ${readLastError(mod)}`)
  }
  return JSON.parse(readLastResult(mod)) as string[]
}

/**
 * Reads a single media file's raw bytes out of Emscripten's in-memory FS.
 * Throws if the file doesn't exist there (e.g. after a reload, before it has
 * been restored) — callers that persist to OPFS should catch and skip, or
 * read from OPFS instead.
 */
export async function readMediaFile(name: string): Promise<Uint8Array> {
  const mod = await loadModule()
  const nameBytes = new TextEncoder().encode(name)
  const rc = withWasmBuffer(mod, nameBytes, (ptr, len) => mod._wasm_read_media_file(ptr, len))
  if (rc !== 0) {
    throw new Error(`wasm_read_media_file(${name}) failed (${rc}): ${readLastError(mod)}`)
  }
  return readLastResultBytes(mod)
}

/**
 * Writes a single media file's raw bytes into Emscripten's in-memory FS
 * (creating the media folder if needed). Used to restore media from OPFS on
 * load so rslib operations that touch media stay consistent. Card rendering
 * itself doesn't need this (it only emits filenames), so display can be served
 * straight from OPFS — see docs/ARCHITECTURE.md §13.
 */
export async function writeMediaFile(name: string, bytes: Uint8Array): Promise<void> {
  const mod = await loadModule()
  const nameBytes = new TextEncoder().encode(name)
  const rc = withWasmBuffer(mod, nameBytes, (namePtr, nameLen) =>
    withWasmBuffer(mod, bytes, (dataPtr, dataLen) =>
      mod._wasm_write_media_file(namePtr, nameLen, dataPtr, dataLen),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_write_media_file(${name}) failed (${rc}): ${readLastError(mod)}`)
  }
}

export async function getNextCard(): Promise<BackendCard | null> {
  const mod = await loadModule()
  const id = mod._wasm_get_next_card()
  if (id === -1n) return null // queue empty — a correct, non-error result.
  if (id < 0n) {
    throw new Error(`wasm_get_next_card failed (${id}): ${readLastError(mod)}`)
  }
  return { id: Number(id) }
}

/** Renders the card most recently returned by `getNextCard` — call this
 * right after a successful `getNextCard()` (it renders whatever the bridge's
 * `LAST_CARD` slot currently holds; there's no card-id parameter). */
export async function getCurrentCardContent(): Promise<CardContent> {
  const mod = await loadModule()
  const rc = mod._wasm_render_current_card()
  if (rc !== 0) {
    throw new Error(`wasm_render_current_card failed (${rc}): ${readLastError(mod)}`)
  }
  return JSON.parse(readLastResult(mod)) as CardContent
}

export async function answerCard(ease: number): Promise<void> {
  const mod = await loadModule()
  const rc = mod._wasm_answer_card(ease)
  if (rc !== 0) {
    throw new Error(`wasm_answer_card failed (${rc}): ${readLastError(mod)}`)
  }
}

/**
 * Thrown by `syncCollection` when the server reports the collection needs a
 * full upload/download rather than an incremental sync (e.g. the very first
 * sync of a fresh collection, or after a schema-breaking change) — rslib's
 * `SyncActionRequired::FullSyncRequired`. Full sync is deliberately out of
 * scope for this pass (see rust/wasm-bridge/src/main.rs `wasm_sync_collection`,
 * docs/ARCHITECTURE.md §20); distinguishing this from a generic `Error` lets
 * the UI show an actionable message instead of a raw status code.
 */
export class FullSyncRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullSyncRequiredError'
  }
}

/** How often to re-check `wasm_sync_poll` while a login/sync runs on the
 * bridge's background thread. A sync round-trip is a real network operation
 * (tens to hundreds of ms at best), so this is plenty responsive without
 * busy-waiting. */
const SYNC_POLL_INTERVAL_MS = 100

/**
 * Live progress for whichever sync is currently running — see
 * `wasm_sync_progress_json`'s doc comment in rust/wasm-bridge/src/main.rs
 * for the full shape/semantics of each variant. `normal_sync`/`media_sync`
 * report running counts with no fixed total (the protocols are incremental
 * round-trips, not one bulk transfer of a known size); `full_sync` reports
 * real transferred/total byte counts, since `syncFullDownload`/
 * `syncFullUpload` move one file of a known size.
 */
export type SyncProgress =
  | {
      kind: 'normal_sync'
      stage: 'connecting' | 'syncing' | 'finalizing'
      localUpdate: number
      localRemove: number
      remoteUpdate: number
      remoteRemove: number
    }
  | {
      kind: 'media_sync'
      checked: number
      downloadedFiles: number
      downloadedDeletions: number
      uploadedFiles: number
      uploadedDeletions: number
    }
  | { kind: 'full_sync'; transferredBytes: number; totalBytes: number }
  | { kind: 'other' }

/** Reads the latest sync progress snapshot, or `null` if none has been
 * reported yet (e.g. polled before the background thread got far enough to
 * construct its progress handler — not an error, just "nothing new"). */
function readSyncProgress(mod: EmscriptenModule): SyncProgress | null {
  const rc = mod._wasm_sync_progress_json()
  if (rc !== 0) return null
  return JSON.parse(readLastResult(mod)) as SyncProgress
}

/**
 * Awaits the in-flight sync started by `wasm_sync_login`/`wasm_sync_collection`
 * — see the doc comment atop those bridge exports (rust/wasm-bridge/src/main.rs)
 * for why this must be a poll rather than the wasm call itself blocking:
 * the actual HTTP I/O runs synchronously on a background thread inside the
 * bridge (Emscripten's `emscripten_fetch` in its synchronous mode), so the
 * `wasm_sync_*` entry points return immediately and JS polls to avoid
 * blocking the browser's main thread.
 *
 * `onProgress`, if given, is called with each poll tick's progress snapshot
 * (skipped if none is available yet) — reuses this same poll loop rather
 * than running a second interval alongside it.
 */
async function pollSyncUntilDone(
  mod: EmscriptenModule,
  onProgress?: (progress: SyncProgress) => void,
): Promise<void> {
  for (;;) {
    const state = mod._wasm_sync_poll()
    if (state === 2) return
    if (state === 1) {
      if (onProgress) {
        const progress = readSyncProgress(mod)
        if (progress) onProgress(progress)
      }
      await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_INTERVAL_MS))
      continue
    }
    if (state === -100) {
      throw new FullSyncRequiredError(
        `server requires a full upload/download (not yet supported in this build): ${readLastError(mod)}`,
      )
    }
    throw new Error(`sync failed (${state}): ${readLastError(mod)}`)
  }
}

/**
 * Logs in to a sync server and returns the resulting sync key ("hkey") —
 * rslib's real `anki::sync::login::sync_login`. `endpoint` empty/blank means
 * official AnkiWeb; a non-empty URL (`http://` or `https://`) targets a
 * self-hosted `anki-sync-server` instead — both are genuinely supported (see
 * rust/wasm-bridge/src/main.rs `wasm_sync_login`'s `parse_endpoint`). The
 * caller is responsible for persisting the returned hkey (this module has no
 * session concept of its own) for later `syncCollection` calls.
 */
export async function syncLogin(
  username: string,
  password: string,
  endpoint: string,
): Promise<string> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const usernameBytes = encoder.encode(username)
  const passwordBytes = encoder.encode(password)
  const endpointBytes = encoder.encode(endpoint)

  const rc = withWasmBuffer(mod, usernameBytes, (usernamePtr, usernameLen) =>
    withWasmBuffer(mod, passwordBytes, (passwordPtr, passwordLen) =>
      withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
        mod._wasm_sync_login(
          usernamePtr,
          usernameLen,
          passwordPtr,
          passwordLen,
          endpointPtr,
          endpointLen,
        ),
      ),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_sync_login failed to start (${rc}): ${readLastError(mod)}`)
  }
  await pollSyncUntilDone(mod)
  return readLastResult(mod)
}

/**
 * Runs a real normal sync (rslib's `NormalSyncer::sync`, unmodified sync
 * protocol logic) against `endpoint` (empty → official AnkiWeb) using a
 * previously obtained `hkey` (see `syncLogin`). Resolves once the sync
 * completes with no remote changes or a successful incremental sync; throws
 * `FullSyncRequiredError` if the server demands a full upload/download — see
 * `syncFullDownload`/`syncFullUpload` for that case — or a plain `Error` for
 * any other failure (auth expired, network error, sanity-check mismatch,
 * etc). A sync can change local cards/notes/decks just like an import or an
 * answer does, so callers must still call `persistCollection()` afterwards.
 */
export async function syncCollection(
  hkey: string,
  endpoint: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<void> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const hkeyBytes = encoder.encode(hkey)
  const endpointBytes = encoder.encode(endpoint)

  const rc = withWasmBuffer(mod, hkeyBytes, (hkeyPtr, hkeyLen) =>
    withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
      mod._wasm_sync_collection(hkeyPtr, hkeyLen, endpointPtr, endpointLen),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_sync_collection failed to start (${rc}): ${readLastError(mod)}`)
  }
  await pollSyncUntilDone(mod, onProgress)
}

/**
 * Full download: replaces the local collection wholesale with the server's
 * copy — the real Anki desktop "first sync" dialog's "Download from server"
 * choice, for when the server is already authoritative (e.g. already synced
 * from desktop Anki). **Destructive to local data** — any local-only changes
 * are lost. Callers must still call `persistCollection()` afterwards (the
 * bridge only replaces its own in-memory-FS copy of the file; nothing is
 * written to OPFS until then), and should probably re-fetch anything they
 * were showing (decks, current card, stats) since the collection underneath
 * has been swapped out entirely.
 */
export async function syncFullDownload(
  hkey: string,
  endpoint: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<void> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const hkeyBytes = encoder.encode(hkey)
  const endpointBytes = encoder.encode(endpoint)

  const rc = withWasmBuffer(mod, hkeyBytes, (hkeyPtr, hkeyLen) =>
    withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
      mod._wasm_sync_full_download(hkeyPtr, hkeyLen, endpointPtr, endpointLen),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_sync_full_download failed to start (${rc}): ${readLastError(mod)}`)
  }
  await pollSyncUntilDone(mod, onProgress)
}

/**
 * Full upload: replaces the *server's* collection wholesale with the local
 * copy — the real Anki desktop "first sync" dialog's "Upload to server"
 * choice, for when the local collection is authoritative. **Destructive to
 * remote data.** Same shape as `syncFullDownload` otherwise.
 */
export async function syncFullUpload(
  hkey: string,
  endpoint: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<void> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const hkeyBytes = encoder.encode(hkey)
  const endpointBytes = encoder.encode(endpoint)

  const rc = withWasmBuffer(mod, hkeyBytes, (hkeyPtr, hkeyLen) =>
    withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
      mod._wasm_sync_full_upload(hkeyPtr, hkeyLen, endpointPtr, endpointLen),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_sync_full_upload failed to start (${rc}): ${readLastError(mod)}`)
  }
  await pollSyncUntilDone(mod, onProgress)
}

/**
 * Syncs media (images/audio referenced by note fields) — a completely
 * separate protocol and server-side database from collection sync
 * (`syncCollection`/`syncFullDownload`/`syncFullUpload` only ever transfer
 * the `.anki2` file itself). Real Anki desktop always runs both under its
 * one "Sync" button; callers here should do the same — run this after a
 * successful collection sync/full-download/full-upload, since without it
 * notes can reference images/audio that were never actually fetched (the
 * collection data downloads fine; the files it points at don't, until this
 * runs too). Downloaded files land in the bridge's in-memory media folder —
 * call `persistMedia()` (`db/collection.ts`) afterwards to copy them to OPFS,
 * exactly as already done after `importApkg`.
 */
export async function syncMedia(
  hkey: string,
  endpoint: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<void> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const hkeyBytes = encoder.encode(hkey)
  const endpointBytes = encoder.encode(endpoint)

  const rc = withWasmBuffer(mod, hkeyBytes, (hkeyPtr, hkeyLen) =>
    withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
      mod._wasm_sync_media(hkeyPtr, hkeyLen, endpointPtr, endpointLen),
    ),
  )
  if (rc !== 0) {
    throw new Error(`wasm_sync_media failed to start (${rc}): ${readLastError(mod)}`)
  }
  await pollSyncUntilDone(mod, onProgress)
}
