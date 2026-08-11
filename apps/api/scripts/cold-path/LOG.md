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
