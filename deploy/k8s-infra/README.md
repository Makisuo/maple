# Maple Kubernetes Infra Collector

This chart deploys Maple's Kubernetes infrastructure collector using the upstream OpenTelemetry Collector Contrib image. It follows the SigNoz-style split collector shape:

- a DaemonSet for node-local OTLP, host metrics, kubelet metrics, and optional pod logs
- a single-replica Deployment for cluster-wide metrics and optional Kubernetes events

All signals are exported with OTLP HTTP to Maple's ingest gateway. The collector does not write directly to Tinybird or ClickHouse; the ingest gateway remains responsible for ingest-key auth and authoritative `maple_org_id` enrichment.

## Install

Once the chart is published to GHCR, the easiest install path is:

```bash
curl -fsSL https://raw.githubusercontent.com/Makisuo/maple/main/deploy/k8s-infra/install.sh | \
  MAPLE_INGEST_ENDPOINT=https://ingest.example.com \
  MAPLE_INGEST_KEY=YOUR_MAPLE_INGEST_KEY \
  MAPLE_CLUSTER_NAME=production \
  bash
```

The script prints the active `kubectl` context before installing and requires confirmation unless `MAPLE_INSTALL_YES=1` is set.

Direct Helm install from the OCI chart:

```bash
helm upgrade --install maple-k8s-infra \
  oci://ghcr.io/makisuo/charts/maple-k8s-infra \
  --namespace maple \
  --create-namespace \
  --set-string maple.ingest.endpoint=https://ingest.example.com \
  --set-string maple.ingestKey.value=YOUR_MAPLE_INGEST_KEY \
  --set-string global.clusterName=production
```

Local install from this repository:

```bash
helm upgrade --install maple-k8s-infra ./deploy/k8s-infra \
  --namespace maple \
  --create-namespace \
  --set maple.ingest.endpoint=https://ingest.example.com \
  --set maple.ingestKey.value=YOUR_MAPLE_INGEST_KEY \
  --set global.clusterName=production
```

For production installs, prefer an existing secret:

```bash
kubectl create secret generic maple-ingest-key \
  --namespace maple \
  --from-literal=ingest-key=YOUR_MAPLE_INGEST_KEY

helm upgrade --install maple-k8s-infra ./deploy/k8s-infra \
  --namespace maple \
  --set maple.ingest.endpoint=https://ingest.example.com \
  --set maple.ingestKey.existingSecret.name=maple-ingest-key \
  --set maple.ingestKey.existingSecret.key=ingest-key \
  --set global.clusterName=production
```

## Defaults

- Host metrics, kubelet metrics, cluster metrics, and OTLP receiving are enabled.
- Pod logs and Kubernetes events are disabled by default to keep ingestion volume predictable.
- The cluster collector runs one replica by default to avoid duplicate cluster-wide metrics.
- The DaemonSet exposes host ports `4317` and `4318` by default for node-local application OTLP.

## Useful Overrides

```yaml
global:
  clusterName: production
  deploymentEnvironment: prod

maple:
  ingest:
    endpoint: https://ingest.example.com
  ingestKey:
    existingSecret:
      name: maple-ingest-key
      key: ingest-key

presets:
  podLogs:
    enabled: true
  k8sEvents:
    enabled: true
  otlpReceiver:
    grpc:
      hostPort: null
    http:
      hostPort: null
```

## Validate

```bash
helm lint deploy/k8s-infra
helm template maple-k8s-infra deploy/k8s-infra --set maple.ingestKey.value=test >/tmp/maple-k8s-infra.yaml
```

## Publish

The GitHub Actions workflow `.github/workflows/publish-k8s-infra-chart.yml` publishes the chart to GHCR. Run it manually, or push a tag like:

```bash
git tag k8s-infra-v0.1.0
git push origin k8s-infra-v0.1.0
```

Manual publish from a machine with Helm:

```bash
HELM_REGISTRY_USERNAME=YOUR_GITHUB_USER \
HELM_REGISTRY_PASSWORD=YOUR_GITHUB_TOKEN \
./scripts/publish-k8s-infra-chart.sh
```
