#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist/charts}"

mkdir -p "$OUT_DIR"
helm lint "$ROOT/deploy/k8s-infra"
helm package "$ROOT/deploy/k8s-infra" --destination "$OUT_DIR"

echo "Packaged chart:"
find "$OUT_DIR" -maxdepth 1 -name 'maple-k8s-infra-*.tgz' -print
