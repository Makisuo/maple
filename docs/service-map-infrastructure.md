# Service Map Infrastructure Tab

Maple's service map shows a pod-count badge on each service node and an Infrastructure tab listing the Kubernetes workloads running each service. This page covers the one-time wiring needed for those views to populate against your cluster.

## Quickstart

```bash
helm upgrade --install maple-k8s-infra \
  oci://ghcr.io/makisuo/charts/maple-k8s-infra \
  --namespace maple --create-namespace \
  --set maple.ingestKey.value=YOUR_MAPLE_INGEST_KEY \
  --set global.clusterName=production

kubectl annotate namespace shop \
  instrumentation.opentelemetry.io/inject-sdk=maple/maple-default

kubectl rollout restart deployment -n shop
```

Within ~60 seconds, services from `shop` get a pod-count badge on their service-map node and a populated Infrastructure tab in the side panel. Self-hosted Maple users add `--set maple.ingest.endpoint=https://your-ingest`.

To opt in many namespaces declaratively at install time, list them in `autoInstrumentation.instrumentation.autoInstrumentNamespaces` instead of running `kubectl annotate` for each.

## Will this work for my app?

**The chart injects env vars; it does not add an OpenTelemetry SDK to your app.** Your app still needs to produce OTLP spans somehow. Whether the env-var injection has any effect depends on whether your SDK reads the standard `OTEL_*` env vars at startup:

| Stack                                                           | Works automatically?                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Maple's `@maple-dev/effect-sdk/server` (>= 0.2.0)               | Yes — reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES`. Calling `Maple.layer()` with no args picks up the operator-injected config. |
| Java with `opentelemetry-javaagent.jar`                         | Yes — auto-config reads every `OTEL_*` env var.                                                                                                       |
| Python with `opentelemetry-distro` / `opentelemetry-instrument` | Yes.                                                                                                                                                  |
| Node.js with `@opentelemetry/auto-instrumentations-node`        | Yes.                                                                                                                                                  |
| .NET with `AddOtlpExporter()` and no explicit endpoint          | Yes — falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`.                                                                                                    |
| Go with `otlptracehttp.New(ctx)` (no `WithEndpoint`)            | Yes.                                                                                                                                                  |
| Go with `otlptracehttp.New(ctx, WithEndpoint("..."))`           | No — hardcoded endpoint wins.                                                                                                                         |
| Rust / other                                                    | Depends on whether the exporter is constructed from env vars.                                                                                         |
| Apps with no OTel SDK linked at all                             | No — nothing produces spans for env vars to configure.                                                                                                |

If you're on a stack from the first half of the table, you can stop reading here and do the quickstart. If you're hardcoding endpoints in app code, switch to the env-var form (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_RESOURCE_ATTRIBUTES`) before the injection helps you. If you have no SDK, you need to add one before any of this matters — `inject-sdk` mode (the one we use) deliberately does not bundle a language agent.

To verify the env vars actually reach your container, exec into a freshly-restarted pod:

```bash
kubectl exec -n shop <pod-name> -- env | grep OTEL
```

Both `OTEL_EXPORTER_OTLP_ENDPOINT=http://maple-k8s-infra-agent.maple.svc.cluster.local:4318` and `OTEL_RESOURCE_ATTRIBUTES=k8s.pod.ip=...,k8s.pod.uid=...` should be present. If they are but your spans still don't show up, the SDK isn't reading them — fix on the app side.

## How it works

1. **Operator webhook injects env vars at pod creation.** The `Instrumentation/maple-default` CR (`deploy/k8s-infra/templates/instrumentation.yaml`) lists `OTEL_EXPORTER_OTLP_ENDPOINT` plus five downward-API env vars (`K8S_POD_IP`, `K8S_POD_UID`, `K8S_POD_NAME`, `K8S_NAMESPACE_NAME`, `K8S_NODE_NAME`) layered into `OTEL_RESOURCE_ATTRIBUTES` via `$(VAR)` interpolation.
2. **App's OTel SDK reads them on startup** and tags every span with `k8s.pod.ip` / `k8s.pod.uid` / `k8s.pod.name` / `k8s.namespace.name` / `k8s.node.name`. The chart's `global.clusterName` is also baked in as `k8s.cluster.name`.
3. **Agent's `k8sattributes` processor enriches the span** by looking up the pod (via `k8s.pod.ip`, `k8s.pod.uid`, or `(k8s.pod.name, k8s.namespace.name)` — see `processors.kubernetesAttributes.podAssociation` in `values.yaml`) in its in-memory cache built from a Kubernetes API watch. It adds `k8s.deployment.name` / `k8s.statefulset.name` / `k8s.daemonset.name`.
4. **Web app joins on the result.** The `serviceWorkloads` query joins `service.name` (on spans) to workload identity (also on spans), then enriches with pod count and CPU / memory utilization from `metrics_gauge`.

