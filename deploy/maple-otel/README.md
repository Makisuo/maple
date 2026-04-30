# maple-otel

Lean Helm chart that runs Maple's custom OpenTelemetry Collector
(`mapleexporter` baked in) and ships OTLP straight into a Maple-schema
ClickHouse.

Pick this chart when all you want is "OTLP in, Maple ClickHouse out." For
the full infrastructure-monitoring bundle (kubelet stats, host metrics,
pod log scraping, auto-instrumentation operator), use `maple-k8s-infra`.

## Install

```bash
helm install maple-otel oci://ghcr.io/makisuo/charts/maple-otel \
  --version 0.1.0 \
  --namespace maple --create-namespace \
  --set maple.orgId=org_xxx \
  --set maple.clickhouse.endpoint=https://your-ch.example.com \
  --set maple.clickhouse.password.value=$CH_PASSWORD
```

For a more secret-hygienic install:

```bash
kubectl -n maple create secret generic maple-clickhouse-password \
  --from-literal=password=$CH_PASSWORD

helm install maple-otel oci://ghcr.io/makisuo/charts/maple-otel \
  --version 0.1.0 \
  --namespace maple \
  --set maple.orgId=org_xxx \
  --set maple.clickhouse.endpoint=https://your-ch.example.com \
  --set maple.clickhouse.password.existingSecret.name=maple-clickhouse-password \
  --set maple.clickhouse.password.existingSecret.key=password
```

## Make sure the schema is there

The chart does NOT install Maple's ClickHouse schema. Apply it once with:

```bash
bunx @maple/clickhouse-cli@latest apply \
  --url=https://your-ch.example.com \
  --user=maple --password=$CH_PASSWORD \
  --database=default
```

Or via the Maple UI under Settings → BYO Backend → ClickHouse.

## What's in the box

- OpenTelemetry Collector (custom build, image
  `ghcr.io/makisuo/maple/otel-collector-maple:<chart appVersion>`)
- Receivers: OTLP gRPC + HTTP
- Processors: `memory_limiter`, optional `k8sattributes` (default ON,
  with cluster-scoped RBAC for pod/namespace/deployment lookup),
  `batch`
- Exporter: `mapleexporter` writing to Maple's schema (`traces`, `logs`,
  `metrics_sum`, `metrics_gauge`, `metrics_histogram`,
  `metrics_exponential_histogram`)
- Optional Ingress for off-cluster OTLP traffic — TLS via a
  namespace-scoped HTTP01 ACME Issuer (Let's Encrypt)

## Common values

| Key | Default | Purpose |
|---|---|---|
| `maple.orgId` | _(required)_ | Stamped on every record's OrgId column. |
| `maple.clickhouse.endpoint` | _(required)_ | ClickHouse HTTP URL. |
| `maple.clickhouse.user` | `maple` | CH user with INSERT privileges on Maple's tables. |
| `maple.clickhouse.password.value` | `""` | Inline password (or set `existingSecret.{name,key}`). |
| `maple.clickhouse.database` | `default` | DB holding Maple's schema. |
| `k8sattributes.enabled` | `true` | Enrich spans with originating-pod metadata. |
| `replicaCount` | `2` | Collector replicas. |
| `ingress.enabled` | `false` | Expose externally on listed `hosts`. |
| `maple.orgIdFromResourceAttribute` | `""` | Read org id off this resource attr per-record (multi-tenant). |

See [`values.yaml`](./values.yaml) for the full list with comments.
