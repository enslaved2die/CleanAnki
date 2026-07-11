import { describe, it, expect } from 'vitest'
import { resolveMediaInHtml, type MediaByteSource } from '../../src/ui/StudyView/media'

// A tiny fake media store so these tests don't need OPFS/a browser. Values are
// arbitrary bytes — resolveMediaInHtml only cares that it gets *some* bytes for
// a known name and *null* for an unknown one.
function fakeStore(files: Record<string, Uint8Array>): MediaByteSource {
  return async (name: string) => files[name] ?? null
}

const IMG_BYTES = new Uint8Array([1, 2, 3, 4])
const SND_BYTES = new Uint8Array([5, 6, 7, 8])

describe('resolveMediaInHtml', () => {
  it('turns a [sound:...] token into a playable <audio> with a data: URL', async () => {
    const store = fakeStore({ 'hello.mp3': SND_BYTES })
    const out = await resolveMediaInHtml('front [sound:hello.mp3] back', store)
    expect(out).not.toContain('[sound:')
    expect(out).toMatch(/<audio[^>]+controls[^>]*>/i)
    expect(out).toMatch(/<audio[^>]+src="data:audio\/mpeg;base64,/i)
  })

  it('rewrites a bare <img src="file"> to a data: URL', async () => {
    const store = fakeStore({ 'pic.jpg': IMG_BYTES })
    const out = await resolveMediaInHtml('<img src="pic.jpg">', store)
    expect(out).toMatch(/<img[^>]+src="data:image\/jpeg;base64,/i)
  })

  it('decodes percent-encoded filenames before lookup', async () => {
    const store = fakeStore({ 'a b.png': IMG_BYTES })
    const out = await resolveMediaInHtml('<img src="a%20b.png">', store)
    expect(out).toMatch(/src="data:image\/png;base64,/i)
  })

  it('leaves already-resolved / external srcs untouched', async () => {
    const store = fakeStore({})
    const input = '<img src="https://example.com/x.png"><img src="data:image/png;base64,AAAA">'
    const out = await resolveMediaInHtml(input, store)
    expect(out).toContain('https://example.com/x.png')
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('drops a [sound:...] token whose file is missing (no element left behind)', async () => {
    const store = fakeStore({})
    const out = await resolveMediaInHtml('a [sound:gone.mp3] b', store)
    expect(out).not.toContain('[sound:')
    expect(out).not.toMatch(/<audio/i)
  })

  it('leaves a missing <img> reference as a bare filename (broken image, not vanished)', async () => {
    const store = fakeStore({})
    const out = await resolveMediaInHtml('<img src="missing.jpg">', store)
    expect(out).toMatch(/<img[^>]+src="missing\.jpg"/i)
  })

  it('resolves multiple references, fetching each unique file once', async () => {
    const fetched: string[] = []
    const source: MediaByteSource = async (name) => {
      fetched.push(name)
      return name === 'dup.mp3' ? SND_BYTES : null
    }
    const out = await resolveMediaInHtml('[sound:dup.mp3] and [sound:dup.mp3]', source)
    expect((out.match(/<audio/gi) ?? []).length).toBe(2)
    // Same file referenced twice, fetched once (cached).
    expect(fetched.filter((n) => n === 'dup.mp3').length).toBe(1)
  })
})
