#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${HELM_REGISTRY:-ghcr.io}"
OWNER="${HELM_REGISTRY_OWNER:-makisuo}"
OWNER_LC="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
PACKAGE_DIR="${PACKAGE_DIR:-$ROOT/dist/charts}"

if [[ -z "${HELM_REGISTRY_USERNAME:-}" || -z "${HELM_REGISTRY_PASSWORD:-}" ]]; then
  echo "Set HELM_REGISTRY_USERNAME and HELM_REGISTRY_PASSWORD." >&2
  exit 1
fi

"$ROOT/scripts/package-k8s-infra-chart.sh" "$PACKAGE_DIR"

echo "$HELM_REGISTRY_PASSWORD" | helm registry login "$REGISTRY" \
  --username "$HELM_REGISTRY_USERNAME" \
  --password-stdin

for chart in "$PACKAGE_DIR"/maple-k8s-infra-*.tgz; do
  helm push "$chart" "oci://$REGISTRY/$OWNER_LC/charts"
done

echo "Published. Install with:"
echo "  helm upgrade --install maple-k8s-infra oci://$REGISTRY/$OWNER_LC/charts/maple-k8s-infra --namespace maple --create-namespace ..."
