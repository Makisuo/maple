#!/usr/bin/env bash
# Build the distributable `maple` local binary — a single Bun-compiled
# executable plus libchdb. No Rust/cargo involved.
#
# Pipeline:
#   1. Build the workspace packages consumed through gitignored `dist/` paths.
#   2. Build the lightweight SPA (`apps/local-ui` → its `dist/`).
#   3. Inline that dist into apps/cli/src/server/ui-embed.gen.ts so
#      `bun build --compile` bakes the SPA into the binary.
#   4. Compile apps/cli (the CLI + the OTLP-ingest/query server) into a single
#      executable with `bun build --compile`. The schema artifacts and SPA are
#      embedded; the OTLP encoders run in-process; chDB is reached via bun:ffi.
#   5. Download libchdb (v26.1.0, matching what we test against) for the host
#      platform and place it beside the binary. At runtime `maple` dlopens the
#      sibling libchdb (resolved relative to its own path) — no rpath tricks.
#   6. Restore the committed ui-embed.gen.ts stub so the tree stays clean.
#
# The distributable is a 2-file bundle: `maple` + `libchdb.so`. Keep them in the
# same directory.
#
# Usage:
#   scripts/build-local-binary.sh                 # release build into ./dist
#   OUT_DIR=/tmp/maple scripts/build-local-binary.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist}"
LIBCHDB_VERSION="${LIBCHDB_VERSION:-v26.1.0}"
UI_EMBED="$REPO_ROOT/apps/cli/src/server/ui-embed.gen.ts"

# Version baked into the binary via `bun build --define`. The release workflow
# passes the tag; a local build defaults to `git describe` (or "dev").
MAPLE_BUILD_VERSION="${MAPLE_BUILD_VERSION:-$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev)}"

mkdir -p "$OUT_DIR"

# Several workspace packages are published from gitignored `dist/` directories.
# A fresh checkout / CI only runs `bun install`, so build the repository's
# canonical prerequisite set before local-ui or the CLI resolves those imports.
echo "==> Building workspace prerequisites"
bun run alchemy:build-deps

echo "==> Building local-ui SPA"
bun run --filter @maple/local-ui build

echo "==> Inlining SPA into ui-embed.gen.ts"
restore_stub() { git -C "$REPO_ROOT" checkout -- "$UI_EMBED" 2>/dev/null || true; }
trap restore_stub EXIT
bun run "$REPO_ROOT/scripts/gen-ui-embed.ts"

echo "==> Compiling maple binary (bun build --compile) — version $MAPLE_BUILD_VERSION"
( cd "$REPO_ROOT" && bun build apps/cli/src/bin.ts --compile \
	--define "__MAPLE_VERSION__=\"$MAPLE_BUILD_VERSION\"" \
	--define "__CHDB_VERSION__=\"$LIBCHDB_VERSION\"" \
	--outfile "$OUT_DIR/maple" )

echo "==> Downloading libchdb $LIBCHDB_VERSION for this platform"
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64)        ASSET="linux-x86_64-libchdb.tar.gz" ;;
	Linux-aarch64)       ASSET="linux-aarch64-libchdb.tar.gz" ;;
	Darwin-x86_64)       ASSET="macos-x86_64-libchdb.tar.gz" ;;
	Darwin-arm64)        ASSET="macos-arm64-libchdb.tar.gz" ;;
	*) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
# Expected sha256 per platform asset, pinned to LIBCHDB_VERSION: release assets
# are mutable even for a fixed tag, so this is verified before extraction.
# Bumping LIBCHDB_VERSION means re-hashing each asset here. A `case` rather than
# an associative array because macOS still ships bash 3.2.
case "$ASSET" in
	linux-x86_64-libchdb.tar.gz)  EXPECTED_SHA256="3f192cb85cbdb6153622db8ad6f6a25d7163bbda57f283e5ba8fd22cadd0da81" ;;
	linux-aarch64-libchdb.tar.gz) EXPECTED_SHA256="08ee80488822dfa04776841bb5a4b7ddce35e161ef579b5615b80a88b177428d" ;;
	macos-x86_64-libchdb.tar.gz)  EXPECTED_SHA256="425db8a197288e1826b60958b3e233d0a7a5b4b46b8065c8bb7489366dbaf47f" ;;
	macos-arm64-libchdb.tar.gz)   EXPECTED_SHA256="78cfd42203cd33cb0304952f4a6c39921fd9a583c614c2eef96ef6060e9677eb" ;;
	*) echo "ERROR: no pinned sha256 for $ASSET (LIBCHDB_VERSION=$LIBCHDB_VERSION)" >&2; exit 1 ;;
esac

URL="https://github.com/chdb-io/chdb-core/releases/download/$LIBCHDB_VERSION/$ASSET"
TMP="$(mktemp -d)"
curl -fsSL "$URL" -o "$TMP/libchdb.tar.gz"

# Verify BEFORE extracting: release assets are mutable even for a fixed tag,
# so this authenticates the download rather than whatever happened to arrive.
ACTUAL_SHA256="$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$TMP/libchdb.tar.gz"; else shasum -a 256 "$TMP/libchdb.tar.gz"; fi | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
	echo "ERROR: libchdb checksum mismatch for $ASSET" >&2
	echo "  expected: $EXPECTED_SHA256" >&2
	echo "  actual:   $ACTUAL_SHA256" >&2
	rm -rf "$TMP"
	exit 1
fi

tar -xzf "$TMP/libchdb.tar.gz" -C "$TMP"
LIB="$(find "$TMP" -name 'libchdb.so' -o -name 'libchdb.dylib' | head -1)"
[ -n "$LIB" ] || { echo "ERROR: libchdb not found in $ASSET" >&2; exit 1; }
cp "$LIB" "$OUT_DIR/libchdb.so"
rm -rf "$TMP"

echo "==> Done. Bundle in $OUT_DIR:"
echo "      maple        ($(du -h "$OUT_DIR/maple" | cut -f1))"
echo "      libchdb.so   ($(du -h "$OUT_DIR/libchdb.so" | cut -f1))"