The end-to-end join key is `service.name` → `k8s.deployment.name`. If step 3 fails to enrich, the join fails silently and the Infrastructure tab stays empty.

## Per-cloud caveats

| Distribution                  | Caveat                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EKS standard                  | None.                                                                                                                                                                                                                                                                                                         |
| EKS Fargate                   | Agent DaemonSet can't run on Fargate-typed nodes. Either keep one EC2 node so the agent has somewhere to land, or override `autoInstrumentation.instrumentation.otlpEndpointOverride` to point at the cluster collector. Set `presets.fargateMetrics.enabled=true` so per-pod CPU/memory still feed the join. |
| GKE Standard                  | None.                                                                                                                                                                                                                                                                                                         |
| GKE Autopilot                 | Mutating webhooks are rejected on Google-managed namespaces. Only annotate user namespaces.                                                                                                                                                                                                                   |
| AKS Azure CNI Overlay         | None — pod IPs survive overlay.                                                                                                                                                                                                                                                                               |
| Self-managed (k3s, kind, k0s) | None. Auto-generated webhook certs work without cert-manager.                                                                                                                                                                                                                                                 |
| Service-mesh (Linkerd, Istio) | Sidecars rewrite source IPs, breaking the `k8s.pod.ip` association key. The `k8s.pod.uid` and `(k8s.pod.name, k8s.namespace.name)` keys travel inside the OTLP payload itself and rescue the join. No mesh-side config needed.                                                                                |

## Verification

Confirm enrichment is reaching ClickHouse:

```sql
SELECT
  ServiceName,
  ResourceAttributes['k8s.deployment.name']  AS deployment,
  ResourceAttributes['k8s.namespace.name']   AS namespace,
  count() AS spans
FROM traces
WHERE Timestamp > now() - INTERVAL 5 MINUTE
  AND ResourceAttributes['k8s.namespace.name'] = '<your-ns>'
GROUP BY 1, 2, 3
ORDER BY spans DESC
```

`deployment` should be populated (not blank, not `NULL`) for at least one row. If it's blank for every row, the `k8sattributes` processor isn't enriching — see Troubleshooting.

In the UI: open the service map, find one of those services, confirm the pod-count badge on its node, click in, and confirm the Infrastructure tab shows a row with the correct kind, name, namespace, cluster, and pod count.

## Troubleshooting

**Empty Infrastructure tab after annotating + restarting.**
Run the verification query first. The result tells you which side is broken.

- `deployment` is blank for every row → enrichment isn't happening. Check agent RBAC (`kubectl get clusterrolebinding -l app.kubernetes.io/instance=maple-k8s-infra`) and look for `k8sattributes` errors in agent logs (`kubectl logs -n maple -l app.kubernetes.io/component=agent --tail=500 | grep -i k8sattributes`).
- `deployment` is populated but the tab is empty → metrics side is missing. Ensure `presets.kubeletMetrics.enabled=true` (the default) and the cluster collector is running.
- No spans arrive at all → app isn't sending OTLP to the agent. See "Will this work for my app?" above and check `kubectl exec ... -- env | grep OTEL`.

**Pods don't get the env vars at all.**
Either the operator's webhook isn't firing or the namespace annotation has a typo.

```bash
kubectl get mutatingwebhookconfiguration | grep opentelemetry-operator
kubectl logs -n maple -l app.kubernetes.io/name=opentelemetry-operator --tail=200
kubectl get namespace <your-ns> -o jsonpath='{.metadata.annotations}' | jq .
```

The annotation must be exactly `instrumentation.opentelemetry.io/inject-sdk: "maple/maple-default"`. Anything else (just `maple-default`, just `true`, etc.) is silently ignored. If the operator pod is crash-looping, it's usually a webhook cert issue — switch to cert-manager via `opentelemetryOperator.admissionWebhooks.certManager.enabled=true` if your cluster requires it.

**Service mesh in the way.**
Sidecars rewrite source IPs but the `k8s.pod.uid` / `(name, namespace)` association keys ride inside the OTLP payload and rescue the join. Verify the env vars are present:

```bash
kubectl describe pod -n <your-ns> <pod> | grep -E 'K8S_POD_(IP|UID|NAME)|K8S_NAMESPACE_NAME'
```

All four should be set. If only some are, the operator's webhook didn't run on this pod — see the previous failure mode.

## Opting out

```bash
kubectl annotate namespace <your-ns> instrumentation.opentelemetry.io/inject-sdk-
kubectl rollout restart deployment -n <your-ns>
```

The trailing `-` removes the annotation. New pods come up plain; the badge and tab clear on the next service-map fetch.

To remove auto-instrumentation entirely, set `autoInstrumentation.enabled=false` (stops rendering the Instrumentation CR) and `autoInstrumentation.operator.enabled=false` (uninstalls the operator subchart) on the next `helm upgrade`.
