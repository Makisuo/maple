// The branded ids and telemetry dimensions moved to `@maple/primitives`, a leaf
// package depending on nothing but `effect`, so that packages which must sit
// *below* `@maple/domain` — `@maple/widgets`, and anything after it — can brand
// their schemas without importing the package that aggregates `MapleApi`.
//
// This re-export keeps `@maple/domain/primitives` and `@maple/domain` working
// unchanged. Prefer importing `@maple/primitives` directly in new code.
export * from "@maple/primitives"
