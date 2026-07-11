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

/** Result of a sync attempt. `sync_with_server` is still a stub on the Rust
 * side (see docs/ARCHITECTURE.md §3/§6) — every call currently throws. */
export type SyncResult = never

/** A deck as returned by `listDecks` — `id` is a `bigint` because deck ids
 * are i64 creation-timestamps that can exceed `Number.MAX_SAFE_INTEGER`'s
 * exact range; `wasm_list_decks` deliberately encodes them as JSON strings
 * for exactly this reason (see rust/wasm-bridge/src/main.rs), parsed back
 * into `BigInt` here. */
export interface Deck {
  id: bigint
  name: string
}

/** Raw shape of the object Emscripten's MODULARIZE factory resolves to.
 * Only the pieces this module actually touches are declared. */
interface EmscriptenModule {
  HEAPU8: Uint8Array
  FS: {
    readFile(path: string): Uint8Array
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
  _wasm_import_apkg(ptr: number, len: number): number
  _wasm_list_decks(): number
  // `deck_id` is a genuine i64 parameter, not just an i64 return — confirmed
  // empirically (not just assumed) that -sWASM_BIGINT=1 marshals i64
  // *parameters* as native JS BigInt too, the same as it does for
  // wasm_get_next_card's i64 *return*. See docs/ARCHITECTURE.md §10.
  _wasm_set_current_deck(deckId: bigint): number
  _wasm_delete_deck(deckId: bigint): number
  _wasm_list_media_files(): number
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
  _wasm_sync_with_server(
    endpointPtr: number,
    endpointLen: number,
    tokenPtr: number,
    tokenLen: number,
  ): number
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

export async function syncWithServer(endpoint: string, token: string): Promise<SyncResult> {
  const mod = await loadModule()
  const encoder = new TextEncoder()
  const endpointBytes = encoder.encode(endpoint)
  const tokenBytes = encoder.encode(token)

  const rc = withWasmBuffer(mod, endpointBytes, (endpointPtr, endpointLen) =>
    withWasmBuffer(mod, tokenBytes, (tokenPtr, tokenLen) =>
      mod._wasm_sync_with_server(endpointPtr, endpointLen, tokenPtr, tokenLen),
    ),
  )
  // Still a stub on the Rust side — this always throws today. Kept as a real
  // exception (not a resolved "not implemented" value) so a caller can't
  // mistake it for success.
  throw new Error(`wasm_sync_with_server failed (${rc}): ${readLastError(mod)}`)
}
