#!/usr/bin/env bash
# Push the maple-otel chart tarball to GHCR. Mirrors the
# publish-k8s-infra-chart.sh shape so a new chart slots in cleanly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${HELM_REGISTRY:-ghcr.io}"
OWNER="${HELM_REGISTRY_OWNER:-makisuo}"
OWNER_LC="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
PACKAGE_DIR="${PACKAGE_DIR:-$ROOT/dist/charts}"
CHART_NAME="maple-otel"
CHART_DIR="$ROOT/deploy/$CHART_NAME"

if [[ -z "${HELM_REGISTRY_USERNAME:-}" || -z "${HELM_REGISTRY_PASSWORD:-}" ]]; then
    echo "Set HELM_REGISTRY_USERNAME and HELM_REGISTRY_PASSWORD." >&2
    exit 1
fi

mkdir -p "$PACKAGE_DIR"
helm lint "$CHART_DIR"
helm package "$CHART_DIR" --destination "$PACKAGE_DIR"

echo "$HELM_REGISTRY_PASSWORD" | helm registry login "$REGISTRY" \
    --username "$HELM_REGISTRY_USERNAME" \
    --password-stdin

for chart in "$PACKAGE_DIR"/$CHART_NAME-*.tgz; do
    helm push "$chart" "oci://$REGISTRY/$OWNER_LC/charts"
done

echo "Published. Install with:"
echo "  helm upgrade --install $CHART_NAME oci://$REGISTRY/$OWNER_LC/charts/$CHART_NAME --namespace maple --create-namespace ..."
