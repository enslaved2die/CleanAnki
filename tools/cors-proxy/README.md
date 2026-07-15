# cors-proxy

A minimal, dependency-free local reverse proxy that adds CORS headers in
front of an Anki sync server — **official AnkiWeb included, not just
self-hosted servers.**

## Why you need this

The Anki sync protocol (`anki-sync-server`, any self-hosted build derived
from rslib's `http_server` module, and — confirmed directly, not assumed —
the real production AnkiWeb server itself) sends no `Access-Control-Allow-*`
response headers at all. It was only ever built to be called from the native
Anki desktop/mobile clients, which don't enforce CORS. CleanAnki's sync
client runs in a browser, and only browsers enforce CORS, so a direct
request to *any* Anki sync server — official or self-hosted — is blocked
before the app ever sees a response:

```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the
remote resource at https://sync.ankiweb.net/sync/hostKey. (Reason: CORS
request failed). Status code: (null).
```

(Verified directly against `sync.ankiweb.net`: it answers a CORS preflight
`OPTIONS` request with a bare `405 Method Not Allowed` and no CORS headers of
any kind — it doesn't even recognise `OPTIONS` as a real request, let alone
answer it the way a CORS-aware server would.)

This is not something CleanAnki (or any browser-based Anki client) can work
around from the client side — the server has to send the right headers, and
none of them do. **This means the proxy below is needed even for official
AnkiWeb** — just point its target at `https://sync.ankiweb.net` instead of a
self-hosted server's address; everything else works the same way.

Two ways to fix it — pick whichever you're more comfortable running. Both do
the same thing: add the missing `Access-Control-Allow-*` headers in front of
your real server.

## Option 1: the Node script (`proxy.mjs`)

No dependencies beyond Node itself.

```bash
node tools/cors-proxy/proxy.mjs
# or, to point at a self-hosted server:
SYNC_SERVER=http://192.168.178.4:8081 PORT=8082 node tools/cors-proxy/proxy.mjs
# or, to reach official AnkiWeb through the proxy instead:
SYNC_SERVER=https://sync.ankiweb.net PORT=8082 node tools/cors-proxy/proxy.mjs
```

Then in CleanAnki's Sync tab, check "Use custom sync server" and enter
`http://localhost:8082` (or whatever `PORT` you chose) instead of your real
server's address. Leave it running in a terminal alongside `npm run dev`
while you use the Sync tab.

## Option 2: nginx (`nginx/sync-cors-proxy.conf`)

If you'd rather use nginx — e.g. you're already running it, or running your
sync server (such as
[anki-sync-server-enhanced](https://github.com/chrislongros/anki-sync-server-enhanced))
in Docker and want another container/config alongside it — see
`nginx/sync-cors-proxy.conf`, a documented example config that does the same
job (and can also terminate TLS at the same time, if you want HTTPS too —
see the important note in that file: **TLS and CORS are two separate
problems**; enabling HTTPS alone, whether via nginx or a sync-server-bundled
option like `TLS_ENABLED`, does not fix the CORS error by itself, since CORS
is about response headers, not encryption).

Edit `upstream_sync_server` in that file to point at your real server, load
it into nginx, then point CleanAnki's "custom sync server" field at the
nginx instance's own address instead of your real server's.

## Already have a CORS config and it's still failing?

Hit in practice with an existing, otherwise-correct-looking nginx CORS
config (via Nginx Proxy Manager): if `Access-Control-Allow-Headers` is a
*fixed list*, make sure it includes `anki-sync` — that's the one custom
header the sync protocol actually sends (confirmed in the vendored rslib
source, `SYNC_HEADER_NAME`), not `Authorization`/`X-Anki-Version`/etc.,
which are harmless to also allow but don't help. A fixed list that omits it
looks like it should work (right domain, right port, `Access-Control-Allow-Origin`
present) but the browser will still reject the actual request, since the
preflight tells it `anki-sync` isn't an allowed header. Both example configs
in this directory sidestep this entirely by reflecting whatever the
browser's own preflight asks for (`$http_access_control_request_headers` in
nginx, `req.headers['access-control-request-headers']` in `proxy.mjs`)
instead of hardcoding a list.
