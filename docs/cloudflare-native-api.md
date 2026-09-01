# Cloudflare-native API plan

Status: proposed follow-up after the lazy-route and cold-bootstrap optimization stack merges.

## Outcome

Keep `https://api.maple.dev` and the public v2 contract unchanged, while making the runtime a
small public gateway backed by coarse, private Worker islands. A route author continues to define
an Effect `HttpApiGroup` and its handler once; the topology decides where that group runs.

The first production slice is the read-heavy v2 telemetry surface. It is a good boundary because
traces, logs, metrics, services, and the service map share warehouse dependencies but do not need
the rest of Maple's HTTP, MCP, alerting, webhook, or workflow graph.

```text
api.maple.dev
    |
    v
api gateway Worker
    |-- /health and OPTIONS ---------------------- local
    |-- /v2/{traces,logs,metrics,services,...} --- telemetry Worker
    `-- everything else -------------------------- core Worker
```

The gateway is the only public Worker. The telemetry and core Workers have no custom domain or
stable `workers.dev` URL and are reachable through Cloudflare service bindings only.

## Design rules

1. **One public contract.** Worker placement must not change URLs, schemas, error envelopes,
   authentication, CORS, pagination, or OpenAPI output.
2. **Coarse islands.** Split by dependency graph, not by endpoint. A normal request should invoke
   the gateway and one target, leaving ample room under Cloudflare's 32-Worker invocation limit.
3. **No shared database Worker.** The target owns authentication and the request-scoped Hyperdrive
   connection. A Postgres socket must never outlive the target invocation that created it.
4. **Workers-native transport.** Forward the original `Request` with an HTTP service binding. Do
   not serialize it into an internal JSON/RPC envelope, buffer response bodies, or make a public
   network request between Workers.
5. **Tiny global scope.** The gateway imports no Maple domain barrel, Effect API AST, database
   driver, or route implementation. Its route table is generated as literals at build time.
6. **One middleware implementation.** Target Workers share the same factory for tracing, error
   handling, CORS, handler memoization, and Postgres scoping, so islands cannot drift semantically.
7. **Explicit fallback and rollback.** Until an island passes the production gates, the core Worker
   remains deployable and the gateway can send that entire route family back to it.

## Developer experience

The intended route-authoring flow remains the current one:

1. Add an endpoint to an Effect `HttpApiGroup` in `@maple/domain`.
2. Add the handler to the matching `HttpApiBuilder.group` in `apps/api`.
3. Run the normal route tests.

An endpoint added to an existing group inherits that group's Worker automatically. Only a new API
group needs one topology decision.

The source of truth should resemble:

```typescript
export const ApiTopology = defineApiTopology({
	telemetry: defineApiIsland({
		groups: [
			[V2TracesApiGroup, HttpV2TracesLive],
			[V2LogsApiGroup, HttpV2LogsLive],
			[V2MetricsApiGroup, HttpV2MetricsLive],
			[V2ServicesApiGroup, HttpV2ServicesLive],
			[V2ServiceMapApiGroup, HttpV2ServiceMapLive],
		],
		services: TelemetryServicesLive,
	}),
	core: defineApiIsland({ fallback: true }),
})
```

Build-time tooling derives these artifacts rather than asking a developer to maintain them:

- the gateway's literal method/path-to-binding table;
- the island-specific Effect APIs and route Layers;
- typed Worker binding names;
- Alchemy Worker resources and dependency order;
- local multi-Worker configuration;
- the combined public OpenAPI document;
- an exhaustiveness report proving that every public group is assigned exactly once.

The shared target entry point should be declarative:

```typescript
export default makeApiWorker({
	api: TelemetryApi,
	routes: TelemetryRoutesLive,
	services: TelemetryServicesLive,
	serviceName: "maple-api-telemetry",
})
```

`makeApiWorker` owns the code currently repeated or load-bearing in `worker.ts`: an isolate-wide
memoized Effect handler, request-local environment, telemetry flush, server-error span mapping,
and one lazily-created Postgres connection scope per invocation.

Local development stays one command and one origin. `bun dev` starts the gateway and all private
targets through local workerd service bindings; callers continue to use `https://api.localhost`.
Tests call the same `fetch(Request)` boundary whether the target is local or deployed.

## Repository shape

Keep the multiple deployables in `apps/api`; their code and contract still form one product API.

```text
apps/api/src/cloudflare/
    gateway.ts
    make-api-worker.ts
    topology.ts
    topology.generated.ts
apps/api/src/islands/
    telemetry/
        api.ts
        routes.ts
        services.ts
        worker.ts
    core/
        worker.ts
packages/domain/src/http/v2/islands/
    telemetry.ts
```

