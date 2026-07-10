#!/usr/bin/env bash
#
# Regenerates rust/vendor/{anki,systemstat,burn-train} from pristine upstream
# sources plus this directory's .patch files. rust/vendor/* is gitignored
# (anki alone is ~985MB) — this script is what makes the vendored, patched
# dependency tree reproducible from a clean checkout. See docs/ARCHITECTURE.md
# §6/§10 for *why* each of these three is patched.
#
# Usage: bash rust/vendor-patches/regen.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${RUST_DIR}/vendor"

mkdir -p "${VENDOR_DIR}"
cd "${VENDOR_DIR}"

# --- anki (rslib), tag 26.05, patched Cargo.toml/Cargo.lock + 4 source files ---
if [ ! -d anki ]; then
  echo "==> cloning ankitects/anki @ 26.05"
  git clone --branch 26.05 --depth 1 https://github.com/ankitects/anki.git anki
  echo "==> fetching FTL translation submodules (anki_i18n's build.rs needs these)"
  git -C anki submodule update --init --depth 1 ftl/core-repo ftl/qt-repo
  echo "==> applying anki-26.05.patch"
  git -C anki apply "${SCRIPT_DIR}/anki-26.05.patch"
else
  echo "==> rust/vendor/anki already exists, skipping (delete it to re-clone)"
fi

# --- systemstat 0.2.7: adds an emscripten platform stub ---
# NOTE: the crates.io download step below (curl to crates.io's API) could not
# be network-tested from the sandbox this script was authored in (index/static
# .crates.io were unreachable there, though crates.io's main API host was) —
# that's an environment limitation of that sandbox, not a known issue with a
# normal dev machine. What WAS verified there: applying
# systemstat-0.2.7.patch/burn-train-0.17.1.patch to the pristine crates.io
# source (obtained via the already-populated local cargo registry cache as a
# stand-in for the download) reproduces rust/vendor/{systemstat,burn-train}
# byte-for-byte. If the curl step ever needs a User-Agent to avoid a 403 (per
# crates.io's API data-access policy), add e.g. `-A "CleanAnki (<repo-url>)"`.
if [ ! -d systemstat ]; then
  echo "==> downloading systemstat 0.2.7 from crates.io"
  curl -sSL "https://crates.io/api/v1/crates/systemstat/0.2.7/download" -o systemstat.crate
  mkdir systemstat
  tar xzf systemstat.crate -C systemstat --strip-components=1
  rm systemstat.crate
  echo "==> applying systemstat-0.2.7.patch"
  patch -p1 < "${SCRIPT_DIR}/systemstat-0.2.7.patch"
else
  echo "==> rust/vendor/systemstat already exists, skipping"
fi

# --- burn-train 0.17.1: makes metric event processing synchronous on wasm ---
if [ ! -d burn-train ]; then
  echo "==> downloading burn-train 0.17.1 from crates.io"
  curl -sSL "https://crates.io/api/v1/crates/burn-train/0.17.1/download" -o burn-train.crate
  mkdir burn-train
  tar xzf burn-train.crate -C burn-train --strip-components=1
  rm burn-train.crate
  echo "==> applying burn-train-0.17.1.patch"
  patch -p1 < "${SCRIPT_DIR}/burn-train-0.17.1.patch"
else
  echo "==> rust/vendor/burn-train already exists, skipping"
fi

echo "==> done. rust/vendor/{anki,systemstat,burn-train} ready."
