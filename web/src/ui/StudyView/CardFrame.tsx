import { useEffect, useRef, useState } from 'react'

/**
 * Renders a card's question/answer HTML + the notetype's own CSS inside a
 * sandboxed `<iframe srcDoc>`, instead of `dangerouslySetInnerHTML` directly
 * into the page.
 *
 * Why an iframe instead of scoping/prefixing the CSS selectors ourselves:
 * notetype stylesheets are written assuming they own the whole page (classic
 * Anki convention: `.card { ... }` wraps the rendered content, but real-world
 * decks (confirmed against an actual downloaded deck) also contain much
 * broader rules — `.mobile .disabled`, bare element selectors, etc.
 * Correctly rewriting arbitrary author CSS (nested at-rules, comma-separated
 * selector lists, `@media`/`@keyframes`, attribute selectors, comments...) to
 * safely scope it is a genuinely fiddly parsing problem. An iframe gives
 * perfect isolation for free: the notetype's CSS and any inline styles can
 * never leak out and restyle our own app chrome, and our own Tailwind
 * classes can never bleed in and change how the card looks. `sandbox`
 * deliberately does NOT include `allow-scripts` — real-world card templates
 * can and do embed `<script>` tags (confirmed: one real imported card ships
 * a text-to-speech `<script>` block) and we don't want arbitrary script
 * execution from imported deck content. `allow-same-origin` is kept so the
 * parent can read `contentDocument.body.scrollHeight` to auto-size the
 * iframe (srcDoc content is normally treated as same-origin with the parent
 * anyway, but sandboxing without this flag would force it to "null" origin
 * and block that read).
 *
 * Known gap: note fields may reference collection media (`<img src="...">`)
 * — media files aren't persisted/served anywhere yet, so images show
 * broken. Out of scope for this pass (see docs/ARCHITECTURE.md §10.5/§11).
 */
export default function CardFrame({ html, css }: { html: string; css: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)

  // Real Anki wraps rendered content in `<div class="card">` (classic
  // convention many notetype stylesheets assume, e.g. `.card { font-family: ... }`).
  const srcDoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 16px; }
</style>
<style>${css}</style>
</head>
<body class="card">${html}</body>
</html>`

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const resize = () => {
      const doc = iframe.contentDocument
      if (doc?.body) setHeight(Math.max(doc.body.scrollHeight, 80))
    }
    iframe.addEventListener('load', resize)
    return () => iframe.removeEventListener('load', resize)
  }, [srcDoc])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      title="Card content"
      className="w-full rounded-lg border-0"
      style={{ height }}
    />
  )
}
