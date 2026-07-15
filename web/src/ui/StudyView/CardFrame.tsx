import { useEffect, useRef, useState } from 'react'

/**
 * Renders a card's question/answer HTML + the notetype's own CSS inside a
 * sandboxed `<iframe srcDoc>`, instead of `dangerouslySetInnerHTML` directly
 * into the page.
 *
 * Why an iframe instead of scoping/prefixing the CSS selectors ourselves:
 * notetype stylesheets are written assuming they own the whole page (classic
 * Anki convention: `.card { ... }` wraps the rendered content), but real-world
 * decks (confirmed against an actual downloaded deck) also contain much
 * broader rules — `.mobile .disabled`, bare element selectors, etc.
 * Correctly rewriting arbitrary author CSS (nested at-rules, comma-separated
 * selector lists, `@media`/`@keyframes`, attribute selectors, comments...) to
 * safely scope it is a genuinely fiddly parsing problem. An iframe gives
 * perfect isolation for free.
 *
 * Sandbox: `allow-scripts` WITHOUT `allow-same-origin`. Real deck templates
 * embed real `<script>` (text-to-speech, dynamically-generated text, and
 * expand-for-more "hint" toggles wired via inline `onclick`), and the user
 * opted in to running them (same trust model as real Anki desktop/mobile,
 * which don't sandbox note-content JS either — you chose to import the deck).
 * `allow-same-origin` is deliberately omitted: combined with `allow-scripts`
 * it would let embedded script reach `window.parent` and drive the real app
 * (a well-known sandbox-escape), so we leave it off, giving the iframe an
 * opaque origin — scripts run but are walled off from the parent entirely.
 *
 * Because the iframe is now cross-origin, the parent can no longer read
 * `iframe.contentDocument.body.scrollHeight` to auto-size it. Instead a small
 * measuring script (injected into `srcDoc` ahead of the note's own content)
 * reports the document height to the parent via `postMessage`, re-measuring on
 * a `ResizeObserver` so late-loading media/scripts that change the layout are
 * accounted for. See docs/ARCHITECTURE.md §14.
 *
 * Media (`<img>`/`<audio>`) uses inline `data:` URLs (see media.ts), which load
 * fine in an opaque-origin iframe (unlike blob: URLs, which are origin-scoped).
 */

/** Distinguishable shape so the parent's `message` listener doesn't react to
 * unrelated postMessage traffic (analytics pings, other embeds, etc.). */
const RESIZE_MESSAGE_SOURCE = 'anki-card-frame'

/** Runs inside the sandboxed iframe. Measures the document height and reports
 * it to the parent. Re-measures on load and on any layout change (images/audio
 * metadata arriving, deck scripts mutating the DOM) via ResizeObserver. */
const RESIZE_SCRIPT = `
(function () {
  function height() {
    var b = document.body, d = document.documentElement;
    return Math.max(
      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0,
      d ? d.scrollHeight : 0, d ? d.offsetHeight : 0
    );
  }
  var last = -1;
  function report() {
    var h = height();
    if (h === last) return;
    last = h;
    parent.postMessage({ source: '${RESIZE_MESSAGE_SOURCE}', height: h }, '*');
  }
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  // iOS Safari (especially once installed as a standalone PWA) commonly
  // finishes loading @font-face fonts *after* the load event — the
  // ResizeObserver below normally catches the resulting reflow, but iOS has
  // also been seen to suspend/coalesce observer callbacks while a view is
  // backgrounded, so this is a second, more direct signal for exactly the
  // one layout shift most likely to be missed.
  if (typeof document.fonts !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(report).catch(function () {});
  }
  // Standalone iOS PWAs suspend timers/rAF while the view is backgrounded
  // (app-switch, screen lock) and can resume with a stale measurement from
  // before whatever caused the backgrounding — re-measure on the two events
  // WebKit actually fires when a bfcache'd/backgrounded view becomes visible
  // again, not just on the initial load.
  window.addEventListener('pageshow', report);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') report();
  });
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
  }
  report();
  // A few delayed re-measures catch async media/script layout shifts even in
  // engines where the observers/events above don't fire as expected.
  setTimeout(report, 100);
  setTimeout(report, 500);
  setTimeout(report, 1500);
})();
`

export default function CardFrame({ html, css }: { html: string; css: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)

  // Real Anki wraps rendered content in `<div class="card">` (classic
  // convention many notetype stylesheets assume, e.g. `.card { font-family: ... }`).
  const srcDoc = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 16px; }
  /* Real note images/audio widgets often have no sizing rules of their own
     (confirmed against real decks — e.g. a bare <img src="logo.jpg"> at its
     full native resolution) and would otherwise overflow the card's width,
     forcing it into a horizontally-scrolling box instead of scaling down to
     fit. box-sizing keeps the 16px padding above from adding to that overflow.
     These are defaults, not !important — a notetype's own <style> below is
     free to override them for a specific card if it explicitly sets its own
     image dimensions. */
  * { box-sizing: border-box; }
  img, video { max-width: 100%; height: auto; }
  audio { max-width: 100%; }
  table { max-width: 100%; }
</style>
<style>${css}</style>
<script>${RESIZE_SCRIPT}</script>
</head>
<body class="card">${html}</body>
</html>`

  useEffect(() => {
    const iframe = iframeRef.current
    function onMessage(event: MessageEvent) {
      // The iframe is opaque-origin, so event.origin is "null" — we can't
      // validate by origin. Validate by (a) it came from *our* iframe's window
      // and (b) the distinguishable message shape instead.
      if (iframe && event.source !== iframe.contentWindow) return
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { source?: unknown }).source === RESIZE_MESSAGE_SOURCE &&
        typeof (data as { height?: unknown }).height === 'number'
      ) {
        setHeight(Math.max((data as { height: number }).height, 80))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      title="Card content"
      className="w-full rounded-lg border-0"
      style={{ height }}
    />
  )
}
