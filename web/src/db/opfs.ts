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
