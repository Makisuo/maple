// @maple/query-model — what "a warehouse query" is, for every surface that stores one.
//
// The leaf `packages/widgets/src/index.ts` asked for: dashboard widgets and
// alert rules both persist a query-builder draft, so the draft belongs below
// both rather than inside either. Deps are `@maple/primitives` and `effect`
// only, which is what lets `@maple/widgets` (itself below `@maple/domain`)
// import it.
//
// It goes in `packages/`, not `lib/`: it names `traces`/`logs`/`metrics` and
// Maple's aggregation vocabulary, so it fails the "could ship as a standalone
// OSS library tomorrow" test.
//
// Deliberately NOT here:
//   - Lowering. Turning a draft into a `QuerySpec` needs the CH DSL and lives in
//     `@maple/query-engine/query-builder`.
//   - Aggregation option lists (`AGGREGATIONS_BY_SOURCE`, `GROUP_BY_OPTIONS`).
//     Those are builder-UI affordances keyed off what the lowering implements,
//     not part of the stored value.

export * from "./comparison"
export * from "./formula"
export * from "./funnel"
export * from "./query-draft"
export * from "./query-set"
export * from "./result-shape"
export * from "./series-reducer"
export * from "./time-range"
