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
| 4 | ANTICIPATED_ERROR_IDENTIFIERS from codegen literal list instead of module-eval reflection over the whole domain HTTP surface (`anticipated-errors-derive.ts` + generated file + drift test) | 44 / 147 | 4.9 / 38.8 | 0.99MB, dynamic | ACCEPT — worker.ts startup no longer evals ~600KB of Effect Schema construction; startup graph 0.81 → 0.37MB, startup heap 25.7 → 4.9MB. The schema eval moved to the http closure (78 → 147ms) where routes need it anyway; net first-request total 205 → 191ms and 3x startup-budget headroom. Also diets alerting/web/electric-sync workers, which import the same set |
