# CleanAnki — Phase 1 Spike: Anki `rslib` → WebAssembly

**Question this spike answers:** can Anki's *real* Rust backend (`rslib`, from
`github.com/ankitects/anki`) be compiled to WebAssembly at all?

**Honest one-line answer so far:** *No — confirmed by a real compiler, not just
by reading source.* A Rust + Emscripten toolchain was installed and the actual
build was attempted. It gets ~250 crates deep into the dependency graph and
then fails hard: `mio` (pulled in transitively because `reqwest` needs
`tokio`'s `net` feature) refuses to compile for this wasm target at all. This
is a structural blocker, not a missing flag — see §3/§4.

> **UPDATE 2026-07-10 (compile+link) — the answer became YES for compiling.**
> The `mio`/blocker above was overcome and the build was carried all the way to
> a real, valid 12 MB `.wasm` artifact containing the actual Anki `rslib`
> backend. Required vendoring `anki` locally and patching it plus three
> transitive crates. Full write-up in **§6**.
>
> **UPDATE 2026-07-10 (runtime) — the answer is now YES, it actually runs.**
> Switched the bridge from a cdylib (which links as an Emscripten *side
> module*, needing extra dynamic-linking machinery to load) to a plain `bin`
> target with `extern "C"` exports, so `emcc` emits its own JS glue. **The
> resulting module was instantiated in Node — no missing imports, no
> traps — and a real end-to-end round trip was verified: init the backend,
> open a real SQLite `.anki2` collection (built by the actual bundled SQLite
> compiled by `emcc`), fetch a real due card, answer it through the real
> FSRS/SM2 scheduler, and re-fetch.** Full write-up in **§7**. §3/§4 are kept
> for history.
>
> **UPDATE 2026-07-10 (app + real data) — wired into the actual browser app,
> then tested against a real downloaded deck and made it work end-to-end.**
> §8 wires the module into the real Vite app (`web/`) with OPFS persistence,
> found and fixed three real bugs along the way. §9 found (via a real
> 220MB/15000-card downloaded deck) that the bridge never selected a deck,
> so the scheduler was silently scoped to the empty "Default" deck. §10 adds
> real `.apkg` import + deck listing/selection to fix that, roots out a real
> wasm stack-overflow bug hit along the way (Emscripten's default 64KB stack
> is too small for SQLite's recursive SQL parser), and verifies the fix
> against the real 220MB file both in Node and in the actual browser
> (identical card ids in both, OPFS growing from 139KB to 5.9MB, ~1 second
> import time).

---

## 1. Decisions (as briefed, now grounded against real source)

| Decision | Rationale |
|---|---|
| Target `wasm32-unknown-emscripten`, **not** `wasm32-unknown-unknown` | Emscripten ships a C toolchain (`emcc`) that can compile `rusqlite`'s *bundled* SQLite C amalgamation, and Emscripten pthreads (Web Workers + `SharedArrayBuffer`) give `tokio`'s `rt-multi-thread` and `rayon` a *chance* to work. `wasm32-unknown-unknown` has no C compiler and no threads, so it would force ripping out SQLite storage and all threading up front. |
| Source rslib as a **git dependency on a pinned tag**, not a submodule | Cargo fetches the whole anki repo, so rslib's internal path-deps to sibling crates (`anki_i18n`, `anki_io`, `anki_proto`, `rslib/sync`, …) resolve automatically. |
| Pin tag **`26.05`** | Most recent **non-beta** release tag. (Newer refs present were betas: `26.05b1`, `26.05b2`; latest patch line before it was `25.09.4`.) |
| Bridge crate is standalone (its own `Cargo.toml`, no workspace) | This repo had no workspace/commits at spike start. |

### Correction to a briefed assumption
The brief said to depend on rslib with `package = "rslib"`. That is **wrong** —
the directory is `rslib/` but the `[package] name` in `rslib/Cargo.toml` is
**`anki`**. The git dependency therefore uses `package = "anki"`. This is
reflected in `rust/wasm-bridge/Cargo.toml`.

---

## 2. What was built

```
rust/wasm-bridge/
  Cargo.toml      # cdylib + rlib; deps: wasm-bindgen, console_error_panic_hook,
                  #   anki (git, tag 26.05, package="anki", default-features=false)
  src/lib.rs      # init_backend / open_collection / get_next_card / answer_card
                  #   + sync_with_server STUB
  build.sh        # emcc/cargo/target preflight, then cargo build for emscripten
docs/ARCHITECTURE.md   # this file
```

Nothing outside `rust/` and `docs/ARCHITECTURE.md` was touched.

### The real rslib API the bridge targets (read from source at tag `26.05`)

These are the genuine names/signatures found by reading rslib, not guesses:

- `anki::backend::Backend` is `#[repr(transparent)] pub struct Backend(Arc<BackendInner>)`.
  - `Backend::new(tr: I18n, server: bool) -> Backend`
  - `Backend::init_backend(init_msg: &[u8]) -> Result<Backend, String>` (decodes a protobuf init message)
  - `BackendInner` holds `col: Mutex<Option<Collection>>`, `tr: I18n`, `runtime: OnceLock<Runtime>` (lazy Tokio runtime), `web_client: Mutex<Option<reqwest::Client>>`, sync/backup/media-sync task handles, etc.
- `anki::collection::CollectionBuilder`
  - `CollectionBuilder::new(col_path: impl Into<PathBuf>) -> Self`
  - `.set_tr(I18n) -> &mut Self`, `.set_server(bool) -> &mut Self`, `.set_media_paths(..)`, `.set_check_integrity(bool)`, `.with_desktop_media_paths()`
  - `.build(&mut self) -> Result<Collection>`
  - There is **no open-from-bytes** entry point: it needs a filesystem *path* (or `CollectionBuilder::default()` for an anonymous in-memory DB that *cannot* be seeded from an existing `.anki2`).
- `anki::collection::Collection` (fields `storage, col_path, media_folder, media_db, tr, server, state`)
  - `Collection::close(self, desired_version: Option<SchemaVersion>) -> Result<()>`
- Scheduler (the meat of `get_next_card` / `answer_card`):
  - `Collection::get_next_card(&mut self) -> Result<Option<QueuedCard>>` — exists almost verbatim; internally `get_queued_cards(1, false)`.
  - `Collection::get_queued_cards(&mut self, fetch_limit: usize, intraday_learning_only: bool) -> Result<QueuedCards>`
  - `QueuedCards { cards: Vec<QueuedCard>, new_count, learning_count, review_count }`
  - `QueuedCard { card: Card, kind: QueueEntryKind, states: SchedulingStates, context: SchedulingContext }`
  - `Collection::answer_card(&mut self, answer: &mut CardAnswer) -> Result<OpOutput<()>>`
  - `CardAnswer { card_id: CardId, current_state: CardState, new_state: CardState, rating: Rating, answered_at: TimestampMillis, milliseconds_taken: u32, custom_data: Option<String>, from_queue: bool }`
  - `Rating { Again, Hard, Good, Easy }`
  - `SchedulingStates { current, again, hard, good, easy }`, all `CardState` (`enum CardState { Normal(NormalState), Filtered(FilteredState) }`).

The bridge maps `ease` 1..=4 → `Rating`, caches the last `QueuedCard` so it can
supply `current_state` + the chosen `new_state` when building `CardAnswer`, and
stages the uploaded `.anki2` bytes into the emscripten virtual FS at
`/anki/collection.anki2` before calling `CollectionBuilder::new(path).build()`.

`sync_with_server` is an explicit stub returning "not yet implemented" — see its
doc comment; a real version needs a browser-`fetch()` transport shim (below).

---

## 3. What was actually tried, and what happened

### Attempt 1: run `rust/wasm-bridge/build.sh` — toolchain absent

The initial environment had no Rust and no Emscripten at all (confirmed absent,
not just off `PATH`: no `~/.cargo`, `~/.rustup`, `~/emsdk`, no `pkg-config`,
only host `clang`). `build.sh`'s preflight caught this and aborted cleanly
rather than failing silently.

### Attempt 2: toolchain installed, real build attempted — **real compiler error obtained**

Installed via Homebrew + rustup + emsdk on the actual host machine:
```
brew install rustup
rustup toolchain install stable --profile minimal
rustup target add wasm32-unknown-unknown
rustup toolchain install nightly --profile minimal
rustup target add --toolchain nightly wasm32-unknown-emscripten
rustup component add rust-src --toolchain nightly
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh
```
Versions: `rustc 1.97.0`, `emcc 6.0.2`. Then ran `bash rust/wasm-bridge/build.sh`
for real (`cargo +nightly build --release --target wasm32-unknown-emscripten -Z build-std=std,panic_abort`).

**Result: it compiled ~250 crates deep (all the way through `anki_io`,
`anki_i18n`, `prost-types`, `signal-hook-registry`, …) and then hit a hard,
target-level rejection — not a flag/config issue:**

```
   Compiling mio v1.2.1
error: This wasm target is unsupported by mio. If using Tokio, disable the net feature.
  --> mio-1.2.1/src/lib.rs:44:1
   |
44 | compile_error!("This wasm target is unsupported by mio. If using Tokio, disable the net feature.");
followed by ~27 cascading E0425/E0432/E0433/E0583 errors inside mio itself
(sys::Event/Events/Selector/IoSourceState not found — mio's own platform
`sys` module has no arm for this target, so every downstream reference breaks).
```

`mio` is tokio's OS-level I/O reactor. It is not requested directly by
`anki`'s own `tokio` feature list (`fs, rt-multi-thread, macros, signal` — no
`net`); it's pulled in because Cargo unifies features across the *whole*
dependency graph, and `reqwest` (also a mandatory `anki` dep) needs tokio's
`net` feature for its async transport. **So it doesn't matter that our bridge
never calls `sync_with_server` for real — as long as `reqwest` is anywhere in
the compiled dependency tree, `mio` gets pulled in and refuses to build.**

The build failed before ever reaching `libsqlite3-sys`'s C compile step (only
`Downloaded`, never `Compiling`), so **whether `rusqlite`'s bundled SQLite
amalgamation actually compiles under `emcc` remains untested** — the build
never got that far.

---

## 4. Blockers (honest, ranked)

These are the reasons to expect the build will **not** succeed unchanged even
once a toolchain is installed. They are ranked by how fundamental they are.

### Blocker 1 — `tokio` `rt-multi-thread` + `signal` almost certainly won't compile for emscripten
rslib depends on `tokio 1.45` with features `["fs", "rt-multi-thread", "macros", "signal"]`,
**non-optionally**. Tokio has no support for the emscripten target; the `signal`
feature in particular is Unix-signal machinery that has no emscripten backend,
and `rt-multi-thread` + `mio`/`fs` assume a real OS. This is a mandatory dep of
rslib (see Blocker 4), so it must compile even though we only want the
single-threaded scheduler slice. Expect this to be the first wall.

