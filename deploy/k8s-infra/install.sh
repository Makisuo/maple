#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${MAPLE_NAMESPACE:-maple}"
RELEASE="${MAPLE_RELEASE:-maple-k8s-infra}"
CHART_REF="${MAPLE_CHART_REF:-oci://ghcr.io/makisuo/charts/maple-k8s-infra}"
CHART_VERSION="${MAPLE_CHART_VERSION:-}"
INGEST_ENDPOINT="${MAPLE_INGEST_ENDPOINT:-}"
INGEST_KEY="${MAPLE_INGEST_KEY:-}"
INGEST_SECRET_NAME="${MAPLE_INGEST_SECRET_NAME:-maple-ingest-key}"
INGEST_SECRET_KEY="${MAPLE_INGEST_SECRET_KEY:-ingest-key}"
CLUSTER_NAME="${MAPLE_CLUSTER_NAME:-}"
DEPLOYMENT_ENVIRONMENT="${MAPLE_DEPLOYMENT_ENVIRONMENT:-}"
INSTALL_YES="${MAPLE_INSTALL_YES:-}"

usage() {
  cat <<'USAGE'
Install Maple's Kubernetes infra collector.

Required:
  MAPLE_INGEST_ENDPOINT   Maple ingest gateway base URL, e.g. https://ingest.example.com

Auth, choose one:
  MAPLE_INGEST_KEY        Ingest key. The script creates/updates a Kubernetes Secret.
  or
  MAPLE_INGEST_SECRET_NAME Existing Secret name. Defaults to maple-ingest-key.

Optional:
  MAPLE_NAMESPACE=maple
  MAPLE_RELEASE=maple-k8s-infra
  MAPLE_CLUSTER_NAME=production
  MAPLE_DEPLOYMENT_ENVIRONMENT=prod
  MAPLE_CHART_REF=oci://ghcr.io/makisuo/charts/maple-k8s-infra
  MAPLE_CHART_VERSION=0.1.0
  MAPLE_INSTALL_YES=1      Skip interactive context confirmation.

Example:
  MAPLE_INGEST_ENDPOINT=https://ingest.example.com \
  MAPLE_INGEST_KEY=maple_xxx \
  MAPLE_CLUSTER_NAME=production \
  bash install.sh
USAGE
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

need kubectl
need helm

if [[ -z "$INGEST_ENDPOINT" ]]; then
  echo "MAPLE_INGEST_ENDPOINT is required." >&2
  usage
  exit 1
fi

if [[ -z "$INGEST_KEY" && -z "${MAPLE_INGEST_SECRET_NAME:-}" ]]; then
  echo "Provide MAPLE_INGEST_KEY or MAPLE_INGEST_SECRET_NAME." >&2
  usage
  exit 1
fi

CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
if [[ -z "$CONTEXT" ]]; then
  echo "No current kubectl context is configured." >&2
  exit 1
fi

cat <<EOF
About to install Maple Kubernetes infra collector:
  kubectl context: $CONTEXT
  namespace:       $NAMESPACE
  release:         $RELEASE
  chart:           $CHART_REF
  ingest endpoint: $INGEST_ENDPOINT
EOF

if [[ "$INSTALL_YES" != "1" ]]; then
  read -r -p "Continue? Type 'yes' to install: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Cancelled."
    exit 1
  fi
fi

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

if [[ -n "$INGEST_KEY" ]]; then
  kubectl -n "$NAMESPACE" create secret generic "$INGEST_SECRET_NAME" \
    --from-literal="${INGEST_SECRET_KEY}=${INGEST_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

HELM_ARGS=(
  upgrade --install "$RELEASE" "$CHART_REF"
  --namespace "$NAMESPACE"
  --set-string "maple.ingest.endpoint=$INGEST_ENDPOINT"
  --set-string "maple.ingestKey.existingSecret.name=$INGEST_SECRET_NAME"
  --set-string "maple.ingestKey.existingSecret.key=$INGEST_SECRET_KEY"
)

if [[ -n "$CHART_VERSION" ]]; then
  HELM_ARGS+=(--version "$CHART_VERSION")
fi

if [[ -n "$CLUSTER_NAME" ]]; then
  HELM_ARGS+=(--set-string "global.clusterName=$CLUSTER_NAME")
fi

if [[ -n "$DEPLOYMENT_ENVIRONMENT" ]]; then
  HELM_ARGS+=(--set-string "global.deploymentEnvironment=$DEPLOYMENT_ENVIRONMENT")
fi

helm "${HELM_ARGS[@]}"

cat <<EOF

Installed. Check rollout:
  kubectl -n $NAMESPACE rollout status daemonset/${RELEASE}-agent
  kubectl -n $NAMESPACE rollout status deployment/${RELEASE}-cluster

Collector service for in-cluster apps:
  OTLP gRPC: ${RELEASE}-agent.$NAMESPACE.svc:4317
  OTLP HTTP: http://${RELEASE}-agent.$NAMESPACE.svc:4318
EOF