The `@maple/domain/http/v2/islands/telemetry` subpath exports only the five telemetry groups and
their shared boundary middleware. The telemetry Worker must not import the root v2 barrel, because
that would evaluate every group's schema and erase the cold-start benefit.

## Delivery phases

### 0. Merge and freeze the baseline

- Merge the lazy HTTP route and cold-bootstrap PRs first.
- Re-run startup CPU, compressed bundle, module evaluation, cold `/health`, cold authenticated and
  unauthenticated `/v2/services`, and warm route latency on the merge SHA.
- Store the raw samples and machine/runtime versions so later comparisons use the same baseline.

### 1. Build the topology foundation without moving traffic

- Extract `makeApiWorker` from the current Worker without changing behavior.
- Define the typed topology and generate the literal gateway route manifest.
- Add the telemetry-only domain API, route Layer, and service Layer using existing endpoint groups
  and handlers; do not copy endpoint schemas or business logic.
- Extend Alchemy to deploy a private telemetry Worker and bind it to the existing API Worker.
- Add topology checks: every route exactly once, no collisions, no public private-Worker URL, and
  the full OpenAPI document unchanged.

### 2. Prove one functional vertical slice

- Forward `/v2/services` through the binding behind a disabled-by-default deployment switch.
- Run the real authorization, org selection, rate limit, query engine, cache, tracing, CORS, and
  error middleware in the telemetry Worker.
- Keep all other telemetry routes on the core Worker during this phase.
- Add differential tests that send the same request to core and telemetry handlers and compare
  status, response bytes, selected headers, error envelope, and recorded span fields.
- Cover success plus schema failure, 401, 403, 404, 429, warehouse failure, disconnect, and
  streaming/abort behavior.

### 3. Deploy a controlled Cloudflare canary

- Deploy the private target before the gateway, keeping changes backward-compatible across
  versions.
- Upload a gateway version that sends the selected route to the target and initially assign it 0%
  production traffic.
- Smoke-test that exact gateway and target version using Cloudflare version overrides.
- Increase the gateway deployment gradually while using version affinity for a stable caller key.
- Stamp gateway and target version IDs on spans so comparisons distinguish both halves of a call.
- Observe at least one full traffic cycle before promotion. Rollback is a gateway deployment change;
  it must not require deleting or redeploying the target.

### 4. Expand only after the gate passes

- Move the rest of services, traces, logs, metrics, and service-map groups together.
- Delete their imports from the core Worker's runtime graph after the canary is fully promoted.
- Re-measure the core Worker as well as the telemetry Worker; the split only wins if combined CPU
  and operational complexity improve.
- Consider another island only when an import/dependency profile demonstrates a material boundary.

## Verification and acceptance gates

Local workerd measurements are screening evidence. Deployed Cloudflare measurements decide whether
traffic moves.

Correctness must be exact for:

- status and response bytes;
- content type, cache, CORS, rate-limit, and request-ID headers;
- authentication and organization-selection behavior;
- public error tags/codes and retry metadata;
- span name, kind, status, `query.context`, tenant, and Worker-version attribution;
- disconnect cancellation, streaming, and `waitUntil` telemetry flushing;
- one Hyperdrive scope per target invocation with no request-bound object crossing the binding.

Performance gates, evaluated against the post-merge baseline:

1. Cold telemetry-route p50 and p95 improve by at least 15% in deployed measurements.
2. Warm telemetry-route p95 regresses by less than 2 ms.
3. Gateway plus target cold CPU is lower, and combined warm CPU is no higher.
4. Error rate and timeout rate do not regress.
5. Each Worker stays below 75% of the startup, memory, compressed-size, subrequest, connection, and
   invocation-depth limits under the tested load.
6. A normal API request uses exactly two Worker invocations and one service-binding subrequest.

If correctness differs, combined CPU increases, or either latency gate fails, keep the first two
optimization PRs, route the family to core, and retain the benchmark/topology tooling for a later
module-boundary improvement.

## Non-goals

- one Worker per endpoint;
- a database, authentication, or query-engine Worker shared across requests;
- changing the public v2 HTTP contract to fit the internal topology;
- replacing Effect schemas or handlers solely to obtain the Worker split;
- moving webhooks, MCP, queues, cron, Workflows, or Durable Objects in the first slice;
- enabling Smart Placement before measuring whether its backend-oriented placement helps Maple's
  user-to-edge and edge-to-warehouse latency together.

## Cloudflare references

- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/)
- [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
