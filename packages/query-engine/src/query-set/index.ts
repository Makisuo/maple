// @maple/query-engine/query-set — running a stored QuerySet and shaping the result.
//
// The layer between the pure lowering (`../query-builder/model`, draft →
// QuerySpec) and a host that can execute a QuerySpec. Three surfaces needed
// exactly this and each had grown its own copy: the web app's
// `query-builder-timeseries` server function, the MCP widget inspector, and the
// alert rule compiler.
//
// Its own subpath rather than `./runtime` or the root barrel, for one concrete
// reason: `apps/web/src/api/warehouse/*` runs in the BROWSER, so everything here
// is browser-bundled. `./runtime` pulls the ClickHouse DSL and is API-only; the
// root barrel is imported for small helpers all over the place and should not
// drag the merge machinery in behind them.
//
// Deliberately NOT here:
//   - Alert bucket observations. `computeAlertBuckets` in `../runtime` emits a
//     per-(bucket, group) `sampleCount` that `QueryEngineResult` does not carry,
//     and `minimumSampleCount` depends on it. The runner and that lowering are
//     two shaping layers over the same lowering, not one over the other.
//   - Raw SQL. It is not a query set; it goes through `executeRawSql` with its
//     own reshaping.

export * from "./breakdown-merge"
export * from "./bucketing"
export * from "./series-merge"