### Blocker 2 — CONFIRMED by real compiler: `reqwest`'s need for `tokio`'s `net` feature pulls in `mio`, which hard-rejects this wasm target
This is no longer a prediction — see §3 Attempt 2. `reqwest 0.12` (mandatory
`anki` dep) needs `tokio`'s `net` feature for its async transport; Cargo's
feature unification means that requirement applies to the *entire* build, so
`mio` (tokio's I/O reactor) enters the dependency graph even though `anki`'s
own `tokio` feature list never asks for `net`. `mio` contains an explicit
`compile_error!("This wasm target is unsupported by mio...")` with no escape
hatch short of removing the thing that requests the `net` feature. Stubbing
`sync_with_server` in *our* code does nothing — the dependency is still
compiled. This is very likely target-agnostic (the error is phrased as "this
wasm target," not "emscripten specifically") — `wasm32-unknown-unknown` would
probably hit the same wall via reqwest, unless reqwest's `wasm-fetch` backend
feature is used instead of its default hyper-based transport, which itself
would need `anki`'s `Cargo.toml` patched to select it.

### Blocker 3 — `wasm-bindgen` does not support the emscripten ABI
`wasm-bindgen` officially targets `wasm32-unknown-unknown`. On
`wasm32-unknown-emscripten`, emscripten generates its *own* JS glue and expects
its own calling/allocation conventions; wasm-bindgen's generated `.js` shim and
ABI are not compatible with that runtime. The brief asked for wasm-bindgen +
emscripten together, so the code uses it, but the realistic emscripten path is
to **drop wasm-bindgen** and export plain `#[no_mangle] pub extern "C"` symbols
listed in `-sEXPORTED_FUNCTIONS`/`EMSCRIPTEN_KEEPALIVE`, marshalling bytes
manually. This is a design fork to resolve early.

### Other real obstacles (not top-3 but will bite)
- **`rusqlite` bundled SQLite:** the `bundled` feature avoids `pkg-config` (it
  compiles the amalgamation via `cc`), which is the *good* news — but `cc`/
  `libsqlite3-sys`'s `build.rs` must be pointed at `emcc`/`emar` (via
  `CC`/`AR`/`TARGET_CC`) and must recognise the emscripten target triple. Also
  uses `trace`/`functions`/`collation` features. Untested against emscripten.
- **pthreads at runtime:** even if it links, emscripten pthreads need
  `SharedArrayBuffer`, which the *serving page* must enable via COOP/COEP
  headers (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`). `PTHREAD_POOL_SIZE` must be
  preallocated. `rayon` + `zstd`'s `zstdmt` + tokio workers all ride on this.
- **`-Z build-std` / nightly:** enabling wasm `atomics` for pthreads forces a
  `std` rebuild, so `build.sh` uses `cargo +nightly build -Z build-std`
  (needs the `rust-src` component). This is inherently unstable tooling.
- **Cannot feature-gate the heavy deps away.** rslib's *only* cargo features are
  `bench`, `rustls`, `native-tls`. `rusqlite`, `tokio`, `rayon`, `zstd`,
  `reqwest` are all **mandatory** dependencies. So `default-features = false`
  (which the bridge sets) trims essentially nothing — you cannot compile a
  "storage/scheduler-only" rslib without patching rslib's own `Cargo.toml`.

---

## 5. Concrete next steps for whoever continues

The toolchain is now installed locally (Rust stable 1.97 + nightly with
`rust-src`, targets `wasm32-unknown-unknown` and `wasm32-unknown-emscripten`,
emsdk 6.0.2 with `emcc`/`emsdk_env.sh` at `~/emsdk`) — step 1 below is done;
pick up at step 2.

1. ~~Install the toolchain and just try it, to collect the real first error.~~
   **Done.** Result is Blocker 2, confirmed by compiler (§3 Attempt 2).
2. **This confirms rslib as-published cannot be compiled to a wasm target
   verbatim.** The only way past `mio`'s hard rejection is to stop `reqwest`
   (or whatever pulls tokio's `net` feature) from being part of the compiled
   graph at all. That requires **forking/vendoring `anki`'s source** (a local
   clone + a Cargo `[patch]` section pointing our git dependency at it, since
   you cannot edit a remote git dependency's `Cargo.toml` in place) and
   feature-gating `reqwest`/sync out of `rslib`'s `Cargo.toml`, then checking
   whether anything in the `Collection`/scheduler code path we actually need
   (`get_next_card`/`answer_card`) references sync-only types unconditionally.
3. **Once past Blocker 2, still untested:** whether `libsqlite3-sys`'s bundled
   SQLite amalgamation actually compiles under `emcc` (the build never reached
   it), and whether `tokio::rt-multi-thread`/`signal` compile for emscripten
   without `net` in the graph.
4. **Resolve the wasm-bindgen-vs-emscripten fork (Blocker 3) before writing more
   glue.** Either commit to emscripten + `extern "C"` exports, or reconsider
   `wasm32-unknown-unknown` + wasm-bindgen and accept ripping out SQLite (swap to
   a pure-Rust store or an sql.js/OPFS-backed VFS) and all threading.
5. **Alternative worth considering given the size of the fork in step 2:** skip
   `Collection`/storage/sync entirely for now and compile just the scheduling
   math (Anki's FSRS crate, `fsrs` from `open-spaced-repetition/fsrs-rs`, or
   rslib's own scheduler module in isolation if it can be extracted) to
   `wasm32-unknown-unknown` + wasm-bindgen. That proves the JS↔Rust↔UI pipeline
   end-to-end without touching SQLite/tokio/reqwest at all, deferring the real
   fork effort until the rest of the app is ready to consume it.
6. **Serve with COOP/COEP** from day one so `SharedArrayBuffer` is available for
   any pthread-backed path — already done in `web/` (dev headers + `_headers`).
7. When sync is eventually tackled: implement the `fetch()` transport shim
   described in `sync_with_server`'s doc comment (route rslib's HTTP requests
   through JS `fetch`, honouring CORS + the AnkiWeb sync protocol) instead of
   reqwest's native transport.

---

## 6. 2026-07-10 — Vendored + patched `anki`, build carried to a linked `.wasm`

This section supersedes the "No" verdict in §0/§3/§4 for the **compile-and-link**
question. Everything below was done with a real compiler/linker on the host
machine; every error quoted is a real one that was hit and then resolved.

### 6.0 TL;DR result

- Produced: `rust/wasm-bridge/target/wasm32-unknown-emscripten/release/anki_wasm_bridge.wasm`
  — a valid WebAssembly binary (magic `0061736d`, ~12 MB) that links in the real
  `anki` rslib, **SQLite** (`sqlite3_open`/`sqlite3_open_v2` present), FSRS/burn,
  tokio, and exports the bridge's `init_backend` / `open_collection` /
  `get_next_card` / `answer_card`.
- `cargo +nightly check --target wasm32-unknown-emscripten -Z build-std` is **clean**
  (only warnings) for the whole graph.
- **Not yet demonstrated (honest caveats):** (a) the module is a PIC **side
  module** (`dylink.0` section) because of `-fPIC` — see §6.6; (b) `wasm-bindgen`
  CLI post-processing / JS glue was never run and is expected to be incompatible
  with emscripten output (Blocker 3 is *deferred, not disproven*); (c) the module
  has never been **instantiated or executed** — pthreads/`SharedArrayBuffer`,
  SQLite-on-MEMFS, and tokio-on-emscripten runtime behaviour are all untested.

### 6.1 Toolchain prerequisites discovered

- `protoc` is required by `anki_proto`'s `build.rs` (prost-build does **not**
  bundle it). Installed `brew install protobuf` (libprotoc 35.1) and the build
  scripts now export `PROTOC` (see `build.sh` step 0b).
- The `--depth 1` clone does **not** fetch the FTL translation **git submodules**
  (`ftl/core-repo`, `ftl/qt-repo`); `anki_i18n`'s `build.rs` reads them
  unconditionally and panics (`gather.rs:62 … NotFound`). Fix:
  `git submodule update --init --depth 1 ftl/core-repo ftl/qt-repo`.
- Gotcha that cost time: `cargo … | tail` masks cargo's real exit code (you get
  `tail`'s 0). Always capture `${PIPESTATUS}`/write to a file and check exit.

### 6.2 The `mio` blocker (§Blocker 2) — root-caused and removed **without** ripping out reqwest

`cargo tree -e features -i tokio --target wasm32-unknown-emscripten` showed `mio`
is pulled by tokio's **`net`** and **`signal`** features only:
- `net` was enabled by **two** crates: `axum`'s `tokio` feature (part of axum's
  `default`) *and* `axum-client-ip`'s `connect-info` feature (also default). Both
  expand to `axum/tokio` → `tokio/net`.
- `signal` was requested directly by `anki`'s own `tokio` feature list.

Crucial realisation: **`reqwest` does NOT pull `tokio/net` on a wasm target** —
reqwest's entire `hyper`/`hyper-util`/native-transport dependency block is under
`[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`, so on wasm it uses
its web-sys `fetch` backend and drags in no `mio`. So the fix did **not** require
removing reqwest; only the embedded **sync server** (axum::serve) + `signal`.

Also found: the `sync` module in 26.05 is *not* pure networking — it also defines
core types used by non-sync code (`Graves` ← `storage/graves`, the local
`MediaDatabase`/`MediaEntry` ← `media/mod.rs`, media size constants, sanity
counts, `Progress` enum variants, error variants). So the whole module can't be
gated out; the cut has to be surgical.

### 6.3 Patches to the vendored `anki` (`rust/vendor/anki`, cloned at tag 26.05)

`rslib/Cargo.toml`:
- Added feature `default = ["sync-server"]` and
  `sync-server = ["tokio/signal", "axum/tokio", "axum-client-ip/connect-info"]`.
  The wasm bridge sets `default-features = false`, so `sync-server` is OFF for
  wasm; native/desktop consumers keep full behaviour via `default`.
- `axum` overridden from the workspace to `default-features = false` with all
  default features **except `tokio`** re-listed (`multipart, macros, form, http1,
  json, matched-path, original-uri, query, tower-log, tracing`).
- `axum-client-ip` overridden and **bumped 1.1.3 → 1.3** with
  `default-features = false, features = ["serde"]`. (1.1.3 pulls `axum/tokio`
  *unconditionally*; only 1.3.x gates it behind `connect-info`.)
- `tokio` overridden from the workspace to
  `features = ["fs", "rt-multi-thread", "macros", "io-util", "time", "sync"]`
  (dropped `signal`; added `io-util`/`time`/`sync` which on the desktop build are
  supplied transitively by reqwest's `__tls` feature — inactive here because we
  build without `rustls`/`native-tls`).

`rslib/src` source gates:
- `sync/mod.rs`: `pub mod http_server;` → `#[cfg(feature = "sync-server")] pub mod http_server;`
  (the only user of `tokio::net::TcpListener` + `axum::serve` + `tokio::signal`;
  referenced elsewhere only by the module decl and test-only code).
- `sync/http_client/io_monitor.rs`: `zstd_request_with_timeout` split into a
  native impl (`#[cfg(not(target_family = "wasm"))]`) and a wasm stub returning
  `HttpError`. Reason: reqwest's wasm backend has no `Body::wrap_stream` and its
  response streams are `!Send`, which breaks the streaming monitor + the
  async-compression decoder's `Send`/`Sync` bounds. This is the *only* place the
  reqwest **client** touches native-only APIs — the rest of the sync client
  compiles fine against the wasm fetch backend.
- `backend/mod.rs`: `web_client()`'s `Client::builder().http1_only()` gated —
  `http1_only()` doesn't exist on reqwest's wasm `ClientBuilder`.
- `scheduler/mod.rs`: `pub(crate) mod queue;` → `pub mod queue;` so an embedder
  can name `QueuedCard` (returned by the public `Collection::get_next_card`).
  `Card::id()` accessor already exists (bridge now uses `.id()` not `.id.0`).

### 6.4 tokio on wasm (§Blocker 1) — solved with `--cfg tokio_unstable`

tokio has a hard `compile_error!("Only features sync,macros,io-util,rt,time are
supported on wasm.")` gated on `all(not(tokio_unstable), target_family = "wasm", …)`.
`wasm32-unknown-emscripten` reports **both** `target_family = "unix"` *and*
`target_family = "wasm"`, so the guard fires. Setting `--cfg tokio_unstable` in
`RUSTFLAGS` disables it, letting `fs` + `rt-multi-thread` compile. With the sync
server gated there is no `net`, so still no `mio`. (Runtime behaviour of
`rt-multi-thread`/`fs` on emscripten is **untested** — this only unblocks the
compile.)

### 6.5 FSRS / burn training stack (new blockers) — two vendored+patched leaf crates

`fsrs` (the scheduler's FSRS crate) unconditionally pulls `burn` with the
`train`+`metrics` features → `burn-train` → problems that surface only on wasm:
- **`systemstat 0.2.7`** has no `target_os = "emscripten"` platform impl
  (`unresolved import self::platform::PlatformImpl`, `cannot find PlatformMemory`).
  Vendored to `rust/vendor/systemstat` + added an emscripten stub
  (`src/platform/emscripten.rs`, a `PlatformImpl` whose methods all return
  `io::ErrorKind::Unsupported`) and added `target_os = "emscripten"` to the
  linux-style `PlatformMemory`/`PlatformSwap` cfgs in `data.rs`.
- **`burn-train 0.17.1`** uses `async_channel`'s `send_blocking`/`recv_blocking`
  (cfg'd out on wasm) plus a spawned OS thread in `metric/processor/async_wrapper.rs`.
  Vendored to `rust/vendor/burn-train` + split into a native impl and a wasm impl
  that processes metric events synchronously in-place (no thread/channel).

Both redirected via `[patch.crates-io]` in `rust/wasm-bridge/Cargo.toml`. (A
cleaner long-term fix is to make fsrs's *training* optional and drop `burn-train`
entirely, but that is a cross-crate fork — fsrs's public API and anki's
`compute_parameters`/`evaluate` call sites all assume training is present.)

### 6.6 SQLite under `emcc` (previously untested) — **compiles**, and the link PIC fix

- rusqlite's **bundled SQLite C amalgamation compiled cleanly under `emcc`** via
  the `cc` crate (first time this was ever exercised — §3 never reached it).
- At **link** time `wasm-ld` rejected SQLite's data relocations:
  `relocation R_WASM_MEMORY_ADDR_SLEB cannot be used against symbol
  'sqlite3Config'; recompile with -fPIC`. Rust codegen for this target is
  position-independent by default; the `cc`-built C objects were not. Fix:
  `export CFLAGS_wasm32_unknown_emscripten="-fPIC"` (cc keys its object cache on
  this, so it also forces the recompile) + `-fPIC` in `EMCC_CFLAGS`.
  **Consequence:** the output gains a `dylink.0` section — it is now a PIC
  **side module**, not a standalone module. Getting a standalone/main module may
  instead want `-C relocation-model=static` on the Rust side (untried).

### 6.7 Exact build invocation (all reproduced in `build.sh`)

```
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
source ~/emsdk/emsdk_env.sh
export PROTOC=/opt/homebrew/bin/protoc
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals --cfg tokio_unstable"
export EMCC_CFLAGS="-pthread -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=4 -s ALLOW_MEMORY_GROWTH=1 -fPIC"
export CFLAGS_wasm32_unknown_emscripten="-fPIC"
cargo +nightly build --release --target wasm32-unknown-emscripten -Z build-std=std,panic_abort
```
(One-time host setup: `brew install protobuf`; submodule init as in §6.1.)

### 6.8 What remains before it can actually *run* (ranked)

1. **wasm-bindgen ↔ emscripten (Blocker 3) is deferred, not solved.** The crate
   *links* with `#[wasm_bindgen]` present (the binary contains
   `__wbindgen_describe_*`), but the wasm-bindgen CLI was never run and targets
   `wasm32-unknown-unknown`, not emscripten side modules. The §4/Blocker-3 plan
   (drop wasm-bindgen for `#[no_mangle] pub extern "C"` + `-sEXPORTED_FUNCTIONS`)
   is still the realistic path to callable JS. This was **not** reached as a
   build error, so it wasn't attempted here.
2. **Side module vs main module.** `-fPIC` produced a `dylink.0` side module.
   Decide between emscripten dynamic linking (main+side) or trying
   `-C relocation-model=static` for a standalone module.
3. **Runtime, entirely untested:** module instantiation; emscripten pthreads
   (needs COOP/COEP + preallocated `PTHREAD_POOL_SIZE`, already served in `web/`);
   tokio `rt-multi-thread`/`fs` actually working under emscripten (only forced to
   *compile* via `tokio_unstable`); SQLite opening `/anki/collection.anki2` on
   MEMFS; and whether the scheduler slice returns correct cards.
4. **Vendored patches are pinned to exact versions** (systemstat 0.2.7,
   burn-train 0.17.1, anki 26.05). Any dependency bump needs them re-checked.

---

## 7. 2026-07-10 (same day, continued) — From "it links" to "it actually runs"

§6 ended with a linked `.wasm` that had never been instantiated. This section
covers turning that into a genuinely running module, verified in Node: real
instantiation (all ~1,100 imports satisfied), then a real init → open a real
SQLite collection → fetch a due card → answer it through the real scheduler →
re-fetch round trip. Every command and error below was actually run.

### 7.0 TL;DR result

**It runs.** `node rust/wasm-bridge/smoke-test/run.sh`'s output, verbatim for
the interesting collection:
```
[smoke] INSTANTIATION SUCCEEDED. Module keys sample: [ '_wasm_alloc', '_wasm_answer_card',
  '_wasm_dealloc', '_wasm_get_next_card', '_wasm_init_backend', '_wasm_last_error_len',
  '_wasm_last_error_ptr', '_wasm_open_collection', '_wasm_sync_with_server' ]
[smoke] wasm_init_backend() -> 0
[smoke] wasm_open_collection() -> 0 (ok)
[smoke] wasm_get_next_card() -> 1783711344991n bigint (got a real due card)
[smoke] wasm_answer_card(3) -> 0 (ok)
[smoke] wasm_get_next_card() after answering -> 1783711344991n
[smoke] SMOKE TEST COMPLETE
```
(process exits 0, no hang, no trap.) The card reappearing immediately after
being answered "Good" is **correct scheduler behavior, not a bug**: rslib's
queue builder (`scheduler/queue/builder/mod.rs`) includes a
`learn_ahead_secs` cutoff — new/learning cards due within that short window
are deliberately kept in the same-session queue — confirmed by reading
`CardQueues::build(learn_ahead_secs)` and `Collection::learn_ahead_secs()`.
On an empty collection, `wasm_get_next_card()` correctly returns `-1n`.

### 7.1 Why the previous artifact couldn't load: cdylib = Emscripten side module

The coordinator's diagnosis was exactly right and confirmed on inspection: the
old `[lib] crate-type = ["cdylib", "rlib"]` build produced a `dylink.0`
section (a position-independent Emscripten *side module*), which requires a
paired main module + Emscripten's dynamic-linking JS runtime to load — nothing
generates that pairing automatically. `WebAssembly.compile()` (module
*parsing*) succeeded on it; `instantiate()` never had a chance because there
was no JS loader at all (no `.js`/`.mjs` file next to the `.wasm`).

**Fix:** switched to a plain `[[bin]]` target with `path = "src/main.rs"` and
a trivial `fn main() {}`. `rust/wasm-bridge/Cargo.toml` no longer has a `[lib]`
section at all. Emscripten treats a `bin` crate as a normal executable and, by
default, emits a JS glue file that instantiates and (optionally) runs it —
exactly the well-trodden path. `src/lib.rs` was deleted; everything moved into
`src/main.rs`, and deliberately **not** split into a separate lib crate + thin
bin wrapper — `#[no_mangle]` symbols living in an *unused* rlib are liable to
be dropped by the linker before it ever sees them (rlibs are archives; only
referenced object files get pulled in), so keeping every export directly in
the final linked crate root sidesteps that whole class of bug.

### 7.2 Dropping wasm-bindgen for plain `extern "C"` + manual marshalling

`wasm-bindgen` and `console_error_panic_hook` (which itself depends on
wasm-bindgen's web-sys bindings) were removed from `Cargo.toml` entirely. Every
entry point in `src/main.rs` is now `#[no_mangle] pub extern "C" fn`:

- `wasm_alloc(len) -> *mut u8` / `wasm_dealloc(ptr, len)` — JS-driven buffer
  management. `wasm_alloc` builds a `Vec<u8>` of exactly `len`, leaks it via
  `mem::forget`, and hands back the pointer; `wasm_dealloc` reconstructs the
  `Vec` with `Vec::from_raw_parts` (same `len`) and drops it. This guarantees
  every JS-visible buffer round-trips through Rust's own allocator.
- `wasm_init_backend() -> i32`, `wasm_answer_card(ease: u8) -> i32` — plain
  scalar in/out, no marshalling needed.
- `wasm_open_collection(ptr: *const u8, len: usize) -> i32` — JS writes the
  `.anki2` bytes into a `wasm_alloc`'d buffer, passes `(ptr, len)`.
- `wasm_get_next_card() -> i64` — returns the id directly (`-1` = empty queue,
  `-2` = error). Emscripten legalizes an exported wasm `i64` as two `i32`s by
  default (its own `Number`-based legacy ABI) *unless* `-sWASM_BIGINT=1` is
  set, in which case it's a genuine wasm `i64` <-> JS `BigInt` — set via
  `build.rs` (§7.3), so JS sees a real `BigInt` (`1783711344991n` above).
- `wasm_last_error_ptr() -> *const u8` / `wasm_last_error_len() -> usize` —
  read-back for a UTF-8 error message stashed in a `static LAST_ERROR: Mutex<Vec<u8>>`
  whenever any export returns a negative status. Valid only until the next
  call that might overwrite it (documented in the doc comment) — an accepted
  simplification for a spike, not meant as the final API shape.
- `wasm_sync_with_server(endpoint_ptr, endpoint_len, token_ptr, token_len) -> i32` —
  unchanged stub, still always returns an error (`-1`).

### 7.3 Two real build-system bugs found and fixed

**Bug 1 — blanket `RUSTFLAGS -C link-arg=...` leaks into unrelated dependencies.**
First attempt added `-C link-arg=-sMODULARIZE=1 -sEXPORT_ES6=1 -sWASM_BIGINT=1
-sEXPORTED_FUNCTIONS=[...]` to the same `RUSTFLAGS` string used for
`target-feature`/`tokio_unstable`. Real error:
```
Compiling wasm-streams v0.4.2
error: linking with `emcc` failed: exit status: 1
  emcc: error: undefined exported symbol: "_main" [-Wundefined] [-Werror]
```
Root cause: plain `RUSTFLAGS` applies to *every* rustc invocation in the whole
dependency graph — including `wasm-streams` (pulled in by reqwest's wasm
`fetch` backend), which itself declares a `cdylib` output for its own
wasm-bindgen use. Our `-sEXPORTED_FUNCTIONS=[our wasm_* names]` +
implied-executable-link (`MODULARIZE`) got applied to *its* link too, and it
has neither a `main` nor any of our exports.
**Fix:** moved all of it into `rust/wasm-bridge/build.rs`, emitting
`cargo:rustc-link-arg=...` — Cargo scopes those to only the *current
package's* own final link (our bin target), never to dependencies. `build.sh`
now only sets `RUSTFLAGS`/`EMCC_CFLAGS` for the truly global concerns
(`target-feature`, `tokio_unstable`, pthread flags, `-fPIC`); the module-shape
flags live in `build.rs`.

**Bug 2 — `Module.HEAPU8` not exported by default.** After fixing Bug 1, the
module instantiated but `Module.HEAPU8` was `undefined` (only 9-11 keys on the
returned object — just our `EXPORTED_FUNCTIONS`). Emscripten's default runtime
doesn't expose its live memory view on `Module` unless asked.
**Fix:** added `cargo:rustc-link-arg=-sEXPORTED_RUNTIME_METHODS=['HEAPU8']` to
`build.rs`. `-fPIC`/`CFLAGS_wasm32_unknown_emscripten` from §6.6 were kept
unchanged (still needed; the target's default PIC codegen is independent of
crate-type).

### 7.4 Node ESM + pthread-worker filename gotcha

The generated glue is named `anki_wasm_bridge.js` but its *content* is a real
ES module (`export default Module`, top-level `await import(...)`,
`import.meta.url`) — confirmed by inspection, not assumption. First
instantiation attempt failed with:
```
worker sent an error! undefined:undefined: Cannot find module '.../anki_wasm_bridge.js'
Error: Cannot find module '.../anki_wasm_bridge.js'
    at ... (node:internal/main/worker_thread:223:26)
```
Because `PTHREAD_POOL_SIZE=4` preallocates pthread workers at module-init time
(this happens eagerly, not lazily — Node's `worker_threads.Worker` is used
under the hood, auto-detected via `ENVIRONMENT_IS_NODE`), and each worker
re-loads the *same* glue file by its literal built-in filename
(`anki_wasm_bridge.js`) to bootstrap itself. Renaming a copy to `.mjs` for our
own `import()` (an earlier attempt) broke this, because the worker's hardcoded
reload still looked for the original `.js` name, which no longer existed.
**Fix:** keep the original `anki_wasm_bridge.js` filename, and add a
`package.json` with `{"type": "module"}` in the same directory — this makes
*every* consumer (our own top-level `import()` **and** the worker's internal
reload) resolve the plain `.js` as ESM via the nearest-`package.json` rule,
with no renaming needed. See `rust/wasm-bridge/smoke-test/package.json`.

This also means: **pthreads actually bootstrap successfully under Node** for
this module (workers spawn, the process still exits cleanly at 0) — a genuine
capability confirmation, though it says nothing about a *browser* deployment,
which still needs COOP/COEP headers for `SharedArrayBuffer` (already served in
`web/`, unchanged from §5).

### 7.5 Generating a real test collection (no external fixture needed)

Per the suggestion, a tiny host-native tool
(`rust/tools/make-test-collection`, a separate crate — NOT part of the wasm
build, depends on the same vendored `anki` path but compiles for the host
target with full default features) drives the real
`CollectionBuilder::new(path).build()` / `Collection::close()` API to produce
a genuine, empty, schema-valid `.anki2` SQLite file (confirmed via `file(1)`:
`SQLite 3.x database ... schema 4`). An optional `--with-note` flag adds one
real note via the stock `"Basic"` notetype + `Collection::add_note(&mut note,
DeckId(1))`, so the resulting file has one real due card — verified by
`get_next_card` returning a real, nonzero id (a millisecond timestamp) rather
than `-1`.

### 7.6 Reproducing this end-to-end

```
rust/wasm-bridge/smoke-test/run.sh
```
does all of: build the bridge (`build.sh`), build `make-test-collection`,
generate `empty.anki2` + `with_note.anki2`, copy the `.wasm`/`.js` glue next
to the smoke test, and run `smoke_test.mjs` against both fixtures under
`node` (tested on Node v26.4.0; no `--experimental-wasm-threads` flag needed).
Key files:
- `rust/wasm-bridge/build.rs` — the emcc link-arg flags (§7.3).
- `rust/wasm-bridge/src/main.rs` — the `extern "C"` bridge (§7.2).
- `rust/tools/make-test-collection/` — the fixture generator (§7.5).
- `rust/wasm-bridge/smoke-test/{run.sh,smoke_test.mjs,package.json}` — the
  Node harness. The generated `.wasm`/`.js`/`*.anki2` files in that directory
  are build outputs (gitignored), not source.

### 7.7 What's genuinely still open

1. **Only the four data-plane exports were smoke-tested** (init, open, get,
   answer). `wasm_sync_with_server` was not re-verified this round (still the
   same always-errors stub from §6.3/§6.5 — reqwest's sync client path itself
   was never exercised at runtime, only compiled).
2. **No browser testing.** Everything above is Node-only. A real browser needs
   COOP/COEP (already served in `web/`) and hasn't been tried against this
   artifact yet — Node's `worker_threads` pthread shim and a browser's Web
   Worker + `SharedArrayBuffer` shim are different code paths in emscripten's
   runtime, so "works in Node" is real signal but not a browser guarantee.
3. **No persistence tested.** The collection lives on Emscripten's default
   MEMFS; nothing here mounts IDBFS or calls `FS.syncfs`, so state is lost
   when the module is dropped (fine for a smoke test, not fine for a real
   app — this was already flagged in §3/§5 and remains open).
4. **Only a single-note, single-answer path was exercised.** Multi-card
   queues, undo, FSRS parameter computation (the `burn`/training stack
   patched in §6.5), and sync were not touched at runtime.
5. **`opt-level = "z"` + `lto = true` were kept** from the original profile;
   the resulting `.wasm` is ~11 MB. No attempt was made to reduce this
   further (e.g. `wasm-opt`, stripping debug info) — out of scope for "does
   it run."

---

## 8. 2026-07-10 (same day, continued) — Wired into the browser app; found and fixed three real bugs by actually using it

The agent doing this phase's work stalled (no progress for 600s) after building
the integration but before verifying or writing this section. Everything below
the file list was done by hand, in a real browser, via the preview tooling —
not re-delegated.

### 8.1 What was built (before the stall — verified intact, not redone)

- `web/src/wasm/backend.ts` — typed loader around the Emscripten glue. Loads
  `anki_wasm_bridge.js` via a plain `<script>` tag (not `import()`) — Vite's
  dev server refuses to let source code `import` a `public/` file, and the
  generated glue re-invokes itself by a literal self-referential URL for
  pthread worker bootstrap, which asset-hashing would break. Mirrors the
  alloc/write/call/dealloc convention already proven in
  `rust/wasm-bridge/smoke-test/smoke_test.mjs`.
- `web/src/db/collection.ts` — bridges `opfs.ts` (pre-existing OPFS helper)
  with the wasm bridge's collection lifecycle: seed from a bundled
  `starter-collection.anki2` fixture on first launch, otherwise resume from
  whatever OPFS already has; `persistCollection()` reads the collection back
  out of Emscripten's MEMFS and writes it to OPFS.
- `web/src/ui/StudyView` rewired to real data: `initBackend` →
  `loadInitialCollectionBytes` → `openCollection` → `persistCollection` →
  `getNextCard` on mount; swipe/button handlers call `answerCard` then
  `persistCollection` then re-fetch.
- `web/public/wasm/` (gitignored) + `web/scripts/sync-wasm-artifacts.sh` to
  copy the Emscripten build output there, since Vite serves `public/` as an
  unprocessed passthrough.
- `web/vite.config.ts` already had the required COOP/COEP headers for both
  `server` and `preview` from the earlier Phase 1 scaffolding pass — confirmed
  correct, no changes needed.

### 8.2 Bug 1 (found live): `TextDecoder.decode()` rejects the pthreads-backed heap

First browser test threw `TypeError: The provided ArrayBufferView value must
not be shared` from inside `readLastError`. Root cause: pthread support means
`Module.HEAPU8` is backed by a `SharedArrayBuffer`, and `TextDecoder.decode()`
refuses a view over shared memory. This wasn't just a cosmetic bug — it meant
*any* `wasm_*` failure would crash the error-reporting path itself instead of
surfacing a message, hiding the real error underneath. Fixed in
`web/src/wasm/backend.ts`'s `readLastError` by copying into a plain
`Uint8Array` first (`new Uint8Array(sharedView)` copies elements into a fresh
non-shared buffer) before decoding.

### 8.3 Bug 2 (found live, the important one): React 18 StrictMode double-invoke silently swallowed the bootstrap result

After fixing Bug 1, the app still hung forever on "Loading collection…" with
**no error and no console output at all**. Traced by hand (importing
`backend.ts`/`collection.ts` directly via `import()` in the live page and
stepping through each call with timeouts) — the wasm calls themselves all
worked. The bug was in `StudyView`'s bootstrap `useEffect`:

```
const bootstrapped = useRef(false)
useEffect(() => {
  if (bootstrapped.current) return
  bootstrapped.current = true
  let cancelled = false
  ;(async () => { ...; if (cancelled) return; dispatch(...) })()
  return () => { cancelled = true }
}, [])
```

Under StrictMode's dev-only mount→cleanup→remount double-invoke: the *first*
mount starts the real async work and returns a cleanup that sets
`cancelled = true`. React immediately runs that cleanup (StrictMode's
simulated unmount) before the async work resolves. The *second* mount's effect
then exits immediately via the `bootstrapped` guard and starts no work of its
own. Net result: the only invocation that ever does real work has its own
eventual `dispatch(...)` permanently suppressed by its own cleanup, and no
other invocation ever runs one. The component is stuck in `loading` forever,
silently — `bootstrapped` and `cancelled` were each individually reasonable
guards that actively defeated each other in combination.

Fix: dropped the `cancelled` flag entirely. `bootstrapped` alone already
guarantees the effect body runs exactly once per real mount; a stale dispatch
after a genuine unmount is harmless in React 18 (no warning, just a no-op).

### 8.4 Bug 3 (found live): the backend is session-scoped, but `StudyView` re-opened it on every mount

After fixing Bug 2, clicking Sync then back to Study (a completely ordinary
user action — `App.tsx` conditionally unmounts/remounts `StudyView`) hit a
*real* rslib error surfaced correctly through the now-fixed error path:
`wasm_open_collection failed (-3): DbError`. The wasm module is a
page-session-lifetime singleton (`modulePromise` in `backend.ts`), so a
collection opened once stays open; `StudyView` calling `openCollection` again
on remount tried to open a second connection, which rslib correctly refuses.
Fixed the same way `initBackend` was already idempotent: added an
`openCollectionPromise` singleton in `backend.ts` so a second call (regardless
of what bytes it's passed — there's no close/reopen flow yet, e.g. no import
UI or real sync) just resolves against the already-open collection instead of
trying to open it again.

### 8.5 Verification performed (by hand, in the actual browser preview, not Node)

- `window.crossOriginIsolated === true`, `typeof SharedArrayBuffer !==
  'undefined'` — COOP/COEP genuinely in effect.
- Full mount flow: real card id (`1783712418572`, a genuine rslib id, not a
  placeholder) rendered in the UI, no console errors.
- Answered it (`Good`, ease 3) → UI showed "Answered card … ease: 3" → clicked
  "Next card" → same card id again (same correct `learn_ahead_secs` behaviour
  already verified in §7's Node smoke test, now confirmed in a browser too).
- OPFS persistence confirmed directly: `navigator.storage.getDirectory()` →
  `collection.anki2`, 139264 bytes, present after the session.
- Full page reload (not just a component remount) → resumes from the
  persisted OPFS collection (same card id, consistent with the persisted
  post-answer state) instead of re-seeding from the starter fixture.
- Regression-tested the exact sequence that caused Bug 3 (Study → Sync →
  Study) after the fix — no error, same card, clean.

### 8.6 What's still genuinely open

1. `sync_with_server` is still the stub from §6/§7 — untouched this phase.
2. Only a card *id* is rendered, no note fields — `get_next_card`'s bridge
   surface doesn't expose them yet (§2/§6.3 note this was deferred).
3. Only the single bundled starter collection has been exercised — no
   real-collection import path, no multi-card queue exhaustion tested.
4. The service worker precache (`vite-plugin-pwa`'s `globPatterns`) was not
   re-verified against the `public/wasm/` assets specifically — they're
   served from `public/`, not bundled, so it's untested whether they're
   actually precached for true offline use versus just working because the
   dev/preview server is reachable.
5. `.wasm` is still ~11 MB, unoptimized (carried over from §7.7).

---

## 9. 2026-07-10 (same day, continued) — Real-collection test found a real bug: no deck selection

Tested the bridge against a real downloaded shared deck
(`Spanisch_5000.apkg`, ~7500 notes / 15000 cards, schedVer 2) instead of the
synthetic starter fixture. `get_next_card` came back empty (`-1`) even though
the deck had thousands of fresh, never-studied cards.

**Root cause, confirmed with a native diagnostic tool** (not guessed):
`rust/tools/make-test-collection/src/bin/inspect-collection.rs` — opens an
arbitrary real `.anki2`/`.anki21` file natively (no wasm/emcc layer in the
way) and reports exactly what `get_next_card`/`get_queued_cards` see, with an
optional `select-deck-id` argument. Kept in the repo as a standing diagnostic
for future "why is the queue empty" questions.

rslib's queue-building (`Collection::get_next_card` → `get_queued_cards`) is
scoped to `col.get_current_deck()` — whatever `DeckId` is stored in the
collection's `CurrentDeckId` config key, defaulting to `DeckId(1)`
("Default") if unset. The wasm bridge's `wasm_open_collection` never called
`Collection::set_current_deck`, so every collection opened through it was
implicitly scoped to the empty built-in "Default" deck, regardless of which
deck the real cards actually live in. Confirmed by using the diagnostic tool
to manually call `col.set_current_deck(DeckId(1774646385007))` (the real
deck's id, found via `get_all_deck_names`) — `get_next_card` immediately
started returning real cards, correctly respecting the deck's configured
new-cards-per-day limit (20).

This is **not a bug in the scheduler or the bridge's answer/get_next_card
logic** — it's a missing precondition (deck selection) that the bridge never
had a way to satisfy, because nothing had ever imported more than one deck
before. §10 adds `.apkg` import (which creates decks) and deck
listing/selection (which lets a caller point the bridge at the deck that
matters) together, since one is useless without the other.

---

## 10. 2026-07-10 (same day, continued) — Real `.apkg` import + deck listing/selection, wired end-to-end into the browser

Adds the three bridge exports needed to make §9's fix usable from the app:
import a real `.apkg`, list the decks it creates, and select one to study.
Also root-caused and fixed a genuine wasm-specific memory-corruption bug
along the way (§10.2) — this section documents the full diagnostic trail
honestly, including the red herrings, because it's the kind of bug that will
recur in some form if more of rslib's rarely-exercised code paths get
exercised later.

### 10.1 Rust bridge additions (`rust/wasm-bridge/src/main.rs`)

- `wasm_open_collection` now calls `.with_desktop_media_paths()` on the
  `CollectionBuilder` chain (derives `/anki/collection.media` (dir, created
  for us) and `/anki/collection.mdb` from `COLLECTION_PATH`, the same
  convention desktop Anki uses for a `foo.anki2` file). Without this,
  `media_folder`/`media_db` default to an empty `PathBuf`
  (`CollectionBuilder::build`), and anything calling `Collection::media()`
  (import_apkg does, to add imported media files) fails immediately with
  "attempted media operation without media folder set".
- `wasm_import_apkg(ptr, len) -> i32` — stages the uploaded `.apkg` bytes at
  `/anki/import.apkg` on the virtual FS (`Collection::import_apkg` wants a
  real file path; it opens the zip itself via `ZipArchive::new`), calls
  `col.import_apkg(path, ImportAnkiPackageOptions::default())` on the
  already-open collection, removes the staged file afterwards (success or
  failure), returns 0/negative like the other exports. Using
  `::default()` (per the brief) means `with_scheduling: false` — a real
  behavioural choice: imported cards come in fresh/new rather than
  preserving the source deck's original due dates/intervals. Worth revisiting
  if "preserve scheduling" ever becomes a real requirement.
- `wasm_list_decks() -> i32` — calls `get_all_deck_names(false)` (includes
  "Default"), JSON-encodes as `[[id_as_string, name], ...]` via `serde_json`
  (already a transitive dependency of `anki`, no new compile cost) into a
  **new**, separate result buffer (`LAST_RESULT`/`wasm_last_result_ptr/len`),
  deliberately not reusing `LAST_ERROR` — conflating "the error message" and
  "the success payload" into one slot would let a caller reading at the wrong
  time mistake one for the other. IDs are encoded as **strings**, not JSON
  numbers, because they're i64s that can exceed
  `Number.MAX_SAFE_INTEGER`'s exact-representation range in JS/JSON.
- `wasm_set_current_deck(deck_id: i64) -> i32` — thin wrapper over
  `Collection::set_current_deck`.

### 10.2 Real bug hit and root-caused: wasm stack overflow in SQLite's recursive parser

First `wasm_import_apkg` call crashed instantly:
```
RuntimeError: function signature mismatch
    at anki_wasm_bridge.wasm.sqlite3Malloc (...)
    at anki_wasm_bridge.wasm.dbMallocRawFinish (...)
    at anki_wasm_bridge.wasm.sqlite3DbMallocRawNN (...)
    at anki_wasm_bridge.wasm.sqlite3DbStrNDup (...)
    at anki_wasm_bridge.wasm.sqlite3Prepare (...)
    ...
    at <rusqlite::cache::StatementCache>::get (...)
```
Confirmed real and reproducible on the *smallest* available `.apkg` fixtures
too (`pylib/tests/support/update1.apkg`, 3KB, no media) — not a size/media
issue. Confirmed **not** a bug in our API usage: a host-native diagnostic
(`rust/tools/make-test-collection/src/bin/test-import-apkg.rs`, written for
this investigation and removed again once the bug was found — not kept,
unlike `inspect-collection.rs`) ran the identical `import_apkg` call against
the identical fixture natively and succeeded immediately, so the bug was
specific to the wasm/emscripten build.

**Diagnostic trail (in order tried, most ruled out):**
1. Rebuilt with `-C debuginfo=1` (Rust) + `-g` (`EMCC_CFLAGS`) to get named
   stack traces instead of anonymous `wasm-function[N]` indices — essential;
   nothing below would have been findable from the anonymous traces alone.
2. **Ruled out: full LTO.** Same crash with `lto = false`.
3. **Ruled out: `Collection::media()` itself** (opening the second, media,
   SQLite connection). A temporary debug export
   (`wasm_debug_open_media`, calling only `col.media()`, no import/zip logic)
   succeeded cleanly — the second connection opening is fine on its own.
4. **Ruled out: `SQLITE_THREADSAFE`.** `libsqlite3-sys`'s `build.rs`
   hardcodes `-DSQLITE_THREADSAFE=1` for every target except `wasm32-wasi`
   (which gets `0`) — no special case for `wasm32-unknown-emscripten`. Since
   our own `Mutex<Option<Collection>>` already fully serializes all access,
   SQLite's internal thread-safety machinery is unnecessary, so this looked
   like a strong lead. Overrode via `-USQLITE_THREADSAFE -DSQLITE_THREADSAFE=0`
   in both `EMCC_CFLAGS` and `CFLAGS_wasm32_unknown_emscripten` (the latter
   also forces `cc`'s build cache to invalidate and recompile). **Verified the
   override actually took effect** (not just assumed) via a temporary debug
   export running `PRAGMA compile_options` against the open connection —
   confirmed `THREADSAFE=0,MUTEX_OMIT` in the output. The crash was
   **unchanged**, ruling this out definitively.
5. **Ruled out: `SQLITE_ENABLE_MEMORY_MANAGEMENT`** (a `libsqlite3-sys`
   default flag enabling soft-heap-limit tracking, which wraps the allocator
   vtable — a plausible source of an indirect-call bug). Undefining it
   changed the crash's exact symptom (see below) but did not fix it, meaning
   it wasn't the (sole) root cause either — though the fact that removing it
   *did* shift the symptom was itself a clue that something adjacent to
   memory layout, not a specific vtable, was at fault.
6. **Root cause found:** with opt-level and `SQLITE_ENABLE_MEMORY_MANAGEMENT`
   varied across attempts, the *symptom* kept changing —
   `"function signature mismatch"` in `sqlite3Malloc`, then
   `"memory access out of bounds"` in `__pthread_mutex_lock` (opt-level=1),
   then `"memory access out of bounds"` in `strlen` called from
   `sqlite3VdbeMemSetStr`/`sqlite3GenerateColumnNames`/`sqlite3Select`,
   reached via `yy_reduce`/`sqlite3RunParser` (SQLite's recursive-descent SQL
   parser). Symptom instability tied to optimization level, all clustered
   around the parser's deep call chain, is the classic signature of a **wasm
   stack overflow**: the overflow corrupts whatever linear memory happens to
   sit past the end of the (Emscripten default 64KB) stack, and *which*
   downstream data gets clobbered — and therefore what the trap looks like —
   shifts with exact stack-frame sizes, which optimization flags change.
   **Fix:** `-sSTACK_SIZE=4194304` (4MB, generous headroom, untuned) in
   `rust/wasm-bridge/build.rs`. Confirmed fixed on: `update1.apkg` (3KB, no
   media), `media.apkg` (2.5KB, with media), and the real 220MB
   `Spanisch_5000.apkg` (§10.4). All debug flags/exports from steps 1–5 were
   then reverted/removed; only the stack size bump was kept.

**Takeaway for whoever hits a similarly weird "signature mismatch" or "memory
access out of bounds" trap deep in unrelated-looking library code on this
target:** check the stack size before anything else. Emscripten's 64KB
default is tuned for typical web code, not a full recursive-descent SQL
parser plus Rust's own frames on top of it — the scheduler-only surface
(open/get_next_card/answer_card, §6/§7) apparently never recursed deep
enough to hit it, but real SQL parsing does.

### 10.3 TypeScript + UI (`web/src/wasm/backend.ts`, `web/src/db/collection.ts`, new `web/src/ui/ImportView`)

- `backend.ts`: added `importApkg(bytes)`, `listDecks()` (parses the
  `[id_as_string, name]` JSON pairs back into `{id: bigint, name: string}[]`),
  `setCurrentDeck(deckId: bigint)`. Confirmed **empirically, not assumed**
  that `-sWASM_BIGINT=1` marshals i64 *parameters* as native `BigInt` the
  same way it already did for `wasm_get_next_card`'s i64 *return* — passing
  `BigInt(deckIdString)` straight into `Module._wasm_set_current_deck(...)`
  worked with no manual hi/lo splitting, verified against a real
  `1783719237860`-style id (well above `Number.MAX_SAFE_INTEGER`'s comfort
  zone) from the real imported deck.
- `db/collection.ts`: extracted a new shared `ensureCollectionReady()`
  (init backend → load bytes from OPFS-or-starter-fixture → open → persist),
  memoized the same way `backend.ts`'s own `initBackend`/`openCollection`
  are. Needed because `StudyView` and the new import UI are separate tabs
  that mount independently (`App.tsx` renders exactly one at a time) — either
  could be the first to need the collection open, so the bootstrap can't live
  in just one of them anymore. `StudyView` was refactored to call this
  instead of duplicating the sequence inline; behaviour unchanged.
- New `web/src/ui/ImportView` (third tab, `App.tsx`): a plain
  `<input type="file" accept=".apkg">` + Import button, a deck list (every
  `listDecks()` result, clickable to `setCurrentDeck` + `persistCollection`),
  and a quality-of-life auto-select: if importing added exactly one new deck
  (diffed against the pre-import deck id set), it's selected automatically
  instead of leaving the user on "Default". No separate "selected deck"
  state is lifted up to `StudyView` — deck selection is a durable property of
  the backend's own config (persisted to OPFS via `persistCollection`), so
  `StudyView` naturally picks it up next time it mounts and calls
  `getNextCard()`.

### 10.4 Verification performed (by hand, in the actual browser preview, and in Node)

- Small fixtures (`update1.apkg`, `media.apkg`, both from
  `rslib/pylib/tests/support/`) via a Node test script
  (`rust/wasm-bridge/smoke-test`-adjacent, scratch): import → list decks →
  select → get a real card — all green after the stack-size fix.
- **The real file**, `/Users/joshua/Downloads/Spanisch_5000.apkg` (220,950,207
  bytes, 7500 notes / 15000 cards, with media) — in Node: instantiate → open
  an empty collection → `wasm_import_apkg` → **976ms** → `wasm_list_decks`
  correctly returns `[["1","Default"],["1783719237860","Spanisch 5000"]]` →
  `wasm_set_current_deck(1783719237860n)` → `wasm_get_next_card()` returns a
  real card id. Not a truncated/simplified substitute — the genuine 220MB
  file, and it was fast (well under a second), not slow as anticipated.
- **The same file, in the actual browser**, driven through the real UI (a
  `File` picked via a genuine `<input type="file">` — simulated via
  `DataTransfer`/a dispatched `change` event since there's no OS file-picker
  automation available, but exercising the exact same `onChange` → `File` →
  `arrayBuffer()` → `importApkg` code path a real user action would): "Last
  import took 958ms" (matches the Node timing), decks list shows both
  "Default" and "Spanisch 5000 (studying this deck)" (auto-select worked),
  switching to the Study tab shows card id `1586782689812` — **the identical
  id** the Node test independently produced for the same fixture, confirming
  browser and Node are exercising the same real code path. Answered it
  ("Good") successfully, clicked "Next card", got a different real card
  (`1586782689814`). Checked OPFS directly afterward:
  `collection.anki2` grew from 139,264 bytes (the empty/starter fixture) to
  **5,894,144 bytes**, confirming the imported notes/cards/media data was
  actually persisted, not just held in memory. Zero console errors
  throughout the whole sequence.
- Regression-tested the full §7/§8 smoke-test suite
  (`rust/wasm-bridge/smoke-test/run.sh`) after all of the above — unchanged,
  still passing (empty collection → `-1`; with-note collection → real card →
  successful answer).

### 10.5 Known scope boundaries (deliberately not chased this pass)

1. **Media files are not persisted to OPFS.** `import_apkg`'s own
   `MediaManager` writes imported media into Emscripten's in-memory FS
   (`/anki/collection.media`) just fine, but only the collection *database*
   bytes get read back out and persisted (`readCollectionBytes`/
   `persistCollection`) — media files are lost on reload. Acceptable for now
   since the UI doesn't render note fields/media yet at all (`StudyView`
   only shows a card id) — there's nothing to display even if the bytes were
   persisted. Revisit alongside a real note-field renderer.
2. **`with_scheduling: false` is a real behavioural choice, not a bug** — see
   §10.1. Imported cards are always "fresh" regardless of the source
   collection's actual review history/due dates.
3. **No re-import/merge testing.** Importing the same `.apkg` twice, or
   importing into a collection that already has decks/notetypes with
   conflicting names, was not exercised.
4. **`sync_with_server` untouched** — still the stub from §3/§6/§7.
5. `.wasm` is still ~11–12 MB, unoptimized (carried over from §7.7/§8.6).

### 10.6 Independent verification (by the coordinator, not this agent)

Re-verified from a clean rebuild (`bash rust/wasm-bridge/build.sh`, not reusing
this agent's binaries) with a separately-written test script
(`rust/wasm-bridge/smoke-test/import_test.mjs`) against two real files, one
much larger than anything tested above:

- `Spanisch_5000.apkg` (220,950,207 bytes): import in **1097ms**
  (agent reported 976ms — same order of magnitude, different run), deck list
  `[["1","Default"],["1783719977448","Spanisch 5000"]]`, selected the new
  deck, `get_next_card` → `1586782689812n` — **the identical card id**
  independently reproduced in a fresh Node run.
- **New, not tested by the implementing agent**: `2025-06-29-Ankizin_v5_46729-notes_6022_Delete_with_media_fixed.apkg`
  (783,635,419 bytes — a real German medical-school deck, 46,729 notes /
  53,205 cards, 57 decks in a deep `::`-nested hierarchy with non-ASCII
  names). Import completed in **14.3s**, `wasm_list_decks` returned all 57
  decks with correct hierarchical names and umlauts intact, selecting the
  top-level "Ankizin" deck (not a leaf) correctly aggregated cards from its
  subdecks and returned a real card — confirms deck-hierarchy handling works
  through the whole pipeline, not just flat single-deck collections.
- Also drove the actual browser UI myself (not reusing the agent's session):
  clicked "Spanisch 5000" in the real `ImportView` deck list, switched to the
  real `StudyView` tab, got card id `1586782689812` — matching my own
  independent Node run exactly. Zero console errors.

---

## 11. 2026-07-11 — Real card content (question/answer/CSS) + a nested deck tree UI

Addresses the user's feedback: "I only see Card ID as content." Adds
`Collection::render_existing_card` to the bridge and a proper Anki review
flow (question → reveal answer → grade) to `StudyView`, plus fixes
`ImportView`'s deck list to render a real `::`-nested tree instead of a flat
list of full paths (the thing that made Ankizin's 57 decks look like
"separate collections" — they aren't; rslib has no tree structure in storage
at all, hierarchy is purely the `::` in the name string, and real Anki's
desktop app does the same client-side parsing to display a tree).

The implementing agent stalled (background-task watchdog, no progress for
600s) partway through this — twice, in fact, across this project. Both times
it had already done the hard, real diagnostic work and left a clear, working
fix one mechanical step from being wired in; I finished the wiring myself
and independently verified the result rather than re-running the agent.

### 11.1 Rust bridge: `wasm_render_current_card`

`rust/wasm-bridge/src/main.rs` — renders whatever `LAST_CARD` currently holds
via `Collection::render_existing_card(cid, false, false)`
(`rslib/src/notetype/render.rs:46`), strips `[sound:...]`-style av tags with
rslib's own `strip_av_tags` (`card_rendering/mod.rs`), and returns
`{"question", "answer", "css"}` JSON via the existing `wasm_last_result_*`
mechanism.

**A real bug the agent found and root-caused, which I then finished fixing**:
`RenderCardOutput::question()`/`.answer()` are *strict* — they only return
real text when `qnodes`/`anodes` reduce to exactly one `RenderedNode::Text`;
any other shape falls through to the literal string `"not fully rendered"`.
Testing against the actual Ankizin deck, the agent found this hit **~56% of
a real sample** — caused by malformed Cloze notes (no `{{c1::...}}` in the
card's ordinal, a genuine data-quality issue in that specific deck, not a
bug here) making `render_card` emit an error-message node *appended to* a
partial-render node rather than replacing it, so the output is multiple
nodes instead of one clean `Text` node. The agent wrote the fix
(`flatten_rendered_nodes`, which concatenates every node's text — `Text` and
`Replacement` alike) but stalled before wiring it into
`wasm_render_current_card` (which still called the strict `.question()`/
`.answer()`). I wired it in (`rust/wasm-bridge/src/main.rs`, two lines) and
independently re-verified with a **new** test script
(`rust/wasm-bridge/smoke-test/render_test.mjs`, not the agent's own): a fresh
40-card real sample from Ankizin came back with **zero** `"not fully
rendered"` hits, and I specifically hit the exact malformed-Cloze case by
hand — it now correctly surfaces the real error content
(`<div>No cloze ⁨1⁩ found on card...`), i.e. the same honest error message
real Anki desktop would also show for that malformed note, not a
paper-over.

**Known scope boundary, not chased**: note fields may contain
`<img src="...">` referencing collection media. Media files aren't
persisted to OPFS or served anywhere (§10.5) — images show broken. Text-only
for this pass.

### 11.2 `StudyView`: a real question → reveal → grade flow

Previously the UI skipped straight to grading buttons next to a bare card
id. `web/src/state/studySession.ts`'s `reviewing` state gained `content:
CardContent | null` and `revealed: boolean`; new events `CONTENT_LOADED` and
`REVEAL`; `ANSWER` is now only a valid transition once `revealed` is true.
Real flow: card id loads → `getCurrentCardContent()` fetches question/
answer/css → question shown alone → "Show Answer" → answer + ease buttons
shown → grade → next card.

Content renders inside a new `CardFrame` component (`StudyView/CardFrame.tsx`)
using a **sandboxed `<iframe srcDoc>`**, not `dangerouslySetInnerHTML`
directly on the page — deliberate choice over trying to scope/prefix
notetype CSS ourselves: real notetype stylesheets assume they own the whole
page (bare element selectors, `.mobile .disabled`-style rules, etc.),
confirmed against real imported decks, and correctly rewriting arbitrary
author CSS to scope it is a genuinely fiddly parsing problem. The iframe
gives free, perfect isolation both directions. `sandbox` deliberately omits
`allow-scripts` — real card templates do embed `<script>` blocks (confirmed:
Ankizin's cards ship a hint-reveal-shortcut script), and those should not
execute with imported, untrusted deck content. `allow-same-origin` is kept
only so the parent can read `scrollHeight` to auto-size the iframe.

**Verified in the actual browser** (not just the render fix above): the
bundled starter fixture's question ("smoke-test front") shows alone with a
"Show Answer" button; clicking it reveals the answer ("smoke-test back")
with a divider plus the four ease buttons. Zero console errors.

### 11.3 `ImportView`: a real deck tree

New `web/src/ui/ImportView/DeckTree.tsx` — `buildDeckTree` parses every
deck's full `::`-joined name back into a real tree client-side (exported
separately for unit testing), rendered with per-level indentation and
collapse/expand toggles. Clicking a node still calls `setCurrentDeck` exactly
as before (parent-deck selection aggregating subdeck cards was already
confirmed working in §10.6 — pure rendering fix, no bridge change needed).

**Verified in the actual browser** against the real Ankizin file: after
import, the tree correctly showed "Ankizin" as a collapsible root with
"M1_Vorklinik" → "Anatomie" → "Makroskopische_Anatomie" → its own children
nested and indented beneath it, instead of 57 unrelated-looking flat rows.

---

## 12. 2026-07-11 — Delete-deck function

The user asked for a way to delete decks. Implemented directly (not
delegated — by this point the API research and file locations were already
well-established from prior phases, so a fresh agent round-trip wasn't worth
the overhead).

**Rust**: `wasm_delete_deck(deck_id: i64) -> i32`
(`rust/wasm-bridge/src/main.rs`) calls
`Collection::remove_decks_and_child_decks(&[DeckId(deck_id)])`
(`rslib/src/decks/remove.rs:6`) — confirmed from source this **cascades**:
deleting a deck deletes every child deck and all cards (and any
now-orphaned notes) in all of them, exactly matching real Anki desktop
behaviour (there is no "this deck only" delete mode in rslib itself). The
built-in "Default" deck (id 1) is special-cased by rslib to be reset/renamed
rather than truly removed, so deleting it is harmless. If the deleted deck
was the current deck, `get_current_deck()` already falls back to Default on
its own the next time it's called (`decks/current.rs:16-21`) — no extra
handling needed in the bridge.

**TypeScript/UI**: `deleteDeck(deckId)` in `backend.ts`; a "Delete" action
per node in `DeckTree.tsx`, threaded through from `ImportView`, gated behind
a `window.confirm` (cascading, irreversible — no undo across a reload since
the very next `persistCollection()` overwrites OPFS).

**Verified in the actual browser** against the real, freshly re-imported
Ankizin deck (46,729 notes / 53,205 cards / 57 decks): deleted the top-level
"Ankizin" deck — confirmed all 57 decks disappeared in one action (a broader,
even more convincing cascade test than originally planned — an incidental
selector bug in my own test script matched the outer "Ankizin" row instead
of an inner one, which turned out to be a better test), leaving only
"Default". **Confirmed the deletion actually persisted, not just in-memory**:
after a full page reload, the deck list still showed only "Default" and
`StudyView` fell back to the starter fixture's own card. Zero console
errors throughout.

---

## 13. 2026-07-11 — Media (audio + images) that actually works, persisted across reloads

Addresses the user's report: "cards can come with audio and images, both are
not working." Both are now real: `[sound:...]` tokens render as playable
`<audio controls>` widgets and `<img src="file">` references show the real
image, and both survive a page reload. Verified against the real
`Spanisch_5000.apkg` (6853 media files, 218 MB) in the actual browser.

### 13.1 The two gaps that were closed

1. `wasm_render_current_card` used to run rslib's `strip_av_tags` over the
   question/answer HTML, which **deletes** `[sound:file.mp3]` tags entirely
   (rslib parses them as `SoundOrVideo` nodes and `write_without_av_tags`
   drops them). It now returns the HTML **verbatim** — `[sound:...]` tokens and
   `<img>` tags intact — and the JS layer resolves them. The `strip_av_tags`
   import was removed from `main.rs`.
2. Media files existed only on Emscripten's in-memory FS
   (`/anki/collection.media`, written there by `import_apkg`'s own
   `MediaManager`), which is wiped on every reload. They're now copied out to
   OPFS after import and read back from OPFS at render time.

### 13.2 Rust bridge additions (`rust/wasm-bridge/src/main.rs`, `build.rs`)

Three new `extern "C"` exports (all added to `build.rs`'s `EXPORTED_FUNCTIONS`),
operating on `MEDIA_FOLDER = "/anki/collection.media"` (derived, as documented
in §10.1, from `COLLECTION_PATH` via rslib's `with_extension("media")`):

- `wasm_list_media_files() -> i32` — `std::fs::read_dir` the media folder,
  JSON-encode the filenames via `set_last_result`. A missing folder yields
  `[]`, not an error (a collection with no media is normal).
- `wasm_read_media_file(name_ptr, name_len) -> i32` — `std::fs::read` the named
  file and write its **raw bytes** (not JSON) via `set_last_result`; negative +
  `set_last_error` if it doesn't exist. The JS side reads these back with a new
  `readLastResultBytes` helper (a copy of the `LAST_RESULT` buffer that is *not*
  UTF-8-decoded, unlike `readLastResult`).
- `wasm_write_media_file(name_ptr, name_len, data_ptr, data_len) -> i32` —
  `std::fs::write` raw bytes into the media folder (creating it first). Used to
  restore media into MEMFS; see §13.4 on why this is deliberately *not* on the
  hot path.

### 13.3 TypeScript layers

- `web/src/wasm/backend.ts`: `listMediaFiles()`, `readMediaFile(name)`,
  `writeMediaFile(name, bytes)` — same alloc/write/call/dealloc convention as
  every other export.
- `web/src/db/opfs.ts`: media stored one-file-per-name under a `media/`
  subdirectory of the OPFS root (`getDirectoryHandle('media', {create})`).
  New `writeOpfsMediaFile` / `readOpfsMediaFile` (returns `null` if absent) /
  `listOpfsMediaFiles`.
- `web/src/db/collection.ts`: `persistMedia()` copies every file the backend
  has (`listMediaFiles` → `readMediaFile`) out to OPFS; called from
  `ImportView` right after `importApkg` + `persistCollection`. Sibling
  `restoreMediaToBackend()` exists but is intentionally unused on the hot path
  (§13.4).
- `web/src/ui/StudyView/media.ts`: `resolveMediaInHtml(html, fetchMedia?)`
  rewrites `[sound:...]` → `<audio controls>` and bare `<img>/<source>/
  <audio>/<video>` `src` filenames → inline media (details in §13.5). Wired
  into `StudyView` so both question and answer HTML are resolved before being
  handed to `CardFrame`.

### 13.4 Design choice: display reads from OPFS directly; no eager MEMFS restore

The briefed plan was to restore *every* media file back into the wasm backend's
MEMFS on load (`writeMediaFile` in a loop) and resolve display media by reading
from MEMFS (`readMediaFile`). Measured, that restore is a real first-load cost
for large decks, and — crucially — **card rendering never reads media bytes**:
`render_existing_card` only emits filenames in the HTML. So display media can be
served straight from OPFS (`readOpfsMediaFile`) with **no** MEMFS rehydration at
all. This is both faster (nothing on the load hot path) and simpler (works
identically before and after a reload). `restoreMediaToBackend()` is kept for
the operations that *do* read media bytes (re-export, media check — none wired
up yet), but is deliberately off the bootstrap path.

Note this also means the media *database* (`collection.mdb`) and the MEMFS media
folder are still not persisted — only the collection DB and the media *files*
(in OPFS). That's fine for display and for re-import (rslib rebuilds media DB
state as needed); revisit if a media-reading rslib op is ever wired up.

### 13.5 `resolveMediaInHtml`: data: URLs, not blob: URLs

`resolveMediaInHtml` produces **`data:` URLs**, not `blob:` URLs. This is forced
by the CardFrame sandbox change in §14: the card iframe is now
`sandbox="allow-scripts"` **without** `allow-same-origin`, giving it an *opaque*
origin. `blob:` URLs are keyed to the origin that created them, so a
parent-created `blob:` URL **cannot be loaded from the opaque-origin iframe** —
this was verified as a real gotcha, exactly the one the original task flagged.
`data:` URLs carry their bytes inline, are not origin-scoped, and load fine in
the opaque-origin iframe. They also need no `URL.revokeObjectURL` lifecycle
management (the blob-URL leak concern the task raised simply doesn't exist), so
there is nothing to clean up when moving to the next card.

Mechanics: `[sound:...]` tokens are matched on the raw string and replaced with
`<audio controls preload="metadata" src="data:...">`; `<img>` (and
`<source>/<audio>/<video>`) `src` attributes are rewritten via `DOMParser` (so
attribute order/quoting/entities are handled robustly). Filenames are
`decodeURIComponent`'d (a real file `a b.png` may appear as `a%20b.png`). MIME
is inferred by extension; bytes → data URL via `FileReader.readAsDataURL` over a
`Blob`. Missing media: `[sound:]` tokens are dropped (no element to leave); a
missing `<img>` keeps its bare filename (a visibly-broken image beats silently
vanishing). Unit-tested in `web/tests/ui/media.test.ts` (7 tests, injectable
byte source — no browser needed).

### 13.6 Real measurements (Node + browser, `Spanisch_5000.apkg`, 6853 files / 218 MB)

- Node (`rust/wasm-bridge/smoke-test/media_test.mjs`, kept as a standing test):
  `import_apkg` 995 ms; `wasm_list_media_files` returns 6853 names; reading
  **all** 6853 files out of MEMFS via `wasm_read_media_file` = **30 ms**;
  writing all 6853 back via `wasm_write_media_file` = **188 ms**. So the
  wasm/MEMFS side of media I/O is negligible.
- Browser (real UI import): import **936 ms**; then `persistMedia()` copying all
  **6853 files (218 MB) into OPFS = 4151 ms** (~4.2 s, one-time, during import,
  not on every load). Confirmed OPFS `media/` held all 6853 files afterward.
- **Reload persistence (the whole point), confirmed:** after a full page reload,
  OPFS `media/` still held all 6853 files, and `resolveMediaInHtml('<img
  src="verbo.jpg">[sound:s5000_99_spanisch.mp3]')` produced a real
  `data:image/...` and a real `data:audio/mpeg;...` read back from OPFS — i.e.
  the display path works with MEMFS empty, purely off persisted OPFS media.

The 4.2 s per-file OPFS write cost (thousands of `createWritable`/`write`/
`close` cycles) is the one honest rough edge: acceptable as a one-time import
step, but if it ever needs to be faster, a single `FileSystemSyncAccessHandle`
from a worker (already flagged in `opfs.ts`'s header) or batching would help.
Not optimized now — measured, and left simple.

### 13.7 Verified in the actual browser

- An `<img>` rendered a real image (the "spanisch 5000" logo, then a portrait
  photo on a vocab card) inside the sandboxed iframe — not broken.
- A real vocab card ("sein (Eigenschaft, Zeit)" / "ser (irr.)") showed a working
  `<audio controls>` widget. The audio `data:` URL was fed through
  `AudioContext.decodeAudioData` in the parent and decoded to genuine audio
  (0.72 s, 48 kHz, mono MP3) — proving it's real playable sound, not a
  placeholder.
- Both survived a full page reload (§13.6).
- Zero console errors/warnings throughout.
- (Data-quality aside, not a bug: several `.jpg`-named files in this deck are
  actually PNG bytes. We label the data URL `image/jpeg` by extension; the
  browser sniffs and renders them fine.)

---

## 14. 2026-07-11 — Enable card-template scripts (opaque-origin sandbox) + postMessage resize

Addresses two more user reports: (1) the card frame defaulted to a tiny height,
and (2) some real Spanisch_5000 cards show a "Seite 3" link that "doesn't do
anything." Both traced to the same root cause: `CardFrame`'s iframe was
`sandbox="allow-same-origin"` with **no** `allow-scripts`, so the deck's own
`<script>` blocks and inline `onclick` handlers never ran — the "Seite 3" link
is an `<a class="hint" onclick="...getElementById('hint...').style.display=
'inline-block'...">` expand-for-more toggle, and the deck also ships
text-to-speech and dynamically-generated-text scripts. None executed. The user
chose (via the coordinator) to enable script execution — same trust model as
real Anki desktop/mobile, which don't sandbox note-content JS either.

### 14.1 The secure sandbox: `allow-scripts` WITHOUT `allow-same-origin`

`CardFrame.tsx` now uses `sandbox="allow-scripts"` and deliberately **omits**
`allow-same-origin`. Combining the two on a sandboxed iframe is a well-known
escape: together they let embedded script reach `window.parent` and drive the
real app (the iframe is then treated as same-origin with the embedder). Leaving
`allow-same-origin` off gives the iframe an **opaque** origin — deck scripts run
but are walled off from the parent app entirely. (This opaque origin is exactly
why display media had to switch from `blob:` to `data:` URLs — see §13.5.)

### 14.2 Cross-origin-safe auto-resize via postMessage

Dropping `allow-same-origin` breaks the old resize mechanism, which read
`iframe.contentDocument.body.scrollHeight` (a cross-origin access, now blocked).
Replaced with the standard pattern: a small measuring script is injected into
the `srcDoc` `<head>` (ahead of the note's own content); it measures
`document`/`body` scroll height and reports it to the parent via
`parent.postMessage({source: 'anki-card-frame', height}, '*')`, re-measuring on
`load`, on `resize`, on a `ResizeObserver` over the document element, and on two
short `setTimeout`s (to catch async media/script layout shifts). The parent
listens for `message` events, validates that `event.source === iframe.contentWindow`
**and** the distinguishable `{source:'anki-card-frame'}` shape (origin can't be
validated — it's `"null"` for the opaque iframe), and sets its height state.
Default height bumped 80 → 120 px so the frame isn't collapsed before the first
message arrives.

### 14.3 Verification (real browser, real Spanisch_5000 card)

- **Script execution proven, definitively:** the iframe auto-resized from the
  120 px default to 721 px (logo card) and 986 px (a vocab answer) — a height
  change is *only* possible if the injected `<script>` ran and posted its
  message, so `allow-scripts` genuinely executes JS in the opaque sandbox.
- **"Seite 3" mechanism confirmed wired:** the exact toggle anchor
  (`<a class="hint" href="#" onclick="this.style.display='none';
  document.getElementById('hint4753594160').style.display='inline-block';
  return false;">`) is present in the rendered DOM, and its target
  `#hint4753594160` exists. It is inline-onclick JS of the same class as the
  (proven-executing) injected script, so it toggles when clicked. Honest caveat:
  a *physical* click into the cross-origin sandboxed iframe couldn't be
  performed with the available preview tooling (CSS-selector clicks don't pierce
  an opaque-origin frame, and no external Chrome was connected for a coordinate
  click) — the coordinator will confirm the click itself in a real browser.
- Deck scripts (TTS `speechSynthesis`, dynamic text) run inside the iframe;
  any errors they throw are the deck author's, isolated to the iframe, and can't
  touch the parent app. Zero errors in the *parent* console throughout.
- `data:`-URL media loads fine in the opaque-origin iframe (§13.5) — confirmed
  by the image + audio rendering described in §13.7.

---

## 15. 2026-07-11 — Root-caused and fixed the intermittent "reload shows the wrong card" bug

The user reported: after importing a real deck and selecting it, reloading the
page was flaky — roughly half the time `StudyView` reverted to showing the
*original bundled starter fixture's* card ("smoke-test front") instead of a
real card from the imported deck, even though the correct deck's data was
genuinely sitting in OPFS the whole time (confirmed: `collection.anki2` in
OPFS was consistently 5,902,336 bytes, matching the imported collection, not
the 139,264-byte starter).

### 15.1 Ruling out the obvious suspects

Added temporary logging to `ensureCollectionReady()` and confirmed, across
*multiple reloads where the bug still occurred*: `loadInitialCollectionBytes()`
correctly returned `5902336` bytes every time, and `openCollection()` /
`persistCollection()` both completed without throwing every time. So it
wasn't stale bytes being read from OPFS, and `wasm_open_collection` wasn't
returning an error. `grep -rn "openCollection("` confirmed exactly one call
site. This ruled out the naive theories (wrong bytes, a duplicate/racing
bootstrap path, an error being silently swallowed).

### 15.2 Real root cause: unflushed SQLite WAL

rslib opens collections with `journal_mode = wal` + `locking_mode = exclusive`
(`rust/vendor/anki/rslib/src/storage/sqlite.rs`). In WAL mode, writes
(`open_collection`'s own setup, `import_apkg`, `set_current_deck`,
`answer_card`, `delete_deck`, ...) land in a `<COLLECTION_PATH>-wal` sidecar
file, not the main `.anki2` file — the main file only gets those writes
merged in when SQLite performs a **checkpoint**, which under exclusive locking
happens lazily (not after every write). `readCollectionBytes()` (used by
`persistCollection()`) only ever read the main file via `Module.FS.readFile(COLLECTION_PATH)`
— the `-wal` sidecar lives on Emscripten's in-memory MEMFS, which is wiped on
every page reload, and was never persisted to OPFS at all. So anything still
sitting in the WAL (which, after a single import + deck selection, is
*most of the collection* — see the numbers below) was silently lost on every
reload, and the reopened collection reverted to whatever had last been
checkpointed — for a fresh app, that's the original starter fixture's state.
Whether enough operations had accumulated to cross SQLite's own automatic
WAL-auto-checkpoint threshold (~1000 pages) by chance is what made the bug
*look* intermittent in casual browser testing — it isn't actually random.

### 15.3 The fix

`rust/wasm-bridge/src/main.rs`: new `wasm_checkpoint()` export, calling
`col.storage.checkpoint()` (a `PRAGMA wal_checkpoint(TRUNCATE)`-equivalent,
same mechanism `Collection::maybe_backup` already uses before copying the DB
for a backup). `web/src/wasm/backend.ts`'s `readCollectionBytes()` now calls
`wasm_checkpoint()` before reading the main file back out — so every
`persistCollection()` call (after open, import, deck selection, answering,
deletion) flushes the WAL first. A no-op checkpoint on an already-flushed WAL
is harmless, so this is safe to call unconditionally on every persist, not
just after known-heavy writes.

### 15.4 Verification (real numbers, not a hunch)

A fast, deterministic Node reproduction was built
(`rust/wasm-bridge/smoke-test/repro_wal.mjs`) that faithfully mimics the
browser flow in a single process — instance A: open the starter fixture,
import a real `.apkg`, select the new deck, read the main file back out
exactly like `persistCollection()` does; instance B (a fresh module instance,
simulating a reload with MEMFS wiped): write back *only* those main-file
bytes, open, and check what `get_next_card` returns. It also reports the
`-wal` sidecar's size before/after the checkpoint call, toggleable via a
command-line flag so before/after can be compared directly:

```
$ node repro_wal.mjs Spanisch_5000.apkg 15            # no checkpoint (baseline)
...wal(before=5887512B after=5887512B) main=5902336B => reload[...] BUG (starter card)
   (repeated identically for all 15 iterations)
RESULT: 15/15 reloads showed the starter card (100% failure), checkpoint=false

$ node repro_wal.mjs Spanisch_5000.apkg 15 checkpoint  # with the fix
...wal(before=5887512B after=0B) main=5902336B => reload[id=1586782689812 ...] ok (real card)
   (repeated identically for all 15 iterations)
RESULT: 0/15 reloads showed the starter card (0% failure), checkpoint=true
```

5.88 MB was sitting unflushed in the WAL — nearly the entire imported
collection. **100% → 0% failure, deterministically, not a probabilistic
improvement.**

Also specifically tested the regression risk flagged mid-investigation
(checkpointing immediately after open, before any import, in case it broke a
*subsequent* import): opened the starter fixture, checkpointed immediately
(simulating `ensureCollectionReady`'s unconditional post-open persist), then
ran a real `import_apkg` against the 220MB Spanish file — succeeded cleanly
(`rc=0`, 988ms), and a further checkpoint after import also succeeded. No
reproduction of any regression from this sequence.

Independently re-verified end-to-end in the actual browser (not just Node):
cleared OPFS entirely (simulating a fresh install), imported the real 220MB
Spanish deck through the genuine UI (file input → `DataTransfer` → `change`
event, exact same code path a real user action would take), selected the
deck, then reloaded **20 times in a row** — every single reload correctly
showed the real imported card, confirmed both visually (screenshot) and by
querying `getCurrentCardContent()` directly. Combined with the 15/15 (fixed)
Node-harness runs: **35 consecutive successes, 0 failures**, against 15/15
(100%) failures on the same Node harness without the fix.

Full test suite (`npm --prefix web test -- --run`) still passes (37/37) after
the fix; a fresh `bash rust/wasm-bridge/build.sh` is clean.

## 16. 2026-07-11 — Real deck-overview / home screen

Requested after the user shared a screenshot of real Anki desktop's deck list
("Stapelübersicht": Neu/Nochmal/Fällig — New/Learn/Due — per deck). The goal
was a Home screen you land on that shows every deck's due counts and lets you
jump straight into studying one, matching that screen.

**New bridge export: `wasm_get_deck_tree`.** rslib already has exactly what's
needed — `Collection::deck_tree(Some(timestamp))` — which:
- builds the real `::`-nested hierarchy (unlike `wasm_list_decks`, which
  returns a flat `(id, name)` list the JS side had to re-parse into a tree
  client-side — see §11's `DeckTree.tsx`/`buildDeckTree`),
- unburies previous-day-buried cards (matching what opening the real deck
  list does),
- and populates `new_count`/`learn_count`/`review_count` — already
  limit-applied and already including children, i.e. exactly the numbers real
  Anki's deck list shows, not raw unfiltered totals.

`DeckTreeNode` (the proto type) isn't re-exported by `anki::decks::*` the way
several sibling types are (`DeckKind`, `FilteredSearchTerm`, ...), so
`rust/wasm-bridge/Cargo.toml` gained a direct path dependency on
`anki_proto` (`../vendor/anki/rslib/proto` — the identical crate anki's own
workspace resolves to, so no duplicate compile) just to name the type. The
tree is hand-serialized to JSON recursively (`deck_tree_node_to_json`, same
manual-JSON style as `wasm_list_decks` — no `serde::Serialize` derive on a
type this crate doesn't own), with `deckId` as a **string** (same
`Number.MAX_SAFE_INTEGER` overflow reasoning as every other deck id in this
bridge).

**Consolidated the two deck-list UIs into one.** Before this, `ImportView`
had its own deck picker (`DeckTree.tsx` + `buildDeckTree`, parsing
`wasm_list_decks`' flat names back into a tree client-side, no due counts) for
"pick which deck to study." That's now `HomeView`'s job — it shows the real
backend-built tree with counts and doubles as deck selection (click a deck
name → `setCurrentDeck` + persist → hand off to the Study tab) and deletion
(same cascading `deleteDeck` as before). `ImportView` was cut down to just the
file-picker/import flow (still auto-selects a newly-imported deck
programmatically, matching prior behaviour, just without its own picker UI to
show the result). `DeckTree.tsx` and its test were deleted outright rather
than left as dead code — the real backend tree fully supersedes the
client-side name-parsing one.

`App.tsx` gained a `home` tab, first in the tab order and the default view on
load — the user lands on the deck overview first, same as real Anki's
"deck list" being the app's home screen rather than dropping straight into a
review session.

Verified in the real browser against OPFS-persisted state from the earlier
Spanish-deck import: Home correctly shows `Default` (1 new) and
`Spanisch 5000` (14 new, 5 learn); clicking `Spanisch 5000` switches to Study
and immediately renders a real card from that deck. `ImportView` still
functions standalone with the picker removed. Full test suite passes (33/33
— down from 37/37, the 4 removed `DeckTree.test.ts` cases; no coverage lost,
that logic no longer exists).

## 17. 2026-07-11 — Real sync attempt: hard-blocked on reqwest's wasm backend needing wasm-bindgen

Attempted to wire up real Anki sync (`sync_login` + `NormalSyncer::sync`)
against the user's self-hosted `anki-sync-server`. Every sync HTTP call in
rslib funnels through one function,
`IoMonitor::zstd_request_with_timeout` (`rust/vendor/anki/rslib/src/sync/http_client/io_monitor.rs`),
which was previously stubbed to always return "not implemented" for wasm
(the `mio`/`tokio-net` blocker from §2-4 was already fixed for everything
*except* this one transport function). The plan was: implement a real
non-streaming version (reqwest-wasm has no streaming `Body`/response
support) and see how far the existing, unmodified sync protocol logic gets.

**Derisking result: a hard `LinkError`, not a fixable flag.** reqwest 0.12's
wasm backend (`reqwest-0.12.28/src/wasm/`) calls the browser's `fetch()` via
`wasm_bindgen`/`js_sys`/`web_sys` — externs that need the `wasm-bindgen` CLI's
generated JS glue to resolve. This project deliberately never runs that CLI
(it doesn't understand Emscripten's `MODULARIZE` output at all — see the
doc comment atop `rust/wasm-bridge/src/main.rs`), so those imports are
unsatisfiable. Concretely tested: building a `reqwest::RequestBuilder`
(`.post(url).header(...).build()`) needs only **one** missing symbol
(`__wbindgen_throw`, from `Client::new()`'s internal `unwrap_throw`) — but
actually calling `.send()` to dispatch the request pulls in **58** undefined
wasm-bindgen-JS-interop symbols. This is a real toolchain incompatibility,
not a missing Cargo feature: reqwest's wasm transport and an Emscripten-only,
non-wasm-bindgen build are fundamentally at odds.

A real fix exists but is substantial new engineering, not a quick patch: skip
reqwest's `.send()` path entirely and implement a custom transport — e.g. run
the sync operation on a background pthread (this build already has
pthreads/`SharedArrayBuffer` working for other things) and call Emscripten's
own native `emscripten_fetch` C API in its synchronous mode (a standard,
well-documented pattern for blocking HTTP from a worker thread in Emscripten
C/C++/Rust code, requiring no wasm-bindgen at all). This was not attempted —
scoped as a distinct, uncertain follow-up rather than open-ended work in this
session. Presented to the user as a real decision point (continue now vs.
pause); they chose to pause and prioritize the statistics view instead. All
throwaway derisking code (`wasm_test_fetch`, the temporary `reqwest`/`tokio`
deps) was removed; the tree is back to exactly its pre-attempt state
(`wasm_sync_with_server` is still the original stub).

## 18. 2026-07-11 — FSRS as the default scheduling algorithm

Requested directly: make FSRS (Free Spaced Repetition Scheduler) the active
algorithm instead of legacy SM-2, matching real Anki's own default for new
collections since 23.10.

Turned out to be a single collection-level config flag, not a scheduling
reimplementation or even a per-deck setting: `BoolKey::Fsrs`
(`rust/vendor/anki/rslib/src/config/bool.rs:40`, re-exported at
`anki::prelude::BoolKey`). Every real scheduling call site — `answer_card`,
`get_next_card`'s queue building, filtered-deck building — already branches on
`self.get_config_bool(BoolKey::Fsrs)` directly; turning it on doesn't touch
anything else. `wasm_open_collection` (rust/wasm-bridge/src/main.rs) now calls
```rust
col.set_config_bool(BoolKey::Fsrs, true, false)?;
```
right after building the `Collection`, before it's stored in `COLLECTION`.
Set unconditionally on every open (idempotent — this app has no UI to turn it
back off, and imports already discard scheduling state via
`with_scheduling: false`) rather than only for brand-new collections.

Per-deck FSRS *parameters* (`DeckConfig.inner.fsrs_params_4/5/6`) are left at
their default `vec![]` — confirmed safe, not an oversight: `answer_card`
builds `FSRS::new(Some(params))` with whatever `DeckConfig::fsrs_params()`
returns, and the vendored `fsrs` crate treats an empty slice as "use my
built-in `DEFAULT_PARAMETERS`," not an error (real Anki desktop does the same
before a user has ever run "Optimize" to fit personalized weights from their
own review history).

Verified in the real browser: reloaded, opened the Spanish deck from Home,
revealed and graded a real card ("Good") — `answer_card` completed and
advanced to the next card with no error, confirming FSRS-backed scheduling
runs end-to-end through the exact same UI flow as before. Full test suite
still passes (33/33).

## 19. 2026-07-11 — Statistics view

New `wasm_get_stats` bridge export, backed by the same real computation real
Anki desktop's stats screen uses: `Collection::graphs` (the `StatsService`
trait's `graphs(GraphsRequest)`, at `anki::services::StatsService` —
`rust/vendor/anki/rslib/src/stats/service.rs`) and `Collection::studied_today`.
`GraphsResponse` is a large protobuf message (15 optional sub-messages,
mostly `HashMap<day/interval, count>` chart-bucket data meant for client-side
chart rendering) — impractical and unnecessary to hand-serialize wholesale,
so this bridge picks out a handful of scalar headline numbers instead:

- `today` (answer count/correct count/time/mature-correct) — direct fields on
  `GraphsResponse.today`, no computation needed.
- `cardCounts` (new/learn/relearn/young/mature/suspended/buried) — direct
  fields on `GraphsResponse.card_counts.including_inactive`.
- `dueToday`/`dueThisWeek`/`backlog` — summed ourselves from
  `GraphsResponse.future_due.future_due`, a `HashMap<i32, u32>` keyed by day
  offset from today (0 = due today, negative = overdue backlog); see
  `rust/vendor/anki/rslib/src/stats/graphs/future_due.rs`. This map already
  covers every non-suspended card regardless of the `days` request
  parameter (that only bounds the revlog window for charts not exposed
  here), so `days: 365` in the request is just a generous, arbitrary value.
- `fsrs` — `GraphsResponse.fsrs`, a nice free confirmation that §18's
  scheduling change is actually active.
- `studiedTodayText` — `Collection::studied_today()`'s real, translated
  "Studied N cards in M minutes today" sentence, used verbatim.

New `StatisticsView` (web/src/ui/StatisticsView/index.tsx), added as a
"Stats" tab in `App.tsx` between Import and Sync. Verified in the real
browser against the existing Spanish-deck study session: showed "Studied 29
cards..." (83% correct), `Scheduling algorithm: FSRS` (confirming §18), due
counts, and card-count breakdown (14996 new, 4 in learning) — all real
numbers matching what had actually happened in this session, not placeholder
data. Full test suite passes (33/33), typecheck clean, fresh wasm build clean.

## 20. 2026-07-12 — Real sync, unblocked: `emscripten_fetch` replaces reqwest's `.send()`

§17 stopped at a confirmed hard `LinkError`: reqwest's wasm `.send()` needs
wasm-bindgen JS glue this Emscripten-only build never produces. The fix
picked up here, per the plan proposed at the end of §17: keep reqwest only to
*build* the request (method/url/headers — proven safe already), and perform
the actual HTTP I/O with Emscripten's own native `emscripten_fetch` C API in
its synchronous mode, from a background `std::thread` (a real Web Worker
under `wasm32-unknown-emscripten`, backed by the pthreads support this build
already has working for tokio/rayon).

### 20.1 Derisking, done first and reported honestly before building further

Added a throwaway export (`wasm_test_fetch_start`/`_poll`, since removed) that
spawned a `std::thread` and called synchronous `emscripten_fetch` against a
real reachable URL, reporting status via a poll (never `.join()` — blocking
join from the main thread itself hit Emscripten's `unwind` abort; the main
thread must never block on a worker, only start it and poll). Node could not
complete this test (`XMLHttpRequest is not defined` — Node has no XHR, and
`emscripten_fetch`'s sync path is XHR-based), so this was verified for real
in an actual browser: an isolated static server (its own port, own origin,
COOP/COEP headers, no relation to the app's `:5173` origin/OPFS bucket) using
`preview_start`/`preview_eval`. Result: `crossOriginIsolated=true`,
`SharedArrayBuffer` available, and a GET to `https://httpbin.org/get` returned
a genuine HTTP 200 with the real response body — proof that
`std::thread::spawn` produces a real, schedulable worker under this target,
and synchronous `emscripten_fetch` really dispatches network I/O from it.
This derisking used a *separate* Node process and a *separate* browser tab
the whole time; it never touched the user's real `:5173` session or its OPFS
data.

### 20.2 Transport: `IoMonitor::zstd_request_with_timeout`'s wasm branch (vendored patch)

`rust/vendor/anki/rslib/src/sync/http_client/io_monitor.rs` — replaced the
`#[cfg(target_family = "wasm")]` stub (always `NOT_IMPLEMENTED`) with a real
implementation:

1. `request.header(CONTENT_TYPE, ...).build()` — extracts method/url/headers
   from the `RequestBuilder` (pure Rust, no wasm-bindgen involvement).
2. `zstd::encode_all(request_body, 0)` — one-shot compression (anki already
   depends on `zstd` directly elsewhere, e.g. `colpkg/export.rs`), wire-
   compatible with the server's streaming `async_compression` zstd (still
   standard zstd frames either way).
3. A hand-written `#[repr(C)]` FFI module (`emfetch`, field-for-field matching
   `emscripten/fetch.h` — verified byte-for-byte against the actual generated
   JS glue's hardcoded struct-field byte offsets, see 20.4) builds an
   `emscripten_fetch_attr_t` with the method, a null-terminated
   `{key,value,...,0}` header array, the compressed body, and
   `EMSCRIPTEN_FETCH_SYNCHRONOUS`, then calls `emscripten_fetch` — a real,
   blocking network round-trip.
4. `zstd::decode_all` on the response body; non-2xx or status 0 (network
   error/timeout — XHR reports no HTTP status) becomes an `HttpError`.

Deliberate simplifications vs. the non-wasm version above it in the same
file: no incremental streaming (both bodies are handled in one shot — sync
payloads are bounded by `MAXIMUM_SYNC_PAYLOAD_BYTES_UNCOMPRESSED` already), no
`IoMonitor`/stall-timeout race (replaced by `emscripten_fetch`'s own
`timeoutMSecs`, set from the caller's `stall_duration`). Everything else in
the real sync protocol above and around this function (login, meta check, the
full `NormalSyncer` algorithm, sanity checks) is unmodified rslib logic.

**A second, real bug found and fixed empirically, not by inspection.**
Building a request with a body and a custom header consistently failed with
`HttpError { code: 303, context: "sync server returned HTTP 0" }` against a
real same-origin mock server — no exception surfaced anywhere in Rust, no
network request even visible in DevTools. Root cause, found by testing
Emscripten's generated `fetchXHR()` JS directly: it does
`xhr.send(HEAPU8.subarray(dataPtr, dataPtr + dataLength))`, and that subarray
is a *view over the wasm heap's backing `SharedArrayBuffer`* (mandatory for
pthreads). Browsers reject sending a `SharedArrayBuffer`-backed view:
`"Failed to execute 'send' on 'XMLHttpRequest': The provided ArrayBufferView
value must not be shared."` — confirmed by reproducing it directly with a
bare `new SharedArrayBuffer(16)` + `xhr.send(view)` in the browser console.
This is the *exact same bug class* already hit and fixed on the read side in
§8.2 (`TextDecoder.decode()` rejecting the pthreads-backed heap) — anything
that hands a live wasm-memory view to a browser API that specifically
special-cases and rejects `SharedArrayBuffer` needs a plain, non-shared copy
first. Fixed with a one-line, self-verifying `sed` patch applied to Emscripten's
*generated* glue at the end of `rust/wasm-bridge/build.sh` (there is no
upstream flag for this): `xhr.send(data)` → `xhr.send(data?data.slice():data)`
(`TypedArray.prototype.slice()` returns a fresh, non-shared copy). The build
script asserts the substring appears exactly once before and after patching,
so a future emscripten version that changes this code shape fails loudly
instead of silently no-op'ing.

**Also found:** `reqwest::Client::new()` (the wasm impl) does
`Client::builder().build().unwrap_throw()` — that one `.unwrap_throw()` (from
`wasm_bindgen::UnwrapThrowExt`, infallible in practice here) is the *only*
reason a wasm-bindgen `__wbindgen_throw` import was reachable from this
binary at all, and that import cannot be satisfied (needs wasm-bindgen-CLI
JS glue this build never produces) — it failed at *instantiation*
("import requires a callable"), not at a call site, since wasm imports are
resolved eagerly regardless of reachability. Fixed by never calling
`Client::new()`: `rust/wasm-bridge/src/main.rs`'s `build_sync_http_client()`
calls `Client::builder().build().expect(...)` instead (plain
`Result::expect`, no wasm-bindgen involvement whatsoever) — with nothing left
referencing `Client::new()`'s body, `lto = true` (already set in this crate's
release profile) drops it entirely, and the import requirement disappears
with it. Confirmed empirically: this is what took the link from one
undefined-import instantiation failure to a clean, zero-undefined-symbol
build.

Regenerated `rust/vendor-patches/anki-26.05.patch` afterwards (`cd
rust/vendor/anki && git diff > ../../vendor-patches/anki-26.05.patch`,
capturing this change cumulatively with every prior patch).

### 20.3 New bridge exports (`rust/wasm-bridge/src/main.rs`)

Both new exports *start* their work on a spawned `std::thread` and return
immediately (0, or negative only for a bad argument) — the browser's main
thread must never block on `emscripten_fetch`'s synchronous mode, so JS polls
`wasm_sync_poll()` (1 = running, 2 = done OK, negative = error/`-100` = full
sync required) rather than the wasm call itself blocking:

- `wasm_sync_login(username, password, endpoint)` — calls
  `anki::sync::login::sync_login`. On success, the returned `hkey` is written
  via `wasm_last_result_ptr/len`.
- `wasm_sync_collection(hkey, endpoint)` — builds `SyncAuth { hkey, endpoint,
  io_timeout_secs: None }` and an `HttpSyncClient`, then runs
  `NormalSyncer::new(&mut col, server).sync()` on a `tokio::runtime::Builder
  ::new_current_thread()` (the established pattern for driving async rslib
  code to completion from sync-shaped code — the transport's own blocking
  `emscripten_fetch` call happens inline when the future is polled, on the
  same worker thread, so no further thread hop is needed inside the sync
  itself). `SyncActionRequired::NoChanges`/`NormalSyncRequired` → success;
  `FullSyncRequired` → a distinct `-100` error code (full upload/download is
  out of scope for this pass — the error message tells the user to do their
  first full sync from Anki desktop).
- Both endpoints (empty string) resolve to official AnkiWeb, or accept a
  self-hosted server URL — including plain `http://`, not just `https://`,
  per a real user requirement (`parse_endpoint` normalises/validates the URL
  and adds a trailing slash rslib's endpoint-joining logic needs).
- Error messages from these two exports use `format!("{e:?}")` (`Debug`),
  not the shared `set_last_error`'s usual `Display` — `AnkiError`'s derived
  `snafu` `Display` prints just the bare variant name (e.g. `"SyncError"`)
  for variants without an explicit format string, while `Debug` recurses
  into the real nested detail (HTTP status, context, network error kind),
  which is what you actually want when diagnosing a real sync failure.

### 20.4 What "confirmed working" actually means here — evidence, not assumption

Verified for real, against a same-origin mock sync server (Node, native
`zlib.zstdCompressSync`/`zstdDecompressSync`) in an actual browser (isolated
static server/origin, no relation to the app's real `:5173`/OPFS):
`wasm_sync_login` ran end-to-end — real zstd-compressed request body, the
custom `anki-sync` header, a real POST dispatched via synchronous
`emscripten_fetch`, a real response received and zstd-decompressed, parsed by
rslib's own unmodified login-protocol code into a `HostKeyResponse`, hkey
returned correctly (`"MOCK_HKEY_12345"`, matching what the mock server sent).
The mock server's own log confirmed the request it received: correct
`Content-Type: application/octet-stream`, the `anki-sync` header present, a
valid zstd-decodable body containing the exact expected JSON
(`{"u":"testuser","p":"testpass"}`). Since `wasm_sync_collection`'s
`NormalSyncer::sync()` funnels through this exact same transport function for
every protocol step (meta/start/apply_changes/chunk/apply_chunk/sanity_check/
finish), this is direct evidence the transport itself — the only genuinely
new code in this session — works correctly, not just that it compiles.

**What remains unverified** (the orchestrating session/user should check
against the real server): the full `NormalSyncer` protocol exchange end to
end against `anki-sync-server` specifically (not the shallow mock above), and
anything server-specific about the user's own self-hosted instance
(`http://192.168.178.4:8081/`, per the user — unreachable from this sandbox,
and the user mentioned they haven't yet confirmed that server works with
real Anki desktop either, so a failure there may not indicate a bug in this
implementation at all). `FullSyncRequired` handling is implemented but its
error path (not just its happy path) was not exercised against a real
server. Auth failure / expired-hkey / network-down error surfacing is
implemented (falls through to the generic `Debug`-formatted error) but not
exercised against a real unreachable/rejecting server from this sandbox.

### 20.5 Web app (`web/src/wasm/backend.ts`, `web/src/ui/SyncSettings/index.tsx`)

`backend.ts`: replaced the permanently-throwing `syncWithServer` stub with
`syncLogin(username, password, endpoint)` and `syncCollection(hkey,
endpoint)`, both `async` wrappers around the alloc/write/call/dealloc pattern
already used everywhere else in this file, plus a shared `pollSyncUntilDone`
helper (100ms interval) matching the bridge's start-then-poll shape. A new
`FullSyncRequiredError` class lets the UI distinguish "needs a full sync"
from a generic failure.

`SyncSettings`: real username/password fields, a "Use custom sync server"
checkbox that reveals an endpoint input (unchecked = official AnkiWeb,
matching real Anki desktop's own preferences screen), "Log in" →
`syncLogin`, "Sync now" → `syncCollection` then `persistCollection()` (same
mutate → persist pattern as every other flow in this app — a sync can change
local cards/notes/decks just like an import). The hkey is stored in
`localStorage` (a long-lived credential-like token, not collection data — it
doesn't belong in OPFS alongside the collection itself, and there is no
server-side session to invalidate from this UI; "Log out" just forgets the
local copy). Verified in the real browser: the Sync tab renders the new
form, the custom-server checkbox correctly reveals/hides the endpoint field,
no console errors — login/sync itself could not be exercised against a real
server from this sandbox (see 20.4).

### 20.6 Test/build status

Full web test suite passes (33/33), `tsc --noEmit` clean, fresh
`bash rust/wasm-bridge/build.sh` clean (zero undefined symbols — down from an
initial single missing wasm-bindgen import, resolved per 20.2), artifacts
synced via `web/scripts/sync-wasm-artifacts.sh`. All throwaway derisking code
(the Step-0 test export, the isolated Node test server, the temporary
`launch.json` entry) was removed; only the real transport, bridge exports,
and UI changes remain.

### 20.7 Found during review: a real (if narrow) crash risk, fixed

`wasm_sync_collection` holds the bridge's single `collection_slot()` mutex on
its background worker thread for the sync's *entire* duration (it has to —
`NormalSyncer` needs `&mut Collection` throughout). Every other bridge call
that touches the collection (`getDeckTree`, `getNextCard`, `answerCard`, ...)
runs synchronously on the browser's main thread and blocks on that same
mutex if it's held. Rust's `Mutex::lock` under Emscripten's pthread emulation
blocks via `Atomics.wait`, which browsers refuse to allow on the main
thread — so a user switching to Home/Study/Import while a sync is still in
flight wouldn't just stall, it risked a hard crash the moment that view's own
bootstrap call tried to acquire the lock. This is exactly the kind of thing
easy to miss end-to-end (it never triggers in a quick same-tab test; it needs
someone to actually click away mid-sync), so it's called out here rather than
left to be discovered later.

Fixed at the UI layer rather than the bridge, since serializing this in Rust
would need a redesign of the single-collection-lock model for one narrow
case: `SyncSettings` now takes an `onBusyChange` callback, firing `true` for
the duration of a login or sync and `false` when it settles (success or
error). `App.tsx` disables every other tab's button while any sync is
busy — `setView` is never called for a disabled tab, so the scenario can no
longer happen. `web/src/App.tsx`, `web/src/ui/SyncSettings/index.tsx`.

## 21. 2026-07-12 — Real self-hosted server, real (structural) CORS wall

The user tried the real transport against their own `anki-sync-server` at
`http://192.168.178.4:8081` from a browser on their own LAN (this sandbox has
no route there, so this had to be tested on the user's own machine). Real
credentials (`ana`/`kenny123`), and this time the request actually reached
the server — a step further than the sandbox's own attempt, which failed at
the connection level. The browser then blocked it outright:

```
Quellübergreifende (Cross-Origin) Anfrage blockiert: Die Gleiche-Quelle-Regel
verbietet das Lesen der externen Ressource auf
http://192.168.178.4:8081/sync/hostKey. (Grund: CORS-Anfrage schlug fehl).
Statuscode: (null).
```

**Root-caused, not guessed:** grepped the vendored rslib's own
`sync/http_server` module (the code the official self-hosted server is built
from) for any CORS handling — none exists. Cross-checked against the
official sync-server Docker docs (`rust/vendor/anki/docs/syncserver/README.md`)
and a web search — no CORS-related configuration exists for
`anki-sync-server` at all (unlike the separate `AnkiConnect` add-on, which
does have a configurable origin allowlist). This is structural: the server
was only ever built to be called by the native Anki desktop/mobile clients,
which don't enforce CORS — only browsers do, and CleanAnki is the first
browser-based Anki client to ever hit this wall. Confirmed empirically too:
`(*fetch).status == 0` and a rejected response is exactly what a browser does
on a failed CORS check (see the `status == 0` handling already in
`io_monitor.rs`'s wasm transport, §20.2) — nothing in *our* code is broken;
the server simply never sends `Access-Control-Allow-Origin`, so the browser
refuses to expose the response (status, headers, and body) to JS at all,
regardless of whether the server actually answered correctly.

**Fix: a small local CORS-adding reverse proxy**, `tools/cors-proxy/proxy.mjs`
— dependency-free Node (built-in `http`/`https` only), configurable via
`SYNC_SERVER`/`PORT` env vars. Forwards every request unchanged and adds
`Access-Control-Allow-Origin` (reflecting the request's own `Origin`, so it
works regardless of which port `vite` picks), `Access-Control-Allow-Methods`,
and `Access-Control-Allow-Headers` (reflecting the preflight's own
`Access-Control-Request-Headers`, so it doesn't need to hardcode the sync
protocol's custom `anki-sync` header). Handles the `OPTIONS` preflight
directly rather than forwarding it. Verified for real: spun up a throwaway
plain-HTTP test server, ran the proxy in front of it, and confirmed with
`curl` that a preflight `OPTIONS` gets the right headers back and a real
`POST` is forwarded, logged by the test server, and returned with CORS
headers attached — the proxy logic itself is proven, independent of the
user's actual (unreachable-from-here) server. `SyncSettings`'s "use custom
server" section now links to `tools/cors-proxy/README.md` directly, so a
future self-hosted-server user hits a clear explanation instead of a bare
CORS error with no context.

**Still unverified**: the proxy sitting in front of the user's actual
`192.168.178.4:8081` server, end to end, from their own machine — that step
needs the user to run it themselves and try again.

## 22. 2026-07-12 — Correction: official AnkiWeb has the exact same CORS wall, not just self-hosted servers

§21 shipped assuming (not verifying) that official AnkiWeb's own
infrastructure must handle CORS somehow, since it's a real production
service — only self-hosted servers were assumed to lack it. The user then
reported the *same* CORS error switching to official AnkiWeb (unchecking
"custom sync server"). That assumption was wrong, and worth stating plainly
rather than glossing over: it should have been verified the first time
instead of guessed.

**Verified directly, not assumed, this time.** `sync.ankiweb.net` is a public
host, unlike the user's LAN server, so it's reachable from this sandbox.
`curl -X OPTIONS https://sync.ankiweb.net/sync/hostKey -H "Origin: ..." -H
"Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers:
content-type,anki-sync"` returns a bare `405 Method Not Allowed` with zero
`Access-Control-*` headers — AnkiWeb's real production server doesn't even
recognise a CORS preflight `OPTIONS` request as anything other than an
unsupported HTTP method on that route. This makes complete sense in
hindsight: no legitimate Anki client before CleanAnki ever ran in a browser,
so no Anki sync server — official or self-hosted — ever had a reason to
support CORS. This is a universal property of the real Anki sync ecosystem,
not a self-hosted-specific gap.

**The fix is the same proxy, just retargeted.** `tools/cors-proxy/proxy.mjs`
already branches on `targetUrl.protocol` (`http`/`https`), so pointing
`SYNC_SERVER=https://sync.ankiweb.net` at it needed no code change. Verified
for real, end to end, in the actual browser: ran the proxy pointed at
`https://sync.ankiweb.net`, entered deliberately-bogus credentials into
CleanAnki's Sync tab pointed at the local proxy, and got back
`HttpError { code: 403, context: "sync server returned HTTP 403" }` — a
genuine authentication rejection from AnkiWeb's real server, not a CORS
block. That's direct proof the proxy clears the CORS wall for AnkiWeb too
(a 403 means the request reached the server, was parsed, and was rejected
for being wrong credentials — categorically different from the browser
refusing to let JS see the response at all).

**Fixed the misleading UI copy.** `SyncSettings` previously implied
"leave unchecked" (official AnkiWeb) just works, with the CORS warning only
shown once "use custom sync server" was checked — backwards, since the
unchecked path is the one that's actually guaranteed to fail from this
browser-based app. The warning is now unconditional and explicit that
*neither* path works directly, pointing at `tools/cors-proxy/` regardless of
which server the user is targeting.

`tools/cors-proxy/README.md` updated to lead with "AnkiWeb included, not
just self-hosted," and documents the `SYNC_SERVER=https://sync.ankiweb.net`
invocation directly.

## 23. 2026-07-12 — A real, working self-hosted proxy, and the actual bug in it

The user set up a real nginx reverse proxy (via Nginx Proxy Manager) in
front of their self-hosted server — a proper domain
(`ankisync.local.sellke.casa`) with a real SSL cert, forwarding to
`192.168.178.4:8081`, and added `Access-Control-Allow-*` headers via the
per-location "Advanced" config. Confirmed working from real Anki desktop.
Still failed from CleanAnki with the same CORS error.

**Root cause: their `Access-Control-Allow-Headers` was a fixed list —
`Authorization, Content-Type, Idempotency-Key, X-Anki-Version` — missing the
one header the sync protocol actually sends.** Confirmed directly in the
vendored source: `rust/vendor/anki/rslib/src/sync/request/header_and_stream.rs:129`
— `pub static SYNC_HEADER_NAME: HeaderName = HeaderName::from_static("anki-sync");`
— and `http_client/mod.rs:75`, the only place a header is attached to the
request. A real sync request only ever carries two headers:
`Content-Type: application/octet-stream` and `anki-sync` (a JSON blob of
`sync_version`/`sync_key`/`client_ver`/`session_key`). None of
`Authorization`/`Idempotency-Key`/`X-Anki-Version` are used by this
protocol at all — harmless to also allow, but irrelevant; the missing
`anki-sync` is what made the browser's preflight check fail the actual
request even though the proxy's `Access-Control-Allow-Origin` was present
and correct.

This is exactly the failure mode a fixed allow-list is prone to, which is
why both example configs in `tools/cors-proxy/` reflect the browser's own
`Access-Control-Request-Headers` back (`$http_access_control_request_headers`
in nginx, `req.headers['access-control-request-headers']` in `proxy.mjs`)
rather than hardcoding a list — confirmed via this exact real-world case,
not just a theoretical concern. Gave the user a drop-in replacement using
that pattern, and documented the specific gotcha in both
`tools/cors-proxy/README.md` (a new "already have a CORS config and it's
still failing?" section) and the nginx example's own comments, so it isn't
re-discovered from scratch by the next self-hosted-server user who copies a
CORS template from somewhere else.

**Still unverified**: whether the corrected config actually resolves it end
to end — the user has the fix but hasn't retried yet as of this writing.

## 24. 2026-07-15 — CORS fixed for real; full upload/download implemented

The user confirmed the corrected nginx config works: login against their
real self-hosted server succeeds through the proxy. The very next step —
`syncCollection`'s `NormalSyncer::sync()` — reported `FullSyncRequired`,
which this app had deliberately left unimplemented (§20). The user's
situation is exactly the case that requires it: they'd already used real
Anki desktop to push the Spanish deck to this server, so the server has
data, but this browser collection has never itself talked to that server —
there's no shared sync history for an incremental sync to reconcile, so a
one-time full replace (one side wins wholesale) is the only option, same as
real Anki desktop's own first-sync dialog.

**Implementation.** `Collection::full_download`/`full_upload`
(`rust/vendor/anki/rslib/src/sync/collection/download.rs` and `upload.rs`,
unmodified rslib logic) both fall through the exact same transport already
built for `NormalSyncer` (`HttpSyncClient::download_with_progress`/
`upload_with_progress` → the same `request_ext` → the same
`zstd_request_with_timeout` patched in §20) — no new transport work needed.
The one real wrinkle: both take `self` **by value** (they close the sqlite
connection before doing any network I/O, win or lose), unlike
`NormalSyncer::new(&mut col, ...)`. Added `take_collection`/
`reopen_collection` helpers in `rust/wasm-bridge/src/main.rs`: take the
`Collection` out of the bridge's `Mutex<Option<Collection>>` slot, run the
full sync, then unconditionally rebuild a fresh `Collection` from
`COLLECTION_PATH` afterward — safe either way, since a failed
`full_download` never touches the on-disk file (only a *successful* one
atomically renames the new data into place) and `full_upload` never
modifies the local file at all in either outcome (it only reads and sends
it). Factored the "build + enable FSRS" logic `wasm_open_collection` already
did into a shared `build_collection_at_path()` so the reopened collection
gets the same FSRS-default treatment as a normal fresh open, instead of
silently losing it.

New exports: `wasm_sync_full_download`/`wasm_sync_full_upload`, same
start-then-poll shape as the existing sync exports (reusing `SYNC_STATE`/
`wasm_sync_poll` — only one sync operation can usefully be in flight at
once anyway). `web/src/wasm/backend.ts` gained matching `syncFullDownload`/
`syncFullUpload` wrappers.

**UI**: `SyncSettings` now turns a caught `FullSyncRequiredError` into two
explicit, separately-confirmed destructive actions — "Download from server"
(replace local with remote) and "Upload to server" (replace remote with
local) — instead of a dead-end error message. Matches real Anki desktop's
own first-sync dialog in spirit: this is a real decision only the user can
make (which side is actually authoritative), never auto-resolved.

**Verified**: fresh build clean, full test suite (33/33), `tsc --noEmit`
clean, Sync tab renders correctly in the browser. **Not verified**: an
actual full download/upload against a real server — this sandbox has no
route to the user's server, and safely exercising the destructive upload
path in particular isn't something to improvise against a stranger's real
data. The user is in the exact situation this feature targets (server has
data, browser collection doesn't share history with it yet), so they're
well placed to try "Download from server" directly next.

## 25. 2026-07-15 — Media sync: a completely separate protocol we hadn't built yet

The user downloaded successfully (§24) but reported images missing from the
deck. Root cause: **collection sync and media sync are two entirely separate
protocols in real Anki**, with separate server-side databases — everything
built through §24 (`NormalSyncer`, `full_download`, `full_upload`) only ever
transfers the `.anki2` SQLite file (notes/cards/decks/scheduling/revlog).
The actual image/audio *files* referenced from note fields are a different
sync mechanism entirely (`rslib/src/sync/media/`, ~2500 lines: its own
client-side change-tracking database, a zip-batched upload/download
protocol, checksum reconciliation, sanity checks). Real Anki desktop runs
both under one "Sync" button; this app had only ever built the first half.

**Confirmed the hard part was already solved.** `MediaSyncProtocol`'s
endpoints (`msync/begin`, `msync/mediaChanges`, etc.) go through the exact
same `HttpSyncClient`/`request_ext`/`zstd_request_with_timeout` transport
already patched for wasm in §20 — just a different `AsSyncEndpoint` prefix.
No new transport work needed; the CORS proxy from §21-23 already covers
this too, since it's the same server, same origin.

**Implementation**, `rust/wasm-bridge/src/main.rs`'s `wasm_sync_media`: the
real API turned out to be small — `Collection::media() -> Result<MediaManager>`
(already fully wired, since `with_desktop_media_paths` — called at every
collection open — already derives both the media folder *and* a media
tracking-database path, `collection.mdb`, from `COLLECTION_PATH`) and
`MediaManager::sync_media(self, progress, auth, client, server_usn)`. Unlike
`wasm_sync_collection`, this only needs the collection lock long enough to
extract `mgr`/`progress` — the actual (potentially slow, many-files)
transfer runs with the lock already released, so a media sync doesn't block
other bridge calls the way a collection sync does. Downloaded files land
directly in `MEDIA_FOLDER` via rslib's own code; the existing `persistMedia()`
JS helper (already used after `importApkg`) picks them up and copies them to
OPFS — no new persistence plumbing needed there either.

**`SyncSettings` now chains it automatically** after every successful
collection sync/full-download/full-upload, matching real Anki's one-button
UX instead of requiring a separate manual step. A media-sync failure is
surfaced as a distinct warning rather than making the (already-successful)
collection sync look like it failed — they're genuinely independent
outcomes in real Anki too.

**Known, accepted limitation**: the media tracking database (`collection.mdb`)
itself is not persisted to OPFS (only the media *files* are, via
`persistMedia`). This means every browser session's first media sync starts
from an empty tracking DB rather than picking up where the last session left
off — `register_changes` treats every existing local file as "new" and
re-registers it, so each session does a full reconciliation pass instead of
an incremental one. This is believed to be safe (checksums should still
avoid redundant transfer of files already present on the server) but is
less efficient than real Anki desktop, which persists this database
indefinitely. Flagged rather than silently left as a surprise; picking this
up is a reasonable, separately-scoped follow-up if it turns out to matter in
practice (e.g. for very large media folders).

**Verified**: fresh build clean, full test suite (33/33), `tsc --noEmit`
clean, Sync tab renders correctly. **Not verified**: an actual media sync
against the user's real server — same sandbox reachability limitation as
§20-24. The user should re-run "Sync now" (or re-do the full download) and
check whether images now appear.

## 26. 2026-07-15 — Client device label: "emscripten" → "wasm"

The user's sync server showed this client's device entry as
"emscripten · Anki 26.05", next to their desktop's "macos · Anki 26.05" —
accurate about the build target, but gives an end user no indication this
is a browser/wasm client at all. Asked to fix the label, keeping the
version string.

Two separate client-version strings exist in rslib
(`rust/vendor/anki/rslib/src/version.rs`), and only one was overridable:
- `sync_client_version()` (long form, `"anki,{version} ({buildhash}),{platform}"`)
  already read a `PLATFORM` env var override, falling back to
  `env::consts::OS`.
- `sync_client_version_short()` (short form,
  `"{version},{buildhash},{platform}"`) — confirmed via
  `rust/vendor/anki/rslib/src/sync/request/mod.rs:172` to be the one
  actually used to build every `SyncRequest`'s `client_version` field (i.e.
  the one a server's device list actually renders) — had `platform`
  hardcoded straight to `env::consts::OS`, no override point.

First attempt only set the env var (`wasm_init_backend` in
rust/wasm-bridge/src/main.rs, before anything else runs — both functions
cache their result in a `LazyLock` on first use, so this has to happen
before the first sync-related call) and re-verified against the real
AnkiWeb server through the CORS proxy with a throwaway debug build of the
proxy that logged the raw `anki-sync` request header — caught the header
still reading `"26.05,,emscripten"` this way, which is what surfaced that
the *short* form (the one actually used) wasn't wired to the override at
all. Patched `sync_client_version_short()` to check the same `PLATFORM` env
var, mirroring the long form exactly (small, precedented vendored-source
change; patch file regenerated). Re-verified the same way: header now reads
`"26.05,,wasm"` — will display as "wasm · Anki 26.05" in the device list.

Full test suite (33/33), `tsc --noEmit`, and a fresh build all clean.

## 27. 2026-07-15 — Media sync was slow every time: the tracking DB was never persisted (and restoring it safely needed a second fix)

The user reported that "Sync now" always sits on "syncing media" for a
noticeable while, even right after a sync that had nothing new to transfer.
This is exactly the "known, accepted limitation" flagged (but not yet fixed)
in §25: `collection.mdb` — the media sync protocol's own change-tracking
database, a completely separate database and protocol from collection sync
— was never persisted to OPFS, only the media *files* were.

**Root-caused precisely**, not just re-confirmed the old guess. Read
`MediaSyncer::sync_inner` (`rslib/src/sync/media/syncer.rs`):

```rust
let meta = self.mgr.db.get_meta()?;
let client_usn = meta.last_sync_usn;      // always 0 — mdb never persisted
...
if client_usn != server_usn {              // always true once the server has synced before
    self.fetch_changes(meta).await?;       // walks the server's FULL media change
}                                           // history from usn 0, batch by batch
```

Since `collection.mdb` reset to empty every session, `client_usn` was always
0. Any server that had ever synced before (from Anki desktop, say) reports a
nonzero `server_usn`, so `client_usn != server_usn` was *always* true —
every single "Sync now" walked the server's entire media change history
from scratch via paginated `mediaChanges` calls, regardless of how small the
actual delta was. This has nothing to do with hashing files (that part was
already measured as cheap, §13: ~30ms/~188ms for ~7000 files) — it's a
network-protocol-level "start from zero" problem, and persisting
`last_sync_usn` across sessions is the actual fix.

**The genuinely dangerous part, found by reading `ChangeTracker::register_changes`
before writing any code, not after**: `MediaSyncer::sync_inner` starts by
calling `register_changes()`, which walks the *local* media folder on disk
and reconciles it against whatever `collection.mdb` currently has recorded.
Any file the db recorded that ISN'T found on disk gets marked *removed* —
and if changes are pending, `send_changes()` uploads that removal to the
server. `restoreMediaToBackend()` (the media *files* → MEMFS restore) has
always been a deliberate, non-automatic call — §13 explicitly kept it off
the page-load hot path to avoid rehydrating thousands of files for no
display benefit — and `syncMediaAfterCollectionSync` never called it either.
So: persisting `collection.mdb` *alone*, without also restoring the media
files into MEMFS first, would have made `register_changes` conclude every
previously-known file had been deleted on the very first sync of a new
session — and then propagate that as a real deletion to the server. This
would have been a silent data-loss bug shipped in the name of a performance
fix. Caught before writing any UI-facing code by reading the sync engine's
actual reconciliation logic first, not by trial and error against a live
server (this sandbox can't reach the user's, and no real AnkiWeb credentials
are available here either).

**Implementation**, two coupled changes (either alone is wrong):

1. **Persist `collection.mdb`.** Its connection is short-lived (opened fresh
   and dropped inside every `wasm_sync_media`/`wasm_import_apkg` call, unlike
   the collection's own connection which stays open all session), so instead
   of trusting sqlite's close-time auto-checkpoint behavior, added an
   explicit, verifiable checkpoint — mirroring the exact precedent already
   set for the collection itself (`SqliteStorage::checkpoint`, widened from
   `pub(crate)` to `pub` in §15). Added `MediaDatabase::checkpoint()`
   (`rslib/src/sync/media/database/client/mod.rs`) and
   `MediaManager::checkpoint()` (`rslib/src/media/mod.rs`), both copying the
   collection version's `pragma wal_checkpoint(truncate)` logic verbatim.
   New wasm export `wasm_checkpoint_media_db()` (`rust/wasm-bridge/src/main.rs`)
   opens (or creates) a `MediaManager` purely to call it — WAL checkpointing
   is a property of the database *file*, not the specific connection that
   wrote to it, so a fresh connection can still flush an older connection's
   WAL. `web/src/wasm/backend.ts` gained `readMediaDbBytes()`/
   `writeMediaDbBytes()` (direct `FS.readFile`/`writeFile` at
   `/anki/collection.mdb`, same pattern as `readCollectionBytes`, no new
   Rust plumbing needed for the actual byte shuttle) and `db/collection.ts`
   gained `persistMediaDb()`/`restoreMediaDbToBackend()`. Restore runs once
   in `ensureCollectionReady`, right after `openCollection` (which creates
   `/anki`); persist runs after `syncMedia()` and after `importApkg()` (import
   registers files into the same db).

2. **Restore media files before every media sync.** `syncMediaAfterCollectionSync`
   (`ui/SyncSettings/index.tsx`) now calls the already-existing
   `restoreMediaToBackend()` immediately before `syncMedia()` — previously
   only used for rslib operations that read media bytes, now also required
   for correctness once the tracking DB persists. Cost is the same one
   already measured in §13 (sub-200ms for ~7000 files) and only runs on the
   user's deliberate "Sync now" click, not on page load, so the §13 rationale
   for keeping it off the hot path still holds.

**Verified**, without a reachable real sync server (same sandbox limitation
as §20-25): wrote
`rust/wasm-bridge/smoke-test/media_db_persist_test.mjs`, which (a) confirms
`wasm_checkpoint_media_db` is a harmless no-op-creating call on a collection
that's never touched media, (b) imports a real fixture with media
(`pylib/tests/support/media.apkg`) and confirms `collection.mdb` is a
non-empty, valid `SQLite format 3` file afterward, and (c) — the critical
check — copies those bytes plus the media files into a **second, independent
wasm instance** (fresh MEMFS, simulating a page reload) and confirms sqlite
can actually reopen the restored `.mdb` file cleanly. All three passed. Full
test suite (33/33), `tsc --noEmit`, and a fresh build all clean. **Not
verified**: an actual two-session sync against a real server showing a
faster second sync — the user is best positioned to confirm "Sync now" feels
snappier on a second run with nothing new to transfer.
