# Service-bound route worker benchmark

Measured on 2026-08-23 with Bun 1.4.0, Wrangler 4.118.0, and local workerd on an Apple Silicon
development machine. These are relative local measurements, not production latency promises.

## What implementation actually exists

Hono does **not** create sub-workers for mounted routes. Its
[`HonoBase.route()` implementation](https://github.com/honojs/hono/blob/main/src/hono-base.ts)
copies a sub-application's handlers into the same in-process router.

The architecture that matches the remembered behavior is Cloudflare's
[HTTP service-binding API gateway pattern](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/):
a small public Worker selects a coarse route island and forwards the original `Request` to a private
Worker. Cloudflare documents service bindings as running on the same thread and server by default,
with no additional request charge, while each hop still counts toward the 32-Worker invocation
limit.

## Existing stack

Every request sample starts a fresh `wrangler dev` process, waits for the listener, and then sends
the first request. The workerd startup profile is measured separately by `wrangler check startup`.
Medians use five request runs (three for `/v2/services`).

| Metric                                          |                   `main` |         Lazy HTTP routes |           Cold bootstrap |
| ----------------------------------------------- | -----------------------: | -----------------------: | -----------------------: |
| workerd active startup CPU                      |                 114.2 ms |                 117.8 ms |                  30.7 ms |
| bundle (raw / gzip)                             | 12,895.31 / 2,544.05 KiB | 12,895.60 / 2,544.19 KiB | 12,832.11 / 2,534.29 KiB |
| desktop startup graph eval                      |                    98 ms |                   100 ms |                    34 ms |
| desktop startup heap delta                      |                 30.85 MB |                 30.85 MB |                  5.03 MB |
| cold `GET /health` request                      |                 202.3 ms |                 125.6 ms |                   7.4 ms |
| cold unauthenticated `GET /v2/services` request |                 207.3 ms |                 129.0 ms |                 217.5 ms |
| startup CPU + `/v2/services` local proxy        |                 321.5 ms |                 246.8 ms |                 248.2 ms |

Interpretation:

- Lazy endpoint compilation cuts the first real-route proxy by about 23%, while leaving upload-time
  startup unchanged as designed.
- The cold-bootstrap layer removes 73% of active startup CPU, 84% of startup heap, and 96% of the
  cold health-request time.
- The generated anticipated-error list moves domain-schema evaluation from startup to the first
  real route. Consequently, request-only `/v2/services` time rises, but the combined local cold
  proxy stays flat versus the lazy-route layer. It solves startup-budget and liveness risk; it does
  not claim a further real-route cold win.

## Route-island experiment

Run:

```bash
bun run --cwd apps/api bench:service-bindings --samples=250
```

The router measures `binding.fetch()` inside workerd. The two probe Workers compare today's complete
HTTP/service module graph with the smallest useful telemetry-route module graph using current module
boundaries. Seven fresh-process runs produced:

| Graph            | Cold module-evaluation samples       | Median |
| ---------------- | ------------------------------------ | -----: |
| monolith         | 148, 146, 144, 146, 145, 145, 147 ms | 146 ms |
| telemetry island | 104, 96, 96, 97, 97, 97, 97 ms       |  97 ms |

The telemetry island reduces module evaluation by **33.6%**. A representative 250-request warm run
measured the service-binding call at **0 ms median / 1 ms p95** at workerd's timer resolution.

This is enough evidence to build a functional canary, not enough evidence to route production
traffic immediately. The probe evaluates real Maple modules, but intentionally excludes Effect
Layer acquisition, authentication results, database dialing, and warehouse I/O.

## Recommended rollout and acceptance gate

Use coarse islands, not one Worker per endpoint. Start with the read-heavy v2 telemetry surface; it
has a coherent dependency graph and the benchmarked 34% module-evaluation reduction. Keep health and
preflight handling in the tiny public router. Let the target Worker own auth, request scope,
telemetry, and its per-invocation Hyperdrive connection. A shared "database Worker" would violate
Maple's request-bound connection lifecycle and add a hop without preserving a socket between
invocations.

Deploy the private target before the router, then canary a small share of telemetry requests and
compare against the monolith for at least one full traffic cycle. Ship the split only if all of these
hold:

1. Cold telemetry-route p50 and p95 improve by at least 15%.
2. Warm route p95 regresses by less than 2 ms.
3. Error rate, response bytes, CORS headers, auth envelopes, and tracing are equivalent.
4. Router plus target CPU is lower at cold p95 and no higher at warm p95.
5. Target startup, heap, compressed size, subrequests, and Worker-invocation depth remain inside
   Cloudflare limits with at least 25% headroom.

If the functional canary misses either latency gate, keep the first two stack layers and drop the
route-worker layer; the benchmark harness remains useful for future module-boundary changes.
