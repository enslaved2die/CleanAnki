// Resolves collection-media references in rendered card HTML into inline,
// self-contained media the sandboxed <iframe> can actually load.
//
// The Rust bridge now returns card HTML verbatim (see docs/ARCHITECTURE.md
// §13): `[sound:file.mp3]`-style audio tokens and `<img src="file.jpg">`
// references are left intact instead of being stripped. This module:
//   * turns each `[sound:...]` token into a playable `<audio controls>` element
//   * rewrites each bare `<img>`/`<source>`/`<audio>`/`<video>` `src` (a media
//     filename) to point at the real bytes
//
// It uses **data: URLs**, not blob: URLs, on purpose. CardFrame renders card
// content in an iframe with `sandbox="allow-scripts"` and NO `allow-same-origin`
// (so untrusted deck scripts can run but can't reach the parent app) — that
// gives the iframe document an *opaque* origin, and blob: URLs are keyed to the
// origin that created them, so a parent-created blob: URL cannot be loaded from
// the opaque-origin iframe. data: URLs carry their bytes inline and are not
// origin-scoped, so they load regardless. They also need no revocation
// (a blob-URL lifetime concern that would otherwise leak across a study
// session), so there's nothing to clean up when moving to the next card.
//
// Bytes are read from OPFS (where media is persisted after import — see
// db/collection.ts `persistMedia`), not from the wasm backend's in-memory FS,
// so this works identically before and after a reload with no eager rehydration
// step. The byte source is injectable for unit testing.

import { readOpfsMediaFile } from '../../db/opfs'

/** Fetches raw bytes for a media filename, or `null` if it isn't available. */
export type MediaByteSource = (name: string) => Promise<Uint8Array | null>

const MIME_BY_EXT: Record<string, string> = {
  // audio
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  // images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
}

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/** True if `src` is a bare media filename (no scheme / not already resolved),
 * i.e. something we should try to look up in the media store. */
function isBareMediaRef(src: string): boolean {
  if (!src) return false
  return !/^(?:https?:|data:|blob:|file:|\/\/|\/|#)/i.test(src)
}

/** Media `src`/token values may be percent-encoded in the HTML (e.g. a space
 * as `%20`) while the file on disk has the literal name; decode, but fall back
 * to the raw string if it isn't valid percent-encoding. */
function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    // Copy into a plain ArrayBuffer-backed Blob part: `bytes` may be a view
    // over the pthread-backed SharedArrayBuffer wasm heap in some code paths.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    reader.readAsDataURL(new Blob([copy], { type: mime }))
  })
}

/**
 * Rewrites `html` so its media references resolve to inline data: URLs.
 * Returns the transformed HTML. References whose bytes can't be found are left
 * as-is for `<img>` (so a genuinely-missing image still shows the alt/broken
 * state rather than silently vanishing) and dropped for `[sound:...]` tokens
 * (there is no element to leave behind).
 *
 * `fetchMedia` defaults to reading from OPFS; injectable for tests.
 */
export async function resolveMediaInHtml(
  html: string,
  fetchMedia: MediaByteSource = readOpfsMediaFile,
): Promise<string> {
  const cache = new Map<string, string | null>()

  async function dataUrlFor(rawName: string): Promise<string | null> {
    const name = decodeName(rawName)
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    let url: string | null = null
    try {
      const bytes = await fetchMedia(name)
      if (bytes) url = await bytesToDataUrl(bytes, mimeFor(name))
    } catch {
      url = null
    }
    cache.set(name, url)
    return url
  }

  // Phase 1 — [sound:filename] tokens -> <audio controls>. Done on the raw
  // string (the tokens are plain text emitted by rslib), before any DOM parse.
  const soundRe = /\[sound:([^\]]+)\]/g
  const soundNames = [...new Set([...html.matchAll(soundRe)].map((m) => m[1]))]
  const soundUrls = new Map<string, string | null>()
  await Promise.all(
    soundNames.map(async (n) => {
      soundUrls.set(n, await dataUrlFor(n))
    }),
  )
  let out = html.replace(soundRe, (_full, name: string) => {
    const url = soundUrls.get(name)
    return url ? `<audio controls preload="metadata" src="${url}"></audio>` : ''
  })

  // Phase 2 — <img>/<source>/<audio>/<video> src="filename" -> data URL.
  // Parsing via DOMParser reads/writes the attribute robustly (attribute order,
  // quoting, entities). The <audio> elements just injected in phase 1 already
  // carry data: URLs, so isBareMediaRef skips them.
  const doc = new DOMParser().parseFromString(out, 'text/html')
  const els = Array.from(
    doc.querySelectorAll('img[src], source[src], audio[src], video[src]'),
  )
  await Promise.all(
    els.map(async (el) => {
      const src = el.getAttribute('src') ?? ''
      if (!isBareMediaRef(src)) return
      const url = await dataUrlFor(src)
      if (url) el.setAttribute('src', url)
    }),
  )

  return doc.body.innerHTML
}
