#!/bin/sh
# Production celld: deploy the Worker into the fleet bucket, then serve it.
# Not `celld dev` — that uses PROJECT/.celld/dev and shares nothing with prod.
set -eu

APP_DIR="${CELLD_APP_DIR:?CELLD_APP_DIR required}"
PORT="${CELLD_PORT:?CELLD_PORT required}"
CONFIG="${CELLD_WRANGLER:-wrangler.celld.jsonc}"
CELLD_BIN="${CELLD_BIN:-/usr/local/bin/celld}"
BUCKET="${CELLD_BUCKET:?CELLD_BUCKET required (s3://name/prefix)}"
ENDPOINT="${S3_ENDPOINT:?S3_ENDPOINT required}"
REGION="${AWS_REGION:-us-east-1}"

cd "$APP_DIR"
export PATH="/usr/local/bin:/root/.bun/bin:${PATH}"
export CELLD_ESBUILD="${CELLD_ESBUILD:-$(command -v esbuild)}"
if [ -z "${CELLD_ESBUILD}" ]; then
	echo "celld-entrypoint: esbuild not on PATH" >&2
	exit 1
fi
export CELLD_TRUST_FORWARDED_HEADERS="${CELLD_TRUST_FORWARDED_HEADERS:-1}"
export CELLD_WATCH="${CELLD_WATCH:-/var/lib/celld}"
# celld defaults RUST_LOG=info and emits a ship-loop / lease line every second.
export RUST_LOG="${RUST_LOG:-warn}"
mkdir -p "$CELLD_WATCH"

echo "celld-entrypoint: deploy $CONFIG → $BUCKET ($ENDPOINT)"
"$CELLD_BIN" deploy "$CONFIG" --bucket "$BUCKET" --endpoint "$ENDPOINT" --region "$REGION"

LISTEN_HOST="${CELLD_LISTEN_HOST:-0.0.0.0}"
echo "celld-entrypoint: listen ${LISTEN_HOST}:${PORT}"
exec "$CELLD_BIN" \
	--bucket "$BUCKET" \
	--endpoint "$ENDPOINT" \
	--region "$REGION" \
	--listen "${LISTEN_HOST}:${PORT}" \
	--internal-listen "127.0.0.1:0" \
	--trust-forwarded-headers
