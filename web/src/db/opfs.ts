// Helpers for storing the Anki collection blob in the Origin Private File
// System (OPFS).
//
// Phase 1 simplification (deliberate, not an oversight): the wasm-bridge
// backend works with the collection as a single in-memory blob, so these
// helpers only support reading/writing a file's *entire* contents at once.
// There is no incremental/streaming read-write, no partial-write recovery,
// and no locking beyond what OPFS itself provides. That's fine for Phase 1
// (a single tab, whole-collection load/save around study sessions) but will
// need revisiting before this scales to large collections or multi-tab use —
// at that point look at FileSystemSyncAccessHandle from a dedicated worker
// for random-access reads/writes instead of always shuttling the whole file.

/** Returns the root directory handle of the origin-private filesystem. */
export async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

/** Returns true if `fileName` exists at the root of OPFS. */
export async function opfsFileExists(fileName: string): Promise<boolean> {
  const root = await getOpfsRoot()
  try {
    await root.getFileHandle(fileName)
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return false
    }
    throw err
  }
}

/**
 * Opens (creating it if necessary) a file at the root of OPFS and returns its
 * handle. Does not read or write any data.
 */
export async function openOrCreateOpfsFile(fileName: string): Promise<FileSystemFileHandle> {
  const root = await getOpfsRoot()
  return root.getFileHandle(fileName, { create: true })
}

/**
 * Reads the *entire* contents of an OPFS file into memory.
 *
 * Throws if the file does not exist — callers that want create-on-read
 * semantics should check `opfsFileExists` (or catch and treat a missing file
 * as "no collection yet") first.
 */
export async function readOpfsFile(fileName: string): Promise<Uint8Array> {
  const root = await getOpfsRoot()
  const fileHandle = await root.getFileHandle(fileName)
  const file = await fileHandle.getFile()
  const buffer = await file.arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * Replaces the *entire* contents of an OPFS file with `data`, creating the
 * file first if it doesn't exist. This is a full overwrite, not an
 * incremental update — see the module-level note above.
 */
export async function writeOpfsFile(fileName: string, data: Uint8Array): Promise<void> {
  const fileHandle = await openOrCreateOpfsFile(fileName)
  // `createWritable` truncates any existing content by default
  // (keepExistingData defaults to false), which is exactly the "replace
  // whole file" semantics this Phase 1 helper promises.
  const writable = await fileHandle.createWritable()
  try {
    // Copy into a plain (non-shared) ArrayBuffer-backed view: `data` is
    // typed as a general `Uint8Array` and callers may hand us a view over a
    // SharedArrayBuffer (plausible here, given the wasm side uses pthread
    // emulation), but the File System Access API's write() only accepts
    // views backed by a real ArrayBuffer.
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    await writable.write(copy)
  } finally {
    await writable.close()
  }
}

/** Deletes a file at the root of OPFS if it exists. No-op if it doesn't. */
export async function deleteOpfsFile(fileName: string): Promise<void> {
  const root = await getOpfsRoot()
  try {
    await root.removeEntry(fileName)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Collection media (audio/images) — one file per media filename under a
// `media/` subdirectory of the OPFS root.
//
// This is the persistence layer the collection *database* helpers above lack:
// the wasm backend's media lives on Emscripten's in-memory FS, which is wiped
// on every reload, so after an import we copy each media file here, and the
// card renderer reads from here to build data: URLs for <img>/<audio>. See
// docs/ARCHITECTURE.md §13.
// ---------------------------------------------------------------------------

/** Name of the OPFS subdirectory holding collection media files. */
const MEDIA_DIR_NAME = 'media'

/** Minimal structural type for the async-iterable directory handle — the
 * ambient DOM lib in this project doesn't declare `entries()`/`keys()` on
 * `FileSystemDirectoryHandle`, though every OPFS-capable browser implements
 * them (the handle is async-iterable). */
interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>
}

async function getMediaDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  const root = await getOpfsRoot()
  try {
    return await root.getDirectoryHandle(MEDIA_DIR_NAME, { create })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return null // only reachable with create=false
    }
    throw err
  }
}

/** Writes (overwriting) a single media file into the OPFS `media/` directory. */
export async function writeOpfsMediaFile(name: string, data: Uint8Array): Promise<void> {
  const dir = (await getMediaDir(true))!
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    // Same shared-buffer caveat as writeOpfsFile: copy into a plain
    // ArrayBuffer-backed view (the bytes may come from the pthread-backed,
    // SharedArrayBuffer-backed wasm heap, which write() rejects).
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    await writable.write(copy)
  } finally {
    await writable.close()
  }
}

/** Reads a single media file from OPFS `media/`, or `null` if it (or the
 * media directory) doesn't exist. */
export async function readOpfsMediaFile(name: string): Promise<Uint8Array | null> {
  const dir = await getMediaDir(false)
  if (!dir) return null
  try {
    const fileHandle = await dir.getFileHandle(name)
    const file = await fileHandle.getFile()
    return new Uint8Array(await file.arrayBuffer())
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return null
    }
    throw err
  }
}

/** Lists every media filename persisted in OPFS `media/` (empty if none). */
export async function listOpfsMediaFiles(): Promise<string[]> {
  const dir = await getMediaDir(false)
  if (!dir) return []
  const names: string[] = []
  for await (const name of (dir as IterableDirectoryHandle).keys()) {
    names.push(name)
  }
  return names
}
