# Maple Kubernetes Infra Collector

This chart deploys Maple's Kubernetes infrastructure collector using the upstream OpenTelemetry Collector Contrib image. It uses a split collector architecture:

- a DaemonSet for node-local OTLP, host metrics, kubelet metrics, and optional pod logs
- a single-replica Deployment for cluster-wide metrics and optional Kubernetes events

All signals are exported with OTLP HTTP to Maple's ingest gateway. The collector does not write directly to Tinybird or ClickHouse; the ingest gateway remains responsible for ingest-key auth and authoritative `maple_org_id` enrichment.

For wiring the service map's Infrastructure tab to your workloads, see [docs/service-map-infrastructure.md](../../docs/service-map-infrastructure.md).

## Install

The chart defaults to Maple's hosted ingest gateway (`https://ingest.maple.dev`). Self-hosted users override `maple.ingest.endpoint`.

Once the chart is published to GHCR, the easiest install path is:

```bash
curl -fsSL https://raw.githubusercontent.com/Makisuo/maple/main/deploy/k8s-infra/install.sh | \
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
  --set-string maple.ingestKey.value=YOUR_MAPLE_INGEST_KEY \
  --set-string global.clusterName=production
```

Local install from this repository:

```bash
helm upgrade --install maple-k8s-infra ./deploy/k8s-infra \
  --namespace maple \
  --create-namespace \
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
  --set maple.ingestKey.existingSecret.name=maple-ingest-key \
  --set maple.ingestKey.existingSecret.key=ingest-key \
  --set global.clusterName=production
```

For a self-hosted Maple deployment, add `--set maple.ingest.endpoint=https://your-ingest.example.com` to any of the commands above.

## Defaults

- Host metrics, kubelet metrics, cluster metrics, and OTLP receiving are enabled.
- Pod logs, Kubernetes events, and Fargate metrics are disabled by default to keep ingestion volume predictable.
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

## EKS Fargate

EKS Fargate pods can't host the DaemonSet (each Fargate pod is its own micro-VM with no shared host) and their kubelets aren't reachable on `:10250`. To collect per-pod CPU and memory for Fargate-launched pods, the cluster collector scrapes `/metrics/cadvisor` on each Fargate-typed node via the API server proxy and reshapes the cAdvisor output into the `kubeletstats` convention (`k8s.pod.cpu.usage`, `k8s.pod.memory.usage`) so the Pods/Workloads views light up the same way as for EC2-launched pods.

Enable it with:

```bash
helm upgrade --install maple-k8s-infra ./deploy/k8s-infra \
  --namespace maple --create-namespace \
  --set maple.ingest.endpoint=https://ingest.example.com \
  --set maple.ingestKey.value=YOUR_MAPLE_INGEST_KEY \
  --set global.clusterName=production \
  --set presets.fargateMetrics.enabled=true
```

What it collects: per-pod CPU usage (cores) and memory working-set bytes for every Fargate-launched pod, tagged with `eks.amazonaws.com/compute-type=fargate` in the resource attributes.

What it does **not** collect: host metrics (there is no host on Fargate), CPU/memory limit utilization, network I/O. The first two require the kubeletstats receiver, which Fargate doesn't expose; network I/O is left out of v1 because cAdvisor reports it as a counter that we'd need to rate-convert.

The preset adds a `nodes/proxy` permission to the cluster collector's ClusterRole so the prometheus receiver can scrape via the API server proxy. EC2-launched pods are filtered out of the Fargate scrape (relabel keeps only nodes labeled `eks.amazonaws.com/compute-type=fargate`), so there is no double-counting with the DaemonSet.

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
