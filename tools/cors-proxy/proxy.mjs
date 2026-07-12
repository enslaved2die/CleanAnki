#!/usr/bin/env node
// A minimal, dependency-free local CORS-adding reverse proxy for a
// self-hosted `anki-sync-server`.
//
// Why this exists: the official anki-sync-server (and every self-hosted
// build of it derived from rslib's `http_server` module) sends no
// `Access-Control-Allow-*` response headers at all — it was only ever built
// to be called from the native Anki desktop/mobile clients, which don't
// enforce CORS. Only browsers do. CleanAnki's sync client runs in a browser
// (it's a PWA), so a direct cross-origin request to the sync server is
// blocked by the browser before the app ever sees a response — confirmed
// against a real server: "Cross-Origin Request Blocked ... CORS request
// failed. Status code: (null)." This isn't fixable from the browser side;
// the server (or something sitting in front of it) has to send the right
// headers. See docs/ARCHITECTURE.md for the full writeup.
//
// This proxy runs locally (same machine as your browser), forwards every
// request to your real sync server unchanged, and adds the CORS headers the
// browser needs to allow the response through. Point CleanAnki's "custom
// sync server" field at this proxy's address instead of the real server.
//
// Usage:
//   node tools/cors-proxy/proxy.mjs
//   SYNC_SERVER=http://192.168.178.4:8081 PORT=8082 node tools/cors-proxy/proxy.mjs
//
// Then in CleanAnki's Sync tab, use http://localhost:8082 (or whatever PORT
// you chose) as the sync server address — not the real server's address.

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

const TARGET = new URL(process.env.SYNC_SERVER ?? 'http://192.168.178.4:8081')
const PORT = Number(process.env.PORT ?? 8082)

function corsHeaders(req) {
  return {
    // Reflecting the request's own Origin (rather than a fixed value) means
    // this works regardless of which port `npm run dev` happens to pick.
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Reflect whatever headers the preflight asked about (the sync protocol
    // sends a custom `anki-sync` header) instead of hardcoding a list.
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
    'Access-Control-Max-Age': '86400',
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req))
    res.end()
    return
  }

  const targetUrl = new URL(req.url ?? '/', TARGET)
  const transport = targetUrl.protocol === 'https:' ? https : http
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const proxyReq = transport.request(
      targetUrl,
      {
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, {
          ...proxyRes.headers,
          ...corsHeaders(req),
        })
        proxyRes.pipe(res)
      },
    )
    proxyReq.on('error', (err) => {
      console.error(`[cors-proxy] upstream request failed: ${err.message}`)
      res.writeHead(502, corsHeaders(req))
      res.end(`cors-proxy: could not reach ${TARGET.origin}: ${err.message}`)
    })
    proxyReq.end(body)
  })
})

server.listen(PORT, () => {
  console.log(`[cors-proxy] listening on http://localhost:${PORT}`)
  console.log(`[cors-proxy] forwarding to ${TARGET.origin}`)
  console.log(`[cors-proxy] in CleanAnki's Sync tab, use http://localhost:${PORT} as the server address`)
})
