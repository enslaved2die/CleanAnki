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

## Usage

```bash
node tools/cors-proxy/proxy.mjs
# or, to point at a different server/port:
SYNC_SERVER=http://192.168.178.4:8081 PORT=8082 node tools/cors-proxy/proxy.mjs
```

Then in CleanAnki's Sync tab, check "Use custom sync server" and enter
`http://localhost:8082` (or whatever `PORT` you chose) instead of your real
server's address. The proxy forwards every request to `SYNC_SERVER`
unchanged and adds the CORS headers the browser needs to allow the response
through.

Leave this running in a terminal alongside `npm run dev` while you use the
Sync tab.
