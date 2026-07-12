# cors-proxy

A minimal, dependency-free local reverse proxy that adds CORS headers in
front of a self-hosted `anki-sync-server`.

## Why you need this

The official `anki-sync-server` (and any self-hosted build derived from
rslib's `http_server` module) sends no `Access-Control-Allow-*` response
headers — it was only ever built to be called from the native Anki
desktop/mobile clients, which don't enforce CORS. CleanAnki's sync client
runs in a browser, and only browsers enforce CORS, so a direct request from
CleanAnki to your self-hosted server is blocked before the app ever sees a
response:

```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the
remote resource at http://<your-server>/sync/hostKey. (Reason: CORS request
failed). Status code: (null).
```

This is not something CleanAnki (or any browser-based Anki client) can work
around from the client side — the server has to send the right headers, and
it doesn't. Official AnkiWeb sync works from a browser context only because
AnkiWeb's own infrastructure presumably handles this; a self-hosted server
does not.

Two ways to fix it — pick whichever you're more comfortable running. Both do
the same thing: add the missing `Access-Control-Allow-*` headers in front of
your real server.

## Option 1: the Node script (`proxy.mjs`)

No dependencies beyond Node itself.

```bash
node tools/cors-proxy/proxy.mjs
# or, to point at a different server/port:
SYNC_SERVER=http://192.168.178.4:8081 PORT=8082 node tools/cors-proxy/proxy.mjs
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
