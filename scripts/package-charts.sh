#!/usr/bin/env bash
# Package every Helm chart under deploy/ into dist/charts/.
#
# Used by both the local dev path (`./scripts/package-charts.sh`) and the
# CI publish workflows (publish-k8s-infra-chart.yml, publish-maple-otel-
# chart.yml). Each chart is linted before packaging — failure aborts the
# whole script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/dist/charts}"

CHARTS=(
    "deploy/k8s-infra"
    "deploy/maple-otel"
)

mkdir -p "$OUT_DIR"

for chart in "${CHARTS[@]}"; do
    echo "==> Linting $chart"
    helm lint "$ROOT/$chart"
    echo "==> Packaging $chart"
    helm package "$ROOT/$chart" --destination "$OUT_DIR"
done

echo
echo "Packaged charts:"
find "$OUT_DIR" -maxdepth 1 -name '*.tgz' -print
