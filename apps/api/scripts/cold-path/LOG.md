# Cold-path graph diet — iteration log

Harness: `OUT=apps/api/.coldpath-out SEO=0 bun apps/api/scripts/cold-path/build-bundle2.mjs`
then `node --expose-gc --experimental-loader ./apps/api/scripts/cold-path/cf-loader.mjs ./apps/api/scripts/cold-path/cold-path-scorecard.mjs apps/api/.coldpath-out`.
The bundle dir must sit inside `apps/api/` so the externals (`@maple-dev/effect-sdk/cloudflare`,
`@maple-dev/clickhouse-builder`) resolve via `apps/api/node_modules`; build their dists first
(`bunx turbo build --filter=@maple-dev/effect-sdk --filter=@maple-dev/clickhouse-builder`).
Numbers are desktop V8 (node 26) on this machine — treat them as relative, not absolute;
`evalMs` jitters ±10%.

evalMs = startupGraph / plusHttpGraph · heapMB = startupGraph / fullGraph

| iter | change | evalMs | heapMB | registry chunk | verdict |
| ---- | ------ | ------ | ------ | -------------- | ------- |
| 0 | baseline @ 53934a70 | 241 / 400 | 37.3 / 196.3 | 2.76MB, dynamic | reference (73 chunks) |
| 1 | react-email behind dynamic import (alert-email, DigestService renderDigestHtml; deriveDigestStatus split into react-free `@maple/email/weekly-digest-core`) | 116 / 260 | 25.7 / 180.1 | 0.99MB, dynamic | ACCEPT — the "registry" chunk was ~2.1MB of @react-email/tailwind + code-block(prism) + tailwindcss + prettier statically reachable from the alert/digest services |
| 2 | autumn-js/backend behind dynamic import in makeCallAutumn (type imports stay static) | 119 / 84 | 25.7 / 40.7 | 0.99MB, dynamic | ACCEPT — autumn-js + zod v4 was ~1.6MB of source and ~140MB (!) of eager zod schema construction inside the http-graph chunk |
| 3 | CloudflareApi.ts → lazy facade over CloudflareApiImpl.ts (distilled SDK loads on first integration call) | 127 / 78 | 25.7 / 39.9 | 0.99MB, dynamic | ACCEPT (small, <5% heap) — sheds ~2.4MB SDK source (~250KB minified) from the request-path closure |
| 4 | ANTICIPATED_ERROR_IDENTIFIERS from codegen literal list instead of module-eval reflection over the whole domain HTTP surface (`anticipated-errors-derive.ts` + generated file + drift test) | 44 / 147 | 4.9 / 38.8 | 0.99MB, dynamic | MOVED to a follow-up PR — accepted on its numbers (startup 127 → 44ms, startup heap 25.7 → 4.9MB, 3x startup-budget headroom, also diets alerting/web/electric-sync), but it adds a generated file + gen step to maintain, so it was reverted out of this PR for separate review. Note its request-path effect is slightly negative in isolation (schema eval moves from startup into the http closure, 78 → 147ms; net first-request 205 → 191ms) |

## Final for THIS PR (through iteration 3): eval 127/78 ms · heap 25.7/39.9 MB

Baseline → final: startup eval 241 → 127ms (−47%), full-graph eval ~400 → 78ms (−80%),
startup heap 37.3 → 25.7MB (−31%), full heap 196.3 → 39.9MB (−80%). Full-graph budgets met
(≤150ms/≤100MB); startup budgets already comfortably met at baseline. Iteration 4's numbers
(startup 44ms / 4.9MB) apply once the follow-up codegen PR lands.

**Stopped here.** Remaining request-path weight decomposes into: `effect` itself (3.8MB
source, shared runtime — needed), the domain HTTP schema surface (~600KB source /
~14MB heap — owned by the statically-mounted routes; lazifying Effect Schema
construction is the "conservative — correctness over wins" item and the remaining wins
don't justify the risk), and the service implementations (built by the layer graph on
the same first request, so deferring their module eval only moves the cost, it doesn't
remove it — this is also why McpLive/MCP-tools laziness was evaluated and rejected).
Every >5% third-party contributor (react-email+tailwind+prettier+prism, autumn-js+zod,
distilled Cloudflare SDK) is now behind a dynamic import.

**Not pursued per brief:** scrape-cron extraction, org-settings caching (tried/reverted
twice previously), Hyperdrive/pool/timeout changes, `strictExecutionOrder` (stays false).

**Harness caveat:** `@maple-dev/effect-sdk/cloudflare` (and clickhouse-builder) stay
external in this build and load unbundled from `apps/api/node_modules`, double-evaluating
`effect` — this inflates startupGraph eval by ~100ms vs production, identically across
iterations. Build their dists before scoring or startup eval reads as a resolution error.
